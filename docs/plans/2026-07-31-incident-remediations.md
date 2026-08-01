# Incident Remediations (R1, R2, R3, R6, R8, R9) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Close the failure classes from the 2026-07-29..31 dvora incident: recovery-owned messages that wedge forever (R1/R2), silent scheduler wallpaper logs (R3), lost container crash output (R6), host-wide recovery blockage from one bad reconciliation record (R8), and hot-journal / lock-contention wedges between host and container (R9).

**Architecture:** All changes are host-side Node (better-sqlite3, `src/**`) except R9's container half (`container/agent-runner/src/**`, bun:sqlite). R1/R2 add a TTL-based escape hatch to the deliberate "recovery rows never wake" design: expired recovery acks count as due, get released back to pending (bounded attempts tracked in `messages_in`), and after K attempts escalate to a failed ack + user-visible notice + error incident, which the existing scheduler sync and ack-sync machinery then consume. R8 restructures the reconciliation reader from whole-file fail-closed to per-record quarantine with advisory-field sanitization. R9 adds a guarded write-mode journal-rollback open on the host and busy-retry tolerance in the container.

**Tech Stack:** TypeScript (strict, NodeNext — relative imports need `.js`), better-sqlite3 11.10.0 (host), bun:sqlite (container), vitest (host tests), bun:test (container tests).

## Global Constraints

- **Inbound-message durability writes are untouchable.** No change may cause a message to be dropped or double-processed; the claim/dedupe semantics from the catch-up work must hold. Recovery-ack release (Task 3) reuses the existing container resume machinery — it returns rows to `pending`, it never deletes `messages_in` rows. Be precise about what protects a re-run: message/row-level dedupe is HARD (the `delivered` table, `INSERT OR IGNORE`); NEW external side effects on the resumed turn are protected only ADVISORILY by the injected recovery context (the input ledger is per-turn in-memory and cannot dedupe across a release) — hence Task 3's GWS-cleanliness release gate and the accepted, K-bounded residual for ordinary chat side effects.
- **Messages must NEVER be silently dropped.** Every terminal failure produces a user-visible notice row in `messages_out` AND an error-severity incident.
- **All new behavior is configurable via env with safe defaults** (idiom: `Number(process.env.NANOCLAW_X) || default`, declared next to the consumer). New knobs: `NANOCLAW_RECOVERY_WAKE_TTL_MS` (1800000), `NANOCLAW_RECOVERY_MAX_WAKE_ATTEMPTS` (3), `NANOCLAW_SCHEDULER_ACK_STALE_ESCALATION_MS` (3600000), `NANOCLAW_INCIDENT_DEDUPE_LOG_INTERVAL_MS` (3600000), `NANOCLAW_CONTAINER_STDERR_TAIL_KB` (64), `NANOCLAW_CONTAINER_STDERR_EVENTS_PER_MIN` (30), `NANOCLAW_CONTAINER_STDERR_KEEP_FILES` (5, clean-exit tails), `NANOCLAW_CONTAINER_STDERR_KEEP_CRASH_FILES` (5, crash tails — rotated separately), `NANOCLAW_CONTAINER_SQLITE_BUSY_TIMEOUT_MS` (30000).
- **Fail-open for anything advisory, fail-loud for anything uncertain.**
- **Session DBs stay `journal_mode = DELETE`** — a sacred cross-mount invariant (`src/session-manager.ts:1-12`). Never propose WAL for `inbound.db`/`outbound.db`.
- **R1 must only ADD wakes, never suppress any.** Unparseable timestamps count as expired (fail toward waking).
- **Two test runners:** host = `pnpm test` (vitest), container = `cd container/agent-runner && bun test`. CI gate = `pnpm run format:check` → `pnpm run typecheck` → `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` → host vitest → container bun test. All suites must stay green.
- **Commits:** conventional-with-scope (`fix(sweep):`, `feat(db):`, `test(...)`), one concern each.
- **Line numbers** in this plan were verified at deployed ref `a005743`. They are anchors, not gospel — locate the quoted code by content before editing.
- All commands run from the repo root: `/home/dan/code/nanoclaw-reboot-resilience/.worktrees/incident-remediations`.
- Do NOT deploy and do NOT touch the live host. Repo-side implementation + tests only.
- README.md is the only end-user markdown doc; do not create new docs beyond this plan.

## File Structure

| File | Role |
|---|---|
| `src/db/schema.ts` | Modify: add `recovery_wake_attempts` to `messages_in` in `INBOUND_SCHEMA` |
| `src/db/session-db.ts` | Modify: TTL-aware due count, recovery-ack list/release/fail helpers, `parseSqliteUtcMs`, GWS release-gate helpers (`getHostAcceptedInputId`, `listGwsUncertainInputIds`), `syncProcessingAcks` failed-status precedence guard, reconciliation reader rework (`readGwsReconciliationRecords`, identity fail-closed), `transliterateToAscii`, hot-journal healing open |
| `src/host-sweep.ts` | Modify: TTL consts, release/escalate step + TTL-aware wake gate in `sweepSession`, GATED healing outbound open (`!isContainerRunning` only), reconciliation quarantine plumbing in `recoverGwsClaimPartitions`/`recoverAfterKill` (incl. async `writeRecovery` restructuring) |
| `src/recovery-escalation.ts` | Create: release-or-escalate pass for expired recovery acks, with GWS-cleanliness release gate (R1/R2 core) |
| `src/modules/scheduling/sync.ts` | Modify: plumb `status_changed`, stale-ack error escalation (R3) |
| `src/yente/scheduler-alerts.ts` | Modify: rate-limit the `scheduler_incident_deduped` log (R3) |
| `src/container-stderr.ts` | Create: stderr tail buffer, chunk line-splitter, rate limiter, persist with carry flush + crash-privileged rotation (R6, pure/unit-testable) |
| `src/container-runner.ts` | Modify: stderr handler rewrite, `ActiveContainer` fields, persist tail to host-side `v2-container-logs` on exit (pinned anchor) (R6); env passthrough for container busy timeout (R9) |
| `src/delivery.ts` | Modify: transient hot-journal/busy classification (defer only — no inline heal), per-session error containment (R9) |
| `src/session-manager.ts` | Modify: `openOutboundDbHealing` session-scoped wrapper (R9, gated callers only); `containerLogsDir` host-side log tree (R6) |
| `src/yente/operator-gws-session.ts` | Modify: adopt new reconciliation reader return shape (R8) |
| `container/agent-runner/src/db/sqlite-retry.ts` | Create: busy classification + bounded retry helper (R9) |
| `container/agent-runner/src/db/connection.ts` | Modify: configurable busy_timeout (R9) |
| `container/agent-runner/src/index.ts`, `container/agent-runner/src/poll-loop.ts` | Modify: wrap the FULL unguarded DB touchpoint surface with retry (incl. catch handlers + `pollFollowups`) (R9) |
| Tests | `src/db/session-db.test.ts`, `src/host-sweep.test.ts`, `src/recovery-escalation.test.ts` (new), `src/modules/scheduling/sync.test.ts`, `src/yente/scheduler-alerts.test.ts`, `src/container-stderr.test.ts` (new), `src/container-runner.test.ts`, `src/delivery.test.ts`, `container/agent-runner/src/db/sqlite-retry.test.ts` (new), `container/agent-runner/src/poll-loop.test.ts` (self-trigger injection) |

Background reading (do not edit): incident findings at `/home/dan/code/shapiroserver2/docs/plans/2026-07-30-nanoclaw-write-stream-findings-and-ssd-plan.md`. Recon reports with verbatim current code live at `/home/dan/code/nanoclaw-reboot-resilience/.worktrees/.the-usual-logs/incident-remediations/reports/*.md`.

---

### Task 1: R1 — TTL-aware recovery wake counting

Recovery-owned rows (`processing_ack.status='recovery'`) are deliberately excluded from the host wake due-count. Add a TTL: rows whose `status_changed` is older than `NANOCLAW_RECOVERY_WAKE_TTL_MS` (default 30 min) stop being excluded, so they count as due and trip a wake. This only ever ADDS wakes.

**Files:**
- Modify: `src/db/session-db.ts` (~316-344, `countDueMessagesExcludingRecovery`)
- Modify: `src/host-sweep.ts` (~114-148 const block; ~493-511 wake gate in `sweepSession`)
- Test: `src/db/session-db.test.ts` (describe at ~389), `src/host-sweep.test.ts` (describe at ~795)

**Interfaces:**
- Consumes: existing `processing_ack` schema (`message_id, status, status_changed, notice_message_out_id, claim_token`); `status_changed` is a SQLite `datetime('now')` string (`YYYY-MM-DD HH:MM:SS`, UTC).
- Produces (used by Tasks 2-4):
  - `export function parseSqliteUtcMs(s: string): number` in `src/db/session-db.ts` — parses both SQLite `datetime('now')` strings and ISO strings; `NaN` if unparseable.
  - `export interface RecoveryWakeOptions { nowMs: number; recoveryWakeTtlMs: number; }` in `src/db/session-db.ts`.
  - `countDueMessagesExcludingRecovery(inDb: Database.Database, outDb: Database.Database, wake?: RecoveryWakeOptions): number` — third parameter optional; omitted = legacy behavior (exclude all recovery rows).
  - `export const RECOVERY_WAKE_TTL_MS: number` in `src/host-sweep.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/db/session-db.test.ts`, inside the existing `describe('countDueMessagesExcludingRecovery')` block (uses the file's `freshDir()`/`inboundDb()`/`outboundDb()` helpers with real `INBOUND_SCHEMA`/`OUTBOUND_SCHEMA`). The existing tests in this describe (~:389-433) insert inbound rows via the imported `insertMessage` helper (import at :22), NOT raw SQL — the real `messages_in` schema has `content TEXT NOT NULL` with no default (`src/db/schema.ts:322`), so a raw INSERT that omits `content` fails the NOT NULL constraint. `insertMessage` supplies `content`, hardcodes `status = 'pending'`, defaults `trigger` to 1, and auto-assigns `seq` — exactly the due-gate shape these tests need. Use it here too:

```ts
it('counts a recovery-owned row as due again once its ack is older than the wake TTL', () => {
  freshDir();
  const inDb = inboundDb();
  const outDb = outboundDb();
  insertMessage(inDb, {
    id: 'm-old', kind: 'chat', timestamp: new Date().toISOString(),
    platformId: null, channelType: null, threadId: null,
    content: '{"text":"a"}', processAfter: null, recurrence: null,
  });
  // Recovery ack last transitioned 45 minutes ago.
  outDb
    .prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-old', 'recovery', datetime('now', '-45 minutes'))`,
    )
    .run();
  const wake = { nowMs: Date.now(), recoveryWakeTtlMs: 30 * 60 * 1000 };
  // Legacy call (no options): still excluded — R1 must not change callers that opt out.
  expect(countDueMessagesExcludingRecovery(inDb, outDb)).toBe(0);
  // TTL-aware call: expired recovery ownership no longer suppresses the wake.
  expect(countDueMessagesExcludingRecovery(inDb, outDb, wake)).toBe(1);
  inDb.close();
  outDb.close();
});

it('keeps excluding a recovery-owned row younger than the wake TTL', () => {
  freshDir();
  const inDb = inboundDb();
  const outDb = outboundDb();
  insertMessage(inDb, {
    id: 'm-fresh', kind: 'chat', timestamp: new Date().toISOString(),
    platformId: null, channelType: null, threadId: null,
    content: '{"text":"a"}', processAfter: null, recurrence: null,
  });
  outDb
    .prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-fresh', 'recovery', datetime('now', '-5 minutes'))`,
    )
    .run();
  const wake = { nowMs: Date.now(), recoveryWakeTtlMs: 30 * 60 * 1000 };
  expect(countDueMessagesExcludingRecovery(inDb, outDb, wake)).toBe(0);
  inDb.close();
  outDb.close();
});

it('treats an unparseable status_changed as expired (fails toward waking)', () => {
  freshDir();
  const inDb = inboundDb();
  const outDb = outboundDb();
  insertMessage(inDb, {
    id: 'm-bad', kind: 'chat', timestamp: new Date().toISOString(),
    platformId: null, channelType: null, threadId: null,
    content: '{"text":"a"}', processAfter: null, recurrence: null,
  });
  outDb
    .prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-bad', 'recovery', 'garbage')`,
    )
    .run();
  const wake = { nowMs: Date.now(), recoveryWakeTtlMs: 30 * 60 * 1000 };
  expect(countDueMessagesExcludingRecovery(inDb, outDb, wake)).toBe(1);
  inDb.close();
  outDb.close();
});
```

Also add a `parseSqliteUtcMs` unit test in the same file (top level):

```ts
describe('parseSqliteUtcMs', () => {
  it('parses sqlite and ISO timestamps as UTC and returns NaN for garbage', () => {
    expect(parseSqliteUtcMs('2026-04-20 11:00:00')).toBe(Date.parse('2026-04-20T11:00:00Z'));
    expect(parseSqliteUtcMs('2026-04-20T11:00:00.000Z')).toBe(Date.parse('2026-04-20T11:00:00.000Z'));
    expect(Number.isNaN(parseSqliteUtcMs('garbage'))).toBe(true);
  });
});
```

Import `parseSqliteUtcMs` in the test file's existing import list from `./session-db.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/db/session-db.test.ts -t 'wake TTL'`
Expected: FAIL (`countDueMessagesExcludingRecovery` does not accept a third argument / `parseSqliteUtcMs` is not exported).

- [ ] **Step 3: Implement in `src/db/session-db.ts`**

Add near the top of the file (module scope):

```ts
/**
 * Parse a session-DB timestamp to epoch ms. processing_ack.status_changed is
 * written with SQLite datetime('now') ('YYYY-MM-DD HH:MM:SS', UTC, no zone
 * marker); tests and some writers use ISO strings. Returns NaN if unparseable.
 */
