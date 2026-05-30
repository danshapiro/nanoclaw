/**
 * Typed OpenCode interruption errors + the missing-session classifier.
 *
 * Design contract (see plan Hard Invariants 151–153):
 *   - All typed errors carry liveness metadata (configured timeout, elapsed
 *     time, last event type, last meaningful-event timestamp) and PRESERVE
 *     continuation by default. A transport error, bare 404, ECONNRESET, stream
 *     end, queue overflow, or "event timeout" text is NEVER stale-session proof.
 *   - `isMissingOpenCodeSessionError(err, attemptedSessionId)` is a DIAGNOSTIC /
 *     TRIGGER predicate only — a verbatim attempted-id match may TRIGGER the
 *     authoritative positive existence check, but is never itself an
 *     authoritative clear.
 *   - The only authoritative clears are (a) an explicit provider
 *     `clear-continuation`, (b) a positive existence check proving the session
 *     is gone (`classifyContinuation` with `sessionExists`), or (c) the bounded
 *     zombie path (`zombieDecision`).
 *   - Sanitization: user-facing/fallback messages NEVER embed raw provider error
 *     text, stack traces, secrets, or paths.
 */

import type { ProviderContinuationPolicy } from './types.js';

/**
 * Liveness snapshot attached to every notice/terminal pump result and to every
 * typed interruption error. Mirrors `ProviderLivenessMetadata` but with the
 * core fields required (not optional) so a terminal path always carries them.
 */
export interface OpenCodeLivenessSnapshot {
  configuredTimeoutMs: number;
  elapsedMs: number;
  lastEventType: string | null;
  lastMeaningfulEventAt: string | null;
}

export type OpenCodeInterruptionClassification =
  | 'transport-timeout'
  | 'absolute-timeout'
  | 'stream-read-error'
  | 'stream-ended'
  | 'queue-overflow';

/**
 * Base class for typed OpenCode interruptions. These are recoverable terminal
 * conditions, not stale-session proof. They preserve continuation by default;
 * only the poll loop's authoritative clears may change that.
 */
export class OpenCodeInterruptionError extends Error {
  readonly classification: OpenCodeInterruptionClassification;
  readonly liveness: OpenCodeLivenessSnapshot;
  /** Continuation is preserved unless an authoritative clear says otherwise. */
  readonly continuationPolicy: ProviderContinuationPolicy = 'preserve';
  /** Sanitized message safe to surface to the user (no raw provider text). */
  readonly fallbackUserMessage: string;

  constructor(args: {
    classification: OpenCodeInterruptionClassification;
    message: string;
    liveness: OpenCodeLivenessSnapshot;
    fallbackUserMessage: string;
  }) {
    super(args.message);
    this.name = new.target.name;
    this.classification = args.classification;
    this.liveness = args.liveness;
    this.fallbackUserMessage = args.fallbackUserMessage;
  }
}

const FALLBACK_TRANSPORT =
  'I lost the connection to the model while working on this and stopped before finishing. Your request is preserved; ask me to continue and I will pick it back up.';
const FALLBACK_ABSOLUTE =
  'This turn hit its maximum runtime and was stopped before finishing. Your request is preserved; ask me to continue.';
const FALLBACK_READ =
  'I hit an error reading the model event stream and stopped before finishing. Your request is preserved; ask me to continue.';
const FALLBACK_ENDED =
  'The model event stream ended unexpectedly before I finished. Your request is preserved; ask me to continue.';
const FALLBACK_OVERFLOW =
  'I fell behind on model events and had to stop this turn safely. Your request is preserved; ask me to continue.';

export class OpenCodeTransportTimeoutError extends OpenCodeInterruptionError {
  constructor(liveness: OpenCodeLivenessSnapshot) {
    super({
      classification: 'transport-timeout',
      message: `OpenCode transport timeout after ${liveness.configuredTimeoutMs}ms of silence`,
      liveness,
      fallbackUserMessage: FALLBACK_TRANSPORT,
    });
  }
}

