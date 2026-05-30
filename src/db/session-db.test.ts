/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import {
  countDueMessages,
  countDueMessagesExcludingRecovery,
  ensureSchema,
  importHostSideEffects,
  insertMessage,
  migrateMessagesInTable,
  syncProcessingAcks,
  upsertSessionRouting,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function freshDir(): { dir: string } {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  return { dir: TEST_DIR };
}

function inboundDb(): Database.Database {
  const db = new Database(path.join(TEST_DIR, 'inbound.db'));
  db.exec(INBOUND_SCHEMA);
  return db;
}

function outboundDb(): Database.Database {
  const db = new Database(path.join(TEST_DIR, 'outbound.db'));
  db.exec(OUTBOUND_SCHEMA);
  return db;
}

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds platform_message_id and only backfills routed Discord rows', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
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
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, '{}')`,
    ).run('111122223333444455:ag-discord-test-agent', 2, '987654321098765432', 'discord');
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, '{}')`,
    ).run('6037840640:42', 4, 'telegram-chat', 'telegram');

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const rows = db.prepare('SELECT id, platform_message_id FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      platform_message_id: string | null;
    }>;
    expect(rows).toEqual([
      {
        id: '111122223333444455:ag-discord-test-agent',
        platform_message_id: '111122223333444455',
      },
      {
        id: '6037840640:42',
        platform_message_id: null,
      },
    ]);
    db.close();
  });
});

// ── Task 1: route metadata persistence ──────────────────────────────────────

describe('route metadata persistence', () => {
  it('insertMessage persists messaging_group_id and is_group', () => {
    freshDir();
    const db = inboundDb();
    insertMessage(db, {
      id: 'm1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      content: '{"text":"hi"}',
      processAfter: null,
      recurrence: null,
      messagingGroupId: 'mg-dm-1',
      isGroup: 0,
    });
    const row = db.prepare('SELECT messaging_group_id, is_group FROM messages_in WHERE id = ?').get('m1') as {
      messaging_group_id: string | null;
      is_group: number | null;
    };
    expect(row.messaging_group_id).toBe('mg-dm-1');
    expect(row.is_group).toBe(0);
    db.close();
  });

  it('insertMessage leaves route metadata null when not supplied', () => {
    freshDir();
    const db = inboundDb();
    insertMessage(db, {
      id: 'm-legacy',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      content: '{"text":"hi"}',
      processAfter: null,
      recurrence: null,
    });
    const row = db.prepare('SELECT messaging_group_id, is_group FROM messages_in WHERE id = ?').get('m-legacy') as {
      messaging_group_id: string | null;
      is_group: number | null;
    };
    expect(row.messaging_group_id).toBeNull();
    expect(row.is_group).toBeNull();
    db.close();
  });

  it('upsertSessionRouting stores messaging_group_id and is_group', () => {
    freshDir();
    const db = inboundDb();
    upsertSessionRouting(db, {
      channel_type: 'discord',
      platform_id: 'chan-1',
      thread_id: null,
      messaging_group_id: 'mg-dm-1',
      is_group: 0,
    });
    const row = db.prepare('SELECT messaging_group_id, is_group FROM session_routing WHERE id = 1').get() as {
      messaging_group_id: string | null;
      is_group: number | null;
    };
    expect(row.messaging_group_id).toBe('mg-dm-1');
    expect(row.is_group).toBe(0);
    db.close();
  });

  it('ensureSchema ALTERs legacy inbound DBs to add route columns idempotently', () => {
    freshDir();
    const legacyPath = path.join(TEST_DIR, 'inbound.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
        status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT,
        tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT,
        platform_message_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
      );
      CREATE TABLE session_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT
      );
    `);
    legacy.close();

    ensureSchema(legacyPath, 'inbound');
    ensureSchema(legacyPath, 'inbound'); // idempotent

    const db = new Database(legacyPath);
    const inCols = new Set(
      (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const routeCols = new Set(
      (db.prepare("PRAGMA table_info('session_routing')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(inCols.has('messaging_group_id')).toBe(true);
    expect(inCols.has('is_group')).toBe(true);
    expect(routeCols.has('messaging_group_id')).toBe(true);
    expect(routeCols.has('is_group')).toBe(true);
    db.close();
  });
});

// ── Task 1: host due-count excludes recovery-owned rows ──────────────────────

describe('countDueMessagesExcludingRecovery', () => {
  it('excludes rows whose processing_ack.status is recovery but still counts truly pending rows', () => {
    freshDir();
    const inDb = inboundDb();
    const outDb = outboundDb();

    const now = new Date().toISOString();
    insertMessage(inDb, {
      id: 'pending-1',
      kind: 'chat',
      timestamp: now,
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"a"}',
      processAfter: null,
      recurrence: null,
    });
    insertMessage(inDb, {
      id: 'recovery-1',
      kind: 'chat',
      timestamp: now,
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"b"}',
      processAfter: null,
      recurrence: null,
    });

    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'recovery', datetime('now'))",
      )
      .run('recovery-1');

    // Naive inbound-only due count would see both as pending.
    expect(countDueMessages(inDb)).toBe(2);
    // Outbound-aware count excludes the recovery-owned row.
    expect(countDueMessagesExcludingRecovery(inDb, outDb)).toBe(1);

    inDb.close();
    outDb.close();
  });
});

// ── Task 1: syncProcessingAcks failed-gate + recovery preservation ───────────

describe('syncProcessingAcks failed-ack notice gate', () => {
  it('completes a failed ack only when notice_message_out_id points at an existing notice row', () => {
    freshDir();
    const inDb = inboundDb();
    const outDb = outboundDb();
    const now = new Date().toISOString();

    for (const id of ['has-notice', 'no-notice', 'recovery-row', 'completed-row']) {
      insertMessage(inDb, {
        id,
        kind: 'chat',
        timestamp: now,
        platformId: null,
        channelType: null,
        threadId: null,
        content: '{"text":"x"}',
        processAfter: null,
        recurrence: null,
      });
    }

    // A user-visible terminal notice row exists for has-notice.
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('notice-1', 1, datetime('now'), 'chat', '{"text":"failed, retry"}')`,
      )
      .run();
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed, notice_message_out_id) VALUES ('has-notice', 'failed', datetime('now'), 'notice-1')",
      )
      .run();
    // failed without a linked notice — invalid, must NOT complete.
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('no-notice', 'failed', datetime('now'))",
      )
      .run();
    // recovery-owned must be preserved, never completed.
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('recovery-row', 'recovery', datetime('now'))",
      )
      .run();
    // ordinary completed.
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('completed-row', 'completed', datetime('now'))",
      )
      .run();

    syncProcessingAcks(inDb, outDb);

    const statusOf = (id: string) =>
      (inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;

    expect(statusOf('completed-row')).toBe('completed');
    expect(statusOf('has-notice')).toBe('completed');
    expect(statusOf('no-notice')).toBe('pending'); // invalid failed ack, not completed
    expect(statusOf('recovery-row')).toBe('pending'); // recovery-owned, never synced to completed

    inDb.close();
    outDb.close();
  });
});

