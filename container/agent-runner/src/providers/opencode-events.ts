/**
 * Single-reader OpenCode SSE event pump.
 *
 * This is the ONLY place in the runner that calls `stream.next()` on the
 * OpenCode event stream. It:
 *   - filters events to the active session (other-session events are dropped
 *     and never wake the active waiter),
 *   - classifies keepalives vs meaningful events and tracks liveness,
 *   - emits non-terminal `wait-tick` / `keepalive` / `inactivity-notice`
 *     results so long no-SSE work stays state-preserving past the observed
 *     Dvora gap,
 *   - enforces the transport timeout AND, independently of heartbeat, the
 *     absolute turn ceiling, returning typed terminal results that all carry
 *     liveness metadata,
 *   - uses a bounded internal queue that NEVER silently drops protected events
 *     (terminal/permission/question/assistant-text/side-effect) — it returns a
 *     `queue-overflow` terminal result instead.
 *
 * Determinism: the pump takes an INJECTED clock+scheduler (`now()` /
 * `schedule(delayMs, cb): cancel`) as mandatory, total dependencies and NEVER
 * calls global `setTimeout`/`setInterval`/`Date.now`, so a 16-minute / 6-hour
 * scenario is driven instantly by a fake clock in tests.
 */

import {
  OpenCodeAbsoluteTimeoutError,
  OpenCodeQueueOverflowError,
  OpenCodeStreamEndedError,
  OpenCodeStreamReadError,
  OpenCodeTransportTimeoutError,
  type OpenCodeLivenessSnapshot,
} from './opencode-errors.js';

export type { OpenCodeLivenessSnapshot } from './opencode-errors.js';

export type OpenCodePumpResult<T> =
  | { kind: 'event'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'keepalive'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'wait-tick'; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'inactivity-notice'; metadata: OpenCodeLivenessSnapshot & { configuredTimeoutMs: number; elapsedMs: number } }
  | { kind: 'transport-timeout'; error: OpenCodeTransportTimeoutError }
  | { kind: 'absolute-timeout'; error: OpenCodeAbsoluteTimeoutError }
  | { kind: 'read-error'; error: OpenCodeStreamReadError }
  | { kind: 'ended'; error: OpenCodeStreamEndedError }
  | { kind: 'queue-overflow'; error: OpenCodeQueueOverflowError };

export interface OpenCodePumpClock {
  /** Monotonic-ish virtual/real clock in ms. NEVER `Date.now` directly. */
  now(): number;
  /** Schedule `cb` after `delayMs`; returns a cancel function. */
  schedule(delayMs: number, cb: () => void): () => void;
}

export interface OpenCodeEventPumpConfig<T> extends OpenCodePumpClock {
  stream: AsyncGenerator<T, void, void> | { next(): Promise<IteratorResult<T, void>> };
  sessionId: string;
  /** No-SSE transport death window (default no active long tool ≥ 30 min). */
  transportTimeoutMs: number;
  /** Hard maximum turn lifetime; the pump enforces this independent of heartbeat. */
  absoluteTurnTimeoutMs: number;
  /** First inactivity notice fires after this much silence. */
  inactivityNoticeMs: number;
  /** Subsequent inactivity notices repeat at this interval. */
  inactivityThrottleMs: number;
  /** Wait-tick cadence; each tick refreshes the host heartbeat upstream. */
  waitTickMs: number;
  /** Event types treated as keepalives (refresh liveness, not meaningful). */
  keepaliveTypes: string[];
  /** True if the event belongs to the active session (or is a session-less keepalive). */
  isSessionEvent: (event: T) => boolean;
  /** Optional: protected events that must never be dropped on overflow. */
  isProtectedEvent?: (event: T) => boolean;
  /** Bounded internal queue depth (default 256). */
  maxQueue?: number;
}

type Pending<T> =
  | { kind: 'value'; value: T }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown };

export class OpenCodeEventPump<T extends { type?: string }> {
  private readonly cfg: OpenCodeEventPumpConfig<T>;
  private readonly maxQueue: number;
  private readonly startedAt: number;

  /** Bounded queue of session-scoped, already-classified pending items. */
  private readonly queue: Pending<T>[] = [];
  /** Terminal condition latched from the reader (read error / stream end). */
  private terminal: { kind: 'done' } | { kind: 'error'; error: unknown } | null = null;

  /** The single perpetual background reader loop. */
  private readerLoop: Promise<void> | null = null;
  private streamDone = false;
  /** Resolver that wakes a parked pump.next() when the reader makes progress. */
  private consumerNotify: (() => void) | null = null;

  /** Liveness tracking. */
  private lastEventType: string | null = null;
  private lastEventAt: number;
  private lastMeaningfulEventAt: number | null = null;

  /** Inactivity-notice scheduling. */
  private nextInactivityAt: number;