export function parseSqliteUtcMs(s: string): number {
  if (typeof s !== 'string' || s.length === 0) return NaN;
  if (s.includes('T') || s.endsWith('Z')) return Date.parse(s);
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

/** TTL options for the outbound-aware due count (R1). */
export interface RecoveryWakeOptions {
  nowMs: number;
  recoveryWakeTtlMs: number;
}
```

Replace the body of `countDueMessagesExcludingRecovery` (currently at ~:325; keep its doc comment and extend it with: `Rows whose recovery ownership is older than wake.recoveryWakeTtlMs count as due again (R1) — the bounded escape from the deliberate recovery exclusion.`):

```ts
export function countDueMessagesExcludingRecovery(
  inDb: Database.Database,
  outDb: Database.Database,
  wake?: RecoveryWakeOptions,
): number {
  const recoveryRows = outDb
    .prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'recovery'")
    .all() as Array<{ message_id: string; status_changed: string }>;
  const recoveryOwned = new Set(
    recoveryRows
      .filter((r) => {
        if (!wake) return true; // legacy behavior: exclude every recovery row
        const changedMs = parseSqliteUtcMs(r.status_changed);
        // Unparseable timestamps count as expired: fail toward waking, never
        // toward hiding work (R1 must only ADD wakes).
        if (!Number.isFinite(changedMs)) return false;
        return wake.nowMs - changedMs < wake.recoveryWakeTtlMs; // fresh -> keep excluded
      })
      .map((r) => r.message_id),
  );

  const due = inDb
    .prepare(
      `SELECT id FROM messages_in
       WHERE status = 'pending'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .all() as Array<{ id: string }>;

  return due.filter((r) => !recoveryOwned.has(r.id)).length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/db/session-db.test.ts`
Expected: PASS (all, including the pre-existing exclusion test — the legacy 2-arg call path is unchanged).

- [ ] **Step 5: Wire the wake gate in `src/host-sweep.ts`**

Add to the const block (~:114-148, next to `IDLE_REAP_MS`):

```ts
/** R1: recovery-owned rows older than this count as due again in the wake gate. */
export const RECOVERY_WAKE_TTL_MS = Number(process.env.NANOCLAW_RECOVERY_WAKE_TTL_MS) || 30 * 60 * 1000;
```

In `sweepSession` (wake gate at ~:493-511), change the due-count line from:

```ts
    const dueCount = outDb ? countDueMessagesExcludingRecovery(inDb, outDb) : countDueMessages(inDb);
```

to:

```ts
    const dueCount = outDb
      ? countDueMessagesExcludingRecovery(inDb, outDb, {
          nowMs: Date.now(),
          recoveryWakeTtlMs: RECOVERY_WAKE_TTL_MS,
        })
      : countDueMessages(inDb);
```

Add a host-sweep test in `src/host-sweep.test.ts` inside `describe('host sweep wake decision excludes recovery-owned rows')` (~:795; uses the in-memory `testDbs()` harness — its minimal `processing_ack` has `message_id, status, status_changed`, which is all this needs; a `BASE` constant already exists at file scope ~:49 — reuse it):

```ts
it('counts a recovery-owned row as due once older than the wake TTL (R1)', () => {
  const { inDb, outDb } = testDbs();
  inDb.prepare("INSERT INTO messages_in (id, status, trigger) VALUES ('m-rec', 'pending', 1)").run();
  outDb
    .prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-rec', 'recovery', '2026-04-20 10:00:00')",
    )
    .run();
  // BASE is 2026-04-20T12:00:00Z — two hours after the ack transition.
  expect(
    countDueMessagesExcludingRecovery(inDb, outDb, { nowMs: BASE, recoveryWakeTtlMs: 30 * 60 * 1000 }),
  ).toBe(1);
  expect(
    countDueMessagesExcludingRecovery(inDb, outDb, { nowMs: BASE, recoveryWakeTtlMs: 3 * 60 * 60 * 1000 }),
  ).toBe(0);
});
```

- [ ] **Step 6: Run the touched suites**

Run: `pnpm exec vitest run src/db/session-db.test.ts src/host-sweep.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/session-db.ts src/host-sweep.ts src/db/session-db.test.ts src/host-sweep.test.ts
git commit -m "feat(sweep): count recovery-owned rows as due again past a wake TTL (R1)"
```

---

### Task 2: R2a — wake-attempt tracking and recovery-ack release helpers

Bounded retries need durable state. The attempt counter lives on `messages_in.recovery_wake_attempts` (host-owned inbound DB — survives ack deletion and container rewrites of `processing_ack`). This task adds the column + the pure DB helpers; Task 3 wires the policy.

**Files:**
- Modify: `src/db/schema.ts` (`INBOUND_SCHEMA` `messages_in`, ~:287-324)
- Modify: `src/db/session-db.ts` (extend `migrateMessagesInTable`; new helpers)
- Test: `src/db/session-db.test.ts`, `src/host-sweep.test.ts` (harness schema)

**Interfaces:**
- Consumes: `parseSqliteUtcMs` from Task 1; existing self-heal idiom (`PRAGMA table_info` + guarded `ALTER TABLE`, see `migrateOutboundRouteColumns` at `src/db/session-db.ts:74-129`).
- Produces (used by Task 3):
  - Column `messages_in.recovery_wake_attempts INTEGER NOT NULL DEFAULT 0` (self-healed by `migrateMessagesInTable`, which `openInboundDb` already calls).
  - `export interface RecoveryAckRow { messageId: string; statusChanged: string; statusChangedMs: number; }`
  - `export function listRecoveryAcks(outDb: Database.Database): RecoveryAckRow[]`
  - `export function getRecoveryWakeAttempts(inDb: Database.Database, messageId: string): number`
  - `export function incrementRecoveryWakeAttempts(inDb: Database.Database, messageIds: string[]): void`
  - `export function deleteRecoveryAcks(outDbRw: Database.Database, messageIds: string[]): void` — deletes only rows still in `status='recovery'`.
  - `export function failRecoveryAck(outDbRw: Database.Database, messageId: string, noticeMessageOutId: string): void` — flips a recovery ack to `failed` with its terminal-notice pointer.
  - `export interface MessageRoutingRow { kind: string; channelType: string | null; platformId: string | null; threadId: string | null; }` and `export function getMessageRouting(inDb: Database.Database, messageId: string): MessageRoutingRow | null`

- [ ] **Step 1: Write the failing tests**

In `src/db/session-db.test.ts` add a new describe (reuse `freshDir()`/`TEST_DIR`/`outboundDb()`; `openInboundDb` is exported from `src/db/session-db.ts` and takes a db path):

```ts
describe('recovery wake attempt tracking (R2)', () => {
  it('self-heals the recovery_wake_attempts column on an old inbound DB and increments it', () => {
    freshDir();
    // Simulate an OLD inbound DB without the column. CAUTION: openInboundDb's
    // migrations ADD many columns but ASSUME others pre-exist — the
    // platform_message_id backfill (session-db.ts ~:1457-1466) runs
    // `UPDATE messages_in ... WHERE channel_type = 'discord'` and the
    // migration never ADDs `channel_type`, so `id` and `channel_type` MUST be
    // in the legacy fixture; migrateSessionRoutingTable unguardedly ALTERs
    // `session_routing`, so that table must exist too. `content` is NOT NULL
    // in the real schema, so the INSERT must supply it.
    const legacy = new Database(path.join(TEST_DIR, 'inbound.db'));
    legacy.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT,
      tries INTEGER DEFAULT 0, platform_id TEXT, channel_type TEXT, thread_id TEXT,
      content TEXT NOT NULL);
      CREATE TABLE session_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT, platform_id TEXT, thread_id TEXT);`);
    legacy.prepare("INSERT INTO messages_in (id, kind, timestamp, content) VALUES ('m-1', 'chat', datetime('now'), 'hello')").run();
    legacy.close();

    const inDb = openInboundDb(path.join(TEST_DIR, 'inbound.db')); // runs migrateMessagesInTable
    expect(getRecoveryWakeAttempts(inDb, 'm-1')).toBe(0);
    incrementRecoveryWakeAttempts(inDb, ['m-1']);
    incrementRecoveryWakeAttempts(inDb, ['m-1']);
    expect(getRecoveryWakeAttempts(inDb, 'm-1')).toBe(2);
    expect(getRecoveryWakeAttempts(inDb, 'missing')).toBe(0);
    inDb.close();
  });

  it('lists, releases, and fails recovery acks', () => {
    freshDir();
    const outDb = outboundDb();
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-a', 'recovery', '2026-04-20 10:00:00')")
      .run();
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-b', 'completed', '2026-04-20 10:00:00')")
      .run();

    const acks = listRecoveryAcks(outDb);
    expect(acks).toHaveLength(1);
    expect(acks[0].messageId).toBe('m-a');
    expect(acks[0].statusChangedMs).toBe(Date.parse('2026-04-20T10:00:00Z'));

    failRecoveryAck(outDb, 'm-a', 'notice-1');
    const failed = outDb.prepare("SELECT status, notice_message_out_id FROM processing_ack WHERE message_id = 'm-a'").get() as {
      status: string;
      notice_message_out_id: string;
    };
    expect(failed).toMatchObject({ status: 'failed', notice_message_out_id: 'notice-1' });

    // deleteRecoveryAcks only touches rows still in recovery.
    deleteRecoveryAcks(outDb, ['m-a', 'm-b']);
    expect(outDb.prepare('SELECT COUNT(*) AS n FROM processing_ack').get()).toMatchObject({ n: 2 });
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-c', 'recovery', datetime('now'))")
      .run();
    deleteRecoveryAcks(outDb, ['m-c']);
    expect(outDb.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE message_id = 'm-c'").get()).toMatchObject({ n: 0 });
    outDb.close();
  });
});
```

Add `listRecoveryAcks`, `getRecoveryWakeAttempts`, `incrementRecoveryWakeAttempts`, `deleteRecoveryAcks`, `failRecoveryAck` to the test file's import list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/db/session-db.test.ts -t 'recovery wake attempt'`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

In `src/db/schema.ts`, inside `INBOUND_SCHEMA`'s `CREATE TABLE IF NOT EXISTS messages_in`, add after the `tries INTEGER DEFAULT 0` line:

```sql
  -- R2: host-side count of TTL-expired recovery wakes granted to this row.
  -- Distinct from `tries` (processing retries) so the two policies never mix.
  recovery_wake_attempts INTEGER NOT NULL DEFAULT 0,
```

In `src/db/session-db.ts`, extend `migrateMessagesInTable` (the existing self-heal called from `openInboundDb`; pattern identical to `migrateOutboundRouteColumns` at :74-129 — if the function already computes a column set, reuse it instead of re-querying):

```ts
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('recovery_wake_attempts')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN recovery_wake_attempts INTEGER NOT NULL DEFAULT 0').run();
  }
```

Add the helpers (near `countDueMessagesExcludingRecovery`):

```ts
/** A recovery-owned processing_ack row, with its parsed transition time. */
export interface RecoveryAckRow {
  messageId: string;
  statusChanged: string;
  statusChangedMs: number; // NaN when unparseable
}

export function listRecoveryAcks(outDb: Database.Database): RecoveryAckRow[] {
  const rows = outDb
    .prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'recovery'")
    .all() as Array<{ message_id: string; status_changed: string }>;
  return rows.map((r) => ({
    messageId: r.message_id,
    statusChanged: r.status_changed,
    statusChangedMs: parseSqliteUtcMs(r.status_changed),
  }));
}

export function getRecoveryWakeAttempts(inDb: Database.Database, messageId: string): number {
  const row = inDb.prepare('SELECT recovery_wake_attempts AS n FROM messages_in WHERE id = ?').get(messageId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

export function incrementRecoveryWakeAttempts(inDb: Database.Database, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const stmt = inDb.prepare(
    'UPDATE messages_in SET recovery_wake_attempts = recovery_wake_attempts + 1 WHERE id = ?',
  );
  const tx = inDb.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(messageIds);
}

/** Delete ONLY still-recovery acks, returning their rows to normal pending visibility. */
export function deleteRecoveryAcks(outDbRw: Database.Database, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const stmt = outDbRw.prepare("DELETE FROM processing_ack WHERE message_id = ? AND status = 'recovery'");
  const tx = outDbRw.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(messageIds);
}

/** Flip a recovery ack to failed with its terminal-notice pointer (R2 escalation). */
export function failRecoveryAck(outDbRw: Database.Database, messageId: string, noticeMessageOutId: string): void {
  outDbRw
    .prepare(
      "UPDATE processing_ack SET status = 'failed', status_changed = datetime('now'), notice_message_out_id = ? WHERE message_id = ? AND status = 'recovery'",
    )
    .run(noticeMessageOutId, messageId);
}

export interface MessageRoutingRow {
  kind: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

export function getMessageRouting(inDb: Database.Database, messageId: string): MessageRoutingRow | null {
  const row = inDb
    .prepare('SELECT kind, channel_type, platform_id, thread_id FROM messages_in WHERE id = ?')
    .get(messageId) as
    | { kind: string; channel_type: string | null; platform_id: string | null; thread_id: string | null }
    | undefined;
  if (!row) return null;
  return { kind: row.kind, channelType: row.channel_type, platformId: row.platform_id, threadId: row.thread_id };
}
```

Note: `messages_in` carries `channel_type`, `platform_id`, `thread_id` columns (`src/db/schema.ts:299-307`) — verify the names against the schema before finalizing the SELECT.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/db/session-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the host-sweep test harness schema**

`src/host-sweep.test.ts`'s `testDbs()` (~:67-93) uses hand-written minimal schemas. In the `messages_in` CREATE add `recovery_wake_attempts INTEGER NOT NULL DEFAULT 0,` and in the `processing_ack` CREATE add `notice_message_out_id TEXT, claim_token TEXT` (aligning the harness with the prod columns — a known divergence).

Run: `pnpm exec vitest run src/host-sweep.test.ts`
Expected: PASS (schema additions are backward compatible).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/session-db.ts src/db/session-db.test.ts src/host-sweep.test.ts
git commit -m "feat(db): track recovery wake attempts and add recovery-ack release helpers (R2)"
```


---

### Task 3: R2b — release-or-escalate pass for expired recovery acks

The policy core of R1/R2. Past-TTL recovery acks with attempts < K are **released** (attempt++ and the recovery ack deleted — the row returns to normal pending visibility, so the wake actually results in a turn, and the container's existing resume machinery injects the still-pending recovery context into that turn). Release is additionally gated on GWS cleanliness: a row whose ORIGINAL accepted input has unresolved GWS reconciliation evidence (e.g. `outcome_unknown` incidents without a durable resolution) is NEVER auto-released — it escalates directly, regardless of remaining attempts (validator-V5: the release path otherwise never re-checks the reconciliation store, and the re-run's acceptance mints a NEW input_id, so R8's fail-closed machinery structurally cannot catch it). Past-TTL acks with attempts >= K (or GWS-uncertain ones) are **escalated**: user-visible notice, ack → `failed` with the notice pointer, `messages_in` → `failed`, best-effort supersede of the owning `session_state` recovery entries, error incident. The existing `syncProcessingAcks` failed-ack notice gate and the scheduler sync `ack.status === 'failed'` branch (which calls `failScheduledTask`) then consume the failed ack with zero new code.

Design notes the implementer must not "simplify" away:
- Release (not just wake) is required because the container hides ANY acked row from `getPendingMessages` and only resumes recovery entries **within a turn** — a wake with no visible pending work is a no-op idle. Deleting the recovery ack is the host-side twin of the container's own (unwired) `clearRecoveryOwnership` escape hatch; the `session_state` recovery entries remain `pending`, so the resumed turn still gets the "do NOT repeat completed side effects" context. Input-ledger dedupe semantics are untouched.
- The caller must hold the container-stopped guard (`!isContainerRunning(session.id)`) — the RW outbound open is only safe then.
- `failScheduledTask` posts nothing to the user; our notice row IS the user-visible part, and it doubles as the `failedAckHasTerminalNotice` proof (`sync.ts:103-112` checks that `notice_message_out_id` points at an existing `messages_out` row).
- Notice ids are deterministic (`recovery-escalation-<messageId>`) and `writeOutboundDirect` uses `INSERT OR IGNORE`, so a sweep that crashes mid-escalation converges on retry instead of duplicating notices.
- If the inbound row has null routing columns, the notice row will be dropped by delivery with a warn — acceptable: the error incident still reaches the user's channel via the incident->alert route.
- The GWS-cleanliness gate reads the row's ORIGINAL `messages_in.host_accepted_input_id` (the re-run would mint a new one) against the reconciliation store. If the store is configured but unreadable, the pass defers LOUDLY (neither release — unsafe — nor terminal escalation — unfair to the message); R3's stale-ack escalation keeps alerting while that persists.
- Accepted residual (A8, recorded in the load-bearing ledger): ordinary chat-turn external side effects (sent messages, scheduled tasks, agent sends) remain ADVISORILY protected on rerun — the injected recovery-context prompt, the same exposure class as today's natural container resume — bounded by K=3 and loudly escalated on exhaustion. The GWS-uncertain class (the truly dangerous one) is excluded from auto-release by the gate. Do not describe this anywhere as a hard guarantee: no cross-turn idempotency key exists.

**Files:**
- Create: `src/recovery-escalation.ts`
- Modify: `src/host-sweep.ts` (const block; `sweepSession` between crash-recovery step 3 at ~:481-486 and the wake gate at ~:493)
- Modify: `src/db/session-db.ts` (`getHostAcceptedInputId`, `listGwsUncertainInputIds`; `syncProcessingAcks` failed-status precedence guard at ~:393-407)
- Test: `src/recovery-escalation.test.ts` (new), `src/db/session-db.test.ts` (failed-status durability), `container/agent-runner/src/poll-loop.test.ts` (self-trigger injection)

**Interfaces:**
- Consumes (Task 2): `listRecoveryAcks`, `getRecoveryWakeAttempts`, `incrementRecoveryWakeAttempts`, `deleteRecoveryAcks`, `failRecoveryAck`, `getMessageRouting`, plus existing `markMessageFailed(db, messageId)` (`src/db/session-db.ts:346`), `writeOutboundDirect(agentGroupId, sessionId, {id, kind, platformId, channelType, threadId, content})` and `openOutboundDbRw(agentGroupId, sessionId)` (`src/session-manager.ts`), `reportSchedulerIncident(args): Promise<boolean>` (`src/yente/scheduler-alerts.ts:54` — the lock-acquiring wrapper; safe here because `sweepSession` does not hold the scheduler-mutator lock at this point).
- Produces:
  - `export interface RecoveryReleaseOutcome { released: string[]; escalated: string[]; }`
  - `export async function releaseOrEscalateExpiredRecoveryAcks(opts: { session: Session; inDb: Database.Database; outDb: Database.Database; nowMs: number; ttlMs: number; maxAttempts: number; reconciliationStorePath?: string; }): Promise<RecoveryReleaseOutcome>`
  - `export const RECOVERY_MAX_WAKE_ATTEMPTS: number` in `src/host-sweep.ts`.
  - `export function getHostAcceptedInputId(inDb: Database.Database, messageId: string): string | null` in `src/db/session-db.ts` — `SELECT host_accepted_input_id FROM messages_in WHERE id = ?` (column exists, `src/db/schema.ts:315`; self-healed at session-db.ts ~:1485).
  - `export function listGwsUncertainInputIds(reconciliationStorePath: string | undefined): Set<string>` in `src/db/session-db.ts` — lightweight standalone scan (independent of Task 6's reader rework): undefined path ⇒ empty set (GWS reconciliation not configured). A DEFINED path fails closed on ANY unreadability: missing file, truncated tail, a line that fails `JSON.parse`, or an incident whose `input_id` is not a non-empty string ⇒ THROW (the caller defers the pass loudly — never toward release; this is what the Step 1 '/nonexistent-but-configured/store.jsonl' test asserts and what the Step 3 sketch implements). Otherwise parse the JSONL store and return the `input_id` of every incident record lacking a resolution record for its `audit_id`.

- [ ] **Step 1: Write the failing tests**

Create `src/recovery-escalation.test.ts`. Real in-memory DBs; mock `session-manager.js` (capture notices, hand back the shared out DB with a no-op `close`) and `scheduler-alerts.js` (capture incidents). Import the `Session` type from wherever `src/host-sweep.ts` imports it (check its import block) and cast the fixture.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const written: Array<Record<string, unknown>> = [];
const incidents: Array<Record<string, unknown>> = [];
let sharedOutDb: Database.Database;

function nonClosing(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'close') return () => {};
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database.Database;
}

vi.mock('./session-manager.js', () => ({
  writeOutboundDirect: vi.fn((_ag: string, _sid: string, message: Record<string, unknown>) => {
    written.push(message);
    sharedOutDb
      .prepare(
        `INSERT OR IGNORE INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.kind, message.platformId, message.channelType, message.threadId, message.content);
  }),
  openOutboundDbRw: vi.fn(() => nonClosing(sharedOutDb)),
}));

vi.mock('./yente/scheduler-alerts.js', () => ({
  reportSchedulerIncident: vi.fn(async (args: Record<string, unknown>) => {
    incidents.push(args);
    return true;
  }),
}));

import { releaseOrEscalateExpiredRecoveryAcks } from './recovery-escalation.js';
import { countDueMessagesExcludingRecovery, getRecoveryWakeAttempts } from './db/session-db.js';

const session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: null,
} as never; // cast to Session; fill any additional required fields the type demands

function makeDbs() {
  const inDb = new Database(':memory:');
  inDb.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'chat', timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending', trigger INTEGER NOT NULL DEFAULT 1, process_after TEXT,
    tries INTEGER DEFAULT 0, recovery_wake_attempts INTEGER NOT NULL DEFAULT 0,
    channel_type TEXT, platform_id TEXT, thread_id TEXT, host_accepted_input_id TEXT)`);
  const outDb = new Database(':memory:');
  outDb.exec(`CREATE TABLE processing_ack (
      message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL,
      notice_message_out_id TEXT, claim_token TEXT);
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, seq INTEGER, timestamp TEXT, kind TEXT,
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT);
    CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  sharedOutDb = outDb;
  return { inDb, outDb };
}

const TTL = 30 * 60 * 1000;
const NOW = Date.parse('2026-04-20T12:00:00Z');
const OLD = '2026-04-20 10:00:00'; // 2h before NOW

function reOwn(outDb: Database.Database, id: string): void {
  outDb
    .prepare("INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'recovery', ?)")
    .run(id, OLD);
}

beforeEach(() => {
  written.length = 0;
  incidents.length = 0;
});

