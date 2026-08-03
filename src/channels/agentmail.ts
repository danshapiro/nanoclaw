import { NANOCLAW_ROOT } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import {
  createAgentMailApi,
  isAgentMailQuotaOrRateLimitError,
  normalizeMessageEvent,
  type AgentMailApi,
  type AgentMailSocketLike,
} from './agentmail-api.js';
import {
  agentMailSenderAuthPoliciesFromEnv,
  agentMailTrustedAuthServersFromEnv,
  agentMailEventTypesFromEnv,
  buildAgentMailInboundContent,
  catchupMaxPagesFromEnv,
  catchupPageLimitFromEnv,
  DEFAULT_AGENTMAIL_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENTMAIL_CATCHUP_INTERVAL_MS,
  DEFAULT_AGENTMAIL_ROUTE_LEASE_MS,
  defaultAgentMailRouteFile,
  evaluateAgentMailSenderAuthPolicy,
  nanoThreadIdForAgentMailMessage,
  readAgentMailRouteFile,
  resolveAgentMailRoutes,
  senderEmailForAgentMailMessage,
  type AgentMailMessageLike,
} from './agentmail-config.js';
import {
  claimAgentMailMessage,
  findLatestAgentMailReplyContext,
  isAgentMailMessageTerminal,
  markAgentMailMessageFailed,
  markAgentMailMessageBlocked,
  markAgentMailMessageSuppressed,
  markAgentMailMessageRouted,
  reconcileAgentMailRoutes,
  recordAgentMailMessageRoute,
} from './agentmail-state.js';
import { ensureAgentMailOneCliEnv } from './agentmail-onecli.js';
import { registerChannelAdapter } from './channel-registry.js';

type AgentMailAdapterDeps = {
  api?: AgentMailApi;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
};

