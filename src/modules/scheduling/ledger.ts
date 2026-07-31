import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { assertRuntimeLockOwner, type RuntimeLockOwner } from '../../db/runtime-locks.js';

export type ScheduledTaskStatus = 'pending' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface ScheduledTaskRow {
  series_id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  platform_id: string | null;
  channel_type: string | null;
  is_group: 0 | 1 | null;
  status: ScheduledTaskStatus;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  generation: number;
  projected_session_id: string | null;
  projected_message_id: string | null;
  created_by_session_id: string | null;
  updated_by_session_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

export interface CreateScheduledTaskInput {
  seriesId: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  platformId: string | null;
  channelType: string | null;
  isGroup: 0 | 1 | null;
  processAfter: string;
  recurrence: string | null;
  content: string;
  sessionId: string;
  sourceMessageId: string;
}

export interface ImportLegacyScheduledTaskInput extends Omit<CreateScheduledTaskInput, 'sourceMessageId'> {
  messageId: string;
  status: 'pending' | 'paused';
  legacyStatus?: 'pending' | 'paused' | 'completed';
  projectedSessionId?: string | null;
  projectedMessageId?: string | null;
}

export interface TombstoneLegacyArchivedTaskInput {
  seriesId: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  platformId: string | null;
  channelType: string | null;
  isGroup: 0 | 1 | null;
  processAfter: string | null;
  recurrence: string | null;
  content: string;
  sessionId: string;
  messageId: string;
}

export interface ScheduledTaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

export interface SchedulerMutationSource {
  sessionId: string;
  messageId: string;
}

const LIVE_STATUSES: ScheduledTaskStatus[] = ['pending', 'paused'];
const TERMINAL_STATUSES: ScheduledTaskStatus[] = ['completed', 'cancelled', 'failed'];
const SCHEDULER_MUTATOR_LOCK_NAME = 'scheduler-mutator';

function nowIso(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `sched-evt-${randomUUID()}`;
}

function withSchedulerWrite<T>(owner: RuntimeLockOwner, fn: (db: Database.Database) => T): T {
  const db = getDb();
  return db.transaction(() => {
    if (owner.name !== SCHEDULER_MUTATOR_LOCK_NAME) {
      throw new Error(`Scheduler ledger writes require runtime lock "${SCHEDULER_MUTATOR_LOCK_NAME}"`);
    }
    assertRuntimeLockOwner(owner);
    return fn(db);
  })();
}

function isTerminal(status: ScheduledTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function getScheduledTaskInDb(
  db: Database.Database,
  agentGroupId: string,
  seriesId: string,
): ScheduledTaskRow | undefined {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE agent_group_id = ? AND series_id = ?')
    .get(agentGroupId, seriesId) as ScheduledTaskRow | undefined;
}

function taskMatchesCreateInput(row: ScheduledTaskRow, input: CreateScheduledTaskInput): boolean {
  return (
    row.status === 'pending' &&
    row.messaging_group_id === input.messagingGroupId &&
    row.thread_id === input.threadId &&
    row.platform_id === input.platformId &&
    row.channel_type === input.channelType &&
    row.is_group === input.isGroup &&
    row.process_after === input.processAfter &&
    row.recurrence === input.recurrence &&
    row.content === input.content
  );
}

function recordEvent(
  db: Database.Database,
  agentGroupId: string,
  seriesId: string,
  eventType: string,
  sessionId: string | null,
  messageId: string | null,
  details: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO scheduled_task_events
       (id, agent_group_id, series_id, event_type, session_id, message_id, created_at, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId(), agentGroupId, seriesId, eventType, sessionId, messageId, nowIso(), JSON.stringify(details));
}

function eventExists(
  db: Database.Database,
  agentGroupId: string,
  seriesId: string,
  eventType: string,
  sessionId: string | null,
  messageId: string | null,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM scheduled_task_events
       WHERE agent_group_id = ?
         AND series_id = ?
         AND event_type = ?
         AND (session_id IS ?)
         AND (message_id IS ?)
       LIMIT 1`,
    )
    .get(agentGroupId, seriesId, eventType, sessionId, messageId) as { '1': number } | undefined;
  return row !== undefined;
}

function recordIgnoredCommandEvent(
  db: Database.Database,
  agentGroupId: string,
  seriesId: string,
  eventType: string,
  source: SchedulerMutationSource,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  recordEvent(db, agentGroupId, seriesId, eventType, source.sessionId, source.messageId, {
    ...details,
    ignored: true,
    reason,
  });
}

export function getScheduledTask(agentGroupId: string, seriesId: string): ScheduledTaskRow | undefined {
  return getScheduledTaskInDb(getDb(), agentGroupId, seriesId);
}

export function listLiveScheduledTasksForSession(args: {
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  sessionMode?: 'shared' | 'per-thread' | 'agent-shared';
}): ScheduledTaskRow[] {
  if (args.sessionMode === 'agent-shared') {
    return getDb()
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE agent_group_id = @agentGroupId
           AND status IN ('pending', 'paused')
         ORDER BY process_after ASC, series_id ASC`,
      )
      .all(args) as ScheduledTaskRow[];
  }

  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE agent_group_id = @agentGroupId
         AND status IN ('pending', 'paused')
         AND (messaging_group_id IS @messagingGroupId)
         AND (thread_id IS @threadId)
       ORDER BY process_after ASC, series_id ASC`,
    )
    .all(args) as ScheduledTaskRow[];
}

/**
 * Conservative group-level gate for the host sweep's read-before-lock
 * early exit: ANY live task in the agent group means every session of the
 * group runs the full lock + sync path. Reads cost no WAL frames.
 */
export function hasLiveScheduledTasksForAgentGroup(agentGroupId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM scheduled_tasks WHERE agent_group_id = ? AND status IN ('pending', 'paused')) AS present",
    )
    .get(agentGroupId) as { present: number };
  return row.present === 1;
}

export function createOrReplaceScheduledTask(input: CreateScheduledTaskInput, owner: RuntimeLockOwner): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, input.agentGroupId, input.seriesId, 'scheduled', input.sessionId, input.sourceMessageId)) {
      return 0;
    }

    const existing = getScheduledTaskInDb(db, input.agentGroupId, input.seriesId);
    if (existing && isTerminal(existing.status)) {
      throw new Error(
        `Scheduled task id collision with terminal task ${input.agentGroupId}/${input.seriesId}; refusing to resurrect tombstone`,
      );
    }

    if (existing && taskMatchesCreateInput(existing, input)) {
      recordEvent(db, input.agentGroupId, input.seriesId, 'scheduled', input.sessionId, input.sourceMessageId, {
        processAfter: input.processAfter,
        recurrence: input.recurrence,
        idempotent: true,
      });
      return 0;
    }

    const ts = nowIso();
    if (!existing) {
      const result = db
        .prepare(
          `INSERT INTO scheduled_tasks (
             series_id,
             agent_group_id,
             messaging_group_id,
             thread_id,
             platform_id,
             channel_type,
             is_group,
             status,
             process_after,
             recurrence,
             content,
             generation,
             projected_session_id,
             projected_message_id,
             created_by_session_id,
             updated_by_session_id,
             created_at,
             updated_at,
             completed_at,
             last_error
           ) VALUES (
             @seriesId,
             @agentGroupId,
             @messagingGroupId,
             @threadId,
             @platformId,
             @channelType,
             @isGroup,
             'pending',
             @processAfter,
             @recurrence,
             @content,
             1,
             NULL,
             NULL,
             @sessionId,
             @sessionId,
             @ts,
             @ts,
             NULL,
             NULL
           )`,
        )
        .run({ ...input, ts });
      if (result.changes !== 1) return 0;
    } else {
      const result = db
        .prepare(
          `UPDATE scheduled_tasks
           SET messaging_group_id = @messagingGroupId,
               thread_id = @threadId,
               platform_id = @platformId,
               channel_type = @channelType,
               is_group = @isGroup,
               status = 'pending',
               process_after = @processAfter,
               recurrence = @recurrence,
               content = @content,
               generation = generation + 1,
               projected_session_id = NULL,
               projected_message_id = NULL,
               updated_by_session_id = @sessionId,
               updated_at = @ts,
               completed_at = NULL,
               last_error = NULL
           WHERE agent_group_id = @agentGroupId
             AND series_id = @seriesId
             AND status IN ('pending', 'paused')`,
        )
        .run({ ...input, ts });
      if (result.changes !== 1) return 0;
    }

    recordEvent(db, input.agentGroupId, input.seriesId, 'scheduled', input.sessionId, input.sourceMessageId, {
      processAfter: input.processAfter,
      recurrence: input.recurrence,
    });
    return 1;
  });
}

export function importLegacyScheduledTask(input: ImportLegacyScheduledTaskInput, owner: RuntimeLockOwner): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, input.agentGroupId, input.seriesId, 'legacy_imported', input.sessionId, input.messageId)) {
      return 0;
    }

    const existing = getScheduledTaskInDb(db, input.agentGroupId, input.seriesId);
    if (existing) return 0;

    const ts = nowIso();
    const result = db
      .prepare(
        `INSERT INTO scheduled_tasks (
           series_id,
           agent_group_id,
           messaging_group_id,
           thread_id,
           platform_id,
           channel_type,
           is_group,
           status,
           process_after,
           recurrence,
           content,
           generation,
           projected_session_id,
           projected_message_id,
           created_by_session_id,
           updated_by_session_id,
           created_at,
           updated_at,
           completed_at,
           last_error
         ) VALUES (
           @seriesId,
           @agentGroupId,
           @messagingGroupId,
           @threadId,
           @platformId,
           @channelType,
           @isGroup,
           @status,
           @processAfter,
           @recurrence,
           @content,
           1,
           @projectedSessionId,
           @projectedMessageId,
           @sessionId,
           @sessionId,
           @ts,
           @ts,
           NULL,
           NULL
         )`,
      )
      .run({
        ...input,
        projectedSessionId: input.projectedSessionId === undefined ? input.sessionId : input.projectedSessionId,
        projectedMessageId: input.projectedMessageId === undefined ? input.messageId : input.projectedMessageId,
        ts,
      });
    if (result.changes !== 1) return 0;

    recordEvent(db, input.agentGroupId, input.seriesId, 'legacy_imported', input.sessionId, input.messageId, {
      processAfter: input.processAfter,
      recurrence: input.recurrence,
      status: input.legacyStatus ?? input.status,
    });
    return 1;
  });
}

const LEGACY_ARCHIVED_TOMBSTONE_NOTE =
  'Auto-tombstoned by scheduler repair: session is archived and cancellation intent cannot be proven, so the task was not auto-run.';

export function tombstoneLegacyArchivedTask(input: TombstoneLegacyArchivedTaskInput, owner: RuntimeLockOwner): number {
  return withSchedulerWrite(owner, (db) => {
    if (
      eventExists(
        db,
        input.agentGroupId,
        input.seriesId,
        'legacy_archived_tombstoned',
        input.sessionId,
        input.messageId,
      )
    ) {
      return 0;
    }

    const existing = getScheduledTaskInDb(db, input.agentGroupId, input.seriesId);
    if (existing) return 0;

    const ts = nowIso();
    const result = db
      .prepare(
        `INSERT INTO scheduled_tasks (
           series_id,
           agent_group_id,
           messaging_group_id,
           thread_id,
           platform_id,
           channel_type,
           is_group,
           status,
           process_after,
           recurrence,
           content,
           generation,
           projected_session_id,
           projected_message_id,
           created_by_session_id,
           updated_by_session_id,
           created_at,
           updated_at,
           completed_at,
           last_error
         ) VALUES (
           @seriesId,
           @agentGroupId,
           @messagingGroupId,
           @threadId,
           @platformId,
           @channelType,
           @isGroup,
           'cancelled',
           @processAfter,
           NULL,
           @content,
           1,
           NULL,
           NULL,
           @sessionId,
           @sessionId,
           @ts,
           @ts,
           NULL,
           @note
         )`,
      )
      .run({ ...input, ts, note: LEGACY_ARCHIVED_TOMBSTONE_NOTE });
    if (result.changes !== 1) return 0;

    recordEvent(
      db,
      input.agentGroupId,
      input.seriesId,
      'legacy_archived_tombstoned',
      input.sessionId,
      input.messageId,
      {
        note: LEGACY_ARCHIVED_TOMBSTONE_NOTE,
        processAfter: input.processAfter,
        recurrence: input.recurrence,
      },
    );
    return 1;
  });
}

export function pauseScheduledTask(
  agentGroupId: string,
  seriesId: string,
  source: SchedulerMutationSource,
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, agentGroupId, seriesId, 'paused', source.sessionId, source.messageId)) return 0;
    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'paused', source, 'missing-task');
      return 0;
    }
    if (isTerminal(row.status)) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'paused', source, 'terminal-task', { status: row.status });
      return 0;
    }
    if (row.status === 'paused') {
      recordEvent(db, agentGroupId, seriesId, 'paused', source.sessionId, source.messageId, { idempotent: true });
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'paused',
             updated_by_session_id = ?,
             updated_at = ?,
             generation = generation + 1,
             projected_session_id = NULL,
             projected_message_id = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status = 'pending'`,
      )
      .run(source.sessionId, nowIso(), agentGroupId, seriesId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'paused', source.sessionId, source.messageId, {});
    return 1;
  });
}

