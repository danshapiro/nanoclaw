/** Inspect or reconcile a quarantined outbound message after checking the platform.
 * Usage: pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db
 *        pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db MESSAGE_ID --confirmed-delivered
 *        pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db MESSAGE_ID --confirmed-not-delivered
 */
import Database from 'better-sqlite3';
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
    db.transaction(() => {
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
      db.prepare('DELETE FROM delivery_attempts WHERE message_out_id = ?').run(messageId);
    })();
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
