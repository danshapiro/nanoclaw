/** Inspect or reconcile a quarantined outbound message after checking the platform.
 * Usage: pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db
 *        pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db MESSAGE_ID --confirmed-delivered
 *        pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/inbound.db MESSAGE_ID --confirmed-not-delivered
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

const [, , dbPath, messageId, confirmation, ...extra] = process.argv;
const obsoleteSmoke = confirmation === '--confirmed-obsolete-cli-smoke';
if (
  !dbPath ||
  !path.isAbsolute(dbPath) ||
  (obsoleteSmoke ? extra.length !== 1 || !/^[a-f0-9]{64}$/.test(extra[0] ?? '') : extra.length > 0) ||
  (messageId &&
    ![
      '--confirmed-delivered',
      '--confirmed-not-delivered',
      '--confirmed-obsolete-progress',
      '--confirmed-obsolete-cli-smoke',
    ].includes(confirmation)) ||
  (!messageId && confirmation)
) {
  console.error(
    'Usage: reconcile-delivery.ts /absolute/path/inbound.db [MESSAGE_ID --confirmed-delivered|--confirmed-not-delivered|--confirmed-obsolete-progress|--confirmed-obsolete-cli-smoke CONTENT_SHA256]',
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
    if (confirmation === '--confirmed-not-delivered' || obsoleteSmoke) {
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
      if (obsoleteSmoke) {
        // Explicit retirement of one abandoned harness response, never a general
        // discard switch. Bind the operator's selection to its exact payload;
        // protect real routes, live workers and any attached scheduled work.
        const session = db
          .prepare(
            'SELECT messaging_group_id, thread_id, container_status FROM runtime.sessions WHERE id=? AND agent_group_id=?',
          )
          .get(sessionId, agentId) as
          | { messaging_group_id: string; thread_id: string | null; container_status: string }
          | undefined;
        const group = session
          ? (db
              .prepare('SELECT channel_type, platform_id, is_group FROM runtime.messaging_groups WHERE id=?')
              .get(session.messaging_group_id) as
              | { channel_type: string; platform_id: string; is_group: number }
              | undefined)
          : undefined;
        if (
          !session ||
          session.container_status !== 'stopped' ||
          session.thread_id !== null ||
          !session.messaging_group_id?.startsWith('mg-cli-smoke-') ||
          group?.channel_type !== 'cli' ||
          group.is_group !== 0 ||
          !/^cli-smoke:[A-Za-z0-9_-]+:[0-9]{13}-[a-z0-9]+$/.test(group.platform_id)
        ) {
          throw new Error('Only a stopped isolated CLI smoke route may be retired; quarantine retained');
        }
        const work = db
          .prepare(
            'SELECT 1 FROM runtime.scheduled_tasks WHERE messaging_group_id=? OR projected_session_id=? OR created_by_session_id=? OR updated_by_session_id=? LIMIT 1',
          )
          .get(session.messaging_group_id, sessionId, sessionId, sessionId);
        if (work) throw new Error('Smoke route owns scheduled work; quarantine retained');
        const outbound = new Database(path.join(sessionDir, 'outbound.db'), { readonly: true, fileMustExist: true });
        try {
          const message = outbound.prepare('SELECT * FROM messages_out WHERE id=?').get(messageId) as
            | {
                kind: string;
                content: string;
                timestamp: string;
                channel_type: string;
                platform_id: string;
                messaging_group_id: string;
                thread_id: string | null;
                input_id: string | null;
                route_key: string;
                is_group: number;
              }
            | undefined;
          const content = message ? JSON.parse(message.content) : null;
          const age = message ? Date.now() - Date.parse(message.timestamp.replace(' ', 'T') + 'Z') : NaN;
          const route = message?.route_key?.split('|');
          if (
            !message ||
            message.kind !== 'chat' ||
            message.channel_type !== 'cli' ||
            message.is_group !== 0 ||
            message.platform_id !== group.platform_id ||
            message.messaging_group_id !== session.messaging_group_id ||
            message.thread_id !== null ||
            message.input_id !== null ||
            !route ||
            route.length !== 4 ||
            !route[0] ||
            route[1] !== 'cli' ||
            route[2] !== group.platform_id ||
            route[3] !== `dm:${session.messaging_group_id}` ||
            !content ||
            typeof content !== 'object' ||
            Array.isArray(content) ||
            Object.keys(content).length !== 1 ||
            typeof content.text !== 'string' ||
            !content.text.trim() ||
            !Number.isFinite(age) ||
            age < 24 * 60 * 60 * 1000 ||
            createHash('sha256').update(message.content).digest('hex') !== extra[0]
          ) {
            throw new Error('Exact old text-only CLI smoke payload and route proof required; quarantine retained');
          }
        } finally {
          outbound.close();
        }
      }
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
      if (confirmation === '--confirmed-obsolete-progress' || obsoleteSmoke) {
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
    if (obsoleteSmoke) {
      console.log(
        `Retired obsolete CLI smoke ${messageId} with status dropped; no send or delivery claim. Original outbound retained.`,
      );
    } else if (confirmation === '--confirmed-obsolete-progress') {
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