export function resumeScheduledTask(
  agentGroupId: string,
  seriesId: string,
  source: SchedulerMutationSource,
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, agentGroupId, seriesId, 'resumed', source.sessionId, source.messageId)) return 0;
    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'resumed', source, 'missing-task');
      return 0;
    }
    if (isTerminal(row.status)) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'resumed', source, 'terminal-task', { status: row.status });
      return 0;
    }
    if (row.status === 'pending') {
      recordEvent(db, agentGroupId, seriesId, 'resumed', source.sessionId, source.messageId, { idempotent: true });
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'pending',
             updated_by_session_id = ?,
             updated_at = ?,
             generation = generation + 1,
             projected_session_id = NULL,
             projected_message_id = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status = 'paused'`,
      )
      .run(source.sessionId, nowIso(), agentGroupId, seriesId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'resumed', source.sessionId, source.messageId, {});
    return 1;
  });
}

export function updateScheduledTask(
  agentGroupId: string,
  seriesId: string,
  update: ScheduledTaskUpdate,
  source: SchedulerMutationSource,
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, agentGroupId, seriesId, 'updated', source.sessionId, source.messageId)) return 0;

    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'updated', source, 'missing-task', { ...update });
      return 0;
    }
    if (!LIVE_STATUSES.includes(row.status)) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'updated', source, 'terminal-task', {
        ...update,
        status: row.status,
      });
      return 0;
    }

    const updatesRequested =
      update.prompt !== undefined ||
      update.script !== undefined ||
      update.processAfter !== undefined ||
      update.recurrence !== undefined;
    if (!updatesRequested) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'updated', source, 'empty-update');
      return 0;
    }

    let content = row.content;
    if (update.prompt !== undefined || update.script !== undefined) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.content) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Scheduled task ${agentGroupId}/${seriesId} content is not valid JSON`, { cause: err });
      }
      if (update.prompt !== undefined) parsed.prompt = update.prompt;
      if (update.script !== undefined) parsed.script = update.script;
      content = JSON.stringify(parsed);
    }

    const processAfter = update.processAfter ?? row.process_after;
    const recurrence = update.recurrence !== undefined ? update.recurrence : row.recurrence;
    if (content === row.content && processAfter === row.process_after && recurrence === row.recurrence) {
      recordEvent(db, agentGroupId, seriesId, 'updated', source.sessionId, source.messageId, {
        ...update,
        idempotent: true,
      });
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET process_after = ?,
             recurrence = ?,
             content = ?,
             updated_by_session_id = ?,
             updated_at = ?,
             generation = generation + 1,
             projected_session_id = NULL,
             projected_message_id = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status IN ('pending', 'paused')`,
      )
      .run(processAfter, recurrence, content, source.sessionId, nowIso(), agentGroupId, seriesId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'updated', source.sessionId, source.messageId, { ...update });
    return 1;
  });
}

export function cancelScheduledTask(
  agentGroupId: string,
  seriesId: string,
  source: SchedulerMutationSource,
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, agentGroupId, seriesId, 'cancelled', source.sessionId, source.messageId)) return 0;
    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'cancelled', source, 'missing-task');
      return 0;
    }
    if (isTerminal(row.status)) {
      recordIgnoredCommandEvent(db, agentGroupId, seriesId, 'cancelled', source, 'terminal-task', {
        status: row.status,
      });
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'cancelled',
             recurrence = NULL,
             updated_by_session_id = ?,
             updated_at = ?,
             projected_session_id = NULL,
             projected_message_id = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status IN ('pending', 'paused')`,
      )
      .run(source.sessionId, nowIso(), agentGroupId, seriesId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'cancelled', source.sessionId, source.messageId, {});
    return 1;
  });
}

