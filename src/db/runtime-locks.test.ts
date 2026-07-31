import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRuntimeLock,
  assertRuntimeLockOwner,
  clearStaleRuntimeLocks,
  releaseRuntimeLock,
  renewRuntimeLock,
  RuntimeLockHeldError,
  withRuntimeLock,
} from './runtime-locks.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('runtime locks (in-process)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearStaleRuntimeLocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearStaleRuntimeLocks();
  });

  it('rejects a second unexpired independent owner', async () => {
    const gate = deferred<void>();
    const first = withRuntimeLock('scheduler', 10_000, async () => {
      await gate.promise;
      return 'first';
    });

    await expect(withRuntimeLock('scheduler', 10_000, async () => 'second')).rejects.toThrow(/already held/);

    gate.resolve(undefined);
    await expect(first).resolves.toBe('first');
  });

  it('throws RuntimeLockHeldError with the exact message callers string-match on', () => {
    const owner = acquireRuntimeLock('scheduler-mutator', 10_000);
    try {
      expect(() => acquireRuntimeLock('scheduler-mutator', 10_000)).toThrow(RuntimeLockHeldError);
      expect(() => acquireRuntimeLock('scheduler-mutator', 10_000)).toThrow(
        'Runtime lock "scheduler-mutator" is already held by an unexpired owner',
      );
    } finally {
      releaseRuntimeLock(owner);
    }
  });

  it('nested same-context lock reuses the owner token', async () => {
    await withRuntimeLock('scheduler', 10_000, async (outer) => {
      await withRuntimeLock('scheduler', 10_000, async (inner) => {
        expect(inner).toEqual(outer);
        expect(inner.ownerToken).toBe(outer.ownerToken);
      });
    });
  });

  it('independent same-process concurrent lock does not run its fn', async () => {
    const gate = deferred<void>();
    let secondEntered = false;
    const first = withRuntimeLock('scheduler', 10_000, async () => {
      await gate.promise;
    });

    await expect(
      withRuntimeLock('scheduler', 10_000, async () => {
        secondEntered = true;
      }),
    ).rejects.toThrow(/already held/);
    expect(secondEntered).toBe(false);

    gate.resolve(undefined);
    await first;
  });

  it('expired lock can be stolen', () => {
    vi.useFakeTimers();
    const first = acquireRuntimeLock('scheduler', 1_000);
    vi.advanceTimersByTime(1_001);

    const second = acquireRuntimeLock('scheduler', 10_000);
    expect(second.ownerToken).not.toBe(first.ownerToken);
    expect(() => assertRuntimeLockOwner(second)).not.toThrow();
    expect(() => assertRuntimeLockOwner(first)).toThrow(/owner token/);
  });

  it('exports direct acquire, renewal, and release helpers', () => {
    vi.useFakeTimers();
    const owner = acquireRuntimeLock('scheduler', 10_000);
    vi.advanceTimersByTime(9_000);
    renewRuntimeLock(owner, 20_000);
    vi.advanceTimersByTime(15_000); // 24s after acquire; renewed expiry is 9s+20s=29s
    expect(() => assertRuntimeLockOwner(owner)).not.toThrow();
    releaseRuntimeLock(owner);
    expect(() => assertRuntimeLockOwner(owner)).toThrow(/not held/);
  });

  it('renew extends expiry during a long async operation', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const operation = withRuntimeLock('scheduler', 100, async (owner) => {
      await gate.promise;
      return owner;
    });

    // ttl/2 = 50ms renewal interval. At 120ms the ORIGINAL 100ms ttl has
    // long expired -- the lock is only still held because the renewals at
    // 50ms and 100ms extended it. (Advancing only 60ms would prove nothing:
    // the original ttl would still cover it.)
    await vi.advanceTimersByTimeAsync(120);
    expect(acquireAttemptFails()).toBe(true);

    gate.resolve(undefined);
    await expect(operation).resolves.toBeDefined();

    function acquireAttemptFails(): boolean {
      try {
        const owner = acquireRuntimeLock('scheduler', 100);
        releaseRuntimeLock(owner);
        return false;
      } catch (err) {
        return err instanceof RuntimeLockHeldError;
      }
    }
  });

  it('assertRuntimeLockOwner fails after release, token loss, or expiry', () => {
    vi.useFakeTimers();
    const released = acquireRuntimeLock('scheduler', 10_000);
    releaseRuntimeLock(released);
    expect(() => assertRuntimeLockOwner(released)).toThrow(/not held/);

    const original = acquireRuntimeLock('scheduler', 1_000);
    vi.advanceTimersByTime(1_001);
    acquireRuntimeLock('scheduler', 10_000); // steal
    expect(() => assertRuntimeLockOwner(original)).toThrow(/owner token/);

    clearStaleRuntimeLocks();
    const expiring = acquireRuntimeLock('scheduler', 1_000);
    vi.advanceTimersByTime(1_001);
    expect(() => assertRuntimeLockOwner(expiring)).toThrow(/has expired/);
  });

  it('rejects the caller when lock ownership is lost mid-operation (renewal abort)', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const operation = withRuntimeLock('scheduler', 1_000, async (owner) => {
      // Simulate ownership loss (e.g. steal after expiry) while fn is running.
      releaseRuntimeLock(owner);
      await gate.promise;
      return 'never surfaces';
    });
    const assertion = expect(operation).rejects.toThrow(/ownership was lost before renewal/);

    // Advance past the ttl/2 = 500ms renewal tick, which must now fail.
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    gate.resolve(undefined);
  });

  it('clearStaleRuntimeLocks clears held locks and reports the count', () => {
    acquireRuntimeLock('scheduler', 120_000);
    acquireRuntimeLock('not-the-scheduler', 120_000);
    expect(clearStaleRuntimeLocks()).toBe(2);
    expect(clearStaleRuntimeLocks()).toBe(0);
    // Immediately re-acquirable after the clear.
    const owner = acquireRuntimeLock('scheduler', 120_000);
    expect(() => assertRuntimeLockOwner(owner)).not.toThrow();
  });

  it('validates ttl in withRuntimeLock', async () => {
    await expect(withRuntimeLock('scheduler', 0, async () => 'x')).rejects.toThrow(/positive finite/);
    await expect(withRuntimeLock('scheduler', Number.NaN, async () => 'x')).rejects.toThrow(/positive finite/);
  });
});
