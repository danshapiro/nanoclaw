import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { type RuntimeLockOwner } from '../../db/runtime-locks.js';
import { getSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { recordSchedulerIncidentWithOwner, reportSchedulerIncident } from '../../yente/scheduler-alerts.js';
import { getScheduledTask, importLegacyScheduledTask } from './ledger.js';

interface LegacyActiveTaskRow {
  id: string;
  status: 'pending' | 'paused';
  process_after: string | null;
  recurrence: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  messaging_group_id: string | null;
  is_group: 0 | 1 | null;
  content: string;
  series_id: string | null;
}

export async function importLegacyActiveTasks(
  inDb: Database.Database,
  session: Session,
  owner: RuntimeLockOwner,
): Promise<number> {
  const rows = inDb
    .prepare(
      `SELECT id,
              status,
              process_after,
              recurrence,
              platform_id,
              channel_type,
              thread_id,
              messaging_group_id,
              is_group,
              content,
              series_id
         FROM messages_in
        WHERE kind = 'task'
          AND status IN ('pending', 'paused')
        ORDER BY seq ASC, id ASC`,
    )
    .all() as LegacyActiveTaskRow[];

  let imported = 0;
  for (const row of rows) {
    const seriesId = row.series_id ?? row.id;
    if (getScheduledTask(session.agent_group_id, seriesId)) continue;

    const refs = validateSchedulerRefs(session, row);
    if (!refs.valid) {
      reportInvalidLegacyTaskRefs(session, seriesId, row, refs.reason, owner);
      continue;
    }
    if (!row.process_after) continue;

    imported += importLegacyScheduledTask(
      {
        seriesId,
        agentGroupId: session.agent_group_id,
        messagingGroupId: row.messaging_group_id ?? session.messaging_group_id ?? null,
        threadId: row.thread_id ?? session.thread_id ?? null,
        platformId: row.platform_id,
        channelType: row.channel_type,
        isGroup: row.is_group,
        processAfter: row.process_after,
        recurrence: row.recurrence,
        content: row.content,
        sessionId: session.id,
        messageId: row.id,
        status: row.status,
      },
      owner,
    );
  }
  return imported;
}

export async function reportUnsafeLegacyArchivedTask(args: {
  session: Session;
  seriesId: string;
  messageId: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  messagingGroupId: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await reportSchedulerIncident({
    dedupeKey: `legacy-archived:${args.session.id}:${args.messageId}`,
    severity: 'warn',
    message: `Found an archived scheduled task (${args.seriesId}) that predates the durable scheduler ledger. It was not auto-run because cancellation intent cannot be proven.`,
    agentGroupId: args.session.agent_group_id,
    seriesId: args.seriesId,
    sessionId: args.session.id,
    messagingGroupId: args.messagingGroupId ?? args.session.messaging_group_id,
    channelType: args.channelType,
    platformId: args.platformId,
    threadId: args.threadId,
    details: { messageId: args.messageId, ...(args.details ?? {}) },
  });
}

function validateSchedulerRefs(
  session: Session,
  row: LegacyActiveTaskRow,
): { valid: true } | { valid: false; reason: string } {
  const centralSession = getSession(session.id);
  if (!centralSession) return { valid: false, reason: 'missing-session' };
  if (centralSession.status !== 'active') return { valid: false, reason: 'session-not-active' };
  if (!getAgentGroup(session.agent_group_id)) return { valid: false, reason: 'missing-agent-group' };

  const messagingGroupId = row.messaging_group_id ?? session.messaging_group_id;
  if (messagingGroupId && !getMessagingGroup(messagingGroupId)) {
    return { valid: false, reason: 'missing-messaging-group' };
  }
  return { valid: true };
}

function reportInvalidLegacyTaskRefs(
  session: Session,
  seriesId: string,
  row: LegacyActiveTaskRow,
  reason: string,
  owner: RuntimeLockOwner,
): void {
  recordSchedulerIncidentWithOwner(
    {
      dedupeKey: `legacy-invalid-refs:${session.id}:${row.id}`,
      severity: 'warn',
      message: `Found legacy scheduled task ${seriesId} in session ${session.id}, but its central session references are invalid. It was not imported.`,
      agentGroupId: session.agent_group_id,
      seriesId,
      sessionId: session.id,
      messagingGroupId: row.messaging_group_id ?? session.messaging_group_id,
      channelType: row.channel_type,
      platformId: row.platform_id,
      threadId: row.thread_id ?? session.thread_id,
      details: {
        reason,
        messageId: row.id,
        agentGroupId: session.agent_group_id,
        messagingGroupId: row.messaging_group_id ?? session.messaging_group_id,
      },
    },
    owner,
  );
}
