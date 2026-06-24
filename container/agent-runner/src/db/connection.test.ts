import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { ensureOutboundSchema } from './connection.js';

/**
 * Regression coverage for the `no such table: messages_out` failure.
 *
 * The container is the sole writer of outbound.db. Some paths open it without a
 * guarantee that the host pre-seeded the base tables (an operator/fork container
 * that never ran through the host session-manager, or a startup-order race).
 * When `messages_out` is missing, every outbound write — including the
 * apply_managed_repos / push_managed_repo enqueue and send_message — throws
 * `no such table: messages_out`, which the agent sees as a false failure.
 * ensureOutboundSchema must make the connection self-sufficient.
 */
describe('ensureOutboundSchema', () => {
  test('creates the base tables on an un-seeded outbound.db so writes succeed', () => {
    const db = new Database(':memory:');

    expect(() => ensureOutboundSchema(db)).not.toThrow();

    // This is the exact query writeMessageOut() runs first; it threw
    // `no such table: messages_out` before the fix.
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number };
    expect(maxSeq.m).toBe(0);

    // A full-shape insert (matching writeMessageOut's column list) must succeed,
    // proving the table has the route metadata columns too.
    db.prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, input_id, route_key, messaging_group_id, is_group, content)
       VALUES ('m1', 1, NULL, datetime('now'), NULL, NULL, 'system', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}')`,
    ).run();
    const count = db.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };
    expect(count.c).toBe(1);

    // processing_ack (the other host-authoritative base table) must exist too.
    expect(() => db.prepare('SELECT COUNT(*) FROM processing_ack').get()).not.toThrow();
  });

  test('is idempotent and preserves existing rows', () => {
    const db = new Database(':memory:');
    ensureOutboundSchema(db);
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, content)
       VALUES ('m1', 1, datetime('now'), 'chat', '{}')`,
    ).run();

    expect(() => ensureOutboundSchema(db)).not.toThrow();

    const count = db.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };
    expect(count.c).toBe(1);
  });

  test('self-migrates an old messages_out that predates the route columns', () => {
    const db = new Database(':memory:');
    // Simulate a pre-route-metadata outbound.db: messages_out without the
    // input_id / route_key / messaging_group_id / is_group columns.
    db.exec(`
      CREATE TABLE messages_out (
        id          TEXT PRIMARY KEY,
        seq         INTEGER UNIQUE,
        in_reply_to TEXT,
        timestamp   TEXT NOT NULL,
        deliver_after TEXT,
        recurrence  TEXT,
        kind        TEXT NOT NULL,
        platform_id TEXT,
        channel_type TEXT,
        thread_id   TEXT,
        content     TEXT NOT NULL
      );
      CREATE TABLE processing_ack (
        message_id     TEXT PRIMARY KEY,
        status         TEXT NOT NULL,
        status_changed TEXT NOT NULL
      );
    `);

    ensureOutboundSchema(db);

    const outCols = new Set(
      (db.prepare("PRAGMA table_info('messages_out')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ['input_id', 'route_key', 'messaging_group_id', 'is_group']) {
      expect(outCols.has(col)).toBe(true);
    }

    const ackCols = new Set(
      (db.prepare("PRAGMA table_info('processing_ack')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(ackCols.has('notice_message_out_id')).toBe(true);
  });
});
