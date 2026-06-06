import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { withRuntimeLock, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import { clearDeliveryAdapterForTest } from '../../delivery.js';
import { initSessionFolder, openInboundDb, resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelScheduledTask, createOrReplaceScheduledTask, getScheduledTask } from './ledger.js';
import { importLegacyActiveTasks } from './legacy-import.js';
import { ensureSessionSchedulerProjections, resolveProjectionContext } from './sync.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-scheduler-legacy-import', TIMEZONE: 'America/Los_Angeles' };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduler-legacy-import';
const LOCK_NAME = 'scheduler-mutator';

interface LegacyTaskSeed {
  id: string;
  seriesId: string | null;
  status: 'pending' | 'paused' | 'completed';
  processAfter: string | null;
  recurrence: string | null;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  messagingGroupId: string | null;
  isGroup: 0 | 1 | null;
  content: string;
  seq: number;
}

function now(): string {
  return new Date().toISOString();
}

async function withSchedulerLock<T>(fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T> {
  return await withRuntimeLock(LOCK_NAME, 120_000, fn);
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
  vi.useRealTimers();
  clearDeliveryAdapterForTest();
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('importLegacyActiveTasks', () => {
  it('imports active pending and paused legacy task rows into the durable ledger', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-pending',
        seriesId: 'series-pending',
        status: 'pending',
        processAfter: '2026-06-06T12:00:00.000Z',
        recurrence: '0 9 * * *',
        platformId: 'channel',
        channelType: 'discord',
        threadId: 'thread-1',
        messagingGroupId: 'mg-discord',
        isGroup: 1,
        content: JSON.stringify({ prompt: 'pending heartbeat', script: null }),
        seq: 2,
      });
      insertLegacyTask(inDb, {
        id: 'legacy-paused',
        seriesId: 'series-paused',
        status: 'paused',
        processAfter: '2026-06-07T12:00:00.000Z',
        recurrence: null,
        platformId: 'channel',
        channelType: 'discord',
        threadId: 'thread-1',
        messagingGroupId: 'mg-discord',
        isGroup: 1,
        content: JSON.stringify({ prompt: 'paused heartbeat', script: 'echo paused' }),
        seq: 3,
      });

      const result = await withSchedulerLock(async (owner) => {
        const imported = await importLegacyActiveTasks(inDb, session, owner);
        const pendingProjectedBefore = getScheduledTask('ag-yente', 'series-pending')?.projected_message_id;
        const pausedProjectedBefore = getScheduledTask('ag-yente', 'series-paused')?.projected_message_id;
        const projected = ensureSessionSchedulerProjections(inDb, session, resolveProjectionContext(session), owner);
        return { imported, pausedProjectedBefore, pendingProjectedBefore, projected };
      });

      expect(result).toEqual({
        imported: 2,
        pendingProjectedBefore: 'legacy-pending',
        pausedProjectedBefore: 'legacy-paused',
        projected: 2,
      });
      expect(getScheduledTask('ag-yente', 'series-pending')).toMatchObject({
        series_id: 'series-pending',
        agent_group_id: 'ag-yente',
        messaging_group_id: 'mg-discord',
        thread_id: 'thread-1',
        platform_id: 'channel',
        channel_type: 'discord',
        is_group: 1,
        status: 'pending',
        process_after: '2026-06-06T12:00:00.000Z',
        recurrence: '0 9 * * *',
        content: JSON.stringify({ prompt: 'pending heartbeat', script: null }),
        generation: 1,
        projected_session_id: session.id,
        projected_message_id: 'task-series-pending-g1',
      });
      expect(getScheduledTask('ag-yente', 'series-paused')).toMatchObject({
        status: 'paused',
        process_after: '2026-06-07T12:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'paused heartbeat', script: 'echo paused' }),
        projected_session_id: session.id,
        projected_message_id: 'task-series-paused-g1',
      });
      expect(projectedRows(inDb)).toEqual([
        { id: 'legacy-paused', recurrence: null, series_id: 'series-paused', status: 'completed' },
        { id: 'legacy-pending', recurrence: null, series_id: 'series-pending', status: 'completed' },
        { id: 'task-series-paused-g1', recurrence: null, series_id: 'series-paused', status: 'paused' },
        { id: 'task-series-pending-g1', recurrence: '0 9 * * *', series_id: 'series-pending', status: 'pending' },
      ]);
      expect(eventTypes('series-pending')).toEqual(['legacy_imported', 'projected']);
      expect(eventTypes('series-paused')).toEqual(['legacy_imported', 'projected']);
      expect(incidentKeys()).toEqual([]);
    } finally {
      inDb.close();
    }
  });

  it('imports completed recurring legacy rows as the next pending run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-completed',
        seriesId: 'series-completed',
        status: 'completed',
        processAfter: '2025-12-31T17:00:00.000Z',
        recurrence: '0 9 * * *',
        platformId: 'channel',
        channelType: 'discord',
        threadId: 'thread-1',
        messagingGroupId: 'mg-discord',
        isGroup: 1,
        content: JSON.stringify({ prompt: 'completed heartbeat', script: null }),
        seq: 2,
      });

      const result = await withSchedulerLock(async (owner) => {
        const imported = await importLegacyActiveTasks(inDb, session, owner);
        const projected = ensureSessionSchedulerProjections(inDb, session, resolveProjectionContext(session), owner);
        return { imported, projected };
      });

      expect(result).toEqual({ imported: 1, projected: 1 });
      expect(getScheduledTask('ag-yente', 'series-completed')).toMatchObject({
        series_id: 'series-completed',
        status: 'pending',
        process_after: '2026-01-01T17:00:00.000Z',
        recurrence: '0 9 * * *',
        content: JSON.stringify({ prompt: 'completed heartbeat', script: null }),
        generation: 1,
        projected_session_id: session.id,
        projected_message_id: 'task-series-completed-g1',
      });
      expect(projectedRows(inDb)).toEqual([
        { id: 'legacy-completed', recurrence: null, series_id: 'series-completed', status: 'completed' },
        { id: 'task-series-completed-g1', recurrence: '0 9 * * *', series_id: 'series-completed', status: 'pending' },
      ]);
      expect(eventTypes('series-completed').sort()).toEqual(['legacy_imported', 'projected'].sort());
      expect(incidentKeys()).toEqual([]);
    } finally {
      inDb.close();
    }
  });

  it('reports malformed completed recurring rows without blocking other legacy imports', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-invalid-recurring',
        seriesId: 'series-invalid-recurring',
        status: 'completed',
        processAfter: '2025-12-31T17:00:00.000Z',
        recurrence: 'not a cron',
        seq: 2,
      });
      insertLegacyTask(inDb, {
        id: 'legacy-still-imported',
        seriesId: 'series-still-imported',
        status: 'pending',
        processAfter: '2026-06-06T12:00:00.000Z',
        recurrence: null,
        seq: 3,
      });

      const imported = await withSchedulerLock((owner) => importLegacyActiveTasks(inDb, session, owner));

      expect(imported).toBe(1);
      expect(getScheduledTask('ag-yente', 'series-invalid-recurring')).toBeUndefined();
      expect(getScheduledTask('ag-yente', 'series-still-imported')).toMatchObject({
        status: 'pending',
        process_after: '2026-06-06T12:00:00.000Z',
        projected_session_id: session.id,
        projected_message_id: 'legacy-still-imported',
      });
      expect(incidentKeys()).toEqual([`legacy-invalid-recurrence:${session.id}:legacy-invalid-recurring`]);
      expect(incidentDetails(`legacy-invalid-recurrence:${session.id}:legacy-invalid-recurring`)).toMatchObject({
        reason: 'invalid-recurrence',
        messageId: 'legacy-invalid-recurring',
        recurrence: 'not a cron',
      });
    } finally {
      inDb.close();
    }
  });

  it('skips and reports active legacy rows whose central session is missing', async () => {
    const session = fakeSession({ id: 'sess-missing-central' });
    initSessionFolder(session.agent_group_id, session.id);
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-missing-session',
        seriesId: 'series-missing-session',
        messagingGroupId: 'mg-discord',
      });

      const imported = await withSchedulerLock((owner) => importLegacyActiveTasks(inDb, session, owner));

      expect(imported).toBe(0);
      expect(getScheduledTask('ag-yente', 'series-missing-session')).toBeUndefined();
      expect(incidentKeys()).toEqual([`legacy-invalid-refs:${session.id}:legacy-missing-session`]);
      expect(incidentDetails(`legacy-invalid-refs:${session.id}:legacy-missing-session`)).toMatchObject({
        reason: 'missing-session',
        messageId: 'legacy-missing-session',
      });
    } finally {
      inDb.close();
    }
  });

  it('skips and reports active legacy rows whose messaging group is missing', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-missing-mg',
        seriesId: 'series-missing-mg',
        messagingGroupId: 'mg-missing',
      });

      const imported = await withSchedulerLock((owner) => importLegacyActiveTasks(inDb, session, owner));

      expect(imported).toBe(0);
      expect(getScheduledTask('ag-yente', 'series-missing-mg')).toBeUndefined();
      expect(incidentKeys()).toEqual([`legacy-invalid-refs:${session.id}:legacy-missing-mg`]);
      expect(incidentDetails(`legacy-invalid-refs:${session.id}:legacy-missing-mg`)).toMatchObject({
        reason: 'missing-messaging-group',
        messageId: 'legacy-missing-mg',
        messagingGroupId: 'mg-missing',
      });
    } finally {
      inDb.close();
    }
  });

  it('skips and reports active legacy rows whose agent group is missing', async () => {
    const session = fakeSession({
      id: 'sess-missing-agent',
      agent_group_id: 'ag-missing',
      messaging_group_id: 'mg-discord',
    });
    getDb().pragma('foreign_keys = OFF');
    try {
      createSession(session);
    } finally {
      getDb().pragma('foreign_keys = ON');
    }
    initSessionFolder(session.agent_group_id, session.id);
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-missing-agent',
        seriesId: 'series-missing-agent',
        messagingGroupId: 'mg-discord',
      });

      const imported = await withSchedulerLock((owner) => importLegacyActiveTasks(inDb, session, owner));

      expect(imported).toBe(0);
      expect(getScheduledTask('ag-missing', 'series-missing-agent')).toBeUndefined();
      expect(incidentKeys()).toEqual([`legacy-invalid-refs:${session.id}:legacy-missing-agent`]);
      expect(incidentDetails(`legacy-invalid-refs:${session.id}:legacy-missing-agent`)).toMatchObject({
        reason: 'missing-agent-group',
        messageId: 'legacy-missing-agent',
        agentGroupId: 'ag-missing',
      });
    } finally {
      inDb.close();
    }
  });

  it('does not resurrect a central terminal task from an active legacy row', async () => {
    const { session } = resolveSession('ag-yente', 'mg-discord', 'thread-1', 'per-thread');
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(
        {
          seriesId: 'series-terminal',
          agentGroupId: 'ag-yente',
          messagingGroupId: 'mg-discord',
          threadId: 'thread-1',
          platformId: 'channel',
          channelType: 'discord',
          isGroup: 1,
          processAfter: '2026-06-01T12:00:00.000Z',
          recurrence: null,
          content: JSON.stringify({ prompt: 'old', script: null }),
          sessionId: session.id,
          sourceMessageId: 'seed-terminal',
        },
        owner,
      );
      cancelScheduledTask('ag-yente', 'series-terminal', { sessionId: session.id, messageId: 'cancel-terminal' }, owner);
    });

    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      insertLegacyTask(inDb, {
        id: 'legacy-terminal',
        seriesId: 'series-terminal',
        processAfter: '2026-06-09T12:00:00.000Z',
        content: JSON.stringify({ prompt: 'resurrect me', script: null }),
      });

      const imported = await withSchedulerLock((owner) => importLegacyActiveTasks(inDb, session, owner));

      expect(imported).toBe(0);
      expect(getScheduledTask('ag-yente', 'series-terminal')).toMatchObject({
        status: 'cancelled',
        process_after: '2026-06-01T12:00:00.000Z',
        content: JSON.stringify({ prompt: 'old', script: null }),
      });
      expect(incidentKeys()).toEqual([]);
    } finally {
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

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-fake',
    agent_group_id: 'ag-yente',
    messaging_group_id: 'mg-discord',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
    ...overrides,
  };
}

