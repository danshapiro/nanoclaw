import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { log } from '../log.js';

export interface RuntimeLockOwner {
  name: string;
  ownerId: string;
  ownerToken: string;
}

interface RuntimeLockEntry {
  ownerId: string;
  ownerToken: string;
  expiresAtMs: number;
}

const ownerId = `${hostname()}:${process.pid}`;
const lockOwners = new AsyncLocalStorage<Map<string, RuntimeLockOwner>>();

/**
 * In-process lock table. Runtime locks coordinate async tasks within the
 * single NanoClaw service process only — the historical SQLite-row backing
 * bought durability for state that was deliberately wiped on every restart
 * (and generated ~99% of the service's disk writes; see
 * docs/plans/2026-07-30-sqlite-write-churn.md). Same semantics, zero disk.
 */
const locks = new Map<string, RuntimeLockEntry>();

/**
 * Thrown when a runtime lock is already held by an unexpired owner. Callers
 * that can safely retry later (e.g. the periodic host sweep) should treat
 * this as a deferral rather than a failure.
 *
 * NOTE: the message text is load-bearing — router.ts, scheduler-alerts.ts,
 * and scheduling/actions.ts detect contention by substring match on it.
 */
export class RuntimeLockHeldError extends Error {
  constructor(name: string) {
    super(`Runtime lock "${name}" is already held by an unexpired owner`);
    this.name = 'RuntimeLockHeldError';
  }
}

/**
 * Clear all in-process runtime locks. In a freshly started process the map
 * is empty, so the startup call (src/index.ts) is a no-op kept for parity
 * with the historical DB-backed cleanup; tests use it as a reset hook.
 */
export function clearStaleRuntimeLocks(): number {
  const count = locks.size;
  locks.clear();
  if (count > 0) {
    log.info('Cleared runtime locks', { count });
  }
  return count;
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`Runtime lock ttlMs must be a positive finite number; got ${ttlMs}`);
  }
}

export function acquireRuntimeLock(name: string, ttlMs: number): RuntimeLockOwner {
  const now = Date.now();
  const existing = locks.get(name);
  if (existing && existing.expiresAtMs > now) {
    log.warn('Runtime lock acquisition rejected', { name, ownerId });
    throw new RuntimeLockHeldError(name);
  }
  const owner: RuntimeLockOwner = { name, ownerId, ownerToken: randomUUID() };
  locks.set(name, { ownerId: owner.ownerId, ownerToken: owner.ownerToken, expiresAtMs: now + ttlMs });
  log.debug('Runtime lock acquired', { name, ownerId });
  return owner;
}

export function renewRuntimeLock(owner: RuntimeLockOwner, ttlMs: number): void {
  const now = Date.now();
  const entry = locks.get(owner.name);
  if (!entry || entry.ownerId !== owner.ownerId || entry.ownerToken !== owner.ownerToken || entry.expiresAtMs <= now) {
    throw new Error(`Runtime lock "${owner.name}" ownership was lost before renewal`);
  }
  entry.expiresAtMs = now + ttlMs;
}

/**
 * Release is best-effort and token-fenced: releasing a lock that was
 * stolen/expired is a debug-logged no-op, never an error.
 */
export function releaseRuntimeLock(owner: RuntimeLockOwner): void {
  const entry = locks.get(owner.name);
  const released = entry !== undefined && entry.ownerToken === owner.ownerToken;
  if (released) {
    locks.delete(owner.name);
  }
  log.debug('Runtime lock released', { name: owner.name, ownerId: owner.ownerId, released });
}

export function assertRuntimeLockOwner(owner: RuntimeLockOwner): void {
  const entry = locks.get(owner.name);
  if (!entry) {
    throw new Error(`Runtime lock "${owner.name}" is not held`);
  }
  if (entry.ownerId !== owner.ownerId || entry.ownerToken !== owner.ownerToken) {
    throw new Error(`Runtime lock "${owner.name}" owner token does not match`);
  }
  if (entry.expiresAtMs <= Date.now()) {
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
