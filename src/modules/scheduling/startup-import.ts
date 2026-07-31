import fs from 'fs';

import { RuntimeLockHeldError, withRuntimeLock } from '../../db/runtime-locks.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { reportSchedulerIncident } from '../../yente/scheduler-alerts.js';
import { importLegacyActiveTasks } from './legacy-import.js';

/** Bounded retries per session when the scheduler-mutator lock is contended. */
const MAX_LOCK_RETRIES = 5;
const LOCK_RETRY_BACKOFF_MS = 25;

/**
 * One-time startup reconciliation for legacy pre-ledger scheduled tasks.
 *
 * The bounded host sweep (getSweepableSessions) deliberately skips active
 * sessions with no recency/task/container liveness signal — but a legacy
 * kind='task' inbound row has NO central scheduled_tasks row until
 * importLegacyActiveTasks first succeeds, so a session already >30 days
 * stale at deploy time would never be visited and its future-dated legacy
 * work would be silently dropped. This pass visits ALL active sessions
 * (deliberately unbounded — it runs ONCE per process start, in the
 * background, after the service is up) and runs the exact same import
 * path the sweep uses.
 */
export async function reconcileLegacyTaskImportsOnStartup(): Promise<{
  scanned: number;
  imported: number;
  failed: number;
}> {
  const sessions = getActiveSessions(); // FULL active set — one-time, unbounded by design
  let imported = 0;
  let failed = 0;
  // The host sweep's first pass runs concurrently with this loop and takes
  // the same per-session 'scheduler-mutator' lock, which throws
  // RuntimeLockHeldError immediately on contention. A collision must NOT
  // permanently fail the session: the >30-day-stale sessions this one-time
  // pass exists for are never revisited by the bounded sweep, so a dropped
  // session strands its legacy tasks until the next restart. Instead,
  // re-queue the session and retry after a short backoff — the sweep's
  // per-session lock hold is brief, so a handful of attempts is plenty.
  const queue = sessions.map((session) => ({ session, lockAttempts: 0 }));
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    const { session } = entry;
    if (!fs.existsSync(inboundDbPath(session.agent_group_id, session.id))) continue;
    try {
      const inDb = openInboundDb(session.agent_group_id, session.id);
      try {
        imported += await withRuntimeLock('scheduler-mutator', 120_000, (owner) =>
          importLegacyActiveTasks(inDb, session, owner),
        );
      } finally {
        inDb.close();
      }
    } catch (err) {
      if (err instanceof RuntimeLockHeldError && entry.lockAttempts < MAX_LOCK_RETRIES) {
        entry.lockAttempts += 1;
        queue.push(entry);
        log.debug('Startup legacy import deferred on scheduler-mutator contention', {
          sessionId: session.id,
          attempt: entry.lockAttempts,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_BACKOFF_MS * entry.lockAttempts));
        continue;
      }
      failed += 1;
      log.error('Startup legacy import failed for session', { sessionId: session.id, err });
      try {
        await reportSchedulerIncident({
          // Same dedupe key as the sweep's legacy-import incident — retries
          // and later sweep passes will not spam duplicates.
          dedupeKey: `legacy-import:${session.id}`,
          severity: 'error',
          message: `Startup legacy-task import reconciliation failed for session ${session.id}. Scheduled tasks may be delayed until import succeeds.`,
          agentGroupId: session.agent_group_id,
          sessionId: session.id,
          messagingGroupId: session.messaging_group_id,
          threadId: session.thread_id,
          details: { err: err instanceof Error ? err.message : String(err) },
        });
      } catch (incidentErr) {
        log.error('Failed to record startup legacy-import incident', { sessionId: session.id, err: incidentErr });
      }
    }
    // Yield a full event-loop turn per session — deploy day can mean
    // thousands of sessions and this must not starve adapters or the sweep.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  log.info('Startup legacy-task import reconciliation finished', {
    scanned: sessions.length,
    imported,
    failed,
  });
  return { scanned: sessions.length, imported, failed };
}
