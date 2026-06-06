import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getDb } from '../../db/connection.js';
import { assertRuntimeLockOwner, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { recordSchedulerIncidentWithOwner } from '../../yente/scheduler-alerts.js';
import {
  clearCompletedProjectionRecurrence,
  projectScheduledTask,
  retireProjection,
} from './projection.js';
import { nextScheduledRun } from './recurrence.js';
import {
  clearTaskProjection,
  completeScheduledTask,
  failScheduledTask,
  getScheduledTask,
  listLiveScheduledTasksForSession,
  type ScheduledTaskRow,
} from './ledger.js';

const LOCK_NAME = 'scheduler-mutator';

export type ProjectionSessionMode = 'shared' | 'per-thread' | 'agent-shared';

export interface ProjectionContext {
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  sessionMode: ProjectionSessionMode;
}

export interface SchedulerAckRow {
  message_id: string;
  status: 'processing' | 'completed' | 'failed' | 'recovery' | string;
  notice_message_out_id: string | null;
}

interface ProjectionRow {
  id: string;
  series_id: string;
  status: string;
  recurrence: string | null;
}

interface IncidentInput {
  owner: RuntimeLockOwner;
  dedupeKey: string;
  severity: 'info' | 'warn' | 'error';
  session: Session;
  seriesId: string | null;
  message: string;
  details: Record<string, unknown>;
}

function assertSchedulerOwner(owner: RuntimeLockOwner): void {
  if (owner.name !== LOCK_NAME) {
    throw new Error(`Scheduler sync writes require runtime lock "${LOCK_NAME}"`);
  }
  assertRuntimeLockOwner(owner);
}

function recordSchedulerIncident(input: IncidentInput): void {
  recordSchedulerIncidentWithOwner(
    {
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      agentGroupId: input.session.agent_group_id,
      seriesId: input.seriesId,
      sessionId: input.session.id,
      messagingGroupId: input.session.messaging_group_id,
      threadId: input.session.thread_id,
      message: input.message,
      details: input.details,
    },
    input.owner,
  );
}

export function getProcessingAcksForProjectedTasks(
  outDb: Database.Database,
  messageIds: string[],
): Map<string, SchedulerAckRow> {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => '?').join(', ');
  const hasNoticeCol = (outDb.prepare("PRAGMA table_info('processing_ack')").all() as Array<{ name: string }>).some(
    (c) => c.name === 'notice_message_out_id',
  );
  const rows = (
    hasNoticeCol
      ? outDb.prepare(
          `SELECT message_id, status, notice_message_out_id
             FROM processing_ack
            WHERE message_id IN (${placeholders})`,
        )
      : outDb.prepare(
          `SELECT message_id, status, NULL AS notice_message_out_id
             FROM processing_ack
            WHERE message_id IN (${placeholders})`,
        )
  ).all(...messageIds) as SchedulerAckRow[];
  return new Map(rows.map((row) => [row.message_id, row]));
}

export function failedAckHasTerminalNotice(
  outDb: Database.Database | null,
  noticeMessageOutId: string | null,
): boolean {
  if (!outDb || !noticeMessageOutId) return false;
  const row = outDb.prepare('SELECT 1 AS ok FROM messages_out WHERE id = ? LIMIT 1').get(noticeMessageOutId) as
    | { ok: number }
    | undefined;
  return row !== undefined;
}

export function recordInvalidSchedulerAck(
  session: Session,
  row: ProjectionRow,
  ack: SchedulerAckRow | null,
  owner: RuntimeLockOwner,
): void {
  recordSchedulerIncident({
    owner,
    dedupeKey: `scheduler-sync:${session.agent_group_id}:${row.series_id}:${row.id}:invalid-failed-ack`,
    severity: 'error',
    session,
    seriesId: row.series_id,
    message: `Scheduled task "${row.series_id}" produced a failed ack without a valid terminal notice; rescheduling it.`,
    details: {
      reason: 'invalid-failed-ack',
      messageId: row.id,
      ackStatus: ack?.status ?? null,
      noticeMessageOutId: ack?.notice_message_out_id ?? null,
    },
  });
}