export function completeScheduledTask(
  agentGroupId: string,
  seriesId: string,
  args: { sessionId: string; messageId: string; nextRun: string | null },
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, agentGroupId, seriesId, 'completed', args.sessionId, args.messageId)) return 0;
    if (eventExists(db, agentGroupId, seriesId, 'recurrence_scheduled', args.sessionId, args.messageId)) return 0;

    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row || row.status !== 'pending') return 0;
    if (row.projected_session_id !== args.sessionId || row.projected_message_id !== args.messageId) return 0;

    const ts = nowIso();
    if (row.recurrence) {
      if (!args.nextRun) return 0;
      const result = db
        .prepare(
          `UPDATE scheduled_tasks
           SET process_after = ?,
               status = 'pending',
               generation = generation + 1,
               projected_session_id = NULL,
               projected_message_id = NULL,
               updated_by_session_id = ?,
             updated_at = ?,
             completed_at = NULL,
             last_error = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status = 'pending'
           AND projected_session_id IS ?
           AND projected_message_id IS ?`,
        )
        .run(args.nextRun, args.sessionId, ts, agentGroupId, seriesId, args.sessionId, args.messageId);
      if (result.changes !== 1) return 0;

      recordEvent(db, agentGroupId, seriesId, 'recurrence_scheduled', args.sessionId, args.messageId, {
        nextRun: args.nextRun,
      });
      return 1;
    }

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'completed',
             recurrence = NULL,
             completed_at = ?,
             updated_by_session_id = ?,
             updated_at = ?,
             projected_session_id = NULL,
             projected_message_id = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status = 'pending'
           AND projected_session_id IS ?
           AND projected_message_id IS ?`,
      )
      .run(ts, args.sessionId, ts, agentGroupId, seriesId, args.sessionId, args.messageId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'completed', args.sessionId, args.messageId, {});
    return 1;
  });
}

export function failScheduledTask(
  agentGroupId: string,
  seriesId: string,
  args: { sessionId: string; messageId: string; error: string },
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    if (eventExists(db, agentGroupId, seriesId, 'failed', args.sessionId, args.messageId)) return 0;
    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row || row.status !== 'pending') return 0;
    if (row.projected_session_id !== args.sessionId || row.projected_message_id !== args.messageId) return 0;

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'failed',
             last_error = ?,
             updated_by_session_id = ?,
             updated_at = ?,
             projected_session_id = NULL,
             projected_message_id = NULL
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status = 'pending'
           AND projected_session_id IS ?
           AND projected_message_id IS ?`,
      )
      .run(args.error, args.sessionId, nowIso(), agentGroupId, seriesId, args.sessionId, args.messageId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'failed', args.sessionId, args.messageId, { error: args.error });
    return 1;
  });
}

