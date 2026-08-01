import { getSchedulerAlertFallbackRoute } from '../config.js';
import { getDb } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { withRuntimeLock, assertRuntimeLockOwner, type RuntimeLockOwner } from '../db/runtime-locks.js';
import { getSession } from '../db/sessions.js';
import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { logSchedulerEvent, type SchedulerLogSeverity } from '../modules/scheduling/log.js';

type SchedulerIncidentStatus = 'pending' | 'reported' | 'unroutable';
type SchedulerIncidentSeverity = SchedulerLogSeverity;

export interface SchedulerIncidentInput {
  dedupeKey: string;
  severity: SchedulerIncidentSeverity;
  message: string;
  agentGroupId?: string | null;
  seriesId?: string | null;
  sessionId?: string | null;
  messagingGroupId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
  details: Record<string, unknown>;
}

interface SchedulerIncidentRow {
  dedupe_key: string;
  severity: SchedulerIncidentSeverity;
  status: SchedulerIncidentStatus;
  agent_group_id: string | null;
  series_id: string | null;
  session_id: string | null;
  messaging_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  message: string;
  details_json: string;
  created_at: string;
  next_attempt_at: string | null;
  attempt_count: number;
}

interface AlertRoute {
  channelType: string;
  platformId: string;
  threadId: string | null;
  source: 'central-session' | 'owner-admin-dm' | 'legacy-row' | 'configured-fallback';
}

const LOCK_NAME = 'scheduler-mutator';

/** R3: the deduped-incident info line fired ~1000x/day during the dvora incident. */
const DEDUPE_LOG_INTERVAL_MS = Number(process.env.NANOCLAW_INCIDENT_DEDUPE_LOG_INTERVAL_MS) || 60 * 60 * 1000;
const dedupeLogState = new Map<string, { lastEmitMs: number; suppressed: number }>();

export function resetDedupeLogRateLimitForTest(): void {
  dedupeLogState.clear();
}

export async function reportSchedulerIncident(args: SchedulerIncidentInput): Promise<boolean> {
  return await withSchedulerMutation((owner) => recordSchedulerIncidentWithOwner(args, owner));
}

export function recordSchedulerIncidentWithOwner(args: SchedulerIncidentInput, owner: RuntimeLockOwner): boolean {
  if (owner.name !== LOCK_NAME) {
    throw new Error(`Scheduler incident writes require runtime lock "${LOCK_NAME}"`);
  }

  const now = new Date().toISOString();
  const inserted = getDb().transaction(() => {
    assertRuntimeLockOwner(owner);
    return getDb()
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
             @now,
             @now
           )`,
      )
      .run({
        id: `sched-inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dedupeKey: args.dedupeKey,
        severity: args.severity,
        agentGroupId: args.agentGroupId ?? null,
        seriesId: args.seriesId ?? null,
        sessionId: args.sessionId ?? null,
        messagingGroupId: args.messagingGroupId ?? null,
        channelType: args.channelType ?? null,
        platformId: args.platformId ?? null,
        threadId: args.threadId ?? null,
        message: args.message,
        detailsJson: JSON.stringify(args.details),
        now,
      });
  })();

  if (inserted.changes === 0) {
    const now = Date.now();
    const state = dedupeLogState.get(args.dedupeKey) ?? { lastEmitMs: 0, suppressed: 0 };
    if (now - state.lastEmitMs >= DEDUPE_LOG_INTERVAL_MS) {
      logSchedulerEvent('info', 'scheduler_incident_deduped', {
        dedupeKey: args.dedupeKey,
        suppressedSinceLastEmit: state.suppressed,
      });
      dedupeLogState.set(args.dedupeKey, { lastEmitMs: now, suppressed: 0 });
    } else {
      dedupeLogState.set(args.dedupeKey, { lastEmitMs: state.lastEmitMs, suppressed: state.suppressed + 1 });
    }
    return false;
  }

  logSchedulerEvent(args.severity, 'scheduler_incident_queued', {
    dedupeKey: args.dedupeKey,
    agentGroupId: args.agentGroupId ?? null,
    sessionId: args.sessionId ?? null,
    seriesId: args.seriesId ?? null,
  });
  return true;
}

