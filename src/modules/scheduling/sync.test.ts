import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { withRuntimeLock, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import type { MessagingGroupAgent, Session } from '../../types.js';
import {
  createOrReplaceScheduledTask,
  getScheduledTask,
  pauseScheduledTask,
  type CreateScheduledTaskInput,
} from './ledger.js';
import { projectScheduledTask } from './projection.js';
import { ensureSessionSchedulerProjections, resolveProjectionContext, syncSessionSchedulerState } from './sync.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, TIMEZONE: 'America/Los_Angeles' };
});

const LOCK_NAME = 'scheduler-mutator';
const TEST_DIR = '/tmp/nanoclaw-scheduler-sync-test';
const INBOUND_PATH = path.join(TEST_DIR, 'inbound.db');
const OUTBOUND_PATH = path.join(TEST_DIR, 'outbound.db');

function now(): string {
  return new Date().toISOString();
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
    ...overrides,
  };
}

function messagingGroupAgent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: `mga-${overrides.messaging_group_id ?? 'mg-1'}-${overrides.agent_group_id ?? 'ag-1'}`,
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
    ...overrides,
  };
}

function taskInput(overrides: Partial<CreateScheduledTaskInput> = {}): CreateScheduledTaskInput {
  return {
    seriesId: 'task-1',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    threadId: null,
    platformId: 'chan-1',
    channelType: 'discord',
    isGroup: 1,
    processAfter: '2020-01-01T00:00:00.000Z',
    recurrence: null,
    content: JSON.stringify({ prompt: 'heartbeat', script: null }),
    sessionId: 'sess-1',
    sourceMessageId: `out-${overrides.seriesId ?? 'task-1'}`,
    ...overrides,
  };
}

function freshDbs(): { inDb: Database.Database; outDb: Database.Database } {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(INBOUND_PATH, 'inbound');
  ensureSchema(OUTBOUND_PATH, 'outbound');
  return {
    inDb: openInboundDb(INBOUND_PATH),
    outDb: new Database(OUTBOUND_PATH),
  };
}

