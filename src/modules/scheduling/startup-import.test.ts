import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { acquireRuntimeLock, releaseRuntimeLock } from '../../db/runtime-locks.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import { getScheduledTask } from './ledger.js';
import { reconcileLegacyTaskImportsOnStartup } from './startup-import.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-startup-import' };
});

const TEST_DIR = '/tmp/nanoclaw-test-startup-import';
const STALE = '2026-01-01T00:00:00.000Z'; // far outside SWEEP_RECENCY_WINDOW_MS

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'channel',
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('startup legacy-task import reconciliation', () => {
  it('imports legacy future tasks from an active session too stale for the bounded sweep', async () => {
    createSession({
      id: 'sess-stale-legacy',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: STALE, // >30d stale — getSweepableSessions never yields it
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-stale-legacy');

    // A legacy pre-ledger task row: kind='task', live status, far-future
    // due date, and NO central scheduled_tasks row.
    const inDb = openInboundDb('ag-yente', 'sess-stale-legacy');
    try {
      inDb
        .prepare(
          `INSERT INTO messages_in
             (id, seq, kind, timestamp, status, process_after, recurrence, trigger,
              platform_id, channel_type, thread_id, messaging_group_id, is_group, content, series_id)
           VALUES (?, 2, 'task', ?, 'pending', '2099-01-01T00:00:00.000Z', NULL, 1,
              'channel', 'discord', 'thread-1', 'mg-discord', 1, ?, 'series-legacy')`,
        )
        .run('legacy-task-1', STALE, JSON.stringify({ prompt: 'future heartbeat', script: null }));
    } finally {
      inDb.close();
    }
    expect(getScheduledTask('ag-yente', 'series-legacy')).toBeUndefined();

    const summary = await reconcileLegacyTaskImportsOnStartup();

    expect(summary).toEqual({ scanned: 1, imported: 1, failed: 0 });
    expect(getScheduledTask('ag-yente', 'series-legacy')).toMatchObject({
      series_id: 'series-legacy',
      status: 'pending',
      process_after: '2099-01-01T00:00:00.000Z',
    });
  });

  it('retries a session whose first attempt hits a held scheduler-mutator lock instead of failing it', async () => {
    createSession({
      id: 'sess-contended',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-3',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-contended');
    const inDb = openInboundDb('ag-yente', 'sess-contended');
    try {
      inDb
        .prepare(
          `INSERT INTO messages_in
             (id, seq, kind, timestamp, status, process_after, recurrence, trigger,
              platform_id, channel_type, thread_id, messaging_group_id, is_group, content, series_id)
           VALUES (?, 2, 'task', ?, 'pending', '2099-01-01T00:00:00.000Z', NULL, 1,
              'channel', 'discord', 'thread-3', 'mg-discord', 1, ?, 'series-contended')`,
        )
        .run('legacy-task-contended', STALE, JSON.stringify({ prompt: 'future heartbeat', script: null }));
    } finally {
      inDb.close();
    }

    // Simulate the first sweep pass holding the scheduler-mutator lock while
    // the startup reconciliation attempts this session: the first attempt
    // MUST hit RuntimeLockHeldError, be re-queued, and succeed on retry
    // after the lock is released.
    const owner = acquireRuntimeLock('scheduler-mutator', 60_000);
    const pending = reconcileLegacyTaskImportsOnStartup();
    releaseRuntimeLock(owner);
    const summary = await pending;

    expect(summary).toEqual({ scanned: 1, imported: 1, failed: 0 });
    expect(getScheduledTask('ag-yente', 'series-contended')).toMatchObject({
      series_id: 'series-contended',
      status: 'pending',
      process_after: '2099-01-01T00:00:00.000Z',
    });
  });

  it('skips sessions whose inbound.db is missing without failing the pass', async () => {
    createSession({
      id: 'sess-no-folder',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-2',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });

    const summary = await reconcileLegacyTaskImportsOnStartup();
    expect(summary).toEqual({ scanned: 1, imported: 0, failed: 0 });
  });
});