// ── Task 1: host side-effect import requires verified container stop ─────────

describe('importHostSideEffects container-stop gate', () => {
  function writeLedger(sessionDir: string, lines: object[]): string {
    fs.mkdirSync(sessionDir, { recursive: true });
    const p = path.join(sessionDir, 'side-effects.jsonl');
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return p;
  }

  it('refuses to open the outbound DB writable while the container is still running', () => {
    freshDir();
    const sessionPath = path.join(TEST_DIR, 'sess');
    fs.mkdirSync(sessionPath, { recursive: true });
    const outPath = path.join(sessionPath, 'outbound.db');
    const out = new Database(outPath);
    out.exec(OUTBOUND_SCHEMA);
    out.close();
    writeLedger(sessionPath, [
      { kind: 'summarize_dnd_summary_artifact', audit_id: 'a1', occurred_at: new Date().toISOString() },
    ]);

    expect(() => importHostSideEffects({ sessionDir: sessionPath, containerStopped: false })).toThrow(/container/i);
  });

  it('imports validated records idempotently into side_effect_ledger when container is stopped', () => {
    freshDir();
    const sessionPath = path.join(TEST_DIR, 'sess');
    fs.mkdirSync(sessionPath, { recursive: true });
    const outPath = path.join(sessionPath, 'outbound.db');
    const out = new Database(outPath);
    out.exec(OUTBOUND_SCHEMA);
    out.close();

    const artifactRoot = path.join(TEST_DIR, 'artifacts');
    fs.mkdirSync(artifactRoot, { recursive: true });
    const artifactPath = path.join(artifactRoot, 'summary-5-19.md');
    fs.writeFileSync(artifactPath, 'SUMMARY BODY');
    const sizeBytes = fs.statSync(artifactPath).size;

    writeLedger(sessionPath, [
      {
        kind: 'summarize_dnd_summary_artifact',
        audit_id: 'run-5-19',
        operation: 'summarize',
        occurred_at: new Date().toISOString(),
        evidence: { artifact_path: artifactPath, size_bytes: sizeBytes },
      },
    ]);

    const r1 = importHostSideEffects({
      sessionDir: sessionPath,
      containerStopped: true,
      allowedArtifactRoots: [artifactRoot],
    });
    const r2 = importHostSideEffects({
      sessionDir: sessionPath,
      containerStopped: true,
      allowedArtifactRoots: [artifactRoot],
    });

    expect(r1.imported).toBe(1);
    expect(r2.imported).toBe(0); // idempotent: same audit_id is not re-imported

    const verify = new Database(outPath, { readonly: true });
    const count = (verify.prepare('SELECT COUNT(*) AS c FROM side_effect_ledger').get() as { c: number }).c;
    expect(count).toBe(1);
    verify.close();
  });
});
