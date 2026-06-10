/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { getChannelAdapter } from './channels/channel-registry.js';
import { gateCommand } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { withRuntimeLock } from './db/runtime-locks.js';
import {
  findActiveNonNullSessionThreadIdsForAgent,
  findActiveSessionThreadIdEndingWithForAgent,
  findSessionForAgent,
  getSession,
} from './db/sessions.js';
import { deliverSessionMessages, getDeliveryAdapter, suppressSessionOutbound } from './delivery.js';
import { startTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from './types.js';
import type { InboundEvent } from './channels/adapter.js';
import { handleYenteHostCommand, parseYenteHostCommandFromContent } from './yente/host-commands.js';
import {
  markSchedulerResetOldOutboundSuppressed,
  markSchedulerResetResponseDelivered,
  recordSchedulerResetIncident,
  SchedulerResetError,
} from './yente/scheduler-reset.js';
import { RouteResetInProgressError } from './yente/scheduler-reset-repair.js';
import {
  getSchedulerSupersession,
  phaseAtLeast,
  recordSchedulerSupersessionError,
} from './yente/scheduler-supersessions.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam.
  const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: event.message.isGroup ? 1 : 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    agentCount = 0;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;
    const agentEvent = eventWithCanonicalThreadIdForExistingSession(agent.agent_group_id, mg, event);

    const engages = evaluateEngage(agent, messageText, isMention, mg, agentEvent.threadId);

    const accessOk = engages && (!accessGate || accessGate(agentEvent, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(agentEvent, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, agentEvent, userId, adapter?.supportsThreads === true, true);
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Threaded-adapter only; DMs and
      // non-threaded platforms skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.supportsThreads &&
        adapter.subscribe &&
        agentEvent.threadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(agentEvent.platformId, agentEvent.threadId).catch((err) => {
          log.warn('adapter.subscribe failed', {
            channelType: agentEvent.channelType,
            threadId: agentEvent.threadId,
            err,
          });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate') {
      await deliverToAgent(agent, agentGroup, mg, agentEvent, userId, adapter?.supportsThreads === true, false);
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

function eventWithCanonicalThreadIdForExistingSession(
  agentGroupId: string,
  mg: MessagingGroup,
  event: InboundEvent,
): InboundEvent {
  const threadId = canonicalThreadIdForExistingSession(agentGroupId, mg.id, event);
  if (!threadId || threadId === event.threadId) return event;
  log.info('Canonicalized inbound Discord thread id from existing session', {
    agentGroupId,
    messagingGroupId: mg.id,
    platformId: event.platformId,
    suppliedThreadId: event.threadId,
    canonicalThreadId: threadId,
  });
  return { ...event, threadId };
}

function canonicalThreadIdForExistingSession(
  agentGroupId: string,
  messagingGroupId: string,
  event: InboundEvent,
): string | null {
  if (event.channelType !== 'discord' || !event.threadId || event.threadId.startsWith('discord:')) {
    return null;
  }
  return (
    findActiveSessionThreadIdEndingWithForAgent(
      agentGroupId,
      messagingGroupId,
      `:${event.platformId}:${event.threadId}`,
    ) ?? null
  );
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
): Promise<void> {
  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  let agentEvent = event;
  if (effectiveSessionMode === 'per-thread') {
    const nullThreadReset = resolveDiscordNullThreadReset(agent.agent_group_id, mg, agentEvent);
    if (nullThreadReset.action === 'refuse') {
      const deliveryAddr = agentEvent.replyTo ?? {
        channelType: agentEvent.channelType,
        platformId: agentEvent.platformId,
        threadId: agentEvent.threadId,
      };
      await deliverHostText(deliveryAddr, nullThreadReset.message, 'discord-null-thread-reset-refused');
      log.warn('Refused ambiguous Discord null-thread reset command', {
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
        platformId: agentEvent.platformId,
        activeThreadIds: nullThreadReset.activeThreadIds,
      });
      return;
    }
    if (nullThreadReset.action === 'retarget') {
      log.info('Retargeted Discord null-thread reset command to sole active thread session', {
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
        platformId: agentEvent.platformId,
        threadId: nullThreadReset.threadId,
      });
      agentEvent = { ...agentEvent, threadId: nullThreadReset.threadId };
    }
  }

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event). When the caller supplied `replyTo` (CLI admin
  // transport acting on operator intent), the reply is redirected there.
  const deliveryAddr = agentEvent.replyTo ?? {
    channelType: agentEvent.channelType,
    platformId: agentEvent.platformId,
    threadId: agentEvent.threadId,
  };

  let session: Session;
  let created: boolean;
  try {
    ({ session, created } = resolveSession(agent.agent_group_id, mg.id, agentEvent.threadId, effectiveSessionMode));
  } catch (err) {
    if (err instanceof RouteResetInProgressError) {
      await deliverHostText(
        deliveryAddr,
        'Session reset is still finishing; I will be ready in a moment.',
        'route-reset-in-progress',
      );
      log.info('Refused to create competing session during scheduler-aware reset', {
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
        threadId: agentEvent.threadId,
      });
      return;
    }
    throw err;
  }

  if (agentEvent.message.kind === 'chat' || agentEvent.message.kind === 'chat-sdk') {
    let hostCommand;
    try {
      hostCommand = await handleYenteHostCommand({
        content: agentEvent.message.content,
        userId,
        agentGroup,
        messagingGroup: mg,
        session,
        sessionMode: effectiveSessionMode,
        responseAddress: deliveryAddr,
      });
    } catch (err) {
      if (err instanceof SchedulerResetError) {
        await deliverSchedulerResetFailure(err, deliveryAddr);
        return;
      }
      throw err;
    }
    if (hostCommand.handled) {
      if (hostCommand.deliveryMode === 'host-adapter') {
        await finishSchedulerAwareResetHostCommand(hostCommand, deliveryAddr);
        log.info('Yente host command handled', {
          command: hostCommand.command,
          sessionId: hostCommand.sessionForOutbound.id,
          supersededSessionId: hostCommand.supersededSessionId,
          agentGroupId: agent.agent_group_id,
          messagingGroupId: mg.id,
          platformId: deliveryAddr.platformId,
          threadId: deliveryAddr.threadId,
          userId,
        });
        return;
      }

      if (hostCommand.supersededSessionId && hostCommand.supersededSessionId !== hostCommand.sessionForOutbound.id) {
        await suppressSessionOutbound(
          hostCommand.supersededSessionId,
          `yente-session-${hostCommand.command}-before-success`,
        );
      }
      writeOutboundDirect(hostCommand.sessionForOutbound.agent_group_id, hostCommand.sessionForOutbound.id, {
        id: `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: hostCommand.outboundText }),
      });
      log.info('Yente host command handled', {
        command: hostCommand.command,
        sessionId: hostCommand.sessionForOutbound.id,
        supersededSessionId: hostCommand.supersededSessionId,
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
        platformId: deliveryAddr.platformId,
        threadId: deliveryAddr.threadId,
        userId,
      });
      const successDelivery = deliverSessionMessages(hostCommand.sessionForOutbound);
      await successDelivery;
      return;
    }
  }

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (agentEvent.message.kind === 'chat' || agentEvent.message.kind === 'chat-sdk') {
    const gate = gateCommand(agentEvent.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(agentEvent.message.id, agent.agent_group_id),
    kind: agentEvent.message.kind,
    timestamp: agentEvent.message.timestamp,
    platformId: deliveryAddr.platformId,
    platformMessageId: agentEvent.message.id || null,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: agentEvent.message.content,
    trigger: wake ? 1 : 0,
    // Host-stamped route identity from the resolved messaging group. Lets the
    // container normalizer collapse DM aliases safely and isolate distinct
    // group threads, without inferring from nullable thread ids.
    messagingGroupId: mg.id,
    isGroup: mg.is_group === 1 ? 1 : 0,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: agentEvent.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      agentEvent.channelType,
      agentEvent.platformId,
      agentEvent.threadId,
    );
    const freshSession = getSession(session.id);
    if (freshSession) {
      await wakeContainer(freshSession);
    }
  }
}

type DiscordNullThreadResetResolution =
  | { action: 'none' }
  | { action: 'retarget'; threadId: string }
  | { action: 'refuse'; message: string; activeThreadIds: string[] };

function resolveDiscordNullThreadReset(
  agentGroupId: string,
  mg: MessagingGroup,
  event: InboundEvent,
): DiscordNullThreadResetResolution {
  if (event.channelType !== 'discord' || event.threadId !== null || mg.is_group === 0) return { action: 'none' };
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return { action: 'none' };

  const command = parseYenteHostCommandFromContent(event.message.content);
  if (command !== 'new' && command !== 'clear') return { action: 'none' };

  const activeThreadIds = findActiveNonNullSessionThreadIdsForAgent(agentGroupId, mg.id);
  if (activeThreadIds.length === 0) return { action: 'none' };
  if (activeThreadIds.length === 1) return { action: 'retarget', threadId: activeThreadIds[0] };
  return {
    action: 'refuse',
    activeThreadIds,
    message:
      'Cannot reset a Discord per-thread session without a thread id because multiple active sessions exist for this channel. Send /new from the target thread or include the exact thread id.',
  };
}

async function finishSchedulerAwareResetHostCommand(
  hostCommand: Extract<Awaited<ReturnType<typeof handleYenteHostCommand>>, { handled: true }>,
  deliveryAddr: { channelType: string; platformId: string; threadId: string | null },
): Promise<void> {
  const oldSessionId = hostCommand.supersededSessionId;
  if (!oldSessionId) {
    await deliverHostText(deliveryAddr, hostCommand.outboundText, `yente-host-command-${hostCommand.command}`);
    return;
  }

  await withSchedulerMutatorLockForResetFinish(async () => {
    let row = getSchedulerSupersession(oldSessionId);
    if (!row || row.phase === 'response-delivered' || row.phase === 'failed') return;

    if (!phaseAtLeast(row.phase, 'old-outbound-suppressed')) {
      try {
        await suppressSessionOutbound(oldSessionId, `yente-session-${hostCommand.command}-post-reset`);
        markSchedulerResetOldOutboundSuppressed(oldSessionId);
      } catch (err) {
        recordSchedulerSupersessionError(oldSessionId, row.phase, err);
        const oldSession = getSession(oldSessionId);
        if (oldSession) {
          recordSchedulerResetIncident({
            oldSession,
            freshSessionId: hostCommand.sessionForOutbound.id,
            command: hostCommand.command,
            phase: 'old-outbound-suppressed',
            err,
          });
        }
        log.error('Failed to suppress old outbound after scheduler-aware reset', { oldSessionId, err });
        await deliverHostText(
          deliveryAddr,
          'Error: session reset finished but old output cleanup failed. I recorded it for repair.',
          `yente-host-command-${hostCommand.command}-suppression-failed`,
        ).catch((deliveryErr) => {
          log.error('Failed to deliver scheduler-aware reset suppression failure response', {
            oldSessionId,
            deliveryErr,
          });
        });
        return;
      }
      row = getSchedulerSupersession(oldSessionId);
      if (!row || row.phase === 'response-delivered' || row.phase === 'failed') return;
    }

    try {
      await deliverHostText(deliveryAddr, hostCommand.outboundText, `yente-host-command-${hostCommand.command}`);
      markSchedulerResetResponseDelivered(oldSessionId);
    } catch (err) {
      const oldSession = getSession(oldSessionId);
      if (oldSession) {
        recordSchedulerResetIncident({
          oldSession,
          freshSessionId: hostCommand.sessionForOutbound.id,
          command: hostCommand.command,
          phase: 'response-delivered',
          err,
        });
      }
      log.error('Failed to deliver scheduler-aware reset response', { oldSessionId, err });
    }
  });
}

async function withSchedulerMutatorLockForResetFinish<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await withRuntimeLock('scheduler-mutator', 120_000, fn);
    } catch (err) {
      if (!isSchedulerLockContention(err) || Date.now() >= deadline) {
        throw err;
      }
      await sleep(100);
    }
  }
}

function isSchedulerLockContention(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Runtime lock "scheduler-mutator" is already held');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverSchedulerResetFailure(
  err: SchedulerResetError,
  deliveryAddr: { channelType: string; platformId: string; threadId: string | null },
): Promise<void> {
  const text = err.oldSessionRemainsActive
    ? 'Error: session reset failed before scheduled jobs could be preserved. The old session remains active.'
    : 'Error: session reset hit a problem after the old session was disturbed. I recorded it for repair.';
  await deliverHostText(deliveryAddr, text, `yente-reset-failure-${err.phase}`).catch((deliveryErr) => {
    log.error('Failed to deliver scheduler-aware reset failure response', {
      oldSessionId: err.oldSessionId,
      freshSessionId: err.freshSessionId,
      phase: err.phase,
      deliveryErr,
    });
  });
}

async function deliverHostText(
  deliveryAddr: { channelType: string; platformId: string; threadId: string | null },
  text: string,
  reason: string,
): Promise<string | undefined> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    throw new Error(`Cannot deliver host response for ${reason}: delivery adapter is not ready`);
  }
  return await adapter.deliver(
    deliveryAddr.channelType,
    deliveryAddr.platformId,
    deliveryAddr.threadId,
    'chat',
    JSON.stringify({ text }),
  );
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
