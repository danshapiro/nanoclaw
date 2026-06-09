/**
 * Tests for the scheduling module's task DB helpers — focused on the
 * series_id invariant that lets cancel/pause/resume/update reach the live
 * next occurrence of a recurring task, even after the row the agent
 * remembers has completed and been replaced by a follow-up.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { countDueMessages, ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import {
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleScheduleTask,
  handleUpdateTask,
} from './actions.js';
import { getScheduledTask } from './ledger.js';
import {
  insertTask,
  insertRecurrence,
  cancelTask,
  pauseTask,
  resumeTask,
  updateTask,
  getCompletedRecurring,
  type RecurringMessage,
} from './db.js';

const TEST_DIR = '/tmp/nanoclaw-scheduling-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');
const ACTION_SESSION: Session = {
  id: 'sess-action',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'thread-1',
  agent_provider: null,
  status: 'active',
  container_status: 'idle',
  last_active: null,
  created_at: '2026-06-05T00:00:00.000Z',
};

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function insertBasicTask(db: ReturnType<typeof openInboundDb>, id: string, recurrence: string | null) {
  insertTask(db, {
    id,
    processAfter: new Date().toISOString(),
    recurrence,
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: 'noop' }),
  });
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('delivery action handlers', () => {
  beforeEach(() => {
    const central = initTestDb();
    runMigrations(central);
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent 1',
      folder: 'agent-1',
      agent_provider: null,
      created_at: '2026-06-05T00:00:00.000Z',
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: 'Yente',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: '2026-06-05T00:00:00.000Z',
    });
    createSession(ACTION_SESSION);
  });

  afterEach(() => {
    closeDb();
  });

  function scheduleAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: 'schedule_task',
      taskId: 'task-1',
      prompt: 'heartbeat',
      script: null,
      processAfter: '2026-06-06T12:00:00.000Z',
      recurrence: '0 9 * * *',
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: 'thread-1',
      messagingGroupId: 'mg-1',
      isGroup: 1,
      ...overrides,
    };
  }

  async function seedScheduledProjection(db: ReturnType<typeof openInboundDb>) {
    await handleScheduleTask(scheduleAction(), ACTION_SESSION, db, 'out-schedule');
  }

  it('schedule_task writes central intent and active projection', async () => {
    const db = freshDb();

    await handleScheduleTask(scheduleAction(), ACTION_SESSION, db, 'out-schedule');

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      recurrence: '0 9 * * *',
      process_after: '2026-06-06T12:00:00.000Z',
      projected_session_id: 'sess-action',
      projected_message_id: 'task-task-1-g1',
    });
    expect(db.prepare("SELECT series_id, status, recurrence FROM messages_in WHERE kind = 'task'").get()).toEqual({
      series_id: 'task-1',
      status: 'pending',
      recurrence: '0 9 * * *',
    });
    db.close();
  });

  it('cancel_task tombstones central intent and retires the active projection', async () => {
    const db = freshDb();
    await seedScheduledProjection(db);

    await handleCancelTask({ action: 'cancel_task', taskId: 'task-1' }, ACTION_SESSION, db, 'out-cancel');

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'cancelled',
      recurrence: null,
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(db.prepare('SELECT status, recurrence FROM messages_in WHERE series_id = ?').get('task-1')).toEqual({
      status: 'completed',
      recurrence: null,
    });
    db.close();
  });

  it('pause_task refreshes the projection as paused and prevents due wakes', async () => {
    const db = freshDb();
    await handleScheduleTask(
      scheduleAction({ processAfter: '2020-01-01T00:00:00.000Z' }),
      ACTION_SESSION,
      db,
      'out-schedule',
    );
    expect(countDueMessages(db)).toBe(1);

    await handlePauseTask({ action: 'pause_task', taskId: 'task-1' }, ACTION_SESSION, db, 'out-pause');

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'paused',
      projected_message_id: 'task-task-1-g2',
    });
    expect(db.prepare('SELECT id, status FROM messages_in ORDER BY id').all()).toEqual([
      { id: 'task-task-1-g1', status: 'completed' },
      { id: 'task-task-1-g2', status: 'paused' },
    ]);
    expect(countDueMessages(db)).toBe(0);
    db.close();
  });

  it('resume_task refreshes a paused projection as pending', async () => {
    const db = freshDb();
    await seedScheduledProjection(db);
    await handlePauseTask({ action: 'pause_task', taskId: 'task-1' }, ACTION_SESSION, db, 'out-pause');

    await handleResumeTask({ action: 'resume_task', taskId: 'task-1' }, ACTION_SESSION, db, 'out-resume');

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      projected_message_id: 'task-task-1-g3',
    });
    expect(db.prepare('SELECT id, status FROM messages_in ORDER BY id').all()).toEqual([
      { id: 'task-task-1-g1', status: 'completed' },
      { id: 'task-task-1-g2', status: 'completed' },
      { id: 'task-task-1-g3', status: 'pending' },
    ]);
    db.close();
  });

  it('update_task changes central content and refreshes the active projection', async () => {
    const db = freshDb();
    await seedScheduledProjection(db);

    await handleUpdateTask(
      {
        action: 'update_task',
        taskId: 'task-1',
        prompt: 'updated heartbeat',
        script: 'echo ok',
        processAfter: '2026-06-07T12:00:00.000Z',
        recurrence: null,
      },
      ACTION_SESSION,
      db,
      'out-update',
    );

    const task = getScheduledTask('ag-1', 'task-1')!;
    expect(task).toMatchObject({
      status: 'pending',
      recurrence: null,
      process_after: '2026-06-07T12:00:00.000Z',
      projected_message_id: 'task-task-1-g2',
    });
    expect(JSON.parse(task.content)).toEqual({ prompt: 'updated heartbeat', script: 'echo ok' });
    expect(
      db.prepare('SELECT id, process_after, recurrence, content FROM messages_in WHERE status = ?').get('pending'),
    ).toEqual({
      id: 'task-task-1-g2',
      process_after: '2026-06-07T12:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'updated heartbeat', script: 'echo ok' }),
    });
    db.close();
  });
});

describe('insertTask', () => {
  it('stamps series_id = id on insert', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', null);
    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-1') as { series_id: string };
    expect(row.series_id).toBe('task-1');
    db.close();
  });

  it('preserves route metadata on insert', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: 'discord-thread-1',
      channelType: 'discord',
      threadId: 'thread-1',
      messagingGroupId: 'mg-discord-1',
      isGroup: 1,
      content: JSON.stringify({ prompt: 'noop' }),
    });

    const row = db
      .prepare(
        'SELECT platform_id, channel_type, thread_id, messaging_group_id, is_group FROM messages_in WHERE id = ?',
      )
      .get('task-1') as {
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      messaging_group_id: string | null;
      is_group: number | null;
    };
    expect(row.platform_id).toBe('discord-thread-1');
    expect(row.channel_type).toBe('discord');
    expect(row.thread_id).toBe('thread-1');
    expect(row.messaging_group_id).toBe('mg-discord-1');
    expect(row.is_group).toBe(1);
    db.close();
  });
});

describe('cancelTask / pauseTask / resumeTask series matching', () => {
  // Simulates the recurrence chain that used to survive cancellation:
  // the original task completes → handleRecurrence spawns a follow-up
  // row → agent calls cancel_task(originalId) → historically only hit
  // the completed row, leaving the live one running.
  function seedRecurringChain(db: ReturnType<typeof openInboundDb>) {
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    // Mark the original as completed (as syncProcessingAcks would do).
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: JSON.stringify({ prompt: 'noop' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());
  }

  it('cancel by original id reaches the live follow-up via series_id', () => {
    const db = freshDb();
    seedRecurringChain(db);

    cancelTask(db, 'task-orig');

    const live = db.prepare("SELECT id, status, recurrence FROM messages_in WHERE status = 'pending'").all();
    expect(live).toHaveLength(0);

    const followUp = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'task-next'").get() as {
      status: string;
      recurrence: string | null;
    };
    expect(followUp.status).toBe('completed');
    // Recurrence cleared so the sweep doesn't spawn another clone.
    expect(followUp.recurrence).toBeNull();
    db.close();
  });

  it('cancelled task is not picked up by getCompletedRecurring', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', '0 9 * * *');
    cancelTask(db, 'task-1');

    const recurring = getCompletedRecurring(db);
    expect(recurring).toHaveLength(0);
    db.close();
  });

  it('pause by original id pauses the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    pauseTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('paused');
    db.close();
  });

  it('resume by original id resumes the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = 'task-next'").run();
    resumeTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('pending');
    db.close();
  });
});

describe('updateTask', () => {
  it('merges supplied fields into content JSON without clobbering others', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'old', script: 'echo old', extra: 'keep me' }),
    });

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(1);

    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-1') as { content: string };
    const parsed = JSON.parse(row.content);
    expect(parsed.prompt).toBe('new');
    expect(parsed.script).toBe('echo old');
    expect(parsed.extra).toBe('keep me');
  });

  it('updates recurrence and process_after when supplied', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: '0 18 * * *', processAfter: '2026-02-01T00:00:00Z' });

    const row = db.prepare('SELECT recurrence, process_after FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string;
      process_after: string;
    };
    expect(row.recurrence).toBe('0 18 * * *');
    expect(row.process_after).toBe('2026-02-01T00:00:00Z');
  });

  it('clears recurrence when null is passed', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: null });

    const row = db.prepare('SELECT recurrence FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();
  });

  it('reaches the live follow-up via series_id when called with the original id', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-orig',
      processAfter: new Date().toISOString(),
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'old' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: JSON.stringify({ prompt: 'old' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());

    const touched = updateTask(db, 'task-orig', { prompt: 'new' });
    // Only the live follow-up should be touched — completed rows are excluded.
    expect(touched).toBe(1);

    const live = db.prepare("SELECT content FROM messages_in WHERE id = 'task-next'").get() as { content: string };
    expect(JSON.parse(live.content).prompt).toBe('new');

    // Original (completed) row left alone.
    const orig = db.prepare("SELECT content FROM messages_in WHERE id = 'task-orig'").get() as { content: string };
    expect(JSON.parse(orig.content).prompt).toBe('old');
  });

  it('returns 0 when no live task matches', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'p' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-1'").run();

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(0);
  });
});

describe('insertRecurrence', () => {
  it('copies series_id forward', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: '{}',
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date().toISOString());

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-next') as {
      series_id: string;
    };
    expect(row.series_id).toBe('task-orig');
    db.close();
  });

  it('copies route metadata forward', () => {
    const db = freshDb();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: '{}',
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: 'discord-thread-1',
      channel_type: 'discord',
      thread_id: 'thread-1',
      messaging_group_id: 'mg-discord-1',
      is_group: 1,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date().toISOString());

    const row = db
      .prepare(
        'SELECT platform_id, channel_type, thread_id, messaging_group_id, is_group FROM messages_in WHERE id = ?',
      )
      .get('task-next') as {
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      messaging_group_id: string | null;
      is_group: number | null;
    };
    expect(row.platform_id).toBe('discord-thread-1');
    expect(row.channel_type).toBe('discord');
    expect(row.thread_id).toBe('thread-1');
    expect(row.messaging_group_id).toBe('mg-discord-1');
    expect(row.is_group).toBe(1);
    db.close();
  });
});
