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
import {
  classifyAndSanitize,
  parseCanonicalGwsSideEffectPayload,
  parseLedgerLines,
  type RawSideEffectRecord,
  type ValidatedSideEffect,
} from './side-effects-verify.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  if (schema === 'inbound') {
    migrateMessagesInTable(db);
    migrateSessionRoutingTable(db);
    migrateRouteQuarantineTable(db);
  } else {
    migrateOutboundRouteColumns(db);
  }
  db.close();
}

/**
 * Create the route_quarantine table on pre-existing inbound DBs. Fresh
 * installs ship it in INBOUND_SCHEMA; this covers per-session DBs created
 * before the table existed. Idempotent (CREATE TABLE IF NOT EXISTS).
 */
export function migrateRouteQuarantineTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_quarantine (
      route_key            TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      quarantined_at       TEXT, -- NULL = tracking only, not quarantined
      reason               TEXT,
      updated_at           TEXT NOT NULL
    );
  `);
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
  if (!ackCols.has('claim_token')) {
    db.prepare('ALTER TABLE processing_ack ADD COLUMN claim_token TEXT').run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS side_effect_ledger (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      operation       TEXT,
      payload_schema_version INTEGER NOT NULL DEFAULT 1,
      profile         TEXT,
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
  const ledgerCols = new Set(
    (db.prepare("PRAGMA table_info('side_effect_ledger')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!ledgerCols.has('payload_schema_version'))
    db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN payload_schema_version INTEGER NOT NULL DEFAULT 1').run();
  if (!ledgerCols.has('profile')) db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN profile TEXT').run();
  if (!ledgerCols.has('account_label'))
    db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN account_label TEXT').run();
  if (!ledgerCols.has('account_email'))
    db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN account_email TEXT').run();
  if (!ledgerCols.has('input_id')) db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN input_id TEXT').run();
  if (!ledgerCols.has('route_key')) db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN route_key TEXT').run();
  if (!ledgerCols.has('signed_payload'))
    db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN signed_payload TEXT').run();
  if (!ledgerCols.has('signature')) db.prepare('ALTER TABLE side_effect_ledger ADD COLUMN signature TEXT').run();
}

/**
 * Open the inbound DB for a session (host reads/writes).
 *
 * Self-heals the inbound schema on every host open: a per-session DB created
 * before a column was added (e.g. session_routing.messaging_group_id) is
 * migrated forward here - the single opener every host inbound path funnels
 * through - so no host caller can open an un-migrated inbound DB. Keep the
 * messages_in and session_routing opener-owned migrations together; splitting
 * them is what regressed pre-existing sessions after the route-columns change.
 * ensureSchema() applies the same migrations at session-creation time; this
 * covers pre-existing sessions on the per-operation hot path. The delivered
 * table migration stays in the delivery path that owns those writes. These
 * helpers are idempotent and column-existence-guarded, so fresh/already-healed
 * DBs incur only the PRAGMA checks.
 */
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  migrateMessagesInTable(db);
  migrateSessionRoutingTable(db);
  migrateRouteQuarantineTable(db);
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
  type: 'channel' | 'agent' | 'blocked_channel';
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
    hostInputId?: string | null;
    hostRouteKey?: string | null;
    hostReceivedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, platform_message_id, channel_type, thread_id, messaging_group_id, is_group, host_input_id, host_route_key, host_received_at, content, process_after, recurrence, series_id, trigger)
     VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @platformMessageId, @channelType, @threadId, @messagingGroupId, @isGroup, @hostInputId, @hostRouteKey, @hostReceivedAt, @content, @processAfter, @recurrence, @id, @trigger)`,
  ).run({
    ...message,
    platformMessageId: message.platformMessageId ?? null,
    messagingGroupId: message.messagingGroupId ?? null,
    isGroup: message.isGroup ?? null,
    hostInputId: message.hostInputId ?? null,
    hostRouteKey: message.hostRouteKey ?? null,
    hostReceivedAt: message.hostReceivedAt ?? null,
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

export interface StrictGwsSideEffectScope {
  inputId: string;
  routeKey: string;
  notBefore: string;
  notAfter: string;
}

interface StoredSideEffectRow {
  id: string;
  source: string;
  kind: string;
  operation: string | null;
  payload_schema_version: number;
  profile: string | null;
  account_label: string | null;
  account_email: string | null;
  input_id: string | null;
  route_key: string | null;
  signed_payload: string | null;
  signature: string | null;
  evidence_json: string;
  replay_policy: string | null;
  occurred_at: string | null;
}

function rawStoredSideEffect(row: StoredSideEffectRow): RawSideEffectRecord {
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  return {
    kind: row.kind,
    payload_schema_version: row.payload_schema_version,
    audit_id: row.id,
    profile: row.profile ?? undefined,
    account_label: row.account_label ?? undefined,
    account_email: row.account_email ?? undefined,
    operation: row.operation ?? undefined,
    input_id: row.input_id ?? undefined,
    route_key: row.route_key ?? undefined,
    response_input_id: row.input_id ?? undefined,
    response_route_key: row.route_key ?? undefined,
    response_service: row.operation?.split(' ', 2)[0],
    response_method: row.operation?.split(' ', 2)[1],
    occurred_at: row.occurred_at ?? undefined,
    payload: row.signed_payload ?? undefined,
    signature: row.signature ?? undefined,
    evidence,
  };
}

function revalidateStoredSideEffect(
  row: StoredSideEffectRow,
  opts: { gwsPublicKey?: string; allowedArtifactRoots?: string[] },
): ValidatedSideEffect | null {
  return classifyAndSanitize(rawStoredSideEffect(row), {
    ...opts,
    statSize: (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : null),
  });
}

function storedRowMatches(row: StoredSideEffectRow, validated: ValidatedSideEffect): boolean {
  return (
    row.id === validated.id &&
    row.source === validated.source &&
    row.kind === validated.kind &&
    row.operation === validated.operation &&
    row.payload_schema_version === validated.payloadSchemaVersion &&
    row.profile === validated.profile &&
    row.account_label === validated.accountLabel &&
    row.account_email === validated.accountEmail &&
    row.input_id === validated.inputId &&
    row.route_key === validated.routeKey &&
    row.signed_payload === validated.signedPayload &&
    row.signature === validated.signature &&
    row.replay_policy === validated.replayPolicy &&
    row.occurred_at === validated.occurredAt
  );
}

function isGwsShapedRecord(raw: RawSideEffectRecord): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return (
    (raw as RawSideEffectRecord & { source?: unknown }).source === 'gws' ||
    raw.kind === 'gmail_draft_created' ||
    raw.kind === 'gws_mutation_completed' ||
    raw.payload !== undefined ||
    raw.signature !== undefined
  );
}

function requireExactAuthoritativeGwsEffect(
  validated: ValidatedSideEffect | null,
  scope: StrictGwsSideEffectScope,
  description: string,
): asserts validated is ValidatedSideEffect {
  if (!validated) throw new Error(`${description} is unresolved: unclassifiable or missing its outer audit id`);
  if (!validated.validation.authoritative) {
    throw new Error(`${description} is unresolved: nonauthoritative (${validated.validation.reason})`);
  }
  if (validated.inputId !== scope.inputId || validated.routeKey !== scope.routeKey) {
    throw new Error(`${description} is outside the exact operator scope`);
  }
  const occurredMs = validated.occurredAt ? Date.parse(validated.occurredAt) : NaN;
  const notBeforeMs = Date.parse(scope.notBefore);
  const notAfterMs = Date.parse(scope.notAfter);
  if (
    !Number.isFinite(occurredMs) ||
    !Number.isFinite(notBeforeMs) ||
    !Number.isFinite(notAfterMs) ||
    notAfterMs < notBeforeMs ||
    occurredMs < notBeforeMs ||
    occurredMs > notAfterMs
  ) {
    throw new Error(`${description} is outside the exact operator time window`);
  }
}

function requireExactRawGwsScope(raw: RawSideEffectRecord, scope: StrictGwsSideEffectScope, description: string): void {
  if (typeof raw.audit_id !== 'string' || !raw.audit_id) {
    throw new Error(`${description} is unresolved: missing its outer audit id`);
  }
  if (raw.input_id !== scope.inputId || raw.route_key !== scope.routeKey) {
    throw new Error(`${description} is outside the exact operator scope`);
  }
  const occurredMs = typeof raw.occurred_at === 'string' ? Date.parse(raw.occurred_at) : NaN;
  const notBeforeMs = Date.parse(scope.notBefore);
  const notAfterMs = Date.parse(scope.notAfter);
  if (
    !Number.isFinite(occurredMs) ||
    !Number.isFinite(notBeforeMs) ||
    !Number.isFinite(notAfterMs) ||
    notAfterMs < notBeforeMs ||
    occurredMs < notBeforeMs ||
    occurredMs > notAfterMs
  ) {
    throw new Error(`${description} is outside the exact operator time window`);
  }
}

/**
 * Fail closed unless every GWS-shaped stored row re-verifies from its signed
 * payload bytes and independently stored bindings for this exact operator.
 * `validation_json` is intentionally not selected or trusted: outbound.db is
 * mounted writable in the operator container.
 */
export function assertHostGwsSideEffectsReconciled(
  outDb: Database.Database,
  opts: StrictGwsSideEffectScope & { gwsPublicKey?: string },
): number {
  const rows = outDb
    .prepare(
      `SELECT * FROM side_effect_ledger
        WHERE source = 'gws'
           OR kind IN ('gmail_draft_created', 'gws_mutation_completed')
           OR signed_payload IS NOT NULL
           OR signature IS NOT NULL`,
    )
    .all() as StoredSideEffectRow[];
  for (const row of rows) {
    const validated = revalidateStoredSideEffect(row, { gwsPublicKey: opts.gwsPublicKey });
    requireExactAuthoritativeGwsEffect(validated, opts, `stored operator GWS evidence ${row.id}`);
    if (!storedRowMatches(row, validated)) {
      throw new Error(`stored operator GWS evidence ${row.id} has tampered duplicated bindings`);
    }
  }
  return rows.length;
}

function matchingStrictGwsScope(
  raw: RawSideEffectRecord,
  scopes: StrictGwsSideEffectScope[],
): StrictGwsSideEffectScope | null {
  const signed = parseCanonicalGwsSideEffectPayload(raw.payload);
  const candidates = scopes.filter((scope) => raw.input_id === scope.inputId || signed?.input_id === scope.inputId);
  if (candidates.length === 0) return null;
  const distinct = new Map(candidates.map((scope) => [`${scope.inputId}\0${scope.routeKey}`, scope]));
  if (distinct.size !== 1) throw new Error('GWS evidence ambiguously matches multiple interrupted-turn scopes');
  return [...distinct.values()][0];
}

/**
 * Re-verify only rows associated with the accepted inputs being recovered.
 * Normal sessions retain historical rows for the same route, so route alone
 * must never make an older turn a candidate. The host-generated input id is
 * unique to one accepted turn and is the fail-closed selection boundary.
 */
export function assertHostGwsSideEffectsReconciledForScopes(
  outDb: Database.Database,
  opts: { scopes: StrictGwsSideEffectScope[]; gwsPublicKey?: string },
): number {
  const rows = outDb
    .prepare(
      `SELECT * FROM side_effect_ledger
        WHERE source = 'gws'
           OR kind IN ('gmail_draft_created', 'gws_mutation_completed')
           OR signed_payload IS NOT NULL
           OR signature IS NOT NULL`,
    )
    .all() as StoredSideEffectRow[];
  let reconciled = 0;
  for (const row of rows) {
    const raw = rawStoredSideEffect(row);
    const scope = matchingStrictGwsScope(raw, opts.scopes);
    if (!scope) continue;
    const validated = revalidateStoredSideEffect(row, { gwsPublicKey: opts.gwsPublicKey });
    requireExactAuthoritativeGwsEffect(validated, scope, `stored interrupted-turn GWS evidence ${row.id}`);
    if (!storedRowMatches(row, validated)) {
      throw new Error(`stored interrupted-turn GWS evidence ${row.id} has tampered duplicated bindings`);
    }
    reconciled++;
  }
  return reconciled;
}

export interface HostAuthoritativeSideEffect {
  id: string;
  inputId: string;
  kind: ValidatedSideEffect['kind'];
  label: string;
  payloadSchemaVersion: number;
  accountLabel: string | null;
  accountEmail: string | null;
  evidence: Record<string, string | number | boolean | null>;
  occurredAt: string;
}

/** Re-verify every stored byte before host recovery relies on it. */
export function getHostAuthoritativeSideEffects(
  outDb: Database.Database,
  opts: { routeKey: string; inputId?: string; gwsPublicKey?: string },
): HostAuthoritativeSideEffect[] {
  const rows = outDb
    .prepare('SELECT * FROM side_effect_ledger WHERE route_key = ?')
    .all(opts.routeKey) as StoredSideEffectRow[];
  const effects: HostAuthoritativeSideEffect[] = [];
  for (const row of rows) {
    if (opts.inputId && row.input_id !== opts.inputId) continue;
    const validated = revalidateStoredSideEffect(row, { gwsPublicKey: opts.gwsPublicKey });
    if (!validated?.validation.authoritative || !storedRowMatches(row, validated)) continue;
    if (!validated.inputId || !validated.occurredAt) continue;
    effects.push({
      id: validated.id,
      inputId: validated.inputId,
      kind: validated.kind,
      label: `${validated.operation ?? validated.kind}${validated.accountLabel ? ` (${validated.accountLabel})` : ''}`,
      payloadSchemaVersion: validated.payloadSchemaVersion,
      accountLabel: validated.accountLabel,
      accountEmail: validated.accountEmail,
      evidence: validated.evidence,
      occurredAt: validated.occurredAt,
    });
  }
  return effects;
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
// unvalidated hint. Host recovery re-verifies the stored immutable payload and
// signature bytes plus every duplicated binding; it never trusts validation
// metadata written by the container.

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
 * stored idempotently keyed by id. Recovery re-verifies stored bytes rather
 * than trusting persisted validation metadata.
 */
export function importHostSideEffects(opts: {
  sessionDir: string;
  containerStopped: boolean;
  allowedArtifactRoots?: string[];
  gwsPublicKey?: string;
  /** Operator finalization requires a complete JSONL tail before releasing authority. */
  requireCompleteLedger?: boolean;
  /** Operator-only fail-closed accounting for every GWS-shaped ledger row. */
  strictGwsScope?: StrictGwsSideEffectScope;
  /** Normal recovery fail-closed accounting for the exact accepted inputs. */
  strictGwsScopes?: StrictGwsSideEffectScope[];
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
  if (!fs.existsSync(ledgerPath) || !fs.existsSync(outPath)) {
    if (opts.strictGwsScope || opts.strictGwsScopes?.length) {
      throw new Error('strict GWS ledger or outbound database is missing or inaccessible');
    }
    return result;
  }

  const text = fs.readFileSync(ledgerPath, 'utf8');
  if (opts.requireCompleteLedger) {
    if (text.length > 0 && !text.endsWith('\n')) {
      throw new Error('side-effect ledger has a truncated, incomplete tail');
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch (error) {
        throw new Error('side-effect ledger contains an invalid complete JSONL record', { cause: error });
      }
    }
  }
  const raws = parseLedgerLines(text);
  if (raws.length === 0) return result;

  const db = openOutboundDbRw(outPath);
  try {
    migrateOutboundRouteColumns(db);
    const existingStmt = db.prepare('SELECT * FROM side_effect_ledger WHERE id = ?');
    const persistStmt = db.prepare(
      `INSERT INTO side_effect_ledger
         (id, source, kind, operation, payload_schema_version, profile, account_label, account_email, input_id, route_key,
          signed_payload, signature, evidence_json, validation_json, replay_policy, occurred_at, imported_at)
       VALUES (@id, @source, @kind, @operation, @payload_schema_version, @profile, @account_label, @account_email, @input_id, @route_key,
          @signed_payload, @signature, @evidence_json, @validation_json, @replay_policy, @occurred_at, @imported_at)
       ON CONFLICT(id) DO UPDATE SET
         source=excluded.source, kind=excluded.kind, operation=excluded.operation,
         payload_schema_version=excluded.payload_schema_version, profile=excluded.profile,
         account_label=excluded.account_label, account_email=excluded.account_email,
         input_id=excluded.input_id, route_key=excluded.route_key,
         signed_payload=excluded.signed_payload, signature=excluded.signature,
         evidence_json=excluded.evidence_json, validation_json=excluded.validation_json,
         replay_policy=excluded.replay_policy, occurred_at=excluded.occurred_at, imported_at=excluded.imported_at`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const raw of raws) {
        const validated = classifyAndSanitize(raw, {
          allowedArtifactRoots: opts.allowedArtifactRoots,
          gwsPublicKey: opts.gwsPublicKey,
          statSize: (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : null),
        });
        const strictGwsScope = opts.strictGwsScope
          ? isGwsShapedRecord(raw)
            ? opts.strictGwsScope
            : null
          : opts.strictGwsScopes?.length && isGwsShapedRecord(raw)
            ? matchingStrictGwsScope(raw, opts.strictGwsScopes)
            : null;
        if (strictGwsScope) {
          requireExactRawGwsScope(
            raw,
            strictGwsScope,
            `operator GWS ledger record ${typeof raw.audit_id === 'string' ? raw.audit_id : '(missing outer audit id)'}`,
          );
          if (!validated) {
            throw new Error('operator GWS ledger record is unresolved: unclassifiable after exact-scope validation');
          }
        }
        if (!validated) {
          result.skipped++;
          continue;
        }
        const existing = existingStmt.get(validated.id) as StoredSideEffectRow | undefined;
        if (existing) {
          if (!validated.validation.authoritative) {
            if (!strictGwsScope) {
              result.skipped++;
              continue;
            }
            // Persist the exact-scope diagnostic so root-audit discovery may
            // replace it by id. Finalization still fails unless the resulting
            // stored row re-verifies as authoritative.
          } else {
            const prior = revalidateStoredSideEffect(existing, opts);
            if (
              prior?.validation.authoritative &&
              storedRowMatches(existing, prior) &&
              storedRowMatches(existing, validated)
            ) {
              if (strictGwsScope) result.validated++;
              else result.skipped++;
              continue;
            }
          }
        }
        persistStmt.run({
          id: validated.id,
          source: validated.source,
          kind: validated.kind,
          operation: validated.operation,
          payload_schema_version: validated.payloadSchemaVersion,
          profile: validated.profile,
          account_label: validated.accountLabel,
          account_email: validated.accountEmail,
          input_id: validated.inputId,
          route_key: validated.routeKey,
          signed_payload: validated.signedPayload,
          signature: validated.signature,
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
  schema_version?: number;
  audit_id?: string;
  profile?: string;
  account_label?: string;
  account_email?: string;
  input_id?: string;
  route_key?: string;
  service?: string;
  method?: string;
  occurred_at?: string;
  payload?: string;
  signature?: string;
}

interface GwsReconciliationStoreEntry {
  schema_version?: number;
  record_type?: string;
  audit_id?: string;
  outcome?: string;
  account?: string;
  account_label?: string;
  account_email?: string;
  input_id?: string;
  route_key?: string;
  service?: string;
  method?: string;
  operation?: string;
  resource_type?: string;
  started_at?: string;
  ended_at?: string;
  search_hints?: unknown;
}

interface GwsReconciliationResolutionEntry {
  schema_version?: number;
  record_type?: string;
  audit_id?: string;
  input_id?: string;
  route_key?: string;
  disposition?: string;
  operator?: string;
  note?: string;
  resolved_at?: string;
}

export interface GwsManualReconciliation {
  auditId: string;
  inputId: string;
  routeKey: string;
  disposition: 'completed' | 'not_completed';
  operator: string;
  note: string;
  resolvedAt: string;
  operation: string;
  accountLabel: string | null;
  accountEmail: string;
}

/**
 * Consume the proxy's root-owned durable reconciliation journal before an
 * interrupted accepted input can run again. Every current proxy record is a
 * manual-reconciliation receipt; in particular outcome_unknown corresponds to
 * the proxy response's retry=manual_only sentinel. Historical records are
 * excluded by their unique host input id, never merely by the stable route.
 */
export function assertNoUnresolvedGwsReconciliationRecords(opts: {
  reconciliationStorePath: string | undefined;
  scopes: StrictGwsSideEffectScope[];
}): GwsManualReconciliation[] {
  if (!opts.reconciliationStorePath || !fs.existsSync(opts.reconciliationStorePath)) {
    throw new Error('GWS reconciliation store is missing or inaccessible');
  }
  const raw = fs.readFileSync(opts.reconciliationStorePath, 'utf8');
  if (raw.length > 0 && !raw.endsWith('\n')) {
    throw new Error('GWS reconciliation store has a truncated, incomplete tail');
  }
  const incidents = new Map<string, GwsReconciliationStoreEntry>();
  const resolutions = new Map<string, GwsReconciliationResolutionEntry>();
  const incidentFields = new Set([
    'schema_version',
    'audit_id',
    'outcome',
    'profile',
    'account',
    'account_label',
    'account_email',
    'input_id',
    'route_key',
    'service',
    'method',
    'operation',
    'resource_type',
    'requested_title',
    'parent',
    'workspace',
    'started_at',
    'ended_at',
    'returned_id',
    'search_hints',
    'payload',
    'signature',
  ]);
  const resolutionFields = new Set([
    'schema_version',
    'record_type',
    'audit_id',
    'input_id',
    'route_key',
    'disposition',
    'operator',
    'note',
    'resolved_at',
  ]);
  const canonicalAscii = (value: unknown, maximum: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x20-\x7e]+$/.test(value);
  const canonicalTimestamp = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: GwsReconciliationStoreEntry | GwsReconciliationResolutionEntry;
    try {
      entry = JSON.parse(line) as GwsReconciliationStoreEntry;
    } catch (error) {
      throw new Error('GWS reconciliation store contains an invalid complete JSONL record', { cause: error });
    }
    if (!entry || typeof entry !== 'object') {
      throw new Error('GWS reconciliation store contains an invalid complete JSONL record');
    }
    if (entry.record_type === 'resolution') {
      const resolution = entry as GwsReconciliationResolutionEntry;
      if (Object.keys(resolution).some((key) => !resolutionFields.has(key))) {
        throw new Error('GWS reconciliation resolution contains an unknown field');
      }
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
        !canonicalAscii(resolution.operator, 256) ||
        !canonicalAscii(resolution.note, 2048) ||
        !canonicalTimestamp(resolution.resolved_at) ||
        !Number.isFinite(endedMs) ||
        resolvedMs < endedMs
      ) {
        throw new Error('GWS reconciliation resolution is malformed or outside its exact incident binding');
      }
      resolutions.set(resolution.audit_id!, resolution);
      continue;
    }
    if (entry.record_type !== undefined) {
      throw new Error('GWS reconciliation store contains an unknown record type');
    }
    const incident = entry as GwsReconciliationStoreEntry;
    if (Object.keys(incident).some((key) => !incidentFields.has(key))) {
      throw new Error('GWS reconciliation incident contains an unknown field');
    }
    if (
      incident.schema_version !== 2 ||
      !canonicalAscii(incident.audit_id, 256) ||
      incidents.has(incident.audit_id!) ||
      !canonicalAscii(incident.outcome, 256) ||
      !canonicalAscii(incident.account, 512) ||
      !canonicalAscii(incident.input_id, 512) ||
      !canonicalAscii(incident.route_key, 512) ||
      !canonicalAscii(incident.operation, 512) ||
      !canonicalAscii(incident.resource_type, 512) ||
      !canonicalTimestamp(incident.started_at) ||
      !canonicalTimestamp(incident.ended_at) ||
      Date.parse(incident.ended_at!) < Date.parse(incident.started_at!) ||
      !Array.isArray(incident.search_hints) ||
      incident.search_hints.length === 0 ||
      incident.search_hints.some((hint) => !canonicalAscii(hint, 2048))
    ) {
      throw new Error('GWS reconciliation incident is malformed or incomplete');
    }
    incidents.set(incident.audit_id!, incident);
  }

  const accepted: GwsManualReconciliation[] = [];
  for (const entry of incidents.values()) {
    const scope = opts.scopes.find((candidate) => entry.input_id === candidate.inputId);
    if (!scope) continue;
    const startedMs = typeof entry.started_at === 'string' ? Date.parse(entry.started_at) : NaN;
    const endedMs = typeof entry.ended_at === 'string' ? Date.parse(entry.ended_at) : NaN;
    const notBeforeMs = Date.parse(scope.notBefore);
    const notAfterMs = Date.parse(scope.notAfter);
    const complete =
      entry.schema_version === 2 &&
      typeof entry.audit_id === 'string' &&
      entry.audit_id.length > 0 &&
      typeof entry.outcome === 'string' &&
      entry.outcome.length > 0 &&
      typeof entry.account === 'string' &&
      entry.account.length > 0 &&
      entry.route_key === scope.routeKey &&
      typeof entry.operation === 'string' &&
      entry.operation.length > 0 &&
      typeof entry.resource_type === 'string' &&
      entry.resource_type.length > 0 &&
      Array.isArray(entry.search_hints) &&
      entry.search_hints.length > 0 &&
      Number.isFinite(startedMs) &&
      Number.isFinite(endedMs) &&
      Number.isFinite(notBeforeMs) &&
      Number.isFinite(notAfterMs) &&
      startedMs >= notBeforeMs &&
      startedMs <= notAfterMs &&
      endedMs >= startedMs;
    if (!complete) {
      throw new Error(
        `GWS reconciliation evidence for accepted input ${scope.inputId} is malformed or outside its exact scope`,
      );
    }
    const resolution = resolutions.get(entry.audit_id!);
    if (!resolution) {
      throw new Error(
        `GWS ${entry.outcome} requires manual reconciliation before accepted input ${scope.inputId} can resume; ` +
          'do not retry automatically',
      );
    }
    accepted.push({
      auditId: entry.audit_id!,
      inputId: entry.input_id!,
      routeKey: entry.route_key!,
      disposition: resolution.disposition as 'completed' | 'not_completed',
      operator: resolution.operator!,
      note: resolution.note!,
      resolvedAt: resolution.resolved_at!,
      operation: entry.operation!,
      accountLabel: typeof entry.account_label === 'string' && entry.account_label ? entry.account_label : null,
      accountEmail: entry.account!,
    });
  }
  return accepted;
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
 * knows the exact signed mutation already completed and does NOT repeat it.
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
  gwsPublicKey?: string;
  /** Fail instead of silently disabling discovery when the root audit is unavailable. */
  requireAuditAccess?: boolean;
  /** Require the append-only audit to end at a complete JSONL boundary. */
  requireCompleteAudit?: boolean;
  /** Fail if an exact-scope audit row exists but cannot authenticate. */
  failOnUnresolved?: boolean;
}): DiscoverCrashWindowResult {
  if (opts.containerStopped !== true) {
    throw new Error(
      'discoverGwsCrashWindowDrafts: refusing to open outbound DB writable while the container may still be running',
    );
  }
  const result: DiscoverCrashWindowResult = { discovered: 0 };
  // The audit store is global. Never inspect it without an exact host-accepted
  // input, route, and closed time interval for this interrupted turn.
  const notBeforeMs = opts.notBefore ? Date.parse(opts.notBefore) : NaN;
  const notAfterMs = opts.notAfter ? Date.parse(opts.notAfter) : NaN;
  const invalidScope =
    !opts.inputId ||
    !opts.routeKey ||
    !Number.isFinite(notBeforeMs) ||
    !Number.isFinite(notAfterMs) ||
    notAfterMs < notBeforeMs;
  if (invalidScope) {
    if (opts.requireAuditAccess) throw new Error('GWS audit discovery requires an exact input, route, and time window');
    return result;
  }
  // Gating: no audit store configured ⇒ discovery inactive.
  if (!opts.auditStorePath || !fs.existsSync(opts.auditStorePath)) {
    if (opts.requireAuditAccess) throw new Error('GWS audit store is missing or inaccessible');
    return result;
  }
  const outPath = path.join(opts.sessionDir, 'outbound.db');
  if (!fs.existsSync(outPath)) {
    if (opts.requireAuditAccess) throw new Error('GWS audit discovery outbound database is missing');
    return result;
  }

  // Read the proxy's append-only audit store directly (read-only host access),
  // tolerant of malformed lines.
  const raw = fs.readFileSync(opts.auditStorePath, 'utf8');
  if (opts.requireCompleteAudit && raw.length > 0 && !raw.endsWith('\n')) {
    throw new Error('GWS audit store has a truncated, incomplete tail');
  }
  const matches: Array<{ entry: GwsAuditStoreEntry; validated: NonNullable<ReturnType<typeof classifyAndSanitize>> }> =
    [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: GwsAuditStoreEntry;
    try {
      e = JSON.parse(trimmed) as GwsAuditStoreEntry;
    } catch (error) {
      if (opts.requireCompleteAudit) {
        throw new Error('GWS audit store contains an invalid complete JSONL record', { cause: error });
      }
      continue;
    }
    const validated = classifyAndSanitize(
      {
        kind: 'gws_mutation_completed',
        payload_schema_version: e.schema_version,
        audit_id: e.audit_id,
        profile: e.profile,
        account_label: e.account_label,
        account_email: e.account_email,
        input_id: e.input_id,
        route_key: e.route_key,
        response_input_id: e.input_id,
        response_route_key: e.route_key,
        response_service: e.service,
        response_method: e.method,
        operation: e.service && e.method ? `${e.service} ${e.method}` : undefined,
        occurred_at: e.occurred_at,
        payload: e.payload,
        signature: e.signature,
      },
      { gwsPublicKey: opts.gwsPublicKey },
    );
    const signed = parseCanonicalGwsSideEffectPayload(e.payload);
    // Routes are intentionally stable across many normal turns. The
    // host-generated accepted input id is unique, so it selects the current
    // candidate while the exact route and time remain mandatory bindings below.
    const outerIdentifierCandidate = e.input_id === opts.inputId;
    const signedIdentifierCandidate = signed?.input_id === opts.inputId;
    const operatorCandidate = outerIdentifierCandidate || signedIdentifierCandidate;
    if (!operatorCandidate) continue;
    if (!validated?.validation.authoritative) {
      if (opts.failOnUnresolved) {
        throw new Error(
          `GWS audit store contains unresolved candidate evidence for operator scope (${e.audit_id ?? 'missing-audit-id'})`,
        );
      }
      continue;
    }
    const outerOccurredMs = e.occurred_at ? Date.parse(e.occurred_at) : NaN;
    const signedOccurredMs = signed?.occurred_at ? Date.parse(signed.occurred_at) : NaN;
    const exactSignedIdentifiers = Boolean(
      signed && signed.input_id === opts.inputId && signed.route_key === opts.routeKey,
    );
    const exactOperatorEvidence =
      e.input_id === opts.inputId &&
      e.route_key === opts.routeKey &&
      exactSignedIdentifiers &&
      Number.isFinite(outerOccurredMs) &&
      outerOccurredMs >= notBeforeMs &&
      outerOccurredMs <= notAfterMs &&
      Number.isFinite(signedOccurredMs) &&
      signedOccurredMs >= notBeforeMs &&
      signedOccurredMs <= notAfterMs;
    if (!exactOperatorEvidence) {
      if (opts.failOnUnresolved) {
        throw new Error(
          `GWS audit store candidate is outside the exact operator bindings or time window (${e.audit_id ?? 'missing-audit-id'})`,
        );
      }
      continue;
    }
    matches.push({ entry: e, validated });
  }
  if (matches.length === 0) return result;

  const db = openOutboundDbRw(outPath);
  try {
    migrateOutboundRouteColumns(db);
    const existingStmt = db.prepare('SELECT * FROM side_effect_ledger WHERE id = ?');
    const persistStmt = db.prepare(
      `INSERT INTO side_effect_ledger
         (id, source, kind, operation, payload_schema_version, profile, account_label, account_email, input_id, route_key,
          signed_payload, signature, evidence_json, validation_json, replay_policy, occurred_at, imported_at)
       VALUES (@id, @source, @kind, @operation, @payload_schema_version, @profile, @account_label, @account_email, @input_id, @route_key,
          @signed_payload, @signature, @evidence_json, @validation_json, @replay_policy, @occurred_at, @imported_at)
       ON CONFLICT(id) DO UPDATE SET
         source=excluded.source, kind=excluded.kind, operation=excluded.operation,
         payload_schema_version=excluded.payload_schema_version, profile=excluded.profile,
         account_label=excluded.account_label, account_email=excluded.account_email,
         input_id=excluded.input_id, route_key=excluded.route_key,
         signed_payload=excluded.signed_payload, signature=excluded.signature,
         evidence_json=excluded.evidence_json, validation_json=excluded.validation_json,
         replay_policy=excluded.replay_policy, occurred_at=excluded.occurred_at, imported_at=excluded.imported_at`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const { entry: e, validated } of matches) {
        // Preserve an existing row only when it independently re-verifies and
        // is byte-for-byte identical. A forged/hint/tampered same-audit row is
        // replaced by the root-owned signed evidence so it cannot suppress
        // crash-window recovery.
        const existing = existingStmt.get(e.audit_id!) as StoredSideEffectRow | undefined;
        if (existing) {
          const prior = revalidateStoredSideEffect(existing, { gwsPublicKey: opts.gwsPublicKey });
          if (
            prior?.validation.authoritative &&
            storedRowMatches(existing, prior) &&
            storedRowMatches(existing, validated)
          ) {
            continue;
          }
        }
        persistStmt.run({
          id: e.audit_id!,
          source: 'gws',
          kind: validated.kind,
          operation: validated.operation,
          payload_schema_version: validated.payloadSchemaVersion,
          profile: validated.profile,
          account_label: validated.accountLabel,
          account_email: validated.accountEmail,
          input_id: validated.inputId,
          route_key: validated.routeKey,
          signed_payload: validated.signedPayload,
          signature: validated.signature,
          evidence_json: JSON.stringify({ discovered_via: 'gws_audit_store' }),
          // The root audit stores the same canonical bytes/signature as the shim
          // row, so a kill-window discovery is authoritative only after the full
          // schema-v2 binding and Ed25519 verification above succeeds.
          validation_json: JSON.stringify(validated.validation),
          replay_policy: validated.replayPolicy,
          occurred_at: validated.occurredAt,
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
  seq: number | null;
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
       ORDER BY seq IS NULL, seq ASC, timestamp ASC`,
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
  if (!cols.has('host_input_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_input_id TEXT').run();
  }
  if (!cols.has('host_route_key')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_route_key TEXT').run();
  }
  if (!cols.has('host_received_at')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_received_at TEXT').run();
  }
  if (!cols.has('host_accepted_input_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_accepted_input_id TEXT').run();
  }
  if (!cols.has('host_accepted_route_key')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_accepted_route_key TEXT').run();
  }
  if (!cols.has('host_accepted_at')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_accepted_at TEXT').run();
  }
  if (!cols.has('host_acceptance_ended_at')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_acceptance_ended_at TEXT').run();
  }
  if (!cols.has('host_acceptance_claim_token')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_acceptance_claim_token TEXT').run();
  }
  if (!cols.has('host_acceptance_lease_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_acceptance_lease_id TEXT').run();
  }
  if (!cols.has('host_acceptance_sequence')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN host_acceptance_sequence INTEGER').run();
  }
}