  constructor(cfg: OpenCodeEventPumpConfig<T>) {
    this.cfg = cfg;
    this.maxQueue = cfg.maxQueue ?? 256;
    this.startedAt = cfg.now();
    this.lastEventAt = this.startedAt;
    this.nextInactivityAt = this.startedAt + cfg.inactivityNoticeMs;
  }

  private elapsed(): number {
    return this.cfg.now() - this.startedAt;
  }

  private snapshot(): OpenCodeLivenessSnapshot {
    return {
      configuredTimeoutMs: this.cfg.transportTimeoutMs,
      elapsedMs: this.elapsed(),
      lastEventType: this.lastEventType,
      lastMeaningfulEventAt: this.lastMeaningfulEventAt === null ? null : new Date(this.lastMeaningfulEventAt).toISOString(),
    };
  }

  private isKeepalive(event: T): boolean {
    const t = event.type;
    return !t || this.cfg.keepaliveTypes.includes(t);
  }

  private isProtected(event: T): boolean {
    return this.cfg.isProtectedEvent ? this.cfg.isProtectedEvent(event) : false;
  }

  /** Wake any parked pump.next() that is waiting on reader progress. */
  private wakeConsumer(): void {
    if (this.consumerNotify) {
      const n = this.consumerNotify;
      this.consumerNotify = null;
      n();
    }
  }

  /**
   * Start (once) the single perpetual reader loop. It is the ONLY caller of
   * `stream.next()`. It reads ahead into the bounded queue, drops other-session
   * events, latches terminal conditions, and on overflow evicts the OLDEST
   * droppable queued event to make room — never a protected one — signalling
   * overflow rather than silently dropping protected events.
   */
  private startReader(): void {
    if (this.readerLoop || this.streamDone) return;
    this.readerLoop = (async () => {
      while (!this.streamDone) {
        let res: IteratorResult<T, void>;
        try {
          res = await this.cfg.stream.next();
        } catch (error) {
          this.terminal = { kind: 'error', error };
          this.streamDone = true;
          this.wakeConsumer();
          return;
        }
        if (res.done) {
          this.terminal = { kind: 'done' };
          this.streamDone = true;
          this.wakeConsumer();
          return;
        }
        const event = res.value;
        // Drop other-session events entirely; keep reading.
        if (!this.cfg.isSessionEvent(event)) {
          continue;
        }
        this.enqueue(event);
        this.wakeConsumer();
        // Yield to the event loop so a draining consumer can interleave; keeps
        // the read-ahead from starving the consumer in a tight synchronous burst.
        await Promise.resolve();
      }
    })();
  }

  /**
   * Bounded enqueue. NEVER silently drops a protected event. At capacity it
   * evicts the oldest DROPPABLE queued event to make room and latches a
   * one-time overflow signal. If every queued event is protected, the protected
   * incoming event is still queued (the buffer grows past the soft cap rather
   * than lose protected work) and overflow is latched.
   */
  private enqueue(event: T): void {
    if (this.queue.length < this.maxQueue) {
      this.queue.push({ kind: 'value', value: event });
      return;
    }

    // At/over capacity → overflow. Latch the signal once.
    this.terminal = this.terminal ?? { kind: 'error', error: new OpenCodeQueueOverflowError(this.snapshot()) };

    const incomingProtected = this.isProtected(event);
    if (!incomingProtected) {
      // Drop the incoming droppable event (overflow already signalled). Keeps
      // protected events already queued intact.
      return;
    }

    // Incoming is protected and MUST be kept. Evict the oldest droppable queued
    // event to make room; if none is droppable, grow the queue rather than drop
    // protected work.
    const evictIdx = this.queue.findIndex((p) => p.kind === 'value' && !this.isProtected(p.value));
    if (evictIdx >= 0) this.queue.splice(evictIdx, 1);
    this.queue.push({ kind: 'value', value: event });
  }

  private recordEvent(event: T): void {
    const now = this.cfg.now();
    this.lastEventType = event.type ?? null;
    this.lastEventAt = now;
    if (!this.isKeepalive(event)) {
      this.lastMeaningfulEventAt = now;
    }
    // Any event activity defers the next inactivity notice.
    this.nextInactivityAt = now + this.cfg.inactivityNoticeMs;
  }

  private classifyTerminal(t: { kind: 'done' } | { kind: 'error'; error: unknown }): OpenCodePumpResult<T> {
    if (t.kind === 'done') {
      return { kind: 'ended', error: new OpenCodeStreamEndedError(this.snapshot()) };
    }
    // kind === 'error'
    if (t.error instanceof OpenCodeQueueOverflowError) {
      return { kind: 'queue-overflow', error: t.error };
    }
    return { kind: 'read-error', error: new OpenCodeStreamReadError(this.snapshot()) };
  }