export function createAgentMailAdapter(deps: AgentMailAdapterDeps = {}): ChannelAdapter | null {
  const env = deps.env ?? process.env;
  if (env.AGENTMAIL_ENABLED !== '1') return null;

  const apiKey = env.AGENTMAIL_API_KEY?.trim();
  if (apiKey) throw new Error('AGENTMAIL_API_KEY must live in OneCLI, not NanoClaw env');
  if (!deps.api) requireAgentMailOneCliProxyEnv(env);

  const routePath = env.AGENTMAIL_ROUTES_PATH || `${env.NANOCLAW_ROOT || NANOCLAW_ROOT}/agentmail-routes.json`;
  const routeFile =
    deps.api && !env.AGENTMAIL_ROUTES_PATH ? defaultAgentMailRouteFile() : readAgentMailRouteFile(routePath);
  const routes = resolveAgentMailRoutes(routeFile, env);
  const routesByInbox = new Map(routes.map((route) => [route.inboxId, route]));
  const api = deps.api ?? createAgentMailApi({ mode: 'onecli' });
  const now = deps.now ?? (() => new Date().toISOString());
  const catchupPageLimit = catchupPageLimitFromEnv(env);
  const catchupMaxPages = catchupMaxPagesFromEnv(env);
  const eventTypes = agentMailEventTypesFromEnv(env);
  const routeLeaseMs = positiveIntegerEnv(env, 'AGENTMAIL_ROUTE_LEASE_MS', DEFAULT_AGENTMAIL_ROUTE_LEASE_MS);
  const senderAuthPolicies = agentMailSenderAuthPoliciesFromEnv(env);
  const trustedAuthServers = agentMailTrustedAuthServersFromEnv(env);
  const catchupIntervalMs = positiveIntegerEnv(
    env,
    'AGENTMAIL_CATCHUP_INTERVAL_MS',
    DEFAULT_AGENTMAIL_CATCHUP_INTERVAL_MS,
  );
  const attachmentMaxBytes = positiveIntegerEnv(
    env,
    'AGENTMAIL_ATTACHMENT_MAX_BYTES',
    DEFAULT_AGENTMAIL_ATTACHMENT_MAX_BYTES,
  );

  let setup: ChannelSetup | null = null;
  let socket: AgentMailSocketLike | null = null;
  let catchupTimer: NodeJS.Timeout | null = null;
  const routeQueues = new Map<string, Promise<void>>();
  let connected = false;
  let subscribed = false;

  function enqueueRouteMessage(message: AgentMailMessageLike, source: 'websocket' | 'catchup'): Promise<void> {
    const key = `${message.inboxId}:${message.threadId ?? message.messageId}`;
    const previous = routeQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => routeMessage(message, source))
      .finally(() => {
        if (routeQueues.get(key) === next) routeQueues.delete(key);
      });
    routeQueues.set(key, next);
    return next;
  }

  async function routeMessage(message: AgentMailMessageLike, source: 'websocket' | 'catchup'): Promise<void> {
    const route = routesByInbox.get(message.inboxId);
    if (!route) {
      log.warn('AgentMail message ignored for unconfigured inbox', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        source,
      });
      return;
    }

    if (isAgentMailMessageTerminal(message.inboxId, message.messageId)) {
      log.debug('AgentMail message already terminal', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        source,
      });
      return;
    }

    const suppressionReason = shouldSuppressAgentMailMessage(message);
    if (suppressionReason) {
      const suppressedAt = now();
      markAgentMailMessageSuppressed({
        inboxId: message.inboxId,
        messageId: message.messageId,
        eventId: message.eventId ?? null,
        agentmailThreadId: message.threadId ?? null,
        nanoThreadId: nanoThreadIdForAgentMailMessage(route, message),
        messagingGroupId: route.messagingGroupId,
        senderEmail: senderEmailForAgentMailMessage(message),
        subject: message.subject ?? '',
        receivedAt: message.timestamp ?? message.receivedAt ?? message.createdAt ?? suppressedAt,
        suppressedAt,
        reason: suppressionReason,
      });
      log.info('AgentMail message suppressed before routing', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        source,
        reason: suppressionReason,
      });
      return;
    }

    const senderEmail = senderEmailForAgentMailMessage(message);
    const senderAuthPolicy = senderAuthPolicies.get(senderEmail);
    if (!senderAuthPolicy) {
      const blockedAt = now();
      const nanoThreadId = nanoThreadIdForAgentMailMessage(route, message);
      const reason = `sender_not_greenlisted:${senderEmail}`;
      markAgentMailMessageBlocked({
        inboxId: message.inboxId,
        messageId: message.messageId,
        eventId: message.eventId ?? null,
        agentmailThreadId: message.threadId ?? null,
        nanoThreadId,
        messagingGroupId: route.messagingGroupId,
        senderEmail,
        subject: message.subject ?? '',
        receivedAt: message.timestamp ?? message.receivedAt ?? message.createdAt ?? blockedAt,
        blockedAt,
        reason,
      });
      log.warn('AgentMail message blocked by sender greenlist', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        senderEmail,
        source,
      });
      try {
        await api.updateLabels(message.inboxId, message.messageId, {
          add: ['nanoclaw:blocked-sender'],
          remove: ['unread'],
        });
      } catch (err) {
        log.warn('AgentMail label update failed after sender-greenlist block', {
          inboxId: message.inboxId,
          messageId: message.messageId,
          err,
        });
      }
      return;
    }

    const authEvaluation = evaluateAgentMailSenderAuthPolicy(
      message,
      senderEmail,
      senderAuthPolicy,
      trustedAuthServers,
    );
    if (!authEvaluation.allowed) {
      const blockedAt = now();
      const nanoThreadId = nanoThreadIdForAgentMailMessage(route, message);
      markAgentMailMessageBlocked({
        inboxId: message.inboxId,
        messageId: message.messageId,
        eventId: message.eventId ?? null,
        agentmailThreadId: message.threadId ?? null,
        nanoThreadId,
        messagingGroupId: route.messagingGroupId,
        senderEmail,
        subject: message.subject ?? '',
        receivedAt: message.timestamp ?? message.receivedAt ?? message.createdAt ?? blockedAt,
        blockedAt,
        reason: authEvaluation.reason,
      });
      log.warn('AgentMail message blocked by sender authentication policy', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        senderEmail,
        source,
        authservId: authEvaluation.authservId,
        detail: authEvaluation.detail,
      });
      try {
        await api.updateLabels(message.inboxId, message.messageId, {
          add: ['nanoclaw:blocked-auth'],
          remove: ['unread'],
        });
      } catch (err) {
        log.warn('AgentMail label update failed after sender-auth block', {
          inboxId: message.inboxId,
          messageId: message.messageId,
          err,
        });
      }
      return;
    }

    const claimedAt = now();
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + routeLeaseMs).toISOString();
    const claim = claimAgentMailMessage(message.inboxId, message.messageId, claimedAt, leaseExpiresAt);
    if (!claim.claimed) {
      log.debug('AgentMail message not claimable', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        source,
        status: claim.status,
      });
      return;
    }

    const nanoThreadId = nanoThreadIdForAgentMailMessage(route, message);
    try {
      const routedMessage = await withDownloadedAttachments(message);
      recordAgentMailMessageRoute({
        inboxId: routedMessage.inboxId,
        messageId: routedMessage.messageId,
        eventId: routedMessage.eventId ?? null,
        agentmailThreadId: routedMessage.threadId ?? null,
        nanoThreadId,
        messagingGroupId: route.messagingGroupId,
        senderEmail: senderEmailForAgentMailMessage(routedMessage),
        subject: routedMessage.subject ?? '',
        receivedAt: routedMessage.timestamp ?? routedMessage.receivedAt ?? routedMessage.createdAt ?? claimedAt,
      });

      const routeInboundToNanoClaw = setup?.onInboundStrict ?? setup?.onInbound;
      await routeInboundToNanoClaw?.(routedMessage.inboxId, nanoThreadId, {
        id: `agentmail:${routedMessage.inboxId}:${routedMessage.messageId}`,
        kind: 'chat',
        content: buildAgentMailInboundContent(route, routedMessage),
        timestamp: routedMessage.timestamp ?? routedMessage.receivedAt ?? routedMessage.createdAt ?? claimedAt,
        isGroup: true,
      });

      markAgentMailMessageRouted(message.inboxId, message.messageId, now());
    } catch (err) {
      markAgentMailMessageFailed(message.inboxId, message.messageId, now(), errorMessage(err));
      throw err;
    }

    try {
      await api.updateLabels(message.inboxId, message.messageId, { add: ['nanoclaw:routed'], remove: ['unread'] });
    } catch (err) {
      log.warn('AgentMail label update failed after successful routing', {
        inboxId: message.inboxId,
        messageId: message.messageId,
        err,
      });
    }
  }

  async function withDownloadedAttachments(message: AgentMailMessageLike): Promise<AgentMailMessageLike> {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) return message;
    const attachments = [];
    for (const item of message.attachments) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const attachmentId =
        typeof record.id === 'string'
          ? record.id
          : typeof record.attachmentId === 'string'
            ? record.attachmentId
            : null;
      if (!attachmentId) continue;
      const downloaded = await api.downloadAttachment({
        inboxId: message.inboxId,
        messageId: message.messageId,
        attachmentId,
        maxBytes: attachmentMaxBytes,
      });
      attachments.push({
        id: downloaded.attachmentId,
        filename: downloaded.filename,
        contentType: downloaded.contentType,
        data: downloaded.data.toString('base64'),
      });
    }
    return attachments.length ? { ...message, attachments } : message;
  }

  async function catchUp(): Promise<void> {
    for (const route of routes) {
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < catchupMaxPages; page += 1) {
          const result = await api.listMessages(route.inboxId, {
            limit: catchupPageLimit,
            pageToken,
            includeUnauthenticated: eventTypes.includes('message.received.unauthenticated'),
          });
          for (const item of [...result.messages].reverse()) {
            try {
              if (isAgentMailMessageTerminal(route.inboxId, item.messageId)) continue;
              const fullMessage = await Promise.resolve(api.getMessage(route.inboxId, item.messageId)).catch(
                () => item,
              );
              await enqueueRouteMessage(fullMessage, 'catchup');
            } catch (err) {
              log.warn('AgentMail catch-up message failed', { inboxId: route.inboxId, messageId: item.messageId, err });
            }
          }
          pageToken = result.nextPageToken;
          if (!pageToken) break;
        }
      } catch (err) {
        log.warn('AgentMail catch-up inbox failed', { inboxId: route.inboxId, err });
      }
    }
  }

  function scheduleCatchUp(): void {
    if (catchupTimer || catchupIntervalMs <= 0) return;
    catchupTimer = setInterval(() => {
      void catchUp().catch((err) => log.warn('AgentMail periodic catch-up failed', { err }));
    }, catchupIntervalMs);
    catchupTimer.unref?.();
  }

  function shouldSuppressAgentMailMessage(message: AgentMailMessageLike): string | null {
    const labels = new Set((message.labels ?? []).map((label) => label.toLowerCase()));
    if (labels.has('nanoclaw:outbound')) return 'label:nanoclaw:outbound';
    if (labels.has('sent')) return 'label:sent';

    const headers = Object.fromEntries(
      Object.entries(message.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value.join(',') : String(value ?? ''),
      ]),
    );
    const autoSubmitted = headers['auto-submitted']?.trim().toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') return 'header:auto-submitted';
    if (headers['x-nanoclaw-outbound'] === '1') return 'header:x-nanoclaw-outbound';
    if (/^(bulk|junk|list)$/i.test(headers.precedence ?? '')) return 'header:precedence';

    const sender = senderEmailForAgentMailMessage(message).toLowerCase();
    if (sender.includes('mailer-daemon')) return 'sender:mailer-daemon';
    if (sender.includes('postmaster')) return 'sender:postmaster';
    return null;
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function positiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
    const raw = env[key]?.trim();
    if (!raw) return defaultValue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
    return parsed;
  }

  return {
    name: 'agentmail',
    channelType: 'agentmail',
    supportsThreads: true,

    async setup(config) {
      setup = config;
      reconcileAgentMailRoutes(routes, now());
      socket = await api.connectWebSocket();
      const subscribeOnce = () => {
        if (subscribed) return;
        subscribed = true;
        connected = true;
        socket?.sendSubscribe({
          type: 'subscribe',
          inboxIds: routes.map((route) => route.inboxId),
          eventTypes,
        });
        log.info('AgentMail WebSocket subscribe sent', { inboxCount: routes.length, eventTypes });
      };
      socket.on('open', subscribeOnce);
      const openWait = socket.waitForOpen?.();
      if (openWait) {
        void openWait.then(subscribeOnce).catch((err) => log.warn('AgentMail WebSocket waitForOpen failed', { err }));
      }
      socket.on('message', (event) => {
        if (event && typeof event === 'object' && (event as Record<string, unknown>).type === 'subscribed') {
          void catchUp()
            .then(scheduleCatchUp)
            .catch((err) => log.warn('AgentMail initial catch-up failed', { err }));
          return;
        }
        const message = normalizeMessageEvent(event);
        if (!message) return;
        void (async () => {
          const fullMessage =
            (await Promise.resolve(api.getMessage(message.inboxId, message.messageId)).catch((err) => {
              log.warn('AgentMail live full-message fetch failed; falling back to event payload', {
                inboxId: message.inboxId,
                messageId: message.messageId,
                err,
              });
              return null;
            })) ?? message;
          await enqueueRouteMessage(fullMessage, 'websocket');
        })().catch((err) => {
          log.error('AgentMail inbound route failed', { inboxId: message.inboxId, messageId: message.messageId, err });
        });
      });
      socket.on('close', (event) => {
        connected = false;
        subscribed = false;
        log.warn('AgentMail WebSocket closed', {
          code: typeof event.code === 'number' ? event.code : 'none',
          reason: event.reason ? event.reason : 'none',
        });
      });
      socket.on('error', (err) => {
        log.error('AgentMail WebSocket error', { err });
      });
    },

    async teardown() {
      connected = false;
      subscribed = false;
      if (catchupTimer) clearInterval(catchupTimer);
      catchupTimer = null;
      socket?.close();
      socket = null;
      setup = null;
    },

    isConnected() {
      return connected;
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const route = routesByInbox.get(platformId);
      if (!route) throw new Error(`AgentMail delivery platform is not configured: ${platformId}`);
      const context = findLatestAgentMailReplyContext(route.inboxId, threadId);
      if (!context) throw new Error(`No AgentMail reply context for ${platformId} ${threadId ?? '(no thread)'}`);

      const content =
        message.content && typeof message.content === 'object' ? (message.content as Record<string, unknown>) : {};
      const text =
        typeof content.text === 'string'
          ? content.text
          : typeof content.message === 'string'
            ? content.message
            : String(message.content ?? '');
      const html = typeof content.html === 'string' ? content.html : undefined;
      const oversized = message.files?.find((file) => file.data.byteLength > attachmentMaxBytes);
      if (oversized)
        throw new Error(`AgentMail outbound attachment exceeds ${attachmentMaxBytes} bytes: ${oversized.filename}`);
      const attachments = message.files?.map((file) => ({
        filename: file.filename,
        content: file.data.toString('base64'),
      }));

      try {
        const sent = await api.replyToMessage(route.inboxId, context.message_id, {
          text,
          ...(html ? { html } : {}),
          ...(attachments?.length ? { attachments } : {}),
          labels: ['nanoclaw:outbound'],
          headers: { 'Auto-Submitted': 'auto-generated', 'X-NanoClaw-Outbound': '1' },
        });
        return sent.messageId ?? sent.message_id;
      } catch (err) {
        const logFields = {
          inboxId: route.inboxId,
          nanoThreadId: threadId,
          providerMessageId: context.message_id,
          quotaOrRateLimit: isAgentMailQuotaOrRateLimitError(err),
          err,
        };
        if (isAgentMailQuotaOrRateLimitError(err)) {
          log.warn('AgentMail delivery failed due to provider quota or rate limit', logFields);
        } else {
          log.error('AgentMail delivery failed', logFields);
        }
        throw err;
      }
    },
  };
}

