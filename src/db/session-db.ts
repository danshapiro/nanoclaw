/**
 * SQL operations on per-session inbound/outbound DBs.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. Callers own the connection lifecycle
 * (open-write-close per op). See session-manager.ts header for invariants.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { classifyAndSanitize, parseLedgerLines } from './side-effects-verify.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  if (schema === 'inbound') {
    migrateMessagesInTable(db);
    migrateSessionRoutingTable(db);
  } else {
    migrateOutboundRouteColumns(db);
  }
  db.close();
}

/**
 * Add route columns to a pre-existing session_routing table. No-op when the
 * columns are already present (fresh installs ship them in INBOUND_SCHEMA).
 */
export function migrateSessionRoutingTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('session_routing')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('messaging_group_id'))
    db.prepare('ALTER TABLE session_routing ADD COLUMN messaging_group_id TEXT').run();
  if (!cols.has('is_group')) db.prepare('ALTER TABLE session_routing ADD COLUMN is_group INTEGER').run();
}

/**
 * Add route columns to a pre-existing messages_out table and
 * notice_message_out_id to processing_ack, plus the side_effect_ledger table.
 * Host-owned forward-compat for outbound DBs (the container also self-migrates
 * via connection.ts).
 */
export function migrateOutboundRouteColumns(db: Database.Database): void {
  const outCols = new Set(
    (db.prepare("PRAGMA table_info('messages_out')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!outCols.has('input_id')) db.prepare('ALTER TABLE messages_out ADD COLUMN input_id TEXT').run();
  if (!outCols.has('route_key')) db.prepare('ALTER TABLE messages_out ADD COLUMN route_key TEXT').run();
  if (!outCols.has('messaging_group_id'))
    db.prepare('ALTER TABLE messages_out ADD COLUMN messaging_group_id TEXT').run();
  if (!outCols.has('is_group')) db.prepare('ALTER TABLE messages_out ADD COLUMN is_group INTEGER').run();

  const ackCols = new Set(
    (db.prepare("PRAGMA table_info('processing_ack')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!ackCols.has('notice_message_out_id')) {
    db.prepare('ALTER TABLE processing_ack ADD COLUMN notice_message_out_id TEXT').run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS side_effect_ledger (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      operation       TEXT,
      input_id        TEXT,
      route_key       TEXT,
      evidence_json   TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      replay_policy   TEXT,
      occurred_at     TEXT,
      imported_at     TEXT NOT NULL
    );
  `);
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for host-authored direct responses. */
export function openOutboundDbForWrite(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function upsertSessionRouting(
  db: Database.Database,
  routing: {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    messaging_group_id?: string | null;
    is_group?: 0 | 1 | null;
  },
): void {
  db.prepare(
    `INSERT INTO session_routing (id, channel_type, platform_id, thread_id, messaging_group_id, is_group)
     VALUES (1, @channel_type, @platform_id, @thread_id, @messaging_group_id, @is_group)
     ON CONFLICT(id) DO UPDATE SET
       channel_type = excluded.channel_type,
       platform_id  = excluded.platform_id,
       thread_id    = excluded.thread_id,
       messaging_group_id = excluded.messaging_group_id,
       is_group     = excluded.is_group`,
  ).run({
    channel_type: routing.channel_type,
    platform_id: routing.platform_id,
    thread_id: routing.thread_id,
    messaging_group_id: routing.messaging_group_id ?? null,
    is_group: routing.is_group ?? null,
  });
}

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export function replaceDestinations(db: Database.Database, entries: DestinationRow[]): void {
  const tx = db.transaction((rows: DestinationRow[]) => {
    db.prepare('DELETE FROM destinations').run();
    const stmt = db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (@name, @display_name, @type, @channel_type, @platform_id, @agent_group_id)`,
    );
    for (const row of rows) stmt.run(row);
  });
  tx(entries);
}

// ---------------------------------------------------------------------------
// messages_in
// ---------------------------------------------------------------------------

/**
 * Next even seq number for host-owned inbound.db.
 *
 * Exported so the scheduling module's task helpers can maintain the
 * host-writes-even-seq invariant without duplicating the logic. Not part of
 * the general public API — imported by `src/modules/scheduling/db.ts` only.
 */
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

export function insertMessage(
  db: Database.Database,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId: string | null;
    platformMessageId?: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    processAfter: string | null;
    recurrence: string | null;
    /**
     * 1 = wake the agent (default); 0 = accumulate as context only.
     * Host countDueMessages gates on this; container reads everything.
     */
    trigger?: 0 | 1;
    /**
     * Host-stamped route identity. Nullable: a row without these is never
     * collapsible onto another route (fail-safe). Defaults to null.
     */
    messagingGroupId?: string | null;
    isGroup?: 0 | 1 | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, platform_message_id, channel_type, thread_id, messaging_group_id, is_group, content, process_after, recurrence, series_id, trigger)
     VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @platformMessageId, @channelType, @threadId, @messagingGroupId, @isGroup, @content, @processAfter, @recurrence, @id, @trigger)`,
  ).run({
    ...message,
    platformMessageId: message.platformMessageId ?? null,
    messagingGroupId: message.messagingGroupId ?? null,
    isGroup: message.isGroup ?? null,
    trigger: message.trigger ?? 1,
    seq: nextEvenSeq(db),
  });
}

export function countDueMessages(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
       WHERE status = 'pending'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
      )
      .get() as { count: number }
  ).count;
}

/**
 * Outbound-aware due count: like countDueMessages, but excludes rows whose
 * outbound processing_ack is recovery-owned (status='recovery'). Those rows are
 * already owned by route-scoped recovery, so they must not trip a fresh wake.
 * This reads processing_ack READ-ONLY and never completes/resets those rows.
 *
 * New behavior: the legacy countDueMessages never opened the outbound DB, so
 * this is a new outbound-aware due check, not a tweak to an existing filter.
 */
export function countDueMessagesExcludingRecovery(inDb: Database.Database, outDb: Database.Database): number {
  const recoveryOwned = new Set(
    (
      outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'recovery'").all() as Array<{
        message_id: string;
      }>
    ).map((r) => r.message_id),
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

export function markMessageFailed(db: Database.Database, messageId: string): void {
  db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ?").run(messageId);
}

export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  db.prepare(
    `UPDATE messages_in SET tries = tries + 1, process_after = datetime('now', '+${backoffSec} seconds') WHERE id = ?`,
  ).run(messageId);
}

export function getMessageForRetry(
  db: Database.Database,
  messageId: string,
  status: string,
): { id: string; tries: number; processAfter: string | null } | undefined {
  return db
    .prepare('SELECT id, tries, process_after as processAfter FROM messages_in WHERE id = ? AND status = ?')
    .get(messageId, status) as { id: string; tries: number; processAfter: string | null } | undefined;
}

export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  // 'completed' always syncs. 'failed' syncs ONLY when notice_message_out_id
  // points at an existing user-visible terminal notice row in messages_out — a
  // failed ack with no linked notice (NULL or dangling) is invalid host-sync
  // state and must NOT silently complete inbound work. 'recovery' is never
  // synced here (recovery owns those rows until it succeeds).
  //
  // Read-compatible: an old outbound DB (opened read-only here) may predate the
  // notice_message_out_id column. Treat its absence as "no notice proof", so a
  // failed ack from an old DB is conservatively NOT completed.
  const hasNoticeCol = (outDb.prepare("PRAGMA table_info('processing_ack')").all() as Array<{ name: string }>).some(
    (c) => c.name === 'notice_message_out_id',
  );
  const acks = (
    hasNoticeCol
      ? outDb.prepare(
          "SELECT message_id, status, notice_message_out_id FROM processing_ack WHERE status IN ('completed', 'failed')",
        )
      : outDb.prepare(
          "SELECT message_id, status, NULL AS notice_message_out_id FROM processing_ack WHERE status IN ('completed', 'failed')",
        )
  ).all() as Array<{ message_id: string; status: string; notice_message_out_id: string | null }>;

  if (acks.length === 0) return;

  const noticeExistsStmt = outDb.prepare('SELECT 1 AS ok FROM messages_out WHERE id = ?');
  const toComplete: string[] = [];
  for (const ack of acks) {
    if (ack.status === 'completed') {
      toComplete.push(ack.message_id);
      continue;
    }
    // status === 'failed'
    if (!ack.notice_message_out_id) continue; // invalid: no notice proof
    const exists = noticeExistsStmt.get(ack.notice_message_out_id) as { ok: number } | undefined;
    if (exists) toComplete.push(ack.message_id);
    // else dangling notice id — invalid, leave the inbound row as-is.
  }

  if (toComplete.length === 0) return;

  const updateStmt = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status != 'completed'");
  inDb.transaction(() => {
    for (const id of toComplete) updateStmt.run(id);
  })();
}

export interface ImportSideEffectsResult {
  imported: number;
  skipped: number;
  validated: number;
}

// ── Side-effect validation (host) ────────────────────────────────────────────
// The pure, DB-free validation (Ed25519 verify, canonical JSON, classify +
// sanitize) lives in the host copy `./side-effects-verify.ts`, a byte-equivalent
// duplicate of the container copy `container/agent-runner/src/db/
// side-effects-verify.ts`. It is duplicated (not cross-project imported) because
// the host TS project (rootDir ./src) cannot include the container `src` tree
// and must not pull in `bun:sqlite`. The host importer below calls
// `classifyAndSanitize` with the configured PUBLIC verify key, so a signed
// `gmail_draft_created` becomes authoritative ONLY when the proxy's Ed25519
// signature verifies; without a key (or for forged/tampered entries) it stays an
// unvalidated hint. Recovery reads `validation_json.authoritative`.

/**
 * Idempotently import the staged side-effect JSONL for a session into the
 * outbound DB `side_effect_ledger`. The host derives the ledger path from the
 * session dir (NEVER the container literal `/workspace/...` path) and opens the
 * outbound DB writable ONLY after a verified `containerStopped:true` proof.
 *
 * Validation matches the container importer (shared pure helper): summarize-dnd
 * entries require artifact existence + size under an allowed root; gmail
 * entries require a valid Ed25519 signature verified with the PUBLIC key (no
 * key, or forged/tampered ⇒ unvalidated hint). All rows — validated or not — are
 * stored idempotently keyed by id; recovery consults `validation_json.
 * authoritative` to decide what it may rely on.
 */
export function importHostSideEffects(opts: {
  sessionDir: string;
  containerStopped: boolean;
  allowedArtifactRoots?: string[];
  gwsPublicKey?: string;
}): ImportSideEffectsResult {
  if (opts.containerStopped !== true) {
    throw new Error(
      'importHostSideEffects: refusing to open outbound DB writable while the container may still be running ' +
        '(containerStopped must be verified true)',
    );
  }

  const ledgerPath = path.join(opts.sessionDir, 'side-effects.jsonl');
  const outPath = path.join(opts.sessionDir, 'outbound.db');
  const result: ImportSideEffectsResult = { imported: 0, skipped: 0, validated: 0 };
  if (!fs.existsSync(ledgerPath) || !fs.existsSync(outPath)) return result;

  const text = fs.readFileSync(ledgerPath, 'utf8');
  const raws = parseLedgerLines(text);
  if (raws.length === 0) return result;

  const db = openOutboundDbRw(outPath);
  try {
    migrateOutboundRouteColumns(db);
    const existsStmt = db.prepare('SELECT 1 AS ok FROM side_effect_ledger WHERE id = ?');
    const insertStmt = db.prepare(
      `INSERT INTO side_effect_ledger
         (id, source, kind, operation, input_id, route_key, evidence_json, validation_json, replay_policy, occurred_at, imported_at)
       VALUES (@id, @source, @kind, @operation, @input_id, @route_key, @evidence_json, @validation_json, @replay_policy, @occurred_at, @imported_at)`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const raw of raws) {
        const validated = classifyAndSanitize(raw, {
          allowedArtifactRoots: opts.allowedArtifactRoots,
          gwsPublicKey: opts.gwsPublicKey,
          statSize: (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : null),
        });
        if (!validated) {
          result.skipped++;
          continue;
        }
        if (existsStmt.get(validated.id)) {
          result.skipped++;
          continue;
        }
        insertStmt.run({
          id: validated.id,
          source: validated.source,
          kind: validated.kind,
          operation: validated.operation,
          input_id: validated.inputId,
          route_key: validated.routeKey,
          evidence_json: JSON.stringify(validated.evidence),
          validation_json: JSON.stringify(validated.validation),
          replay_policy: validated.replayPolicy,
          occurred_at: validated.occurredAt,
          imported_at: now,
        });
        result.imported++;
        if (validated.validation.authoritative) result.validated++;
      }
    })();
  } finally {
    db.close();
  }
  return result;
}

