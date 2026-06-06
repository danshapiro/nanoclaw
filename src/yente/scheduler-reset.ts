import type Database from 'better-sqlite3';

import { stopContainerAndVerify } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { withRuntimeLock, type RuntimeLockOwner } from '../db/runtime-locks.js';
import { createSession, getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { drainSchedulingActionsFromStoppedSession } from '../modules/scheduling/drain.js';
import {
  ensureSessionSchedulerProjections,
  resolveProjectionContext,
  syncSessionSchedulerState,
} from '../modules/scheduling/sync.js';
import { initSessionFolder, openInboundDb, openOutboundDb, type SessionMode } from '../session-manager.js';
import type { Session } from '../types.js';
import {
  getSchedulerSupersession,
  phaseAtLeast,
  recordSchedulerSupersessionError,
  recordSchedulerSupersessionPhase,
  recordSchedulerSupersessionPhaseInDb,
  terminalPhase,
  type SchedulerResetResponseAddress,
  type SchedulerSupersessionPhase,
  type SchedulerSupersessionRow,
} from './scheduler-supersessions.js';

const LOCK_NAME = 'scheduler-mutator';

export class SchedulerResetError extends Error {
  constructor(
    message: string,
    options: {
      cause: unknown;
      oldSessionId: string;
      freshSessionId: string;
      phase: SchedulerSupersessionPhase;
      oldSessionRemainsActive: boolean;
      repairable: boolean;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'SchedulerResetError';
    this.oldSessionId = options.oldSessionId;
    this.freshSessionId = options.freshSessionId;
    this.phase = options.phase;
    this.oldSessionRemainsActive = options.oldSessionRemainsActive;
    this.repairable = options.repairable;
  }

  readonly oldSessionId: string;
  readonly freshSessionId: string;
  readonly phase: SchedulerSupersessionPhase;
  readonly oldSessionRemainsActive: boolean;
  readonly repairable: boolean;
}

export async function resetYenteSessionPreservingScheduler(args: {
  command: 'new' | 'clear';
  oldSession: Session;
  sessionMode: SessionMode;
  responseAddress: SchedulerResetResponseAddress;
}): Promise<Session> {
  const freshSessionId = generateSessionId();
  const state = {
    phase: 'started' as SchedulerSupersessionPhase,
    oldSessionMarkedResetting: false,
  };

  try {
    return await withRuntimeLock(LOCK_NAME, 120_000, async (owner) => {
      recordSchedulerSupersessionPhase({
        oldSession: args.oldSession,
        freshSessionId,
        command: args.command,
        sessionMode: args.sessionMode,
        responseAddress: args.responseAddress,
        phase: 'started',
      });

      log.info('Yente scheduler-aware reset started', {
        command: args.command,
        oldSessionId: args.oldSession.id,
        freshSessionId,
        agentGroupId: args.oldSession.agent_group_id,
      });

      return await runSchedulerResetPhases(
        {
          oldSession: args.oldSession,
          freshSessionId,
          command: args.command,
          sessionMode: args.sessionMode,
          responseAddress: args.responseAddress,
          phase: 'started',
        },
        owner,
        state,
      );
    });
  } catch (err) {
    const existingSupersession = getSchedulerSupersession(args.oldSession.id);
    const ownsSupersession =
      existingSupersession === undefined ||
      existingSupersession.new_session_id === freshSessionId ||
      existingSupersession.phase === 'failed';
    const oldSessionRemainsActive = !state.oldSessionMarkedResetting;
    if (oldSessionRemainsActive && ownsSupersession) {
      recordSchedulerSupersessionPhase({
        oldSession: args.oldSession,
        freshSessionId,
        command: args.command,
        sessionMode: args.sessionMode,
        responseAddress: args.responseAddress,
        phase: 'failed',
        error: err,
      });
    } else {
      const phase =
        existingSupersession && !terminalPhase(existingSupersession.phase) ? existingSupersession.phase : state.phase;
      recordSchedulerSupersessionError(args.oldSession.id, phase, err);
      recordSchedulerResetIncident({
        oldSession: args.oldSession,
        freshSessionId: existingSupersession?.new_session_id ?? freshSessionId,
        command: args.command,
        phase,
        err,
      });
    }

    const preSideEffectFailure = oldSessionRemainsActive && ownsSupersession;
    throw new SchedulerResetError('Yente scheduler-aware reset failed', {
      cause: err,
      oldSessionId: args.oldSession.id,
      freshSessionId: existingSupersession?.new_session_id ?? freshSessionId,
      phase:
        existingSupersession && !terminalPhase(existingSupersession.phase) ? existingSupersession.phase : state.phase,
      oldSessionRemainsActive: preSideEffectFailure,
      repairable: !preSideEffectFailure,
    });
  }
}

export async function continueSchedulerSupersession(
  row: SchedulerSupersessionRow,
  owner: RuntimeLockOwner,
): Promise<Session> {
  const oldSession = getSession(row.old_session_id);
  if (!oldSession) {
    throw new Error(`Cannot resume scheduler supersession ${row.old_session_id}: old session missing`);
  }
  if (!row.new_session_id) {
    throw new Error(`Cannot resume scheduler supersession ${row.old_session_id}: fresh session id missing`);
  }

  return await runSchedulerResetPhases(
    {
      oldSession,
      freshSessionId: row.new_session_id,
      command: row.command as 'new' | 'clear',
      sessionMode: row.session_mode,
      responseAddress: responseAddressFromSupersession(row),
      phase: row.phase,
    },
    owner,
    {
      phase: row.phase,
      oldSessionMarkedResetting: phaseAtLeast(row.phase, 'old-resetting'),
    },
  );
}

export function markSchedulerResetOldOutboundSuppressed(oldSessionId: string): void {
  const row = getSchedulerSupersession(oldSessionId);
  if (!row) return;
  const oldSession = getSession(row.old_session_id);
  if (!oldSession) return;
  recordSchedulerSupersessionPhase({
    oldSession,
    freshSessionId: row.new_session_id,
    command: row.command,
    sessionMode: row.session_mode,
    responseAddress: responseAddressFromSupersession(row),
    phase: 'old-outbound-suppressed',
  });
}

export function markSchedulerResetResponseDelivered(oldSessionId: string): void {
  const row = getSchedulerSupersession(oldSessionId);
  if (!row) return;
  const oldSession = getSession(row.old_session_id);
  if (!oldSession) return;
  recordSchedulerSupersessionPhase({
    oldSession,
    freshSessionId: row.new_session_id,
    command: row.command,
    sessionMode: row.session_mode,
    responseAddress: responseAddressFromSupersession(row),
    phase: 'response-delivered',
  });
}

export function recordSchedulerResetIncident(args: {
  oldSession: Session;
  freshSessionId: string | null;
  command: string;
  phase: SchedulerSupersessionPhase | string;
  err: unknown;
}): void {
  const message = `Yente session reset for ${args.oldSession.id} failed during ${args.phase}; scheduler repair will retry.`;
  const now = new Date().toISOString();
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
         next_attempt_at
       ) VALUES (
         @id,
         @dedupeKey,
         'error',
         'pending',
         @agentGroupId,
         NULL,
         @sessionId,
         @messagingGroupId,
         NULL,
         NULL,
         @threadId,
         @message,
         @detailsJson,
         @now,
         @now
       )`,
    )
    .run({
      id: `sched-inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      dedupeKey: `scheduler-reset:${args.oldSession.id}:${args.phase}`,
      agentGroupId: args.oldSession.agent_group_id,
      sessionId: args.oldSession.id,
      messagingGroupId: args.oldSession.messaging_group_id,
      threadId: args.oldSession.thread_id,
      message,
      detailsJson: JSON.stringify({
        command: args.command,
        phase: args.phase,
        oldSessionId: args.oldSession.id,
        freshSessionId: args.freshSessionId,
        error: errorDetails(args.err),
      }),
      now,
    });
}

