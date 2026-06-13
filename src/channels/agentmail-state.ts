import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import type { MessagingGroup } from '../types.js';
import type { AgentMailResolvedRoute } from './agentmail-config.js';

export type AgentMailMessageRouteInput = {
  inboxId: string;
  messageId: string;
  eventId: string | null;
  agentmailThreadId: string | null;
  nanoThreadId: string;
  messagingGroupId: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
};

export type AgentMailClaimResult =
  | { claimed: true; status: 'processing' }
  | { claimed: false; status: 'already-routed' | 'already-blocked' | 'active-lease' };

export type AgentMailReplyContext = {
  inbox_id: string;
  message_id: string;
  agentmail_thread_id: string | null;
  nano_thread_id: string | null;
};

export function claimAgentMailMessage(
  inboxId: string,
  messageId: string,
  now: string,
  leaseExpiresAt: string,
): AgentMailClaimResult {
  const claim = getDb().transaction((): AgentMailClaimResult => {
    const existing = getDb()
      .prepare(
        `SELECT status, lease_expires_at
           FROM agentmail_message_routes
          WHERE inbox_id = ? AND message_id = ?`,
      )
      .get(inboxId, messageId) as { status: string; lease_expires_at: string | null } | undefined;

    if (existing?.status === 'routed') return { claimed: false, status: 'already-routed' };
    if (existing?.status === 'blocked') return { claimed: false, status: 'already-blocked' };
    if (existing?.lease_expires_at && existing.lease_expires_at > now && existing.status === 'processing') {
      return { claimed: false, status: 'active-lease' };
    }

    getDb()
      .prepare(
        `INSERT INTO agentmail_message_routes (
           inbox_id, message_id, first_seen_at, claimed_at, lease_expires_at, attempts, status
         ) VALUES (?, ?, ?, ?, ?, 1, 'processing')
         ON CONFLICT(inbox_id, message_id) DO UPDATE SET
           claimed_at = excluded.claimed_at,
           lease_expires_at = excluded.lease_expires_at,
           attempts = agentmail_message_routes.attempts + 1,
           status = 'processing',
           last_error = NULL`,
      )
      .run(inboxId, messageId, now, now, leaseExpiresAt);

    return { claimed: true, status: 'processing' };
  }) as () => AgentMailClaimResult;
  return claim();
}

export function markAgentMailMessageBlocked(
  input: AgentMailMessageRouteInput & { blockedAt: string; reason: string },
): void {
  getDb()
    .prepare(
      `INSERT INTO agentmail_message_routes (
         inbox_id, message_id, event_id, agentmail_thread_id, nano_thread_id,
         messaging_group_id, sender_email, subject, received_at, first_seen_at,
         failed_at, attempts, status, last_error
       ) VALUES (
         @inboxId, @messageId, @eventId, @agentmailThreadId, @nanoThreadId,
         @messagingGroupId, @senderEmail, @subject, @receivedAt, @blockedAt,
         @blockedAt, 1, 'blocked', @reason
       )
       ON CONFLICT(inbox_id, message_id) DO UPDATE SET
         event_id = COALESCE(agentmail_message_routes.event_id, excluded.event_id),
         agentmail_thread_id = COALESCE(agentmail_message_routes.agentmail_thread_id, excluded.agentmail_thread_id),
         nano_thread_id = COALESCE(agentmail_message_routes.nano_thread_id, excluded.nano_thread_id),
         messaging_group_id = COALESCE(agentmail_message_routes.messaging_group_id, excluded.messaging_group_id),
         sender_email = COALESCE(agentmail_message_routes.sender_email, excluded.sender_email),
         subject = COALESCE(agentmail_message_routes.subject, excluded.subject),
         received_at = COALESCE(agentmail_message_routes.received_at, excluded.received_at),
         failed_at = CASE
           WHEN agentmail_message_routes.status = 'routed' THEN agentmail_message_routes.failed_at
           ELSE excluded.failed_at
         END,
         lease_expires_at = CASE
           WHEN agentmail_message_routes.status = 'routed' THEN agentmail_message_routes.lease_expires_at
           ELSE NULL
         END,
         status = CASE
           WHEN agentmail_message_routes.status = 'routed' THEN agentmail_message_routes.status
           ELSE 'blocked'
         END,
         last_error = CASE
           WHEN agentmail_message_routes.status = 'routed' THEN agentmail_message_routes.last_error
           ELSE excluded.last_error
         END`,
    )
    .run(input);
}