export function recordUnresolvedSchedulerAck(
  session: Session,
  row: ProjectionRow,
  status: string,
  owner: RuntimeLockOwner,
): void {
  recordSchedulerIncident({
    owner,
    dedupeKey: `scheduler-sync:${session.agent_group_id}:${row.series_id}:${row.id}:unresolved-ack:${status}`,
    severity: 'warn',
    session,
    seriesId: row.series_id,
    message: `Scheduled task "${row.series_id}" is hidden behind an unresolved ${status} ack.`,
    details: {
      reason: 'unresolved-scheduler-ack',
      messageId: row.id,
      ackStatus: status,
    },
  });
}

function recordTerminalFailureIncident(
  session: Session,
  row: ProjectionRow,
  ack: SchedulerAckRow,
  owner: RuntimeLockOwner,
): void {
  recordSchedulerIncident({
    owner,
    dedupeKey: `scheduler-sync:${session.agent_group_id}:${row.series_id}:${row.id}:terminal-failed-ack`,
    severity: 'error',
    session,
    seriesId: row.series_id,
    message: `Scheduled task "${row.series_id}" failed and wrote a terminal notice.`,
    details: {
      reason: 'terminal-failed-ack',
      messageId: row.id,
      noticeMessageOutId: ack.notice_message_out_id,
    },
  });
}

function projectionRowsForSession(inDb: Database.Database): ProjectionRow[] {
  return inDb
    .prepare(
      `SELECT id, series_id, status, recurrence
         FROM messages_in
        WHERE kind = 'task'
          AND series_id IS NOT NULL`,
    )
    .all() as ProjectionRow[];
}

function isLiveProjectedTask(
  task: ScheduledTaskRow | undefined,
  session: Session,
  row: ProjectionRow,
): task is ScheduledTaskRow {
  return (
    task !== undefined &&
    task.status === 'pending' &&
    task.projected_session_id === session.id &&
    task.projected_message_id === row.id
  );
}

function syncCompletedProjection(
  inDb: Database.Database,
  session: Session,
  row: ProjectionRow,
  task: ScheduledTaskRow,
  owner: RuntimeLockOwner,
): void {
  const nextRun = task.recurrence ? nextScheduledRun(task.recurrence) : null;
  completeScheduledTask(
    session.agent_group_id,
    row.series_id,
    { sessionId: session.id, messageId: row.id, nextRun },
    owner,
  );
  clearCompletedProjectionRecurrence(inDb, row.id);
  retireProjection(inDb, row.series_id);

  const refreshed = getScheduledTask(session.agent_group_id, row.series_id);
  if (refreshed?.status === 'pending') {
    projectScheduledTask(inDb, refreshed, session.id, owner);
  }

  log.info('Scheduler projection completion synced', {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    seriesId: row.series_id,
    messageId: row.id,
    nextRun,
  });
}

function repairInvalidFailedProjection(
  inDb: Database.Database,
  session: Session,
  row: ProjectionRow,
  owner: RuntimeLockOwner,
): void {
  retireProjection(inDb, row.series_id);
  clearTaskProjection(session.agent_group_id, row.series_id, { sessionId: session.id, messageId: row.id }, owner);
  const refreshed = getScheduledTask(session.agent_group_id, row.series_id);
  if (refreshed?.status === 'pending') projectScheduledTask(inDb, refreshed, session.id, owner);
}

