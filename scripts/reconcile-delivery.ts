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
  (messageId && !['--confirmed-delivered', '--confirmed-not-delivered'].includes(confirmation)) ||
  (!messageId && confirmation)
) {
  console.error(
    'Usage: reconcile-delivery.ts /absolute/path/inbound.db [MESSAGE_ID --confirmed-delivered|--confirmed-not-delivered]',
  );
  process.exit(2);
}
const db = new Database(dbPath, { fileMustExist: true });
try {
  if (!messageId) {
    const rows = db
      .prepare(
        "SELECT message_out_id, state, attempts, last_error FROM delivery_attempts WHERE state IN ('unknown', 'failed') ORDER BY message_out_id",
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
      if (confirmation === '--confirmed-delivered') {
        db.prepare(
          "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'delivered', datetime('now'))",
        ).run(messageId);
      }
      if (confirmation === '--confirmed-delivered') {
        db.prepare('DELETE FROM delivery_attempts WHERE message_out_id = ?').run(messageId);
      } else {
        db.prepare(
          "UPDATE delivery_attempts SET state='retry', attempts=0, next_attempt_ms=0, last_error='', first_attempt_ms=?, updated_at_ms=? WHERE message_out_id=?",
        ).run(Date.now(), Date.now(), messageId);
      }
    });
    reconcile.immediate();
    if (confirmation === '--confirmed-delivered') {
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