export function recordAgentMailMessageRoute(input: AgentMailMessageRouteInput): void {
  getDb()
    .prepare(
      `UPDATE agentmail_message_routes
          SET event_id = @eventId,
              agentmail_thread_id = @agentmailThreadId,
              nano_thread_id = @nanoThreadId,
              messaging_group_id = @messagingGroupId,
              sender_email = @senderEmail,
              subject = @subject,
              received_at = @receivedAt
        WHERE inbox_id = @inboxId AND message_id = @messageId`,
    )
    .run(input);
}

export function markAgentMailMessageRouted(inboxId: string, messageId: string, routedAt: string): void {
  getDb()
    .prepare(
      `UPDATE agentmail_message_routes
          SET status = 'routed',
              routed_at = ?,
              lease_expires_at = NULL,
              last_error = NULL
        WHERE inbox_id = ? AND message_id = ?`,
    )
    .run(routedAt, inboxId, messageId);
}

export function markAgentMailMessageFailed(inboxId: string, messageId: string, failedAt: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE agentmail_message_routes
          SET status = 'failed',
              failed_at = ?,
              lease_expires_at = NULL,
              last_error = ?
        WHERE inbox_id = ? AND message_id = ?`,
    )
    .run(failedAt, error.slice(0, 2000), inboxId, messageId);
}

export function isAgentMailMessageRouted(inboxId: string, messageId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM agentmail_message_routes
        WHERE inbox_id = ? AND message_id = ? AND status = 'routed'
        LIMIT 1`,
    )
    .get(inboxId, messageId);
  return Boolean(row);
}

export function isAgentMailMessageTerminal(inboxId: string, messageId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM agentmail_message_routes
        WHERE inbox_id = ? AND message_id = ? AND status IN ('routed', 'blocked')
        LIMIT 1`,
    )
    .get(inboxId, messageId);
  return Boolean(row);
}

export function findLatestAgentMailReplyContext(
  inboxId: string,
  nanoThreadId: string | null,
): AgentMailReplyContext | null {
  if (!nanoThreadId) return null;
  const row = getDb()
    .prepare(
      `SELECT inbox_id, message_id, agentmail_thread_id, nano_thread_id
         FROM agentmail_message_routes
        WHERE inbox_id = ? AND nano_thread_id = ? AND routed_at IS NOT NULL
     ORDER BY COALESCE(received_at, routed_at) DESC, routed_at DESC
        LIMIT 1`,
    )
    .get(inboxId, nanoThreadId) as AgentMailReplyContext | undefined;
  return row ?? null;
}

function createRouteMessagingGroup(route: AgentMailResolvedRoute, now: string): MessagingGroup {
  return {
    id: route.messagingGroupId,
    channel_type: 'agentmail',
    platform_id: route.inboxId,
    name: route.name,
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: now,
  };
}

export function reconcileAgentMailRoutes(routes: AgentMailResolvedRoute[], now: string): void {
  for (const route of routes) {
    const agentGroup = getAgentGroupByFolder(route.agentGroupFolder);
    if (!agentGroup) throw new Error(`AgentMail route ${route.localPart} targets missing agent group folder main`);

    const existing = getMessagingGroupByPlatform('agentmail', route.inboxId);
    if (!existing) {
      createMessagingGroup(createRouteMessagingGroup(route, now));
    } else {
      updateMessagingGroup(existing.id, {
        name: route.name,
        is_group: 1,
        unknown_sender_policy: 'public',
      });
    }

    const mg = getMessagingGroupByPlatform('agentmail', route.inboxId);
    if (!mg) throw new Error(`AgentMail route ${route.localPart} was not created`);
    const existingWiring = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
    if (existingWiring) continue;

    createMessagingGroupAgent({
      id: `mga-agentmail-${route.localPart}`,
      messaging_group_id: mg.id,
      agent_group_id: agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now,
    });
  }
}
