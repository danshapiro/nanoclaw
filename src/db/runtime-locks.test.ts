import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import {
  acquireRuntimeLock,
  assertRuntimeLockOwner,
  renewRuntimeLock,
  withRuntimeLock,
  type RuntimeLockOwner,
} from './runtime-locks.js';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value?: T | PromiseLike<T>) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lockRow(name = 'scheduler') {
  return getDb().prepare('SELECT owner_id, owner_token, expires_at FROM runtime_locks WHERE name = ?').get(name) as
    | { owner_id: string; owner_token: string; expires_at: string }
    | undefined;
}

function insertLock(name: string, ownerId: string, ownerToken: string, expiresAt: string): void {
  const now = new Date(Date.now()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO runtime_locks (name, owner_id, owner_token, expires_at, acquired_at, renewed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, ownerId, ownerToken, expiresAt, now, now);
}

beforeEach(() => {
  vi.useRealTimers();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe('runtime locks', () => {
  it('rejects a second unexpired independent owner', async () => {
    const entered = deferred<RuntimeLockOwner>();
    const release = deferred();
    const first = withRuntimeLock('scheduler', 10_000, async (owner) => {
      entered.resolve(owner);
      await release.promise;
    });
    await entered.promise;

    try {
      await expect(withRuntimeLock('scheduler', 10_000, async () => undefined)).rejects.toThrow(/already held/);
    } finally {
      release.resolve();
      await first;
    }
  });

  it('nested same-context lock reuses owner token', async () => {
    await withRuntimeLock('scheduler', 10_000, async (outer) => {
      await withRuntimeLock('scheduler', 10_000, async (inner) => {
        expect(inner).toEqual(outer);
        expect(inner.ownerToken).toBe(outer.ownerToken);
      });
    });
  });

  it('independent same-process concurrent lock does not reuse existing owner token', async () => {
    const entered = deferred<RuntimeLockOwner>();
    const release = deferred();
    let secondEntered = false;
    const first = withRuntimeLock('scheduler', 10_000, async (owner) => {
      entered.resolve(owner);
      await release.promise;
    });
    const firstOwner = await entered.promise;

    try {
      await expect(
        withRuntimeLock('scheduler', 10_000, async (owner) => {
          secondEntered = true;
          expect(owner.ownerToken).not.toBe(firstOwner.ownerToken);
        }),
      ).rejects.toThrow(/already held/);
      expect(secondEntered).toBe(false);
    } finally {
      release.resolve();
      await first;
    }
  });

  it('expired lock can be stolen', async () => {
    insertLock('scheduler', 'old-owner', 'old-token', new Date(Date.now() - 1).toISOString());

    await withRuntimeLock('scheduler', 10_000, async (owner) => {
      const row = lockRow('scheduler');
      expect(row?.owner_token).toBe(owner.ownerToken);
      expect(row?.owner_token).not.toBe('old-token');
      assertRuntimeLockOwner(owner);
    });
  });

  it('exports direct acquire and renewal helpers', () => {
    const owner = acquireRuntimeLock('scheduler', 10_000);
    const initialExpiry = lockRow('scheduler')?.expires_at;
    expect(initialExpiry).toBeDefined();

    renewRuntimeLock(owner, 20_000);

    const renewedExpiry = lockRow('scheduler')?.expires_at;
    expect(Date.parse(renewedExpiry ?? '')).toBeGreaterThan(Date.parse(initialExpiry ?? ''));
    assertRuntimeLockOwner(owner);
  });

  it('renew extends expiry during a long async operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const entered = deferred();
    const release = deferred();
    const locked = withRuntimeLock('scheduler', 100, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const initialExpiry = lockRow('scheduler')?.expires_at;
    expect(initialExpiry).toBeDefined();

    await vi.advanceTimersByTimeAsync(60);
    const renewedExpiry = lockRow('scheduler')?.expires_at;
    expect(Date.parse(renewedExpiry ?? '')).toBeGreaterThan(Date.parse(initialExpiry ?? ''));

    release.resolve();
    await locked;
  });

  it('assertRuntimeLockOwner fails after row deletion or token loss', async () => {
    await withRuntimeLock('scheduler', 10_000, async (owner) => {
      assertRuntimeLockOwner(owner);

      getDb().prepare('DELETE FROM runtime_locks WHERE name = ?').run(owner.name);
      expect(() => assertRuntimeLockOwner(owner)).toThrow(/not held/);

      insertLock(owner.name, 'other-owner', 'other-token', new Date(Date.now() + 10_000).toISOString());
      expect(() => assertRuntimeLockOwner(owner)).toThrow(/owner token/);
    });
  });
});