/** One append-only entry the gws-proxy writes to GWS_AUDIT_STORE per call. */
interface GwsAuditStoreEntry {
  audit_id?: string;
  input_id?: string;
  route_key?: string;
  service?: string;
  method?: string;
  occurred_at?: string;
}

export interface DiscoverCrashWindowResult {
  discovered: number;
}

/**
 * HOST-ONLY crash-window discovery for GWS draft creation.
 *
 * The agent container CANNOT read `GWS_AUDIT_STORE` (it is a root-owned,
 * host/proxy-co-located file that is NOT mounted into the container), so this
 * read lives in the host import path (called from host-sweep recovery), never in
 * the container `side-effects.ts`.
 *
 * If the tool process was SIGKILLed BETWEEN a successful `drafts.create` and the
 * workspace JSONL append, there is no `gmail_draft_created` JSONL entry. The
 * proxy's append-only audit store still recorded the completed mutation
 * correlated by `input_id`/`route_key`/time-window. This finds such an orphan
 * (a completed `drafts.create` whose `audit_id` is not already in the session's
 * `side_effect_ledger`) and records exactly one non-duplicate row so recovery
 * knows the draft already exists and does NOT re-create it.
 *
 * Gating: `auditStorePath` unset ⇒ discovery is inactive and the no-duplication
 * guarantee degrades to "no duplication when the tool process survives to
 * append". Only safe to call after a verified container stop (single-writer
 * invariant), like importHostSideEffects.
 */
