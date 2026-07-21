/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;

/** Inbound DB — container opens read-only (host is the sole writer). */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (!_outbound) {
    const db = new Database(DEFAULT_OUTBOUND_PATH);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec('PRAGMA foreign_keys = ON');
      ensureOutboundSchema(db);
      _outbound = db;
    } catch (err) {
      db.close();
      throw err;
    }
  }
  return _outbound;
}

/**
 * Ensure the container-owned outbound.db has every table this process writes.
 *
 * The container is the SOLE WRITER of outbound.db, so it owns its own schema.
 * Create-on-demand keeps the connection self-sufficient: a container that opens
 * an outbound.db which was never seeded with the route/state tables (an older
 * session DB) still migrates forward without a formal migration pass.
 */
export function ensureOutboundSchema(db: Database): void {
  // Base outbound tables. The host's src/db/schema.ts (OUTBOUND_SCHEMA) is the
  // authoritative creator when it pre-seeds outbound.db before the container
  // starts, but the container is the SOLE WRITER of this file and some paths
  // open it without that guarantee — an operator/fork container that never ran
  // through the host session-manager, or a startup-order race where the
  // container opens the path before the host writes the schema. Without
  // messages_out, EVERY outbound write throws `no such table: messages_out`,
  // which silently breaks send_message and turns apply_managed_repos /
  // push_managed_repo into false failures (the host script still runs, but the
  // agent only ever sees the enqueue crash). Create-on-demand here mirrors the
  // forward-compat self-heal for the state tables below; the route-metadata
  // columns added later are filled in by ensureOutboundRouteColumns().
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      input_id       TEXT,
      route_key      TEXT,
      messaging_group_id TEXT,
      is_group       INTEGER,
      content        TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL,
      notice_message_out_id TEXT
    );
  `);
  // Lightweight forward-compat: session_state was added after the initial
  // v2 schema, so older session DBs don't have it. Create it on demand
  // instead of requiring a formal migration pass. Also handle the case
  // where an earlier revision of this table existed without updated_at —
  // ALTER TABLE to add any missing columns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const cols = new Set(
    (db.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('updated_at')) {
    db.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
  }
  // container_state: tracks the current tool in flight (if any) so the host
  // sweep can widen its stuck tolerance when Bash is running with a user-
  // declared long timeout. Forward-compat for older outbound.db files.
  db.exec(`
    CREATE TABLE IF NOT EXISTS container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL
    );
  `);
  // side_effect_ledger: validated, imported side effects. The host
  // src/db/schema.ts is the authoritative creator, but a container opening an
  // old-schema outbound.db must self-migrate (create-on-demand) so recovery
  // and import work without a formal migration pass.
  db.exec(`
    CREATE TABLE IF NOT EXISTS side_effect_ledger (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      operation       TEXT,
      payload_schema_version INTEGER NOT NULL DEFAULT 1,
      account_label   TEXT,
      account_email   TEXT,
      input_id        TEXT,
      route_key       TEXT,
      signed_payload  TEXT,
      signature       TEXT,
      evidence_json   TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      replay_policy   TEXT,
      occurred_at     TEXT,
      imported_at     TEXT NOT NULL
    );
  `);
  ensureOutboundRouteColumns(db);
  ensureSideEffectLedgerColumns(db);
}

function ensureSideEffectLedgerColumns(db: Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('side_effect_ledger')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('payload_schema_version'))
    db.exec('ALTER TABLE side_effect_ledger ADD COLUMN payload_schema_version INTEGER NOT NULL DEFAULT 1');
  if (!cols.has('account_label')) db.exec('ALTER TABLE side_effect_ledger ADD COLUMN account_label TEXT');
  if (!cols.has('account_email')) db.exec('ALTER TABLE side_effect_ledger ADD COLUMN account_email TEXT');
  if (!cols.has('input_id')) db.exec('ALTER TABLE side_effect_ledger ADD COLUMN input_id TEXT');
  if (!cols.has('route_key')) db.exec('ALTER TABLE side_effect_ledger ADD COLUMN route_key TEXT');
  if (!cols.has('signed_payload')) db.exec('ALTER TABLE side_effect_ledger ADD COLUMN signed_payload TEXT');
  if (!cols.has('signature')) db.exec('ALTER TABLE side_effect_ledger ADD COLUMN signature TEXT');
}

/**
 * Read-compatible ALTER guards so a container opening an OLD-schema outbound.db
 * self-migrates the route metadata on `messages_out` and the
 * `notice_message_out_id` column on `processing_ack`. The host
 * `src/db/schema.ts` owns the authoritative column definitions; these guards
 * only catch pre-existing files that predate those additions.
 */
function ensureOutboundRouteColumns(db: Database): void {
  const outCols = new Set(
    (db.prepare("PRAGMA table_info('messages_out')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!outCols.has('input_id')) db.exec('ALTER TABLE messages_out ADD COLUMN input_id TEXT');
  if (!outCols.has('route_key')) db.exec('ALTER TABLE messages_out ADD COLUMN route_key TEXT');
  if (!outCols.has('messaging_group_id')) db.exec('ALTER TABLE messages_out ADD COLUMN messaging_group_id TEXT');
  if (!outCols.has('is_group')) db.exec('ALTER TABLE messages_out ADD COLUMN is_group INTEGER');

  const ackCols = new Set(
    (db.prepare("PRAGMA table_info('processing_ack')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!ackCols.has('notice_message_out_id')) {
    db.exec('ALTER TABLE processing_ack ADD COLUMN notice_message_out_id TEXT');
  }
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool, declaredTimeoutMs, now, now);
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  const existing = getOutboundDb()
    .prepare('SELECT current_tool, tool_declared_timeout_ms, tool_started_at FROM container_state WHERE id = 1')
    .get() as
    | { current_tool: string | null; tool_declared_timeout_ms: number | null; tool_started_at: string | null }
    | undefined;
  if (
    existing &&
    existing.current_tool === null &&
    existing.tool_declared_timeout_ms === null &&
    existing.tool_started_at === null
  ) {
    return;
  }

  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 *
 * Recovery-owned acks (`status='recovery'`) and terminal-fallback acks
 * (`status='failed'`) are PRESERVED — only orphan `processing` claims are reset.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/**
 * Clear stale provider-owned tool state on container startup (Task 3 Step 8).
 * `container_state` records the in-flight tool for host-sweep timeout widening.
 * After a crash the row may still claim a long OpenCode/Bash tool is running, so
 * a fresh container must reset it to avoid the host honoring a phantom long
 * timeout. The recovery-owned ack rows are untouched here (see
 * clearStaleProcessingAcks).
 */
export function clearStaleContainerToolState(): void {
  // Reuse the canonical clear so the row is reset to NULL (not deleted), keeping
  // the singleton id=1 invariant.
  clearContainerToolInFlight();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      platform_message_id TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      messaging_group_id TEXT,
      is_group       INTEGER,
      content        TEXT NOT NULL
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      input_id       TEXT,
      route_key      TEXT,
      messaging_group_id TEXT,
      is_group       INTEGER,
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL,
      notice_message_out_id TEXT
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE side_effect_ledger (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      operation       TEXT,
      payload_schema_version INTEGER NOT NULL DEFAULT 1,
      account_label   TEXT,
      account_email   TEXT,
      input_id        TEXT,
      route_key       TEXT,
      signed_payload  TEXT,
      signature       TEXT,
      evidence_json   TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      replay_policy   TEXT,
      occurred_at     TEXT,
      imported_at     TEXT NOT NULL
    );
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _outbound?.close();
  _outbound = null;
}

/**
 * @deprecated Use getInboundDb() / getOutboundDb() instead.
 * Kept for backward compatibility during migration.
 */
export function getSessionDb(): Database {
  return getInboundDb();
}
