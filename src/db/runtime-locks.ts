import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { log } from '../log.js';
import { getDb } from './connection.js';

export interface RuntimeLockOwner {
  name: string;
  ownerId: string;
  ownerToken: string;
}

interface RuntimeLockRow {
  owner_id: string;
  owner_token: string;
  expires_at: string;
}

const ownerId = `${hostname()}:${process.pid}`;
const lockOwners = new AsyncLocalStorage<Map<string, RuntimeLockOwner>>();

/**
 * Thrown when a runtime lock is already held by an unexpired owner. Callers
 * that can safely retry later (e.g. the periodic host sweep) should treat
 * this as a deferral rather than a failure.
 */
export class RuntimeLockHeldError extends Error {
  constructor(name: string) {
    super(`Runtime lock "${name}" is already held by an unexpired owner`);
    this.name = 'RuntimeLockHeldError';
  }
}

/**
 * Delete runtime lock rows left behind by previous process instances.
 *
 * Runtime locks coordinate async tasks within the single NanoClaw service
 * process; owner_id embeds the pid, so after a restart any row with a
 * different owner_id belongs to a dead process. Without this cleanup, a lock
 * held at shutdown (e.g. scheduler-mutator, 120s TTL, taken per-session by
 * the historical host sweep) blocks the restarted process's sweeps until the
 * TTL expires — observed as a burst of "Scheduler sync failed during host
 * sweep" errors right after restart.
 */
export function clearStaleRuntimeLocks(): number {
  const result = getDb().prepare('DELETE FROM runtime_locks WHERE owner_id != ?').run(ownerId);
  if (result.changes > 0) {
    log.info('Cleared stale runtime locks from previous process instances', { count: result.changes });
  }
  return result.changes;
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function expiresAtIso(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`Runtime lock ttlMs must be a positive finite number; got ${ttlMs}`);
  }
}

export function acquireRuntimeLock(name: string, ttlMs: number): RuntimeLockOwner {
  const owner: RuntimeLockOwner = { name, ownerId, ownerToken: randomUUID() };
  const now = nowIso();
  const expiresAt = expiresAtIso(ttlMs);
  const result = getDb()
    .prepare(
      `INSERT INTO runtime_locks (name, owner_id, owner_token, expires_at, acquired_at, renewed_at)
       VALUES (@name, @ownerId, @ownerToken, @expiresAt, @now, @now)
       ON CONFLICT(name) DO UPDATE SET
         owner_id = excluded.owner_id,
         owner_token = excluded.owner_token,
         expires_at = excluded.expires_at,
         acquired_at = excluded.acquired_at,
         renewed_at = excluded.renewed_at
       WHERE runtime_locks.expires_at <= @now`,
    )
    .run({
      name,
      ownerId: owner.ownerId,
      ownerToken: owner.ownerToken,
      expiresAt,
      now,
    });

  if (result.changes !== 1) {
    log.warn('Runtime lock acquisition rejected', { name, ownerId });
    throw new RuntimeLockHeldError(name);
  }

  log.debug('Runtime lock acquired', { name, ownerId });
  return owner;
}

export function renewRuntimeLock(owner: RuntimeLockOwner, ttlMs: number): void {
  const now = nowIso();
  const expiresAt = expiresAtIso(ttlMs);
  const result = getDb()
    .prepare(
      `UPDATE runtime_locks
       SET expires_at = @expiresAt, renewed_at = @now
       WHERE name = @name
         AND owner_id = @ownerId
         AND owner_token = @ownerToken
         AND expires_at > @now`,
    )
    .run({
      name: owner.name,
      ownerId: owner.ownerId,
      ownerToken: owner.ownerToken,
      expiresAt,
      now,
    });

  if (result.changes !== 1) {
    throw new Error(`Runtime lock "${owner.name}" ownership was lost before renewal`);
  }
}

function releaseRuntimeLock(owner: RuntimeLockOwner): void {
  const result = getDb()
    .prepare('DELETE FROM runtime_locks WHERE name = ? AND owner_token = ?')
    .run(owner.name, owner.ownerToken);
  log.debug('Runtime lock released', { name: owner.name, ownerId: owner.ownerId, released: result.changes === 1 });
}

export function assertRuntimeLockOwner(owner: RuntimeLockOwner): void {
  const row = getDb()
    .prepare('SELECT owner_id, owner_token, expires_at FROM runtime_locks WHERE name = ?')
    .get(owner.name) as RuntimeLockRow | undefined;
  if (!row) {
    throw new Error(`Runtime lock "${owner.name}" is not held`);
  }
  if (row.owner_id !== owner.ownerId || row.owner_token !== owner.ownerToken) {
    throw new Error(`Runtime lock "${owner.name}" owner token does not match`);
  }
  if (row.expires_at <= nowIso()) {
    throw new Error(`Runtime lock "${owner.name}" has expired`);
  }
}

export async function withRuntimeLock<T>(
  name: string,
  ttlMs: number,
  fn: (owner: RuntimeLockOwner) => T | Promise<T>,
): Promise<T> {
  validateTtl(ttlMs);

  const existing = lockOwners.getStore()?.get(name);
  if (existing) {
    assertRuntimeLockOwner(existing);
    return await fn(existing);
  }

  const owner = acquireRuntimeLock(name, ttlMs);
  const currentOwners = lockOwners.getStore();
  const nextOwners = new Map(currentOwners);
  nextOwners.set(name, owner);

  let rejectRenewal: (err: Error) => void = () => undefined;
  const renewalFailure = new Promise<never>((_, reject) => {
    rejectRenewal = reject;
  });
  const intervalMs = Math.max(1, Math.floor(ttlMs / 2));
  let renewalLost = false;
  const interval = setInterval(() => {
    try {
      renewRuntimeLock(owner, ttlMs);
    } catch (err) {
      renewalLost = true;
      clearInterval(interval);
      const renewalError =
        err instanceof Error ? err : new Error(`Runtime lock "${owner.name}" renewal failed with a non-error value`);
      log.error('Runtime lock renewal failed', { name: owner.name, ownerId: owner.ownerId, err: renewalError });
      rejectRenewal(renewalError);
    }
  }, intervalMs);
  interval.unref?.();

  const operation = lockOwners.run(nextOwners, async () => await fn(owner));

  try {
    return await Promise.race([operation, renewalFailure]);
  } finally {
    clearInterval(interval);
    releaseRuntimeLock(owner);
    if (renewalLost) {
      operation.catch((err: unknown) => {
        log.error('Runtime lock operation failed after renewal loss', {
          name: owner.name,
          ownerId: owner.ownerId,
          err,
        });
      });
    }
  }
}
