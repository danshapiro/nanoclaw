/**
 * Deterministic, wall-clock-free tests for the single-reader OpenCode event
 * pump. `bun test` has no fake-timer facility, so the pump takes an INJECTED
 * clock+scheduler (now()/schedule()) and never touches global timers; these
 * tests drive a FakeClock that advances virtual time instantly so a 16-minute
 * or 6-hour scenario completes in microseconds.
 */
import { describe, it, expect } from 'bun:test';

import { OpenCodeEventPump, type OpenCodePumpResult } from './opencode-events.js';

type Ev = { type: string; properties: Record<string, unknown> };

// ── Deterministic clock + scheduler ─────────────────────────────────────────
// schedule(delayMs, cb) registers a callback to run when virtual time reaches
// now+delayMs. advance(ms) steps virtual time forward, firing due callbacks in
// order. The pump must use ONLY this seam — never setTimeout/Date.now.
class FakeClock {
  private current = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; cb: () => void }>();

  now = (): number => this.current;

  schedule = (delayMs: number, cb: () => void): (() => void) => {
    const id = this.seq++;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), cb });
    return () => {
      this.timers.delete(id);
    };
  };

  /** Advance virtual time by `ms`, firing every callback whose deadline passes. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const t = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.current = t.at;
      t.cb();
      // Allow any microtasks the callback queued to settle before the next one.
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }
}

// ── Controllable stream source ──────────────────────────────────────────────
// A manually-driven async stream: tests push events / end / error on demand,
// and reads block (return a never-resolving promise of the next value) until
// something is pushed. This models a real SSE stream that may go silent.
class FakeStream<T> {
  private queue: Array<{ value?: T; done?: boolean; error?: unknown }> = [];
  private waiter: ((r: { value?: T; done?: boolean; error?: unknown }) => void) | null = null;

  push(value: T): void {
    this.deliver({ value });
  }
  end(): void {
    this.deliver({ done: true });
  }
  fail(error: unknown): void {
    this.deliver({ error });
  }

  private deliver(r: { value?: T; done?: boolean; error?: unknown }): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(r);
    } else {
      this.queue.push(r);
    }
  }

  next(): Promise<IteratorResult<T, void>> {
    return new Promise((resolve, reject) => {
      const settle = (r: { value?: T; done?: boolean; error?: unknown }) => {
        if (r.error !== undefined) reject(r.error);
        else if (r.done) resolve({ done: true, value: undefined });
        else resolve({ done: false, value: r.value as T });
      };
      if (this.queue.length > 0) settle(this.queue.shift()!);
      else this.waiter = (r) => settle(r);
    });
  }
}

const SESSION = 'ses_active';

function makePump(opts: {
  clock: FakeClock;
  stream: FakeStream<Ev>;
  transportTimeoutMs?: number;
  absoluteTurnTimeoutMs?: number;
  inactivityNoticeMs?: number;
  inactivityThrottleMs?: number;
  waitTickMs?: number;
}): OpenCodeEventPump<Ev> {
  return new OpenCodeEventPump<Ev>({
    now: opts.clock.now,
    schedule: opts.clock.schedule,
    stream: opts.stream as unknown as AsyncGenerator<Ev, void, void>,
    transportTimeoutMs: opts.transportTimeoutMs ?? 30 * 60 * 1000,
    absoluteTurnTimeoutMs: opts.absoluteTurnTimeoutMs ?? 6 * 60 * 60 * 1000,
    inactivityNoticeMs: opts.inactivityNoticeMs ?? 5 * 60 * 1000,
    inactivityThrottleMs: opts.inactivityThrottleMs ?? 5 * 60 * 1000,
    waitTickMs: opts.waitTickMs ?? 60 * 1000,
    keepaliveTypes: ['server.connected', 'server.heartbeat'],
    isSessionEvent: (ev) => {
      const sid = (ev.properties as { sessionID?: string }).sessionID;
      // session-scoped events must match; keepalives have no sessionID.
      return sid === undefined || sid === SESSION;
    },
  });
}

/** Resolve a pump.next() while advancing the fake clock so timers can fire. */
async function nextWithClock(
  pump: OpenCodeEventPump<Ev>,
  clock: FakeClock,
  advanceMs: number,
): Promise<OpenCodePumpResult<Ev>> {
  const p = pump.next();
  await clock.advance(advanceMs);
  return p;
}