async function withSchedulerLock<T>(fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T> {
  return await withRuntimeLock(LOCK_NAME, 120_000, fn);
}

function seedProjectedTask(
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  s: Session,
  overrides: Partial<CreateScheduledTaskInput> = {},
): string {
  const input = taskInput({
    agentGroupId: s.agent_group_id,
    messagingGroupId: s.messaging_group_id,
    threadId: s.thread_id,
    sessionId: s.id,
    ...overrides,
  });
  createOrReplaceScheduledTask(input, owner);
  return projectScheduledTask(inDb, getScheduledTask(input.agentGroupId, input.seriesId)!, s.id, owner);
}

function insertAck(
  outDb: Database.Database,
  messageId: string,
  status: 'completed' | 'failed' | 'processing' | 'recovery',
  noticeMessageOutId: string | null = null,
): void {
  outDb
    .prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed, notice_message_out_id)
       VALUES (?, ?, datetime('now'), ?)`,
    )
    .run(messageId, status, noticeMessageOutId);
}

function incidentRows(): Array<{ dedupe_key: string; severity: string; status: string; series_id: string | null }> {
  return getDb()
    .prepare('SELECT dedupe_key, severity, status, series_id FROM scheduler_incidents ORDER BY created_at, id')
    .all() as Array<{ dedupe_key: string; severity: string; status: string; series_id: string | null }>;
}

function createMockAdapter(channelType: string, supportsThreads: boolean): ChannelAdapter {
  let setupConfig: ChannelSetup | null = null;
  return {
    name: channelType,
    channelType,
    supportsThreads,
    async setup(config) {
      setupConfig = config;
    },
    async teardown() {
      setupConfig = null;
    },
    isConnected() {
      return setupConfig !== null;
    },
    async deliver(_platformId: string, _threadId: string | null, _message: OutboundMessage) {
      return undefined;
    },
  };
}

async function activateAdapter(channelType: string, supportsThreads: boolean): Promise<void> {
  registerChannelAdapter(`sync-test-${channelType}`, {
    factory: () => createMockAdapter(channelType, supportsThreads),
  });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => undefined,
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: () => undefined,
  }));
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
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-1',
    name: 'Yente',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroupAgent(messagingGroupAgent());
  createSession(session());
});

afterEach(async () => {
  vi.useRealTimers();
  await teardownChannelAdapters();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('syncSessionSchedulerState', () => {
  it('marks a projected one-time task completed from a completed ack', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s, { recurrence: null });
      insertAck(outDb, messageId, 'completed');

      syncSessionSchedulerState(inDb, outDb, s, owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'completed',
      projected_session_id: null,
      projected_message_id: null,
      completed_at: expect.any(String),
    });
    expect(inDb.prepare('SELECT status, recurrence FROM messages_in WHERE id = ?').get('task-task-1-g1')).toEqual({
      status: 'completed',
      recurrence: null,
    });
    inDb.close();
    outDb.close();
  });

  it('fans recurring completion through the central ledger and projects the next generation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s, {
        recurrence: '0 9 * * *',
        processAfter: '2025-12-31T17:00:00.000Z',
      });
      insertAck(outDb, messageId, 'completed');

      syncSessionSchedulerState(inDb, outDb, s, owner);
      ensureSessionSchedulerProjections(inDb, s, resolveProjectionContext(s), owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      generation: 2,
      process_after: '2026-01-01T17:00:00.000Z',
      projected_session_id: 'sess-1',
      projected_message_id: 'task-task-1-g2',
    });
    expect(inDb.prepare('SELECT id, status, recurrence, process_after FROM messages_in ORDER BY id').all()).toEqual([
      {
        id: 'task-task-1-g1',
        status: 'completed',
        recurrence: null,
        process_after: '2025-12-31T17:00:00.000Z',
      },
      {
        id: 'task-task-1-g2',
        status: 'pending',
        recurrence: '0 9 * * *',
        process_after: '2026-01-01T17:00:00.000Z',
      },
    ]);
    inDb.close();
    outDb.close();
  });

  it('fails an invalid recurring completion without blocking other projected tasks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const invalidMessageId = seedProjectedTask(inDb, owner, s, {
        seriesId: 'task-invalid',
        recurrence: 'not a cron',
        processAfter: '2025-12-31T17:00:00.000Z',
      });
      const validMessageId = seedProjectedTask(inDb, owner, s, {
        seriesId: 'task-valid',
        recurrence: '0 9 * * *',
        processAfter: '2025-12-31T17:00:00.000Z',
      });
      insertAck(outDb, invalidMessageId, 'completed');
      insertAck(outDb, validMessageId, 'completed');

      syncSessionSchedulerState(inDb, outDb, s, owner);
    });

    expect(getScheduledTask('ag-1', 'task-invalid')).toMatchObject({
      status: 'failed',
      projected_session_id: null,
      projected_message_id: null,
      last_error: expect.stringContaining('Invalid recurrence'),
    });
    expect(getScheduledTask('ag-1', 'task-valid')).toMatchObject({
      status: 'pending',
      generation: 2,
      process_after: '2026-01-01T17:00:00.000Z',
      projected_session_id: 'sess-1',
      projected_message_id: 'task-task-valid-g2',
    });
    expect(
      inDb
        .prepare('SELECT id, status, recurrence FROM messages_in WHERE series_id = ? ORDER BY id')
        .all('task-invalid'),
    ).toEqual([{ id: 'task-task-invalid-g1', status: 'completed', recurrence: null }]);
    expect(
      inDb.prepare('SELECT id, status, recurrence FROM messages_in WHERE series_id = ? ORDER BY id').all('task-valid'),
    ).toEqual([
      { id: 'task-task-valid-g1', status: 'completed', recurrence: null },
      { id: 'task-task-valid-g2', status: 'pending', recurrence: '0 9 * * *' },
    ]);
    expect(incidentRows()).toHaveLength(1);
    expect(incidentRows()[0]).toMatchObject({
      severity: 'error',
      status: 'pending',
      series_id: 'task-invalid',
    });
    expect(incidentRows()[0].dedupe_key).toContain('invalid-recurrence');
    inDb.close();
    outDb.close();
  });

  it('marks a projected task failed only when the failed ack has terminal notice proof', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s);
      outDb
        .prepare(
          `INSERT INTO messages_out (id, seq, timestamp, kind, content)
           VALUES ('notice-1', 1, datetime('now'), 'chat', '{"text":"task failed"}')`,
        )
        .run();
      insertAck(outDb, messageId, 'failed', 'notice-1');

      syncSessionSchedulerState(inDb, outDb, s, owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'failed',
      projected_session_id: null,
      projected_message_id: null,
      last_error: expect.stringContaining('notice-1'),
    });
    expect(incidentRows()).toHaveLength(1);
    expect(incidentRows()[0]).toMatchObject({ severity: 'error', status: 'pending', series_id: 'task-1' });
    inDb.close();
    outDb.close();
  });

  it('repairs an invalid failed ack by recording an incident and projecting a fresh generation', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s);
      insertAck(outDb, messageId, 'failed');

      syncSessionSchedulerState(inDb, outDb, s, owner);
      ensureSessionSchedulerProjections(inDb, s, resolveProjectionContext(s), owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      generation: 2,
      projected_session_id: 'sess-1',
      projected_message_id: 'task-task-1-g2',
    });
    expect(inDb.prepare('SELECT id, status, recurrence FROM messages_in ORDER BY id').all()).toEqual([
      { id: 'task-task-1-g1', status: 'completed', recurrence: null },
      { id: 'task-task-1-g2', status: 'pending', recurrence: null },
    ]);
    expect(incidentRows()).toHaveLength(1);
    expect(incidentRows()[0].dedupe_key).toContain('invalid-failed-ack');
    inDb.close();
    outDb.close();
  });

  it('records recovery-owned scheduler projections without clearing recurrence or re-running them', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s, { recurrence: '0 9 * * *' });
      insertAck(outDb, messageId, 'recovery');

      syncSessionSchedulerState(inDb, outDb, s, owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      generation: 1,
      projected_session_id: 'sess-1',
      projected_message_id: 'task-task-1-g1',
    });
    expect(inDb.prepare('SELECT status, recurrence FROM messages_in WHERE id = ?').get('task-task-1-g1')).toEqual({
      status: 'pending',
      recurrence: '0 9 * * *',
    });
    expect(incidentRows()).toHaveLength(1);
    expect(incidentRows()[0].dedupe_key).toContain('unresolved-ack');
    inDb.close();
    outDb.close();
  });

  it('leaves processing acks alone for ordinary stuck-turn recovery', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s);
      insertAck(outDb, messageId, 'processing');

      syncSessionSchedulerState(inDb, outDb, s, owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      generation: 1,
      projected_session_id: 'sess-1',
      projected_message_id: 'task-task-1-g1',
    });
    expect(incidentRows()).toHaveLength(0);
    inDb.close();
    outDb.close();
  });

  it('reconciles an already-completed inbound projection even when a stale recovery ack lingers', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      const messageId = seedProjectedTask(inDb, owner, s, { recurrence: null });
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(messageId);
      insertAck(outDb, messageId, 'recovery');

      syncSessionSchedulerState(inDb, outDb, s, owner);
      syncSessionSchedulerState(inDb, outDb, s, owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'completed',
      generation: 1,
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(incidentRows()).toHaveLength(0);
    inDb.close();
    outDb.close();
  });

  it('does not wake paused tasks when projection repair runs', async () => {
    const { inDb, outDb } = freshDbs();
    const s = session();

    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(taskInput({ sessionId: s.id }), owner);
      pauseScheduledTask('ag-1', 'task-1', { sessionId: s.id, messageId: 'out-pause' }, owner);

      ensureSessionSchedulerProjections(inDb, s, resolveProjectionContext(s), owner);
    });

    expect(inDb.prepare('SELECT status, trigger FROM messages_in WHERE id = ?').get('task-task-1-g2')).toEqual({
      status: 'paused',
      trigger: 1,
    });
    expect(
      inDb
        .prepare(
          `SELECT COUNT(*) AS c FROM messages_in
         WHERE status = 'pending'
           AND trigger = 1
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
        )
        .get(),
    ).toEqual({ c: 0 });
    inDb.close();
    outDb.close();
  });
});

