# SQLite Write-Churn Elimination Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Eliminate nanoclaw's ~165 GB/day SQLite WAL churn on the central
`v2.db` by (3.1) replacing DB-row runtime locks with an in-process async
mutex, (3.2 code side) bounding the per-minute host sweep to genuinely-live
sessions with archived-session support, (3.3) a read-before-lock early exit
in `sweepSession`, and (3.4) explicit `synchronous=FULL` +
`wal_autocheckpoint=4000` pragmas (durability pinned, checkpoint clustering
reduced) — while guaranteeing that archived sessions are revived (never
dropped) by an inbound message or due scheduled work. Validation of the
plan's load-bearing assumptions added three hardening tasks: a one-time
startup legacy-import reconciliation (Task 8), a write-free steady-state
scheduler projection (Task 9), and a boot-time process-singleton guard
(Task 10).

**Architecture:** The write storm is pure lock bookkeeping: the 60 s host
sweep takes a `runtime_locks` DB-row lock per active session per pass
(~8,500 WAL commits/min across 4,233 accumulated sessions). The lock table
only coordinates async tasks inside the single nanoclaw process (startup
wipes all foreign rows), so an in-memory `Map`-based mutex is semantically
identical with zero disk writes. Independently, the sweep set is bounded to
recently-active sessions plus sessions with live scheduled tasks, archived
sessions become revivable at the routing layer and the sweep, and idle
sessions skip the scheduler-lock block entirely via cheap reads. The
`runtime_locks` table itself is NOT dropped this release — the DROP is
deferred to a post-soak release (Task 2, deferred): the table simply
becomes write-free after Task 1, which captures ~all of the churn win.

**Tech Stack:** TypeScript (NodeNext, strict), better-sqlite3, vitest.
Repo root (isolated worktree): `/home/dan/code/nanoclaw-reboot-resilience/.worktrees/sqlite-write-churn`, branch `fix/sqlite-write-churn`.

**Setup note (validation A8.1):** the worktree currently has NO
`node_modules` — run `pnpm install` once at the worktree root BEFORE
starting Task 1, or every `pnpm exec vitest`/`pnpm test` step below fails
with "Command not found".

**Authoritative analysis:** `/home/dan/code/shapiroserver2/docs/plans/2026-07-30-nanoclaw-write-stream-findings-and-ssd-plan.md`
(file:line evidence for every claim above; its §2.4 sacred/housekeeping
split is normative for this plan).

## Global Constraints

- **SACRED WRITES ARE UNTOUCHABLE.** Do not modify durability semantics of:
  per-session `inbound.db`/`outbound.db` (`messages_in`, `messages_out`,
  `processing_ack`, `side_effect_ledger`) including their
  `journal_mode=DELETE` + per-txn fsync behavior (cross-mount invariants,
  `src/session-manager.ts:1-12`); `discord_message_routes` /
  `discord_channel_cursors` writes; `scheduled_tasks` /
  `scheduled_task_events` state transitions. Only housekeeping writes
  (`runtime_locks` cycles, idempotent re-syncs) may change.
- **HARD USER REQUIREMENT (Dan, non-negotiable):** archived/stale sessions
  MUST be reactivatable — an inbound message or due scheduled work for an
  archived session must revive it and deliver, never drop. Extra latency on
  first wake (up to ~one sweep cycle) is acceptable. Proven by explicit
  acceptance tests (Task 4 Step 1 test 1; Task 5 Step 6).
- **Error-message strings are load-bearing.** `router.ts:748`,
  `yente/scheduler-alerts.ts:371`, `modules/scheduling/actions.ts:215`
  detect lock contention by
  `err.message.includes('Runtime lock "scheduler-mutator" is already held')`.
  The `RuntimeLockHeldError` message
  `` `Runtime lock "${name}" is already held by an unexpired owner` `` and
  the renewal/assert messages (`ownership was lost before renewal`,
  `is not held`, `owner token does not match`, `has expired`) must be
  preserved verbatim.
- All existing test suites must remain green: `pnpm test` (vitest),
  `pnpm exec tsc --noEmit`,
  `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`,
  `pnpm run format:check` (pre-commit hook runs `format:fix`).
- TypeScript NodeNext: relative imports need explicit `.js` extensions.
- Commit style: Conventional Commits, `type(scope): lowercase imperative`,
  no trailing period (e.g. `fix(sweep): bound the sweep set`).
- New DB helpers exported through the barrel `src/db/index.ts` where the
  sibling functions already are.
- Do NOT change the three `getActiveSessions()` callers other than
  `src/host-sweep.ts:329` — `src/modules/scheduling/repair.ts:30` and
  `src/delivery.ts:152` keep their current result set. (Task 9 makes the
  repair loop's projection pass steady-state write-free WITHOUT touching
  its session set; repair's unbounded per-minute archived-session scan is
  a flagged follow-up — see post-plan notes.)
- Do NOT touch `'closed'` status (never written in production; vestigial)
  and do NOT change `'resetting'` semantics or the five active-only session
  selectors' behavior for `resetting` (pinned by
  `src/db/db-v2.test.ts:567-589`).
- **Out of scope:** the one-time host data migration archiving existing
  stale sessions (supervised host action at deploy time), the dvora
  wedged-task unstick (host action), SSD monitoring (separate workstream,
  shapiroserver2 repo), any deployment or live-host access, deleting
  session dirs.