export class OpenCodeAbsoluteTimeoutError extends OpenCodeInterruptionError {
  constructor(liveness: OpenCodeLivenessSnapshot) {
    super({
      classification: 'absolute-timeout',
      message: `OpenCode turn exceeded the absolute ceiling (elapsed ${liveness.elapsedMs}ms)`,
      liveness,
      fallbackUserMessage: FALLBACK_ABSOLUTE,
    });
  }
}

export class OpenCodeStreamReadError extends OpenCodeInterruptionError {
  constructor(liveness: OpenCodeLivenessSnapshot) {
    super({
      classification: 'stream-read-error',
      // Deliberately does NOT embed the raw cause text — sanitized.
      message: 'OpenCode event stream read error',
      liveness,
      fallbackUserMessage: FALLBACK_READ,
    });
  }
}

export class OpenCodeStreamEndedError extends OpenCodeInterruptionError {
  constructor(liveness: OpenCodeLivenessSnapshot) {
    super({
      classification: 'stream-ended',
      message: 'OpenCode event stream ended unexpectedly',
      liveness,
      fallbackUserMessage: FALLBACK_ENDED,
    });
  }
}

export class OpenCodeQueueOverflowError extends OpenCodeInterruptionError {
  constructor(liveness: OpenCodeLivenessSnapshot) {
    super({
      classification: 'queue-overflow',
      message: 'OpenCode event queue overflowed',
      liveness,
      fallbackUserMessage: FALLBACK_OVERFLOW,
    });
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * TRIGGER-ONLY predicate. Returns true ONLY when the EXACT attempted session id
 * appears verbatim in the error text alongside a missing-session phrase. It
 * requires attempted-session context and must not match generic
 * transport/read/timeout/404/NotFound strings.
 *
 * This is never itself authoritative to clear continuation: a true result may
 * only TRIGGER the positive existence check (`classifyContinuation`). In SDK
 * 1.15.10 the NotFoundError `data.message` is free-form and may NOT carry the
 * id, so this predicate is unsound for the false-negative direction — that is
 * exactly why it is trigger-only and the existence check is authoritative.
 */
export function isMissingOpenCodeSessionError(err: unknown, attemptedSessionId: string | undefined): boolean {
  if (!attemptedSessionId) return false;
  const text = errorText(err);
  // The attempted id must appear verbatim.
  if (!text.includes(attemptedSessionId)) return false;
  // …alongside an explicit missing-session phrase. A bare 404/ECONNRESET/timeout
  // that merely happens to contain the id is not a missing-session signal.
  return /\b(not found|no conversation found|does not exist|unknown session|missing session)\b/i.test(text);
}

export interface ContinuationClassification {
  policy: ProviderContinuationPolicy;
  reason?: string;
}

/**
 * AUTHORITATIVE continuation policy. The only way to return `clear` is a
 * positive existence check (`sessionExists` returning false). Any error text —
 * including a bare 404 — with a live (or unknown) session PRESERVES continuation.
 *
 * `sessionExists` is the probe-discovered existence-check seam (backed by
 * `client.session.get({ path: { id } })` returning NotFoundError ⇒ gone). When
 * omitted, there is no proof available, so continuation is preserved.
 */
export async function classifyContinuation(args: {
  attemptedContinuation: string;
  sessionExists?: (id: string) => Promise<boolean>;
  err?: unknown;
}): Promise<ContinuationClassification> {
  if (args.sessionExists) {
    const exists = await args.sessionExists(args.attemptedContinuation);
    if (!exists) return { policy: 'clear', reason: 'session-missing' };
  }
  // Live session, or no existence-check available: never clear on text alone.
  return { policy: 'preserve' };
}

export interface ZombieDecision {
  clear: boolean;
  userVisibleRestart: boolean;
}

/**
 * Bounded zombie backstop. After `limit` consecutive terminal interruptions on
 * the SAME continuation with no successful event in between, the continuation is
 * treated as unusable, cleared, and the next turn restarts from recovery with
 * user-visible context — never silently, never forever.
 */
export function zombieDecision(args: {
  continuation: string;
  consecutiveTerminalFailures: number;
  limit: number;
}): ZombieDecision {
  const clear = args.consecutiveTerminalFailures >= args.limit;
  return { clear, userVisibleRestart: clear };
}
