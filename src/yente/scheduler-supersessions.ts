import { getDb, hasTable } from '../db/connection.js';
import type { Session } from '../types.js';

export type SchedulerSessionMode = 'shared' | 'per-thread' | 'agent-shared';

export interface SchedulerResetResponseAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type SchedulerSupersessionPhase =
  | 'started'
  | 'old-resetting'
  | 'old-stopped'
  | 'actions-drained'
  | 'old-synced'
  | 'fresh-created'
  | 'fresh-projecting'
  | 'fresh-projected'
  | 'old-archived'
  | 'fresh-activated'
  | 'old-outbound-suppressed'
  | 'response-delivered'
  | 'failed';

export interface SchedulerSupersessionRow {
  old_session_id: string;
  new_session_id: string | null;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  session_mode: SchedulerSessionMode;
  response_channel_type: string | null;
  response_platform_id: string | null;
  response_thread_id: string | null;
  phase: SchedulerSupersessionPhase;
  command: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  error_json: string | null;
}

export interface SupersessionPhaseInput {
  oldSession: Pick<Session, 'id' | 'agent_group_id' | 'messaging_group_id' | 'thread_id'>;
  freshSessionId: string | null;
  command: string;
  sessionMode: SchedulerSessionMode;
  phase: SchedulerSupersessionPhase;
  responseAddress?: SchedulerResetResponseAddress | null;
  error?: unknown;
}

export class RouteResetInProgressError extends Error {
  constructor(
    public readonly agentGroupId: string,
    public readonly messagingGroupId: string | null,
    public readonly threadId: string | null,
  ) {
    super('Session reset is still in progress for this route');
    this.name = 'RouteResetInProgressError';
  }
}

export function recordSchedulerSupersessionPhase(input: SupersessionPhaseInput): void {
  recordSchedulerSupersessionPhaseInDb(input);
}

export function recordSchedulerSupersessionPhaseInDb(input: SupersessionPhaseInput): void {
  if (!hasTable(getDb(), 'scheduler_session_supersessions')) return;
  const now = new Date().toISOString();
  getDb().transaction(() => {
    const existing = getSchedulerSupersession(input.oldSession.id);
    const restartingFailedSupersession = existing?.phase === 'failed' && input.phase === 'started';
    const phase = restartingFailedSupersession ? input.phase : nextSupersessionPhase(existing?.phase, input.phase);
    const phaseAdvanced = existing === undefined || phase !== existing.phase;
    const finishedAt = terminalPhase(phase) ? existing?.finished_at ?? now : null;
    const errorJson =
      input.error === undefined
        ? phaseAdvanced
          ? null
          : existing?.error_json ?? null
        : JSON.stringify(errorDetails(input.error));

    getDb()
      .prepare(
        `INSERT INTO scheduler_session_supersessions (
           old_session_id,
           new_session_id,
           agent_group_id,
           messaging_group_id,
           thread_id,
           session_mode,
           response_channel_type,
           response_platform_id,
           response_thread_id,
           phase,
           command,
           started_at,
           updated_at,
           finished_at,
           error_json
         ) VALUES (
           @oldSessionId,
           @freshSessionId,
           @agentGroupId,
           @messagingGroupId,
           @threadId,
           @sessionMode,
           @responseChannelType,
           @responsePlatformId,
           @responseThreadId,
           @phase,
           @command,
           @now,
           @now,
           @finishedAt,
           @errorJson
         )
         ON CONFLICT(old_session_id) DO UPDATE SET
           new_session_id = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.new_session_id
             ELSE COALESCE(excluded.new_session_id, scheduler_session_supersessions.new_session_id)
           END,
           started_at = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.started_at
             ELSE scheduler_session_supersessions.started_at
           END,
           phase = excluded.phase,
           command = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.command
             ELSE scheduler_session_supersessions.command
           END,
           session_mode = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.session_mode
             ELSE scheduler_session_supersessions.session_mode
           END,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at,
           response_channel_type = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.response_channel_type
             ELSE COALESCE(excluded.response_channel_type, scheduler_session_supersessions.response_channel_type)
           END,
           response_platform_id = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.response_platform_id
             ELSE COALESCE(excluded.response_platform_id, scheduler_session_supersessions.response_platform_id)
           END,
           response_thread_id = CASE
             WHEN @restartingFailedSupersession = 1 THEN excluded.response_thread_id
             ELSE COALESCE(excluded.response_thread_id, scheduler_session_supersessions.response_thread_id)
           END,
           error_json = excluded.error_json`,
      )
      .run({
        oldSessionId: input.oldSession.id,
        freshSessionId: input.freshSessionId,
        agentGroupId: input.oldSession.agent_group_id,
        messagingGroupId: routeMessagingGroupId(input.oldSession.messaging_group_id, input.sessionMode),
        threadId: routeThreadId(input.oldSession.thread_id, input.sessionMode),
        sessionMode: input.sessionMode,
        responseChannelType: input.responseAddress?.channelType ?? null,
        responsePlatformId: input.responseAddress?.platformId ?? null,
        responseThreadId: input.responseAddress?.threadId ?? null,
        phase,
        command: input.command,
        now,
        finishedAt,
        errorJson,
        restartingFailedSupersession: restartingFailedSupersession ? 1 : 0,
      });
  })();
}

