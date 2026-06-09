import type Database from 'better-sqlite3';

import { isSessionOutboundWriterRunning } from '../../container-runner.js';
import { quiesceSessionDelivery } from '../../delivery.js';
import { getDb } from '../../db/connection.js';
import { assertRuntimeLockOwner, type RuntimeLockOwner } from '../../db/runtime-locks.js';
import { getDeliveredIds, getDueOutboundMessages, markDelivered, migrateDeliveredTable } from '../../db/session-db.js';
import { log } from '../../log.js';
import { openInboundDb, openOutboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  applyCancelTaskAction,
  applyPauseTaskAction,
  applyResumeTaskAction,
  applyScheduleTaskAction,
  applyUpdateTaskAction,
} from './actions.js';

const LOCK_NAME = 'scheduler-mutator';
const SCHEDULING_ACTIONS = new Set(['schedule_task', 'cancel_task', 'pause_task', 'resume_task', 'update_task']);

type DrainedActionStatus = 'intent' | 'applied';

interface DrainedActionRow {
  status: DrainedActionStatus;
}

export async function drainSchedulingActionsFromStoppedSession(
  session: Session,
  owner: RuntimeLockOwner,
): Promise<number> {
  if (owner.name !== LOCK_NAME) {
    throw new Error(`Scheduler drain requires runtime lock "${LOCK_NAME}"`);
  }
  assertRuntimeLockOwner(owner);

  if (await isSessionOutboundWriterRunning(session)) {
    throw new Error(`refusing scheduler drain while container is running for session ${session.id}`);
  }

  await quiesceSessionDelivery(session.id, 'scheduler-reset-drain');

  let inDb: Database.Database | null = null;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(session.agent_group_id, session.id);
    outDb = openOutboundDb(session.agent_group_id, session.id);
    migrateDeliveredTable(inDb);

    const delivered = getDeliveredIds(inDb);
    const due = getDueOutboundMessages(outDb).filter((row) => !delivered.has(row.id));
    let applied = 0;

    for (const row of due) {
      if (row.kind !== 'system') continue;

      const content = JSON.parse(row.content) as Record<string, unknown>;
      const action = typeof content.action === 'string' ? content.action : '';
      if (!SCHEDULING_ACTIONS.has(action)) continue;

      const drained = getDrainedAction(session.id, row.id);
      if (drained?.status === 'applied') {
        markDelivered(inDb, row.id, null);
        log.info('Skipped already-applied drained scheduling action', {
          sessionId: session.id,
          messageId: row.id,
          action,
        });
        continue;
      }

      recordDrainedActionIntent(session.id, row.id, action, content, owner);
      await applySchedulingActionForDrain(action, content, session, inDb, owner, row.id);
      markDrainedActionApplied(session.id, row.id, owner);
      markDelivered(inDb, row.id, null);
      applied++;

      log.info('Drained scheduling action from stopped session', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        messageId: row.id,
        action,
      });
    }

    return applied;
  } finally {
    outDb?.close();
    inDb?.close();
  }
}

async function applySchedulingActionForDrain(
  action: string,
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  owner: RuntimeLockOwner,
  sourceMessageId: string,
): Promise<void> {
  const options = { source: 'drain' as const, sourceMessageId };
  if (action === 'schedule_task') {
    applyScheduleTaskAction(content, session, inDb, owner, options);
    return;
  }
  if (action === 'cancel_task') {
    applyCancelTaskAction(content, session, inDb, owner, options);
    return;
  }
  if (action === 'pause_task') {
    applyPauseTaskAction(content, session, inDb, owner, options);
    return;
  }
  if (action === 'resume_task') {
    applyResumeTaskAction(content, session, inDb, owner, options);
    return;
  }
  if (action === 'update_task') {
    applyUpdateTaskAction(content, session, inDb, owner, options);
  }
}

function getDrainedAction(oldSessionId: string, messageOutId: string): DrainedActionRow | undefined {
  return getDb()
    .prepare(
      `SELECT status
       FROM scheduler_drained_actions
       WHERE old_session_id = ? AND message_out_id = ?`,
    )
    .get(oldSessionId, messageOutId) as DrainedActionRow | undefined;
}

function recordDrainedActionIntent(
  oldSessionId: string,
  messageOutId: string,
  action: string,
  content: Record<string, unknown>,
  owner: RuntimeLockOwner,
): void {
  getDb().transaction(() => {
    assertRuntimeLockOwner(owner);
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO scheduler_drained_actions
             (old_session_id, message_out_id, action, status, intent_at, applied_at, details_json)
           VALUES (?, ?, ?, 'intent', ?, NULL, ?)`,
      )
      .run(oldSessionId, messageOutId, action, new Date().toISOString(), JSON.stringify(content));
  })();
}

function markDrainedActionApplied(oldSessionId: string, messageOutId: string, owner: RuntimeLockOwner): void {
  getDb().transaction(() => {
    assertRuntimeLockOwner(owner);
    getDb()
      .prepare(
        `UPDATE scheduler_drained_actions
           SET status = 'applied', applied_at = ?
           WHERE old_session_id = ? AND message_out_id = ?`,
      )
      .run(new Date().toISOString(), oldSessionId, messageOutId);
  })();
}