/**
 * Registration factory: acquire the OneCLI proxy env if it's missing, then
 * build the adapter. NODE_EXTRA_CA_CERTS and NODE_USE_ENV_PROXY are
 * startup-only Node options — a process that booted without them cannot
 * apply them at runtime (validated; an in-process undici/ws re-injection
 * alternative was proven possible and deliberately rejected — see the
 * Task 4 rationale in the plan) — so a successful LATE acquisition exits(1)
 * deliberately: systemd (Restart=on-failure, RestartSec=5 — verified active
 * on the live host) relaunches
 * nanoclaw through start.sh, whose env eval now succeeds against the
 * healthy network. This is the missing self-termination path from the
 * 2026-08-02 incident. Preflight shape is unchanged: on acquisition
 * failure, createAgentMailAdapter throws its usual errors and the
 * channel-registry startup retry re-runs this whole factory.
 */
export async function agentMailChannelFactory(
  deps: {
    env?: NodeJS.ProcessEnv;
    ensureEnv?: typeof ensureAgentMailOneCliEnv;
    exit?: (code: number) => void;
    createAdapter?: typeof createAgentMailAdapter;
  } = {},
): Promise<ChannelAdapter | null> {
  const env = deps.env ?? process.env;
  const ensureEnv = deps.ensureEnv ?? ensureAgentMailOneCliEnv;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const createAdapter = deps.createAdapter ?? createAgentMailAdapter;

  const result = await ensureEnv(env);
  if (result === 'acquired' && env.AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE !== '0') {
    log.fatal(
      'AgentMail OneCLI env acquired after boot; exiting so systemd restarts nanoclaw with NODE_EXTRA_CA_CERTS/NODE_USE_ENV_PROXY applied',
    );
    exit(1);
  }
  return createAdapter(deps.env ? { env } : {});
}

registerChannelAdapter('agentmail', { factory: () => agentMailChannelFactory() });

function requireAgentMailOneCliProxyEnv(env: NodeJS.ProcessEnv): void {
  const proxy = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim();
  if (!proxy) {
    throw new Error('AgentMail requires OneCLI proxy env when AGENTMAIL_ENABLED=1');
  }
  if (env.NODE_USE_ENV_PROXY !== '1') {
    throw new Error('AgentMail requires NODE_USE_ENV_PROXY=1 when AGENTMAIL_ENABLED=1');
  }
  if (!env.NODE_EXTRA_CA_CERTS?.trim()) {
    throw new Error('AgentMail requires NODE_EXTRA_CA_CERTS from OneCLI when AGENTMAIL_ENABLED=1');
  }
}