export function discoverGwsCrashWindowDrafts(opts: {
  sessionDir: string;
  containerStopped: boolean;
  auditStorePath: string | undefined;
  inputId?: string;
  routeKey?: string;
  notBefore?: string;
  notAfter?: string;
}): DiscoverCrashWindowResult {
  if (opts.containerStopped !== true) {
    throw new Error(
      'discoverGwsCrashWindowDrafts: refusing to open outbound DB writable while the container may still be running',
    );
  }
  const result: DiscoverCrashWindowResult = { discovered: 0 };
  // Gating: no audit store configured ⇒ discovery inactive.
  if (!opts.auditStorePath || !fs.existsSync(opts.auditStorePath)) return result;
  const outPath = path.join(opts.sessionDir, 'outbound.db');
  if (!fs.existsSync(outPath)) return result;

  // Read the proxy's append-only audit store directly (read-only host access),
  // tolerant of malformed lines.
  const raw = fs.readFileSync(opts.auditStorePath, 'utf8');
  const matches: GwsAuditStoreEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: GwsAuditStoreEntry;
    try {
      e = JSON.parse(trimmed) as GwsAuditStoreEntry;
    } catch {
      continue;
    }
    if (e.service !== 'gmail') continue;
    if (e.method !== 'users.drafts.create' && e.method !== 'drafts.create') continue;
    if (opts.inputId && e.input_id !== opts.inputId) continue;
    if (opts.routeKey && e.route_key !== opts.routeKey) continue;
    if (opts.notBefore && e.occurred_at && e.occurred_at < opts.notBefore) continue;
    if (opts.notAfter && e.occurred_at && e.occurred_at > opts.notAfter) continue;
    if (!e.audit_id) continue;
    matches.push(e);
  }
  if (matches.length === 0) return result;

  const db = openOutboundDbRw(outPath);
  try {
    migrateOutboundRouteColumns(db);
    const existsStmt = db.prepare('SELECT 1 AS ok FROM side_effect_ledger WHERE id = ?');
    const insertStmt = db.prepare(
      `INSERT INTO side_effect_ledger
         (id, source, kind, operation, input_id, route_key, evidence_json, validation_json, replay_policy, occurred_at, imported_at)
       VALUES (@id, @source, @kind, @operation, @input_id, @route_key, @evidence_json, @validation_json, @replay_policy, @occurred_at, @imported_at)`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const e of matches) {
        // Idempotent by audit_id: if the JSONL importer already created this row
        // (the tool survived to append), discovery adds nothing — no duplicate.
        if (existsStmt.get(e.audit_id!)) continue;
        insertStmt.run({
          id: e.audit_id!,
          source: 'gws',
          kind: 'gmail_draft_created',
          operation: e.method ?? null,
          input_id: e.input_id ?? null,
          route_key: e.route_key ?? null,
          evidence_json: JSON.stringify({ discovered_via: 'gws_audit_store' }),
          // Discovered from the audit store, not from a signed JSONL entry: this
          // is durable "a draft was created" evidence for no-duplication, but it
          // is NOT a signature-validated authoritative entry.
          validation_json: JSON.stringify({ authoritative: false, reason: 'discovered_audit_store_crash_window' }),
          replay_policy: 'no_duplicate_draft',
          occurred_at: e.occurred_at ?? null,
          imported_at: now,
        });
        result.discovered++;
      }
    })();
  } finally {
    db.close();
  }
  return result;
}