describe('releaseOrEscalateExpiredRecoveryAcks', () => {
  it('leaves fresh recovery acks alone', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, channel_type, platform_id) VALUES ('m-1', 'discord', 'chan-1')").run();
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-1', 'recovery', datetime('now'))")
      .run();
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    expect(outcome).toEqual({ released: [], escalated: [] });
    expect(written).toHaveLength(0);
  });

  it('releases, then escalates: nothing hides behind a recovery ack past TTL*K (the R2 invariant)', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, channel_type, platform_id) VALUES ('m-1', 'discord', 'chan-1')").run();

    // Sweeps 1..3: each finds the (re-owned) expired ack and releases it.
    for (let pass = 1; pass <= 3; pass++) {
      reOwn(outDb, 'm-1');
      const outcome = await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
      expect(outcome.released).toEqual(['m-1']);
      expect(outcome.escalated).toEqual([]);
      // Ack deleted -> row is visible pending work again (this is what makes the wake useful).
      expect(outDb.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE message_id = 'm-1'").get()).toMatchObject({ n: 0 });
      expect(getRecoveryWakeAttempts(inDb, 'm-1')).toBe(pass);
    }

    // Sweep 4: attempts exhausted -> loud terminal failure.
    reOwn(outDb, 'm-1');
    const final = await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    expect(final.escalated).toEqual(['m-1']);

    const ack = outDb.prepare("SELECT status, notice_message_out_id FROM processing_ack WHERE message_id = 'm-1'").get() as {
      status: string;
      notice_message_out_id: string;
    };
    expect(ack.status).toBe('failed');
    expect(ack.notice_message_out_id).toBe('recovery-escalation-m-1');
    // The notice row exists and carries the inbound row's routing -> this is
    // exactly the failedAckHasTerminalNotice contract plus deliverability.
    const notice = outDb.prepare("SELECT id, channel_type, platform_id FROM messages_out WHERE id = 'recovery-escalation-m-1'").get();
    expect(notice).toMatchObject({ channel_type: 'discord', platform_id: 'chan-1' });
    // Inbound row terminally failed -> no longer due, never silently retried.
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get()).toMatchObject({ status: 'failed' });
    expect(countDueMessagesExcludingRecovery(inDb, outDb, { nowMs: NOW, recoveryWakeTtlMs: TTL })).toBe(0);
    // Error incident recorded with a stable dedupe key.
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ severity: 'error', dedupeKey: 'recovery-escalation:sess-1:m-1' });
  });

  it('supersedes the owning session_state recovery entries on escalation (no zombie context injection)', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, recovery_wake_attempts) VALUES ('m-1', 3)").run();
    reOwn(outDb, 'm-1');
    outDb
      .prepare("INSERT INTO session_state (key, value, updated_at) VALUES ('recovery:test:route-1', ?, datetime('now'))")
      .run(
        JSON.stringify([
          { id: 'rec-1', status: 'pending', originalTasks: [{ messageId: 'm-1', text: 'do it', timestamp: 't' }] },
          { id: 'rec-2', status: 'pending', originalTasks: [{ messageId: 'other', text: 'x', timestamp: 't' }] },
        ]),
      );
    await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    const entries = JSON.parse(
      (outDb.prepare("SELECT value FROM session_state WHERE key = 'recovery:test:route-1'").get() as { value: string }).value,
    ) as Array<{ id: string; status: string }>;
    expect(entries.find((e) => e.id === 'rec-1')?.status).toBe('superseded');
    expect(entries.find((e) => e.id === 'rec-2')?.status).toBe('pending');
  });

  it('uses task-flavored notice text for kind=task rows', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, kind, recovery_wake_attempts) VALUES ('m-t', 'task', 3)").run();
    reOwn(outDb, 'm-t');
    await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0].content as string).text).toContain('scheduled task');
  });

  it('escalates (never releases) an expired ack whose original input is GWS-uncertain, at attempts=0', async () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, channel_type, platform_id, host_accepted_input_id) VALUES ('m-g', 'discord', 'chan-1', 'input-9')",
      )
      .run();
    reOwn(outDb, 'm-g');
    // Reconciliation store: one outcome_unknown incident for input-9, no resolution.
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-')), 'store.jsonl');
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ schema_version: 2, audit_id: 'a-1', outcome: 'outcome_unknown', input_id: 'input-9', route_key: 'r', account: 'acct', operation: 'op', resource_type: 'doc', started_at: '2026-04-20T09:00:00Z', ended_at: '2026-04-20T09:00:01Z' })}\n`,
    );
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3, reconciliationStorePath: storePath,
    });
    // The gate, not exhaustion: attempts were 0 and it still escalated.
    expect(outcome).toEqual({ released: [], escalated: ['m-g'] });
    expect(outDb.prepare("SELECT status FROM processing_ack WHERE message_id = 'm-g'").get()).toMatchObject({ status: 'failed' });
    expect(incidents[0].details).toMatchObject({ gwsUncertainInputId: 'input-9' });
  });

  it('defers the whole pass loudly when a configured reconciliation store is unreadable', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id) VALUES ('m-u')").run();
    reOwn(outDb, 'm-u');
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3,
      reconciliationStorePath: '/nonexistent-but-configured/store.jsonl',
    });
    // Neither released (unsafe) nor escalated (unfair): ack untouched, retried next sweep.
    expect(outcome).toEqual({ released: [], escalated: [] });
    expect(outDb.prepare("SELECT status FROM processing_ack WHERE message_id = 'm-u'").get()).toMatchObject({ status: 'recovery' });
  });

  it("keeps the escalated inbound status 'failed' after syncProcessingAcks runs (durability, V6 residue)", async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, channel_type, platform_id, recovery_wake_attempts) VALUES ('m-1', 'discord', 'chan-1', 3)").run();
    reOwn(outDb, 'm-1');
    await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get()).toMatchObject({ status: 'failed' });
    // One sweep later, step 1 must NOT rewrite the terminal 'failed' to 'completed'.
    syncProcessingAcks(inDb, outDb);
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get()).toMatchObject({ status: 'failed' });
  });
});
```

(Add `syncProcessingAcks` and the fs/os/path imports to the test file's import lists. Note: `deferring` semantics apply only when `reconciliationStorePath` is DEFINED but unreadable; an undefined path — GWS reconciliation not configured — means an empty uncertain set. A DEFINED path whose file does not exist THROWS like any other unreadability — fail toward deferral, never toward release — which is exactly what the '/nonexistent-but-configured/store.jsonl' test above asserts and what the Interfaces spec and the Step 3 sketch require.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/recovery-escalation.test.ts`
Expected: FAIL (`./recovery-escalation.js` does not exist).

- [ ] **Step 3: Implement `src/recovery-escalation.ts`**

```ts
/**
 * R1/R2: bounded lifecycle for recovery-owned processing_ack rows.
 *
 * A quiet thread whose only work is recovery-owned wedges forever: recovery
 * rows are excluded from the wake due-count, and the container only resumes
 * recovery entries within a turn it woke for anyway (dvora incident 2026-07).
 *
 *  - past TTL, attempts < max: RELEASE — bump messages_in.recovery_wake_attempts
 *    and delete the recovery ack so the row is normal pending work again. The
 *    next turn re-processes it WITH the still-pending recovery context injected
 *    by the poll-loop resume machinery (do-not-repeat side effects preserved).
 *  - past TTL, attempts >= max: ESCALATE — user-visible notice row (doubles as
 *    the failedAckHasTerminalNotice proof), ack -> failed, messages_in -> failed,
 *    best-effort supersede of owning session_state recovery entries, and an
 *    error incident (reaches Discord via the incident->alert pass).
 *
 * Invariant: nothing sits hidden behind a recovery ack for more than TTL*K
 * without resolving or failing loudly. Never silently drops a message.
 *
 * Caller contract: the session's container is NOT running (RW outbound open).
 */
import type Database from 'better-sqlite3';
import {
  deleteRecoveryAcks,
  failRecoveryAck,
  getHostAcceptedInputId,
  getMessageRouting,
  getRecoveryWakeAttempts,
  incrementRecoveryWakeAttempts,
  listGwsUncertainInputIds,
  listRecoveryAcks,
  markMessageFailed,
} from './db/session-db.js';
import { openOutboundDbRw, writeOutboundDirect } from './session-manager.js';
import { reportSchedulerIncident } from './yente/scheduler-alerts.js';
import { log } from './log.js';
// Import the Session type from the same module host-sweep.ts imports it from:
import type { Session } from './types.js';

export interface RecoveryReleaseOutcome {
  released: string[];
  escalated: string[];
}

export async function releaseOrEscalateExpiredRecoveryAcks(opts: {
  session: Session;
  inDb: Database.Database;
  outDb: Database.Database;
  nowMs: number;
  ttlMs: number;
  maxAttempts: number;
  /** GWS reconciliation store (env NANOCLAW_GWS_RECONCILIATION_STORE); undefined = GWS not configured. */
  reconciliationStorePath?: string;
}): Promise<RecoveryReleaseOutcome> {
  const expired = listRecoveryAcks(opts.outDb).filter(
    // Unparseable timestamps count as expired: fail loud, never fail hidden.
    (ack) => !Number.isFinite(ack.statusChangedMs) || opts.nowMs - ack.statusChangedMs >= opts.ttlMs,
  );
  if (expired.length === 0) return { released: [], escalated: [] };

  // R2 GWS-cleanliness gate (A8, validator-V5 N1): a row whose ORIGINAL
  // accepted input has unresolved GWS reconciliation evidence must NEVER be
  // auto-released — the re-run would repeat a GWS write whose outcome is
  // unknown, and re-acceptance mints a NEW input_id so R8's fail-closed
  // machinery structurally cannot catch it. Such rows escalate directly.
  let gwsUncertainInputIds: Set<string>;
  try {
    gwsUncertainInputIds = listGwsUncertainInputIds(opts.reconciliationStorePath);
  } catch (err) {
    // Configured store unreadable: neither release (unsafe) nor terminally
    // escalate (unfair to the message) — defer the whole pass LOUDLY and let
    // the next sweep retry; R3's stale-ack escalation keeps alerting.
    log.error('Recovery release pass deferred: GWS reconciliation store unreadable', {
      sessionId: opts.session.id,
      err,
    });
    return { released: [], escalated: [] };
  }

  const toRelease: string[] = [];
  const toEscalate: string[] = [];
  const gatedInputIds = new Map<string, string>();
  for (const ack of expired) {
    const inputId = getHostAcceptedInputId(opts.inDb, ack.messageId);
    const gwsUncertain = inputId !== null && gwsUncertainInputIds.has(inputId);
    const exhausted = getRecoveryWakeAttempts(opts.inDb, ack.messageId) >= opts.maxAttempts;
    (gwsUncertain || exhausted ? toEscalate : toRelease).push(ack.messageId);
    if (gwsUncertain) {
      gatedInputIds.set(ack.messageId, inputId!);
      log.error('Recovery release blocked by unresolved GWS reconciliation; escalating', {
        sessionId: opts.session.id,
        messageId: ack.messageId,
        inputId,
      });
    }
  }

  // Notices first (writeOutboundDirect owns its own short-lived write handle).
  // Deterministic ids + INSERT OR IGNORE make escalation idempotent across
  // partially-failed sweeps.
  const noticeIds = new Map<string, string>();
  for (const messageId of toEscalate) {
    const routing = getMessageRouting(opts.inDb, messageId);
    const noticeId = `recovery-escalation-${messageId}`;
    const text =
      routing?.kind === 'task'
        ? `NanoClaw could not finish a scheduled task's work after ${opts.maxAttempts} interrupted attempts; the task run has been marked failed. (message ${messageId})`
        : `NanoClaw gave up on a message in this conversation after ${opts.maxAttempts} interrupted processing attempts; it has been marked failed and will not be retried automatically. (message ${messageId})`;
    writeOutboundDirect(opts.session.agent_group_id, opts.session.id, {
      id: noticeId,
      kind: 'chat',
      platformId: routing?.platformId ?? null,
      channelType: routing?.channelType ?? null,
      threadId: routing?.threadId ?? null,
      content: JSON.stringify({ text }),
    });
    noticeIds.set(messageId, noticeId);
  }

  const outDbRw = openOutboundDbRw(opts.session.agent_group_id, opts.session.id);
  try {
    deleteRecoveryAcks(outDbRw, toRelease);
    for (const messageId of toEscalate) {
      failRecoveryAck(outDbRw, messageId, noticeIds.get(messageId)!);
      supersedeRecoveryEntriesForMessage(outDbRw, messageId);
    }
  } finally {
    outDbRw.close();
  }

  incrementRecoveryWakeAttempts(opts.inDb, toRelease);
  for (const messageId of toEscalate) markMessageFailed(opts.inDb, messageId);

  for (const messageId of toRelease) {
    log.warn('Released expired recovery ack back to pending', {
      sessionId: opts.session.id,
      messageId,
      ttlMs: opts.ttlMs,
    });
  }
  for (const messageId of toEscalate) {
    log.error('Escalated exhausted recovery ack to terminal failure', {
      sessionId: opts.session.id,
      messageId,
      maxAttempts: opts.maxAttempts,
    });
    await reportSchedulerIncident({
      dedupeKey: `recovery-escalation:${opts.session.id}:${messageId}`,
      severity: 'error',
      agentGroupId: opts.session.agent_group_id,
      sessionId: opts.session.id,
      messagingGroupId: opts.session.messaging_group_id ?? null,
      threadId: opts.session.thread_id ?? null,
      message: `Recovery-owned message ${messageId} in session ${opts.session.id} was abandoned after ${opts.maxAttempts} wake attempts; it has been marked failed and the user was notified.`,
      details: {
        reason: 'recovery-escalation',
        messageId,
        maxAttempts: opts.maxAttempts,
        ttlMs: opts.ttlMs,
        // Distinguishes gate escalations from attempt exhaustion for operators.
        ...(gatedInputIds.has(messageId) ? { gwsUncertainInputId: gatedInputIds.get(messageId) } : {}),
      },
    });
  }
  return { released: toRelease, escalated: toEscalate };
}

/**
 * Best-effort: mark pending/in_flight session_state recovery entries that own
 * this message as superseded, so future turns stop injecting their context.
 * Advisory cleanup — failures are logged and swallowed (fail-open).
 */
function supersedeRecoveryEntriesForMessage(outDbRw: Database.Database, messageId: string): void {
  try {
    const rows = outDbRw.prepare("SELECT key, value FROM session_state WHERE key LIKE 'recovery:%'").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const row of rows) {
      let entries: unknown;
      try {
        entries = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      let changed = false;
      for (const entry of entries as Array<{
        status?: string;
        updatedAt?: string;
        originalTasks?: Array<{ messageId?: string }>;
      }>) {
        if (entry?.status !== 'pending' && entry?.status !== 'in_flight') continue;
        if (!entry.originalTasks?.some((t) => t?.messageId === messageId)) continue;
        entry.status = 'superseded';
        entry.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) {
        outDbRw
          .prepare('UPDATE session_state SET value = ?, updated_at = ? WHERE key = ?')
          .run(JSON.stringify(entries), new Date().toISOString(), row.key);
      }
    }
  } catch (err) {
    log.warn('Best-effort recovery-entry supersede failed', { messageId, err });
  }
}
```

Adjust the `Session` import and the `log` import path to match the file's neighbors (`src/host-sweep.ts` imports both — copy its import specifiers).

Also add the two gate helpers to `src/db/session-db.ts` (near the Task 2 helpers):

```ts
/** R2: the ORIGINAL accepted input id for a row (re-acceptance overwrites it). */
export function getHostAcceptedInputId(inDb: Database.Database, messageId: string): string | null {
  const row = inDb.prepare('SELECT host_accepted_input_id AS v FROM messages_in WHERE id = ?').get(messageId) as
    | { v: string | null }
    | undefined;
  return row?.v ?? null;
}

/**
 * R2 release gate: input_ids with GWS-uncertain evidence in the reconciliation
 * store — incident records lacking a resolution record for their audit_id.
 * Standalone lightweight scan (independent of the Task 6 reader rework).
 * undefined path => empty set (GWS reconciliation not configured).
 * Fail closed on unreadability: configured-but-missing file, truncated tail,
 * unparseable line, or an incident whose input_id is not a non-empty string
 * => THROW (callers defer their pass loudly rather than releasing).
 */
export function listGwsUncertainInputIds(reconciliationStorePath: string | undefined): Set<string> {
  if (!reconciliationStorePath) return new Set();
  // read file (throw if missing); enforce trailing-newline tail; JSON.parse each
  // non-empty line (throw on failure); records with record_type === 'resolution'
  // collect their audit_id; all other records are incidents: require a non-empty
  // string input_id (throw otherwise), map audit_id -> input_id. Return the
  // input_ids of incidents whose audit_id has no collected resolution.
}
```

(Implement the sketched body — it deliberately reuses no Task 6 machinery so Task 3 lands first; Task 6's reader rework does not change this store format.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/recovery-escalation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire into `sweepSession` in `src/host-sweep.ts`**

Add next to `RECOVERY_WAKE_TTL_MS`:

```ts
/** R2: failed resume attempts tolerated before a recovery ack escalates to terminal failure. */
export const RECOVERY_MAX_WAKE_ATTEMPTS = Number(process.env.NANOCLAW_RECOVERY_MAX_WAKE_ATTEMPTS) || 3;
```

Insert between step 3 (crash recovery, ~:481-486) and step 4 (wake gate, ~:493):

```ts
    // 3.5 R1/R2: bounded lifecycle for recovery-owned rows. Requires the
    // container-stopped guard (RW outbound open inside). Errors are contained
    // per session: a failed pass must never block the wake below (the TTL-aware
    // due count still fires, which only ADDS wakes).
    if (outDb && !isContainerRunning(session.id)) {
      try {
        const outcome = await releaseOrEscalateExpiredRecoveryAcks({
          session,
          inDb,
          outDb,
          nowMs: Date.now(),
          ttlMs: RECOVERY_WAKE_TTL_MS,
          maxAttempts: RECOVERY_MAX_WAKE_ATTEMPTS,
          // GWS-cleanliness release gate — same env source as recoverAfterKill.
          reconciliationStorePath: process.env.NANOCLAW_GWS_RECONCILIATION_STORE,
        });
        if (outcome.released.length > 0 || outcome.escalated.length > 0) {
          log.info('Recovery wake TTL pass acted', {
            sessionId: session.id,
            released: outcome.released,
            escalated: outcome.escalated,
          });
        }
      } catch (err) {
        log.error('Recovery wake TTL pass failed', { sessionId: session.id, err });
      }
    }