async function runSchedulerResetPhases(
  args: {
    oldSession: Session;
    freshSessionId: string;
    command: 'new' | 'clear';
    sessionMode: SessionMode;
    responseAddress: SchedulerResetResponseAddress | null;
    phase: SchedulerSupersessionPhase;
  },
  owner: RuntimeLockOwner,
  state: { phase: SchedulerSupersessionPhase; oldSessionMarkedResetting: boolean },
): Promise<Session> {
  let phase = args.phase;
  const oldSession = args.oldSession;

  if (!phaseAtLeast(phase, 'old-resetting')) {
    updateSessionStatus(oldSession.id, 'resetting', oldSession.container_status);
    state.oldSessionMarkedResetting = true;
    phase = recordPhase(args, 'old-resetting', state);
  } else {
    state.oldSessionMarkedResetting = true;
  }

  if (!phaseAtLeast(phase, 'old-stopped')) {
    await stopContainerAndVerify(oldSession.id, `yente-session-${args.command}-scheduler-preserve`);
    phase = recordPhase(args, 'old-stopped', state);
  } else if (!phaseAtLeast(phase, 'actions-drained')) {
    await stopContainerAndVerify(oldSession.id, `yente-session-${args.command}-scheduler-preserve-verify`);
  }

  if (!phaseAtLeast(phase, 'actions-drained')) {
    await drainSchedulingActionsFromStoppedSession(oldSession, owner);
    phase = recordPhase(args, 'actions-drained', state);
  }

  if (!phaseAtLeast(phase, 'old-synced')) {
    syncOldSchedulerState(oldSession, owner);
    phase = recordPhase(args, 'old-synced', state);
  }

  const fresh = ensureFreshSession(args, phase, state);
  phase = state.phase;

  if (!phaseAtLeast(phase, 'fresh-projecting')) {
    phase = recordPhase(args, 'fresh-projecting', state);
  }

  if (!phaseAtLeast(phase, 'fresh-projected')) {
    const inDb = openInboundDb(fresh.agent_group_id, fresh.id);
    try {
      ensureSessionSchedulerProjections(inDb, fresh, resolveProjectionContext(fresh), owner);
    } finally {
      inDb.close();
    }
    phase = recordPhase(args, 'fresh-projected', state);
  }

  if (!phaseAtLeast(phase, 'fresh-activated')) {
    activateFreshAndArchiveOldAtomically(oldSession.id, fresh.id, args);
    phase = 'fresh-activated';
    state.phase = phase;
  }

  const activated = getSession(fresh.id);
  if (!activated) throw new Error(`Fresh session ${fresh.id} disappeared during reset`);

  log.info('Yente scheduler-aware reset finished', {
    command: args.command,
    oldSessionId: oldSession.id,
    freshSessionId: fresh.id,
    agentGroupId: oldSession.agent_group_id,
    phase,
  });

  return activated;
}