export function recordSchedulerSupersessionError(
  oldSessionId: string,
  phase: SchedulerSupersessionPhase,
  error: unknown,
): void {
  if (!hasTable(getDb(), 'scheduler_session_supersessions')) return;
  const existing = getSchedulerSupersession(oldSessionId);
  const nextPhase = nextSupersessionPhase(existing?.phase, phase);
  getDb()
    .prepare(
      `UPDATE scheduler_session_supersessions
          SET phase = @phase,
              updated_at = @updatedAt,
              error_json = @errorJson
        WHERE old_session_id = @oldSessionId`,
    )
    .run({
      oldSessionId,
      phase: nextPhase,
      updatedAt: new Date().toISOString(),
      errorJson: JSON.stringify(errorDetails(error)),
    });
}

export function getSchedulerSupersession(oldSessionId: string): SchedulerSupersessionRow | undefined {
  if (!hasTable(getDb(), 'scheduler_session_supersessions')) return undefined;
  return getDb()
    .prepare('SELECT * FROM scheduler_session_supersessions WHERE old_session_id = ?')
    .get(oldSessionId) as SchedulerSupersessionRow | undefined;
}

export function listUnfinishedSchedulerSupersessions(): SchedulerSupersessionRow[] {
  if (!hasTable(getDb(), 'scheduler_session_supersessions')) return [];
  return getDb()
    .prepare(
      `SELECT * FROM scheduler_session_supersessions
       WHERE phase NOT IN ('response-delivered', 'failed')
       ORDER BY started_at ASC, old_session_id ASC`,
    )
    .all() as SchedulerSupersessionRow[];
}

export function isRouteResetInProgress(args: {
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  sessionMode: SchedulerSessionMode;
}): boolean {
  if (!hasTable(getDb(), 'scheduler_session_supersessions')) return false;
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok
         FROM scheduler_session_supersessions
        WHERE agent_group_id = @agentGroupId
          AND (messaging_group_id IS @messagingGroupId)
          AND (thread_id IS @threadId)
          AND phase NOT IN ('response-delivered', 'failed')
        LIMIT 1`,
    )
    .get({
      agentGroupId: args.agentGroupId,
      messagingGroupId: routeMessagingGroupId(args.messagingGroupId, args.sessionMode),
      threadId: routeThreadId(args.threadId, args.sessionMode),
    }) as { ok: number } | undefined;
  return row !== undefined;
}

export function assertNoRouteResetInProgress(args: {
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  sessionMode: SchedulerSessionMode;
}): void {
  if (!isRouteResetInProgress(args)) return;
  throw new RouteResetInProgressError(
    args.agentGroupId,
    routeMessagingGroupId(args.messagingGroupId, args.sessionMode),
    routeThreadId(args.threadId, args.sessionMode),
  );
}

export function terminalPhase(phase: SchedulerSupersessionPhase): boolean {
  return phase === 'response-delivered' || phase === 'failed';
}

export function phaseIndex(phase: SchedulerSupersessionPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export function phaseAtLeast(current: SchedulerSupersessionPhase, target: SchedulerSupersessionPhase): boolean {
  return phaseIndex(current) >= phaseIndex(target);
}

function nextSupersessionPhase(
  current: SchedulerSupersessionPhase | undefined,
  candidate: SchedulerSupersessionPhase,
): SchedulerSupersessionPhase {
  if (!current) return candidate;
  if (terminalPhase(current)) return current;
  if (candidate === 'failed') return candidate;
  return phaseAtLeast(candidate, current) ? candidate : current;
}

function routeMessagingGroupId(messagingGroupId: string | null, sessionMode: SchedulerSessionMode): string | null {
  return sessionMode === 'agent-shared' ? null : messagingGroupId;
}

function routeThreadId(threadId: string | null, sessionMode: SchedulerSessionMode): string | null {
  return sessionMode === 'per-thread' ? threadId : null;
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

const PHASE_ORDER: SchedulerSupersessionPhase[] = [
  'started',
  'old-resetting',
  'old-stopped',
  'actions-drained',
  'old-synced',
  'fresh-created',
  'fresh-projecting',
  'fresh-projected',
  'old-archived',
  'fresh-activated',
  'old-outbound-suppressed',
  'response-delivered',
  'failed',
];
