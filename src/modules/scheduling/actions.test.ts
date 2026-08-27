import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { acquireRuntimeLock, releaseRuntimeLock } from '../../db/runtime-locks.js';
import { clearDeliveryAdapterForTest } from '../../delivery.js';
import { openInboundDb, resolveSession } from '../../session-manager.js';
import { getScheduledTask } from './ledger.js';
import { handleScheduleTask, handleUpdateTask } from './actions.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-scheduler-actions' };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduler-actions';

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

describe('scheduling delivery actions', () => {
  it('carries a run headline into the ledger and clears it on request', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const inDb = openInboundDb(session.agent_group_id, session.id);

    await handleScheduleTask(
      {
        taskId: 'task-nightly',
        prompt: 'morning pass',
        processAfter: '2026-08-28T11:40:00.000Z',
        recurrence: '40 4 * * *',
        script: null,
        headline: 'Nightly run results',
        platformId: 'channel',
        channelType: 'discord',
        threadId: null,
        messagingGroupId: 'mg-discord',
        isGroup: 1,
      },
      session,
      inDb,
      'sys-headline-1',
    );

    const scheduled = getScheduledTask('ag-yente', 'task-nightly');
    expect(JSON.parse(scheduled!.content).headline).toBe('Nightly run results');

    await handleUpdateTask({ taskId: 'task-nightly', headline: '' }, session, inDb, 'sys-headline-2');

    const cleared = getScheduledTask('ag-yente', 'task-nightly');
    expect(JSON.parse(cleared!.content)).not.toHaveProperty('headline');
    inDb.close();
  });

  it('waits for scheduler lock contention instead of dropping a delivered schedule_task', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const inDb = openInboundDb(session.agent_group_id, session.id);
    const blocker = acquireRuntimeLock('scheduler-mutator', 120_000);

    try {
      const action = handleScheduleTask(
        {
          taskId: 'task-retry',
          prompt: 'heartbeat',
          processAfter: '2026-06-06T12:00:00.000Z',
          recurrence: null,
          script: null,
          platformId: 'channel',
          channelType: 'discord',
          threadId: 'thread-1',
          messagingGroupId: 'mg-discord',
          isGroup: 1,
        },
        session,
        inDb,
        'out-schedule-retry',
      );

      await sleep(50);
      expect(getScheduledTask('ag-yente', 'task-retry')).toBeUndefined();
      releaseRuntimeLock(blocker);

      await action;

      expect(getScheduledTask('ag-yente', 'task-retry')).toMatchObject({
        status: 'pending',
        process_after: '2026-06-06T12:00:00.000Z',
        projected_session_id: session.id,
        projected_message_id: 'task-task-retry-g1',
      });
      expect(inDb.prepare("SELECT id, series_id, status FROM messages_in WHERE kind = 'task'").all()).toEqual([
        { id: 'task-task-retry-g1', series_id: 'task-retry', status: 'pending' },
      ]);
    } finally {
      releaseRuntimeLock(blocker);
      inDb.close();
    }
  });
});

function seedRoute(): void {
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
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