function insertLegacyTask(db: ReturnType<typeof openInboundDb>, overrides: Partial<LegacyTaskSeed> = {}): void {
  const row: LegacyTaskSeed = {
    id: 'legacy-task',
    seriesId: 'series-legacy',
    status: 'pending',
    processAfter: '2026-06-06T12:00:00.000Z',
    recurrence: '0 9 * * *',
    platformId: 'channel',
    channelType: 'discord',
    threadId: 'thread-1',
    messagingGroupId: 'mg-discord',
    isGroup: 1,
    content: JSON.stringify({ prompt: 'legacy heartbeat', script: null }),
    seq: 2,
    ...overrides,
  };

  db.prepare(
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
       @seq,
       'task',
       @timestamp,
       @status,
       @processAfter,
       @recurrence,
       1,
       @platformId,
       @channelType,
       @threadId,
       @messagingGroupId,
       @isGroup,
       @content,
       @seriesId
     )`,
  ).run({ ...row, timestamp: now() });
}

function eventTypes(seriesId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT event_type FROM scheduled_task_events
         WHERE agent_group_id = 'ag-yente'
           AND series_id = ?
         ORDER BY created_at, id`,
      )
      .all(seriesId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function incidentKeys(): string[] {
  return (
    getDb().prepare('SELECT dedupe_key FROM scheduler_incidents ORDER BY dedupe_key').all() as Array<{
      dedupe_key: string;
    }>
  ).map((row) => row.dedupe_key);
}

function projectedRows(db: ReturnType<typeof openInboundDb>): Array<{
  id: string;
  recurrence: string | null;
  series_id: string;
  status: string;
}> {
  return db
    .prepare(
      `SELECT id, recurrence, series_id, status
         FROM messages_in
        WHERE kind = 'task'
        ORDER BY id`,
    )
    .all() as Array<{ id: string; recurrence: string | null; series_id: string; status: string }>;
}

function incidentDetails(dedupeKey: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT details_json FROM scheduler_incidents WHERE dedupe_key = ?').get(dedupeKey) as
    | { details_json: string }
    | undefined;
  if (!row) throw new Error(`Missing incident ${dedupeKey}`);
  return JSON.parse(row.details_json) as Record<string, unknown>;
}