describe('OpenCodeEventPump — events and keepalives', () => {
  it('yields a meaningful event with liveness metadata', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream });

    const p = pump.next();
    stream.push({ type: 'session.idle', properties: { sessionID: SESSION } });
    const res = await p;

    expect(res.kind).toBe('event');
    if (res.kind !== 'event') return;
    expect(res.event.type).toBe('session.idle');
    expect(res.metadata.lastEventType).toBe('session.idle');
    expect(res.metadata.configuredTimeoutMs).toBe(30 * 60 * 1000);
    expect(typeof res.metadata.elapsedMs).toBe('number');
  });

  it('yields keepalive for server.heartbeat and updates liveness without resolving meaningful work', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream });

    const p = pump.next();
    stream.push({ type: 'server.heartbeat', properties: {} });
    const res = await p;

    expect(res.kind).toBe('keepalive');
    if (res.kind !== 'keepalive') return;
    expect(res.event.type).toBe('server.heartbeat');
    expect(res.metadata.lastEventType).toBe('server.heartbeat');
  });

  it('emits a wait-tick before transport timeout when the stream is silent', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream, waitTickMs: 60_000, transportTimeoutMs: 30 * 60_000 });

    const res = await nextWithClock(pump, clock, 60_000);
    expect(res.kind).toBe('wait-tick');
    if (res.kind !== 'wait-tick') return;
    expect(res.metadata.elapsedMs).toBe(60_000);
  });
});

describe('OpenCodeEventPump — no-SSE long work stays alive past the Dvora gap', () => {
  it('keeps emitting wait-ticks beyond 16 minutes when transportTimeoutMs is above that', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 60_000,
      inactivityNoticeMs: 60 * 60_000, // keep inactivity out of the way for this test
      transportTimeoutMs: 30 * 60_000,
    });

    // 16 minutes of pure silence — must NOT terminate.
    for (let min = 1; min <= 16; min++) {
      const res = await nextWithClock(pump, clock, 60_000);
      expect(['wait-tick', 'keepalive']).toContain(res.kind);
    }
    expect(clock.now()).toBe(16 * 60_000);
  });

  it('fires transport-timeout only once transportTimeoutMs of silence elapses', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 5 * 60_000,
      inactivityNoticeMs: 60 * 60_000,
      transportTimeoutMs: 30 * 60_000,
    });

    // Walk forward in 5-min wait-ticks until the transport deadline.
    let res: OpenCodePumpResult<Ev> | undefined;
    for (let i = 0; i < 10; i++) {
      res = await nextWithClock(pump, clock, 5 * 60_000);
      if (res.kind === 'transport-timeout') break;
    }
    expect(res?.kind).toBe('transport-timeout');
    if (res?.kind !== 'transport-timeout') return;
    expect(res.error.liveness.configuredTimeoutMs).toBe(30 * 60_000);
    expect(res.error.liveness.elapsedMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(res.error.liveness.lastEventType).toBeDefined();
    // Transport timeout preserves continuation by default.
    expect(res.error.continuationPolicy).toBe('preserve');
  });
});

