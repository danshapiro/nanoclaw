import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { countDueMessages, ensureSchema, openInboundDb } from '../../db/session-db.js';
import { withRuntimeLock, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import {
  cancelScheduledTask,
  completeScheduledTask,
  createOrReplaceScheduledTask,
  failScheduledTask,
  getScheduledTask,
  listLiveScheduledTasksForSession,
  pauseScheduledTask,
  type CreateScheduledTaskInput,
  type ScheduledTaskRow,
} from './ledger.js';
import {
  clearCompletedProjectionRecurrence,
  projectScheduledTask,
  projectionMessageId,
  retireProjection,
} from './projection.js';

const LOCK_NAME = 'scheduler-mutator';
const TEST_DIR = '/tmp/nanoclaw-scheduler-projection-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function now(): string {
  return new Date().toISOString();
}

function freshInboundDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function baseTask(overrides: Partial<CreateScheduledTaskInput> = {}): CreateScheduledTaskInput {
  return {
    seriesId: 'task-1',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    threadId: 'thread-1',
    platformId: 'chan-1',
    channelType: 'discord',
    isGroup: 1,
    processAfter: '2026-06-06T12:00:00.000Z',
    recurrence: '0 9 * * *',
    content: JSON.stringify({ prompt: 'heartbeat', script: null }),
    sessionId: 'sess-old',
    sourceMessageId: `out-${overrides.seriesId ?? 'task-1'}`,
    ...overrides,
  };
}

