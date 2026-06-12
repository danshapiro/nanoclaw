/**
 * Codex turn timing — the activity-resettable transport-silence window, the
 * independent absolute ceiling, and the inactivity-notice cadence, as a pure
 * state machine driven by an injected clock (never `Date.now`), so 6-hour
 * scenarios run instantly under a fake clock. Mirrors opencode-events.ts.
 */
export interface CodexTimingClock { now(): number; }

export interface CodexTimingConfig {
  transportTimeoutMs: number;     // silence window; reset on ANY activity
  absoluteTurnTimeoutMs: number;  // from turn start; never reset
  inactivityNoticeMs: number;     // first notice after this much no-meaningful silence
  inactivityThrottleMs: number;   // repeat cadence
}

export interface CodexLiveness {
  configuredTimeoutMs: number;
  elapsedMs: number;
  // undefined (not null) to match the in-fork ProviderLivenessMetadata contract
  // (lastEventType?: string). null fails the in-fork typecheck because the in-fork
  // interface uses optional (?: string) which widens to string | undefined, not string | null.
  lastEventType?: string;
  // ISO string (or null) to match the in-fork patched liveness contract
  // (044-opencode-recovery-hardening.patch `lastMeaningfulEventAt?: string | null`)
  // and OpenCode's OpenCodeLivenessSnapshot. A numeric field fails the in-fork typecheck.
  lastMeaningfulEventAt: string | null;
}

export type CodexTimingDecision =
  | { kind: 'none' }
  | { kind: 'inactivity-notice'; liveness: CodexLiveness }
  | { kind: 'transport-timeout'; liveness: CodexLiveness }
  | { kind: 'absolute-timeout'; liveness: CodexLiveness };

const DEFAULTS: CodexTimingConfig = {
  transportTimeoutMs: 30 * 60 * 1000,
  absoluteTurnTimeoutMs: 6 * 60 * 60 * 1000,
  inactivityNoticeMs: 5 * 60 * 1000,
  inactivityThrottleMs: 5 * 60 * 1000,
};

export function codexTimingConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CodexTimingConfig {
  const num = (k: keyof CodexTimingConfig, envKey: string): number => {
    const v = Number(env[envKey]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
  };
  return {
    transportTimeoutMs: num('transportTimeoutMs', 'CODEX_TRANSPORT_TIMEOUT_MS'),
    absoluteTurnTimeoutMs: num('absoluteTurnTimeoutMs', 'CODEX_ABSOLUTE_TURN_TIMEOUT_MS'),
    inactivityNoticeMs: num('inactivityNoticeMs', 'CODEX_INACTIVITY_NOTICE_MS'),
    inactivityThrottleMs: num('inactivityThrottleMs', 'CODEX_INACTIVITY_THROTTLE_MS'),
  };
}

export class CodexTurnTimers {
  private startedAt: number;
  private lastEventAt: number;
  private lastMeaningfulAt: number | null = null;   // ms internally; exposed as ISO in liveness()
  private lastEventType: string | undefined = undefined;
  private nextInactivityAt: number;

  constructor(private readonly clock: CodexTimingClock, private readonly cfg: CodexTimingConfig) {
    const now = clock.now();
    this.startedAt = now;
    this.lastEventAt = now;
    this.nextInactivityAt = now + cfg.inactivityNoticeMs;
  }

  /** Record an inbound notification. `meaningful=false` for transport-only pings. */
  onActivity(eventType: string, meaningful: boolean): void {
    const now = this.clock.now();
    this.lastEventAt = now;                 // ANY event keeps the transport alive
    this.lastEventType = eventType;
    if (meaningful) {                       // only meaningful events defer the notice
      this.lastMeaningfulAt = now;
      this.nextInactivityAt = now + this.cfg.inactivityNoticeMs;
    }
  }

  liveness(): CodexLiveness {
    return {
      configuredTimeoutMs: this.cfg.transportTimeoutMs,
      elapsedMs: this.clock.now() - this.startedAt,
      // undefined when no event has been seen yet (matches ProviderLivenessMetadata: lastEventType?: string).
      lastEventType: this.lastEventType,
      // ISO string to match the in-fork patched contract (string | null).
      lastMeaningfulEventAt: this.lastMeaningfulAt === null ? null : new Date(this.lastMeaningfulAt).toISOString(),
    };
  }

  /** ms until the soonest threshold, for arming a wake timer. */
  nextWakeMs(): number {
    const now = this.clock.now();
    return Math.max(0, Math.min(
      this.lastEventAt + this.cfg.transportTimeoutMs - now,
      this.startedAt + this.cfg.absoluteTurnTimeoutMs - now,
      this.nextInactivityAt - now,
    ));
  }

  /** Evaluate at the current clock. Terminal conditions take priority. */
  poll(): CodexTimingDecision {
    const now = this.clock.now();
    if (now - this.startedAt >= this.cfg.absoluteTurnTimeoutMs) {
      return { kind: 'absolute-timeout', liveness: this.liveness() };
    }
    if (now - this.lastEventAt >= this.cfg.transportTimeoutMs) {
      return { kind: 'transport-timeout', liveness: this.liveness() };
    }
    if (now >= this.nextInactivityAt) {
      this.nextInactivityAt = now + this.cfg.inactivityThrottleMs;
      return { kind: 'inactivity-notice', liveness: this.liveness() };
    }
    return { kind: 'none' };
  }
}