```

Import `releaseOrEscalateExpiredRecoveryAcks` from `./recovery-escalation.js`.

- [ ] **Step 5b: Make the escalated 'failed' inbound status durable (V6 residue)**

Without a guard, `syncProcessingAcks` (`src/db/session-db.ts` ~:366-411) flips the escalated row's inbound status back to `'completed'` one sweep later: the failed-ack branch funnels into the same `UPDATE messages_in SET status = 'completed' WHERE id = ? AND status != 'completed'` (~:407) as completed acks — the Task 3 tests would assert a status that does not survive production. Fix with status precedence: track which ack status put each id in the to-complete list, and for ids coming from `'failed'` acks use

```ts
  "UPDATE messages_in SET status = 'completed' WHERE id = ? AND status NOT IN ('completed', 'failed')"
```

so a host-escalated terminal `'failed'` is never silently rewritten (rows from `'completed'` acks keep the existing statement; a `pending` row behind a failed ack still completes, exactly as today). The durability test in Step 1 (`keeps the escalated inbound status 'failed' after syncProcessingAcks runs`) is the proof; also add a plain unit test beside the existing `syncProcessingAcks` suite in `src/db/session-db.test.ts`: a failed ack with a valid notice over an inbound row already `'failed'` leaves it `'failed'`, while one over a `'pending'` row still completes it.

Run: `pnpm exec vitest run src/db/session-db.test.ts src/recovery-escalation.test.ts`
Expected: PASS.

- [ ] **Step 5c: Container-side proof that recovery context injects on a self-triggered wake (V5 N2)**

The release path's safety story depends on the resumed turn seeing the `<recovery>` context — but the existing container test (`container/agent-runner/src/poll-loop.test.ts` ~:3217) only proves injection when a DIFFERENT due message wakes the route. Add a sibling test in that file for the released-row-as-its-own-wake-trigger case: arrange a `session_state` recovery entry (`pending`) whose `originalTasks` reference message `m-1`, leave `m-1` itself pending and UN-acked (exactly the post-release state — no other due message), run the poll loop turn, and assert the provider prompt contains the injected recovery context for that entry. Mirror the arrange/assert style of the ~:3217 test; only the wake trigger differs. If injection misses (route/provider scope key mismatch), that is a REAL bug in the release design — fix the scope keying, do not weaken the test.

Run: `cd container/agent-runner && bun test src/poll-loop.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full host suite**

Run: `pnpm test`
Expected: PASS. If `src/host-sweep.test.ts` suites that drive `sweepSession` (revival/scheduler siblings) fail on the new import, add `releaseOrEscalateExpiredRecoveryAcks` to their `vi.mock` surface the same way neighboring host-sweep dependencies are mocked.

- [ ] **Step 7: Commit**

```bash
git add src/recovery-escalation.ts src/recovery-escalation.test.ts src/host-sweep.ts src/db/session-db.ts src/db/session-db.test.ts container/agent-runner/src/poll-loop.test.ts
git commit -m "feat(sweep): release or escalate recovery-owned rows past the wake TTL, gated on GWS cleanliness (R2)"
```

---

### Task 4: R3 — escalate stale scheduler acks instead of wallpapering

`sync.ts` records a warn incident once per unresolved recovery ack and then logs `scheduler_incident_deduped` at info ~1000x/day forever. Add: (a) an error-severity incident with a DISTINCT dedupe key once the ack is older than a threshold (so it actually alerts a second, escalated time), and (b) rate-limit the dedupe log line.

**Files:**
- Modify: `src/modules/scheduling/sync.ts` (`SchedulerAckRow` ~:31-35, `getProcessingAcksForProjectedTasks` ~:78-101, recovery branch ~:358-361)
- Modify: `src/yente/scheduler-alerts.ts` (dedupe log at ~:119-131)
- Test: `src/modules/scheduling/sync.test.ts`, `src/yente/scheduler-alerts.test.ts`

**Interfaces:**
- Consumes: `parseSqliteUtcMs` (Task 1, from `src/db/session-db.ts` — a leaf module, no import cycle), existing `recordSchedulerIncident` local adapter (sync.ts:61-76), `logSchedulerEvent`.
- Produces:
  - `SchedulerAckRow` gains `status_changed: string;`
  - `export function recordStaleSchedulerAckEscalation(session: Session, row: ProjectionRow, status: string, ackAgeMs: number, owner: RuntimeLockOwner): void` in sync.ts
  - `export function resetDedupeLogRateLimitForTest(): void` in scheduler-alerts.ts

- [ ] **Step 1: Write the failing tests**

In `src/modules/scheduling/sync.test.ts` (harness: `initTestDb` + `runMigrations`, `freshDbs()`, `withSchedulerLock`, `insertAck(outDb, messageId, status, noticeMessageOutId?)` at ~:130, `incidentRows()` at ~:144 — mirror the existing test at :397 `records recovery-owned scheduler projections without clearing recurrence or re-running them`, which builds a projected task and inserts a recovery ack):

```ts
it('escalates a stale recovery ack to an error incident with a distinct dedupe key (R3)', () => {
  // Build the same projected task + recovery ack fixture as the test above,
  // but backdate the ack: after insertAck(outDb, msgId, 'recovery'), run
  outDb
    .prepare("UPDATE processing_ack SET status_changed = datetime('now', '-2 hours') WHERE message_id = ?")
    .run(msgId);

  withSchedulerLock((owner) => syncSessionSchedulerState(inDb, outDb, session, owner));

  const keys = incidentRows().map((r) => r.dedupe_key);
  expect(keys.some((k) => k.endsWith(':unresolved-ack:recovery'))).toBe(true);
  expect(keys.some((k) => k.endsWith(':unresolved-ack:recovery:stale-escalated'))).toBe(true);
  const escalated = incidentRows().find((r) => r.dedupe_key.endsWith(':stale-escalated'));
  expect(escalated).toMatchObject({ severity: 'error', status: 'pending' });
});

it('does not escalate a fresh recovery ack (R3)', () => {
  // Same fixture, ack left at datetime('now').
  withSchedulerLock((owner) => syncSessionSchedulerState(inDb, outDb, session, owner));
  const keys = incidentRows().map((r) => r.dedupe_key);
  expect(keys.some((k) => k.endsWith(':unresolved-ack:recovery'))).toBe(true);
  expect(keys.some((k) => k.endsWith(':stale-escalated'))).toBe(false);
});
```

(Fill in the fixture by copying the :397 test's arrange block verbatim — same task creation, projection, and session objects; only the ack age differs.)

In `src/yente/scheduler-alerts.test.ts`:

```ts
it('rate-limits the scheduler_incident_deduped log line (R3)', async () => {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  resetDedupeLogRateLimitForTest();
  const args = {
    dedupeKey: 'test:dedupe-rate-limit',
    severity: 'warn' as const,
    message: 'x',
    details: {},
  };
  await reportSchedulerIncident(args); // inserts
  await reportSchedulerIncident(args); // duplicate #1 -> logs deduped
  await reportSchedulerIncident(args); // duplicate #2 -> suppressed (inside window)
  spy.mockRestore();
  const dedupedLines = writes.filter((w) => w.includes('scheduler_incident_deduped'));
  expect(dedupedLines).toHaveLength(1);
});
```

(Match the file's existing seeding requirements — if `reportSchedulerIncident` needs an agent group/session seeded, reuse the file's `seedAgentGroup()` helpers or pass no session fields; incidents without routes are fine here because delivery is not exercised.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/modules/scheduling/sync.test.ts src/yente/scheduler-alerts.test.ts`
Expected: FAIL (no `:stale-escalated` incident; two `scheduler_incident_deduped` lines; `resetDedupeLogRateLimitForTest` missing).

- [ ] **Step 3: Implement sync.ts changes**

Add `status_changed: string;` to `SchedulerAckRow` (~:31-35). In `getProcessingAcksForProjectedTasks` (~:78-101) add `status_changed` to the selected columns in BOTH branches of the existing `notice_message_out_id` feature-check (`status_changed` is NOT NULL since the table's creation — no feature check needed for it).

Add near the module's other consts:

```ts
/** R3: age past which an unresolved ack escalates from warn wallpaper to an error incident. */
const SCHEDULER_ACK_STALE_ESCALATION_MS =
  Number(process.env.NANOCLAW_SCHEDULER_ACK_STALE_ESCALATION_MS) || 60 * 60 * 1000;
```

Add below `recordUnresolvedSchedulerAck` (~:136-155), reusing its shape:

```ts
/**
 * R3: distinct dedupe key (':stale-escalated' suffix) so this alerts once at
 * error severity even though the warn-severity incident already consumed the
 * base key. Age is derived from processing_ack.status_changed.
 */
export function recordStaleSchedulerAckEscalation(
  session: Session,
  row: ProjectionRow,
  status: string,
  ackAgeMs: number,
  owner: RuntimeLockOwner,
): void {
  recordSchedulerIncident({
    owner,
    dedupeKey: `scheduler-sync:${session.agent_group_id}:${row.series_id}:${row.id}:unresolved-ack:${status}:stale-escalated`,
    severity: 'error',
    session,
    seriesId: row.series_id,
    message: `Scheduled task "${row.series_id}" has been hidden behind an unresolved ${status} ack for ${Math.round(ackAgeMs / 60000)} minutes; recovery is stalled and needs attention.`,
    details: {
      reason: 'stale-unresolved-scheduler-ack',
      messageId: row.id,
      ackStatus: status,
      ackAgeMs,
    },
  });
}
```

Change the recovery branch (~:358-361) to:

```ts
      if (ack?.status === 'recovery') {
        recordUnresolvedSchedulerAck(session, row, 'recovery', owner);
        const ackAgeMs = Date.now() - parseSqliteUtcMs(ack.status_changed);
        if (Number.isFinite(ackAgeMs) && ackAgeMs >= SCHEDULER_ACK_STALE_ESCALATION_MS) {
          recordStaleSchedulerAckEscalation(session, row, 'recovery', ackAgeMs, owner);
        }
      }
```

Import `parseSqliteUtcMs` from `../../db/session-db.js`.

- [ ] **Step 4: Implement the dedupe-log rate limit in `src/yente/scheduler-alerts.ts`**

Add at module scope:

```ts
/** R3: the deduped-incident info line fired ~1000x/day during the dvora incident. */
const DEDUPE_LOG_INTERVAL_MS = Number(process.env.NANOCLAW_INCIDENT_DEDUPE_LOG_INTERVAL_MS) || 60 * 60 * 1000;
const dedupeLogState = new Map<string, { lastEmitMs: number; suppressed: number }>();

export function resetDedupeLogRateLimitForTest(): void {
  dedupeLogState.clear();
}
```

Replace the `inserted.changes === 0` block (~:119-122) with:

```ts
  if (inserted.changes === 0) {
    const now = Date.now();
    const state = dedupeLogState.get(args.dedupeKey) ?? { lastEmitMs: 0, suppressed: 0 };
    if (now - state.lastEmitMs >= DEDUPE_LOG_INTERVAL_MS) {
      logSchedulerEvent('info', 'scheduler_incident_deduped', {
        dedupeKey: args.dedupeKey,
        suppressedSinceLastEmit: state.suppressed,
      });
      dedupeLogState.set(args.dedupeKey, { lastEmitMs: now, suppressed: 0 });
    } else {
      dedupeLogState.set(args.dedupeKey, { lastEmitMs: state.lastEmitMs, suppressed: state.suppressed + 1 });
    }
    return false;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/scheduling/sync.test.ts src/yente/scheduler-alerts.test.ts`
Expected: PASS. (If a pre-existing scheduler-alerts test asserted the deduped log line fires on every duplicate, update it to call `resetDedupeLogRateLimitForTest()` and assert the first duplicate logs.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/scheduling/sync.ts src/yente/scheduler-alerts.ts src/modules/scheduling/sync.test.ts src/yente/scheduler-alerts.test.ts
git commit -m "feat(scheduler): escalate stale unresolved acks to error incidents and rate-limit dedupe logs (R3)"
```

---

### Task 5: R6 — capture and persist container stderr

Containers run with `--rm`; their stderr is logged at `log.debug` (below the prod threshold) and vanishes on exit — the dvora root error was permanently lost this way. Capture a byte-capped tail per container, log structured agent-runner events at info (rate-limited, truncated), and persist the tail on every container exit into a HOST-SIDE sibling tree (`DATA_DIR/v2-container-logs/<ag>/<sid>/` — the `hostCorrelationDir` precedent, `src/session-manager.ts:78-80`), NEVER into the agent-writable `/workspace` session dir: crash evidence written where the incriminated agent can forge it is worthless, and host-privileged `mkdir`/`write`/`rm` inside an agent-owned tree without the repo's `O_NOFOLLOW`/`lstat` discipline would hand the agent a symlink-redirected host write/delete primitive (validator-V8). Retention is crash-privileged: clean-exit tails and crash tails rotate on SEPARATE budgets, so routine clean exits can never rotate away crash evidence before an operator looks (in the incident, operator latency was ~4 days; keep-newest-5-regardless would have recycled all slots within ~a day).

**Files:**
- Create: `src/container-stderr.ts` (pure helpers — no container-runner imports)
- Modify: `src/session-manager.ts` (export `containerLogsDir` next to `hostCorrelationDir` ~:78-80)
- Modify: `src/container-runner.ts` (consts; `ActiveContainer` ~:95; stderr handler ~:413-421; `finalizeVerifiedContainerStop` ~:490-527, persist pinned after the LAST early return)
- Test: `src/container-stderr.test.ts` (new), `src/container-runner.test.ts`

**Interfaces:**
- Consumes: `hostCorrelationDir` precedent at `src/session-manager.ts:78-80` (host-owned per-session state OUTSIDE the agent-writable tree; created `mode: 0o700`); the container spawn scope (`agentGroup`, the `ActiveContainer` instance); exit scope in `finalizeVerifiedContainerStop` (`sessionId`, `code`, `current: ActiveContainer` — note: NO agent group in scope today, hence the new `agentGroupId` field).
- Produces:
  - `export function containerLogsDir(agentGroupId: string, sessionId: string): string` in `src/session-manager.ts` (next to `hostCorrelationDir`) = `path.join(DATA_DIR, 'v2-container-logs', agentGroupId, sessionId)` — host-owned, never mounted into any container.
  - (all below in `src/container-stderr.ts`)
  - `export function splitStderrChunk(carry: string, chunk: string): { lines: string[]; carry: string }`
  - `export function parseStructuredStderrEvent(line: string): Record<string, unknown> | null` — accepts bare JSON lines and `[poll-loop] `-prefixed JSON lines; requires a string `event` field.
  - `export class StderrTail { constructor(maxBytes: number); append(line: string): void; contents(): string; }`
  - `export class MinuteRateLimiter { constructor(maxPerMinute: number); allow(nowMs: number): boolean; suppressed: number; }`
  - `export function truncateForLog(line: string, max?: number): string`
  - `export function persistStderrTail(opts: { logDir: string; tail: StderrTail; carry?: string; exitCode: number | null; keepClean?: number; keepCrash?: number; nowMs?: number }): string | null` — best-effort, never throws; flushes the final unterminated `carry` line into the tail, writes `<logDir>/<iso-stamp>-exit-<code>.log` (a null code is labeled `unknown`, never `null`), then rotates CLEAN tails (`-exit-0.log`) down to `keepClean` and CRASH tails (everything else) down to `keepCrash` INDEPENDENTLY.
  - `ActiveContainer` gains `agentGroupId: string; stderrTail: StderrTail; stderrEventLimiter: MinuteRateLimiter; stderrState: { carry: string }; observedExitCode?: number | null;`

- [ ] **Step 1: Write the failing unit tests**

Create `src/container-stderr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MinuteRateLimiter,
  parseStructuredStderrEvent,
  persistStderrTail,
  splitStderrChunk,
  StderrTail,
  truncateForLog,
} from './container-stderr.js';

describe('splitStderrChunk', () => {
  it('reassembles JSON split across chunk boundaries', () => {
    const first = splitStderrChunk('', '{"severity":"error","ev');
    expect(first.lines).toEqual([]);
    const second = splitStderrChunk(first.carry, 'ent":"boom"}\nplain line\npartial');
    expect(second.lines).toEqual(['{"severity":"error","event":"boom"}', 'plain line']);
    expect(second.carry).toBe('partial');
  });
});

describe('parseStructuredStderrEvent', () => {
  it('parses bare and poll-loop-prefixed JSON events, rejects everything else', () => {
    expect(parseStructuredStderrEvent('{"severity":"error","event":"fatal_error"}')).toMatchObject({
      event: 'fatal_error',
    });
    expect(parseStructuredStderrEvent('[poll-loop] {"severity":"info","event":"tick"}')).toMatchObject({
      event: 'tick',
    });
    expect(parseStructuredStderrEvent('plain stderr noise')).toBeNull();
    expect(parseStructuredStderrEvent('{"no_event_field":true}')).toBeNull();
    expect(parseStructuredStderrEvent('{broken json')).toBeNull();
  });
});

describe('StderrTail', () => {
  it('caps at maxBytes by dropping oldest lines', () => {
    const tail = new StderrTail(64);
    for (let i = 0; i < 20; i++) tail.append(`line-${String(i).padStart(2, '0')} xxxxxxxxxx`);
    const contents = tail.contents();
    expect(Buffer.byteLength(contents, 'utf8')).toBeLessThanOrEqual(64 + 32); // one line of slack
    expect(contents).toContain('line-19');
    expect(contents).not.toContain('line-00');
  });
});

describe('MinuteRateLimiter', () => {
  it('allows maxPerMinute then suppresses until the window rolls', () => {
    const limiter = new MinuteRateLimiter(2);
    const t0 = 1_000_000;
    expect(limiter.allow(t0)).toBe(true);
    expect(limiter.allow(t0 + 1)).toBe(true);
    expect(limiter.allow(t0 + 2)).toBe(false);
    expect(limiter.suppressed).toBe(1);
    expect(limiter.allow(t0 + 61_000)).toBe(true);
  });
});

describe('persistStderrTail', () => {
  function writeOne(dir: string, exitCode: number | null, text: string, second: number): string | null {
    const tail = new StderrTail(4096);
    tail.append(text);
    return persistStderrTail({ logDir: dir, tail, exitCode, keepClean: 5, keepCrash: 5, nowMs: Date.UTC(2026, 6, 31, 12, 0, second) });
  }

  it('rotates clean and crash tails on SEPARATE budgets — clean exits never evict crash evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-tail-'));
    writeOne(dir, 1, 'crash output A', 0);
    writeOne(dir, null, 'crash output B (verify path, unknown code)', 1);
    for (let i = 0; i < 9; i++) writeOne(dir, 0, `clean output ${i}`, 2 + i);
    const files = fs.readdirSync(dir).sort();
    const clean = files.filter((f) => f.endsWith('-exit-0.log'));
    const crash = files.filter((f) => !f.endsWith('-exit-0.log'));
    expect(clean).toHaveLength(5); // newest 5 clean kept
    expect(crash).toHaveLength(2); // BOTH crash tails survive 9 clean exits
    expect(crash.some((f) => f.endsWith('-exit-unknown.log'))).toBe(true); // never '-exit-null'
    expect(fs.readFileSync(path.join(dir, crash[0]), 'utf8')).toContain('crash output A');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates crash tails down to keepCrash among themselves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-tail-'));
    for (let i = 0; i < 7; i++) writeOne(dir, 1, `crash output ${i}`, i);
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(5);
    expect(fs.readFileSync(path.join(dir, files.at(-1)!), 'utf8')).toContain('crash output 6');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flushes the final unterminated carry line into the persisted tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-tail-'));
    const tail = new StderrTail(4096);
    tail.append('complete line');
    const file = persistStderrTail({ logDir: dir, tail, carry: 'FATAL: last words with no newline', exitCode: 1 });
    expect(fs.readFileSync(file!, 'utf8')).toContain('FATAL: last words with no newline');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never throws and returns null for an empty tail+carry or unwritable dir', () => {
    expect(
      persistStderrTail({ logDir: '/nonexistent/no-perms/x', tail: new StderrTail(64), exitCode: 0 }),
    ).toBeNull();
  });
});

describe('truncateForLog', () => {
  it('truncates long lines with a marker', () => {
    expect(truncateForLog('x'.repeat(3000), 2000)).toHaveLength(2000 + '…[truncated 1000 chars]'.length);
    expect(truncateForLog('short')).toBe('short');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/container-stderr.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `src/container-stderr.ts`**

```ts
/**
 * R6: container stderr capture. Containers run with --rm, so the live stderr
 * stream is the ONLY copy of the agent-runner's crash output; before this
 * module it was logged at debug (below the prod threshold) and lost forever.
 * Pure helpers — no container-runner imports — so they unit-test without the
 * spawn harness.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Split a stderr chunk into complete lines, carrying partial tails across chunks. */
export function splitStderrChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split('\n');
  const nextCarry = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.length > 0), carry: nextCarry };
}

