import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { withRuntimeLock, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import {
  cancelScheduledTask,
  clearTaskProjection,
  completeScheduledTask,
  createOrReplaceScheduledTask,
  failScheduledTask,
  getScheduledTask,
  listLiveScheduledTasksForSession,
  markTaskProjected,
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTask,
  type CreateScheduledTaskInput,
} from './ledger.js';
import { logSchedulerEvent, parseSchedulerLogLine } from './log.js';

const LOCK_NAME = 'scheduler-mutator';

function now(): string {
  return new Date().toISOString();
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
    processAfter: '2026-06-05T12:00:00.000Z',
    recurrence: null,
    content: JSON.stringify({ prompt: 'check heartbeat', script: null }),
    sessionId: 'sess-old',
    sourceMessageId: 'out-schedule-1',
    ...overrides,
  };
}

function source(messageId: string) {
  return { sessionId: 'sess-old', messageId };
}

async function withSchedulerLock<T>(fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T> {
  return await withRuntimeLock(LOCK_NAME, 120_000, fn);
}

function eventTypes(agentGroupId = 'ag-1', seriesId = 'task-1'): string[] {
  return (
    getDb()
      .prepare(
        `SELECT event_type FROM scheduled_task_events
         WHERE agent_group_id = ? AND series_id = ?
         ORDER BY rowid`,
      )
      .all(agentGroupId, seriesId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function eventCount(agentGroupId = 'ag-1', seriesId = 'task-1'): number {
  return eventTypes(agentGroupId, seriesId).length;
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
  vi.restoreAllMocks();
  closeDb();
});

describe('scheduler ledger', () => {
  it('creates a live task and records exactly one event, while exact replay is a no-op', async () => {
    await withSchedulerLock((owner) => {
      expect(createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner)).toBe(1);
      expect(createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner)).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      series_id: 'task-1',
      agent_group_id: 'ag-1',
      status: 'pending',
      recurrence: '0 9 * * *',
      generation: 1,
      created_by_session_id: 'sess-old',
      updated_by_session_id: 'sess-old',
      content: JSON.stringify({ prompt: 'check heartbeat', script: null }),
      last_error: null,
    });
    expect(eventTypes()).toEqual(['scheduled']);
  });

  it('requires a valid runtime lock owner before writing', () => {
    const invalidOwner: RuntimeLockOwner = {
      name: LOCK_NAME,
      ownerId: 'missing-owner',
      ownerToken: 'missing-token',
    };

    expect(() => createOrReplaceScheduledTask(baseTask(), invalidOwner)).toThrow(/not held|owner token|expired/);
    expect(getScheduledTask('ag-1', 'task-1')).toBeUndefined();
    expect(eventCount()).toBe(0);
  });

  it('rejects valid lock owners from other runtime lock names', async () => {
    await withRuntimeLock('not-the-scheduler', 120_000, (owner) => {
      expect(() => createOrReplaceScheduledTask(baseTask(), owner)).toThrow(/scheduler-mutator/);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toBeUndefined();
    expect(eventCount()).toBe(0);
  });

  it('uses composite agent group and series identity for reads and mutators', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ agentGroupId: 'ag-1', seriesId: 'shared-series' }), owner);
      createOrReplaceScheduledTask(
        baseTask({
          agentGroupId: 'ag-2',
          seriesId: 'shared-series',
          messagingGroupId: 'mg-2',
          platformId: 'chan-2',
        }),
        owner,
      );

      expect(cancelScheduledTask('ag-1', 'shared-series', source('out-cancel-shared'), owner)).toBe(1);
    });

    expect(getScheduledTask('ag-1', 'shared-series')).toMatchObject({ status: 'cancelled' });
    expect(getScheduledTask('ag-2', 'shared-series')).toMatchObject({ status: 'pending' });
    expect(eventTypes('ag-1', 'shared-series')).toEqual(['scheduled', 'cancelled']);
    expect(eventTypes('ag-2', 'shared-series')).toEqual(['scheduled']);
  });

  it('treats terminal rows as tombstones and refuses schedule collisions in the same agent group', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner);
      cancelScheduledTask('ag-1', 'task-1', source('out-cancel-1'), owner);

      expect(() =>
        createOrReplaceScheduledTask(
          baseTask({
            processAfter: '2026-06-06T12:00:00.000Z',
            sourceMessageId: 'out-schedule-after-terminal',
          }),
          owner,
        ),
      ).toThrow(/terminal task ag-1\/task-1/);

      createOrReplaceScheduledTask(baseTask({ agentGroupId: 'ag-2', seriesId: 'task-1' }), owner);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'cancelled',
      recurrence: null,
      process_after: '2026-06-05T12:00:00.000Z',
    });
    expect(getScheduledTask('ag-2', 'task-1')).toMatchObject({ status: 'pending' });
    expect(eventTypes('ag-1', 'task-1')).toEqual(['scheduled', 'cancelled']);
  });

  it('updates only supplied fields, keeps stable identity, and does not duplicate unchanged updates', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(
        baseTask({
          threadId: null,
          content: JSON.stringify({ prompt: 'old', script: 'echo old', extra: 'keep' }),
        }),
        owner,
      );

      expect(
        updateScheduledTask(
          'ag-1',
          'task-1',
          { prompt: 'new', processAfter: '2026-06-06T12:00:00.000Z' },
          source('out-update-1'),
          owner,
        ),
      ).toBe(1);
      expect(
        updateScheduledTask(
          'ag-1',
          'task-1',
          { prompt: 'new', processAfter: '2026-06-06T12:00:00.000Z' },
          source('out-update-1'),
          owner,
        ),
      ).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      series_id: 'task-1',
      agent_group_id: 'ag-1',
      process_after: '2026-06-06T12:00:00.000Z',
      content: JSON.stringify({ prompt: 'new', script: 'echo old', extra: 'keep' }),
      generation: 2,
    });
    expect(eventTypes()).toEqual(['scheduled', 'updated']);
  });

  it('uses source message ids to prevent older command replay from clobbering newer state', async () => {
    await withSchedulerLock((owner) => {
      expect(createOrReplaceScheduledTask(baseTask({ sourceMessageId: 'out-schedule-a' }), owner)).toBe(1);
      expect(pauseScheduledTask('ag-1', 'task-1', source('out-pause-a'), owner)).toBe(1);

      expect(createOrReplaceScheduledTask(baseTask({ sourceMessageId: 'out-schedule-a' }), owner)).toBe(0);
      expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({ status: 'paused' });

      expect(resumeScheduledTask('ag-1', 'task-1', source('out-resume-a'), owner)).toBe(1);
      expect(
        updateScheduledTask(
          'ag-1',
          'task-1',
          { processAfter: '2026-06-06T12:00:00.000Z' },
          source('out-update-a'),
          owner,
        ),
      ).toBe(1);
      expect(
        updateScheduledTask(
          'ag-1',
          'task-1',
          { processAfter: '2026-06-07T12:00:00.000Z' },
          source('out-update-b'),
          owner,
        ),
      ).toBe(1);

      expect(
        updateScheduledTask(
          'ag-1',
          'task-1',
          { processAfter: '2026-06-06T12:00:00.000Z' },
          source('out-update-a'),
          owner,
        ),
      ).toBe(0);
      expect(pauseScheduledTask('ag-1', 'task-1', source('out-pause-a'), owner)).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      process_after: '2026-06-07T12:00:00.000Z',
    });
    expect(eventTypes()).toEqual(['scheduled', 'paused', 'resumed', 'updated', 'updated']);
  });

  it('remembers non-applicable command sources so replay cannot become applicable later', async () => {
    await withSchedulerLock((owner) => {
      expect(pauseScheduledTask('ag-1', 'task-late', source('out-pause-before-create'), owner)).toBe(0);
      expect(resumeScheduledTask('ag-1', 'task-late', source('out-resume-before-create'), owner)).toBe(0);
      expect(
        updateScheduledTask(
          'ag-1',
          'task-late',
          { processAfter: '2026-06-06T12:00:00.000Z' },
          source('out-update-before-create'),
          owner,
        ),
      ).toBe(0);
      expect(cancelScheduledTask('ag-1', 'task-late', source('out-cancel-before-create'), owner)).toBe(0);

      createOrReplaceScheduledTask(
        baseTask({ seriesId: 'task-late', sourceMessageId: 'out-schedule-after-ignored-commands' }),
        owner,
      );
      expect(pauseScheduledTask('ag-1', 'task-late', source('out-pause-before-create'), owner)).toBe(0);
      expect(
        updateScheduledTask(
          'ag-1',
          'task-late',
          { processAfter: '2026-06-06T12:00:00.000Z' },
          source('out-update-before-create'),
          owner,
        ),
      ).toBe(0);
      expect(cancelScheduledTask('ag-1', 'task-late', source('out-cancel-before-create'), owner)).toBe(0);

      expect(pauseScheduledTask('ag-1', 'task-late', source('out-pause-current'), owner)).toBe(1);
      expect(resumeScheduledTask('ag-1', 'task-late', source('out-resume-before-create'), owner)).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-late')).toMatchObject({
      status: 'paused',
      process_after: '2026-06-05T12:00:00.000Z',
    });
    expect(eventTypes('ag-1', 'task-late')).toEqual([
      'paused',
      'resumed',
      'updated',
      'cancelled',
      'scheduled',
      'paused',
    ]);
  });

  it('records one event for each successful pause, resume, projection, clear, and cancel mutation', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask(), owner);

      expect(pauseScheduledTask('ag-1', 'task-1', source('out-pause-1'), owner)).toBe(1);
      expect(pauseScheduledTask('ag-1', 'task-1', source('out-pause-1'), owner)).toBe(0);

      expect(resumeScheduledTask('ag-1', 'task-1', source('out-resume-1'), owner)).toBe(1);
      expect(resumeScheduledTask('ag-1', 'task-1', source('out-resume-1'), owner)).toBe(0);

      expect(markTaskProjected('ag-1', 'task-1', 'sess-fresh', 'task-task-1-g3', owner)).toBe(1);
      expect(markTaskProjected('ag-1', 'task-1', 'sess-fresh', 'task-task-1-g3', owner)).toBe(0);

      expect(
        clearTaskProjection('ag-1', 'task-1', { sessionId: 'sess-fresh', messageId: 'task-task-1-g3' }, owner),
      ).toBe(1);
      expect(
        clearTaskProjection('ag-1', 'task-1', { sessionId: 'sess-fresh', messageId: 'task-task-1-g3' }, owner),
      ).toBe(0);

      expect(cancelScheduledTask('ag-1', 'task-1', source('out-cancel-1'), owner)).toBe(1);
      expect(cancelScheduledTask('ag-1', 'task-1', source('out-cancel-1'), owner)).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'cancelled',
      recurrence: null,
      projected_session_id: null,
      projected_message_id: null,
      generation: 4,
    });
    expect(eventTypes()).toEqual(['scheduled', 'paused', 'resumed', 'projected', 'projection_cleared', 'cancelled']);
  });

  it('advances generation before same-session reprojection so stale clears and completions cannot consume it', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner);
      expect(markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner)).toBe(1);

      expect(updateScheduledTask('ag-1', 'task-1', { prompt: 'updated' }, source('out-update-projected'), owner)).toBe(
        1,
      );
      expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
        generation: 2,
        projected_session_id: null,
        projected_message_id: null,
      });

      expect(clearTaskProjection('ag-1', 'task-1', { sessionId: 'sess-old', messageId: 'task-task-1-g1' }, owner)).toBe(
        0,
      );
      expect(markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner)).toBe(0);
      expect(markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g2', owner)).toBe(1);

      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: '2026-06-06T16:00:00.000Z',
          },
          owner,
        ),
      ).toBe(0);
      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g2',
            nextRun: '2026-06-06T16:00:00.000Z',
          },
          owner,
        ),
      ).toBe(1);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      generation: 3,
      process_after: '2026-06-06T16:00:00.000Z',
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(eventTypes()).toEqual(['scheduled', 'projected', 'updated', 'projected', 'recurrence_scheduled']);
  });

  it('increments generation for completed recurring tasks and treats replay as a no-op', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner);
      markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner);

      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: '2026-06-06T16:00:00.000Z',
          },
          owner,
        ),
      ).toBe(1);
      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: '2026-06-06T16:00:00.000Z',
          },
          owner,
        ),
      ).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      process_after: '2026-06-06T16:00:00.000Z',
      generation: 2,
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(eventTypes()).toEqual(['scheduled', 'projected', 'recurrence_scheduled']);
  });

  it('does not complete recurring tasks when the next run has not been computed', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner);
      markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner);

      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: null,
          },
          owner,
        ),
      ).toBe(0);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      recurrence: '0 9 * * *',
      generation: 1,
      projected_session_id: 'sess-old',
      projected_message_id: 'task-task-1-g1',
    });
    expect(eventTypes()).toEqual(['scheduled', 'projected']);
  });

  it('completes one-time tasks as terminal tombstones', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: null }), owner);
      markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner);

      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: null,
          },
          owner,
        ),
      ).toBe(1);
      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: null,
          },
          owner,
        ),
      ).toBe(0);
      expect(() =>
        createOrReplaceScheduledTask(
          baseTask({
            processAfter: '2026-06-07T12:00:00.000Z',
            sourceMessageId: 'out-schedule-after-complete',
          }),
          owner,
        ),
      ).toThrow(/terminal task/);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'completed',
      recurrence: null,
      completed_at: expect.any(String),
    });
    expect(eventTypes()).toEqual(['scheduled', 'projected', 'completed']);
  });

  it('fails tasks as terminal tombstones with last_error', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner);
      markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner);

      expect(
        failScheduledTask(
          'ag-1',
          'task-1',
          { sessionId: 'sess-old', messageId: 'task-task-1-g1', error: 'tool timeout' },
          owner,
        ),
      ).toBe(1);
      expect(
        failScheduledTask(
          'ag-1',
          'task-1',
          { sessionId: 'sess-old', messageId: 'task-task-1-g1', error: 'tool timeout' },
          owner,
        ),
      ).toBe(0);
      expect(() =>
        createOrReplaceScheduledTask(
          baseTask({
            processAfter: '2026-06-07T12:00:00.000Z',
            sourceMessageId: 'out-schedule-after-fail',
          }),
          owner,
        ),
      ).toThrow(/terminal task/);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'failed',
      last_error: 'tool timeout',
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(eventTypes()).toEqual(['scheduled', 'projected', 'failed']);
  });

  it('ignores stale completion and failure from a superseded projection', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ recurrence: '0 9 * * *' }), owner);
      markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner);
      markTaskProjected('ag-1', 'task-1', 'sess-fresh', 'task-task-1-g1', owner);
      expect(markTaskProjected('ag-1', 'task-1', 'sess-old', 'task-task-1-g1', owner)).toBe(0);
      expect(clearTaskProjection('ag-1', 'task-1', { sessionId: 'sess-old', messageId: 'task-task-1-g1' }, owner)).toBe(
        0,
      );

      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-old',
            messageId: 'task-task-1-g1',
            nextRun: '2026-06-06T16:00:00.000Z',
          },
          owner,
        ),
      ).toBe(0);
      expect(
        failScheduledTask(
          'ag-1',
          'task-1',
          { sessionId: 'sess-old', messageId: 'task-task-1-g1', error: 'old failure' },
          owner,
        ),
      ).toBe(0);

      expect(
        completeScheduledTask(
          'ag-1',
          'task-1',
          {
            sessionId: 'sess-fresh',
            messageId: 'task-task-1-g1',
            nextRun: '2026-06-06T16:00:00.000Z',
          },
          owner,
        ),
      ).toBe(1);
    });

    expect(getScheduledTask('ag-1', 'task-1')).toMatchObject({
      status: 'pending',
      generation: 2,
      process_after: '2026-06-06T16:00:00.000Z',
      last_error: null,
      projected_session_id: null,
      projected_message_id: null,
    });
    expect(eventTypes()).toEqual(['scheduled', 'projected', 'projected', 'recurrence_scheduled']);
  });

  it('lists only live tasks for the composite route, with agent-shared scoped by agent group', async () => {
    await withSchedulerLock((owner) => {
      createOrReplaceScheduledTask(baseTask({ seriesId: 'task-a', processAfter: '2026-06-05T12:00:00.000Z' }), owner);
      createOrReplaceScheduledTask(
        baseTask({ seriesId: 'task-b', processAfter: '2026-06-05T13:00:00.000Z', threadId: null }),
        owner,
      );
      createOrReplaceScheduledTask(
        baseTask({ seriesId: 'task-c', processAfter: '2026-06-05T14:00:00.000Z', messagingGroupId: 'mg-2' }),
        owner,
      );
      createOrReplaceScheduledTask(
        baseTask({ agentGroupId: 'ag-2', seriesId: 'task-d', processAfter: '2026-06-05T15:00:00.000Z' }),
        owner,
      );
      cancelScheduledTask('ag-1', 'task-c', source('out-cancel-c'), owner);
    });

    expect(
      listLiveScheduledTasksForSession({
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        threadId: 'thread-1',
      }).map((row) => row.series_id),
    ).toEqual(['task-a']);
    expect(
      listLiveScheduledTasksForSession({
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        threadId: null,
      }).map((row) => row.series_id),
    ).toEqual(['task-b']);
    expect(
      listLiveScheduledTasksForSession({
        agentGroupId: 'ag-1',
        messagingGroupId: null,
        threadId: null,
        sessionMode: 'agent-shared',
      }).map((row) => row.series_id),
    ).toEqual(['task-a', 'task-b']);
  });
});

