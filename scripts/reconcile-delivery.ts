/** Inspect or reconcile a quarantined outbound message after checking the platform.
 * Usage: pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db
 *        pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db MESSAGE_ID --confirmed-delivered
 *        pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db MESSAGE_ID --confirmed-not-delivered
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const [, , dbPath, messageId, confirmation, ...extra] = process.argv;
if (
  !dbPath ||
  !path.isAbsolute(dbPath) ||
  extra.length ||
  (messageId &&
    !['--confirmed-delivered', '--confirmed-not-delivered', '--confirmed-obsolete-progress'].includes(confirmation)) ||
  (!messageId && confirmation)
) {
  console.error(
    'Usage: reconcile-delivery.ts /absolute/path/inbound.db [MESSAGE_ID --confirmed-delivered|--confirmed-not-delivered|--confirmed-obsolete-progress]',
  );
  process.exit(2);
}
const db = new Database(dbPath, { fileMustExist: true });
try {
  if (!messageId) {
    const rows = db
      .prepare(
        "SELECT message_out_id, state, attempts, last_error FROM delivery_attempts a WHERE state IN ('unknown', 'failed') AND NOT EXISTS (SELECT 1 FROM delivered d WHERE d.message_out_id=a.message_out_id AND d.status IN ('delivered','dropped')) ORDER BY message_out_id",
      )
      .all();
    console.log(JSON.stringify(rows, null, 2));
  } else {
    // Requeueing requires a live source session: archived sessions are not
    // polled and would silently strand the row. Lock both databases through
    // the check and update so archive cannot race that decision.
    const sessionDir = path.dirname(dbPath);
    const agentDir = path.dirname(sessionDir);
    const sessionsDir = path.dirname(agentDir);
    const sessionId = path.basename(sessionDir);
    const agentId = path.basename(agentDir);
    if (confirmation === '--confirmed-not-delivered') {
      if (path.basename(sessionsDir) !== 'v2-sessions' || path.basename(dbPath) !== 'inbound.db') {
        throw new Error('Expected an inbound.db under DATA_DIR/v2-sessions/<agent>/<session>');
      }
      const centralDb = path.join(path.dirname(sessionsDir), 'v2.db');
      if (!fs.existsSync(centralDb)) throw new Error('Cannot verify session status: central v2.db is missing');
      db.prepare('ATTACH DATABASE ? AS runtime').run(centralDb);
      db.pragma('busy_timeout = 1000');
    }
    // Operator-only retirement of obsolete keepalives. Never discard substantive
    // messages/files/edits or claim an ambiguous message reached its destination.
    if (confirmation === '--confirmed-obsolete-progress') {
      if (path.basename(sessionsDir) !== 'v2-sessions' || path.basename(dbPath) !== 'inbound.db') {
        throw new Error('Expected an inbound.db under DATA_DIR/v2-sessions/<agent>/<session>');
      }
      const outbound = new Database(path.join(sessionDir, 'outbound.db'), { readonly: true, fileMustExist: true });
      try {
        const message = outbound
          .prepare('SELECT kind, content, timestamp FROM messages_out WHERE id = ?')
          .get(messageId) as { kind: string; content: string; timestamp: string } | undefined;
        const content = message ? JSON.parse(message.content) : null;
        const age = message ? Date.now() - Date.parse(message.timestamp.replace(' ', 'T') + 'Z') : NaN;
        if (
          message?.kind !== 'chat' ||
          !content ||
          typeof content !== 'object' ||
          Array.isArray(content) ||
          Object.keys(content).length !== 1 ||
          content.text !== "I'm still working on your request." ||
          !Number.isFinite(age) ||
          age < 24 * 60 * 60 * 1000
        ) {
          throw new Error('Only exact progress-only keepalives older than 24h may be retired; quarantine retained');
        }
      } finally {
        outbound.close();
      }
    }
    const reconcile = db.transaction(() => {
      if (confirmation === '--confirmed-not-delivered') {
        const session = db
          .prepare('SELECT status FROM runtime.sessions WHERE id = ? AND agent_group_id = ?')
          .get(sessionId, agentId) as { status: string } | undefined;
        if (session?.status !== 'active')
          throw new Error('Cannot requeue: source session is inactive or missing; quarantine retained');
      }
      const row = db.prepare('SELECT state FROM delivery_attempts WHERE message_out_id = ?').get(messageId) as
        | { state: string }
        | undefined;
      if (!row || !['unknown', 'failed'].includes(row.state)) throw new Error('Message is not quarantined');
      db.prepare("DELETE FROM delivered WHERE message_out_id = ? AND status = 'failed'").run(messageId);
      const delivered = db.prepare('SELECT 1 FROM delivered WHERE message_out_id = ?').get(messageId);
      if (delivered) throw new Error('Message already has a successful delivery receipt');
      if (confirmation === '--confirmed-obsolete-progress') {
        db.prepare(
          "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'dropped', datetime('now'))",
        ).run(messageId);
      }
      if (confirmation === '--confirmed-delivered') {
        db.prepare(
          "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'delivered', datetime('now'))",
        ).run(messageId);
      }
      // Keep unknown/failed as a terminal refusal guard: an active poller may
      // hold a stale delivered-ID snapshot while awaiting an earlier message.
      // The terminal receipt resolves the incident, not deletion of this guard.
      if (confirmation === '--confirmed-not-delivered') {
        db.prepare(
          "UPDATE delivery_attempts SET state='retry', attempts=0, next_attempt_ms=0, last_error='', first_attempt_ms=?, updated_at_ms=? WHERE message_out_id=?",
        ).run(Date.now(), Date.now(), messageId);
      }
    });
    reconcile.immediate();
    if (confirmation === '--confirmed-obsolete-progress') {
      console.log(
        `Retired obsolete progress ${messageId} with status dropped; no send or delivery claim. Original outbound retained.`,
      );
    } else if (confirmation === '--confirmed-delivered') {
      console.log(
        `Recorded ${messageId} as delivered without resending. Its outbox files were retained for operator cleanup.`,
      );
    } else {
      console.log(`Requeued ${messageId}; the active delivery poll will retry it.`);
    }
  }
} finally {
  db.close();
}