export function syncSessionSchedulerState(
  inDb: Database.Database,
  outDb: Database.Database | null,
  session: Session,
  owner: RuntimeLockOwner,
): void {
  assertSchedulerOwner(owner);

  const projected = projectionRowsForSession(inDb);
  const acks = outDb ? getProcessingAcksForProjectedTasks(outDb, projected.map((row) => row.id)) : new Map();

  for (const row of projected) {
    const task = getScheduledTask(session.agent_group_id, row.series_id);
    if (!isLiveProjectedTask(task, session, row)) continue;

    const ack = acks.get(row.id) ?? null;
    if (ack?.status === 'processing') continue;

    const inboundCompleted = row.status === 'completed';
    if (ack?.status === 'failed') {
      if (!failedAckHasTerminalNotice(outDb, ack.notice_message_out_id)) {
        recordInvalidSchedulerAck(session, row, ack, owner);
        repairInvalidFailedProjection(inDb, session, row, owner);
        continue;
      }

      failScheduledTask(
        session.agent_group_id,
        row.series_id,
        {
          sessionId: session.id,
          messageId: row.id,
          error: `Failed ack had terminal notice ${ack.notice_message_out_id}`,
        },
        owner,
      );
      recordTerminalFailureIncident(session, row, ack, owner);
      retireProjection(inDb, row.series_id);
      clearCompletedProjectionRecurrence(inDb, row.id);
      log.info('Scheduler projection failure synced', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        seriesId: row.series_id,
        messageId: row.id,
        noticeMessageOutId: ack.notice_message_out_id,
      });
      continue;
    }

    if (inboundCompleted || ack?.status === 'completed') {
      syncCompletedProjection(inDb, session, row, task, owner);
      continue;
    }

    if (ack?.status === 'recovery') {
      recordUnresolvedSchedulerAck(session, row, 'recovery', owner);
    }
  }
}

export function resolveProjectionContext(session: Session): ProjectionContext | null {
  if (!session.messaging_group_id) {
    const agentShared = getDb()
      .prepare(
        `SELECT 1 AS ok
           FROM messaging_group_agents
          WHERE agent_group_id = ?
            AND session_mode = 'agent-shared'
          LIMIT 1`,
      )
      .get(session.agent_group_id) as { ok: number } | undefined;
    return {
      agentGroupId: session.agent_group_id,
      messagingGroupId: null,
      threadId: null,
      sessionMode: agentShared ? 'agent-shared' : 'shared',
    };
  }

  const route = getDb()
    .prepare(
      `SELECT mg.id AS messaging_group_id,
              mg.channel_type AS channel_type,
              mg.is_group AS is_group,
              mga.session_mode AS session_mode
         FROM messaging_groups mg
         JOIN messaging_group_agents mga
           ON mga.messaging_group_id = mg.id
        WHERE mg.id = ?
          AND mga.agent_group_id = ?
        LIMIT 2`,
    )
    .all(session.messaging_group_id, session.agent_group_id) as Array<{
    messaging_group_id: string;
    channel_type: string;
    is_group: number;
    session_mode: ProjectionSessionMode;
  }>;

  if (route.length !== 1) {
    log.warn('Scheduler projection route could not be resolved from central wiring', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      messagingGroupId: session.messaging_group_id,
      matches: route.length,
    });
    return null;
  }

  const row = route[0]!;
  let sessionMode = row.session_mode;
  const adapter = getChannelAdapter(row.channel_type);
  if (adapter?.supportsThreads && sessionMode !== 'agent-shared' && row.is_group !== 0) {
    sessionMode = 'per-thread';
  }

  if (sessionMode === 'agent-shared') {
    return {
      agentGroupId: session.agent_group_id,
      messagingGroupId: null,
      threadId: null,
      sessionMode,
    };
  }

  return {
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id,
    threadId: sessionMode === 'per-thread' ? session.thread_id : null,
    sessionMode,
  };
}

export function ensureSessionSchedulerProjections(
  inDb: Database.Database,
  session: Session,
  projectionContext: ProjectionContext | null,
  owner: RuntimeLockOwner,
): number {
  assertSchedulerOwner(owner);
  if (!projectionContext) return 0;

  const tasks = listLiveScheduledTasksForSession({
    agentGroupId: projectionContext.agentGroupId,
    messagingGroupId: projectionContext.messagingGroupId,
    threadId: projectionContext.threadId,
    sessionMode: projectionContext.sessionMode,
  });

  let projected = 0;
  for (const task of tasks) {
    const messageId = projectScheduledTask(inDb, task, session.id, owner);
    projected++;
    log.debug('Scheduler projection ensured', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      seriesId: task.series_id,
      messageId,
      sessionMode: projectionContext.sessionMode,
    });
  }
  return projected;
}