describe('OpenCodeEventPump — inactivity notices (non-terminal)', () => {
  it('fires an inactivity-notice at OPENCODE_INACTIVITY_NOTICE_MS, repeats, and does not end the stream', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 60_000,
      inactivityNoticeMs: 5 * 60_000,
      inactivityThrottleMs: 5 * 60_000,
      transportTimeoutMs: 30 * 60_000,
    });

    const notices: OpenCodePumpResult<Ev>[] = [];
    // Walk 12 minutes; expect a notice at ~5 min and again at ~10 min.
    for (let min = 1; min <= 12; min++) {
      const res = await nextWithClock(pump, clock, 60_000);
      if (res.kind === 'inactivity-notice') notices.push(res);
      expect(res.kind).not.toBe('transport-timeout');
      expect(res.kind).not.toBe('ended');
    }
    expect(notices.length).toBeGreaterThanOrEqual(2);
    const first = notices[0];
    if (first.kind !== 'inactivity-notice') throw new Error('expected inactivity-notice');
    expect(first.metadata.configuredTimeoutMs).toBe(30 * 60_000);
    expect(first.metadata.elapsedMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(first.metadata.lastMeaningfulEventAt === null || typeof first.metadata.lastMeaningfulEventAt === 'string').toBe(
      true,
    );
  });

  it('fires an inactivity-notice even when ONLY keepalives arrive (heartbeat-only Dvora scenario)', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 60_000,
      inactivityNoticeMs: 5 * 60_000,
      inactivityThrottleMs: 5 * 60_000,
      // Transport never dies because heartbeats keep it fresh — exactly the
      // no-SSE/heartbeat-only long-work case. The inactivity NOTICE must still
      // fire because no MEANINGFUL event arrived.
      transportTimeoutMs: 30 * 60_000,
    });

    let sawNotice = false;
    // Deliver a heartbeat every minute for 6 minutes. Keepalives keep the
    // transport alive but must NOT defer the inactivity (no-meaningful-event)
    // clock, so a notice must fire by ~5 minutes.
    for (let min = 1; min <= 6; min++) {
      const p = pump.next();
      stream.push({ type: 'server.heartbeat', properties: {} });
      await clock.advance(60_000);
      const res = await p;
      if (res.kind === 'inactivity-notice') sawNotice = true;
      expect(res.kind).not.toBe('transport-timeout');
      expect(res.kind).not.toBe('ended');
    }
    expect(sawNotice).toBe(true);
  });

  it('a later session.idle after inactivity returns normally', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 60_000,
      inactivityNoticeMs: 5 * 60_000,
      transportTimeoutMs: 30 * 60_000,
    });

    // Sit silent for 6 minutes (past one inactivity notice).
    let sawNotice = false;
    for (let min = 1; min <= 6; min++) {
      const res = await nextWithClock(pump, clock, 60_000);
      if (res.kind === 'inactivity-notice') sawNotice = true;
    }
    expect(sawNotice).toBe(true);

    // Now the session finishes.
    const p = pump.next();
    stream.push({ type: 'session.idle', properties: { sessionID: SESSION } });
    const res = await p;
    expect(res.kind).toBe('event');
    if (res.kind !== 'event') return;
    expect(res.event.type).toBe('session.idle');
  });
});