async function withSchedulerLock<T>(fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T> {
  return await withRuntimeLock(LOCK_NAME, 120_000, fn);
}

function seedTask(owner: RuntimeLockOwner, overrides: Partial<CreateScheduledTaskInput> = {}): ScheduledTaskRow {
  const input = baseTask(overrides);
  createOrReplaceScheduledTask(input, owner);
  return getScheduledTask(input.agentGroupId, input.seriesId)!;
}

function messagesInRows(db: ReturnType<typeof openInboundDb>) {
  return db.prepare('SELECT * FROM messages_in ORDER BY seq').all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent 1',
    folder: 'agent-1',
    agent_provider: null,
    created_at: now(),
  });
  createAgentGroup({
    id: 'ag-2',
    name: 'Agent 2',
    folder: 'agent-2',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-1',
    name: 'Yente',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-2',
    channel_type: 'discord',
    platform_id: 'chan-2',
    name: 'Other',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('scheduler projection helpers', () => {
  it('projects live central tasks into a session inbound DB', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      // Exercise deterministic generation formatting from a non-initial row.
      getDb()
        .prepare('UPDATE scheduled_tasks SET generation = 2 WHERE agent_group_id = ? AND series_id = ?')
        .run('ag-1', 'task-1');
      const refreshed = getScheduledTask(task.agent_group_id, task.series_id)!;

      const messageId = projectScheduledTask(inDb, refreshed, 'sess-new', owner);

      expect(messageId).toBe('task-task-1-g2');
      expect(
        inDb
          .prepare(
            `SELECT id, kind, status, process_after, recurrence, content, series_id,
                    trigger, seq, timestamp, host_input_id, host_route_key, host_received_at
               FROM messages_in`,
          )
          .get(),
      ).toEqual({
        id: 'task-task-1-g2',
        kind: 'task',
        status: 'pending',
        process_after: '2026-06-06T12:00:00.000Z',
        recurrence: '0 9 * * *',
        content: JSON.stringify({ prompt: 'heartbeat', script: null }),
        series_id: 'task-1',
        trigger: 1,
        seq: 2,
        timestamp: expect.any(String),
        host_input_id: expect.stringMatching(/^in-host-[0-9a-f]{24}$/),
        host_route_key: 'claude|discord|chan-1|grp:mg-1:thread-1',
        host_received_at: expect.any(String),
      });
      expect(Date.parse((messagesInRows(inDb)[0].timestamp as string) ?? '')).not.toBeNaN();
      expect(Date.parse((messagesInRows(inDb)[0].host_received_at as string) ?? '')).not.toBeNaN();
      expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
        projected_session_id: 'sess-new',
        projected_message_id: 'task-task-1-g2',
      });
    });

    inDb.close();
  });

  it('updates an existing projection without changing its stable id or seq', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      projectScheduledTask(inDb, task, 'sess-new', owner);
      const initial = inDb.prepare('SELECT id, seq FROM messages_in WHERE series_id = ?').get('task-1') as {
        id: string;
        seq: number;
      };

      getDb()
        .prepare(
          `UPDATE scheduled_tasks
           SET status = 'paused',
               process_after = '2026-06-07T12:00:00.000Z',
               content = ?
           WHERE agent_group_id = ? AND series_id = ?`,
        )
        .run(JSON.stringify({ prompt: 'updated', script: 'echo ok' }), 'ag-1', 'task-1');

      projectScheduledTask(inDb, getScheduledTask('ag-1', 'task-1')!, 'sess-new', owner);

      expect(inDb.prepare('SELECT id, seq, status, process_after, content FROM messages_in').get()).toEqual({
        id: initial.id,
        seq: initial.seq,
        status: 'paused',
        process_after: '2026-06-07T12:00:00.000Z',
        content: JSON.stringify({ prompt: 'updated', script: 'echo ok' }),
      });
    });

    inDb.close();
  });

  it('repairs a pending legacy projection that is missing its host-backed trigger stamp', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      const messageId = projectScheduledTask(inDb, task, 'sess-new', owner);
      inDb
        .prepare(
          `UPDATE messages_in
              SET host_input_id = NULL,
                  host_route_key = NULL,
                  host_received_at = NULL
            WHERE id = ?`,
        )
        .run(messageId);

      projectScheduledTask(inDb, task, 'sess-new', owner);
    });

    expect(
      inDb
        .prepare('SELECT host_input_id, host_route_key, host_received_at FROM messages_in WHERE series_id = ?')
        .get('task-1'),
    ).toEqual({
      host_input_id: expect.stringMatching(/^in-host-[0-9a-f]{24}$/),
      host_route_key: 'claude|discord|chan-1|grp:mg-1:thread-1',
      host_received_at: expect.any(String),
    });
    inDb.close();
  });

  it('does not rewrite a projection trigger stamp after host acceptance', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      const messageId = projectScheduledTask(inDb, task, 'sess-new', owner);
      inDb
        .prepare(
          `UPDATE messages_in
              SET host_input_id = 'accepted-input',
                  host_route_key = 'accepted-route',
                  host_received_at = '2026-06-06T11:59:00.000Z',
                  host_accepted_input_id = 'accepted-input',
                  host_accepted_route_key = 'accepted-route',
                  host_accepted_at = '2026-06-06T12:00:00.000Z'
            WHERE id = ?`,
        )
        .run(messageId);

      projectScheduledTask(inDb, task, 'sess-new', owner);
    });

    expect(
      inDb
        .prepare('SELECT host_input_id, host_route_key, host_received_at FROM messages_in WHERE series_id = ?')
        .get('task-1'),
    ).toEqual({
      host_input_id: 'accepted-input',
      host_route_key: 'accepted-route',
      host_received_at: '2026-06-06T11:59:00.000Z',
    });
    inDb.close();
  });

  it('retires stale live projection generations when projecting a refreshed central task', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner, { processAfter: '2020-01-01T00:00:00.000Z' });
      const firstMessageId = projectScheduledTask(inDb, task, 'sess-new', owner);

      expect(firstMessageId).toBe('task-task-1-g1');
      expect(countDueMessages(inDb)).toBe(1);

      expect(pauseScheduledTask('ag-1', 'task-1', { sessionId: 'sess-old', messageId: 'out-pause' }, owner)).toBe(1);
      const refreshed = getScheduledTask('ag-1', 'task-1')!;
      const secondMessageId = projectScheduledTask(inDb, refreshed, 'sess-new', owner);

      expect(secondMessageId).toBe('task-task-1-g2');
    });

    expect(inDb.prepare('SELECT id, status, recurrence FROM messages_in ORDER BY id').all()).toEqual([
      { id: 'task-task-1-g1', status: 'completed', recurrence: null },
      { id: 'task-task-1-g2', status: 'paused', recurrence: '0 9 * * *' },
    ]);
    expect(countDueMessages(inDb)).toBe(0);
    inDb.close();
  });

  it('refuses to mark the ledger projected when the deterministic id belongs to a non-task row', async () => {
    const inDb = freshInboundDb();
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, series_id)
         VALUES ('task-task-1-g1', 2, 'chat', ?, 'pending', '{}', 'chat-series')`,
      )
      .run(now());

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      expect(() => projectScheduledTask(inDb, task, 'sess-new', owner)).toThrow(/already exists as kind=chat/);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      projected_session_id: null,
      projected_message_id: null,
    });
    inDb.close();
  });

  it('projects paused tasks without waking due-count logic', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      getDb()
        .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE agent_group_id = ? AND series_id = ?")
        .run('ag-1', 'task-1');

      projectScheduledTask(inDb, getScheduledTask(task.agent_group_id, task.series_id)!, 'sess-new', owner);
    });

    expect(inDb.prepare('SELECT status, trigger FROM messages_in').get()).toEqual({ status: 'paused', trigger: 1 });
    expect(countDueMessages(inDb)).toBe(0);
    inDb.close();
  });

  it('retires live projection rows when central tasks become terminal', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const cancelled = seedTask(owner, { seriesId: 'task-cancelled', sourceMessageId: 'out-cancelled' });
      const completed = seedTask(owner, {
        seriesId: 'task-completed',
        sourceMessageId: 'out-completed',
        recurrence: null,
      });
      const failed = seedTask(owner, { seriesId: 'task-failed', sourceMessageId: 'out-failed' });

      projectScheduledTask(inDb, cancelled, 'sess-new', owner);
      projectScheduledTask(inDb, completed, 'sess-new', owner);
      projectScheduledTask(inDb, failed, 'sess-new', owner);

      cancelScheduledTask('ag-1', 'task-cancelled', { sessionId: 'sess-old', messageId: 'out-cancel' }, owner);
      completeScheduledTask(
        'ag-1',
        'task-completed',
        { sessionId: 'sess-new', messageId: projectionMessageId(completed), nextRun: null },
        owner,
      );
      failScheduledTask(
        'ag-1',
        'task-failed',
        { sessionId: 'sess-new', messageId: projectionMessageId(failed), error: 'terminal notice' },
        owner,
      );

      expect(retireProjection(inDb, 'task-cancelled')).toBe(1);
      expect(retireProjection(inDb, 'task-completed')).toBe(1);
      expect(retireProjection(inDb, 'task-failed')).toBe(1);
    });

    expect(inDb.prepare('SELECT series_id, status, recurrence FROM messages_in ORDER BY series_id').all()).toEqual([
      { series_id: 'task-cancelled', status: 'completed', recurrence: null },
      { series_id: 'task-completed', status: 'completed', recurrence: null },
      { series_id: 'task-failed', status: 'completed', recurrence: null },
    ]);
    inDb.close();
  });

  it('clears recurrence on completed projection rows after sync consumes them', () => {
    const inDb = freshInboundDb();
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, recurrence, content, series_id)
         VALUES ('task-task-1-g1', 2, 'task', ?, 'completed', '0 9 * * *', '{}', 'task-1')`,
      )
      .run(now());

    clearCompletedProjectionRecurrence(inDb, 'task-task-1-g1');

    expect(inDb.prepare('SELECT recurrence FROM messages_in WHERE id = ?').get('task-task-1-g1')).toEqual({
      recurrence: null,
    });
    inDb.close();
  });

  it('projects only live tasks selected for a route-scoped session', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      seedTask(owner, { seriesId: 'task-route-a', sourceMessageId: 'out-route-a' });
      seedTask(owner, {
        seriesId: 'task-route-b',
        sourceMessageId: 'out-route-b',
        messagingGroupId: 'mg-2',
        platformId: 'chan-2',
      });
      seedTask(owner, { agentGroupId: 'ag-2', seriesId: 'task-other-agent', sourceMessageId: 'out-other-agent' });

      const tasks = listLiveScheduledTasksForSession({
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        threadId: 'thread-1',
      });
      for (const task of tasks) projectScheduledTask(inDb, task, 'sess-route', owner);
    });

    expect(inDb.prepare('SELECT series_id FROM messages_in ORDER BY series_id').all()).toEqual([
      { series_id: 'task-route-a' },
    ]);
    inDb.close();
  });

  it('agent-shared sessions project agent-group tasks while preserving each task route', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      seedTask(owner, { seriesId: 'task-a', sourceMessageId: 'out-a' });
      seedTask(owner, {
        seriesId: 'task-b',
        sourceMessageId: 'out-b',
        messagingGroupId: 'mg-2',
        platformId: 'chan-2',
        threadId: null,
        isGroup: 0,
      });
      seedTask(owner, { agentGroupId: 'ag-2', seriesId: 'task-c', sourceMessageId: 'out-c' });

      const tasks = listLiveScheduledTasksForSession({
        agentGroupId: 'ag-1',
        messagingGroupId: null,
        threadId: null,
        sessionMode: 'agent-shared',
      });
      for (const task of tasks) projectScheduledTask(inDb, task, 'sess-agent-shared', owner);
    });

    expect(
      inDb
        .prepare(
          `SELECT series_id, messaging_group_id, thread_id, platform_id, channel_type, is_group
           FROM messages_in
           ORDER BY series_id`,
        )
        .all(),
    ).toEqual([
      {
        series_id: 'task-a',
        messaging_group_id: 'mg-1',
        thread_id: 'thread-1',
        platform_id: 'chan-1',
        channel_type: 'discord',
        is_group: 1,
      },
      {
        series_id: 'task-b',
        messaging_group_id: 'mg-2',
        thread_id: null,
        platform_id: 'chan-2',
        channel_type: 'discord',
        is_group: 0,
      },
    ]);
    inDb.close();
  });

  it('re-projecting an UNCHANGED live task is a steady-state no-op (host_received_at preserved)', async () => {
    const inDb = freshInboundDb();

    await withSchedulerLock((owner) => {
      const task = seedTask(owner);
      projectScheduledTask(inDb, task, 'sess-new', owner);
      // Sentinel: if the second projection runs its UPDATE, this value is
      // overwritten with a fresh timestamp (host_accepted_at IS NULL).
      inDb
        .prepare("UPDATE messages_in SET host_received_at = '2020-01-01T00:00:00.000Z' WHERE series_id = 'task-1'")
        .run();

      projectScheduledTask(inDb, getScheduledTask('ag-1', 'task-1')!, 'sess-new', owner);
    });

    expect(inDb.prepare('SELECT host_received_at FROM messages_in WHERE series_id = ?').get('task-1')).toEqual({
      host_received_at: '2020-01-01T00:00:00.000Z',
    });
    inDb.close();
  });
});