const POLL_LOOP_PREFIX = '[poll-loop] ';

/** Parse a structured agent-runner event line (bare JSON or '[poll-loop] '-prefixed). */
export function parseStructuredStderrEvent(line: string): Record<string, unknown> | null {
  const candidate = line.startsWith(POLL_LOOP_PREFIX) ? line.slice(POLL_LOOP_PREFIX.length) : line;
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { event?: unknown }).event === 'string') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Byte-capped rolling tail of stderr lines (drops oldest first). */
export class StderrTail {
  private lines: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  append(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line, 'utf8') + 1;
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const dropped = this.lines.shift()!;
      this.bytes -= Buffer.byteLength(dropped, 'utf8') + 1;
    }
  }
  contents(): string {
    return this.lines.join('\n');
  }
}

/** Fixed-window limiter: at most maxPerMinute allows per minute window. */
export class MinuteRateLimiter {
  private windowStartMs = 0;
  private count = 0;
  suppressed = 0;
  constructor(private readonly maxPerMinute: number) {}
  allow(nowMs: number): boolean {
    if (nowMs - this.windowStartMs >= 60_000) {
      this.windowStartMs = nowMs;
      this.count = 0;
    }
    if (this.count < this.maxPerMinute) {
      this.count += 1;
      return true;
    }
    this.suppressed += 1;
    return false;
  }
}

export function truncateForLog(line: string, max = 2000): string {
  return line.length <= max ? line : `${line.slice(0, max)}…[truncated ${line.length - max} chars]`;
}

/**
 * Persist a stderr tail into the HOST-OWNED per-session log dir (a sibling
 * tree outside the agent-writable workspace — see containerLogsDir; the
 * hostCorrelationDir precedent). Never write these files into /workspace:
 * the agent could forge or symlink-redirect its own crash evidence.
 *
 * Flushes the final unterminated `carry` line first (a crash's last line
 * often lacks a trailing newline — plausibly the most important line).
 * Labels a null exit code 'unknown' (verified stop), never 'null'.
 * Rotation is crash-privileged: clean tails (-exit-0.log) and crash tails
 * (everything else) rotate on SEPARATE budgets, so routine clean exits can
 * never evict crash evidence. Best-effort: returns the written path or
 * null; NEVER throws (post-mortem capture must not break container teardown).
 */
export function persistStderrTail(opts: {
  logDir: string;
  tail: StderrTail;
  carry?: string;
  exitCode: number | null;
  keepClean?: number;
  keepCrash?: number;
  nowMs?: number;
}): string | null {
  try {
    if (opts.carry) opts.tail.append(opts.carry);
    const contents = opts.tail.contents();
    if (!contents) return null;
    fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(opts.nowMs ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(opts.logDir, `${stamp}-exit-${opts.exitCode ?? 'unknown'}.log`);
    fs.writeFileSync(file, `${contents}\n`);
    const isClean = (f: string): boolean => f.endsWith('-exit-0.log');
    const entries = fs
      .readdirSync(opts.logDir)
      .filter((f) => f.endsWith('.log'))
      .sort();
    const prune = (names: string[], keep: number): void => {
      for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
        fs.rmSync(path.join(opts.logDir, stale), { force: true });
      }
    };
    prune(entries.filter(isClean), opts.keepClean ?? 5);
    prune(entries.filter((f) => !isClean(f)), opts.keepCrash ?? 5);
    return file;
  } catch {
    return null;
  }
}
```

Add to `src/session-manager.ts` (next to `hostCorrelationDir`, ~:78-80):

```ts
/** R6: host-owned per-session container stderr tails — OUTSIDE the agent-writable session tree, never mounted. */
export function containerLogsDir(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-container-logs', agentGroupId, sessionId);
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm exec vitest run src/container-stderr.test.ts`
Expected: PASS.

- [ ] **Step 5: Integrate into `src/container-runner.ts`**

Add consts near the file's other config reads:

```ts
/** R6: byte cap for the per-container stderr tail persisted on exit. */
export const CONTAINER_STDERR_TAIL_BYTES = (Number(process.env.NANOCLAW_CONTAINER_STDERR_TAIL_KB) || 64) * 1024;
export const CONTAINER_STDERR_EVENTS_PER_MIN = Number(process.env.NANOCLAW_CONTAINER_STDERR_EVENTS_PER_MIN) || 30;
/** Clean-exit (-exit-0) tails kept per session. */
export const CONTAINER_STDERR_KEEP_FILES = Number(process.env.NANOCLAW_CONTAINER_STDERR_KEEP_FILES) || 5;
/** Crash tails (nonzero/unknown exit) kept per session — rotated SEPARATELY so clean exits never evict crash evidence. */
export const CONTAINER_STDERR_KEEP_CRASH_FILES = Number(process.env.NANOCLAW_CONTAINER_STDERR_KEEP_CRASH_FILES) || 5;
```

Extend the `ActiveContainer` interface (~:95) with:

```ts
  agentGroupId: string;
  stderrTail: StderrTail;
  stderrEventLimiter: MinuteRateLimiter;
  /** Mutable holder for the final unterminated stderr line (flushed at persist time). */
  stderrState: { carry: string };
  /** Real exit code recorded by the 'close' handler — the verify path finalizes with code=null. */
  observedExitCode?: number | null;
```

and initialize them where the `ActiveContainer` object is constructed in `spawnContainer` (`agentGroup` is in scope there):

```ts
  agentGroupId: agentGroup.id,
  stderrTail: new StderrTail(CONTAINER_STDERR_TAIL_BYTES),
  stderrEventLimiter: new MinuteRateLimiter(CONTAINER_STDERR_EVENTS_PER_MIN),
  stderrState: { carry: '' },
```

Replace the stderr handler (~:413-421 — currently `for (const line of data.toString().trim().split('\n')) { if (line) log.debug(...) }`). If the handler is attached before the `ActiveContainer` object exists, create the tail/limiter/state as locals first and reference the SAME instances from the `ActiveContainer` initializer (the shared `stderrState` object is what lets finalize flush the last partial line):

```ts
  const stderrState = { carry: '' };
  container.stderr?.on('data', (data) => {
    const { lines, carry } = splitStderrChunk(stderrState.carry, data.toString());
    stderrState.carry = carry;
    for (const line of lines) {
      stderrTail.append(line);
      const event = parseStructuredStderrEvent(line);
      if (event) {
        // R6: structured agent-runner failure events must be visible in prod
        // (debug is below the default log threshold) — rate-limited so a
        // crash-looping container cannot flood the host log.
        if (stderrEventLimiter.allow(Date.now())) {
          log.info('Container event', {
            container: agentGroup.folder,
            severity: (event as { severity?: unknown }).severity ?? null,
            line: truncateForLog(line),
          });
        }
      } else {
        log.debug(line, { container: agentGroup.folder });
      }
    }
  });
```

Record the real exit code where the `close` handler calls into finalization (~:428-439): set `current.observedExitCode = code` before invoking `finalizeContainerProcess` — the verify path (`verifyContainerProcessExited`, ~:727-748) finalizes with `code = null`, and a verified stop must not be stamped as `-exit-null`.

In `finalizeVerifiedContainerStop` (~:490-527 — has `sessionId`, `code`, and the `ActiveContainer` as `current`; match the local variable name), the placement is PINNED: immediately AFTER the second `activeContainers.get(sessionId) !== current` recheck (~:524) and BEFORE `activeMcpBridges.delete(sessionId)` (~:526). The function has FOUR early `return false` exits before that point (no daemon-stop proof ~:496-503, owner mismatch ~:504, revocation failure ~:520-523, second mismatch ~:524); each failed attempt retains the `ActiveContainer` (and its in-memory tail) and finalization is retried, so this placement persists EXACTLY ONE tail per successful finalization — a top-of-function placement would write a new file per retry and rotate genuine crash tails away (validator-V8). Add there:

```ts
  // R6: containers are --rm; this tail is the only surviving copy of stderr.
  // Placement pinned after the last early return: exactly one file per
  // successful finalization, no retry-driven rotation pressure.
  const exitCode = code ?? current.observedExitCode ?? null; // null persists as '-exit-unknown'
  const persisted = persistStderrTail({
    logDir: containerLogsDir(current.agentGroupId, sessionId),
    tail: current.stderrTail,
    carry: current.stderrState.carry, // flush the final unterminated line
    exitCode,
    keepClean: CONTAINER_STDERR_KEEP_FILES,
    keepCrash: CONTAINER_STDERR_KEEP_CRASH_FILES,
  });
  current.stderrState.carry = '';
  if (persisted) {
    log.info('Persisted container stderr tail', { sessionId, exitCode, file: persisted });
  }
```

Import `containerLogsDir` from `./session-manager.js` and the helpers from `./container-stderr.js`. Do NOT write anything under `sessionDir(…)`/`/workspace` — no mkdir, write, or rm in agent-owned paths (symlink-redirect hazard; the repo's `O_NOFOLLOW` discipline in `session-manager.ts:331-351` exists for exactly this reason).

- [ ] **Step 6: Write the integration test**

In `src/container-runner.test.ts`, using the existing `loadContainerRunnerHarness` (~:92) + `fakeChildProcess()` (~:62) machinery (the harness mocks `child_process`, `config.js`, `host-sweep.js`; follow `describe('session wake lifecycle')` at ~:778 for how a container is spawned and its fake process driven):

```ts
describe('container stderr capture (R6)', () => {
  it('logs structured events at info, survives chunk splits, flushes the last partial line, and persists the tail on exit', async () => {
    // Arrange: spawn a session container via the harness (copy the wake
    // fixture from the lifecycle suite), grab the fake child process.
    child.stderr.emit('data', Buffer.from('{"severity":"error","ev'));
    child.stderr.emit('data', Buffer.from('ent":"fatal_error","error":"boom"}\nplain noise\nFATAL last words'));
    // (note: 'FATAL last words' has NO trailing newline — it exercises the carry flush)
    // Assert the structured event was logged at info with the reassembled line.
    // (Spy on log.info via the harness's mocked log module, or capture stdout —
    // match how neighboring tests assert log output.)

    // Act: drive the fake process exit the same way the lifecycle tests do
    // (emit 'close' with code 1 and let finalization run).

    // Assert: the tail file exists in the HOST-SIDE log tree — NOT under
    // v2-sessions (nothing may be written into the agent-writable workspace).
    const dir = path.join(DATA_DIR, 'v2-container-logs', 'ag-1', sessionId);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const contents = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(contents).toContain('"event":"fatal_error"');
    expect(contents).toContain('plain noise');
    expect(contents).toContain('FATAL last words'); // carry flushed at persist time
    expect(files[0]).toContain('-exit-1');
    // Negative: the agent-writable session dir got NOTHING new.
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', 'ag-1', sessionId, '.nanoclaw'))).toBe(false);
  });
});
```

Fill the arrange/act sections by copying the closest existing lifecycle test in the file — the harness owns spawn wiring, DATA_DIR, and exit finalization; this test only adds stderr emissions and the file assertions. The exit path must reach `finalizeVerifiedContainerStop` (the lifecycle suite already exercises it) — and because the persist is pinned after the LAST early return, the harness fixture must let finalization SUCCEED (daemon-stop proof + revocation), same as the passing lifecycle tests.

- [ ] **Step 7: Run the suites**

Run: `pnpm exec vitest run src/container-stderr.test.ts src/container-runner.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/container-stderr.ts src/container-stderr.test.ts src/container-runner.ts src/container-runner.test.ts src/session-manager.ts
git commit -m "feat(container): surface structured stderr events and persist crash-privileged stderr tails host-side (R6)"
```


---

### Task 6: R8 — reconciliation validation blast radius + sanitization

One GWS reconciliation record with an em dash (U+2014) in `search_hints[0]` blocked `recoverGwsClaimPartitions` for EVERY session host-wide for 4 days, because the reader validates the whole shared JSONL store before any scope filtering. Rework (Dan's decision): (i) ADVISORY fields are sanitized on read, never a validation failure; (ii) LOAD-BEARING fields keep strict validation but a failing record is QUARANTINED individually — fail-closed for that record's `input_id` only, with a loud error incident; (iii) whole-file fail-closed remains ONLY for file-level corruption (unparseable JSON, truncated tail, missing store).

Field classification (from the reader at `src/db/session-db.ts:917-1094`):
- IDENTITY (fail-closed at FILE level, validator-V7 / A12): an INCIDENT record's `input_id`. If it is missing, non-string, or fails `canonicalAscii(·, 512)`, the record structurally cannot contribute to `blockedInputIds` — quarantining it would let recovery re-run a GWS-uncertain input (a regression vs today's whole-file fail-closed). Unreadable identity is therefore FILE-level fatal, the same class as unparseable JSON. (Resolution-record identity corruption stays quarantine-safe: its incident remains unresolved and the retained missing-resolution throw backstops it — V7 cases 8-10.)
- LOAD-BEARING (strict `canonicalAscii`/timestamp validation, quarantine on failure): `schema_version`, `record_type`, `audit_id`, `account`, `route_key`, `operation`, `started_at`, `ended_at`, `disposition`, `resolved_at`; unknown fields and duplicate `audit_id` also quarantine (same fail-closed class, now scoped).
- ADVISORY (sanitize via transliteration, never fail): `outcome`, `resource_type`, `search_hints` elements, resolution `operator` and `note`. `search_hints` is validated-then-discarded today (never emitted) — absence/non-array is tolerated as `[]`. `operator`/`note`/`outcome`/`resource_type` must still be present strings (structural absence = uncertainty = quarantine), but their CONTENT can never fail.
- Already-unvalidated allow-listed fields (`account_label`, `account_email`, `service`, `method`, `requested_title`, `parent`, `workspace`, `returned_id`, `profile`, `payload`, `signature`) stay as they are.

Blast-radius semantics after this task: a malformed record belonging to ANOTHER session's input quarantines quietly (error incident, everything else proceeds). A malformed record matching one of THIS session's in-flight accepted inputs blocks THIS session's recovery only (claims stay `processing`, no reset, no wake — identical safety to today's freeze, because waking would let container startup clear the processing acks and re-run a GWS-uncertain input). "Matching" presumes the identity field survives — which is exactly why an incident with UNREADABLE `input_id` cannot be scoped and stays FILE-level fatal (whole store rejected, all sessions blocked — the correct narrow residue of today's behavior). The missing-resolution throw (`requires manual reconciliation before accepted input … can resume`) keeps its existing per-scope throw semantics.

**Files:**
- Modify: `src/db/session-db.ts` (`transliterateToAscii`; reader rename + rework at ~:917-1094)
- Modify: `src/host-sweep.ts` (`recoverGwsClaimPartitions` ~:1267-1342; its caller inside `recoverAfterKill` ~:1352-1420)
- Modify: `src/yente/operator-gws-session.ts` (~:213-216)
- Test: `src/db/session-db.test.ts`, `src/host-sweep.test.ts` (reconciliation suites at ~:1071-1292), `src/yente/operator-gws-session.test.ts` (only if its call site assertion changes)

**Interfaces:**
- Consumes: existing `GwsManualReconciliation` (session-db.ts:897-908), `StrictGwsSideEffectScope` (:419-424), `reportSchedulerIncident`.
- Produces:
  - `export function transliterateToAscii(value: string, maximum: number): string` (session-db.ts)
  - `export interface QuarantinedGwsReconciliationRecord { lineNumber: number; auditId: string | null; inputId: string | null; reason: string; }`
  - `export interface GwsReconciliationReadResult { reconciliations: GwsManualReconciliation[]; quarantined: QuarantinedGwsReconciliationRecord[]; }`
  - `export function readGwsReconciliationRecords(opts: { reconciliationStorePath: string | undefined; scopes: StrictGwsSideEffectScope[] }): GwsReconciliationReadResult` — replaces `assertNoUnresolvedGwsReconciliationRecords` (rename; update both call sites and all test imports).
  - `recoverGwsClaimPartitions` return type gains `quarantinedReconciliation: QuarantinedGwsReconciliationRecord[]; blockedInputIds: string[];`

- [ ] **Step 1: Write the failing tests**

In `src/db/session-db.test.ts`:

```ts
describe('transliterateToAscii', () => {
  it('maps common unicode punctuation, replaces the rest, trims, and caps AFTER substitution', () => {
    expect(transliterateToAscii('inspect — do not retry', 2048)).toBe('inspect - do not retry');
    expect(transliterateToAscii('“smart” ‘quotes’ and… more', 2048)).toBe(`"smart" 'quotes' and... more`);
    expect(transliterateToAscii('日本語', 2048)).toBe('???');
    expect(transliterateToAscii('\u00A0', 2048)).toBe('?'); // whitespace-only input never returns empty
    expect(transliterateToAscii('ab…', 4)).toBe('ab..'); // cap applied after '…' -> '...' expansion
  });
});
```

In `src/host-sweep.test.ts`, extend the reconciliation suites. Reuse the canonical happy-path fixture from the `accepts one exact durable %s resolution…` test (~:1182-1243: inline incident object ~:1186-1206, resolution ~:1207-1217, hand-built `scopes` ~:1223-1230, written to a temp store file with a trailing `\n`); only the deltas are shown here — copy the fixture objects verbatim from that test:

```ts
it('sanitizes non-ASCII advisory hint text instead of failing the store (the dvora em-dash incident)', () => {
  // Same incident+resolution fixture as the happy-path test, EXCEPT:
  //   incident.search_hints = ['inspect Google directly — do not retry']   (em dash, U+2014)
  //   resolution.note = 'resolved — see thread'                            (em dash)
  const { reconciliations, quarantined } = readGwsReconciliationRecords({ reconciliationStorePath, scopes });
  expect(quarantined).toEqual([]);
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0].note).toBe('resolved - see thread');
});