export async function deliverDueSchedulerIncidents(now = new Date()): Promise<number> {
  const rows = getDb()
    .prepare(
      `SELECT dedupe_key
         FROM scheduler_incidents
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
        ORDER BY created_at ASC, dedupe_key ASC
        LIMIT 50`,
    )
    .all({ now: now.toISOString() }) as Array<{ dedupe_key: string }>;

  let delivered = 0;
  for (const row of rows) {
    if (await deliverPendingSchedulerIncident(row.dedupe_key)) delivered++;
  }
  return delivered;
}

export async function deliverPendingSchedulerIncident(dedupeKey: string): Promise<boolean> {
  const incident = getSchedulerIncident(dedupeKey);
  if (!incident || incident.status !== 'pending') return false;

  const route = chooseAlertRoute(incident);
  if (!route) {
    await markIncidentUnroutable(dedupeKey, 'No scheduler alert route is available');
    log.error('Scheduler incident could not be routed', { dedupeKey, message: incident.message });
    logSchedulerEvent('error', 'scheduler_incident_unroutable', { dedupeKey, message: incident.message });
    return false;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    await recordIncidentDeliveryFailure(dedupeKey, incident.attempt_count, 'Delivery adapter is not ready');
    log.warn('Scheduler incident delivery deferred because adapter is missing', {
      dedupeKey,
      routeSource: route.source,
    });
    return false;
  }

  try {
    await adapter.deliver(
      route.channelType,
      route.platformId,
      route.threadId,
      'chat',
      JSON.stringify({ text: incident.message }),
    );
    await markIncidentReported(dedupeKey);
    logSchedulerEvent('info', 'scheduler_incident_reported', { dedupeKey, routeSource: route.source });
    return true;
  } catch (err) {
    await recordIncidentDeliveryFailure(dedupeKey, incident.attempt_count, errorMessage(err));
    log.error('Scheduler incident delivery failed', { dedupeKey, routeSource: route.source, err });
    logSchedulerEvent('error', 'scheduler_incident_delivery_failed', {
      dedupeKey,
      routeSource: route.source,
      err: errorMessage(err),
    });
    return false;
  }
}

function getSchedulerIncident(dedupeKey: string): SchedulerIncidentRow | undefined {
  return getDb().prepare('SELECT * FROM scheduler_incidents WHERE dedupe_key = ?').get(dedupeKey) as
    | SchedulerIncidentRow
    | undefined;
}

function chooseAlertRoute(incident: SchedulerIncidentRow): AlertRoute | null {
  return (
    routeFromCentralSession(incident.session_id) ??
    routeFromOwnerAdminDm(incident.agent_group_id) ??
    routeFromLegacyIncidentFields(incident) ??
    routeFromConfiguredFallback()
  );
}

function routeFromCentralSession(sessionId: string | null): AlertRoute | null {
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session?.messaging_group_id) return null;
  const messagingGroup = getMessagingGroup(session.messaging_group_id);
  if (!messagingGroup || messagingGroup.channel_type === 'cli') return null;
  return {
    channelType: messagingGroup.channel_type,
    platformId: messagingGroup.platform_id,
    threadId: session.thread_id,
    source: 'central-session',
  };
}