describe('scheduler JSONL log helper', () => {
  it('emits uncolored one-object-per-line JSONL with required fields', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logSchedulerEvent('warn', 'scheduler_ledger_collision', {
      agentGroupId: 'ag-1',
      seriesId: 'task-1',
      timestamp: 'cannot-override',
      severity: 'info',
      event: 'cannot_override',
    });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toMatch(/^\{.*\}\n$/);
    expect(line).not.toContain('\u001b[');

    const parsed = parseSchedulerLogLine(line);
    expect(parsed).toMatchObject({
      severity: 'warn',
      event: 'scheduler_ledger_collision',
      agentGroupId: 'ag-1',
      seriesId: 'task-1',
    });
    expect(Date.parse(parsed.timestamp)).not.toBeNaN();
  });

  it('rejects non-JSON bytes and entries missing severity, timestamp, or event', () => {
    expect(() =>
      parseSchedulerLogLine('\u001b[31m{"timestamp":"2026-06-05T12:00:00.000Z","severity":"info","event":"x"}\n'),
    ).toThrow(/not valid JSON/);
    expect(() => parseSchedulerLogLine('{"severity":"info","event":"x"}\n')).toThrow(/timestamp/);
    expect(() => parseSchedulerLogLine('{"timestamp":"2026-06-05T12:00:00.000Z","event":"x"}\n')).toThrow(/severity/);
    expect(() => parseSchedulerLogLine('{"timestamp":"2026-06-05T12:00:00.000Z","severity":"info"}\n')).toThrow(
      /event/,
    );
  });
});
