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
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { withRuntimeLock } from './db/runtime-locks.js';
import { createOrReplaceScheduledTask, type CreateScheduledTaskInput } from './modules/scheduling/ledger.js';

const wakeContainerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('./container-runner.js', () => ({
  wakeContainer: wakeContainerMock,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: vi.fn().mockResolvedValue(true),
  stopContainerAndVerify: vi.fn().mockResolvedValue(true),
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-revival' };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-revival';

function now(): string {
  return new Date().toISOString();
}

const STALE = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  wakeContainerMock.mockClear();

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

/** Second agent group wired agent-shared — used by the agent-shared cases. */
function wireAgentSharedGroup(): void {
  createAgentGroup({ id: 'ag-shared', name: 'Shared', folder: 'shared', agent_provider: null, created_at: now() });
  createMessagingGroupAgent({
    id: 'mga-shared',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-shared',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: now(),
  });
}

async function seedTask(
  input: Partial<CreateScheduledTaskInput> & Pick<CreateScheduledTaskInput, 'seriesId' | 'sessionId'>,
): Promise<void> {
  await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
    createOrReplaceScheduledTask(
      {
        agentGroupId: 'ag-yente',
        messagingGroupId: 'mg-discord',
        threadId: 'thread-1',
        platformId: 'channel',
        channelType: 'discord',
        isGroup: 1,
        processAfter: '2026-01-02T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'wake up', script: null }),
        sourceMessageId: `msg-${input.seriesId}`,
        ...input,
      },
      owner,
    );
  });
}

describe('host sweep revival of archived sessions with due scheduled work', () => {
  it('reactivates the archived session, projects its task, and wakes its container', async () => {
    const { initSessionFolder } = await import('./session-manager.js');

    createSession({
      id: 'sess-archived-due',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-archived-due');

    // A live task on the archived session's exact route, due in the past.
    await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
      createOrReplaceScheduledTask(
        {
          seriesId: 'task-due-now',
          agentGroupId: 'ag-yente',
          messagingGroupId: 'mg-discord',
          threadId: 'thread-1',
          platformId: 'channel',
          channelType: 'discord',
          isGroup: 1,
          processAfter: '2026-01-02T00:00:00.000Z',
          recurrence: null,
          content: JSON.stringify({ prompt: 'wake up', script: null }),
          sessionId: 'sess-archived-due',
          sourceMessageId: 'msg-seed',
        },
        owner,
      );
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    // Revived...
    expect(getSession('sess-archived-due')?.status).toBe('active');
    expect(getSession('sess-archived-due')?.last_active).not.toBe(STALE);
    // ...its due work projected into ITS inbound.db...
    const { openInboundDb } = await import('./session-manager.js');
    const inDb = openInboundDb('ag-yente', 'sess-archived-due');
    try {
      const taskRows = inDb
        .prepare("SELECT id, series_id, status FROM messages_in WHERE kind = 'task'")
        .all() as Array<{ id: string; series_id: string; status: string }>;
      expect(taskRows.some((r) => r.series_id === 'task-due-now')).toBe(true);
    } finally {
      inDb.close();
    }
    // ...and its container woken for the due message.
    expect(wakeContainerMock).toHaveBeenCalled();
    expect((wakeContainerMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe('sess-archived-due');
  });

  it('does not sweep (or revive) an archived session with no live work', async () => {
    const { initSessionFolder } = await import('./session-manager.js');
    createSession({
      id: 'sess-archived-idle',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-idle',
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-yente', 'sess-archived-idle');

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(getSession('sess-archived-idle')?.status).toBe('archived');
    expect(wakeContainerMock).not.toHaveBeenCalled();
  });

  it('revives an archived session whose on-disk FOLDER was deleted: recreates it, projects, wakes', async () => {
    const { sessionDir } = await import('./session-manager.js');
    createSession({
      id: 'sess-archived-no-folder',
      agent_group_id: 'ag-yente',
      messaging_group_id: 'mg-discord',
      thread_id: 'thread-nf',
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    // Deliberately NO initSessionFolder — simulates host-side manual cleanup
    // of the session directory after archival (validation A10).
    await seedTask({ seriesId: 'task-no-folder', sessionId: 'sess-archived-no-folder', threadId: 'thread-nf' });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(getSession('sess-archived-no-folder')?.status).toBe('active');
    expect(fs.existsSync(sessionDir('ag-yente', 'sess-archived-no-folder'))).toBe(true);
    const { openInboundDb } = await import('./session-manager.js');
    const inDb = openInboundDb('ag-yente', 'sess-archived-no-folder');
    try {
      const taskRows = inDb.prepare("SELECT series_id FROM messages_in WHERE kind = 'task'").all() as Array<{
        series_id: string;
      }>;
      expect(taskRows.some((r) => r.series_id === 'task-no-folder')).toBe(true);
    } finally {
      inDb.close();
    }
    expect(wakeContainerMock).toHaveBeenCalled();
    expect((wakeContainerMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe('sess-archived-no-folder');
  });

  it('agent-shared: revives the latest archived group session for a task whose stored route no longer matches', async () => {
    const { initSessionFolder } = await import('./session-manager.js');
    wireAgentSharedGroup();
    createSession({
      id: 'sess-shared-arch',
      agent_group_id: 'ag-shared',
      messaging_group_id: 'mg-discord',
      thread_id: null,
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    initSessionFolder('ag-shared', 'sess-shared-arch');

    // NULL-route task (a2a-created agent-shared provenance): exact-route IS
    // matching would never select it — the agent-shared arm must.
    await seedTask({
      seriesId: 'task-shared-due',
      sessionId: 'sess-shared-arch',
      agentGroupId: 'ag-shared',
      messagingGroupId: null,
      threadId: null,
      platformId: null,
      channelType: null,
      isGroup: null,
      content: JSON.stringify({ prompt: 'shared wake', script: null }),
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(getSession('sess-shared-arch')?.status).toBe('active');
    expect(wakeContainerMock).toHaveBeenCalled();
    expect((wakeContainerMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe('sess-shared-arch');
  });

  it('agent-shared roll regression: never revives the old sibling while the group has an active session', async () => {
    const { initSessionFolder } = await import('./session-manager.js');
    wireAgentSharedGroup();
    // Post-roll shape: old session archived with its RAW old route, new
    // session active; the old task still route-matches the ARCHIVED row.
    createSession({
      id: 'sess-shared-old',
      agent_group_id: 'ag-shared',
      messaging_group_id: 'mg-discord',
      thread_id: null,
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: STALE,
      created_at: STALE,
    });
    createSession({
      id: 'sess-shared-new',
      agent_group_id: 'ag-shared',
      messaging_group_id: 'mg-discord',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });
    initSessionFolder('ag-shared', 'sess-shared-old');
    initSessionFolder('ag-shared', 'sess-shared-new');
    await seedTask({
      seriesId: 'task-old-route',
      sessionId: 'sess-shared-old',
      agentGroupId: 'ag-shared',
      threadId: null,
      processAfter: '2099-01-01T00:00:00.000Z', // future: no wake expected
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    // The active sibling serves the group's tasks — the archived one must
    // NOT come back (two active agent-shared sessions would break the
    // findSessionByAgentGroup single-session invariant).
    expect(getSession('sess-shared-old')?.status).toBe('archived');
    const active = getSessionsByAgentGroup('ag-shared').filter((sess) => sess.status === 'active');
    expect(active.map((sess) => sess.id)).toEqual(['sess-shared-new']);
  });
});
