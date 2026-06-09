import { withRuntimeLock } from '../db/runtime-locks.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getSession } from '../db/sessions.js';
import { dropInactiveSessionOutbound, getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import type { Session } from '../types.js';
import { continueSchedulerSupersession, recordSchedulerResetIncident } from './scheduler-reset.js';
import {
  assertNoRouteResetInProgress,
  getSchedulerSupersession,
  isRouteResetInProgress,
  listUnfinishedSchedulerSupersessions,
  phaseAtLeast,
  recordSchedulerSupersessionError,
  recordSchedulerSupersessionPhase,
  RouteResetInProgressError,
  type SchedulerResetResponseAddress,
  type SchedulerSessionMode,
  type SchedulerSupersessionPhase,
  type SchedulerSupersessionRow,
} from './scheduler-supersessions.js';

export { assertNoRouteResetInProgress, isRouteResetInProgress, RouteResetInProgressError };

export async function resumeUnfinishedSchedulerSupersessions(): Promise<number> {
  const rows = listUnfinishedSchedulerSupersessions();
  let resumed = 0;
  for (const row of rows) {
    await resumeSchedulerSupersession(row.old_session_id);
    resumed++;
  }
  return resumed;
}

export async function resumeSchedulerSupersession(oldSessionId: string): Promise<void> {
  const row = getSchedulerSupersession(oldSessionId);
  if (!row || row.phase === 'response-delivered' || row.phase === 'failed') return;

  try {
    await withRuntimeLock('scheduler-mutator', 120_000, async (owner) => {
      let current = getSchedulerSupersession(oldSessionId);
      if (!current || current.phase === 'response-delivered' || current.phase === 'failed') return;

      const fresh = await continueSchedulerSupersession(current, owner);
      const oldSession = getSession(oldSessionId);
      if (!oldSession) {
        throw new Error(`Cannot finish scheduler supersession repair ${oldSessionId}: old session missing`);
      }

      current = getSchedulerSupersession(oldSessionId);
      if (!current || current.phase === 'response-delivered' || current.phase === 'failed') return;

      if (!phaseAtLeast(current.phase, 'old-outbound-suppressed')) {
        try {
          await dropInactiveSessionOutbound(oldSessionId, `scheduler-reset-repair-${current.command}`);
          recordSchedulerSupersessionPhase({
            oldSession,
            freshSessionId: fresh.id,
            command: current.command,
            sessionMode: current.session_mode as SchedulerSessionMode,
            phase: 'old-outbound-suppressed',
          });
        } catch (err) {
          recordSchedulerSupersessionError(oldSessionId, currentRepairPhase(oldSessionId, current.phase), err);
          recordSchedulerResetIncident({
            oldSession,
            freshSessionId: fresh.id,
            command: current.command,
            phase: 'old-outbound-suppressed',
            err,
          });
          log.error('Scheduler supersession repair failed to suppress old outbound', {
            oldSessionId,
            freshSessionId: fresh.id,
            command: current.command,
            err,
          });
          return;
        }
      }

      current = getSchedulerSupersession(oldSessionId);
      if (!current || current.phase === 'response-delivered' || current.phase === 'failed') return;

      try {
        await deliverRepairResetResponse(oldSession, fresh.id, current);
        recordSchedulerSupersessionPhase({
          oldSession,
          freshSessionId: fresh.id,
          command: current.command,
          sessionMode: current.session_mode as SchedulerSessionMode,
          phase: 'response-delivered',
        });
      } catch (err) {
        recordSchedulerSupersessionError(oldSessionId, currentRepairPhase(oldSessionId, current.phase), err);
        recordSchedulerResetIncident({
          oldSession,
          freshSessionId: fresh.id,
          command: current.command,
          phase: 'response-delivered',
          err,
        });
        log.error('Scheduler supersession repair failed to deliver host response', {
          oldSessionId,
          freshSessionId: fresh.id,
          command: current.command,
          err,
        });
        return;
      }

      log.info('Scheduler supersession repair finished', {
        oldSessionId,
        freshSessionId: fresh.id,
        command: current.command,
      });
    });
  } catch (err) {
    if (isSchedulerLockContention(err)) {
      log.info('Scheduler supersession repair skipped because another scheduler mutation is active', {
        oldSessionId,
        phase: currentRepairPhase(oldSessionId, row.phase),
      });
      return;
    }

    const current = getSchedulerSupersession(oldSessionId);
    const phase = currentRepairPhase(oldSessionId, current?.phase ?? row.phase);
    recordSchedulerSupersessionError(oldSessionId, phase, err);
    const oldSession = getSession(oldSessionId);
    if (oldSession) {
      recordSchedulerResetIncident({
        oldSession,
        freshSessionId: current?.new_session_id ?? row.new_session_id,
        command: current?.command ?? row.command,
        phase,
        err,
      });
    }
    log.error('Scheduler supersession repair failed', {
      oldSessionId,
      freshSessionId: current?.new_session_id ?? row.new_session_id,
      phase,
      err,
    });
  }
}

async function deliverRepairResetResponse(
  oldSession: Session,
  freshSessionId: string,
  row: SchedulerSupersessionRow,
): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    throw new Error(
      `Cannot deliver scheduler reset repair response for ${oldSession.id}: delivery adapter is not ready`,
    );
  }
  const responseAddress = responseAddressForRepair(oldSession, row);

  await adapter.deliver(
    responseAddress.channelType,
    responseAddress.platformId,
    responseAddress.threadId,
    'chat',
    JSON.stringify({ text: `Started a fresh session: ${freshSessionId}` }),
  );
  log.info('Scheduler supersession repair delivered reset response', {
    oldSessionId: oldSession.id,
    freshSessionId,
    command: row.command,
    channelType: responseAddress.channelType,
    platformId: responseAddress.platformId,
    threadId: responseAddress.threadId,
  });
}

function responseAddressForRepair(oldSession: Session, row: SchedulerSupersessionRow): SchedulerResetResponseAddress {
  if (row.response_channel_type && row.response_platform_id) {
    return {
      channelType: row.response_channel_type,
      platformId: row.response_platform_id,
      threadId: row.response_thread_id,
    };
  }

  if (!oldSession.messaging_group_id) {
    throw new Error(`Cannot deliver scheduler reset repair response for ${oldSession.id}: response address is missing`);
  }
  const messagingGroup = getMessagingGroup(oldSession.messaging_group_id);
  if (!messagingGroup) {
    throw new Error(
      `Cannot deliver scheduler reset repair response for ${oldSession.id}: messaging group ${oldSession.messaging_group_id} is missing`,
    );
  }
  return {
    channelType: messagingGroup.channel_type,
    platformId: messagingGroup.platform_id,
    threadId: oldSession.thread_id,
  };
}

function currentRepairPhase(oldSessionId: string, fallback: SchedulerSupersessionPhase): SchedulerSupersessionPhase {
  return getSchedulerSupersession(oldSessionId)?.phase ?? fallback;
}

function isSchedulerLockContention(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Runtime lock "scheduler-mutator" is already held');
}