function ensureFreshSession(
  args: {
    oldSession: Session;
    freshSessionId: string;
    command: 'new' | 'clear';
    sessionMode: SessionMode;
    responseAddress: SchedulerResetResponseAddress | null;
  },
  phase: SchedulerSupersessionPhase,
  state: { phase: SchedulerSupersessionPhase },
): Session {
  let fresh = getSession(args.freshSessionId);
  if (!phaseAtLeast(phase, 'fresh-created')) {
    if (!fresh) {
      fresh = {
        id: args.freshSessionId,
        agent_group_id: args.oldSession.agent_group_id,
        messaging_group_id: args.oldSession.messaging_group_id,
        thread_id: args.oldSession.thread_id,
        agent_provider: args.oldSession.agent_provider,
        status: 'resetting',
        container_status: 'stopped',
        last_active: null,
        created_at: new Date().toISOString(),
      };
      createSession(fresh);
    }
    initSessionFolder(fresh.agent_group_id, fresh.id);
    recordPhase(args, 'fresh-created', state);
  }

  fresh = getSession(args.freshSessionId);
  if (!fresh) throw new Error(`Fresh session ${args.freshSessionId} was not created`);
  return fresh;
}

function syncOldSchedulerState(session: Session, owner: RuntimeLockOwner): void {
  const inDb = openInboundDb(session.agent_group_id, session.id);
  let outDb: Database.Database | null = null;
  try {
    try {
      outDb = openOutboundDb(session.agent_group_id, session.id);
    } catch (err) {
      log.warn('Old session outbound DB unavailable during scheduler reset sync', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        err,
      });
    }
    syncSessionSchedulerState(inDb, outDb, session, owner);
  } finally {
    outDb?.close();
    inDb.close();
  }
}

function activateFreshAndArchiveOldAtomically(
  oldSessionId: string,
  freshSessionId: string,
  args: {
    oldSession: Session;
    command: 'new' | 'clear';
    sessionMode: SessionMode;
    responseAddress: SchedulerResetResponseAddress | null;
  },
): void {
  getDb().transaction(() => {
    updateSessionStatus(oldSessionId, 'archived', 'stopped');
    updateSessionStatus(freshSessionId, 'active', 'stopped');
    recordSchedulerSupersessionPhaseInDb({
      oldSession: args.oldSession,
      freshSessionId,
      command: args.command,
      sessionMode: args.sessionMode,
      responseAddress: args.responseAddress,
      phase: 'old-archived',
    });
    recordSchedulerSupersessionPhaseInDb({
      oldSession: args.oldSession,
      freshSessionId,
      command: args.command,
      sessionMode: args.sessionMode,
      responseAddress: args.responseAddress,
      phase: 'fresh-activated',
    });
  })();
}

function updateSessionStatus(
  sessionId: string,
  status: Session['status'],
  containerStatus: Session['container_status'],
): void {
  getDb()
    .prepare('UPDATE sessions SET status = ?, container_status = ? WHERE id = ?')
    .run(status, containerStatus, sessionId);
}

function recordPhase(
  args: {
    oldSession: Session;
    freshSessionId: string;
    command: 'new' | 'clear';
    sessionMode: SessionMode;
    responseAddress: SchedulerResetResponseAddress | null;
  },
  phase: SchedulerSupersessionPhase,
  state: { phase: SchedulerSupersessionPhase },
): SchedulerSupersessionPhase {
  recordSchedulerSupersessionPhase({
    oldSession: args.oldSession,
    freshSessionId: args.freshSessionId,
    command: args.command,
    sessionMode: args.sessionMode,
    responseAddress: args.responseAddress,
    phase,
  });
  state.phase = phase;
  return phase;
}

function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function responseAddressFromSupersession(row: SchedulerSupersessionRow): SchedulerResetResponseAddress | null {
  if (!row.response_channel_type || !row.response_platform_id) return null;
  return {
    channelType: row.response_channel_type,
    platformId: row.response_platform_id,
    threadId: row.response_thread_id,
  };
}