it('quarantines an out-of-scope record with a load-bearing failure without blocking in-scope recovery', () => {
  // Store: line 1 = the happy-path in-scope incident; line 2 = its resolution;
  // line 3 = a second incident, valid EXCEPT audit_id contains 'é' (non-ASCII,
  // load-bearing) and input_id 'other-input' not in scopes.
  const { reconciliations, quarantined } = readGwsReconciliationRecords({ reconciliationStorePath, scopes });
  expect(reconciliations).toHaveLength(1); // in-scope work proceeds
  expect(quarantined).toHaveLength(1);
  expect(quarantined[0]).toMatchObject({ inputId: 'other-input', reason: expect.stringContaining('malformed') });
});

it('quarantines an unknown-field record instead of halting all recovery host-wide', () => {
  // Happy-path fixture + an extra field `tenant: 'x'` on an out-of-scope incident.
  const { reconciliations, quarantined } = readGwsReconciliationRecords({ reconciliationStorePath, scopes });
  expect(reconciliations).toHaveLength(1);
  expect(quarantined[0].reason).toContain('unknown field');
});

// A12 fail-closed (validator-V7): identity corruption on an INCIDENT record
// must be FILE-level fatal — a quarantined-and-skipped record with unreadable
// input_id structurally cannot contribute to blockedInputIds, so recovery
// would re-run a GWS-uncertain input.
it.each([
  ['non-ASCII byte in input_id', (incident: Record<string, unknown>) => { incident.input_id = 'input-\u00e91'; }],
  ['missing input_id', (incident: Record<string, unknown>) => { delete incident.input_id; }],
  ['non-string input_id', (incident: Record<string, unknown>) => { incident.input_id = 42; }],
])('fails the whole store closed on an incident with unreadable identity: %s', (_name, mutate) => {
  // Happy-path incident fixture with `mutate(incident)` applied, written to the store.
  expect(() => readGwsReconciliationRecords({ reconciliationStorePath, scopes })).toThrow(/identity|input_id/i);
});

it('fails the whole store closed on non-UTF8 bytes inside input_id', () => {
  // Write the incident line with raw bytes: replace a byte of the input_id value
  // with 0xFF via Buffer surgery before writeFileSync. readFileSync(..., 'utf8')
  // turns it into U+FFFD, which fails canonicalAscii -> unreadable identity.
  expect(() => readGwsReconciliationRecords({ reconciliationStorePath, scopes })).toThrow(/identity|input_id/i);
});

it('fails the whole store closed on an unknown-record_type record with unreadable input_id', () => {
  // Out-of-scope record with record_type 'resoluti\u00f8n' AND input_id deleted —
  // it could be a corrupted INCIDENT; quarantining it would drop it from
  // blockedInputIds, so identity must be readable before any quarantine.
  expect(() => readGwsReconciliationRecords({ reconciliationStorePath, scopes })).toThrow(/identity|input_id/i);
});

it('keeps quarantine (not file-fatal) for corrupted record_type or mangled audit_id with INTACT input_id', () => {
  // Two out-of-scope records: one with record_type 'resoluti\u00f8n' + intact ids,
  // one incident with audit_id 'a-\u00e9' + intact input_id 'other-input'.
  const { reconciliations, quarantined } = readGwsReconciliationRecords({ reconciliationStorePath, scopes });
  expect(reconciliations).toHaveLength(1); // in-scope work proceeds
  expect(quarantined.length).toBeGreaterThanOrEqual(2);
  expect(quarantined.every((q) => typeof q.inputId === 'string' || q.reason.includes('resolution'))).toBe(true);
});
```

Update the existing table-driven suites in place:
- `keeps an interrupted turn blocked when the reconciliation evidence is %s` (~:1071-1101, cases missing/truncated/malformed): these are FILE-level and must keep throwing — only rename the imported function and destructure nothing (the call still throws before returning).
- `fails closed on malformed manual reconciliation: %s` (~:1245-1292, cases 'resolution before incident', 'wrong exact binding'): under the reworked reader these two cases DIVERGE, so the shared `.toThrow(/reconciliation|resolution|incident|binding/i)` assertion (~:1291) cannot survive as an it.each — split the table into two plain `it` blocks (keep the existing fixtures verbatim):
  - **'resolution before incident'** (store contains ONLY the malformed resolution `{schema_version: 2, record_type: 'resolution', audit_id: 'a'}` — no incident line at all): this becomes a RECORD-level quarantine with an empty `incidents` map, so the scope pass has nothing to throw about and the reader RETURNS. Replace its throw assertion with:

```ts
  const { reconciliations, quarantined } = readGwsReconciliationRecords({ reconciliationStorePath, scopes });
  expect(reconciliations).toEqual([]);
  expect(quarantined).toHaveLength(1);
  expect(quarantined[0].reason).toMatch(/resolution/i);
```

  - **'wrong exact binding'** (store contains a VALID incident whose `input_id` `'in-strict'` IS in `scopes`, plus a resolution bound to `input_id` `'other-input'`): KEEP this as a throw test. The mis-bound resolution is quarantined at record level, but the incident passes every record-level check and is accepted into `incidents`; the scope pass — whose `requires manual reconciliation` throw Step 3 explicitly KEEPS — then throws because the in-scope, complete incident has no accepted resolution. Only rename the imported function, and TIGHTEN the matcher to `/requires manual reconciliation/i` so the test can no longer pass via the removed record-level throw:

```ts
  expect(() => readGwsReconciliationRecords({ reconciliationStorePath, scopes })).toThrow(/requires manual reconciliation/i);
