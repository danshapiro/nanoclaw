import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import {
  cancelTask,
  listTasks,
  pauseTask,
  resumeTask,
  scheduleTask,
  updateTask,
} from './scheduling.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(`
    CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT,
      messaging_group_id TEXT,
      is_group INTEGER
    );
    INSERT INTO session_routing
      (id, channel_type, platform_id, thread_id, messaging_group_id, is_group)
    VALUES
      (1, 'discord', 'chan-1', 'thread-1', 'mg-1', 1);
  `);
});

afterEach(() => {
  closeSessionDb();
});

function outboxPayloads() {
  return getUndeliveredMessages().map((row) => ({
    ...row,
    content: JSON.parse(row.content) as Record<string, unknown>,
  }));
}

function insertTaskProjection(args: {
  id: string;
  seq: number;
  status: string;
  processAfter: string | null;
  recurrence: string | null;
  seriesId: string;
  prompt: string;
}): void {
  getInboundDb()
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
         content,
         series_id
       ) VALUES (?, ?, 'task', datetime('now'), ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      args.id,
      args.seq,
      args.status,
      args.processAfter,
      args.recurrence,
      JSON.stringify({ prompt: args.prompt, script: null }),
      args.seriesId,
    );
}

describe('scheduling MCP tools', () => {
  it('schedule_task emits a routed system action payload', async () => {
    const result = await scheduleTask.handler({
      prompt: 'heartbeat',
      script: 'echo ok',
      processAfter: '2026-06-06T12:00:00Z',
      recurrence: '0 9 * * *',
    });

    expect(result.isError).toBeUndefined();
    const [row] = outboxPayloads();
    expect(row.kind).toBe('system');
    expect(row.platform_id).toBe('chan-1');
    expect(row.channel_type).toBe('discord');
    expect(row.thread_id).toBe('thread-1');
    expect(row.messaging_group_id).toBe('mg-1');
    expect(row.is_group).toBe(1);
    expect(row.content).toMatchObject({
      action: 'schedule_task',
      prompt: 'heartbeat',
      script: 'echo ok',
      processAfter: '2026-06-06T12:00:00.000Z',
      recurrence: '0 9 * * *',
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: 'thread-1',
      messagingGroupId: 'mg-1',
      isGroup: 1,
    });
    expect(typeof row.content.taskId).toBe('string');
    expect(row.content.taskId).toBe(row.id);
  });

  it('control tools emit stable system action payloads', async () => {
    await cancelTask.handler({ taskId: 'task-1' });
    await pauseTask.handler({ taskId: 'task-1' });
    await resumeTask.handler({ taskId: 'task-1' });
    await updateTask.handler({
      taskId: 'task-1',
      prompt: 'updated',
      script: '',
      processAfter: '2026-06-07T12:00:00Z',
      recurrence: '',
    });

    expect(outboxPayloads().map((row) => row.content)).toEqual([
      { action: 'cancel_task', taskId: 'task-1' },
      { action: 'pause_task', taskId: 'task-1' },
      { action: 'resume_task', taskId: 'task-1' },
      {
        action: 'update_task',
        taskId: 'task-1',
        prompt: 'updated',
        script: null,
        processAfter: '2026-06-07T12:00:00.000Z',
        recurrence: null,
      },
    ]);
  });

  it('list_tasks reads projected live rows by series id', async () => {
    insertTaskProjection({
      id: 'task-task-a-g1',
      seq: 2,
      status: 'completed',
      processAfter: '2026-06-05T12:00:00.000Z',
      recurrence: null,
      seriesId: 'task-a',
      prompt: 'old hidden occurrence',
    });
    insertTaskProjection({
      id: 'task-task-a-g2',
      seq: 4,
      status: 'pending',
      processAfter: '2026-06-06T12:00:00.000Z',
      recurrence: '0 9 * * *',
      seriesId: 'task-a',
      prompt: 'live heartbeat',
    });
    insertTaskProjection({
      id: 'task-task-b-g2',
      seq: 6,
      status: 'paused',
      processAfter: '2026-06-07T12:00:00.000Z',
      recurrence: null,
      seriesId: 'task-b',
      prompt: 'paused reminder',
    });
    insertTaskProjection({
      id: 'task-task-c-g1',
      seq: 8,
      status: 'completed',
      processAfter: '2026-06-08T12:00:00.000Z',
      recurrence: null,
      seriesId: 'task-c',
      prompt: 'terminal hidden',
    });

    const result = await listTasks.handler({});

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('task-a [pending]');
    expect(text).toContain('live heartbeat');
    expect(text).toContain('task-b [paused]');
    expect(text).toContain('paused reminder');
    expect(text).not.toContain('old hidden occurrence');
    expect(text).not.toContain('task-c');
  });
});