export function getStuckProcessingIds(outDb: Database.Database): string[] {
  return (
    outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
      message_id: string;
    }>
  ).map((r) => r.message_id);
}

export interface ProcessingClaim {
  message_id: string;
  status_changed: string;
}

/** Return processing_ack rows still in 'processing' with their claim timestamps. */
export function getProcessingClaims(outDb: Database.Database): ProcessingClaim[] {
  return outDb
    .prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'processing'")
    .all() as ProcessingClaim[];
}

/**
 * Delete orphan 'processing' rows. Called by the host after killing a
 * container so the leftover claim doesn't trip claim-stuck on the next sweep
 * tick before the fresh agent-runner can clear stale rows on startup.
 */
export function deleteOrphanProcessingClaims(outDb: Database.Database): number {
  return outDb.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run().changes;
}

export interface ContainerState {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
}

/**
 * Read the container's current tool-in-flight state, if any. Returns null
 * when either the table doesn't exist yet (older session DB) or no tool is
 * active. Host sweep reads this to widen stuck-detection tolerance while
 * Bash is running with a long declared timeout.
 */
export function getContainerState(outDb: Database.Database): ContainerState | null {
  try {
    const row = outDb
      .prepare(
        `SELECT current_tool, tool_declared_timeout_ms, tool_started_at
           FROM container_state WHERE id = 1`,
      )
      .get() as ContainerState | undefined;
    return row ?? null;
  } catch {
    // Table not present on older session DBs — treat as "no tool in flight".
    return null;
  }
}

