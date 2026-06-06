import Database from 'better-sqlite3';
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
} from '../db/index.js';
import { withRuntimeLock } from '../db/runtime-locks.js';
import { getSession, updateSession } from '../db/sessions.js';
import { setDeliveryAdapter } from '../delivery.js';
import { createOrReplaceScheduledTask, getScheduledTask } from '../modules/scheduling/ledger.js';
import { inboundDbPath, resolveSession, writeOutboundDirect } from '../session-manager.js';
import { resetYenteSessionPreservingScheduler } from './scheduler-reset.js';
import { resumeSchedulerSupersession } from './scheduler-reset-repair.js';
import {
  recordSchedulerSupersessionError,
  recordSchedulerSupersessionPhase,
  RouteResetInProgressError,
} from './scheduler-supersessions.js';

const stopContainerAndVerifyMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../container-runner.js', () => ({
  stopContainerAndVerify: stopContainerAndVerifyMock,
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-scheduler-reset' };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduler-reset';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  seedRoute();
  stopContainerAndVerifyMock.mockReset();
  stopContainerAndVerifyMock.mockResolvedValue(undefined);
  setDeliveryAdapter({
    async deliver() {
      return undefined;
    },
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('resetYenteSessionPreservingScheduler', () => {
  it('drains old scheduling actions, syncs old state, creates a fresh active session, and projects live tasks', async () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
      createOrReplaceScheduledTask(
        {
          seriesId: 'central-task',
          agentGroupId: 'ag-yente',
          messagingGroupId: 'mg-discord',
          threadId: 'thread-1',
          platformId: 'chan-1',
          channelType: 'discord',
          isGroup: 1,
          processAfter: '2026-06-06T12:00:00.000Z',
          recurrence: null,
          content: JSON.stringify({ prompt: 'central heartbeat', script: null }),
          sessionId: oldSession.id,
          sourceMessageId: 'seed-central-task',
        },
        owner,
      );
    });
    writeOutboundDirect('ag-yente', oldSession.id, {
      id: 'old-schedule-action',
      kind: 'system',
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: 'thread-1',
      content: JSON.stringify({
        action: 'schedule_task',
        taskId: 'drained-task',
        prompt: 'drained heartbeat',
        script: null,
        processAfter: '2026-06-07T12:00:00.000Z',
        recurrence: null,
        platformId: 'chan-1',
        channelType: 'discord',
        threadId: 'thread-1',
        messagingGroupId: 'mg-discord',
        isGroup: 1,
      }),
    });

    const fresh = await resetYenteSessionPreservingScheduler({
      command: 'new',
      oldSession,
      sessionMode: 'per-thread',
      responseAddress: {
        channelType: 'discord',
        platformId: 'chan-1',
        threadId: 'thread-1',
      },
    });

    expect(getSession(oldSession.id)?.status).toBe('archived');
    expect(getSession(fresh.id)?.status).toBe('active');
    expect(fresh.id).not.toBe(oldSession.id);
    expect(getScheduledTask('ag-yente', 'drained-task')).toMatchObject({
      status: 'pending',
      process_after: '2026-06-07T12:00:00.000Z',
    });
    const freshIn = new Database(inboundDbPath('ag-yente', fresh.id));
    try {
      expect(
        freshIn.prepare("SELECT series_id, status FROM messages_in WHERE kind = 'task' ORDER BY series_id").all(),
      ).toEqual([
        { series_id: 'central-task', status: 'pending' },
        { series_id: 'drained-task', status: 'pending' },
      ]);
    } finally {
      freshIn.close();
    }
    expect(supersessionPhase(oldSession.id)).toBe('fresh-activated');
  });

  it('blocks competing route session creation while a supersession is unfinished', () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    updateSession(oldSession.id, { status: 'resetting' });
    recordSchedulerSupersessionPhase({
      oldSession,
      freshSessionId: 'fresh-pending',
      command: 'new',
      sessionMode: 'per-thread',
      phase: 'old-resetting',
    });

    expect(() => resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread')).toThrow(
      RouteResetInProgressError,
    );
  });

  it('resumes an unfinished supersession forward to exactly one active session', async () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const delivered: Array<{ channelType: string; platformId: string; threadId: string | null; text: string }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, _kind, content) {
        delivered.push({ channelType, platformId, threadId, text: JSON.parse(content).text });
        return `platform-${delivered.length}`;
      },
    });
    updateSession(oldSession.id, { status: 'resetting' });
    recordSchedulerSupersessionPhase({
      oldSession,
      freshSessionId: 'fresh-repair',
      command: 'clear',
      sessionMode: 'per-thread',
      responseAddress: {
        channelType: 'discord',
        platformId: 'reply-channel',
        threadId: 'reply-thread',
      },
      phase: 'old-resetting',
    });

    await resumeSchedulerSupersession(oldSession.id);

    expect(getSession(oldSession.id)?.status).toBe('archived');
    expect(getSession('fresh-repair')?.status).toBe('active');
    expect(
      getDb()
        .prepare(
          `SELECT id FROM sessions
           WHERE agent_group_id = 'ag-yente'
             AND messaging_group_id = 'mg-discord'
             AND thread_id = 'thread-1'
             AND status = 'active'`,
        )
        .all(),
    ).toEqual([{ id: 'fresh-repair' }]);
    expect(delivered).toEqual([
      {
        channelType: 'discord',
        platformId: 'reply-channel',
        threadId: 'reply-thread',
        text: 'Started a fresh session: fresh-repair',
      },
    ]);
    expect(supersessionPhase(oldSession.id)).toBe('response-delivered');
  });

  it('keeps repaired supersessions unfinished when repair cannot deliver the host response', async () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    setDeliveryAdapter({
      async deliver() {
        throw new Error('adapter unavailable');
      },
    });
    updateSession(oldSession.id, { status: 'resetting' });
    recordSchedulerSupersessionPhase({
      oldSession,
      freshSessionId: 'fresh-repair-delivery-fails',
      command: 'new',
      sessionMode: 'per-thread',
      phase: 'old-resetting',
    });

    await resumeSchedulerSupersession(oldSession.id);

    expect(supersessionPhase(oldSession.id)).toBe('old-outbound-suppressed');
    expect(
      getDb()
        .prepare("SELECT status FROM scheduler_incidents WHERE dedupe_key LIKE 'scheduler-reset:%:response-delivered'")
        .get(),
    ).toEqual({ status: 'pending' });
  });

  it('does not move supersession phases backward when stale repair state records an error', () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    recordSchedulerSupersessionPhase({
      oldSession,
      freshSessionId: 'fresh-forward-only',
      command: 'new',
      sessionMode: 'per-thread',
      phase: 'fresh-activated',
    });

    recordSchedulerSupersessionError(oldSession.id, 'old-resetting', new Error('stale failure'));

    expect(supersessionPhase(oldSession.id)).toBe('fresh-activated');
  });

  it('allows a pre-side-effect failed reset row to be retried for the same active session', async () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    recordSchedulerSupersessionPhase({
      oldSession,
      freshSessionId: 'fresh-failed-before-side-effects',
      command: 'new',
      sessionMode: 'per-thread',
      phase: 'failed',
      error: new Error('previous lock contention'),
    });

    const fresh = await resetYenteSessionPreservingScheduler({
      command: 'new',
      oldSession,
      sessionMode: 'per-thread',
      responseAddress: {
        channelType: 'discord',
        platformId: 'chan-1',
        threadId: 'thread-1',
      },
    });

    expect(fresh.id).not.toBe('fresh-failed-before-side-effects');
    expect(supersessionPhase(oldSession.id)).toBe('fresh-activated');
    expect(
      getDb()
        .prepare('SELECT new_session_id, finished_at FROM scheduler_session_supersessions WHERE old_session_id = ?')
        .get(oldSession.id),
    ).toEqual({ new_session_id: fresh.id, finished_at: null });
  });

  it('does not mark an existing in-progress supersession failed when a competing reset cannot acquire the lock', async () => {
    const { session: oldSession } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    recordSchedulerSupersessionPhase({
      oldSession,
      freshSessionId: 'fresh-in-progress',
      command: 'new',
      sessionMode: 'per-thread',
      phase: 'old-resetting',
    });
    getDb()
      .prepare(
        `INSERT INTO runtime_locks (name, owner_id, owner_token, expires_at, acquired_at, renewed_at)
         VALUES ('scheduler-mutator', 'other-owner', 'other-token', ?, ?, ?)`,
      )
      .run(new Date(Date.now() + 60_000).toISOString(), now(), now());

    await expect(
      resetYenteSessionPreservingScheduler({
        command: 'new',
        oldSession,
        sessionMode: 'per-thread',
        responseAddress: {
          channelType: 'discord',
          platformId: 'chan-1',
          threadId: 'thread-1',
        },
      }),
    ).rejects.toThrow('Yente scheduler-aware reset failed');

    expect(supersessionPhase(oldSession.id)).toBe('old-resetting');
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
    platform_id: 'chan-1',
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

function supersessionPhase(oldSessionId: string): string | undefined {
  return (
    getDb()
      .prepare('SELECT phase FROM scheduler_session_supersessions WHERE old_session_id = ?')
      .get(oldSessionId) as { phase: string } | undefined
  )?.phase;
}