describe('resolveProjectionContext', () => {
  it('uses shared routing from the central messaging group wiring', () => {
    expect(resolveProjectionContext(session({ thread_id: 'ignored-thread' }))).toEqual({
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      threadId: null,
      sessionMode: 'shared',
    });
  });

  it('applies the router per-thread override when an active group adapter supports threads', async () => {
    await activateAdapter('discord', true);

    expect(resolveProjectionContext(session({ thread_id: 'thread-1' }))).toEqual({
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      threadId: 'thread-1',
      sessionMode: 'per-thread',
    });
  });

  it('uses explicit agent-shared wiring for sessions without a messaging group', () => {
    getDb()
      .prepare('UPDATE messaging_group_agents SET session_mode = ? WHERE messaging_group_id = ? AND agent_group_id = ?')
      .run('agent-shared', 'mg-1', 'ag-1');

    expect(resolveProjectionContext(session({ messaging_group_id: null, thread_id: null }))).toEqual({
      agentGroupId: 'ag-1',
      messagingGroupId: null,
      threadId: null,
      sessionMode: 'agent-shared',
    });
  });

  it('falls back to a route-null shared context for sessions without a messaging group and no agent-shared wiring', () => {
    expect(resolveProjectionContext(session({ messaging_group_id: null, thread_id: null }))).toEqual({
      agentGroupId: 'ag-1',
      messagingGroupId: null,
      threadId: null,
      sessionMode: 'shared',
    });
  });

  it('returns null for missing or ambiguous route data instead of trusting the session row alone', () => {
    expect(resolveProjectionContext(session({ messaging_group_id: 'mg-missing' }))).toBeNull();
  });
});