// ---------------------------------------------------------------------------
// messages_out (read-only from host)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export function getDueOutboundMessages(db: Database.Database): OutboundMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as OutboundMessage[];
}

// ---------------------------------------------------------------------------
// delivered
// ---------------------------------------------------------------------------

export function getDeliveredIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
      (r) => r.message_out_id,
    ),
  );
}

export function markDelivered(db: Database.Database, messageOutId: string, platformMessageId: string | null): void {
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, 'delivered', datetime('now'))",
  ).run(messageOutId, platformMessageId ?? null);
}

export function markDeliveryFailed(db: Database.Database, messageOutId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'failed', datetime('now'))",
  ).run(messageOutId);
}

/** Ensure the delivered table has columns added after initial schema. */
export function migrateDeliveredTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN platform_message_id TEXT').run();
  }
  if (!cols.has('status')) {
    db.prepare("ALTER TABLE delivered ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'").run();
  }
}

// Adds columns added to messages_in after the initial v2 schema to
// pre-existing session DBs. No-op on fresh installs where the columns are
// in the baseline schema. Backfills existing rows so invariants hold.
export function migrateMessagesInTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('series_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN series_id TEXT').run();
    db.prepare('UPDATE messages_in SET series_id = id WHERE series_id IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id)').run();
  }
  if (!cols.has('trigger')) {
    // All pre-existing rows got written with the old "every inbound wakes
    // the agent" semantics, so backfill 1 and default 1 for new inserts.
    db.prepare('ALTER TABLE messages_in ADD COLUMN trigger INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN platform_message_id TEXT').run();
    db.prepare(
      `UPDATE messages_in
       SET platform_message_id =
         CASE
           WHEN instr(id, ':') > 0 THEN substr(id, 1, instr(id, ':') - 1)
           ELSE id
         END
       WHERE channel_type = 'discord'
         AND platform_message_id IS NULL`,
    ).run();
  }
  // Host-stamped route identity. Left NULL on existing rows: a null value is
  // never collapsible onto another route, so the only failure mode is a missed
  // merge for legacy rows, never a cross-conversation leak.
  if (!cols.has('messaging_group_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN messaging_group_id TEXT').run();
  }
  if (!cols.has('is_group')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN is_group INTEGER').run();
  }
}