function routeFromOwnerAdminDm(agentGroupId: string | null): AlertRoute | null {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.kind, ur.role, ur.agent_group_id
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
        WHERE ur.role IN ('owner', 'admin')
          AND (
            ur.role = 'owner'
            OR ur.agent_group_id IS NULL
            OR ur.agent_group_id IS @agentGroupId
          )
        ORDER BY
          CASE ur.role WHEN 'owner' THEN 0 ELSE 1 END,
          CASE WHEN ur.agent_group_id IS NULL THEN 0 ELSE 1 END,
          u.id ASC`,
    )
    .all({ agentGroupId }) as Array<{ id: string; kind: string; role: string; agent_group_id: string | null }>;

  for (const row of rows) {
    const handle = userHandle(row.id, row.kind);
    const messagingGroup = getDb()
      .prepare(
        `SELECT channel_type, platform_id
           FROM messaging_groups
          WHERE channel_type = @channelType
            AND is_group = 0
            AND platform_id IN (@userId, @handle)
          ORDER BY CASE platform_id WHEN @userId THEN 0 ELSE 1 END
          LIMIT 1`,
      )
      .get({ channelType: row.kind, userId: row.id, handle }) as
      | { channel_type: string; platform_id: string }
      | undefined;
    if (!messagingGroup || messagingGroup.channel_type === 'cli') continue;
    return {
      channelType: messagingGroup.channel_type,
      platformId: messagingGroup.platform_id,
      threadId: null,
      source: 'owner-admin-dm',
    };
  }

  return null;
}

function routeFromLegacyIncidentFields(incident: SchedulerIncidentRow): AlertRoute | null {
  if (!incident.channel_type || !incident.platform_id || incident.channel_type === 'cli') return null;
  return {
    channelType: incident.channel_type,
    platformId: incident.platform_id,
    threadId: incident.thread_id,
    source: 'legacy-row',
  };
}

function routeFromConfiguredFallback(): AlertRoute | null {
  const fallback = getSchedulerAlertFallbackRoute();
  if (!fallback.channelType || !fallback.platformId || fallback.channelType === 'cli') return null;
  return {
    channelType: fallback.channelType,
    platformId: fallback.platformId,
    threadId: fallback.threadId,
    source: 'configured-fallback',
  };
}

async function markIncidentReported(dedupeKey: string): Promise<void> {
  const now = new Date().toISOString();
  await withSchedulerMutation((owner) => {
    getDb().transaction(() => {
      assertRuntimeLockOwner(owner);
      getDb()
        .prepare(
          `UPDATE scheduler_incidents
                SET status = 'reported',
                    reported_at = @now,
                    last_attempt_at = @now,
                    last_error = NULL
              WHERE dedupe_key = @dedupeKey
                AND status = 'pending'`,
        )
        .run({ dedupeKey, now });
    })();
  });
}

async function markIncidentUnroutable(dedupeKey: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await withSchedulerMutation((owner) => {
    getDb().transaction(() => {
      assertRuntimeLockOwner(owner);
      getDb()
        .prepare(
          `UPDATE scheduler_incidents
                SET status = 'unroutable',
                    last_attempt_at = @now,
                    last_error = @reason
              WHERE dedupe_key = @dedupeKey
                AND status = 'pending'`,
        )
        .run({ dedupeKey, now, reason });
    })();
  });
}

async function recordIncidentDeliveryFailure(
  dedupeKey: string,
  previousAttemptCount: number,
  error: string,
): Promise<void> {
  const now = new Date().toISOString();
  const nextAttempt = new Date(
    Date.now() + Math.min(300_000, 10_000 * Math.max(1, previousAttemptCount + 1)),
  ).toISOString();
  await withSchedulerMutation((owner) => {
    getDb().transaction(() => {
      assertRuntimeLockOwner(owner);
      getDb()
        .prepare(
          `UPDATE scheduler_incidents
                SET status = 'pending',
                    attempt_count = attempt_count + 1,
                    last_attempt_at = @now,
                    next_attempt_at = @nextAttempt,
                    last_error = @error
              WHERE dedupe_key = @dedupeKey
                AND status = 'pending'`,
        )
        .run({ dedupeKey, now, nextAttempt, error });
    })();
  });
}

async function withSchedulerMutation<T>(fn: (owner: RuntimeLockOwner) => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await withRuntimeLock(LOCK_NAME, 120_000, fn);
    } catch (err) {
      if (!isSchedulerLockContention(err) || Date.now() >= deadline) throw err;
      await sleep(100);
    }
  }
}

function isSchedulerLockContention(err: unknown): boolean {
  return err instanceof Error && err.message.includes(`Runtime lock "${LOCK_NAME}" is already held`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function userHandle(userId: string, kind: string): string {
  const prefix = `${kind}:`;
  return userId.startsWith(prefix) ? userId.slice(prefix.length) : userId;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
