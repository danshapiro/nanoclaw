import type Database from 'better-sqlite3';
import fs from 'fs';

import { getDb } from '../../db/connection.js';
import { getActiveSessions } from '../../db/sessions.js';
import { withRuntimeLock } from '../../db/runtime-locks.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { reportSchedulerIncident } from '../../yente/scheduler-alerts.js';
import { reportUnsafeLegacyArchivedTask } from './legacy-import.js';
import { getScheduledTask, tombstoneLegacyArchivedTask } from './ledger.js';
import { ensureSessionSchedulerProjections, resolveProjectionContext } from './sync.js';

interface LegacyTaskRow {
  id: string;
  series_id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  messaging_group_id: string | null;
  is_group: 0 | 1 | null;
  content: string;
}

export async function repairSchedulerProjections(): Promise<void> {
  for (const session of getActiveSessions()) {
    await repairActiveSessionProjections(session);
  }
  await reportUnsafeArchivedSchedulerRows();
}

async function repairActiveSessionProjections(session: Session): Promise<void> {
  let inDb: Database.Database | null = null;
  try {
    if (!fs.existsSync(inboundDbPath(session.agent_group_id, session.id))) {
      return;
    }
    inDb = openInboundDb(session.agent_group_id, session.id);
    await withRuntimeLock('scheduler-mutator', 120_000, async (owner) => {
      ensureSessionSchedulerProjections(inDb!, session, resolveProjectionContext(session), owner);
    });
  } catch (err) {
    log.error('Scheduler projection repair failed for session', { sessionId: session.id, err });
    await reportSchedulerIncident({
      dedupeKey: `repair:${session.id}`,
      severity: 'error',
      message: `Scheduler repair failed for session ${session.id}. Scheduled tasks may be delayed until repair succeeds.`,
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
      threadId: session.thread_id,
      details: { err: errorMessage(err) },
    });
  } finally {
    inDb?.close();
  }
}

async function reportUnsafeArchivedSchedulerRows(): Promise<void> {
  const sessions = getDb()
    .prepare("SELECT * FROM sessions WHERE status <> 'active' ORDER BY created_at ASC, id ASC")
    .all() as Session[];

  for (const session of sessions) {
    const inPath = inboundDbPath(session.agent_group_id, session.id);
    if (!fs.existsSync(inPath)) continue;

    let inDb: Database.Database | null = null;
    try {
      inDb = openInboundDb(session.agent_group_id, session.id);
      const rows = listUnsafeLegacyRows(inDb);
      for (const row of rows) {
        const central = getScheduledTask(session.agent_group_id, row.series_id);
        if (central) continue;

        await reportUnsafeLegacyArchivedTask({
          session,
          seriesId: row.series_id,
          messageId: row.id,
          messagingGroupId: row.messaging_group_id ?? session.messaging_group_id,
          channelType: row.channel_type,
          platformId: row.platform_id,
          threadId: row.thread_id ?? session.thread_id,
          details: {
            reason: 'archived-live-task-without-central-proof',
            archivedSessionId: session.id,
            messageId: row.id,
            status: row.status,
            processAfter: row.process_after,
            recurrence: row.recurrence,
          },
        });

        // Report-first: only after the incident report succeeded, tombstone the
        // legacy row centrally so future sweeps short-circuit on the central-row
        // check instead of re-reporting (and dedupe-logging) forever. Restricted
        // to provably terminal sessions; transient states (e.g. 'resetting')
        // stay report-only.
        if (session.status === 'archived') {
          await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
            tombstoneLegacyArchivedTask(
              {
                seriesId: row.series_id,
                agentGroupId: session.agent_group_id,
                messagingGroupId: row.messaging_group_id ?? session.messaging_group_id,
                threadId: row.thread_id ?? session.thread_id,
                platformId: row.platform_id,
                channelType: row.channel_type,
                isGroup: row.is_group,
                processAfter: row.process_after,
                recurrence: row.recurrence,
                content: row.content,
                sessionId: session.id,
                messageId: row.id,
              },
              owner,
            );
          });
        }
      }
    } catch (err) {
      log.error('Archived scheduler row scan failed', { sessionId: session.id, err });
      await reportSchedulerIncident({
        dedupeKey: `legacy-archived-scan:${session.id}`,
        severity: 'error',
        message: `Scheduler repair could not scan archived session ${session.id}.`,
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        messagingGroupId: session.messaging_group_id,
        threadId: session.thread_id,
        details: { err: errorMessage(err) },
      });
    } finally {
      inDb?.close();
    }
  }
}

function listUnsafeLegacyRows(inDb: Database.Database): LegacyTaskRow[] {
  return inDb
    .prepare(
      `SELECT id,
              series_id,
              status,
              process_after,
              recurrence,
              channel_type,
              platform_id,
              thread_id,
              messaging_group_id,
              is_group,
              content
        FROM messages_in
        WHERE kind = 'task'
          AND series_id IS NOT NULL
          AND (
            status IN ('pending', 'paused', 'processing')
            OR (status = 'completed' AND recurrence IS NOT NULL)
          )
        ORDER BY seq ASC, id ASC`,
    )
    .all() as LegacyTaskRow[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