```

  …and note the scope-side effect: if the quarantined record's `input_id` matches a scope, `recoverGwsClaimPartitions` must block (covered next).

Add a direct test for the partition gate (arrange claims/scopes with whatever minimal fixture the surrounding `recoverGwsClaimPartitions` tests use — see the `recovers accepted partitions while returning a genuinely unaccepted crash-window claim to pending` test at ~:1665 for the on-disk `setupSession()` fixture):

```ts
it('blocks ONLY the session whose accepted input has a quarantined record (fail-closed per input_id)', () => {
  // Arrange: setupSession() with one accepted in-flight claim whose scope
  // inputId is 'input-1'; reconciliation store contains a single incident for
  // input_id 'input-1' whose audit_id is non-ASCII (load-bearing failure).
  const result = recoverGwsClaimPartitions({ /* same opts as the :1665 test, with this store */ });
  expect(result.recoveryIds).toEqual([]);
  expect(result.blockedInputIds).toEqual(['input-1']);
  expect(result.quarantinedReconciliation).toHaveLength(1);
  // Claims untouched: still processing, ready for a fixed store on a later sweep.
  const acks = outDb.prepare("SELECT status FROM processing_ack").all();
  expect(acks.every((a: { status: string }) => a.status === 'processing')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/host-sweep.test.ts src/db/session-db.test.ts -t 'reconcil'` (plus `-t 'transliterate'`)
Expected: FAIL (`readGwsReconciliationRecords` missing; transliterate missing).

- [ ] **Step 3: Implement in `src/db/session-db.ts`**

Add the sanitizer:

```ts
const ASCII_SUBSTITUTIONS: Record<string, string> = {
  '\u2014': '-', // em dash — the dvora incident byte
  '\u2013': '-',
  '\u2012': '-',
  '\u2011': '-',
  '\u2010': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u2032': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u2033': '"',
  '\u2026': '...',
  '\u00A0': ' ',
  '\u200B': '',
  '\uFEFF': '',
};

/**
 * R8: advisory-field sanitizer. Transliterates common Unicode punctuation to
 * ASCII, replaces every other non-printable-ASCII code point with '?', trims,
 * enforces the length cap AFTER substitution ('…' expands to '...'), and never
 * returns an empty string. Advisory hint text must never fail validation.
 */
export function transliterateToAscii(value: string, maximum: number): string {
  let out = '';
  for (const ch of value) {
    if (ch >= '\x20' && ch <= '\x7e') {
      out += ch;
      continue;
    }
    out += ASCII_SUBSTITUTIONS[ch] ?? '?';
  }
  out = out.trim();
  if (out.length === 0) out = '?';
  return out.slice(0, maximum);
}
```

Add the result types:

```ts
export interface QuarantinedGwsReconciliationRecord {
  lineNumber: number; // 1-based line in the store file
  auditId: string | null;
  inputId: string | null;
  reason: string;
}

export interface GwsReconciliationReadResult {
  reconciliations: GwsManualReconciliation[];
  quarantined: QuarantinedGwsReconciliationRecord[];
}
```

Rename `assertNoUnresolvedGwsReconciliationRecords` → `readGwsReconciliationRecords`, return type `GwsReconciliationReadResult`, and rework the parse loop. Keep UNCHANGED: the missing-path throw, the truncated-tail throw, the per-line `JSON.parse` throw and non-object throw (file-level corruption), `canonicalAscii`, `canonicalTimestamp`, the allow-list sets. NEW file-level throw (A12): any record that could be an incident — an incident-branch record OR an unknown-`record_type` record — with unreadable identity (`input_id` failing `canonicalAscii`) — same class as unparseable JSON. This identity check MUST run BEFORE every quarantine path that could swallow an incident (see both branches below). Restructure the rest of the loop (currently :972-1036) as follows — a line counter and quarantine helper first (the `inputId: string | null` tolerance in the helper exists for RESOLUTION records only; incidents with unreadable identity never reach `quarantine`):

```ts
  const quarantined: QuarantinedGwsReconciliationRecord[] = [];
  const quarantinedAuditIds = new Set<string>();
  const quarantine = (lineNumber: number, record: Record<string, unknown>, reason: string): void => {
    const auditId = typeof record.audit_id === 'string' ? record.audit_id : null;
    const inputId = typeof record.input_id === 'string' ? record.input_id : null;
    if (auditId) quarantinedAuditIds.add(auditId);
    quarantined.push({ lineNumber, auditId, inputId, reason });
  };
```

Resolution branch (every former `throw` that is record-shaped becomes `quarantine(...); continue;`):

```ts
    if (entry.record_type === 'resolution') {
      const resolution = entry as GwsReconciliationResolutionEntry;
      if (Object.keys(resolution).some((key) => !resolutionFields.has(key))) {
        quarantine(lineNumber, resolution as Record<string, unknown>, 'resolution contains an unknown field');
        continue;
      }
      // ADVISORY content: operator/note are human text — sanitize, never reject
      // their content. Structural absence is still uncertainty -> quarantine.
      if (typeof resolution.operator !== 'string' || resolution.operator.length === 0 ||
          typeof resolution.note !== 'string' || resolution.note.length === 0) {
        quarantine(lineNumber, resolution as Record<string, unknown>, 'resolution operator/note missing');
        continue;
      }
      resolution.operator = transliterateToAscii(resolution.operator, 256);
      resolution.note = transliterateToAscii(resolution.note, 2048);
      const incident = typeof resolution.audit_id === 'string' ? incidents.get(resolution.audit_id) : undefined;
      const resolvedMs = typeof resolution.resolved_at === 'string' ? Date.parse(resolution.resolved_at) : NaN;
      const endedMs = typeof incident?.ended_at === 'string' ? Date.parse(incident.ended_at) : NaN;
      if (
        resolution.schema_version !== 2 ||
        !incident ||
        resolutions.has(resolution.audit_id!) ||
        resolution.input_id !== incident.input_id ||
        resolution.route_key !== incident.route_key ||
        (resolution.disposition !== 'completed' && resolution.disposition !== 'not_completed') ||
        !canonicalTimestamp(resolution.resolved_at) ||
        !Number.isFinite(endedMs) ||
        resolvedMs < endedMs
      ) {
        quarantine(
          lineNumber,
          resolution as Record<string, unknown>,
          typeof resolution.audit_id === 'string' && quarantinedAuditIds.has(resolution.audit_id)
            ? 'resolution references a quarantined incident'
            : 'resolution is malformed or outside its exact incident binding',
        );
        continue;
      }
      resolutions.set(resolution.audit_id!, resolution);
      continue;
    }
    if (entry.record_type !== undefined) {
      // A12: an unknown record_type could be a corrupted INCIDENT. Quarantining
      // it with unreadable identity would drop it from blockedInputIds — so
      // identity must be readable BEFORE this quarantine is allowed.
      if (!canonicalAscii((entry as Record<string, unknown>).input_id, 512)) {
        throw new Error(
          `GWS reconciliation store line ${lineNumber}: unknown record_type with missing or unreadable input_id — failing closed`,
        );
      }
      quarantine(lineNumber, entry as Record<string, unknown>, 'unknown record type');
      continue;
    }
```

Incident branch:

```ts
    const incident = entry as GwsReconciliationStoreEntry;
    // IDENTITY validation FIRST — before ANY quarantine path in this branch —
    // FILE-level fatal, NOT quarantine (A12, validator-V7): an incident whose
    // input_id is unreadable structurally cannot contribute to
    // blockedInputIds; quarantining it (e.g. as 'unknown field' when mojibake
    // mangles field names and values together) would let recovery re-run a
    // GWS-uncertain input. Same class as unparseable JSON.
    if (!canonicalAscii(incident.input_id, 512)) {
      throw new Error(
        `GWS reconciliation store line ${lineNumber}: incident identity (input_id) is missing or unreadable — failing closed`,
      );
    }
    if (Object.keys(incident).some((key) => !incidentFields.has(key))) {
      quarantine(lineNumber, incident as Record<string, unknown>, 'incident contains an unknown field');
      continue;
    }
    // ADVISORY sanitization: hint text must never fail validation.
    if (typeof incident.outcome === 'string') incident.outcome = transliterateToAscii(incident.outcome, 256);
    if (typeof incident.resource_type === 'string') {
      incident.resource_type = transliterateToAscii(incident.resource_type, 512);
    }
    incident.search_hints = Array.isArray(incident.search_hints)
      ? incident.search_hints
          .filter((hint): hint is string => typeof hint === 'string')
          .map((hint) => transliterateToAscii(hint, 2048))
      : []; // hints are never consumed downstream; absence is tolerated
    // LOAD-BEARING validation: failure quarantines THIS record only (its
    // readable input_id still blocks the matching scope via the caller gate).
    if (
      incident.schema_version !== 2 ||
      !canonicalAscii(incident.audit_id, 256) ||
      incidents.has(incident.audit_id!) ||
      typeof incident.outcome !== 'string' ||
      incident.outcome.length === 0 ||
      typeof incident.resource_type !== 'string' ||
      incident.resource_type.length === 0 ||
      !canonicalAscii(incident.account, 512) ||
      !canonicalAscii(incident.route_key, 512) ||
      !canonicalAscii(incident.operation, 512) ||
      !canonicalTimestamp(incident.started_at) ||
      !canonicalTimestamp(incident.ended_at) ||
      Date.parse(incident.ended_at!) < Date.parse(incident.started_at!)
    ) {
      quarantine(lineNumber, incident as Record<string, unknown>, 'incident is malformed or incomplete');
      continue;
    }
    incidents.set(incident.audit_id!, incident);
```

Scope pass (:1038-1094): keep both throws (`malformed or outside its exact scope`, `requires manual reconciliation`) — they are per-THIS-session semantics — but REMOVE the two `search_hints` conditions from the completeness check (advisory). Return `{ reconciliations: accepted, quarantined }`.

Type touch-ups: `GwsReconciliationStoreEntry.search_hints` is `unknown` — the sanitized reassignment above is legal; if the interface fights the narrowing, adjust it to `search_hints?: unknown` -> `string[] | unknown` narrowing via a local variable instead of mutating.

- [ ] **Step 4: Update the callers**

`src/host-sweep.ts` `recoverGwsClaimPartitions` (~:1267-1342): change the return type to `{ recoveryIds: string[]; returnedUnacceptedClaimIds: string[]; quarantinedReconciliation: QuarantinedGwsReconciliationRecord[]; blockedInputIds: string[] }` (fill `[]` at the existing early returns). Replace the gate at ~:1301-1304 with:

```ts
    const { reconciliations: manualReconciliations, quarantined } = readGwsReconciliationRecords({
      reconciliationStorePath: opts.reconciliationStorePath,
      scopes,
    });
    const quarantinedInputIds = new Set(
      quarantined.map((q) => q.inputId).filter((v): v is string => typeof v === 'string'),
    );
    const blockedInputIds = plan.partitions
      .map((partition) => partition.scope.inputId)
      .filter((inputId) => quarantinedInputIds.has(inputId));
    if (blockedInputIds.length > 0) {
      // R8 fail-closed per input_id: THIS session's recovery stops (claims stay
      // processing, no reset, no wake — waking would let container startup
      // clear the acks and re-run a GWS-uncertain input). Other sessions are
      // unaffected. The caller records the loud incidents.
      return { recoveryIds: [], returnedUnacceptedClaimIds, quarantinedReconciliation: quarantined, blockedInputIds };
    }
```

…and thread `quarantinedReconciliation: quarantined, blockedInputIds: []` through the normal-path return.

In `recoverAfterKill` (~:1352-1420), at the `recoverGwsClaimPartitions` call site inside its recovery pass: capture the result; for EVERY entry of `result.quarantinedReconciliation` record a loud incident (permanent dedupe means repeats are free):

```ts
      for (const q of result.quarantinedReconciliation) {
        log.error('Quarantined GWS reconciliation record', { sessionId: session.id, ...q });
        await reportSchedulerIncident({
          dedupeKey: `gws-reconciliation-quarantine:${q.auditId ?? `line-${q.lineNumber}`}`,
          severity: 'error',
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
          message: `GWS reconciliation record quarantined (${q.reason}); ${
            q.inputId
              ? `input ${q.inputId} is blocked from recovery`
              : 'resolution-side record — its incident stays unresolved and remains blocked'
          }. Fix the store record to unblock.`,
          details: { reason: 'gws-reconciliation-quarantine', ...q },
        });
      }
      if (result.blockedInputIds.length > 0) {
        log.error('GWS reconciliation quarantine blocks recovery for this session', {
          sessionId: session.id,
          blockedInputIds: result.blockedInputIds,
        });
        return { blocked: true }; // no reset, no wake — see the async restructuring below
      }
```

(With the A12 fail-closed rule, a quarantined record with `inputId === null` can only be a RESOLUTION record — incident identity corruption throws at file level before quarantine — so the message must not claim "no in-flight input affected": the system cannot know that; the unresolved incident keeps its input blocked via the missing-resolution throw.)

**Async restructuring (REQUIRED — A11-N1, validator-V6):** the snippet above cannot be dropped verbatim into the current wiring. `recoverGwsClaimPartitions` is called inside the `writeRecovery: () => {…}` callback (`src/host-sweep.ts` ~:1396-1413), which is SYNCHRONOUS and invoked WITHOUT await at ~:773 (`opts.writeRecovery();` inside `recoverInterruptedTurn`). Placed there verbatim, (a) the `await reportSchedulerIncident(...)` calls become floating promises, and (b) the bare `return` exits only the callback — `clearProviderToolState` + `resetStuckProcessingRows` + the wake (~:777-781) STILL run, the exact opposite of "no reset, no wake". Restructure explicitly:
- Change the `writeRecovery` option type (in `recoverInterruptedTurn` and `recoverInterruptedTurnBounded`'s opts) to `writeRecovery: () => Promise<{ blocked: boolean }>`.
- Make the callback `async`, put the quarantine incident loop + blocked check above INSIDE it, and return `{ blocked: blockedInputIds.length > 0 }`.
- At the invocation site (~:773): `const recovery = await opts.writeRecovery(); if (recovery.blocked) return;` — placed BEFORE `clearProviderToolState`/`resetStuckProcessingRows` and the wake, so a quarantine-blocked session is genuinely not reset and not woken (the enclosing function is already async). Update every other `writeRecovery` provider (tests included) to the new async signature.

`src/yente/operator-gws-session.ts` (~:213-216): destructure the new shape; the operator flow has exactly one scope, so keep its fail-closed posture:

```ts
    const { reconciliations, quarantined } = readGwsReconciliationRecords({ reconciliationStorePath, scopes });
    const blocked = quarantined.filter((q) => scopes.some((s) => s.inputId === q.inputId));
    if (blocked.length > 0) {
      throw new Error(`GWS reconciliation record quarantined for this operator scope: ${blocked[0].reason}`);
    }
```

(and use `reconciliations` wherever the old return value was used). The same identity rule protects this path with no extra code: an incident with unreadable `input_id` makes `readGwsReconciliationRecords` THROW at file level (A12 fix above), so the operator flow fails closed rather than matching `null` against its scope — do NOT add a null-tolerant branch here.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/host-sweep.test.ts src/db/session-db.test.ts src/yente/operator-gws-session.test.ts`
Expected: PASS — including the updated evidence it.each table and the two split malformed-reconciliation tests. The `does not reset or wake after a crash with a durable manual-only outcome` test (~:1103) must still pass unchanged (missing-resolution throw preserved).

- [ ] **Step 6: Commit**

```bash
git add src/db/session-db.ts src/host-sweep.ts src/yente/operator-gws-session.ts src/db/session-db.test.ts src/host-sweep.test.ts src/yente/operator-gws-session.test.ts
git commit -m "fix(gws): sanitize advisory reconciliation fields and quarantine bad records per input (R8)"
```

---

### Task 7: R9a — host-side hot-journal recovery + delivery loop containment

A crashed container leaves a hot `outbound.db-journal`. Session DBs are `journal_mode = DELETE` by invariant, and the host's steady-state opens are read-only — which CANNOT roll a hot journal back: every first statement throws `SQLITE_READONLY_ROLLBACK` ("attempt to write a readonly database"). Nothing classifies that code, so delivery's `pollActive`/`pollSweep` (whose try wraps the whole for-loop) abort the remaining sessions every tick, and the sweep throws at `syncProcessingAcks` before recovery/wake/SLA — a self-sustaining wedge (the only routine RW opener is the container, which only starts if the sweep wakes it). Fix: probe on read-only open; on `SQLITE_READONLY_ROLLBACK` perform ONE gated write-mode open to roll the journal back (loudly logged), then reopen read-only. The guard is EXTRINSIC and host-local, NOT SQLite locking: cross-mount fcntl lock propagation between host and container is unverifiable (validator-V2), so "hot journal ⇒ dead writer" must not be trusted against a possibly-live container writer. The healing RW open therefore runs ONLY where the host has verified the session's container is not running: `sweepSession`'s outbound open, gated on `!isContainerRunning(session.id)` and always before the wake gate (~:501-504). That gated open also covers the post-crash window — a nonzero container exit schedules `scheduleUnexpectedExitRecovery` (`src/container-runner.ts:545,593`) → `recoverSessionAfterUnexpectedExit` → `sweepSession`, so a crashed container's journal is healed on the next sweep, before any wake. The 1s delivery poll NEVER heals inline: on `SQLITE_READONLY_ROLLBACK` it treats the session as transiently contained and defers healing to the gated sweep path. Detection stays keyed on the exact code `SQLITE_READONLY_ROLLBACK` (verified 16/16 trials: the message text is the generic "attempt to write a readonly database", so code-keyed detection is both necessary and correct). Also contain delivery errors per session.

**Files:**
- Modify: `src/db/session-db.ts` (`isHotJournalError`, `openOutboundDbReadOnlyHealing`)
- Modify: `src/session-manager.ts` (`openOutboundDbHealing` wrapper)
- Modify: `src/delivery.ts` (`deliverSessionMessages` catch at ~:163-199 — `drainSession`'s plain read-only open at ~:293 stays as-is: no inline heal)
- Modify: `src/host-sweep.ts` (`sweepSession` outbound open at ~:429-436, gated on `!isContainerRunning`)
- Test: `src/db/session-db.test.ts`, `src/delivery.test.ts`, `src/host-sweep.test.ts` (heal gate)

**Interfaces:**
- Consumes: better-sqlite3 facts — the constructor does NOT read the DB file (a hot journal throws on the FIRST statement, not at open); errors are `SqliteError` with string `.code`; `{ readonly: true }` opens read-only.
- Produces:
  - `export function isHotJournalError(err: unknown): boolean` (session-db.ts) — `.code === 'SQLITE_READONLY_ROLLBACK'`.
  - `export function openOutboundDbReadOnlyHealing(dbPath: string, onHotJournal?: (dbPath: string) => void): Database.Database` (session-db.ts) — pure DB layer; callers supply the logger via callback. SAFETY CONTRACT: the caller must have verified no container writer can be live on this DB.
  - `export function openOutboundDbHealing(agentGroupId: string, sessionId: string): Database.Database` (session-manager.ts) — wrapper that logs `log.error('Hot outbound journal detected; performing gated write-mode rollback', …)` in the callback. Call ONLY from sites that hold the container-not-running guard (the gated sweep open below); never from the delivery poll.

- [ ] **Step 1: Write the failing unit test (with the hot-journal fixture)**

Add to `src/db/session-db.test.ts`. The `plantHotJournal` helper materializes a REAL hot journal: copy the live rollback journal aside mid-transaction (AFTER forcing a journal spill/sync so the header magic is written), commit, then restore the copied journal — the restored journal has a valid header and no owning process, which is precisely SQLite's "hot" condition. The `cache_size = 10` pragma is load-bearing: SQLite writes the 8-byte journal header magic only at SYNC time (commit or cache spill); with the default pager cache a ~1MB write leaves the on-disk journal header ZEROED, and the copied journal is a dud SQLite silently ignores (verified failing 5/5 without the pragma; hot 5/5 with it — validator-V1).

```ts
function plantHotJournal(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  // Tiny pager cache forces a mid-transaction journal spill+sync, which is
  // what writes the journal header magic. Without this the journal FILE
  // exists but its header is zeroed and SQLite ignores it (not hot).
  db.pragma('cache_size = 10');
  db.exec('CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, data BLOB)');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO filler (data) VALUES (?)').run(Buffer.alloc(1024 * 1024));
  const journalPath = `${dbPath}-journal`;
  if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) {
    throw new Error('test setup failed to materialize a rollback journal');
  }
  fs.copyFileSync(journalPath, `${journalPath}.saved`);
  db.exec('COMMIT');
  db.close();
  fs.copyFileSync(`${journalPath}.saved`, journalPath);
  fs.rmSync(`${journalPath}.saved`);
}

describe('openOutboundDbReadOnlyHealing (R9)', () => {
  it('rolls back a hot journal via one guarded write-mode open and reopens read-only', () => {
    freshDir();
    const outDb = outboundDb();
    outDb.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-1', 'completed', datetime('now'))").run();
    outDb.close();
    const dbPath = path.join(TEST_DIR, 'outbound.db');
    plantHotJournal(dbPath);

    // Sanity: this IS the incident failure mode — a plain read-only open cannot read.
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()).toThrow();
    ro.close();

    const onHotJournal = vi.fn();
    const healed = openOutboundDbReadOnlyHealing(dbPath, onHotJournal);
    expect(onHotJournal).toHaveBeenCalledTimes(1);
    expect((healed.prepare('SELECT COUNT(*) AS n FROM processing_ack').get() as { n: number }).n).toBe(1);
    healed.close();
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);

    // Clean DB path: no callback, plain read-only handle.
    const clean = openOutboundDbReadOnlyHealing(dbPath, onHotJournal);
    expect(onHotJournal).toHaveBeenCalledTimes(1);
    clean.close();
  });
});
```

The RO-probe sanity assertion is the DEFINITION of "hot" here — the fixture's `existsSync`/`size>0` guard cannot detect a dud journal (the file exists either way; only the header magic differs). If the sanity assertion ever fails, the spill did not happen: shrink `cache_size` further or grow the blob until it passes ("copy the journal later in the transaction" does NOT help — magic is written at sync, not later in wall-clock time). If `filler` collides with the outbound schema, use any new table name. Note for every journal assertion in this plan: a healing (or any RW) open leaves a NON-hot dud journal IN PLACE — `existsSync(…-journal) === false` assertions are only valid when the fixture planted a genuinely hot journal.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/db/session-db.test.ts -t 'hot journal'`
Expected: FAIL (`openOutboundDbReadOnlyHealing` missing).

- [ ] **Step 3: Implement in `src/db/session-db.ts`**

```ts
/** R9: a crashed writer's hot rollback journal makes read-only opens throw this. */
export function isHotJournalError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'SQLITE_READONLY_ROLLBACK'
  );
}

/**
 * R9: read-only outbound open that heals a crashed writer's hot journal.
 * better-sqlite3 constructors don't read the file, so we PROBE with one
 * statement; on SQLITE_READONLY_ROLLBACK we perform ONE write-mode open
 * whose first read rolls the journal back, then reopen read-only. Callers
 * log via onHotJournal.
 *
 * SAFETY CONTRACT: the caller must have verified that no container writer
 * can be live on this DB (host-local `!isContainerRunning` knowledge).
 * Cross-mount fcntl lock propagation between host and container is
 * UNVERIFIED (validator-V2), so SQLite locking must not be trusted to stop
 * a concurrent rollback against a live writer — rolling back a live
 * transaction is SQLite's documented corruption class.
 */
export function openOutboundDbReadOnlyHealing(
  dbPath: string,
  onHotJournal?: (dbPath: string) => void,
): Database.Database {
  const probe = (db: Database.Database): void => {
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  };
  const openReadOnly = (): Database.Database => {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
  };

  let db = openReadOnly();
  try {
    probe(db);
    return db;
  } catch (err) {
    db.close();
    if (!isHotJournalError(err)) throw err;
  }

  onHotJournal?.(dbPath);
  const rw = new Database(dbPath);
  try {
    rw.pragma('busy_timeout = 5000');
    probe(rw); // the read triggers the rollback
  } finally {
    rw.close();
  }

  db = openReadOnly();
  probe(db);
  return db;
}
```

In `src/session-manager.ts` (next to `openOutboundDb` at ~:611):

```ts
/**
 * R9: read-only outbound open that heals a crashed container's hot journal.
 * CALLER CONTRACT: only call from sites that verified the session's container
 * is not running (gated sweep path) — never from the 1s delivery poll.
 */
export function openOutboundDbHealing(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbReadOnlyHealing(outboundDbPath(agentGroupId, sessionId), (dbPath) => {
    log.error('Hot outbound journal detected; performing gated write-mode rollback', {
      agentGroupId,
      sessionId,
      dbPath,
    });
  });
}
```

(`outboundDbPath` is already used inside `writeOutboundDirect` — same module.)

- [ ] **Step 4: Run to verify the unit test passes**

Run: `pnpm exec vitest run src/db/session-db.test.ts -t 'hot journal'`
Expected: PASS.

- [ ] **Step 5: Wire the sweep and delivery, contain delivery errors**

`src/host-sweep.ts` `sweepSession` (~:429-436) — replace the bare-swallow outbound open with the GATED healing open:

```ts
  try {
    // R9a: the write-mode healing open runs ONLY when the host knows no
    // container writer can be live (cross-mount SQLite locking is unverified
    // and must not be the guard). This site also covers the post-crash
    // window: a nonzero exit schedules recoverSessionAfterUnexpectedExit ->
    // sweepSession (container-runner.ts:545,593), and it always runs BEFORE
    // the wake gate below.
    outDb = !isContainerRunning(session.id)
      ? openOutboundDbHealing(agentGroup.id, session.id)
      : openOutboundDb(agentGroup.id, session.id);
  } catch (err) {
    // outbound.db might not exist yet (container hasn't started). Anything
    // else deserves a log line: this bare swallow hid the hot-journal wedge.
    outDb = null;
    if (isHotJournalError(err)) {
      // Hot journal while the container is (or may be) running: defer — a
      // healthy container rolls its own journal back at startup, and the
      // next sweep after it stops takes the gated heal path above.
      log.warn('Hot outbound journal with container running; deferring heal to a gated sweep', {
        sessionId: session.id,
      });
    } else if ((err as { code?: string }).code !== 'SQLITE_CANTOPEN') {
      log.warn('Outbound DB unavailable during sweep', { sessionId: session.id, err });
    }
  }
```

(Import `openOutboundDbHealing` alongside the existing `openOutboundDb` import from `./session-manager.js`, and `isHotJournalError` from `./db/session-db.js`; `isContainerRunning` is already imported. If the not-yet-created case surfaces as a different code in practice, key the silence on file non-existence instead — the point is: silence ONLY the brand-new-session case.)

`src/delivery.ts` `drainSession` (~:293): KEEP the plain `openOutboundDb` — the 1s delivery poll must NOT perform an inline RW heal (a live container writer cannot be ruled out there; delivery runs regardless of container state). On `.code === 'SQLITE_READONLY_ROLLBACK'` the session is treated as transient/contained for this tick (catch below) and healing is deferred to the gated sweep path.

`src/delivery.ts` `deliverSessionMessages` (~:163-199): extend the catch so a non-transient error defers THIS session instead of poisoning the whole poll loop, and treat hot-journal residue as transient/contained (deferral only — the heal itself happens on the gated sweep):

```ts
  } catch (err) {
    if (isSqliteBusyError(err) || isHotJournalError(err)) {
      const streak = (deliveryContentionStreaks.get(session.id) ?? 0) + 1;
      deliveryContentionStreaks.set(session.id, streak);
      const context = {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        consecutiveDeferrals: streak,
      };
      if (streak >= DELIVERY_CONTENTION_ERROR_THRESHOLD) {
        log.error('Session delivery repeatedly deferred by SQLite contention', context);
      } else {
        log.warn('Session delivery deferred by transient SQLite contention', context);
      }
    } else {
      // R9: pollActive/pollSweep wrap the WHOLE session loop in one try — a
      // rethrow here starves every session ordered after this one, every tick.
      log.error('Session delivery failed', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        err,
      });
    }
  } finally {
```

Import `isHotJournalError` from `./db/session-db.js`.

- [ ] **Step 6: Write the delivery-level test**

In `src/delivery.test.ts`, next to the existing contention test (~:246-281 — reuse its session/outbound fixture and captured-adapter `delivered` array), add the same `plantHotJournal` helper verbatim (test files are separate compilation islands; duplicating the ~25-line helper is deliberate) and:

```ts
it('defers a hot-journal session without healing inline, and delivers after the gated heal (R9)', async () => {
  // Arrange exactly like the transient-lock test: session + outbound.db with
  // one due message and a capturing adapter.
  plantHotJournal(outboundDbPath('ag-1', session.id));
  // The 1s poll must NOT perform the RW heal (a live container writer cannot
  // be ruled out here): contained, no throw, journal untouched.
  await expect(deliverSessionMessages(session)).resolves.toBeUndefined();
  expect(fs.existsSync(`${outboundDbPath('ag-1', session.id)}-journal`)).toBe(true); // NOT healed inline
  // The gated sweep path (container verified not running) performs the heal:
  openOutboundDbHealing('ag-1', session.id).close();
  expect(fs.existsSync(`${outboundDbPath('ag-1', session.id)}-journal`)).toBe(false); // healed
  await deliverSessionMessages(session);
  expect(delivered.length).toBeGreaterThan(0); // and delivery proceeds
});

it('contains a non-transient per-session failure instead of throwing (R9)', async () => {
  fs.writeFileSync(outboundDbPath('ag-1', session.id), 'this is not a sqlite database');
  await expect(deliverSessionMessages(session)).resolves.toBeUndefined();
});
```

(Import `openOutboundDbHealing` from `./session-manager.js`; the journal-gone assertion is valid because `plantHotJournal` plants a genuinely hot journal — see the Step 1 note.)

Also add the sweep-side gate test in `src/host-sweep.test.ts`, using the on-disk `setupSession()` fixture the reconciliation suites use (~:1665) and the file's existing container-runner mocking for `isContainerRunning`:

```ts
it('heals a hot outbound journal only when the container is verified not running (R9 gate)', async () => {
  // Arrange: setupSession() with a hot journal planted on outbound.db.
  // 1) isContainerRunning mocked TRUE  -> run sweepSession -> journal still exists (no RW heal).
  // 2) isContainerRunning mocked FALSE -> run sweepSession -> journal gone (gated heal ran, before any wake).
});
```

(If the harness cannot drive `sweepSession` against an on-disk outbound DB, cover the gate by asserting `openOutboundDbHealing` is called/not-called via a `session-manager.js` spy — the load-bearing assertion is: no write-mode open while `isContainerRunning` is true.)

- [ ] **Step 7: Run the suites**

Run: `pnpm exec vitest run src/delivery.test.ts src/host-sweep.test.ts src/db/session-db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/session-db.ts src/session-manager.ts src/delivery.ts src/host-sweep.ts src/db/session-db.test.ts src/delivery.test.ts
git commit -m "fix(db): heal hot outbound journals with a guarded write-mode open and contain delivery errors per session (R9)"
```

---

### Task 8: R9b — container-side busy tolerance

The 07-31 crash cluster (8 exits code=1 in 10 min) is MECHANISM-CONSISTENT with a host lock hold outlasting the container's 5s `busy_timeout` and `SQLITE_BUSY` unwinding `runPollLoop` → `main().catch` → `process.exit(1)` (index.ts:123-134) — but that root cause is a hypothesis, not proven: the container stderr that would prove it was destroyed (the very gap R6 closes), and the lock-hold figures are untraceable to the findings doc (validator-V4). What IS verified in the current tree: the container has NO try/catch between the poll-loop `while` (poll-loop.ts:360) and the first inner `try` (:520); `getPendingMessages()` (:366) reads both session DBs; both handles carry `busy_timeout = 5000`; and the unguarded-DB-on-exit(1) surface is far wider than three sites (V4's 20-row touchpoint table — pre-loop writes, idle-loop sites, the catch handlers' own DB writes, and the 500ms `pollFollowups` path whose voided promise can reject unhandled). R9b is defense-in-depth: raise busy_timeout (configurable, default 30s — a defensible knob, not a proven ceiling) AND route EVERY DB touchpoint reachable from the poll/turn loops through a bounded busy-retry that fails LOUD (rethrows) on exhaustion. Turn-internal provider errors already route through the provider-failure/recovery machinery — leave that machinery alone; wrap only the session-DB statements around it.

**Files:**
- Create: `container/agent-runner/src/db/sqlite-retry.ts`
- Modify: `container/agent-runner/src/db/connection.ts` (~:23-56)
- Modify: `container/agent-runner/src/index.ts` (~:64, ~:72), `container/agent-runner/src/poll-loop.ts` (~:349, ~:357, ~:366, ~:423-486, ~:568, catch handlers ~:620/~:717, `pollFollowups` ~:1167-1189)
- Modify: `src/container-runner.ts` (`buildContainerArgs` ~:1491 — env passthrough)
- Test: `container/agent-runner/src/db/sqlite-retry.test.ts` (new, bun:test)

**Interfaces:**
- Consumes: bun:sqlite (`SQLiteError` with string `.code`; busy timeout set via `db.exec('PRAGMA busy_timeout = N')`).
- Produces (in `container/agent-runner/src/db/sqlite-retry.ts`):
  - `export function isSqliteBusyError(err: unknown): boolean` — matches `.code` starting with `SQLITE_BUSY` OR message containing `database is locked`.
  - `export async function withSqliteRetry<T>(fn: () => T, opts: { label: string; attempts?: number; baseDelayMs?: number }): Promise<T>` — bounded exponential backoff (default 5 attempts, 250ms base, 5s cap), emits a structured `sqlite_busy_retry` stderr event per retry, rethrows non-busy errors immediately and busy errors after the cap.

- [ ] **Step 1: Verify the failure path before fixing it (spec-mandated investigation)**

Read and confirm in the current tree (record what you find in the commit body):
- `container/agent-runner/src/index.ts` ~:123-134: `main().catch` → `process.exit(1)` for anything except `ProviderContainerStopRequired`.
- `container/agent-runner/src/poll-loop.ts`: no try/catch between the `while` at ~:360 and the first inner `try` at ~:520; `getPendingMessages()` at ~:366 reads `messages_in` (read-only inbound) AND `processing_ack` (outbound).
- `container/agent-runner/src/db/connection.ts` ~:23-56: both handles get `PRAGMA busy_timeout = 5000`; no `.code` inspection anywhere container-side.
- `container/agent-runner/src/poll-loop.ts` ~:1167-1179: `void pollFollowups().finally(…)` fires every 500ms during EVERY active turn; `pollFollowups` calls `getPendingMessages()` (:1179), `markProcessing`/`markCompleted` (:1185-1186), `writeRoutedMessage` (:1189) with no try/catch — a throw there becomes an unhandled rejection on a voided promise.
- The catch handlers at poll-loop.ts ~:620 and ~:717 themselves WRITE the session DBs (`scheduleProviderRetry`, `appendRecoveryEntry`/`ownExhaustedPreacceptRetry`, `returnProcessingToPending`, `writeMessageOut`, `markProviderRetryUserErrorEmitted`, `clearContinuation`) — a busy throw inside the handler escapes it and still unwinds to exit(1).
- Host lock producers on `outbound.db` while a container runs: `writeOutboundDirect` (`src/session-manager.ts:625`, unguarded, reachable from `src/router.ts:559,593`) and recovery-path `openOutboundDbRw` (`src/host-sweep.ts:1359`).

If any of these have materially changed, adapt the touchpoint list below to the actual unguarded sites — the fix targets "DB touched outside any try/catch on the exit(1) path (or on a voided-promise path)". Also note in the commit body that the crash cluster's cause remains a mechanism-consistent hypothesis — do NOT restate it as proven.

- [ ] **Step 2: Write the failing tests**

Create `container/agent-runner/src/db/sqlite-retry.test.ts` (bun:test — this suite runs via `cd container/agent-runner && bun test`):

```ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSqliteBusyError, withSqliteRetry } from './sqlite-retry.js';

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sqlite-retry-')), 't.db');
}

describe('isSqliteBusyError', () => {
  it('classifies a real bun:sqlite lock error and shaped errors; rejects others', () => {
    const path = tempDbPath();
    const a = new Database(path);
    a.exec('PRAGMA journal_mode = DELETE');
    a.exec('CREATE TABLE t (id INTEGER)');
    a.exec('BEGIN EXCLUSIVE');
    const b = new Database(path);
    b.exec('PRAGMA busy_timeout = 50');
    let caught: unknown;
    try {
      b.exec('BEGIN EXCLUSIVE');
    } catch (err) {
      caught = err;
    }
    a.exec('ROLLBACK');
    a.close();
    b.close();
    expect(caught).toBeDefined();
    expect(isSqliteBusyError(caught)).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true);
    expect(isSqliteBusyError(new Error('boom'))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });
});

describe('withSqliteRetry', () => {
  it('retries a busy operation until the lock is released', async () => {
    const path = tempDbPath();
    const a = new Database(path);
    a.exec('PRAGMA journal_mode = DELETE');
    a.exec('CREATE TABLE t (id INTEGER)');
    a.exec('BEGIN EXCLUSIVE');
    setTimeout(() => {
      a.exec('ROLLBACK');
      a.close();
    }, 300);
    const b = new Database(path);
    b.exec('PRAGMA busy_timeout = 50');
    const result = await withSqliteRetry(
      () => {
        b.exec('BEGIN IMMEDIATE');
        b.exec('COMMIT');
        return 'ok';
      },
      { label: 'test', attempts: 10, baseDelayMs: 100 },
    );
    b.close();
    expect(result).toBe('ok');
  });

  it('rethrows non-busy errors immediately and busy errors after the attempt cap', async () => {
    await expect(
      withSqliteRetry(
        () => {
          throw new Error('boom');
        },
        { label: 'x', attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('boom');

    let calls = 0;
    await expect(
      withSqliteRetry(
        () => {
          calls += 1;
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
        { label: 'x', attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('database is locked');
    expect(calls).toBe(3);
  });
});
```

Run: `cd container/agent-runner && bun test src/db/sqlite-retry.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `container/agent-runner/src/db/sqlite-retry.ts`**

```ts
/**
 * R9: bounded busy-retry for session-DB access. The host legitimately takes
 * short write locks on outbound.db (direct notices, recovery); a lock hold
 * longer than busy_timeout must NOT crash the container mid-turn (the
 * hypothesized 07-31 crash-cluster mechanism: SQLITE_BUSY unwinding
 * runPollLoop straight into process.exit(1) — mechanism-consistent, but the
 * stderr that would prove it was lost; R6 closes that gap). Defense-in-depth:
 * retries are bounded and exhaustion RETHROWS — fail loud, never swallow.
 */

export function isSqliteBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('database is locked');
}

export async function withSqliteRetry<T>(
  fn: () => T,
  opts: { label: string; attempts?: number; baseDelayMs?: number },
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= attempts) throw err;
      console.error(
        JSON.stringify({
          severity: 'warn',
          event: 'sqlite_busy_retry',
          label: opts.label,
          attempt,
          max_attempts: attempts,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, baseDelayMs * 2 ** (attempt - 1))));
    }
  }
}
```

- [ ] **Step 4: Raise the busy timeout and wrap the FULL touchpoint surface**

`container/agent-runner/src/db/connection.ts` — add at module scope and use in BOTH open paths (~:35, ~:45):

```ts
/**
 * R9: must exceed legitimate host write-lock holds. The 07-31 holds were
 * never measured (stderr destroyed); 30s is a defensible default, not a
 * proven ceiling — hence configurable, and backed by the bounded retries.
 */
