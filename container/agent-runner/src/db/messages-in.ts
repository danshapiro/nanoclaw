/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  platform_message_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  /** Host-stamped route identity (nullable; null is never collapsible). */
  messaging_group_id: string | null;
  is_group: number | null;
  host_input_id: string | null;
  host_route_key: string | null;
  host_received_at: string | null;
  content: string;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Returns the most recent `MAX_MESSAGES_PER_PROMPT` pending rows in
 * chronological order, regardless of their `trigger` flag: accumulated
 * context (trigger=0) rides along with the wake-eligible rows so the agent
 * sees the prior context it missed. Host's countDueMessages gates waking on
 * trigger=1 separately (see src/db/session-db.ts).
 */
export function getPendingMessages(): MessageInRow[] {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  const pending = inbound
    .prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(getMaxMessagesPerPrompt()) as MessageInRow[];

  if (pending.length === 0) return [];

  // Filter out messages already acknowledged in outbound.db
  const ackedIds = new Set(
    (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      (r) => r.message_id,
    ),
  );

  // Reverse: we fetched DESC to take the most recent N, but the agent
  // should see them in chronological order (oldest first).
  return pending.filter((m) => !ackedIds.has(m.id)).reverse();
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', datetime('now'))",
    )
    .run(id);
}

function logAckEvent(event: Record<string, unknown>): void {
  console.error(JSON.stringify(event));
}

/**
 * Return route-matched unaccepted rows to pending by deleting ONLY their
 * transient `processing_ack.status='processing'` rows. Never touches
 * `recovery`/`completed`/`failed` acks — recovery-owned work stays hidden from
 * normal pending scans until recovery resolves it.
 */
export function returnProcessingToPending(ids: string[], reason: string): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare("DELETE FROM processing_ack WHERE message_id = $id AND status = 'processing'");
  db.transaction(() => {
    for (const id of ids) stmt.run({ $id: id });
  })();
  logAckEvent({ severity: 'info', event: 'return_processing_to_pending', message_ids: ids, reason });
}

/**
 * Move accepted-but-unresolved rows into `processing_ack.status='recovery'` so
 * they stay hidden from normal due/pending scans while recovery owns them.
 */
export function markRecoveryOwned(ids: string[], recoveryId: string): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES ($id, 'recovery', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run({ $id: id });
  })();
  logAckEvent({ severity: 'info', event: 'mark_recovery_owned', message_ids: ids, recovery_id: recoveryId });
}

/**
 * Transition recovery-owned rows to `completed` after a successful recovery
 * result. Only acts on rows currently in `recovery` status.
 */
export function markRecoveryCompleted(ids: string[], recoveryId: string): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "UPDATE processing_ack SET status = 'completed', status_changed = datetime('now') WHERE message_id = $id AND status = 'recovery'",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run({ $id: id });
  })();
  logAckEvent({ severity: 'info', event: 'mark_recovery_completed', message_ids: ids, recovery_id: recoveryId });
}

/**
 * Delete recovery acks ONLY after the rows have been returned to pending,
 * completed, or covered by a replacement recovery/fallback. The caller asserts
 * which disposition applied via `reason`; this deletes the recovery ack rows
 * so they no longer hide the underlying inbound rows.
 */
export function clearRecoveryOwnership(ids: string[], recoveryId: string, reason: string): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare("DELETE FROM processing_ack WHERE message_id = $id AND status = 'recovery'");
  db.transaction(() => {
    for (const id of ids) stmt.run({ $id: id });
  })();
  logAckEvent({
    severity: 'info',
    event: 'clear_recovery_ownership',
    message_ids: ids,
    recovery_id: recoveryId,
    reason,
  });
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  return getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  const response = inbound
    .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
    .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

  if (!response) return undefined;

  // Check it hasn't been acked already
  const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
  if (acked) return undefined;

  return response;
}