export function markTaskProjected(
  agentGroupId: string,
  seriesId: string,
  sessionId: string,
  messageId: string,
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row) {
      if (eventExists(db, agentGroupId, seriesId, 'projected', sessionId, messageId)) return 0;
      recordEvent(db, agentGroupId, seriesId, 'projected', sessionId, messageId, {
        ignored: true,
        reason: 'missing-task',
      });
      return 0;
    }
    if (!LIVE_STATUSES.includes(row.status)) {
      if (eventExists(db, agentGroupId, seriesId, 'projected', sessionId, messageId)) return 0;
      recordEvent(db, agentGroupId, seriesId, 'projected', sessionId, messageId, {
        ignored: true,
        reason: 'terminal-task',
        status: row.status,
      });
      return 0;
    }
    if (row.projected_session_id === sessionId && row.projected_message_id === messageId) {
      if (!eventExists(db, agentGroupId, seriesId, 'projected', sessionId, messageId)) {
        recordEvent(db, agentGroupId, seriesId, 'projected', sessionId, messageId, { idempotent: true });
      }
      return 0;
    }
    if (eventExists(db, agentGroupId, seriesId, 'projected', sessionId, messageId)) return 0;

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET projected_session_id = ?,
             projected_message_id = ?,
             updated_at = ?
         WHERE agent_group_id = ?
           AND series_id = ?
           AND status IN ('pending', 'paused')
           AND NOT (projected_session_id IS ? AND projected_message_id IS ?)`,
      )
      .run(sessionId, messageId, nowIso(), agentGroupId, seriesId, sessionId, messageId);
    if (result.changes !== 1) return 0;

    recordEvent(db, agentGroupId, seriesId, 'projected', sessionId, messageId, {});
    return 1;
  });
}

export function clearTaskProjection(
  agentGroupId: string,
  seriesId: string,
  expected: { sessionId: string; messageId: string },
  owner: RuntimeLockOwner,
): number {
  return withSchedulerWrite(owner, (db) => {
    const row = getScheduledTaskInDb(db, agentGroupId, seriesId);
    if (!row || (row.projected_session_id === null && row.projected_message_id === null)) return 0;
    if (row.projected_session_id !== expected.sessionId || row.projected_message_id !== expected.messageId) return 0;

    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET projected_session_id = NULL,
             projected_message_id = NULL,
             generation = generation + 1,
             updated_at = ?
         WHERE agent_group_id = ?
           AND series_id = ?
           AND projected_session_id IS ?
           AND projected_message_id IS ?`,
      )
      .run(nowIso(), agentGroupId, seriesId, expected.sessionId, expected.messageId);
    if (result.changes !== 1) return 0;

    recordEvent(
      db,
      agentGroupId,
      seriesId,
      'projection_cleared',
      row.projected_session_id,
      row.projected_message_id,
      {},
    );
    return 1;
  });
}