describe('OpenCodeEventPump — terminal results carry liveness metadata', () => {
  it('returns transport-timeout with liveness metadata when no events arrive', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 30 * 60_000,
      inactivityNoticeMs: 60 * 60_000,
      transportTimeoutMs: 30 * 60_000,
    });

    const res = await nextWithClock(pump, clock, 30 * 60_000);
    expect(res.kind).toBe('transport-timeout');
    if (res.kind !== 'transport-timeout') return;
    expect(res.error.liveness.configuredTimeoutMs).toBe(30 * 60_000);
    expect(res.error.liveness.elapsedMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('returns absolute-timeout (distinct from transport-timeout) at the absolute turn ceiling, independent of heartbeats', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({
      clock,
      stream,
      waitTickMs: 60_000,
      inactivityNoticeMs: 60 * 60_000,
      // transport timeout never fires because heartbeats keep refreshing it,
      // but the absolute ceiling must still terminate the turn.
      transportTimeoutMs: 30 * 60_000,
      absoluteTurnTimeoutMs: 10 * 60_000,
    });

    // Heartbeat every 30s so transport never times out; the pump must still
    // kill the turn at the 10-minute absolute ceiling.
    let res: OpenCodePumpResult<Ev> | undefined;
    for (let i = 0; i < 40; i++) {
      const p = pump.next();
      // deliver a heartbeat ~immediately each loop, then advance 30s.
      stream.push({ type: 'server.heartbeat', properties: {} });
      await clock.advance(30_000);
      res = await p;
      if (res.kind === 'absolute-timeout') break;
    }
    expect(res?.kind).toBe('absolute-timeout');
    if (res?.kind !== 'absolute-timeout') return;
    expect(res.error.liveness.elapsedMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(res.error.continuationPolicy).toBe('preserve');
  });

  it('returns read-error with liveness metadata when the stream read throws', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream });

    const p = pump.next();
    stream.fail(new Error('ECONNRESET while reading OpenCode events'));
    const res = await p;
    expect(res.kind).toBe('read-error');
    if (res.kind !== 'read-error') return;
    expect(res.error.liveness.configuredTimeoutMs).toBe(30 * 60_000);
    expect(res.error.continuationPolicy).toBe('preserve');
    // Sanitized — no raw provider text in the user-facing fallback.
    expect(res.error.fallbackUserMessage).not.toContain('ECONNRESET');
  });

  it('returns ended with liveness metadata when the stream ends', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream });

    const p = pump.next();
    stream.end();
    const res = await p;
    expect(res.kind).toBe('ended');
    if (res.kind !== 'ended') return;
    expect(res.error.liveness.configuredTimeoutMs).toBe(30 * 60_000);
    expect(res.error.continuationPolicy).toBe('preserve');
  });
});

describe('OpenCodeEventPump — session filtering', () => {
  it('does not wake the active waiter for other-session events', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream, waitTickMs: 60_000, transportTimeoutMs: 30 * 60_000 });

    const p = pump.next();
    // Event for a different session — must be ignored, not delivered.
    stream.push({ type: 'session.idle', properties: { sessionID: 'ses_other' } });
    // No meaningful delivery; the next thing should be a wait-tick at 60s.
    await clock.advance(60_000);
    const res = await p;
    expect(res.kind).toBe('wait-tick');
  });
});

describe('OpenCodeEventPump — bounded queue never drops protected events', () => {
  it('returns queue-overflow rather than silently dropping, and preserves protected events', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = new OpenCodeEventPump<Ev>({
      now: clock.now,
      schedule: clock.schedule,
      stream: stream as unknown as AsyncGenerator<Ev, void, void>,
      transportTimeoutMs: 30 * 60_000,
      absoluteTurnTimeoutMs: 6 * 60 * 60_000,
      inactivityNoticeMs: 60 * 60_000,
      inactivityThrottleMs: 60 * 60_000,
      waitTickMs: 60_000,
      keepaliveTypes: ['server.connected', 'server.heartbeat'],
      maxQueue: 4,
      isSessionEvent: (ev) => {
        const sid = (ev.properties as { sessionID?: string }).sessionID;
        return sid === undefined || sid === SESSION;
      },
      isProtectedEvent: (ev) =>
        ev.type === 'session.error' ||
        ev.type === 'permission.updated' ||
        ev.type === 'question.asked' ||
        ev.type === 'message.part.updated' ||
        ev.type === 'side-effect',
    });

    // Kick the perpetual reader (first next() starts it), then let it read the
    // whole flood ahead of the consumer so the bounded queue genuinely
    // overflows. We do NOT await this promise yet — we let the reader fill.
    const firstNext = pump.next();

    // Flood the pump well beyond maxQueue with droppable noise PLUS one
    // protected event that must survive eviction.
    for (let i = 0; i < 20; i++) {
      stream.push({ type: 'message.updated', properties: { sessionID: SESSION, n: i } });
    }
    stream.push({ type: 'permission.updated', properties: { sessionID: SESSION, id: 'perm-1' } });

    // Let the read-ahead loop run to completion (it yields a microtask between
    // reads); a generous spin lets it consume the whole synchronous flood.
    for (let i = 0; i < 200; i++) await Promise.resolve();

    // Drain EVERYTHING the pump will yield. Across all results we must (a) never
    // silently lose the protected permission event, and (b) signal
    // queue-overflow rather than dropping it. Order of the two is not asserted.
    const seen: string[] = [];
    let overflowSeen = false;
    const handle = (res: OpenCodePumpResult<Ev>): boolean => {
      if (res.kind === 'queue-overflow') {
        overflowSeen = true;
        expect(res.error.liveness.configuredTimeoutMs).toBe(30 * 60_000);
        return true; // terminal — stop draining
      }
      if (res.kind === 'event' || res.kind === 'keepalive') {
        seen.push(res.event.type);
        return false;
      }
      return true; // some other terminal — stop
    };
    let done = handle(await firstNext);
    for (let i = 0; i < 60 && !done; i++) {
      done = handle(await pump.next());
    }
    expect(overflowSeen).toBe(true);
    expect(seen).toContain('permission.updated');
  });
});

