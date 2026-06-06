import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { updateSession } from '../../db/sessions.js';
import { withRuntimeLock } from '../../db/runtime-locks.js';
import { clearDeliveryAdapterForTest } from '../../delivery.js';
import {
  initSessionFolder,
  openInboundDb,
  resolveSession,
  type SessionMode,
} from '../../session-manager.js';
import { createOrReplaceScheduledTask, getScheduledTask } from './ledger.js';
import { repairSchedulerProjections } from './repair.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-scheduler-repair' };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduler-repair';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  clearDeliveryAdapterForTest();
  const db = initTestDb();
  runMigrations(db);
  seedRoute();
});

afterEach(() => {
  clearDeliveryAdapterForTest();
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('repairSchedulerProjections', () => {
  it('projects central live tasks into the active session', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    await seedCentralTask('task-live', session.id);

    await repairSchedulerProjections();

    expect(projectedRows(session.id)).toEqual([{ id: 'task-task-live-g1', series_id: 'task-live', status: 'pending' }]);
    expect(getScheduledTask('ag-yente', 'task-live')).toMatchObject({
      projected_session_id: session.id,
      projected_message_id: 'task-task-live-g1',
    });
  });

  it('does not resurrect archived live rows when central task state is terminal', async () => {
    const archived = archivedSessionWithLegacyTask('task-terminal');
    const { session: active } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    await seedCentralTask('task-terminal', archived.id);
    getDb()
      .prepare(
        `UPDATE scheduled_tasks
            SET status = 'completed',
                completed_at = ?,
                projected_session_id = NULL,
                projected_message_id = NULL
          WHERE agent_group_id = 'ag-yente'
            AND series_id = 'task-terminal'`,
      )
      .run(now());

    await repairSchedulerProjections();

    expect(projectedRows(active.id)).toEqual([]);
    expect(incidentKeys()).toEqual([]);
  });

  it('reports archived live task rows without central proof and does not project them', async () => {
    archivedSessionWithLegacyTask('task-orphan');
    const { session: active } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');

    await repairSchedulerProjections();

    expect(projectedRows(active.id)).toEqual([]);
    expect(incidentKeys()).toEqual([expect.stringMatching(/^legacy-archived:/)]);
    expect(getScheduledTask('ag-yente', 'task-orphan')).toBeUndefined();
  });

  it('lets central live task proof drive projection instead of trusting the archived row', async () => {
    const archived = archivedSessionWithLegacyTask('task-proven');
    const { session: active } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    await seedCentralTask('task-proven', archived.id);

    await repairSchedulerProjections();

    expect(projectedRows(active.id)).toEqual([{ id: 'task-task-proven-g1', series_id: 'task-proven', status: 'pending' }]);
    expect(incidentKeys()).toEqual([]);
  });
});

function seedRoute(sessionMode: SessionMode = 'per-thread'): void {
  createAgentGroup({
    id: 'ag-yente',
    name: 'Yente',
    folder: 'yente',
    agent_provider: null,
    created_at: now(),
  });
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
    session_mode: sessionMode,
    priority: 0,
    created_at: now(),
  });
}

async function seedCentralTask(seriesId: string, sessionId: string): Promise<void> {
  await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
    createOrReplaceScheduledTask(
      {
        seriesId,
        agentGroupId: 'ag-yente',
        messagingGroupId: 'mg-discord',
        threadId: 'thread-1',
        platformId: 'channel',
        channelType: 'discord',
        isGroup: 1,
        processAfter: '2026-06-06T12:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'heartbeat', script: null }),
        sessionId,
        sourceMessageId: `seed-${seriesId}`,
      },
      owner,
    );
  });
}

function archivedSessionWithLegacyTask(seriesId: string): { id: string } {
  const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
  updateSession(session.id, { status: 'archived', container_status: 'stopped' });
  initSessionFolder(session.agent_group_id, session.id);
  const inDb = openInboundDb(session.agent_group_id, session.id);
  try {
    inDb
      .prepare(
        `INSERT INTO messages_in (
           id,
           seq,
           kind,
           timestamp,
           status,
           process_after,
           recurrence,
           trigger,
           platform_id,
           channel_type,
           thread_id,
           messaging_group_id,
           is_group,
           content,
           series_id
         ) VALUES (
           @id,
           2,
           'task',
           @timestamp,
           'pending',
           '2026-06-06T12:00:00.000Z',
           NULL,
           1,
           'channel',
           'discord',
           'thread-1',
           'mg-discord',
           1,
           @content,
           @seriesId
         )`,
      )
      .run({
        id: `legacy-${seriesId}`,
        timestamp: now(),
        content: JSON.stringify({ prompt: 'legacy heartbeat', script: null }),
        seriesId,
      });
  } finally {
    inDb.close();
  }
  return { id: session.id };
}

function projectedRows(sessionId: string): Array<{ id: string; series_id: string; status: string }> {
  const inDb = openInboundDb('ag-yente', sessionId);
  try {
    return inDb
      .prepare("SELECT id, series_id, status FROM messages_in WHERE kind = 'task' ORDER BY id")
      .all() as Array<{ id: string; series_id: string; status: string }>;
  } finally {
    inDb.close();
  }
}

function incidentKeys(): string[] {
  return (
    getDb().prepare('SELECT dedupe_key FROM scheduler_incidents ORDER BY dedupe_key').all() as Array<{
      dedupe_key: string;
    }>
  ).map((row) => row.dedupe_key);
}