**Scope check:** all four changes target one subsystem (the nanoclaw host
runtime's central-DB write path) and share test fixtures; one plan.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/db/runtime-locks.ts` | rewrite internals | in-process async mutex, same public API + error strings |
| `src/db/runtime-locks.test.ts` | rewrite | behavior suite for the in-memory engine (no raw SQL) |
| `src/modules/scheduling/actions.test.ts` | touch (2 lines + import) | release blocker via exported `releaseRuntimeLock` instead of raw SQL |
| `src/yente/scheduler-reset.test.ts` | touch (~5 lines) | simulate contention via `acquireRuntimeLock` instead of raw INSERT |
| `src/db/sessions.ts` | extend | `findLatestArchivedSessionForAgent`, `findLatestArchivedSessionByAgentGroup`, `reactivateSession`, `getSweepableSessions`, `SWEEP_RECENCY_WINDOW_MS` |
| `src/db/index.ts` | touch | barrel-export the new session helpers |
| `src/db/sessions.test.ts` | extend | unit tests for revival helpers |
| `src/db/sweepable-sessions.test.ts` | create | unit tests for the bounded, session-mode-aware sweep query |
| `src/session-manager.ts` | touch | `resolveSession` archived-revival arm (opt-in `reviveArchived` param, default OFF; reset guard before revival) |
| `src/router.ts` | touch (~5 lines) | `mention-sticky` treats archived sessions as still subscribed; inbound call site opts into revival |
| `src/session-revival.test.ts` | create | **acceptance tests**: archive → message → revive → deliver; roll regression |
| `src/host-sweep.ts` | touch | use `getSweepableSessions`; archived-reactivation branch (with folder recreate); failed-wake `last_active` stamp; read-before-lock gate; test exports |
| `src/host-sweep.revival.test.ts` | create | sweep revival end to end: per-thread, agent-shared, deleted-folder; no-double-active roll regression |
| `src/host-sweep.early-exit.test.ts` | create | idle session skips the scheduler-mutator lock |
| `src/db/session-db.ts` | extend | `hasSchedulerTaskRows(db)` cheap gate read |
| `src/modules/scheduling/ledger.ts` | extend | `hasLiveScheduledTasksForAgentGroup(agentGroupId)` cheap gate read |
| `src/db/connection.ts` | touch (3 lines) | explicit `synchronous=FULL`, `wal_autocheckpoint=4000` pragmas |
| `src/db/connection.test.ts` | create | pragma assertions on a file-backed DB |
| `src/modules/scheduling/startup-import.ts` | create | one-time startup legacy-task import reconciliation (Task 8) |
| `src/modules/scheduling/startup-import.test.ts` | create | reconciliation imports from a >30d-stale active session |
| `src/modules/scheduling/projection.ts` | touch | skip the existing-row UPDATE when the projection is unchanged (Task 9) |
| `src/modules/scheduling/projection.test.ts` | extend | steady-state re-projection preserves `host_received_at` (no write) |
| `src/process-singleton.ts` | create | boot-time exclusive-lock-DB singleton guard (Task 10) |
| `src/process-singleton.test.ts` | create | two-connection contention on a /tmp lock DB |
| `src/index.ts` | touch | singleton guard before `initDb`; startup reconciliation kickoff |

Design notes locked in here (rationale lives in the findings doc):

1. **Existing session selectors stay active-only.** Revival is explicit:
   new `findLatestArchived*` helpers are consulted only where revival is
   intended (`resolveSession`, `mention-sticky`, sweep). This keeps the
   `/new`//`/clear` roll flow (`rollActiveSession`) and the resetting
   exclusions pinned by existing tests unchanged.
2. **Due-inbound liveness needs no SQL clause of its own** in the sweep
   predicate: every inbound write stamps `sessions.last_active`
   (`src/session-manager.ts:453`), so a session with pending inbound work
   is "recent" by construction; future-dated due work written by the
   scheduler is always represented by a live `scheduled_tasks` row
   (`pending`/`paused`), which the predicate checks directly. Two
   validation-found gaps (A3, A7) are closed elsewhere: legacy pre-ledger
   task rows have NO central row until imported — Task 8's one-time
   startup reconciliation visits ALL active sessions so >30d-stale ones
   cannot silently strand them; and obligation-SERVICING failure loops
   (wedged containers, continuously failing wakes) do not stamp
   `last_active` — covered by the active arm's
   `container_status <> 'stopped'` clause and the failed-wake
   `last_active` stamp (both Task 5).
3. **Conservatism direction:** every gate errs toward sweeping/locking MORE
   (never less) on the ACTIVE arm — any doubt ⇒ take the lock and sync as
   today. The one deliberate exception is revival: the archived arm never
   revives while an `active` OR `resetting` sibling exists (a duplicate
   active session is strictly worse than a one-sweep-cycle delivery delay).
4. **`canonicalThreadIdForExistingSession` and the `/new` retarget helper
   stay active-only.** In the rare case a platform-shortened thread id for
   an archived session misses canonicalization, routing creates a fresh
   session — the message is still delivered (never dropped), only
   continuity is lost. Conscious trade to keep the change surface small.
5. **`repairSchedulerProjections`'s tombstone path is compatible** with
   sweep revival: `tombstoneLegacyArchivedTask` fires only for legacy
   inbound task rows with NO central `scheduled_tasks` row
   (`repair.ts:77-78` in the current tree: `if (central) continue;`);
   the sweep's archived arm requires a live central row, which repair
   never touches.

---

### Task 1: In-process runtime lock engine

**Files:**
- Modify: `src/db/runtime-locks.ts` (full internal rewrite, 203 lines today)
- Rewrite: `src/db/runtime-locks.test.ts`
- Modify: `src/modules/scheduling/actions.test.ts:49,73,89`
- Modify: `src/yente/scheduler-reset.test.ts:337` (and its cleanup)

**Interfaces:**
- Consumes: nothing new (drops `getDb` from `./connection.js`).
- Produces (unchanged signatures — all 9 production call sites and 11
  `assertRuntimeLockOwner` fencing sites keep working untouched):
  - `interface RuntimeLockOwner { name: string; ownerId: string; ownerToken: string }`
  - `class RuntimeLockHeldError extends Error` (message verbatim preserved)
  - `clearStaleRuntimeLocks(): number` — now clears the in-memory map
    (startup call at `src/index.ts:72` stays as-is; also the test reset hook)
  - `acquireRuntimeLock(name: string, ttlMs: number): RuntimeLockOwner`
  - `renewRuntimeLock(owner: RuntimeLockOwner, ttlMs: number): void`
  - `assertRuntimeLockOwner(owner: RuntimeLockOwner): void`
  - `withRuntimeLock<T>(name: string, ttlMs: number, fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T>`
  - **NEW export:** `releaseRuntimeLock(owner: RuntimeLockOwner): void`
    (was module-private; tests currently release via raw SQL because no
    public unlock path exists)

- [ ] **Step 1: Rewrite the test suite (failing first)**

Replace the entire contents of `src/db/runtime-locks.test.ts` with the
following. It preserves the intent of all 10 existing behavior tests,
drops the raw-SQL helpers (`lockRow`, `insertLock`), pins the load-bearing
error string, and adds the previously-untested renewal-loss abort path.
No DB setup is needed anymore — the engine is pure in-memory.

```ts
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
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run (from the repo root `/home/dan/code/nanoclaw-reboot-resilience/.worktrees/sqlite-write-churn`):

```bash
pnpm exec vitest run src/db/runtime-locks.test.ts
```

Expected: FAIL — `releaseRuntimeLock` is not exported (compile/import
error), and once past that, `clearStaleRuntimeLocks` semantics and the
no-DB setup fail against the current DB-backed implementation.

- [ ] **Step 3: Rewrite `src/db/runtime-locks.ts` as an in-memory mutex**

Replace the whole file with the following. `withRuntimeLock` is byte-for-
byte the current implementation (reentrancy via `AsyncLocalStorage`,
copy-on-write owner map, `ttl/2` renewal interval, `Promise.race` renewal
abort, unconditional token-fenced release in `finally`) — only the storage
primitives underneath it change. All log messages and error strings are
preserved.

```ts
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
```

Semantics preserved exactly: take-or-steal on expiry; unexpired ⇒
`RuntimeLockHeldError`; not re-entrant via `acquireRuntimeLock` (only
`withRuntimeLock`'s ALS map is); renewal fenced on name+ownerId+token+
not-expired; release token-fenced best-effort; assert = the fencing check
every scheduler write transaction runs.

- [ ] **Step 4: Run the new suite to verify it passes**

```bash
pnpm exec vitest run src/db/runtime-locks.test.ts
```

Expected: PASS (12 tests).

- [ ] **Step 5: Update the two test files that used raw SQL against `runtime_locks`**

In `src/modules/scheduling/actions.test.ts`: the test
`waits for scheduler lock contention instead of dropping a delivered schedule_task`
acquires a blocker via `acquireRuntimeLock('scheduler-mutator', 120_000)`
(line ~49) and currently releases it at lines ~73 and ~89 with:

```ts
getDb().prepare('DELETE FROM runtime_locks WHERE name = ? AND owner_token = ?').run(blocker.name, blocker.ownerToken);
```

Replace each such release with:

```ts
releaseRuntimeLock(blocker);
```

and add `releaseRuntimeLock` to the existing import from
`'../../db/runtime-locks.js'` (the file already imports
`acquireRuntimeLock` from there).

In `src/yente/scheduler-reset.test.ts` (line ~337): the contention
simulation currently does a raw INSERT of an `'other-owner'` row into
`runtime_locks`. Replace it with an in-process blocker (an independent
async context contends for real — pinned by the runtime-locks suite):

```ts
const blocker = acquireRuntimeLock('scheduler-mutator', 120_000);
```

and release it after the assertions in that test (before the test ends):

```ts
releaseRuntimeLock(blocker);
```

adding `import { acquireRuntimeLock, releaseRuntimeLock } from '../db/runtime-locks.js';`
(adjust the relative path to match the file's existing imports). The
test's assertions (reset rejects with `'Yente scheduler-aware reset
failed'`; supersession phase stays `'old-resetting'`) are unchanged.

> Note: because the in-memory lock map is module-global and vitest keeps
> module state within a file, any test that acquires a blocker MUST
> release it (or call `clearStaleRuntimeLocks()` in `afterEach`) so later
> tests in the same file don't inherit contention.

- [ ] **Step 6: Run the affected suites**

```bash
pnpm exec vitest run src/db/runtime-locks.test.ts src/modules/scheduling/actions.test.ts src/yente/scheduler-reset.test.ts src/host-sweep.scheduler.test.ts src/shutdown.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full suite + typecheck**

```bash
pnpm test && pnpm exec tsc --noEmit
```

Expected: PASS (the `runtime_locks` table still exists via migration 014,
so `db-v2.test.ts`'s table-existence assertion still passes; the table is
simply never written again).

- [ ] **Step 8: Commit**

```bash
git add src/db/runtime-locks.ts src/db/runtime-locks.test.ts src/modules/scheduling/actions.test.ts src/yente/scheduler-reset.test.ts
git commit -m "fix(locks): replace DB-row runtime locks with an in-process async mutex"
```

---

### Task 2: `runtime_locks` table drop — DEFERRED (no steps)

**Decision (load-bearing-assumption validation, A1 — critical): this
release does NOT drop the `runtime_locks` table.** Validation ran the real
old binary's startup path against a simulated post-drop `v2.db`: the old
code prepares SQL against `runtime_locks` unconditionally at startup
(`clearStaleRuntimeLocks`, `src/index.ts:72`), and better-sqlite3 compiles
statements eagerly — the throw lands at `prepare()` time, `main()` rejects,
`process.exit(1)` fires, and the supervisor's KeepAlive respawns it into a
hard crash-loop with zero service availability. The deploy model is
in-place (fixed `dist/` path, no version pinning, no guaranteed `v2.db`
backup at deploy time) and migrations have no `down()` — so "the old
binary never meets the post-drop DB" is not a property anyone can promise,
and the outcome when it happens is the worst case.

What this release does instead:

- The table persists via migration 014 and simply becomes **write-free**
  after Task 1 — the in-process mutex already captures ~all of the churn
  win; the DROP itself bought nothing measurable.
- No migration 018 is created. `src/db/schema.ts`, `src/db/migrations/*`,
  and `src/db/db-v2.test.ts` are untouched by this plan (the existing
  `runtime_locks` table-existence assertion in `db-v2.test.ts` stays
  green as-is).
- The DROP moves to a future release, after the in-memory-locks change has
  soaked in production, with a **pre-drop `v2.db` backup as a hard
  precondition** (see post-plan notes).

---

### Task 3: Session revival DB helpers

**Files:**
- Modify: `src/db/sessions.ts` (append after `archiveSession`, line ~131)
- Modify: `src/db/index.ts` (barrel exports, lines ~27-37)
- Modify: `src/db/sessions.test.ts` (extend)

**Interfaces:**
- Consumes: existing `updateSession`, `getDb`, `Session` type.
- Produces (used by Tasks 4 and 5):
  - `findLatestArchivedSessionForAgent(agentGroupId: string, messagingGroupId: string, threadId: string | null): Session | undefined`
  - `findLatestArchivedSessionByAgentGroup(agentGroupId: string): Session | undefined`
  - `reactivateSession(id: string): void` — sets `status='active'` AND
    stamps `last_active` (so a revived session is immediately inside the
    sweep recency window).

- [ ] **Step 1: Write the failing tests**

Append to `src/db/sessions.test.ts` (it already has the
`initTestDb()`+`runMigrations`+seed-`ag-1`/`mg-1` `beforeEach`, a `now()`
helper, and imports through the barrel `./index.js` — extend that import
list with the three new names plus `findSessionForAgent`, `getSession`,
and `getActiveSessions` if not present, and `import type { Session } from '../types.js';`):

```ts
describe('archived-session revival helpers', () => {
  function seedSession(id: string, overrides: Partial<Session> = {}): void {
    createSession({
      id,
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
      ...overrides,
    });
  }

  it('findLatestArchivedSessionForAgent returns only archived rows for the exact route', () => {
    seedSession('sess-active'); // active — must be ignored
    seedSession('sess-resetting', { status: 'resetting' }); // must be ignored
    seedSession('sess-arch-old', { status: 'archived', last_active: '2026-01-01T00:00:00.000Z' });
    seedSession('sess-arch-new', { status: 'archived', last_active: '2026-06-01T00:00:00.000Z' });
    seedSession('sess-arch-other-thread', { status: 'archived', thread_id: 'thread-2' });

    expect(findLatestArchivedSessionForAgent('ag-1', 'mg-1', 'thread-1')?.id).toBe('sess-arch-new');
    expect(findLatestArchivedSessionForAgent('ag-1', 'mg-1', 'no-such-thread')).toBeUndefined();
  });

  it('findLatestArchivedSessionForAgent matches NULL thread ids', () => {
    seedSession('sess-arch-null-thread', { status: 'archived', thread_id: null });
    expect(findLatestArchivedSessionForAgent('ag-1', 'mg-1', null)?.id).toBe('sess-arch-null-thread');
  });

  it('findLatestArchivedSessionByAgentGroup returns the most recent archived session', () => {
    seedSession('sess-arch-a', { status: 'archived', last_active: '2026-01-01T00:00:00.000Z' });
    seedSession('sess-arch-b', { status: 'archived', last_active: '2026-06-01T00:00:00.000Z', thread_id: 'thread-2' });
    expect(findLatestArchivedSessionByAgentGroup('ag-1')?.id).toBe('sess-arch-b');
    expect(findLatestArchivedSessionByAgentGroup('ag-none')).toBeUndefined();
  });

  it('reactivateSession makes an archived session active again and stamps last_active', () => {
    seedSession('sess-revive', { status: 'archived', last_active: null });

    reactivateSession('sess-revive');

    const revived = getSession('sess-revive')!;
    expect(revived.status).toBe('active');
    expect(revived.last_active).not.toBeNull();
    expect(findSessionForAgent('ag-1', 'mg-1', 'thread-1')?.id).toBe('sess-revive');
    expect(getActiveSessions().map((s) => s.id)).toContain('sess-revive');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/db/sessions.test.ts
```

Expected: FAIL with "has no exported member 'findLatestArchivedSessionForAgent'".

- [ ] **Step 3: Implement the helpers**

Append to `src/db/sessions.ts` after `archiveSession` (~line 131):

```ts
/**
 * Most recently used ARCHIVED session for an agent+route — the revival
 * lookup. Archived sessions are revivable by design (an inbound message or
 * due scheduled work must revive them, never drop): callers that intend
 * revival consult this AFTER the active-only lookups miss. 'resetting' and
 * 'closed' are deliberately excluded — reset has its own supersession
 * machinery, and 'closed' is vestigial.
 */
export function findLatestArchivedSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare(
        `SELECT * FROM sessions
          WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'archived'
          ORDER BY COALESCE(last_active, created_at) DESC, created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(agentGroupId, messagingGroupId, threadId) as Session | undefined;
  }
  return getDb()
    .prepare(
      `SELECT * FROM sessions
        WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'archived'
        ORDER BY COALESCE(last_active, created_at) DESC, created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(agentGroupId, messagingGroupId) as Session | undefined;
}

/** Agent-shared-mode variant of findLatestArchivedSessionForAgent. */
export function findLatestArchivedSessionByAgentGroup(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
        WHERE agent_group_id = ? AND status = 'archived'
        ORDER BY COALESCE(last_active, created_at) DESC, created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(agentGroupId) as Session | undefined;
}

/**
 * Revive an archived session: back to 'active' and freshly last_active so
 * the bounded host sweep (getSweepableSessions) picks it up immediately.
 */
export function reactivateSession(id: string): void {
  updateSession(id, { status: 'active', last_active: new Date().toISOString() });
}
```

Add the three names to the barrel exports in `src/db/index.ts` alongside
the other `./sessions.js` re-exports.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec vitest run src/db/sessions.test.ts src/db/db-v2.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/sessions.ts src/db/index.ts src/db/sessions.test.ts
git commit -m "feat(sessions): add archived-session revival lookups and reactivateSession"
```

---

### Task 4: Inbound-message revival at the routing layer (+ acceptance test)

**Files:**
- Modify: `src/session-manager.ts` (`resolveSession` ~:188-236 only —
  `rollActiveSession` is NOT touched)
- Modify: `src/router.ts` (`mention-sticky` case ~:416-423; inbound
  `resolveSession` call ~:490)
- Create: `src/session-revival.test.ts`

**Interfaces:**
- Consumes (Task 3): `findLatestArchivedSessionForAgent`,
  `findLatestArchivedSessionByAgentGroup`, `reactivateSession`.
- Produces: `resolveSession(agentGroupId, messagingGroupId, threadId, sessionMode, reviveArchived = false)`
  — 5th optional parameter, default `false` (revival is OPT-IN; validation
  A5). Only the router inbound call site (`src/router.ts:490`, inside its
  existing `RouteResetInProgressError` handler) passes `true`. Every other
  caller — `src/modules/agent-to-agent/agent-route.ts:139` (a2a) and
  `rollActiveSession` — keeps today's mint-fresh semantics via the default:
  never-drop still holds everywhere, because a freshly minted session
  delivers the message. (`rollActiveSession` itself has ZERO production
  callers — the real `/new`//`/clear` path is scheduler-reset's
  `activateFreshAndArchiveOldAtomically`, which is untouched; the `/new`
  regression test below exercises that real path.)

- [ ] **Step 1: Write the failing acceptance tests**

Create `src/session-revival.test.ts`. It clones the `src/router.test.ts`
harness (same mocks, own `DATA_DIR`) but wires the agent with
`engage_mode: 'mention-sticky'` so both revival triggers at the routing
layer are covered: explicit mention and sticky follow-up.

```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from './channels/adapter.js';
import {
  archiveSession,
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { findSessionForAgent, getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { setDeliveryAdapter } from './delivery.js';
import { inboundDbPath } from './session-manager.js';

const cleanupContainerForSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: cleanupContainerForSessionMock,
  stopContainerAndVerify: cleanupContainerForSessionMock,
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-revival' };
});

const TEST_DIR = '/tmp/nanoclaw-test-session-revival';
const PLATFORM_ID = 'channel';
const THREAD_ID = 'discord:guild:channel';

function now(): string {
  return new Date().toISOString();
}

let currentUserId: string | null = 'discord:admin';

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  currentUserId = 'discord:admin';
  cleanupContainerForSessionMock.mockReset();
  cleanupContainerForSessionMock.mockResolvedValue(true);
  setDeliveryAdapter({
    async deliver() {
      return undefined;
    },
  });

  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: PLATFORM_ID,
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
  grantAdmin('discord:admin');

  const { setSenderResolver } = await import('./router.js');
  setSenderResolver(() => currentUserId);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function grantAdmin(userId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'discord', userId, now());
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, 'admin', 'ag-yente', null, now());
}

function event(content: string, id: string, isMention: boolean): InboundEvent {
  return {
    channelType: 'discord',
    platformId: PLATFORM_ID,
    threadId: THREAD_ID,
    message: { id, kind: 'chat', content, timestamp: now(), isMention, isGroup: true },
  };
}

function inboundTexts(sessionId: string): string[] {
  const db = new Database(inboundDbPath('ag-yente', sessionId));
  try {
    return (db.prepare('SELECT content FROM messages_in ORDER BY timestamp').all() as Array<{ content: string }>).map(
      (row) => (row.content.trim().startsWith('{') ? (JSON.parse(row.content).text as string) : row.content),
    );
  } finally {
    db.close();
  }
}

describe('archived-session revival (HARD REQUIREMENT: revive and deliver, never drop)', () => {
  it('an inbound mention for an archived session revives the SAME session and delivers into it', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;

    await routeInbound(event('hello before archive', 'msg-1', true));
    const original = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    expect(original).toBeDefined();

    // Simulate the stale-session archival (host migration / rollup).
    archiveSession(original.id);
    expect(getSession(original.id)?.status).toBe('archived');
    wakeMock.mockClear();

    await routeInbound(event('hello after archive', 'msg-2', true));

    // Revived: same session id, active again, message landed in ITS inbound.db.
    const revived = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    expect(revived.id).toBe(original.id);
    expect(getSession(original.id)?.status).toBe('active');
    expect(getSession(original.id)?.last_active).not.toBeNull();
    expect(inboundTexts(original.id)).toEqual(['hello before archive', 'hello after archive']);
    // No duplicate session was created for the route.
    expect(getSessionsByAgentGroup('ag-yente')).toHaveLength(1);
    // The wake path fired for the revived session.
    expect(wakeMock).toHaveBeenCalled();
    expect((wakeMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe(original.id);
  });

  it('a NON-mention follow-up in an archived mention-sticky thread still revives and delivers', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('engage me', 'msg-1', true));
    const original = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    archiveSession(original.id);

    await routeInbound(event('follow-up without mention', 'msg-2', false));

    expect(getSession(original.id)?.status).toBe('active');
    expect(inboundTexts(original.id)).toContain('follow-up without mention');
    expect(getSessionsByAgentGroup('ag-yente')).toHaveLength(1);
  });

  it('regression: /new still rolls to a FRESH session and must NOT revive the one it just archived', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('hello first', 'msg-1', true));
    const original = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;

    await routeInbound(event('/new', 'msg-new', true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterNew = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    expect(afterNew.id).not.toBe(original.id);
    expect(getSession(original.id)?.status).toBe('archived');
  });
});
```

> If `createMessagingGroupAgent` requires a non-null `engage_pattern`,
> pass `engage_pattern: null` only if the column is nullable (check
> `src/db/schema.ts` / migration 001); otherwise use `''`. The
> `mention-sticky` branch does not read the pattern.

- [ ] **Step 2: Run to verify the right failures**

```bash
pnpm exec vitest run src/session-revival.test.ts
```

Expected: FAIL — test 1: `revived.id` is a NEW id (a duplicate session was
created; `getSessionsByAgentGroup` length 2); test 2: no delivery (sticky
check finds no active session and the non-mention message is dropped);
test 3: PASSES already (it guards the upcoming change). If test 3 fails at
this point, the harness is wrong — fix the harness before proceeding.

- [ ] **Step 3: Implement revival in `resolveSession` and the sticky check**

In `src/session-manager.ts`, extend the imports from `./db/sessions.js`
(or the barrel it currently uses) with `findLatestArchivedSessionForAgent`,
`findLatestArchivedSessionByAgentGroup`, `reactivateSession`. Change
`resolveSession` (currently `:188-236`) to the following. TWO load-bearing
ordering/default decisions (validation A4 + A5):

1. `assertNoRouteResetInProgress` runs BEFORE the archived-revival lookup
   (order: active lookup → miss → assert → archived lookup → revive, else
   fall through to creation). A mid-reset inbound therefore throws
   `RouteResetInProgressError` exactly as today (pinned by
   `scheduler-reset.test.ts`) — otherwise revival could resurrect an
   archived sibling while old+fresh sessions sit at `'resetting'`, leaving
   TWO active sessions on the route after the reset finalizes.
2. `reviveArchived` defaults to `false`; only the router inbound call site
   opts in (Step 3c below).

```ts
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: SessionMode,
  reviveArchived = false,
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  // Guard BEFORE revival: during a scheduler-aware reset both route
  // sessions are 'resetting', so the active lookups above miss — reviving
  // an archived sibling here would end with two active sessions after the
  // reset finalizes. Throwing preserves today's exact mid-reset behavior.
  assertNoRouteResetInProgress({
    agentGroupId,
    messagingGroupId,
    threadId,
    sessionMode,
  });

  if (reviveArchived) {
    if (sessionMode === 'agent-shared') {
      const archived = findLatestArchivedSessionByAgentGroup(agentGroupId);
      if (archived) {
        return { session: reviveArchivedSession(archived), created: false };
      }
    } else if (messagingGroupId) {
      const lookupThreadId = sessionMode === 'shared' ? null : threadId;
      const archived = findLatestArchivedSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
      if (archived) {
        return { session: reviveArchivedSession(archived), created: false };
      }
    }
  }

  // ... creation path UNCHANGED from here down (generateId, createSession,
  // initSessionFolder, log 'Session created', return { session, created: true })
}

/**
 * HARD REQUIREMENT (see docs/plans/2026-07-30-sqlite-write-churn.md): an
 * inbound message for an archived session revives it and delivers into it —
 * never drops, never forks a duplicate session. Revival is OPT-IN
 * (reviveArchived=true) at the router inbound call site only; every other
 * caller (a2a agent-route, rollActiveSession) keeps today's mint-fresh
 * semantics — a fresh session still delivers, so never-drop holds there too.
 */
function reviveArchivedSession(session: Session): Session {
  reactivateSession(session.id);
  // The on-disk folder normally survives archival; recreate it only if it
  // vanished (e.g. manual cleanup) so the message write cannot fail.
  if (!fs.existsSync(sessionDir(session.agent_group_id, session.id))) {
    initSessionFolder(session.agent_group_id, session.id);
  }
  log.info('Session reactivated by inbound routing', {
    id: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id,
    threadId: session.thread_id,
  });
  return { ...session, status: 'active' };
}
```

(`fs`, `sessionDir`, `initSessionFolder`, and `log` are already available
in `session-manager.ts`.)

`rollActiveSession` (`:238-255`) is NOT changed: it calls the 4-arg
`resolveSession(...)`, and the new default (`reviveArchived = false`)
already preserves its mint-a-fresh-session semantics. (It has zero
production callers anyway — the real `/new`//`/clear` reset path is
`activateFreshAndArchiveOldAtomically` in `src/yente/scheduler-reset.ts`,
untouched by this plan.) Likewise `src/modules/agent-to-agent/agent-route.ts:139`
stays 4-arg: a2a messages keep minting fresh agent-shared sessions.

In `src/router.ts`, TWO changes:

(3c) The inbound call site (`deliverToAgent`, `:490`) opts INTO revival —
it already sits inside the `RouteResetInProgressError` try/catch, so the
mid-reset throw from the reordered guard lands in today's handler
("Session reset is still finishing..."):

```ts
    ({ session, created } = resolveSession(
      agent.agent_group_id,
      mg.id,
      agentEvent.threadId,
      effectiveSessionMode,
      true, // HARD REQUIREMENT: inbound messages revive archived sessions
    ));
```

(3d) The `mention-sticky` case (`:416-423`): import
`findLatestArchivedSessionForAgent` next to the existing
`findSessionForAgent` import and change the tail of the case to:

```ts
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      if (existing !== undefined) return true;
      // An ARCHIVED session keeps the thread subscribed: the follow-up
      // revives it downstream in resolveSession instead of being dropped.
      return findLatestArchivedSessionForAgent(agent.agent_group_id, mg.id, threadId) !== undefined;
    }
```

> Note (validation A4): the mention-sticky arm is unaffected by the reset
> guard — it only decides ENGAGEMENT (whether the agent fires at all).
> Revival itself happens, and is reset-guarded, inside `resolveSession`;
> a sticky follow-up arriving mid-reset engages, then hits the guard and
> gets today's "reset is still finishing" reply.

- [ ] **Step 4: Run the acceptance tests**

```bash
pnpm exec vitest run src/session-revival.test.ts
```

Expected: PASS (all 3).

- [ ] **Step 5: Run the neighboring suites that pin roll/reset/sticky behavior**

```bash
pnpm exec vitest run src/router.test.ts src/host-core.test.ts src/yente/scheduler-reset.test.ts src/session-manager.test.ts src/delivery.test.ts
```

Expected: PASS — in particular `scheduler-reset.test.ts`'s
`blocks competing route session creation while a supersession is unfinished`
(the guard-before-revival ordering preserves it), `router.test.ts`'s
`archives and rolls the addressed session for admin /new and /clear`
(the opt-in default preserves it: the roll/reset machinery never passes
`reviveArchived=true`) and `delivery.test.ts`'s
archived-session drop behavior (delivery still treats non-active sessions
as inactive; revival only happens on new inbound routing).

- [ ] **Step 6: Full suite + typecheck, then commit**

```bash
pnpm test && pnpm exec tsc --noEmit
git add src/session-manager.ts src/router.ts src/session-revival.test.ts
git commit -m "feat(routing): revive archived sessions on inbound messages instead of forking new ones"
```

---

### Task 5: Bounded sweep set + sweep-side revival of due scheduled work

**Files:**
- Modify: `src/db/sessions.ts` (append `SWEEP_RECENCY_WINDOW_MS`, `getSweepableSessions`)
- Modify: `src/db/index.ts` (barrel export)
- Create: `src/db/sweepable-sessions.test.ts`
- Modify: `src/host-sweep.ts` (`:329` swap; `sweepSession` head ~`:347`; wake path ~`:426-430`; add `sweepSessionForTest` export next to `runHostSweepPassForTest` ~`:298`)
- Modify: `src/host-sweep.scheduler.test.ts:39,79` (mock `getSweepableSessions` instead of `getActiveSessions`)
- Create: `src/host-sweep.revival.test.ts`

**Interfaces:**
- Consumes: Task 3's `reactivateSession`; existing
  `createOrReplaceScheduledTask(input: CreateScheduledTaskInput, owner: RuntimeLockOwner): number`
  (`src/modules/scheduling/ledger.ts`, all 12 input fields required:
  `seriesId, agentGroupId, messagingGroupId, threadId, platformId,
  channelType, isGroup, processAfter, recurrence, content, sessionId,
  sourceMessageId`; must run inside
  `withRuntimeLock('scheduler-mutator', 120_000, ...)`) for test seeding.
  Live scheduled-task statuses are exactly `'pending'` and `'paused'`
  (the `listLiveScheduledTasksForSession` filter). The archived arm is
  SESSION-MODE-AWARE (validation A2 + A2-v2): a session row `x` is
  **agent-shared-classified** IFF its OWN route's wiring row is
  agent-shared, OR it has NO messaging group and ANY wiring row in its
  agent group is agent-shared — exactly mirroring
  `resolveProjectionContext` (`src/modules/scheduling/sync.ts:393-409`:
  NULL-mg sessions use a GROUP-WIDE agent-shared check with no mg filter;
  non-NULL-mg sessions use their own route row). Agent-shared delivery is
  served ONLY by agent-shared-classified sessions (the `ledger.ts:208-217`
  non-agent-shared arm is strict-route), so the agent-shared branch's
  sibling guard and latest-archived tiebreak must range over exactly that
  classified set — group-blind or mode-blind scoping either over-blocks
  (an active per-thread session that cannot serve the task) or picks an
  archived sibling that cannot serve it (both never-drop violations,
  validator-A2-v2 scenarios 8a/8b/8c).
- Produces:
  - `SWEEP_RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000` (exported const)
  - `getSweepableSessions(now?: Date): Session[]`
  - `sweepSessionForTest(session: Session): Promise<void>` (test-only
    export, same precedent as `runHostSweepPassForTest`) — Task 6 uses it.

- [ ] **Step 1: Write the failing query tests**

Create `src/db/sweepable-sessions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  getSweepableSessions,
  initTestDb,
  runMigrations,
  SWEEP_RECENCY_WINDOW_MS,
} from './index.js';
import { withRuntimeLock } from './runtime-locks.js';
import { createOrReplaceScheduledTask, type CreateScheduledTaskInput } from '../modules/scheduling/ledger.js';
import type { Session } from '../types.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const RECENT = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
const STALE = new Date(NOW.getTime() - SWEEP_RECENCY_WINDOW_MS - 24 * 60 * 60 * 1000).toISOString(); // 31 days ago

function now(): string {
  return NOW.toISOString();
}

function seedSession(id: string, overrides: Partial<Session> = {}): void {
  createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: RECENT,
    created_at: STALE,
    ...overrides,
  });
}

async function seedLiveTask(seriesId: string, overrides: Partial<CreateScheduledTaskInput> = {}): Promise<void> {
  await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
    createOrReplaceScheduledTask(
      {
        seriesId,
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        threadId: 'thread-1',
        platformId: 'channel',
        channelType: 'discord',
        isGroup: 1,
        processAfter: '2099-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'heartbeat', script: null }),
        sessionId: 'sess-seed',
        sourceMessageId: `msg-${seriesId}`,
        ...overrides,
      },
      owner,
    );
  });
}

/** Wire the (ag-1, mg-1) route agent-shared — the archived arm's per-route mode source. */
function wireAgentShared(): void {
  createMessagingGroupAgent({
    id: 'mga-shared',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: now(),
  });
}

function sweepableIds(): string[] {
  return getSweepableSessions(NOW)
    .map((s) => s.id)
    .sort();
}

describe('getSweepableSessions', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'AG', folder: 'ag', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'channel',
      name: 'MG',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('includes recently-active sessions and excludes stale ones', () => {
    seedSession('sess-recent');
    seedSession('sess-stale', { last_active: STALE, thread_id: 'thread-2' });
    expect(sweepableIds()).toEqual(['sess-recent']);
  });

  it('treats a NULL last_active session as recent via created_at', () => {
    seedSession('sess-new', { last_active: null, created_at: RECENT });
    seedSession('sess-old-never-active', { last_active: null, created_at: STALE, thread_id: 'thread-2' });
    expect(sweepableIds()).toEqual(['sess-new']);
  });

  it('keeps a stale ACTIVE session sweepable while its agent group has a live task', async () => {
    seedSession('sess-stale-with-task', { last_active: STALE });
    await seedLiveTask('task-live');
    expect(sweepableIds()).toEqual(['sess-stale-with-task']);
  });

  it('excludes archived sessions with no live scheduled work', () => {
    seedSession('sess-archived', { status: 'archived' });
    expect(sweepableIds()).toEqual([]);
  });

  it('includes an archived session whose exact route has a live task and no active sibling', async () => {
    seedSession('sess-archived-due', { status: 'archived', last_active: STALE });
    await seedLiveTask('task-orphaned');
    expect(sweepableIds()).toEqual(['sess-archived-due']);
  });

  it('excludes an archived session when an ACTIVE sibling on the same route serves the task', async () => {
    seedSession('sess-active-sibling');
    seedSession('sess-archived-shadowed', { status: 'archived', last_active: STALE });
    await seedLiveTask('task-served');
    expect(sweepableIds()).toEqual(['sess-active-sibling']);
  });

  it('revives only the LATEST archived sibling on an orphaned route', async () => {
    seedSession('sess-arch-old', { status: 'archived', last_active: STALE, created_at: '2026-01-01T00:00:00.000Z' });
    seedSession('sess-arch-new', { status: 'archived', last_active: STALE, created_at: '2026-02-01T00:00:00.000Z' });
    await seedLiveTask('task-orphaned');
    expect(sweepableIds()).toEqual(['sess-arch-new']);
  });

  it('never includes resetting sessions', () => {
    seedSession('sess-resetting', { status: 'resetting' });
    expect(sweepableIds()).toEqual([]);
  });

  it('keeps a stale ACTIVE session with a non-stopped container sweepable', () => {
    // Obligation-servicing loops (wedged containers, SLA kills, orphaned
    // claims after a host restart) never stamp last_active — the
    // container_status clause keeps them under sweep supervision.
    seedSession('sess-wedged', { last_active: STALE, container_status: 'running' });
    expect(sweepableIds()).toEqual(['sess-wedged']);
  });

  it('agent-shared: a cross-route live task makes the LATEST archived group session sweepable', async () => {
    wireAgentShared();
    // Archived agent-shared sessions carry the RAW mg of whichever route
    // created them (or NULL for a2a-created ones) — a due task's stored
    // route may differ. Exact-route IS matching would drop this work.
    seedSession('sess-arch-shared-old', {
      status: 'archived',
      last_active: STALE,
      thread_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedSession('sess-arch-shared-new', {
      status: 'archived',
      last_active: STALE,
      thread_id: null,
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await seedLiveTask('task-null-route', { messagingGroupId: null, threadId: null });
    expect(sweepableIds()).toEqual(['sess-arch-shared-new']);
  });

  it('agent-shared: any active session in the group shadows every archived sibling (no double-active)', async () => {
    wireAgentShared();
    seedSession('sess-shared-active', { thread_id: null }); // active + recent
    seedSession('sess-arch-shared', { status: 'archived', last_active: STALE, thread_id: null });
    // Task route-matches the ARCHIVED sibling's raw columns (post-roll shape):
    // the group-scoped sibling guard must still refuse revival.
    await seedLiveTask('task-post-roll', { threadId: null });
    expect(sweepableIds()).toEqual(['sess-shared-active']);
  });

  it('a RESETTING sibling on the route blocks archived revival without being swept itself', async () => {
    seedSession('sess-resetting-sib', { status: 'resetting', last_active: STALE });
    seedSession('sess-arch-behind-reset', { status: 'archived', last_active: STALE });
    await seedLiveTask('task-mid-reset');
    // Neither: resetting sessions are never swept (pinned semantics), and
    // the archived sibling must not be revived mid-reset (validation A4).
    expect(sweepableIds()).toEqual([]);
  });

  it('MIXED-mode group: exact-route revival on the per-thread route survives an active agent-shared session elsewhere in the group', async () => {
    // ag-1 wired per-thread on mg-1 and agent-shared on mg-2. Mode is
    // determined per SESSION ROUTE: the archived mg-1 session must take the
    // exact-route branch — group-level detection would put it under the
    // group-scoped sibling guard and the active mg-2 session would block
    // its revival (an under-revive, violating never-drop).
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-2',
      name: 'MG2',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-per-thread',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-shared-mg2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now(),
    });

    seedSession('sess-shared-active-mg2', { messaging_group_id: 'mg-2', thread_id: null }); // active + recent
    seedSession('sess-arch-thread', { status: 'archived', last_active: STALE }); // mg-1/thread-1
    await seedLiveTask('task-exact-route'); // exact route: mg-1/thread-1

    // Both: the active session via recency, the archived per-thread session
    // via its OWN route's exact-route branch.
    expect(sweepableIds()).toEqual(['sess-arch-thread', 'sess-shared-active-mg2']);
  });

  it('8a: a NEWER archived NULL-mg (a2a) sibling wins the classified tiebreak for an mg-routed group task', async () => {
    wireAgentShared(); // (ag-1, mg-1) agent-shared
    // Post-roll-via-a2a shape: older archived sibling carries the mg route,
    // newer one carries NULL mg (agent-route.ts:139 provenance). BOTH are
    // agent-shared-classified — the NULL-mg one via resolveProjectionContext's
    // group-wide fallback — and either would deliver the group task once
    // active. The tiebreak must pick the newer NULL-mg sibling, not exile it
    // to the exact-route branch (where 'mg-1' IS NULL fails -> silent drop).
    seedSession('sess-arch-mg', {
      status: 'archived',
      last_active: STALE,
      thread_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedSession('sess-arch-null', {
      status: 'archived',
      last_active: STALE,
      messaging_group_id: null,
      thread_id: null,
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await seedLiveTask('task-mg-routed', { threadId: null });
    expect(sweepableIds()).toEqual(['sess-arch-null']);
  });

  it('8b: an active PER-THREAD session cannot block agent-shared revival in a mixed-mode group', async () => {
    // ag-1: per-thread on mg-1, agent-shared on mg-2. The active per-thread
    // session CANNOT serve the group task (ledger.ts non-agent-shared arm is
    // strict-route), so the classification-scoped guard must ignore it —
    // a group-blind guard would stall delivery for as long as ANY session
    // in the group stays active.
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-2',
      name: 'MG2',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-pt-mg1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-as-mg2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now(),
    });

    seedSession('sess-pt-active', { thread_id: 'thread-x' }); // per-thread route, active + recent
    seedSession('sess-arch-as', {
      status: 'archived',
      last_active: STALE,
      messaging_group_id: 'mg-2',
      thread_id: null,
    });
    await seedLiveTask('task-group', { messagingGroupId: 'mg-2', threadId: null });

    // Both: the per-thread session via recency, the archived agent-shared
    // session (the ONLY session that can deliver the task) via revival.
    expect(sweepableIds()).toEqual(['sess-arch-as', 'sess-pt-active']);
  });

  it('8c: the agent-shared tiebreak ignores NEWER archived per-thread siblings (mode-blind pick would drop the work)', async () => {
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-2',
      name: 'MG2',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-pt-mg1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-as-mg2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now(),
    });

    // Older archived agent-shared candidate vs NEWER archived per-thread
    // sibling. A mode-blind group-latest pick would select the per-thread
    // one — which then fails its own exact-route task match — reviving
    // nothing. The classified tiebreak must pick the agent-shared session.
    seedSession('sess-arch-as', {
      status: 'archived',
      last_active: STALE,
      messaging_group_id: 'mg-2',
      thread_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedSession('sess-arch-pt', {
      status: 'archived',
      last_active: STALE,
      thread_id: 'thread-y',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await seedLiveTask('task-group', { messagingGroupId: 'mg-2', threadId: null });

    expect(sweepableIds()).toEqual(['sess-arch-as']);
  });
});
```

> `sess-arch-old`/`sess-arch-new` deliberately share `last_active` so the
> `created_at DESC` tiebreak is what selects the winner.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/db/sweepable-sessions.test.ts
```

Expected: FAIL — `getSweepableSessions` / `SWEEP_RECENCY_WINDOW_MS` not
exported.

- [ ] **Step 3: Implement `getSweepableSessions`**

Append to `src/db/sessions.ts`:

```ts
/**
 * Recency window for the bounded host sweep. A session stays in the
 * per-minute sweep while ANY liveness signal holds:
 *  - recent activity: COALESCE(last_active, created_at) inside the window
 *    (inbound writes, successful container spawns, revival, and FAILED
 *    wake attempts all stamp last_active);
 *  - a live ('pending'/'paused') central scheduled task for its group;
 *  - container_status <> 'stopped' (wedged/running containers, SLA kills,
 *    orphaned claims after a host restart — servicing-failure loops that
 *    never stamp last_active).
 * Sessions outside all of these are NOT dead: an inbound message revives
 * them at the routing layer (resolveSession), and due scheduled work
 * revives them via the archived arm below. First wake after revival may
 * take up to ~one sweep cycle.
 */
export const SWEEP_RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The sweep-scoped session set (replaces getActiveSessions for the host
 * sweep ONLY — scheduler repair and delivery keep the full active set).
 *
 * A session is sweepable when:
 *  - status='active' AND recently active (COALESCE(last_active, created_at)
 *    within the window) — inbound-message liveness needs no clause of its
 *    own because every inbound write stamps last_active
 *    (src/session-manager.ts writeSessionMessage); OR
 *  - status='active' AND container_status <> 'stopped' — wedged/running
 *    containers, SLA kills, and orphaned claims are serviced by the sweep
 *    but their failure loops never stamp last_active; OR
 *  - status='active' AND its agent group has a live ('pending'/'paused')
 *    scheduled task that could belong to it (conservative: tasks with NULL
 *    messaging_group_id match every session in the group); OR
 *  - status='archived' AND live scheduled work is orphaned on it — the
 *    sweep revives exactly the latest such archived sibling (HARD
 *    REQUIREMENT: revive and deliver, never drop). This arm is
 *    SESSION-MODE-AWARE, mirroring what delivery would actually do once
 *    the session is active. A session row x is AGENT-SHARED-CLASSIFIED
 *    iff EXISTS an mga row with x's agent group, session_mode =
 *    'agent-shared', AND (x.messaging_group_id IS NULL OR
 *    mga.messaging_group_id = x.messaging_group_id) — the exact rule of
 *    resolveProjectionContext (sync.ts:393-409): a NULL-mg session (a2a
 *    provenance) is agent-shared iff ANY wiring in its group is
 *    agent-shared (group-wide, no mg filter); a routed session uses its
 *    OWN route's wiring row, so mixed-mode groups keep per-route modes.
 *     * agent-shared-classified archived sessions: task delivery ignores
 *       route columns (ledger.ts agent-shared arm matches by
 *       agent_group_id only), so ANY live task in the agent group
 *       matches; the sibling guard and latest-archived tiebreak range
 *       ONLY over sessions that are THEMSELVES agent-shared-classified —
 *       an active per-thread session in a mixed group CANNOT serve
 *       agent-shared tasks (ledger.ts:208-217 is strict-route) and must
 *       not block revival, and a newer archived per-thread sibling must
 *       not win the tiebreak and then fail its own route match (both
 *       would strand the work — validator-A2-v2 8b/8c);
 *     * everything else: exact-route NULL-safe IS matching on
 *       (messaging_group_id, thread_id), route-scoped guard and tiebreak.
 *    The sibling guard counts status IN ('active','resetting'): a
 *    resetting sibling means a scheduler-aware reset is mid-flight and
 *    will produce the active session itself — reviving beside it would
 *    create two active sessions on the route. (This does NOT sweep
 *    resetting sessions — their pinned exclusion is unchanged.)
 */
export function getSweepableSessions(now: Date = new Date()): Session[] {
  const cutoff = new Date(now.getTime() - SWEEP_RECENCY_WINDOW_MS).toISOString();
  return getDb()
    .prepare(
      `SELECT s.* FROM sessions s
        WHERE (
          s.status = 'active' AND (
            COALESCE(s.last_active, s.created_at) >= @cutoff
            OR s.container_status <> 'stopped'
            OR EXISTS (
              SELECT 1 FROM scheduled_tasks t
               WHERE t.agent_group_id = s.agent_group_id
                 AND t.status IN ('pending', 'paused')
                 AND (t.messaging_group_id IS NULL OR t.messaging_group_id IS s.messaging_group_id)
            )
          )
        ) OR (
          s.status = 'archived'
          AND CASE
            WHEN EXISTS (
              SELECT 1 FROM messaging_group_agents mga
               WHERE mga.agent_group_id = s.agent_group_id
                 AND mga.session_mode = 'agent-shared'
                 AND (s.messaging_group_id IS NULL OR mga.messaging_group_id = s.messaging_group_id)
            )
            THEN (
              EXISTS (
                SELECT 1 FROM scheduled_tasks t
                 WHERE t.agent_group_id = s.agent_group_id
                   AND t.status IN ('pending', 'paused')
              )
              AND NOT EXISTS (
                SELECT 1 FROM sessions a
                 WHERE a.status IN ('active', 'resetting')
                   AND a.agent_group_id = s.agent_group_id
                   AND EXISTS (
                     SELECT 1 FROM messaging_group_agents amga
                      WHERE amga.agent_group_id = a.agent_group_id
                        AND amga.session_mode = 'agent-shared'
                        AND (a.messaging_group_id IS NULL OR amga.messaging_group_id = a.messaging_group_id)
                   )
              )
              AND s.id = (
                SELECT s2.id FROM sessions s2
                 WHERE s2.status = 'archived'
                   AND s2.agent_group_id = s.agent_group_id
                   AND EXISTS (
                     SELECT 1 FROM messaging_group_agents smga
                      WHERE smga.agent_group_id = s2.agent_group_id
                        AND smga.session_mode = 'agent-shared'
                        AND (s2.messaging_group_id IS NULL OR smga.messaging_group_id = s2.messaging_group_id)
                   )
                 ORDER BY COALESCE(s2.last_active, s2.created_at) DESC, s2.created_at DESC, s2.id DESC
                 LIMIT 1
              )
            )
            ELSE (
              EXISTS (
                SELECT 1 FROM scheduled_tasks t
                 WHERE t.agent_group_id = s.agent_group_id
                   AND t.status IN ('pending', 'paused')
                   AND t.messaging_group_id IS s.messaging_group_id
                   AND t.thread_id IS s.thread_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM sessions a
                 WHERE a.status IN ('active', 'resetting')
                   AND a.agent_group_id = s.agent_group_id
                   AND a.messaging_group_id IS s.messaging_group_id
                   AND a.thread_id IS s.thread_id
              )
              AND s.id = (
                SELECT s2.id FROM sessions s2
                 WHERE s2.status = 'archived'
                   AND s2.agent_group_id = s.agent_group_id
                   AND s2.messaging_group_id IS s.messaging_group_id
                   AND s2.thread_id IS s.thread_id
                 ORDER BY COALESCE(s2.last_active, s2.created_at) DESC, s2.created_at DESC, s2.id DESC
                 LIMIT 1
              )
            )
          END
        )`,
    )
    .all({ cutoff }) as Session[];
}
```

Barrel-export both names from `src/db/index.ts`.

- [ ] **Step 4: Run the query tests**

```bash
pnpm exec vitest run src/db/sweepable-sessions.test.ts
```

Expected: PASS (16 tests).

- [ ] **Step 5: Wire the sweep to the bounded set + archived reactivation**

In `src/host-sweep.ts`:

(a) Swap the session source at `:329` (inside `runHostSweepPass`):

```ts
    const sessions = getSweepableSessions();
```

updating the import at `:34` from `getActiveSessions` to
`getSweepableSessions` (and add `reactivateSession` and `updateSession` to
the same import — `updateSession` is used by the failed-wake stamp in (e)
below). `getActiveSessions` keeps its other two callers untouched. Also
add `sessionDir` and `initSessionFolder` to the existing
`./session-manager.js` import (check the actual import list at the top of
`host-sweep.ts` — both are exported from `src/session-manager.ts:56` and
`:258`).

(b) At the head of `sweepSession` (`:347`), directly AFTER the
`getAgentGroup` bail and BEFORE the `fs.existsSync(inPath)` guard, insert:

```ts
  if (session.status === 'archived') {
    // getSweepableSessions only yields an archived session when live
    // scheduled work is orphaned on it (mode-aware match) and no
    // active-or-resetting session can serve it. Revive it FIRST (before
    // any early-outs) so the scheduler block below sees an active central
    // row and projects + wakes as normal. HARD REQUIREMENT: due work
    // revives, never drops.
    reactivateSession(session.id);
    // Recreate the on-disk folder if it vanished (e.g. manual host
    // cleanup) — mirrors Task 4's reviveArchivedSession. Without this,
    // the fs.existsSync(inPath) guard below would bail forever on a row
    // that is now active-and-recent: a permanent, incident-free
    // half-revival (validation A10). initSessionFolder is idempotent.
    if (!fs.existsSync(sessionDir(session.agent_group_id, session.id))) {
      initSessionFolder(session.agent_group_id, session.id);
    }
    log.info('Reactivated archived session for due scheduled work', { sessionId: session.id });
    session = { ...session, status: 'active' };
  }
```

(c) Next to `runHostSweepPassForTest` (~`:298`), add the test export
Task 6 uses:

```ts
export async function sweepSessionForTest(session: Session): Promise<void> {
  await sweepSession(session);
}
```

(d) `src/host-sweep.scheduler.test.ts` mocks `./db/sessions.js` partially
and overrides `getActiveSessions` (lines `:39` and `:79`) — since the
sweep now calls `getSweepableSessions`, rename that override to
`getSweepableSessions` (same behavior: push `'session-sweep'` / return the
fake session array).

(e) In `sweepSession` step 4 (the wake block, `:426-430`), stamp
`last_active` when a wake attempt FAILS. `wakeContainer` only stamps via
`markContainerRunning` after a SUCCESSFUL spawn — a continuously failing
wake would otherwise age out of the recency window after 30 days and
strand its due work silently (validation A7). The write cost is bounded by
the number of concurrently FAILING sessions (normally zero — success paths
write nothing new):

```ts
    const dueCount = outDb ? countDueMessagesExcludingRecovery(inDb, outDb) : countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      try {
        await wakeContainer(session);
      } catch (err) {
        // Keep the failing session inside the sweep recency window so the
        // wake is retried next pass instead of silently aging out.
        updateSession(session.id, { last_active: new Date().toISOString() });
        throw err; // caller loop logs it, exactly as today
      }
    }