describe('OpenCodeEventPump — stop() settles a parked next() and cancels its armed timers', () => {
  it('resolves a parked next() and fires no orphaned scheduled callback afterward', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    const pump = makePump({ clock, stream, waitTickMs: 60_000, transportTimeoutMs: 30 * 60_000 });

    pump.beginTurn();
    // Park a next() with armed wait-tick / transport / absolute / inactivity
    // timers; the stream stays silent.
    const parked = pump.next();
    // End the turn while next() is parked.
    pump.stop();

    // The parked promise must settle cleanly (not hang) with a benign
    // non-terminal result.
    const res = await parked;
    expect(['wait-tick', 'keepalive', 'inactivity-notice']).toContain(res.kind);

    // No orphaned timer: advancing well past every armed deadline must not throw
    // (a cancelled scheduler callback would otherwise try to settle again).
    await clock.advance(7 * 60 * 60_000);
    expect(true).toBe(true);
  });
});

describe('OpenCodeEventPump — cross-turn handoff over a shared long-lived stream', () => {
  it('does not lose the follow-up turn first protected event after a clean turn-1 session.idle + stop()', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream<Ev>();
    // ONE long-lived pump wraps the SAME shared stream for the whole session.
    const pump = makePump({ clock, stream, waitTickMs: 60_000, transportTimeoutMs: 30 * 60_000 });

    // ── Turn 1: prompt → session.idle → stop() (clean turn end). ──────────────
    pump.beginTurn();
    const t1 = pump.next();
    stream.push({ type: 'session.idle', properties: { sessionID: SESSION } });
    const r1 = await t1;
    expect(r1.kind).toBe('event');
    if (r1.kind !== 'event') return;
    expect(r1.event.type).toBe('session.idle');
    // The turn-loop calls stop() on a clean session.idle. With the previous
    // per-turn-pump design the reader's in-flight read-ahead would consume the
    // NEXT event into a discarded queue; the long-lived pump must keep it.
    pump.stop();

    // ── The follow-up turn's FIRST event arrives on the same shared stream. ───
    // This is a protected native question (permission.updated) — losing it means
    // a missed native question. It must reach turn 2, not the dead read-ahead.
    stream.push({ type: 'permission.updated', properties: { sessionID: SESSION, id: 'perm-followup' } });
    // Let any read-ahead loop settle.
    for (let i = 0; i < 50; i++) await Promise.resolve();

    // ── Turn 2: begins a new turn over the SAME pump/stream. ──────────────────
    pump.beginTurn();
    const r2 = await pump.next();
    expect(r2.kind).toBe('event');
    if (r2.kind !== 'event') return;
    expect(r2.event.type).toBe('permission.updated');
    expect((r2.event.properties as { id?: string }).id).toBe('perm-followup');
  });
});
