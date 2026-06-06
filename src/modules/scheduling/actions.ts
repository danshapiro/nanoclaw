/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to the central scheduler ledger, then project it into inbound.db.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { assertRuntimeLockOwner, withRuntimeLock, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  cancelScheduledTask,
  createOrReplaceScheduledTask,
  getScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTask,
  type ScheduledTaskRow,
  type ScheduledTaskUpdate,
} from './ledger.js';
import { logSchedulerEvent } from './log.js';
import { projectScheduledTask, retireProjection } from './projection.js';

const LOCK_NAME = 'scheduler-mutator';
const LOCK_TTL_MS = 120_000;
const LIVE_STATUSES = ['pending', 'paused'] as const;

export interface ApplySchedulingActionOptions {
  source: 'delivery' | 'drain';
  sourceMessageId: string;
}

function stringField(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Scheduling action missing required string field "${key}"`);
  }
  return value;
}

function nullableStringField(content: Record<string, unknown>, key: string): string | null {
  const value = content[key];
  return typeof value === 'string' ? value : null;
}

function nullableRecurrence(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableScript(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isGroupField(value: unknown): 0 | 1 | null {
  return value === 0 || value === 1 ? value : null;
}

function isLiveTask(task: ScheduledTaskRow | undefined): task is ScheduledTaskRow {
  return task !== undefined && LIVE_STATUSES.includes(task.status as (typeof LIVE_STATUSES)[number]);
}

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
    }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after scheduling notification', { err }));
  }
}

function recordSchedulerActionIncident(args: {
  owner: RuntimeLockOwner;
  severity: 'warn' | 'error';
  dedupeKey: string;
  message: string;
  details: Record<string, unknown>;
  session: Session;
  seriesId: string;
}): void {
  const now = new Date().toISOString();
  getDb()
    .transaction(() => {
      assertRuntimeLockOwner(args.owner);
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO scheduler_incidents (
             id,
             dedupe_key,
             severity,
             status,
             agent_group_id,
             series_id,
             session_id,
             messaging_group_id,
             channel_type,
             platform_id,
             thread_id,
             message,
             details_json,
             created_at,
             next_attempt_at,
             attempt_count,
             last_attempt_at,
             last_error,
             reported_at
           ) VALUES (
             @id,
             @dedupeKey,
             @severity,
             'pending',
             @agentGroupId,
             @seriesId,
             @sessionId,
             @messagingGroupId,
             @channelType,
             @platformId,
             @threadId,
             @message,
             @detailsJson,
             @createdAt,
             NULL,
             0,
             NULL,
             NULL,
             NULL
           )`,
        )
        .run({
          id: `sched-inc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          dedupeKey: args.dedupeKey,
          severity: args.severity,
          agentGroupId: args.session.agent_group_id,
          seriesId: args.seriesId,
          sessionId: args.session.id,
          messagingGroupId: args.session.messaging_group_id,
          channelType: null,
          platformId: null,
          threadId: args.session.thread_id,
          message: args.message,
          detailsJson: JSON.stringify(args.details),
          createdAt: now,
        });
    })();
  logSchedulerEvent(args.severity, 'scheduler_action_incident', {
    dedupeKey: args.dedupeKey,
    agentGroupId: args.session.agent_group_id,
    sessionId: args.session.id,
    seriesId: args.seriesId,
    message: args.message,
    ...args.details,
  });
}

function sourceFor(session: Session, sourceMessageId: string) {
  return { sessionId: session.id, messageId: sourceMessageId };
}

export function applyScheduleTaskAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  options: ApplySchedulingActionOptions,
): number {
  const taskId = stringField(content, 'taskId');
  const prompt = stringField(content, 'prompt');
  const processAfter = stringField(content, 'processAfter');
  const script = nullableScript(content.script);
  const existing = getScheduledTask(session.agent_group_id, taskId);

  if (existing && !isLiveTask(existing)) {
    const dedupeKey = `scheduler-action:${options.source}:${session.id}:${options.sourceMessageId}:schedule_task:${taskId}:terminal-collision`;
    const message = `schedule_task refused to resurrect terminal task "${taskId}".`;
    recordSchedulerActionIncident({
      owner,
      severity: 'error',
      dedupeKey,
      message,
      details: { action: 'schedule_task', source: options.source, sourceMessageId: options.sourceMessageId },
      session,
      seriesId: taskId,
    });
    if (options.source === 'delivery') notifyAgent(session, message);
    return 0;
  }

  const changed = createOrReplaceScheduledTask(
    {
      seriesId: taskId,
      agentGroupId: session.agent_group_id,
      messagingGroupId: nullableStringField(content, 'messagingGroupId'),
      threadId: nullableStringField(content, 'threadId'),
      platformId: nullableStringField(content, 'platformId'),
      channelType: nullableStringField(content, 'channelType'),
      isGroup: isGroupField(content.isGroup),
      processAfter,
      recurrence: nullableRecurrence(content.recurrence),
      content: JSON.stringify({ prompt, script }),
      sessionId: session.id,
      sourceMessageId: options.sourceMessageId,
    },
    owner,
  );

  const task = getScheduledTask(session.agent_group_id, taskId);
  if (isLiveTask(task)) projectScheduledTask(inDb, task, session.id, owner);
  log.info('Scheduled task ledger action applied', {
    action: 'schedule_task',
    taskId,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    source: options.source,
    sourceMessageId: options.sourceMessageId,
    changed,
  });
  return changed;
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  sourceMessageId: string,
): Promise<void> {
  await withRuntimeLock(LOCK_NAME, LOCK_TTL_MS, async (owner) => {
    applyScheduleTaskAction(content, session, inDb, owner, { source: 'delivery', sourceMessageId });
  });
}

export function applyCancelTaskAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  options: ApplySchedulingActionOptions,
): number {
  const taskId = stringField(content, 'taskId');
  const changed = cancelScheduledTask(session.agent_group_id, taskId, sourceFor(session, options.sourceMessageId), owner);
  retireProjection(inDb, taskId);
  log.info('Scheduled task ledger action applied', {
    action: 'cancel_task',
    taskId,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    source: options.source,
    sourceMessageId: options.sourceMessageId,
    changed,
  });
  return changed;
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  sourceMessageId: string,
): Promise<void> {
  await withRuntimeLock(LOCK_NAME, LOCK_TTL_MS, async (owner) => {
    applyCancelTaskAction(content, session, inDb, owner, { source: 'delivery', sourceMessageId });
  });
}

export function applyPauseTaskAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  options: ApplySchedulingActionOptions,
): number {
  const taskId = stringField(content, 'taskId');
  const changed = pauseScheduledTask(session.agent_group_id, taskId, sourceFor(session, options.sourceMessageId), owner);
  const task = getScheduledTask(session.agent_group_id, taskId);
  if (isLiveTask(task)) projectScheduledTask(inDb, task, session.id, owner);
  log.info('Scheduled task ledger action applied', {
    action: 'pause_task',
    taskId,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    source: options.source,
    sourceMessageId: options.sourceMessageId,
    changed,
  });
  return changed;
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  sourceMessageId: string,
): Promise<void> {
  await withRuntimeLock(LOCK_NAME, LOCK_TTL_MS, async (owner) => {
    applyPauseTaskAction(content, session, inDb, owner, { source: 'delivery', sourceMessageId });
  });
}

export function applyResumeTaskAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  options: ApplySchedulingActionOptions,
): number {
  const taskId = stringField(content, 'taskId');
  const changed = resumeScheduledTask(session.agent_group_id, taskId, sourceFor(session, options.sourceMessageId), owner);
  const task = getScheduledTask(session.agent_group_id, taskId);
  if (isLiveTask(task)) projectScheduledTask(inDb, task, session.id, owner);
  log.info('Scheduled task ledger action applied', {
    action: 'resume_task',
    taskId,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    source: options.source,
    sourceMessageId: options.sourceMessageId,
    changed,
  });
  return changed;
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  sourceMessageId: string,
): Promise<void> {
  await withRuntimeLock(LOCK_NAME, LOCK_TTL_MS, async (owner) => {
    applyResumeTaskAction(content, session, inDb, owner, { source: 'delivery', sourceMessageId });
  });
}

export function applyUpdateTaskAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  options: ApplySchedulingActionOptions,
): { matchedLiveBefore: boolean; changed: number } {
  const taskId = stringField(content, 'taskId');
  const before = getScheduledTask(session.agent_group_id, taskId);
  const matchedLiveBefore = isLiveTask(before);
  const update: ScheduledTaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }

  const changed = updateScheduledTask(
    session.agent_group_id,
    taskId,
    update,
    sourceFor(session, options.sourceMessageId),
    owner,
  );
  const task = getScheduledTask(session.agent_group_id, taskId);
  if (isLiveTask(task)) projectScheduledTask(inDb, task, session.id, owner);
  log.info('Scheduled task ledger action applied', {
    action: 'update_task',
    taskId,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    source: options.source,
    sourceMessageId: options.sourceMessageId,
    changed,
    fields: Object.keys(update),
  });
  return { matchedLiveBefore, changed };
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  sourceMessageId: string,
): Promise<void> {
  let matchedLiveBefore = false;
  await withRuntimeLock(LOCK_NAME, LOCK_TTL_MS, async (owner) => {
    ({ matchedLiveBefore } = applyUpdateTaskAction(content, session, inDb, owner, {
      source: 'delivery',
      sourceMessageId,
    }));
  });
  if (!matchedLiveBefore) {
    const taskId = stringField(content, 'taskId');
    notifyAgent(session, `update_task: no live task matched id "${taskId}".`);
  }
}