const BUSY_TIMEOUT_MS = Number(process.env.NANOCLAW_CONTAINER_SQLITE_BUSY_TIMEOUT_MS) || 30_000;
```

```ts
    _inbound.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // …and in getOutboundDb:
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
```

`container/agent-runner/src/index.ts` (~:64) — wrap the pre-loop write (main is async):

```ts
  await withSqliteRetry(() => clearStaleContainerToolState(), { label: 'clearStaleContainerToolState' });
```

`container/agent-runner/src/poll-loop.ts` (~:357) — same treatment:

```ts
  await withSqliteRetry(() => clearStaleProcessingAcks(), { label: 'clearStaleProcessingAcks' });
```

`container/agent-runner/src/poll-loop.ts` (~:366) — the per-iteration read:

```ts
    const messages = (
      await withSqliteRetry(() => getPendingMessages(), { label: 'getPendingMessages' })
    ).filter((m) => m.kind !== 'system');
```

**Coverage policy (A7 falsified — the three sites above do NOT cover the surface, validator-V4):** every DB touchpoint reachable from the poll/turn loops on a path that can terminate the process (uncaught throw on the `main().catch` → exit(1) chain, or an unhandled rejection on a voided promise) goes through `withSqliteRetry`. In addition to the three sites above, wrap (line numbers are anchors — locate every call by content):

- `container/agent-runner/src/index.ts` ~:72 — `buildSystemPromptAddendum` (inbound destination reads via destinations.ts).
- `poll-loop.ts` ~:349 — `migrateLegacyContinuation` (session-state reads/writes).
- The idle-loop naked sites at ~:423-486 — `markCompleted` (:423), `writeRoutedMessage` (:424), `clearProviderRetrySchedule` (:433/:464), `readProviderRetrySchedule` (:440), `ownExhaustedPreacceptRetry` (:450), `listRecoveryEntries` (:486).
- `markProcessing` at ~:568 (turn-start claim write).
- The catch-handler DB writes at ~:620 and ~:717 — `scheduleProviderRetry`, `appendRecoveryEntry`/`ownExhaustedPreacceptRetry`, `returnProcessingToPending`, `writeMessageOut`, `markProviderRetryUserErrorEmitted`, `clearContinuation`: a busy throw INSIDE a catch handler escapes it and still reaches exit(1), so the handlers need the same wrapping as the code they guard.
- The **pollFollowups** path (~:1167-1189, fires every 500ms during EVERY active turn — exactly when host delivery lock activity peaks): wrap its DB calls (the second `getPendingMessages` at :1179, `markProcessing`/`markCompleted` at :1185-1186, `writeRoutedMessage` at :1189, and the later `markProcessing`/`returnProcessingToPending`/`countOutboundVisibleReplyMessages` calls in the same function), AND make the voided `void pollFollowups().finally(…)` promise rejection-proof: add a `.catch` that emits a structured stderr event — a rejected voided promise is an unhandled rejection (process-fatal under Bun's default; even if it merely warned, follow-up claiming would silently die).

Where several wrapped calls are adjacent, wrapping the enclosing helper's body once is preferable to per-statement wrapping — the POLICY is the unit ("every DB touchpoint reachable from the poll/turn loops goes through the retry helper"); the list above is the checklist, cross-checked against validator-V4's touchpoint table.

Import `withSqliteRetry` from `./db/sqlite-retry.js` (adjust relative path per file). Do NOT blanket-retry turn-internal PROVIDER logic (the LLM turn itself) — provider errors already route through the provider-failure/recovery machinery, and retrying side-effectful turn code would risk the dedupe semantics. The wraps above target session-DB statements only: a busy failure means the statement did NOT execute, so retrying it is side-effect-safe. On exhaustion `withSqliteRetry` rethrows into the existing loud paths — never swallow.

`src/container-runner.ts` `buildContainerArgs` (~:1491) — pass the knob through to the container (follow the function's existing arg-array style; add next to the other `-e`/env plumbing, or after the `--cap-drop=ALL` args if none exists):

```ts
  if (process.env.NANOCLAW_CONTAINER_SQLITE_BUSY_TIMEOUT_MS) {
    args.push('-e', `NANOCLAW_CONTAINER_SQLITE_BUSY_TIMEOUT_MS=${process.env.NANOCLAW_CONTAINER_SQLITE_BUSY_TIMEOUT_MS}`);
  }
```

- [ ] **Step 5: Run both container-side gates**

Run: `cd container/agent-runner && bun test`
Expected: PASS (all, including the new suite).
Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: clean.
Run: `pnpm exec vitest run src/container-runner.test.ts`
Expected: PASS (buildContainerArgs tests, if any assert exact arg arrays, may need the new conditional accounted for — it is inert unless the env var is set).

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/db/sqlite-retry.ts container/agent-runner/src/db/sqlite-retry.test.ts container/agent-runner/src/db/connection.ts container/agent-runner/src/index.ts container/agent-runner/src/poll-loop.ts src/container-runner.ts
git commit -m "fix(container): tolerate host lock holds on session DBs with a raised busy timeout and bounded retries (R9)"
```

---

### Task 9: Full-suite validation

The complete CI surface, exactly as the workflows run it.

- [ ] **Step 1: Format**

Run: `pnpm run format:fix && pnpm run format:check`
Expected: `format:check` exits 0. Stage/commit any formatter-only diffs as `style: apply formatter`.

- [ ] **Step 2: Typecheck both sides**

Run: `pnpm run typecheck && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: both clean.

- [ ] **Step 3: Full host suite**

Run: `pnpm test`
Expected: all files pass (baseline was 91 files / 1069 tests; expect more now). The run is noisy with expected ERROR log lines — judge by the summary and exit code.

- [ ] **Step 4: Full container suite**

Run: `cd container/agent-runner && bun test`
Expected: all pass (baseline was 415 tests / 31 files).

- [ ] **Step 5: Commit (only if anything changed)**

```bash
git add -A && git status --short
# commit only if the formatter or fixes touched files:
git commit -m "style: apply formatter across incident remediation changes"
```

---

## Cross-task ordering and interplay notes (for reviewers)

- `sweepSession` step order after this plan: open DBs (outbound via the GATED healing open — write-mode journal rollback ONLY when `!isContainerRunning`, so the heal always lands in a container-not-running window and strictly BEFORE the wake gate) → syncProcessingAcks (which never overwrites a terminal inbound `'failed'` — the Task 3 status-precedence guard) → scheduler sync → crash recovery → **3.5 release/escalate expired recovery acks (Task 3, release gated on GWS cleanliness)** → TTL-aware due count + wake (Task 1) → SLA. Escalated/released rows change state BEFORE the due count reads it, so an exhausted row never triggers a pointless wake and a released row wakes through the normal path.
- The escalation notice (Task 3) is what makes the scheduler path work: `syncProcessingAcks` accepts a `failed` ack only with a valid `notice_message_out_id`, and the scheduler sync's `ack.status === 'failed'` branch then calls `failScheduledTask` + `recordTerminalFailureIncident`. No scheduler-module changes are needed for R2. Task 3's release gate keeps GWS-uncertain rows out of auto-release entirely (they escalate directly), and its `syncProcessingAcks` guard keeps the escalated inbound `'failed'` durable across later sweeps.
- R3's stale threshold (60 min default) intentionally fires before R2's terminal escalation (TTL*K = 90 min default): operators get an error alert while the system is still retrying, then a second alert if it terminally fails.
- R8's reader no longer throws for record-level problems; every caller decision (block vs proceed) is keyed on `quarantined[].inputId` versus the caller's scopes. File-level corruption still throws everywhere.
- R9's two halves close the loop from both sides: the host heals the journal a crashed container leaves behind — but ONLY in the gated container-not-running window inside the sweep (which the post-crash recovery path funnels into), always before any wake; the 1s delivery loop never heals inline, it defers the affected session to the sweep. The container half survives the host's lock holds (so it stops crashing and leaving journals) — and, since the gated heal can race a fresh container's own startup rollback only through the wake that follows it, heal-before-wake ordering is what keeps that window closed.