  /**
   * Pull the next pump result. Resolves with a queued event/keepalive if one is
   * available, otherwise arms wait-tick / inactivity / transport / absolute
   * timers and races them against the next queued item or terminal condition.
   */
  next(): Promise<OpenCodePumpResult<T>> {
    this.startReader();

    // 1. Drain any already-queued session event first.
    const drained = this.drainQueued();
    if (drained) return Promise.resolve(drained);

    // 2. If a terminal condition is latched and the queue is empty, surface it.
    if (this.queue.length === 0 && this.terminal) {
      return Promise.resolve(this.classifyTerminal(this.terminal));
    }

    // 3. Otherwise wait: race the reader against scheduler-driven timers.
    return new Promise<OpenCodePumpResult<T>>((resolve) => {
      let settled = false;
      const cancels: Array<() => void> = [];
      const cleanup = () => {
        for (const c of cancels) {
          try {
            c();
          } catch {
            /* ignore */
          }
        }
        cancels.length = 0;
      };
      const settle = (r: OpenCodePumpResult<T>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      };

      // Absolute ceiling — enforced independent of any heartbeat. Computed from
      // turn start, so heartbeats cannot push it out.
      const absoluteRemaining = this.cfg.absoluteTurnTimeoutMs - this.elapsed();
      cancels.push(
        this.cfg.schedule(Math.max(0, absoluteRemaining), () => {
          settle({ kind: 'absolute-timeout', error: new OpenCodeAbsoluteTimeoutError(this.snapshot()) });
        }),
      );

      // Transport timeout — from the last event (silence window).
      const transportRemaining = this.lastEventAt + this.cfg.transportTimeoutMs - this.cfg.now();
      cancels.push(
        this.cfg.schedule(Math.max(0, transportRemaining), () => {
          settle({ kind: 'transport-timeout', error: new OpenCodeTransportTimeoutError(this.snapshot()) });
        }),
      );

      // Inactivity notice — non-terminal; fires at the configured point and
      // again at the throttle interval. Only relevant before transport death.
      const inactivityRemaining = this.nextInactivityAt - this.cfg.now();
      if (this.nextInactivityAt < this.lastEventAt + this.cfg.transportTimeoutMs) {
        cancels.push(
          this.cfg.schedule(Math.max(0, inactivityRemaining), () => {
            // Schedule the next throttled notice and surface this one.
            this.nextInactivityAt = this.cfg.now() + this.cfg.inactivityThrottleMs;
            const base = this.snapshot();
            settle({
              kind: 'inactivity-notice',
              metadata: { ...base, configuredTimeoutMs: base.configuredTimeoutMs, elapsedMs: base.elapsedMs },
            });
          }),
        );
      }

      // Wait tick — keeps long no-SSE work alive and refreshes the heartbeat
      // upstream. Fires before transport/absolute death.
      cancels.push(
        this.cfg.schedule(Math.max(0, this.cfg.waitTickMs), () => {
          settle({ kind: 'wait-tick', metadata: this.snapshot() });
        }),
      );

      // Reader progress wakes this waiter. The reader drained one event into the
      // queue (or latched a terminal); surface it, then re-park if the wake was
      // spurious (e.g. only other-session events were dropped).
      const onProgress = (): void => {
        if (settled) return;
        const drained = this.drainQueued();
        if (drained) {
          settle(drained);
          return;
        }
        if (this.terminal && this.queue.length === 0) {
          settle(this.classifyTerminal(this.terminal));
          return;
        }
        // Spurious wake — re-park until the reader makes real progress or a
        // timer fires.
        this.consumerNotify = onProgress;
      };
      this.consumerNotify = onProgress;
      // The reader may have already produced an item before we parked.
      if (this.queue.length > 0 || this.terminal) onProgress();
    });
  }

  /** Shift one queued session event and return its pump result, or null. */
  private drainQueued(): OpenCodePumpResult<T> | null {
    const item = this.queue.shift();
    if (!item || item.kind !== 'value') return null;
    this.recordEvent(item.value);
    const metadata = this.snapshot();
    return this.isKeepalive(item.value)
      ? { kind: 'keepalive', event: item.value, metadata }
      : { kind: 'event', event: item.value, metadata };
  }

  /**
   * Stop the pump: mark the stream done so the reader loop exits after its
   * current outstanding read settles, and wake any parked consumer. The pump is
   * single-use per turn; the caller stops it when the turn ends. (It does NOT
   * close the shared stream — that is owned by the runtime controller.)
   */
  stop(): void {
    this.streamDone = true;
    this.wakeConsumer();
  }

  /** Current liveness snapshot (for structured logging by the provider). */
  liveness(): OpenCodeLivenessSnapshot {
    return this.snapshot();
  }
}
