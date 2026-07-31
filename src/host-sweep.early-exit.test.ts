import Database from 'better-sqlite3';
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
} from './db/index.js';
import { INBOUND_SCHEMA } from './db/schema.js';
import { createOrReplaceScheduledTask } from './modules/scheduling/ledger.js';

const withRuntimeLockSpy = vi.hoisted(() => vi.fn());

vi.mock('./db/runtime-locks.js', async () => {
  const actual = (await vi.importActual('./db/runtime-locks.js')) as typeof import('./db/runtime-locks.js');
  withRuntimeLockSpy.mockImplementation(actual.withRuntimeLock);
  return { ...actual, withRuntimeLock: withRuntimeLockSpy };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: vi.fn().mockResolvedValue(true),
  stopContainerAndVerify: vi.fn().mockResolvedValue(true),
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-early-exit' };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-early-exit';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  withRuntimeLockSpy.mockClear();

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

async function seedLiveCentralTask(seriesId: string, sessionId: string): Promise<void> {
  const { withRuntimeLock } = await import('./db/runtime-locks.js');
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
        processAfter: '2099-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'x', script: null }),
        sessionId,
        sourceMessageId: `msg-${seriesId}`,
      },
      owner,
    );
  });
}

async function seedActiveSession(id: string) {
  const { initSessionFolder } = await import('./session-manager.js');
  const session = {
    id,
    agent_group_id: 'ag-yente',
    messaging_group_id: 'mg-discord',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: now(),
    created_at: now(),
  };
  createSession(session);
  initSessionFolder('ag-yente', id);
  return session;
}

describe('sessionNeedsSchedulerSync (pure gate)', () => {
  it('is false for an idle session with no task rows and no live central tasks', async () => {
    const { sessionNeedsSchedulerSync } = await import('./host-sweep.js');
    const inDb = new Database(':memory:');
    inDb.exec(INBOUND_SCHEMA);
    expect(sessionNeedsSchedulerSync(inDb, 'ag-yente')).toBe(false);
    inDb.close();
  });

  it('is true when the inbound DB has ANY kind=task row (projection or legacy)', async () => {
    const { sessionNeedsSchedulerSync } = await import('./host-sweep.js');
    const inDb = new Database(':memory:');
    inDb.exec(INBOUND_SCHEMA);
    inDb
      .prepare(
        "INSERT INTO messages_in (id, kind, timestamp, content, status, trigger) VALUES (?, 'task', ?, ?, 'completed', 1)",
      )
      .run('m-task', now(), JSON.stringify({ prompt: 'x', script: null }));
    expect(sessionNeedsSchedulerSync(inDb, 'ag-yente')).toBe(true);
    inDb.close();
  });

  it('is true when the agent group has a live central task', async () => {
    const { sessionNeedsSchedulerSync } = await import('./host-sweep.js');
    await seedLiveCentralTask('task-live', 'sess-any');
    const inDb = new Database(':memory:');
    inDb.exec(INBOUND_SCHEMA);
    expect(sessionNeedsSchedulerSync(inDb, 'ag-yente')).toBe(true);
    inDb.close();
  });
});

describe('sweepSession early exit', () => {
  it('never takes the scheduler-mutator lock for a provably idle session', async () => {
    const session = await seedActiveSession('sess-idle');
    const { sweepSessionForTest } = await import('./host-sweep.js');

    withRuntimeLockSpy.mockClear();
    await sweepSessionForTest(session);

    expect(withRuntimeLockSpy).not.toHaveBeenCalled();
  });

  it('still takes the lock when the agent group has a live task (conservative)', async () => {
    const session = await seedActiveSession('sess-with-task');
    await seedLiveCentralTask('task-live-2', 'sess-with-task');
    const { sweepSessionForTest } = await import('./host-sweep.js');

    withRuntimeLockSpy.mockClear();
    await sweepSessionForTest(session);

    expect(withRuntimeLockSpy).toHaveBeenCalledTimes(1);
    expect(withRuntimeLockSpy.mock.calls[0]?.[0]).toBe('scheduler-mutator');
  });
});