```

- [ ] **Step 6: Write the sweep-revival integration test (second revival trigger)**

Create `src/host-sweep.revival.test.ts` — end to end through a REAL sweep
pass: an archived session with a due live task gets revived, its task
projected into its inbound.db, and its container woken. Coverage spans the
modes the archived arm distinguishes (validation A2/A4/A10): per-thread
exact-route revival, agent-shared cross-route revival, revival of a session
whose on-disk folder was deleted, and the no-double-active regression after
an agent-shared roll.

```ts
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { withRuntimeLock } from './db/runtime-locks.js';
import { createOrReplaceScheduledTask, type CreateScheduledTaskInput } from './modules/scheduling/ledger.js';

const wakeContainerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('./container-runner.js', () => ({
  wakeContainer: wakeContainerMock,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: vi.fn().mockResolvedValue(true),
  stopContainerAndVerify: vi.fn().mockResolvedValue(true),
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-revival' };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-revival';

function now(): string {
  return new Date().toISOString();
}

const STALE = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  wakeContainerMock.mockClear();

  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'channel',
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Second agent group wired agent-shared — used by the agent-shared cases. */
function wireAgentSharedGroup(): void {
  createAgentGroup({ id: 'ag-shared', name: 'Shared', folder: 'shared', agent_provider: null, created_at: now() });
  createMessagingGroupAgent({
    id: 'mga-shared',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-shared',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: now(),
  });
}

async function seedTask(input: Partial<CreateScheduledTaskInput> & Pick<CreateScheduledTaskInput, 'seriesId' | 'sessionId'>): Promise<void> {
  await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
    createOrReplaceScheduledTask(
      {
        agentGroupId: 'ag-yente',
        messagingGroupId: 'mg-discord',
        threadId: 'thread-1',
        platformId: 'channel',
        channelType: 'discord',
        isGroup: 1,
        processAfter: '2026-01-02T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'wake up', script: null }),
        sourceMessageId: `msg-${input.seriesId}`,
        ...input,
      },
      owner,
    );
  });
}

describe('host sweep revival of archived sessions with due scheduled work', () => {
  it('reactivates the archived session, projects its task, and wakes its container', async () => {
    const { initSessionFolder } = await import('./session-manager.js');

    createSession({
      id: 'sess-archived-due',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-archived-due');

    // A live task on the archived session's exact route, due in the past.
    await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
      createOrReplaceScheduledTask(
        {
          seriesId: 'task-due-now',
          agentGroupId: 'ag-yente',
          messagingGroupId: 'mg-discord',
          threadId: 'thread-1',
          platformId: 'channel',
          channelType: 'discord',
          isGroup: 1,
          processAfter: '2026-01-02T00:00:00.000Z',
          recurrence: null,
          content: JSON.stringify({ prompt: 'wake up', script: null }),
          sessionId: 'sess-archived-due',
          sourceMessageId: 'msg-seed',
        },
        owner,
      );
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    // Revived...
    expect(getSession('sess-archived-due')?.status).toBe('active');
    expect(getSession('sess-archived-due')?.last_active).not.toBe(STALE);
    // ...its due work projected into ITS inbound.db...
    const { openInboundDb } = await import('./session-manager.js');
    const inDb = openInboundDb('ag-yente', 'sess-archived-due');
    try {
      const taskRows = inDb
        .prepare("SELECT id, series_id, status FROM messages_in WHERE kind = 'task'")
        .all() as Array<{ id: string; series_id: string; status: string }>;
      expect(taskRows.some((r) => r.series_id === 'task-due-now')).toBe(true);
    } finally {
      inDb.close();
    }
    // ...and its container woken for the due message.
    expect(wakeContainerMock).toHaveBeenCalled();
    expect((wakeContainerMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe('sess-archived-due');
  });

  it('does not sweep (or revive) an archived session with no live work', async () => {
    const { initSessionFolder } = await import('./session-manager.js');
    createSession({
      id: 'sess-archived-idle',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-idle',
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-archived-idle');

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(getSession('sess-archived-idle')?.status).toBe('archived');
    expect(wakeContainerMock).not.toHaveBeenCalled();
  });

  it('revives an archived session whose on-disk FOLDER was deleted: recreates it, projects, wakes', async () => {
    const { sessionDir } = await import('./session-manager.js');
    createSession({
      id: 'sess-archived-no-folder',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-nf',
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    // Deliberately NO initSessionFolder — simulates host-side manual cleanup
    // of the session directory after archival (validation A10).
    await seedTask({ seriesId: 'task-no-folder', sessionId: 'sess-archived-no-folder', threadId: 'thread-nf' });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(getSession('sess-archived-no-folder')?.status).toBe('active');
    expect(fs.existsSync(sessionDir('ag-yente', 'sess-archived-no-folder'))).toBe(true);
    const { openInboundDb } = await import('./session-manager.js');
    const inDb = openInboundDb('ag-yente', 'sess-archived-no-folder');
    try {
      const taskRows = inDb
        .prepare("SELECT series_id FROM messages_in WHERE kind = 'task'")
        .all() as Array<{ series_id: string }>;
      expect(taskRows.some((r) => r.series_id === 'task-no-folder')).toBe(true);
    } finally {
      inDb.close();
    }
    expect(wakeContainerMock).toHaveBeenCalled();
    expect((wakeContainerMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe('sess-archived-no-folder');
  });

  it('agent-shared: revives the latest archived group session for a task whose stored route no longer matches', async () => {
    const { initSessionFolder } = await import('./session-manager.js');
    wireAgentSharedGroup();
    createSession({
      id: 'sess-shared-arch',
      agent_group_id: 'ag-shared',
      messaging_group_id: 'mg-discord',
      thread_id: null,
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-shared', 'sess-shared-arch');

    // NULL-route task (a2a-created agent-shared provenance): exact-route IS
    // matching would never select it — the agent-shared arm must.
    await seedTask({
      seriesId: 'task-shared-due',
      sessionId: 'sess-shared-arch',
      agentGroupId: 'ag-shared',
      messagingGroupId: null,
      threadId: null,
      platformId: null,
      channelType: null,
      isGroup: null,
      content: JSON.stringify({ prompt: 'shared wake', script: null }),
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(getSession('sess-shared-arch')?.status).toBe('active');
    expect(wakeContainerMock).toHaveBeenCalled();
    expect((wakeContainerMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe('sess-shared-arch');
  });

  it('agent-shared roll regression: never revives the old sibling while the group has an active session', async () => {
    const { initSessionFolder } = await import('./session-manager.js');
    wireAgentSharedGroup();
    // Post-roll shape: old session archived with its RAW old route, new
    // session active; the old task still route-matches the ARCHIVED row.
    createSession({
      id: 'sess-shared-old',
      agent_group_id: 'ag-shared',
      messaging_group_id: 'mg-discord',
      thread_id: null,
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    createSession({
      id: 'sess-shared-new',
      agent_group_id: 'ag-shared',
      messaging_group_id: 'mg-discord',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });
    initSessionFolder('ag-shared', 'sess-shared-old');
    initSessionFolder('ag-shared', 'sess-shared-new');
    await seedTask({
      seriesId: 'task-old-route',
      sessionId: 'sess-shared-old',
      agentGroupId: 'ag-shared',
      threadId: null,
      processAfter: '2099-01-01T00:00:00.000Z', // future: no wake expected
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    // The active sibling serves the group's tasks — the archived one must
    // NOT come back (two active agent-shared sessions would break the
    // findSessionByAgentGroup single-session invariant).
    expect(getSession('sess-shared-old')?.status).toBe('archived');
    const active = getSessionsByAgentGroup('ag-shared').filter((sess) => sess.status === 'active');
    expect(active.map((sess) => sess.id)).toEqual(['sess-shared-new']);
  });
});
```

> Fixture note: projection-context resolution
> (`resolveProjectionContext`) reads the `messaging_groups` ×
> `messaging_group_agents` wiring seeded above; with no registered
> `'discord'` channel adapter, `sessionMode` falls back to the `mga` row's
> `'per-thread'`, which matches the task's `thread_id` — so the projection
> should resolve. The load-bearing assertions are the status flip and the
> wake; if the projection-row assertion proves environment-brittle, keep
> it but investigate rather than delete — it is the "deliver" half of the
> requirement for scheduled work.

- [ ] **Step 7: Run the new and neighboring suites**

```bash
pnpm exec vitest run src/db/sweepable-sessions.test.ts src/host-sweep.revival.test.ts src/host-sweep.test.ts src/host-sweep.scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 8: Full suite + typecheck, then commit**

```bash
pnpm test && pnpm exec tsc --noEmit
git add src/db/sessions.ts src/db/index.ts src/db/sweepable-sessions.test.ts src/host-sweep.ts src/host-sweep.revival.test.ts src/host-sweep.scheduler.test.ts
git commit -m "feat(sweep): bound the sweep to live sessions and revive archived sessions with due scheduled work"
```

---

### Task 6: Read-before-lock early exit in `sweepSession`

**Files:**
- Modify: `src/db/session-db.ts` (append `hasSchedulerTaskRows`)
- Modify: `src/modules/scheduling/ledger.ts` (append `hasLiveScheduledTasksForAgentGroup`)
- Modify: `src/host-sweep.ts` (export `sessionNeedsSchedulerSync`; gate the step-2 lock block)
- Create: `src/host-sweep.early-exit.test.ts`

**Interfaces:**
- Consumes: Task 5's `sweepSessionForTest(session: Session): Promise<void>`.
- Produces:
  - `hasSchedulerTaskRows(db: Database.Database): boolean` (session-db,
    reads the session's inbound.db)
  - `hasLiveScheduledTasksForAgentGroup(agentGroupId: string): boolean`
    (ledger, reads central `scheduled_tasks`)
  - `sessionNeedsSchedulerSync(inDb: Database.Database, agentGroupId: string): boolean`
    (host-sweep, exported gate — the style every other host-sweep helper
    test uses)

- [ ] **Step 1: Write the failing tests**

Create `src/host-sweep.early-exit.test.ts`:

```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { INBOUND_SCHEMA } from './db/schema.js';
import { createOrReplaceScheduledTask } from './modules/scheduling/ledger.js';

const withRuntimeLockSpy = vi.hoisted(() => vi.fn());

vi.mock('./db/runtime-locks.js', async () => {
  const actual = (await vi.importActual('./db/runtime-locks.js')) as typeof import('./db/runtime-locks.js');
  withRuntimeLockSpy.mockImplementation(actual.withRuntimeLock);
  return { ...actual, withRuntimeLock: withRuntimeLockSpy };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: vi.fn().mockResolvedValue(true),
  stopContainerAndVerify: vi.fn().mockResolvedValue(true),
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-early-exit' };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-early-exit';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  withRuntimeLockSpy.mockClear();

  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'channel',
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function seedLiveCentralTask(seriesId: string, sessionId: string): Promise<void> {
  const { withRuntimeLock } = await import('./db/runtime-locks.js');
  await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
    createOrReplaceScheduledTask(
      {
        seriesId,
        agentGroupId: 'ag-yente',
        messagingGroupId: 'mg-discord',
        threadId: 'thread-1',
        platformId: 'channel',
        channelType: 'discord',
        isGroup: 1,
        processAfter: '2099-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'x', script: null }),
        sessionId,
        sourceMessageId: `msg-${seriesId}`,
      },
      owner,
    );
  });
}

async function seedActiveSession(id: string) {
  const { initSessionFolder } = await import('./session-manager.js');
  const session = {
    id,
    agent_group_id: 'ag-yente',
    messaging_group_id: 'mg-discord',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: now(),
    created_at: now(),
  };
  createSession(session);
  initSessionFolder('ag-yente', id);
  return session;
}

describe('sessionNeedsSchedulerSync (pure gate)', () => {
  it('is false for an idle session with no task rows and no live central tasks', async () => {
    const { sessionNeedsSchedulerSync } = await import('./host-sweep.js');
    const inDb = new Database(':memory:');
    inDb.exec(INBOUND_SCHEMA);
    expect(sessionNeedsSchedulerSync(inDb, 'ag-yente')).toBe(false);
    inDb.close();
  });

  it('is true when the inbound DB has ANY kind=task row (projection or legacy)', async () => {
    const { sessionNeedsSchedulerSync } = await import('./host-sweep.js');
    const inDb = new Database(':memory:');
    inDb.exec(INBOUND_SCHEMA);
    inDb
      .prepare(
        "INSERT INTO messages_in (id, kind, timestamp, content, status, trigger) VALUES (?, 'task', ?, ?, 'completed', 1)",
      )
      .run('m-task', now(), JSON.stringify({ prompt: 'x', script: null }));
    expect(sessionNeedsSchedulerSync(inDb, 'ag-yente')).toBe(true);
    inDb.close();
  });

  it('is true when the agent group has a live central task', async () => {
    const { sessionNeedsSchedulerSync } = await import('./host-sweep.js');
    await seedLiveCentralTask('task-live', 'sess-any');
    const inDb = new Database(':memory:');
    inDb.exec(INBOUND_SCHEMA);
    expect(sessionNeedsSchedulerSync(inDb, 'ag-yente')).toBe(true);
    inDb.close();
  });
});

describe('sweepSession early exit', () => {
  it('never takes the scheduler-mutator lock for a provably idle session', async () => {
    const session = await seedActiveSession('sess-idle');
    const { sweepSessionForTest } = await import('./host-sweep.js');

    withRuntimeLockSpy.mockClear();
    await sweepSessionForTest(session);

    expect(withRuntimeLockSpy).not.toHaveBeenCalled();
  });

  it('still takes the lock when the agent group has a live task (conservative)', async () => {
    const session = await seedActiveSession('sess-with-task');
    await seedLiveCentralTask('task-live-2', 'sess-with-task');
    const { sweepSessionForTest } = await import('./host-sweep.js');

    withRuntimeLockSpy.mockClear();
    await sweepSessionForTest(session);

    expect(withRuntimeLockSpy).toHaveBeenCalledTimes(1);
    expect(withRuntimeLockSpy.mock.calls[0]?.[0]).toBe('scheduler-mutator');
  });
});
```

> The `vi.mock('./db/runtime-locks.js')` passthrough spy intercepts
> host-sweep's static import — the seeding helper uses the SAME mocked
> module (the spy delegates to the actual implementation), so
> `mockClear()` immediately before the `sweepSessionForTest` call is what
> isolates the assertion. If the INBOUND_SCHEMA insert column list drifts
> from the real schema, copy the exact column names from
> `INBOUND_SCHEMA` in `src/db/schema.ts` — the point is a row with
> `kind='task'`.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/host-sweep.early-exit.test.ts
```

Expected: FAIL — `sessionNeedsSchedulerSync` is not exported; the
idle-session test also fails because the current code always takes the
lock.

- [ ] **Step 3: Implement the gate**

Append to `src/db/session-db.ts` (near `countDueMessages`, ~`:289`):

```ts
/**
 * Cheap read used by the host sweep's read-before-lock gate: does this
 * session's inbound DB contain ANY scheduler task row (projection or
 * legacy)? Deliberately a superset of both the projection-sync selector
 * (kind='task' AND series_id IS NOT NULL) and the legacy-import selector
 * (kind='task' with live-ish statuses) — any doubt means "take the lock".
 */
export function hasSchedulerTaskRows(db: Database.Database): boolean {
  const row = db.prepare("SELECT EXISTS(SELECT 1 FROM messages_in WHERE kind = 'task') AS present").get() as {
    present: number;
  };
  return row.present === 1;
}
```

Append to `src/modules/scheduling/ledger.ts` (next to
`listLiveScheduledTasksForSession`, ~`:191`):

```ts
/**
 * Conservative group-level gate for the host sweep's read-before-lock
 * early exit: ANY live task in the agent group means every session of the
 * group runs the full lock + sync path. Reads cost no WAL frames.
 */
export function hasLiveScheduledTasksForAgentGroup(agentGroupId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM scheduled_tasks WHERE agent_group_id = ? AND status IN ('pending', 'paused')) AS present",
    )
    .get(agentGroupId) as { present: number };
  return row.present === 1;
}
```

In `src/host-sweep.ts`, add the imports (`hasSchedulerTaskRows` from
`./db/session-db.js`, `hasLiveScheduledTasksForAgentGroup` from
`./modules/scheduling/ledger.js`) and the exported gate near the other
exported helpers:

```ts
/**
 * Read-before-lock gate (defense in depth for the write-churn fix): the
 * scheduler-mutator block in sweepSession is skipped only when it is
 * PROVABLY a no-op — no inbound task rows to import/sync AND no live
 * central task in the agent group to project. Conservative by
 * construction: any task row of any status, or any live task anywhere in
 * the group, takes the lock exactly as before.
 */
export function sessionNeedsSchedulerSync(inDb: Database.Database, agentGroupId: string): boolean {
  return hasSchedulerTaskRows(inDb) || hasLiveScheduledTasksForAgentGroup(agentGroupId);
}
```

Then wrap `sweepSession`'s step-2 block (`:374-411` — the
`try { await withRuntimeLock('scheduler-mutator', 120_000, ...) } catch ...`
INCLUDING its `RuntimeLockHeldError` catch) in the gate, changing NOTHING
inside the block:

```ts
    // 2. Sync durable scheduler projection state before due-count so completed
    // recurring projections fan out centrally and reset-resistant projections
    // are repaired before the wake decision. Skipped entirely when cheap
    // reads prove there is nothing to sync (the common case for idle
    // sessions) — see sessionNeedsSchedulerSync.
    if (sessionNeedsSchedulerSync(inDb, session.agent_group_id)) {
      try {
        await withRuntimeLock('scheduler-mutator', 120_000, async (owner) => {
          // ... existing body verbatim: importLegacyActiveTasks try/catch
          // (with its reportSchedulerIncident fallback), then
          // syncSessionSchedulerState(inDb, outDb, session, owner), then
          // ensureSessionSchedulerProjections(inDb, session, resolveProjectionContext(session), owner)
        });
      } catch (err) {
        if (err instanceof RuntimeLockHeldError) {
          // Another in-process task holds the scheduler-mutator lock. The sweep
          // revisits every session on its next interval, so this is a benign
          // deferral, not a failure.
          log.warn('Scheduler sync deferred during host sweep: mutator lock held', { sessionId: session.id });
        } else {
          log.error('Scheduler sync failed during host sweep', { sessionId: session.id, err });
        }
      }
    }
```

- [ ] **Step 4: Run the tests**

```bash
pnpm exec vitest run src/host-sweep.early-exit.test.ts src/host-sweep.revival.test.ts src/host-sweep.test.ts
```

Expected: PASS — including `host-sweep.revival.test.ts` from Task 5: the
revived session has a live central task, so the gate keeps the lock path
(this cross-check is why Task 6 comes after Task 5).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
pnpm test && pnpm exec tsc --noEmit
git add src/db/session-db.ts src/modules/scheduling/ledger.ts src/host-sweep.ts src/host-sweep.early-exit.test.ts
git commit -m "feat(sweep): read-before-lock early exit skips scheduler sync for provably idle sessions"
```

---

### Task 7: Explicit central-DB pragmas (`synchronous=FULL` pinned)

**Files:**
- Modify: `src/db/connection.ts:18-25` (`initDb`)
- Create: `src/db/connection.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change — `initDb(dbPath)` now sets
  `synchronous = FULL` EXPLICITLY and `wal_autocheckpoint = 4000` in
  addition to the existing `journal_mode = WAL` and `foreign_keys = ON`.
- Durability note (validation A6 — critical): **`synchronous=NORMAL` was
  REJECTED.** The scheduler's replay machinery acks container-emitted
  scheduling actions in the FULL-durable per-session DBs (`markDelivered`
  in inbound.db, both on the delivery path and the drain path) AFTER the
  volatile central `v2.db` apply. Under NORMAL, a power loss inside the
  un-checkpointed WAL tail can drop the central write while the durable
  ack survives and suppresses replay: a `schedule_task` is silently lost
  (a recurring series dies after ≤1 run; a one-shot gets tombstoned) and a
  `cancel_task` is actively undone (per-minute repair re-projects the
  resurrected task). Explicit FULL pins today's compiled-in default so
  `v2.db` stays at least as durable as the session-DB ledgers that gate
  replay — do not downgrade without first moving those gates into `v2.db`
  itself. The headline churn win comes from Tasks 1/5/6;
  `wal_autocheckpoint=4000` alone still trims checkpoint fsync clustering
  (~1-3 GB/day of the 165). Session DBs (`journal_mode=DELETE`, per-txn
  fsync) are NOT touched — that is a sacred cross-mount invariant.

- [ ] **Step 1: Write the failing test**

Create `src/db/connection.test.ts` (file-backed DB — `initTestDb` is
in-memory and never exercises these pragmas):

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from './connection.js';

describe('initDb pragmas', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-conn-test-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets WAL + explicit FULL sync + larger autocheckpoint + foreign keys', () => {
    const db = initDb(path.join(tmpDir, 'v2.db'));

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // synchronous: 2 = FULL — explicit and load-bearing (see the durability
    // note: scheduling-action replay is gated on session-DB acks written
    // AFTER the central apply; v2.db must stay at least as durable).
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(4000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/db/connection.test.ts
```

Expected: FAIL — `wal_autocheckpoint` is 1000 (the compiled default). The
other three assertions already pass today (`synchronous` compiles to
2/FULL by default — the point of setting it explicitly is to PIN that
against build/env drift, and to leave a comment that stops a future
NORMAL downgrade).

- [ ] **Step 3: Implement**

In `src/db/connection.ts` `initDb` (`:18-25`), change the pragma block to:

```ts
export function initDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  // FULL is EXPLICIT and load-bearing. Scheduling-action replay is gated on
  // acks/drain ledgers persisted in the FULL-durable session DBs AFTER the
  // central apply — synchronous=NORMAL would let a power loss drop the
  // central write while the durable ack suppresses replay (schedule_task
  // silently lost; cancel_task resurrected by the per-minute repair). Do
  // NOT downgrade to NORMAL without first moving those replay gates into
  // this database.
  _db.pragma('synchronous = FULL');
  _db.pragma('wal_autocheckpoint = 4000');
  _db.pragma('foreign_keys = ON');
  log.info('Central DB initialized', { path: dbPath });
  return _db;
}
```

Do NOT touch `initTestDb` and do NOT touch `src/db/session-db.ts`'s
`journal_mode=DELETE` (sacred).

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec vitest run src/db/connection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Full suite + typecheck (all four gates)**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run format:check
```

Expected: everything green. If `format:check` complains, run
`pnpm run format:fix` and re-stage.

- [ ] **Step 6: Commit**

```bash
git add src/db/connection.ts src/db/connection.test.ts
git commit -m "feat(db): pin synchronous=FULL explicitly and raise wal_autocheckpoint to 4000 on the central DB"
```

---

### Task 8: One-time startup legacy-task import reconciliation

**Why (validation A3, high):** `importLegacyActiveTasks` runs ONLY inside
`sweepSession` (`src/host-sweep.ts:380-381`). Once Task 5 bounds the sweep,
an ACTIVE session that is already >30 days stale at deploy time and holds
unimported legacy `kind='task'` inbound rows (pre-ledger, far-future
`process_after`, NO central `scheduled_tasks` row) is never visited again —
its scheduled work is silently dropped. Repair does not close this hole:
`repairSchedulerProjections` only projects EXISTING central rows for active
sessions, and its legacy scan covers only non-active sessions. This task
runs one unbounded import pass over ALL active sessions at startup;
persistent import failures surface as dedupe-keyed scheduler incidents
(loud, not silent — accepted residual).

**Files:**
- Create: `src/modules/scheduling/startup-import.ts`
- Create: `src/modules/scheduling/startup-import.test.ts`
- Modify: `src/index.ts` (kick off after the service is up, ~:186)

**Interfaces:**
- Consumes: `getActiveSessions()` (`src/db/sessions.ts:99` — the FULL
  active set, deliberately unbounded, one-time),
  `importLegacyActiveTasks(inDb, session, owner)`
  (`src/modules/scheduling/legacy-import.ts:27`, async, returns imported
  count), `withRuntimeLock('scheduler-mutator', 120_000, ...)`,
  `inboundDbPath`/`openInboundDb` (`src/session-manager.ts:61,557`),
  `reportSchedulerIncident` (`src/yente/scheduler-alerts.ts:54`).
- Produces: `reconcileLegacyTaskImportsOnStartup(): Promise<{ scanned: number; imported: number; failed: number }>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/scheduling/startup-import.test.ts` (harness mirrors
`legacy-import.test.ts`: config-mocked DATA_DIR, real migrations, real
session folder):

```ts
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import { getScheduledTask } from './ledger.js';
import { reconcileLegacyTaskImportsOnStartup } from './startup-import.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-startup-import' };
});

const TEST_DIR = '/tmp/nanoclaw-test-startup-import';
const STALE = '2026-01-01T00:00:00.000Z'; // far outside SWEEP_RECENCY_WINDOW_MS

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'channel',
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('startup legacy-task import reconciliation', () => {
  it('imports legacy future tasks from an active session too stale for the bounded sweep', async () => {
    createSession({
      id: 'sess-stale-legacy',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: STALE, // >30d stale — getSweepableSessions never yields it
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-stale-legacy');

    // A legacy pre-ledger task row: kind='task', live status, far-future
    // due date, and NO central scheduled_tasks row.
    const inDb = openInboundDb('ag-yente', 'sess-stale-legacy');
    try {
      inDb
        .prepare(
          `INSERT INTO messages_in
             (id, seq, kind, timestamp, status, process_after, recurrence, trigger,
              platform_id, channel_type, thread_id, messaging_group_id, is_group, content, series_id)
           VALUES (?, 2, 'task', ?, 'pending', '2099-01-01T00:00:00.000Z', NULL, 1,
              'channel', 'discord', 'thread-1', 'mg-discord', 1, ?, 'series-legacy')`,
        )
        .run('legacy-task-1', STALE, JSON.stringify({ prompt: 'future heartbeat', script: null }));
    } finally {
      inDb.close();
    }
    expect(getScheduledTask('ag-yente', 'series-legacy')).toBeUndefined();

    const summary = await reconcileLegacyTaskImportsOnStartup();

    expect(summary).toEqual({ scanned: 1, imported: 1, failed: 0 });
    expect(getScheduledTask('ag-yente', 'series-legacy')).toMatchObject({
      series_id: 'series-legacy',
      status: 'pending',
      process_after: '2099-01-01T00:00:00.000Z',
    });
  });

  it('skips sessions whose inbound.db is missing without failing the pass', async () => {
    createSession({
      id: 'sess-no-folder',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-2',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });

    const summary = await reconcileLegacyTaskImportsOnStartup();
    expect(summary).toEqual({ scanned: 1, imported: 0, failed: 0 });
  });
});
```

(If the raw `messages_in` INSERT column list drifts from the real inbound
schema, copy the exact column names from `INBOUND_SCHEMA` in
`src/db/schema.ts` — the point is a live legacy `kind='task'` row with a
`series_id` and no central row.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/modules/scheduling/startup-import.test.ts
```

Expected: FAIL — module `./startup-import.js` does not exist.

- [ ] **Step 3: Implement the reconciliation pass**

Create `src/modules/scheduling/startup-import.ts`:

```ts
import fs from 'fs';

import { withRuntimeLock } from '../../db/runtime-locks.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { reportSchedulerIncident } from '../../yente/scheduler-alerts.js';
import { importLegacyActiveTasks } from './legacy-import.js';

/**
 * One-time startup reconciliation for legacy pre-ledger scheduled tasks.
 *
 * The bounded host sweep (getSweepableSessions) deliberately skips active
 * sessions with no recency/task/container liveness signal — but a legacy
 * kind='task' inbound row has NO central scheduled_tasks row until
 * importLegacyActiveTasks first succeeds, so a session already >30 days
 * stale at deploy time would never be visited and its future-dated legacy
 * work would be silently dropped. This pass visits ALL active sessions
 * (deliberately unbounded — it runs ONCE per process start, in the
 * background, after the service is up) and runs the exact same import
 * path the sweep uses.
 */
export async function reconcileLegacyTaskImportsOnStartup(): Promise<{
  scanned: number;
  imported: number;
  failed: number;
}> {
  const sessions = getActiveSessions(); // FULL active set — one-time, unbounded by design
  let imported = 0;
  let failed = 0;
  for (const session of sessions) {
    if (!fs.existsSync(inboundDbPath(session.agent_group_id, session.id))) continue;
    try {
      const inDb = openInboundDb(session.agent_group_id, session.id);
      try {
        imported += await withRuntimeLock('scheduler-mutator', 120_000, (owner) =>
          importLegacyActiveTasks(inDb, session, owner),
        );
      } finally {
        inDb.close();
      }
    } catch (err) {
      failed += 1;
      log.error('Startup legacy import failed for session', { sessionId: session.id, err });
      try {
        await reportSchedulerIncident({
          // Same dedupe key as the sweep's legacy-import incident — retries
          // and later sweep passes will not spam duplicates.
          dedupeKey: `legacy-import:${session.id}`,
          severity: 'error',
          message: `Startup legacy-task import reconciliation failed for session ${session.id}. Scheduled tasks may be delayed until import succeeds.`,
          agentGroupId: session.agent_group_id,
          sessionId: session.id,
          messagingGroupId: session.messaging_group_id,
          threadId: session.thread_id,
          details: { err: err instanceof Error ? err.message : String(err) },
        });
      } catch (incidentErr) {
        log.error('Failed to record startup legacy-import incident', { sessionId: session.id, err: incidentErr });
      }
    }
    // Yield a full event-loop turn per session — deploy day can mean
    // thousands of sessions and this must not starve adapters or the sweep.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  log.info('Startup legacy-task import reconciliation finished', {
    scanned: sessions.length,
    imported,
    failed,
  });
  return { scanned: sessions.length, imported, failed };
}
```

Wire it into `src/index.ts` `main()` AFTER the service is fully up (after
`startHostSweep()` at ~:185, before the final `log.info('NanoClaw running')`)
— non-blocking, fire-and-forget:

```ts
  // 6b. One-time legacy-task import reconciliation (non-blocking): the
  // bounded sweep never visits >30d-stale active sessions, so any legacy
  // pre-ledger future tasks they hold must be imported once here.
  void reconcileLegacyTaskImportsOnStartup().catch((err) => {
    log.error('Startup legacy-task import reconciliation failed', { err });
  });
```

adding `import { reconcileLegacyTaskImportsOnStartup } from './modules/scheduling/startup-import.js';`
next to the other module imports. A contended `scheduler-mutator` lock on
a given session simply lands in that session's try/catch (dedupe-keyed
incident) — the sweep's own import path remains the steady-state retry.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec vitest run src/modules/scheduling/startup-import.test.ts src/modules/scheduling/legacy-import.test.ts
```

Expected: PASS.

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
pnpm test && pnpm exec tsc --noEmit
git add src/modules/scheduling/startup-import.ts src/modules/scheduling/startup-import.test.ts src/index.ts
git commit -m "feat(scheduler): reconcile unimported legacy tasks across all active sessions at startup"
```

---

### Task 9: Make scheduler projection steady-state write-free

**Why (validation A9, medium):** `projectScheduledTask`
(`src/modules/scheduling/projection.ts:115-149`, existing-row branch) runs
an UNCONDITIONAL `UPDATE` whose `host_received_at = CASE WHEN
host_accepted_at IS NULL THEN @hostReceivedAt ...` rewrites a FRESH
timestamp on every call while the projection awaits acceptance. Both the
per-minute repair pass (`repairSchedulerProjections` →
`ensureSessionSchedulerProjections`) and the host sweep call it for EVERY
live task — so every live, not-yet-accepted projection costs one real
journal+fsync transaction per pass on its `journal_mode=DELETE`
inbound.db. A /tmp probe (validator-A9) proved SQLite skips ALL disk I/O
for same-value and 0-row UPDATEs — so skipping the UPDATE when the
projected values are unchanged makes the steady-state pass write nothing.

**Files:**
- Modify: `src/modules/scheduling/projection.ts` (`projectScheduledTask`,
  existing-row branch)
- Modify: `src/modules/scheduling/projection.test.ts` (add one test)

**Interfaces:** no signature changes. Behavior pinned by the existing
suite: changed tasks still update in place (`updates an existing
projection without changing its stable id or seq`), NULLed host stamps
still get repaired (`repairs a pending legacy projection that is missing
its host-backed trigger stamp`), accepted stamps stay frozen (`does not
rewrite a projection trigger stamp after host acceptance`).

- [ ] **Step 1: Write the failing test**

Append inside the `describe('scheduler projection helpers', ...)` block of
`src/modules/scheduling/projection.test.ts`:

```ts
  it('re-projecting an UNCHANGED live task is a steady-state no-op (host_received_at preserved)', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      projectScheduledTask(inDb, task, 'sess-new', owner);
      // Sentinel: if the second projection runs its UPDATE, this value is
      // overwritten with a fresh timestamp (host_accepted_at IS NULL).
      inDb
        .prepare("UPDATE messages_in SET host_received_at = '2020-01-01T00:00:00.000Z' WHERE series_id = 'task-1'")
        .run();

      projectScheduledTask(inDb, getScheduledTask('ag-1', 'task-1')!, 'sess-new', owner);
    });

    expect(inDb.prepare('SELECT host_received_at FROM messages_in WHERE series_id = ?').get('task-1')).toEqual({
      host_received_at: '2020-01-01T00:00:00.000Z',
    });
    inDb.close();
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/modules/scheduling/projection.test.ts
```

Expected: FAIL — the new test sees a fresh `host_received_at` (today's
unconditional UPDATE rewrites it). All existing tests PASS.

- [ ] **Step 3: Implement the unchanged-skip**

In `projectScheduledTask`, widen the existence probe (currently
`SELECT id, kind FROM messages_in WHERE id = ?`, `:36-38`) to fetch the
compared columns:

```ts
    const existing = inDb
      .prepare(
        `SELECT id, kind, status, process_after, recurrence, platform_id, channel_type,
                thread_id, messaging_group_id, is_group, content, series_id, trigger,
                host_input_id, host_route_key, host_received_at
           FROM messages_in WHERE id = ?`,
      )
      .get(messageId) as
      | {
          id: string;
          kind: string;
          status: string;
          process_after: string | null;
          recurrence: string | null;
          platform_id: string | null;
          channel_type: string | null;
          thread_id: string | null;
          messaging_group_id: string | null;
          is_group: 0 | 1 | null;
          content: string;
          series_id: string | null;
          trigger: number;
          host_input_id: string | null;
          host_route_key: string | null;
          host_received_at: string | null;
        }
      | undefined;
```

and wrap the existing-row UPDATE (`:116-149`) so it only runs when
something would actually change (the INSERT branch and the
retire-other-generations UPDATE above it are untouched):

```ts
    } else {
      // Steady-state guard: the repair pass and the host sweep re-project
      // every live task every minute. When nothing changed, skip the UPDATE
      // entirely — the previous unconditional UPDATE refreshed
      // host_received_at each pass, costing one fsynced journal transaction
      // per live task per minute on the DELETE-journal inbound.db. The
      // host-stamp NULL checks keep the legacy-repair behavior: a projection
      // missing its trigger stamp is NOT "unchanged".
      const unchanged =
        existing.status === task.status &&
        existing.process_after === task.process_after &&
        existing.recurrence === task.recurrence &&
        existing.platform_id === task.platform_id &&
        existing.channel_type === task.channel_type &&
        existing.thread_id === task.thread_id &&
        existing.messaging_group_id === task.messaging_group_id &&
        existing.is_group === task.is_group &&
        existing.content === task.content &&
        existing.series_id === task.series_id &&
        existing.trigger === 1 &&
        existing.host_input_id !== null &&
        existing.host_route_key !== null &&
        existing.host_received_at !== null;
      if (!unchanged) {
        inDb
          .prepare(
            `UPDATE messages_in
             ... // the existing UPDATE statement and .run() payload, verbatim
          );
      }
    }
```

(`markTaskProjected` after the transaction stays as-is — its steady-state
short-circuit already returns without writing.)

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec vitest run src/modules/scheduling/projection.test.ts src/modules/scheduling/sync.test.ts src/modules/scheduling/repair.test.ts src/host-sweep.scheduler.test.ts
```

Expected: PASS — including the pinned repair/acceptance/update-in-place
behaviors listed under Interfaces.

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
pnpm test && pnpm exec tsc --noEmit
git add src/modules/scheduling/projection.ts src/modules/scheduling/projection.test.ts
git commit -m "fix(scheduler): skip the projection update when a live task is unchanged"
```

---

### Task 10: Boot-time process-singleton guard

**Why (validation A11, medium):** the DB-row `runtime_locks` table was the
only (accidental) cross-process contention detector; Task 1's in-memory
locks cannot see a second process. Real overlap paths exist and are
unguarded: a manual `pnpm start`/`pnpm dev` beside the running service,
the legacy `com.nanoclaw` plist plus the new per-checkout
`com.nanoclaw-v2-<slug>` label both KeepAlive'd on the same checkout, a
`launchctl unload`→`load` during the ~60 s graceful drain, and the nohup
fallback's `kill; sleep 2`. Two service processes mutating one `v2.db`
must fail loudly instead.

**Files:**
- Create: `src/process-singleton.ts`
- Create: `src/process-singleton.test.ts`
- Modify: `src/index.ts` (`main()`, BEFORE `initDb` at ~:69-70)

**Interfaces:**
- Consumes: better-sqlite3 (`PRAGMA locking_mode=EXCLUSIVE` + a write
  transaction takes the OS-level exclusive file lock and, in this mode,
  HOLDS it until the connection closes — i.e. process exit), `DATA_DIR`
  from `src/config.js` (`v2.db` lives at `path.join(DATA_DIR, 'v2.db')`,
  `src/index.ts:69`; the lock DB sits beside it).
- Produces:
  - `acquireProcessSingletonLock(lockDbPath: string): void` — throws a
    loud, named error on `SQLITE_BUSY`.
  - `releaseProcessSingletonLockForTest(): void` (test-only).
- Deliberately SERVICE-scoped: ops scripts (`scripts/run-migrations.ts`,
  `scripts/q.ts`, yente tools) stay OUTSIDE the guard — they are
  operator-supervised and legitimately run beside the service (accepted
  residual, A11).

- [ ] **Step 1: Write the failing test**

Create `src/process-singleton.test.ts` (a `/tmp` lock DB; two connections
in one test process contend at the OS level exactly like two processes):

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireProcessSingletonLock, releaseProcessSingletonLockForTest } from './process-singleton.js';

describe('process-singleton guard', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-singleton-test-'));
    lockPath = path.join(tmpDir, 'nanoclaw.lock.db');
  });

  afterEach(() => {
    releaseProcessSingletonLockForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires the lock on a fresh path', () => {
    expect(() => acquireProcessSingletonLock(lockPath)).not.toThrow();
  });

  it('a second connection cannot acquire the held lock (loud contention failure)', () => {
    acquireProcessSingletonLock(lockPath);
    // Each call opens an independent better-sqlite3 connection — the same
    // OS-level file-lock contention two overlapping processes would hit.
    expect(() => acquireProcessSingletonLock(lockPath)).toThrow(/already holds the singleton lock/);
  });

  it('re-acquisition succeeds after the holder releases (process-exit analogue)', () => {
    acquireProcessSingletonLock(lockPath);
    releaseProcessSingletonLockForTest();
    expect(() => acquireProcessSingletonLock(lockPath)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec vitest run src/process-singleton.test.ts
```

Expected: FAIL — module `./process-singleton.js` does not exist.

- [ ] **Step 3: Implement the guard**

Create `src/process-singleton.ts`:

```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

let lockDb: Database.Database | null = null;

/**
 * Boot-time process-singleton guard.
 *
 * In-process runtime locks (src/db/runtime-locks.ts) cannot detect a SECOND
 * nanoclaw process — and real overlap paths exist (manual start beside the
 * service, legacy + slug launchd labels on one checkout, unload→load during
 * the graceful drain, the nohup fallback). This takes an EXCLUSIVE SQLite
 * lock on a dedicated lock DB beside v2.db and HOLDS it for the process
 * lifetime; a second service process fails loudly at boot instead of
 * silently double-writing v2.db.
 *
 * Deliberately service-scoped: ops scripts (scripts/run-migrations.ts,
 * scripts/q.ts, yente tools) remain outside the guard — operator-supervised.
 */
export function acquireProcessSingletonLock(lockDbPath: string): void {
  fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
  // Short busy timeout: a conflicting boot should fail fast, not hang.
  const db = new Database(lockDbPath, { timeout: 1_000 });
  try {
    // locking_mode=EXCLUSIVE + a write transaction acquires the OS-level
    // exclusive file lock; in this mode SQLite NEVER releases it until the
    // connection closes (process exit) — no lease, no renewal, no staleness:
    // the kernel drops the lock the instant the process dies.
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS singleton (pid INTEGER NOT NULL); DELETE FROM singleton;');
    db.prepare('INSERT INTO singleton (pid) VALUES (?)').run(process.pid);
    db.exec('COMMIT;');
    lockDb = db; // held for process lifetime — deliberately never closed
    log.info('Process-singleton lock acquired', { lockDbPath, pid: process.pid });
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === 'SQLITE_BUSY') {
      log.error('Another nanoclaw process already holds the singleton lock — refusing to start', { lockDbPath });
      throw new Error(
        `Another nanoclaw process already holds the singleton lock at ${lockDbPath}; ` +
          'refusing to start a second writer against the same v2.db',
      );
    }
    throw err;
  }
}

/** Test-only: release the held lock so contention can be exercised. */
export function releaseProcessSingletonLockForTest(): void {
  lockDb?.close();
  lockDb = null;
}
```

Wire it into `src/index.ts` `main()` as the FIRST step, before `initDb`
(`:68-70` today), importing
`import { acquireProcessSingletonLock } from './process-singleton.js';`:

```ts
async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Process-singleton guard — MUST precede initDb: two overlapping
  // service processes must never both write v2.db (in-process runtime
  // locks cannot see across processes). A throw here lands in
  // main().catch → log.fatal → exit(1): the SECOND instance crash-loops
  // loudly under its supervisor while the first keeps serving.
  acquireProcessSingletonLock(path.join(DATA_DIR, 'nanoclaw.lock.db'));

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec vitest run src/process-singleton.test.ts src/shutdown.test.ts
```

Expected: PASS. (`shutdown.test.ts` guards `index.ts`'s import surface —
if it imports `main`'s module, the guard must not fire at import time; it
runs only inside `main()`.)

- [ ] **Step 5: Final whole-plan verification**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run format:check
```

Expected: everything green. If `format:check` complains, run
`pnpm run format:fix` and re-stage.

- [ ] **Step 6: Commit**

```bash
git add src/process-singleton.ts src/process-singleton.test.ts src/index.ts
git commit -m "feat(boot): hold an exclusive singleton lock beside v2.db and fail loudly on overlap"
```

---

## Post-plan notes for the deploy stage (NOT tasks in this plan)

- The one-time host migration (archive stale sessions with a `v2.db`
  backup) is a supervised host action AFTER this code ships; the code-side
  predicate (`getSweepableSessions`) already keeps the set bounded even
  before the migration runs, via the recency window.
- **Deferred `runtime_locks` DROP (Task 2):** ship it in a FUTURE release
  only after the in-memory-locks change has soaked in production. Hard
  precondition: a fresh `v2.db` backup taken immediately before the
  migration runs (e.g. `cp data/v2.db data/v2.db.bak-pre-drop` with the
  service stopped), plus a one-line rollback runbook (the migration-014
  `CREATE TABLE runtime_locks (...)` DDL). An old binary against a
  post-drop DB crash-loops at startup — validated, not hypothetical.
- **Verify the live host's ACTUAL pragma values** (validation A6 caveat):
  `sqlite3 data/v2.db 'PRAGMA journal_mode; PRAGMA synchronous; PRAGMA wal_autocheckpoint;'`.
  The findings doc's 12 s write trace showed NORMAL-like fsync behavior
  (~61 fsyncs for ~15,300 WAL frames), contradicting the code-default
  FULL that Task 7 pins. Investigate on the host (better-sqlite3 build's
  `SQLITE_DEFAULT_SYNCHRONOUS`, WSL2/storage-layer behavior, or trace
  misattribution) — if commits genuinely weren't fsyncing, the A6 loss
  window already existed in production and needs its own follow-up.
- **Flagged follow-up (out of scope, validation A9):** `repair.ts`'s
  `reportUnsafeArchivedSchedulerRows` still runs an UNBOUNDED per-minute
  scan over ALL non-active sessions (open + full `messages_in` scan each),
  with no event-loop yield — the set grows without bound and is untouched
  by this plan's sweep bounding. Task 9 removes the write mechanism, not
  the loop. Bound/stagger it in a follow-up release.
- Host verification after deploy (findings doc execution note): service
  `write_bytes` < 0.2 MB/s sustained over an hour; WAL mtime quiet between
  real events; sweep pass duration AND scheduler-repair pass duration in
  logs (the A9 scale unknowns become observable here); zero regressions in
  catch-up counters and message round-trips; the startup reconciliation's
  summary log line (`Startup legacy-task import reconciliation finished`)
  shows `failed: 0` — investigate any incident it filed.
