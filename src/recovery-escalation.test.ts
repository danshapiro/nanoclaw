import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const written: Array<Record<string, unknown>> = [];
const incidents: Array<Record<string, unknown>> = [];
let sharedOutDb: Database.Database;

function nonClosing(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'close') return () => {};
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database.Database;
}

vi.mock('./session-manager.js', () => ({
  writeOutboundDirect: vi.fn((_ag: string, _sid: string, message: Record<string, unknown>) => {
    written.push(message);
    sharedOutDb
      .prepare(
        `INSERT OR IGNORE INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.kind, message.platformId, message.channelType, message.threadId, message.content);
  }),
  openOutboundDbRw: vi.fn(() => nonClosing(sharedOutDb)),
}));

vi.mock('./yente/scheduler-alerts.js', () => ({
  reportSchedulerIncident: vi.fn(async (args: Record<string, unknown>) => {
    incidents.push(args);
    return true;
  }),
}));

import { releaseOrEscalateExpiredRecoveryAcks } from './recovery-escalation.js';
import {
  countDueMessagesExcludingRecovery,
  getRecoveryWakeAttempts,
  listGwsUncertainInputIds,
  syncProcessingAcks,
} from './db/session-db.js';

const session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: null,
} as never; // cast to Session; the pass only reads id/agent_group_id/messaging_group_id/thread_id

function makeDbs() {
  const inDb = new Database(':memory:');
  inDb.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'chat', timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending', trigger INTEGER NOT NULL DEFAULT 1, process_after TEXT,
    tries INTEGER DEFAULT 0, recovery_wake_attempts INTEGER NOT NULL DEFAULT 0,
    channel_type TEXT, platform_id TEXT, thread_id TEXT, host_accepted_input_id TEXT)`);
  const outDb = new Database(':memory:');
  outDb.exec(`CREATE TABLE processing_ack (
      message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL,
      notice_message_out_id TEXT, claim_token TEXT);
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, seq INTEGER, timestamp TEXT, kind TEXT,
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT);
    CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  sharedOutDb = outDb;
  return { inDb, outDb };
}

const TTL = 30 * 60 * 1000;
const NOW = Date.parse('2026-04-20T12:00:00Z');
const OLD = '2026-04-20 10:00:00'; // 2h before NOW

function reOwn(outDb: Database.Database, id: string): void {
  outDb
    .prepare("INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'recovery', ?)")
    .run(id, OLD);
}

beforeEach(() => {
  written.length = 0;
  incidents.length = 0;
});

describe('releaseOrEscalateExpiredRecoveryAcks', () => {
  it('leaves fresh recovery acks alone', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, channel_type, platform_id) VALUES ('m-1', 'discord', 'chan-1')").run();
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-1', 'recovery', datetime('now'))",
      )
      .run();
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session,
      inDb,
      outDb,
      nowMs: NOW,
      ttlMs: TTL,
      maxAttempts: 3,
    });
    expect(outcome).toEqual({ released: [], escalated: [] });
    expect(written).toHaveLength(0);
  });

  it('releases, then escalates: nothing hides behind a recovery ack past TTL*K (the R2 invariant)', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, channel_type, platform_id) VALUES ('m-1', 'discord', 'chan-1')").run();

    // Sweeps 1..3: each finds the (re-owned) expired ack and releases it.
    for (let pass = 1; pass <= 3; pass++) {
      reOwn(outDb, 'm-1');
      const outcome = await releaseOrEscalateExpiredRecoveryAcks({
        session,
        inDb,
        outDb,
        nowMs: NOW,
        ttlMs: TTL,
        maxAttempts: 3,
      });
      expect(outcome.released).toEqual(['m-1']);
      expect(outcome.escalated).toEqual([]);
      // Ack deleted -> row is visible pending work again (this is what makes the wake useful).
      expect(outDb.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE message_id = 'm-1'").get()).toMatchObject({
        n: 0,
      });
      expect(getRecoveryWakeAttempts(inDb, 'm-1')).toBe(pass);
    }

    // Sweep 4: attempts exhausted -> loud terminal failure.
    reOwn(outDb, 'm-1');
    const final = await releaseOrEscalateExpiredRecoveryAcks({
      session,
      inDb,
      outDb,
      nowMs: NOW,
      ttlMs: TTL,
      maxAttempts: 3,
    });
    expect(final.escalated).toEqual(['m-1']);

    const ack = outDb
      .prepare("SELECT status, notice_message_out_id FROM processing_ack WHERE message_id = 'm-1'")
      .get() as {
      status: string;
      notice_message_out_id: string;
    };
    expect(ack.status).toBe('failed');
    expect(ack.notice_message_out_id).toBe('recovery-escalation-m-1');
    // The notice row exists and carries the inbound row's routing -> this is
    // exactly the failedAckHasTerminalNotice contract plus deliverability.
    const notice = outDb
      .prepare("SELECT id, channel_type, platform_id FROM messages_out WHERE id = 'recovery-escalation-m-1'")
      .get();
    expect(notice).toMatchObject({ channel_type: 'discord', platform_id: 'chan-1' });
    // Inbound row terminally failed -> no longer due, never silently retried.
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get()).toMatchObject({ status: 'failed' });
    expect(countDueMessagesExcludingRecovery(inDb, outDb, { nowMs: NOW, recoveryWakeTtlMs: TTL })).toBe(0);
    // Error incident recorded with a stable dedupe key.
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ severity: 'error', dedupeKey: 'recovery-escalation:sess-1:m-1' });
  });

  it('supersedes the owning session_state recovery entries on escalation (no zombie context injection)', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, recovery_wake_attempts) VALUES ('m-1', 3)").run();
    reOwn(outDb, 'm-1');
    outDb
      .prepare(
        "INSERT INTO session_state (key, value, updated_at) VALUES ('recovery:test:route-1', ?, datetime('now'))",
      )
      .run(
        JSON.stringify([
          { id: 'rec-1', status: 'pending', originalTasks: [{ messageId: 'm-1', text: 'do it', timestamp: 't' }] },
          { id: 'rec-2', status: 'pending', originalTasks: [{ messageId: 'other', text: 'x', timestamp: 't' }] },
        ]),
      );
    await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    const entries = JSON.parse(
      (outDb.prepare("SELECT value FROM session_state WHERE key = 'recovery:test:route-1'").get() as { value: string })
        .value,
    ) as Array<{ id: string; status: string }>;
    expect(entries.find((e) => e.id === 'rec-1')?.status).toBe('superseded');
    expect(entries.find((e) => e.id === 'rec-2')?.status).toBe('pending');
  });

  it('uses task-flavored notice text for kind=task rows', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id, kind, recovery_wake_attempts) VALUES ('m-t', 'task', 3)").run();
    reOwn(outDb, 'm-t');
    await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0].content as string).text).toContain('scheduled task');
  });

  it('escalates (never releases) an expired ack whose original input is GWS-uncertain, at attempts=0', async () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, channel_type, platform_id, host_accepted_input_id) VALUES ('m-g', 'discord', 'chan-1', 'input-9')",
      )
      .run();
    reOwn(outDb, 'm-g');
    // Reconciliation store: one outcome_unknown incident for input-9, no resolution.
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-')), 'store.jsonl');
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ schema_version: 2, audit_id: 'a-1', outcome: 'outcome_unknown', input_id: 'input-9', route_key: 'r', account: 'acct', operation: 'op', resource_type: 'doc', started_at: '2026-04-20T09:00:00Z', ended_at: '2026-04-20T09:00:01Z' })}\n`,
    );
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session,
      inDb,
      outDb,
      nowMs: NOW,
      ttlMs: TTL,
      maxAttempts: 3,
      reconciliationStorePath: storePath,
    });
    // The gate, not exhaustion: attempts were 0 and it still escalated.
    expect(outcome).toEqual({ released: [], escalated: ['m-g'] });
    expect(outDb.prepare("SELECT status FROM processing_ack WHERE message_id = 'm-g'").get()).toMatchObject({
      status: 'failed',
    });
    expect(incidents[0].details).toMatchObject({ gwsUncertainInputId: 'input-9' });
  });

  it('defers the whole pass loudly when a configured reconciliation store is unreadable', async () => {
    const { inDb, outDb } = makeDbs();
    inDb.prepare("INSERT INTO messages_in (id) VALUES ('m-u')").run();
    reOwn(outDb, 'm-u');
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session,
      inDb,
      outDb,
      nowMs: NOW,
      ttlMs: TTL,
      maxAttempts: 3,
      reconciliationStorePath: '/nonexistent-but-configured/store.jsonl',
    });
    // Neither released (unsafe) nor escalated (unfair): ack untouched, retried next sweep.
    expect(outcome).toEqual({ released: [], escalated: [] });
    expect(outDb.prepare("SELECT status FROM processing_ack WHERE message_id = 'm-u'").get()).toMatchObject({
      status: 'recovery',
    });
  });

  it('defers the whole pass loudly when an incident record has a missing audit_id (gate fails CLOSED)', async () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, channel_type, platform_id, host_accepted_input_id) VALUES ('m-a', 'discord', 'chan-1', 'input-7')",
      )
      .run();
    reOwn(outDb, 'm-a');
    // Incident record with NO audit_id: unmatchable against resolutions, so it
    // must throw/defer -- never fall out of the uncertain set and release.
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-')), 'store.jsonl');
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ schema_version: 2, outcome: 'outcome_unknown', input_id: 'input-7' })}\n`,
    );
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session,
      inDb,
      outDb,
      nowMs: NOW,
      ttlMs: TTL,
      maxAttempts: 3,
      reconciliationStorePath: storePath,
    });
    // Deferred like the unreadable-store case: ack untouched, retried next sweep.
    expect(outcome).toEqual({ released: [], escalated: [] });
    expect(outDb.prepare("SELECT status FROM processing_ack WHERE message_id = 'm-a'").get()).toMatchObject({
      status: 'recovery',
    });
  });

  it('listGwsUncertainInputIds fails closed on duplicate incident audit_ids (never overwrites)', () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-')), 'store.jsonl');
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ audit_id: 'a-1', input_id: 'input-1' })}\n${JSON.stringify({ audit_id: 'a-1', input_id: 'input-2' })}\n`,
    );
    expect(() => listGwsUncertainInputIds(storePath)).toThrow(/duplicate incident records for audit_id/);
  });

  it('releases normally when the original input has an incident WITH a matching resolution (happy path)', async () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, channel_type, platform_id, host_accepted_input_id) VALUES ('m-r', 'discord', 'chan-1', 'input-9')",
      )
      .run();
    reOwn(outDb, 'm-r');
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-')), 'store.jsonl');
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ schema_version: 2, audit_id: 'a-1', outcome: 'outcome_unknown', input_id: 'input-9' })}\n${JSON.stringify({ record_type: 'resolution', audit_id: 'a-1' })}\n`,
    );
    const outcome = await releaseOrEscalateExpiredRecoveryAcks({
      session,
      inDb,
      outDb,
      nowMs: NOW,
      ttlMs: TTL,
      maxAttempts: 3,
      reconciliationStorePath: storePath,
    });
    expect(outcome).toEqual({ released: ['m-r'], escalated: [] });
    expect(outDb.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE message_id = 'm-r'").get()).toMatchObject({
      n: 0,
    });
  });

  it("keeps the escalated inbound status 'failed' after syncProcessingAcks runs (durability, V6 residue)", async () => {
    const { inDb, outDb } = makeDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, channel_type, platform_id, recovery_wake_attempts) VALUES ('m-1', 'discord', 'chan-1', 3)",
      )
      .run();
    reOwn(outDb, 'm-1');
    await releaseOrEscalateExpiredRecoveryAcks({ session, inDb, outDb, nowMs: NOW, ttlMs: TTL, maxAttempts: 3 });
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get()).toMatchObject({ status: 'failed' });
    // One sweep later, step 1 must NOT rewrite the terminal 'failed' to 'completed'.
    syncProcessingAcks(inDb, outDb);
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get()).toMatchObject({ status: 'failed' });
  });
});
