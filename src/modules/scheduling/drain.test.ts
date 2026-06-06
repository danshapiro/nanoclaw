import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  testDir: '/tmp/nanoclaw-scheduler-drain-test',
  isSessionOutboundWriterRunning: vi.fn(),
  wakeContainer: vi.fn(),
}));

vi.mock('../../container-runner.js', () => ({
  isSessionOutboundWriterRunning: mocks.isSessionOutboundWriterRunning,
  wakeContainer: mocks.wakeContainer,
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: mocks.testDir };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { withRuntimeLock, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath, outboundDbPath, resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getScheduledTask } from './ledger.js';
import { drainSchedulingActionsFromStoppedSession } from './drain.js';

const LOCK_NAME = 'scheduler-mutator';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
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
}

function freshSession(): Session {
  return resolveSession('ag-1', 'mg-1', 'thread-1', 'shared').session;
}

function scheduleAction(taskId = 'task-1', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'schedule_task',
    taskId,
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

function insertOutbound(
  session: Session,
  id: string,
  kind: 'chat' | 'system',
  content: Record<string, unknown>,
  timestamp = "datetime('now')",
): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  try {
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ${timestamp}, ?, 'chan-1', 'discord', 'thread-1', ?)`,
    ).run(id, kind, JSON.stringify(content));
  } finally {
    db.close();
  }
}

function deliveredRows(session: Session): string[] {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    return (db.prepare('SELECT message_out_id FROM delivered ORDER BY message_out_id').all() as Array<{
      message_out_id: string;
    }>).map((row) => row.message_out_id);
  } finally {
    db.close();
  }
}

function deleteDeliveredRow(session: Session, messageOutId: string): void {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    db.prepare('DELETE FROM delivered WHERE message_out_id = ?').run(messageOutId);
  } finally {
    db.close();
  }
}

function inboundKinds(session: Session): string[] {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    return (db.prepare('SELECT kind FROM messages_in ORDER BY seq').all() as Array<{ kind: string }>).map(
      (row) => row.kind,
    );
  } finally {
    db.close();
  }
}

function drainedRows(): Array<{
  message_out_id: string;
  action: string;
  status: string;
  intent_at: string;
  applied_at: string | null;
}> {
  return getDb()
    .prepare(
      `SELECT message_out_id, action, status, intent_at, applied_at
       FROM scheduler_drained_actions
       ORDER BY message_out_id`,
    )
    .all() as Array<{
    message_out_id: string;
    action: string;
    status: string;
    intent_at: string;
    applied_at: string | null;
  }>;
}

function schedulerEventTypes(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT event_type
         FROM scheduled_task_events
         WHERE series_id = 'task-1'
           AND event_type IN ('scheduled', 'paused', 'resumed', 'updated', 'cancelled')
         ORDER BY rowid`,
      )
      .all() as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

async function withSchedulerLock<T>(fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T> {
  return await withRuntimeLock(LOCK_NAME, 120_000, fn);
}

async function drain(session: Session): Promise<number> {
  return await withSchedulerLock((owner) => drainSchedulingActionsFromStoppedSession(session, owner));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.isSessionOutboundWriterRunning.mockReset();
  mocks.isSessionOutboundWriterRunning.mockResolvedValue(false);
  mocks.wakeContainer.mockReset();
  if (fs.existsSync(mocks.testDir)) fs.rmSync(mocks.testDir, { recursive: true, force: true });
  fs.mkdirSync(mocks.testDir, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  seedAgentAndChannel();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(mocks.testDir)) fs.rmSync(mocks.testDir, { recursive: true, force: true });
});

describe('drainSchedulingActionsFromStoppedSession', () => {
  it('applies due scheduling system rows and marks only those rows delivered', async () => {
    const session = freshSession();
    insertOutbound(session, 'out-chat', 'chat', { text: 'do not deliver' });
    insertOutbound(session, 'out-1-schedule', 'system', scheduleAction());
    insertOutbound(session, 'out-2-pause', 'system', { action: 'pause_task', taskId: 'task-1' });
    insertOutbound(session, 'out-3-resume', 'system', { action: 'resume_task', taskId: 'task-1' });
    insertOutbound(session, 'out-4-update', 'system', {
      action: 'update_task',
      taskId: 'task-1',
      prompt: 'updated heartbeat',
      script: 'echo ok',
      processAfter: '2026-06-07T12:00:00.000Z',
      recurrence: null,
    });
    insertOutbound(session, 'out-5-cancel', 'system', { action: 'cancel_task', taskId: 'task-1' });

    await expect(drain(session)).resolves.toBe(5);

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'cancelled',
      process_after: '2026-06-07T12:00:00.000Z',
      recurrence: null,
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(schedulerEventTypes()).toEqual(['scheduled', 'paused', 'resumed', 'updated', 'cancelled']);
    expect(deliveredRows(session)).toEqual([
      'out-1-schedule',
      'out-2-pause',
      'out-3-resume',
      'out-4-update',
      'out-5-cancel',
    ]);
    expect(drainedRows()).toEqual([
      expect.objectContaining({ message_out_id: 'out-1-schedule', action: 'schedule_task', status: 'applied' }),
      expect.objectContaining({ message_out_id: 'out-2-pause', action: 'pause_task', status: 'applied' }),
      expect.objectContaining({ message_out_id: 'out-3-resume', action: 'resume_task', status: 'applied' }),
      expect.objectContaining({ message_out_id: 'out-4-update', action: 'update_task', status: 'applied' }),
      expect.objectContaining({ message_out_id: 'out-5-cancel', action: 'cancel_task', status: 'applied' }),
    ]);
    for (const row of drainedRows()) {
      expect(row.intent_at).toEqual(expect.any(String));
      expect(row.applied_at).toEqual(expect.any(String));
      expect(row.applied_at! >= row.intent_at).toBe(true);
    }
  });

  it('resumes intent rows and skips already-applied rows without reapplying ledger events', async () => {
    const session = freshSession();
    insertOutbound(session, 'out-schedule', 'system', scheduleAction());

    getDb()
      .prepare(
        `INSERT INTO scheduler_drained_actions
           (old_session_id, message_out_id, action, status, intent_at, details_json)
         VALUES (?, ?, 'schedule_task', 'intent', ?, '{}')`,
      )
      .run(session.id, 'out-schedule', now());

    await expect(drain(session)).resolves.toBe(1);
    expect(schedulerEventTypes()).toEqual(['scheduled']);

    deleteDeliveredRow(session, 'out-schedule');

    await expect(drain(session)).resolves.toBe(0);
    expect(schedulerEventTypes()).toEqual(['scheduled']);
    expect(deliveredRows(session)).toEqual(['out-schedule']);
    expect(drainedRows()).toEqual([
      expect.objectContaining({ message_out_id: 'out-schedule', action: 'schedule_task', status: 'applied' }),
    ]);
  });

  it('applies order-dependent scheduling actions by outbound seq, not timestamp ties', async () => {
    const session = freshSession();
    insertOutbound(
      session,
      'out-schedule',
      'system',
      scheduleAction(),
      "'2026-06-05T00:00:02.000Z'",
    );
    insertOutbound(
      session,
      'out-update',
      'system',
      {
        action: 'update_task',
        taskId: 'task-1',
        prompt: 'updated heartbeat',
        processAfter: '2026-06-07T12:00:00.000Z',
      },
      "'2026-06-05T00:00:01.000Z'",
    );

    await expect(drain(session)).resolves.toBe(2);

    const task = getScheduledTask('ag-1', 'task-1')!;
    expect(JSON.parse(task.content)).toMatchObject({ prompt: 'updated heartbeat' });
    expect(task.process_after).toBe('2026-06-07T12:00:00.000Z');
    expect(schedulerEventTypes()).toEqual(['scheduled', 'updated']);
  });

  it('refuses to drain while the old session outbound writer is still running', async () => {
    const session = freshSession();
    insertOutbound(session, 'out-schedule', 'system', scheduleAction());
    mocks.isSessionOutboundWriterRunning.mockResolvedValue(true);

    await expect(drain(session)).rejects.toThrow(/refusing scheduler drain while container is running/);

    expect(getScheduledTask('ag-1', 'task-1')).toBeUndefined();
    expect(deliveredRows(session)).toEqual([]);
    expect(drainedRows()).toEqual([]);
  });

  it('does not notify or wake the old session for update misses drained during reset', async () => {
    const session = freshSession();
    insertOutbound(session, 'out-update-miss', 'system', {
      action: 'update_task',
      taskId: 'task-1',
      prompt: 'miss',
    });

    await expect(drain(session)).resolves.toBe(1);

    expect(mocks.wakeContainer).not.toHaveBeenCalled();
    expect(inboundKinds(session)).toEqual([]);
    expect(deliveredRows(session)).toEqual(['out-update-miss']);
    expect(drainedRows()).toEqual([
      expect.objectContaining({ message_out_id: 'out-update-miss', action: 'update_task', status: 'applied' }),
    ]);
  });

  it('waits for in-flight delivery before reading old outbound rows', async () => {
    const session = freshSession();
    insertOutbound(session, 'out-chat', 'chat', { text: 'visible before reset' });

    const deliveryStarted = deferred();
    const deliveryRelease = deferred();
    let drainResolved = false;
    setDeliveryAdapter({
      async deliver() {
        deliveryStarted.resolve();
        await deliveryRelease.promise;
        return 'platform-chat';
      },
    });

    const delivery = deliverSessionMessages(session);
    await deliveryStarted.promise;
    const draining = drain(session).then((count) => {
      drainResolved = true;
      return count;
    });
    await Promise.resolve();

    expect(drainResolved).toBe(false);
    deliveryRelease.resolve();
    await delivery;
    await expect(draining).resolves.toBe(0);
  });
});
