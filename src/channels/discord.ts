/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { getDb, hasTable, isDbInitialized } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveDiscordStartupConfig } from './discord-commands.js';
import { startupRetryConfigFromEnv } from './startup-retry.js';
import {
  advanceDiscordChannelCursor,
  claimDiscordMessage,
  markDiscordMessageFailed,
  markDiscordMessageRouted,
} from './discord-state.js';
import {
  createDiscordCatchup,
  DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
  discordCatchupConfigFromEnv,
  type DiscordCatchup,
} from './discord-catchup.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_MESSAGE_TEXT_LIMIT = 2000;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_HTTP_URL = /<?https?:\/\/[^\s<>()\]]+>?/g;
type DiscordAdapterInstance = ReturnType<typeof createDiscordAdapter>;
type NormalizeStats = { urlLabeledLinks: number; bareUrls: number };
type TextSegment = { content: string; isProtected: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: async () => {
    const env = readEnvFile([
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_APPLICATION_ID',
      'DISCORD_AUTO_CREATE_THREAD_CHANNEL_IDS',
      'DISCORD_CATCHUP_DISABLED',
      'DISCORD_CATCHUP_INTERVAL_MS',
      'DISCORD_CATCHUP_READY_DEBOUNCE_MS',
      'DISCORD_CATCHUP_MAX_MESSAGES',
      'DISCORD_CATCHUP_MAX_AGE_MS',
      'DISCORD_CATCHUP_ROUTE_LEASE_MS',
      'DISCORD_CATCHUP_MAX_THREADS',
      'DISCORD_COMMAND_SYNC_RETRY_DISABLED',
      'DISCORD_COMMAND_SYNC_RETRY_DELAYS_MS',
      'DISCORD_COMMAND_SYNC_RETRY_CAP_MS',
      'DISCORD_COMMAND_SYNC_RETRY_JITTER',
    ]);
    const botToken = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
    if (!botToken) return null;
    const autoCreateThreadChannelIds = new Set(
      (process.env.DISCORD_AUTO_CREATE_THREAD_CHANNEL_IDS || env.DISCORD_AUTO_CREATE_THREAD_CHANNEL_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
    if (autoCreateThreadChannelIds.size > 0) {
      log.info('Discord auto-create thread channels configured', { count: autoCreateThreadChannelIds.size });
    }
    // Catch-up wiring. For env-file keys, process.env wins (house precedence);
    // note: spread order makes process.env values override file values, but
    // only for keys present in process.env — matching the `process.env.X || env.X`
    // pattern used above for the other Discord keys.
    const catchupEnv: NodeJS.ProcessEnv = { ...env, ...process.env };
    const catchupConfig = discordCatchupConfigFromEnv(catchupEnv);
    // Application-command sync is deliberately NOT load-bearing: only config
    // discovery (skipped when env provides app id + public key) can throw —
    // and the registry's startup retry covers that. The sync itself runs in
    // the background with its own backoff (2026-08-02 outage class).
    const commandSync = await resolveDiscordStartupConfig({
      botToken,
      applicationId: process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID,
      publicKey: process.env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY,
      channelIds: getRegisteredDiscordChannelIds(),
      retryConfig: startupRetryConfigFromEnv(catchupEnv, 'DISCORD_COMMAND_SYNC_RETRY'),
    });
    const discordAdapter = createDiscordAdapter({
      botToken,
      publicKey: process.env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY || commandSync.publicKey,
      applicationId: process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID || commandSync.applicationId,
    });
    const channelIds = (): Set<string> => monitoredDiscordChannelIds(autoCreateThreadChannelIds);
    let catchup: DiscordCatchup | null = null;
    const handledTracker = createDiscordHandledTracker();
    return createChatSdkBridge({
      adapter: wrapYenteDiscordChannelIds(discordAdapter, botToken, autoCreateThreadChannelIds, {
        monitoredChannelIds: channelIds,
        routeLeaseMs: catchupConfig.routeLeaseMs,
        onGatewayEvent: (type) => catchup?.onGatewayEvent(type),
        wasMessageHandled: handledTracker.wasHandled,
      }),
      concurrency: 'concurrent',
      botToken,
      extractReplyContext,
      supportsThreads: true,
      maxTextLength: DISCORD_MESSAGE_TEXT_LIMIT,
      transformOutboundText: normalizeDiscordOutboundMarkdown,
      onInboundForwarded: handledTracker.noteHandled,
      onGatewayWebhookReady: (webhookUrl) => {
        if (catchup) return; // idempotency guard: channel-registry retries the WHOLE setup() body on NetworkError (channel-registry.ts:68-87) — a re-fired hook must not build a second engine + duplicate unref()'d timers
        catchup = createDiscordCatchup({
          botToken,
          webhookUrl,
          monitoredChannelIds: channelIds,
          env: catchupEnv,
        });
        catchup.start(); // startup run + periodic timer (kill switch handled inside)
      },
    });
  },
});

export function normalizeDiscordOutboundMarkdown(text: string): string {
  const stats: NormalizeStats = { urlLabeledLinks: 0, bareUrls: 0 };
  const normalized = splitMarkdownProtectedRegions(text)
    .map(({ content, isProtected }) => {
      if (isProtected) return content;
      return normalizeDiscordTextSegment(content, stats);
    })
    .join('')
    .replace(/^(\d+)\.$/gm, '$1\\.');

  if (stats.urlLabeledLinks > 0 || stats.bareUrls > 0) {
    log.info('Discord outbound links normalized', stats);
  }
  return normalized;
}

function normalizeDiscordTextSegment(content: string, stats: NormalizeStats): string {
  let normalized = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  MARKDOWN_LINK.lastIndex = 0;
  while ((match = MARKDOWN_LINK.exec(content)) !== null) {
    normalized += normalizeBareUrls(content.slice(lastIndex, match.index), stats);

    const rawMatch = match[0];
    const rawLabel = match[1] ?? '';
    const targetUrl = match[2] ?? '';
    if (isHttpUrlLabel(rawLabel)) {
      stats.urlLabeledLinks++;
      normalized += `[${labelForUrl(targetUrl)}](${targetUrl})`;
    } else {
      normalized += rawMatch;
    }
    lastIndex = match.index + rawMatch.length;
  }

  normalized += normalizeBareUrls(content.slice(lastIndex), stats);
  return normalized;
}

function normalizeBareUrls(content: string, stats: NormalizeStats): string {
  return content.replace(BARE_HTTP_URL, (match: string) => {
    const split = splitBareUrlMatch(match);
    if (!split || !parseHttpUrl(split.url)) return match;

    stats.bareUrls++;
    return `[${labelForUrl(split.url)}](${split.url})${split.suffix}`;
  });
}

function splitBareUrlMatch(match: string): { url: string; suffix: string } | null {
  if (match.startsWith('<')) {
    if (!match.endsWith('>')) return null;
    return { url: match.slice(1, -1), suffix: '' };
  }

  const url = stripTrailingUrlPunctuation(match);
  return { url, suffix: match.slice(url.length) };
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, '');
}

function splitMarkdownProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const protectedRegion = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = protectedRegion.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }
  return segments;
}

function isHttpUrlLabel(label: string): boolean {
  return parseHttpUrl(stripAutolinkBrackets(label)) !== null;
}

function stripAutolinkBrackets(label: string): string {
  const trimmed = label.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

function labelForUrl(value: string): string {
  const parsed = parseHttpUrl(value);
  if (!parsed) return 'link';

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname;

  if (host === 'docs.google.com') {
    if (path.startsWith('/document/')) return 'Google Doc';
    if (path.startsWith('/spreadsheets/')) return 'Google Sheet';
    if (path.startsWith('/presentation/')) return 'Google Slides';
    if (path.startsWith('/forms/')) return 'Google Form';
    return 'Google document';
  }
  if (host === 'drive.google.com') return 'Google Drive file';
  if (host === 'calendar.google.com') return 'Google Calendar';
  if (
    (host === 'maps.google.com' || host === 'google.com' || host.endsWith('.google.com')) &&
    path.startsWith('/maps')
  ) {
    return 'map';
  }
  if (host === 'photos.app.goo.gl' || host === 'photos.google.com') return 'photo album';
  if (host === 'gist.github.com') return 'gist';
  if (host === 'github.com') {
    if (/\/pull\/\d+(?:\/|$)/.test(path)) return 'GitHub PR';
    if (/\/issues\/\d+(?:\/|$)/.test(path)) return 'GitHub issue';
    if (/\/commit\/[0-9a-f]+(?:\/|$)/i.test(path)) return 'GitHub commit';
    return 'GitHub link';
  }
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'YouTube video';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Zoom link';
  if (host.endsWith('home.danshapiro.com') && path.startsWith('/p/')) return 'shared page';

  return 'link';
}

function getRegisteredDiscordChannelIds(): string[] {
  if (!isDbInitialized()) return [];
  const db = getDb();
  if (!hasTable(db, 'messaging_groups')) return [];
  const rows = db
    .prepare(
      "SELECT platform_id FROM messaging_groups WHERE channel_type = 'discord' AND platform_id NOT LIKE 'quarantined:%'",
    )
    .all() as Array<{ platform_id: string }>;
  return [...new Set(rows.map((row) => yenteDiscordPlatformIdFromThreadId(row.platform_id)).filter(Boolean))].sort();
}

/**
 * Channels the catch-up engine monitors: registered Discord messaging groups
 * (normalized to parent channel snowflakes, quarantined excluded) plus the
 * auto-thread channels. Recomputed per call so newly registered channels
 * join without a restart.
 */
export function monitoredDiscordChannelIds(autoCreateThreadChannelIds: Set<string>): Set<string> {
  return new Set([...getRegisteredDiscordChannelIds(), ...autoCreateThreadChannelIds]);
}

export function yenteDiscordPlatformIdFromThreadId(threadId: string): string {
  if (!threadId.startsWith('discord:')) return threadId;
  const parts = threadId.split(':');
  return parts[2] ?? threadId;
}

export async function toDiscordThreadId(platformId: string, botToken: string): Promise<string> {
  if (platformId.startsWith('discord:')) return platformId;

  const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(platformId)}`, {
    method: 'GET',
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve Discord channel ${platformId}: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { guild_id?: unknown };
  const guildId = typeof body.guild_id === 'string' && body.guild_id.length > 0 ? body.guild_id : '@me';
  return `discord:${guildId}:${platformId}`;
}

/** Backoff schedule for Gateway event forwarding retries (attempt 1 -> wait 250ms -> attempt 2 -> wait 1000ms -> attempt 3). */
export const GATEWAY_FORWARD_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/**
 * Network-level failures worth retrying when forwarding a Gateway event to
 * the local webhook server: undici's `TypeError: fetch failed` wrapper and
 * the usual transient socket errors seen around service restart windows.
 * Other thrown errors are NOT matched here — those fail immediately.
 */
function isTransientGatewayForwardError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    const code = (current as { code?: unknown }).code;
    if (
      /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message) ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET'
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Forward a Discord Gateway event to the local webhook server with a small
 * bounded retry (3 attempts total, 250ms then 1000ms backoff).
 *
 * Replaces @chat-adapter/discord's `forwardGatewayEvent`, which does a single
 * fetch and drops the event on `TypeError: fetch failed` (seen ~9/week in
 * prod, clustered around service restart windows). Retries ONLY transient
 * network-level failures and 5xx responses — never 4xx. Logs WARN per retry
 * attempt; the ERROR (same messages as the upstream adapter) is emitted only
 * after the final attempt fails. Never throws; resolves true only when the webhook accepted the event.
 */
export async function forwardDiscordGatewayEventWithRetry(
  webhookUrl: string,
  event: { type: string },
  botToken: string,
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
  } = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelays = deps?.retryDelaysMs ?? GATEWAY_FORWARD_RETRY_DELAYS_MS;
  const maxAttempts = retryDelays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-discord-gateway-token': botToken,
        },
        body: JSON.stringify(event),
      });
    } catch (error) {
      if (attempt < maxAttempts && isTransientGatewayForwardError(error)) {
        log.warn('Transient error forwarding Gateway event, retrying', {
          type: event.type,
          attempt,
          maxAttempts,
          error: String(error),
        });
        await sleep(retryDelays[attempt - 1]);
        continue;
      }
      log.error('Error forwarding Gateway event', { type: event.type, attempt, error: String(error) });
      return false;
    }

    if (response.ok) return true;

    if (response.status >= 500 && attempt < maxAttempts) {
      log.warn('Failed to forward Gateway event (5xx), retrying', {
        type: event.type,
        attempt,
        maxAttempts,
        status: response.status,
      });
      await sleep(retryDelays[attempt - 1]);
      continue;
    }

    const errorText = await response.text().catch(() => '');
    log.error('Failed to forward Gateway event', {
      type: event.type,
      status: response.status,
      attempt,
      error: errorText,
    });
    return false;
  }
  return false;
}

export type YenteDiscordWrapOptions = {
  monitoredChannelIds?: () => Set<string>;
  routeLeaseMs?: number;
  onGatewayEvent?: (type: string) => void;
  now?: () => string;
  /**
   * Consume-on-read acceptance probe wired from the bridge's onInboundForwarded
   * hook: returns true exactly once per message id a dispatch handler actually
   * forwarded. Optional in this task; the wrapper begins consulting it (and
   * the option becomes required) in the follow-up bookkeeping change.
   */
  wasMessageHandled?: (messageId: string) => boolean;
};

/**
 * Acceptance tracker shared by the chat-sdk bridge's onInboundForwarded hook
 * (writer) and the wrapped adapter's outcome block (consume-on-read reader
 * via Set.delete). Entries are added only by a successful inbound forward and
 * always consumed by the consult that the same forward reaches, so the set
 * stays near zero by construction. Exported so production and tests build the
 * tracker from the SAME constructor.
 */
export function createDiscordHandledTracker(): {
  noteHandled: (id: string) => void;
  wasHandled: (id: string) => boolean;
} {
  const handled = new Set<string>();
  return {
    noteHandled: (id) => {
      handled.add(id);
    },
    wasHandled: (id) => handled.delete(id),
  };
}

export function wrapYenteDiscordChannelIds(
  adapter: DiscordAdapterInstance,
  botToken: string,
  autoCreateThreadChannelIds: Set<string> = new Set(),
  options: YenteDiscordWrapOptions = {},
): DiscordAdapterInstance {
  const monitoredChannelIds = options.monitoredChannelIds ?? ((): Set<string> => new Set());
  const routeLeaseMs = options.routeLeaseMs ?? DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS;
  const nowIso = options.now ?? ((): string => new Date().toISOString());
  // Replace the vendored adapter's single-shot Gateway event forwarder with
  // the bounded-retry version. The adapter awaits forwardGatewayEvent per
  // event, so sequencing is unchanged — a retry only delays that one event.
  (
    adapter as unknown as { forwardGatewayEvent: (webhookUrl: string, event: { type: string }) => Promise<void> }
  ).forwardGatewayEvent = (webhookUrl: string, event: { type: string }) => {
    options.onGatewayEvent?.(event.type);
    return forwardDiscordGatewayEventWithRetry(webhookUrl, event, botToken).then(() => undefined);
  };

  const cache = new Map<string, string>();
  const resolve = async (threadId: string): Promise<string> => {
    if (threadId.startsWith('discord:')) return threadId;
    const cached = cache.get(threadId);
    if (cached) return cached;
    const resolved = await toDiscordThreadId(threadId, botToken);
    cache.set(threadId, resolved);
    return resolved;
  };

  adapter.channelIdFromThreadId = ((threadId: string) =>
    yenteDiscordPlatformIdFromThreadId(threadId)) as typeof adapter.channelIdFromThreadId;

  const postMessage = adapter.postMessage.bind(adapter);
  adapter.postMessage = (async (threadId, message) =>
    postMessage(await resolve(threadId), message)) as typeof adapter.postMessage;

  const editMessage = adapter.editMessage.bind(adapter);
  adapter.editMessage = (async (threadId, messageId, message) =>
    editMessage(await resolve(threadId), messageId, message)) as typeof adapter.editMessage;

  const deleteMessage = adapter.deleteMessage.bind(adapter);
  adapter.deleteMessage = (async (threadId, messageId) =>
    deleteMessage(await resolve(threadId), messageId)) as typeof adapter.deleteMessage;

  const addReaction = adapter.addReaction.bind(adapter);
  adapter.addReaction = (async (threadId, messageId, emoji) =>
    addReaction(await resolve(threadId), messageId, emoji)) as typeof adapter.addReaction;

  const removeReaction = adapter.removeReaction.bind(adapter);
  adapter.removeReaction = (async (threadId, messageId, emoji) =>
    removeReaction(await resolve(threadId), messageId, emoji)) as typeof adapter.removeReaction;

  const startTyping = adapter.startTyping.bind(adapter);
  adapter.startTyping = (async (threadId, status) =>
    startTyping(await resolve(threadId), status)) as typeof adapter.startTyping;

  const rawAdapter = adapter as any;
  const originalHandleForwardedMessage = rawAdapter.handleForwardedMessage.bind(rawAdapter);
  rawAdapter.handleForwardedMessage = async (dataArg: unknown, optionsArg: unknown, ...rest: unknown[]) => {
    const data = dataArg as Record<string, any> | undefined;
    const opts = optionsArg;
    const channelId = data?.channel_id as string | undefined;
    const messageId = data?.id as string | undefined;

    if (!channelId || !messageId) {
      // Not a message-shaped payload — pass through untouched.
      return originalHandleForwardedMessage(dataArg, opts, ...rest);
    }

    // 1. Idempotency gate: claim before forwarding. Live and catch-up
    //    messages traverse this same choke point, so one claim covers both.
    //    FAIL-OPEN on DB errors: a state bug must never silence live messages.
    try {
      const claimedAt = nowIso();
      const leaseExpiresAt = new Date(Date.parse(claimedAt) + routeLeaseMs).toISOString();
      const claim = claimDiscordMessage(
        channelId,
        messageId,
        {
          guildId: (data?.guild_id as string | undefined) ?? null,
          authorId: (data?.author?.id as string | undefined) ?? null,
          source: 'gateway',
        },
        claimedAt,
        leaseExpiresAt,
      );
      if (!claim.claimed) {
        // INFO, not debug: the deployed default log level is info, and the
        // host smoke greps logs/nanoclaw.log for this exact bare token.
        log.info('discord_message_duplicate_dropped', { channelId, messageId, status: claim.status });
        return undefined;
      }
    } catch (error) {
      log.error('Discord message claim failed, routing anyway', { channelId, messageId, error: String(error) });
    }

    // 2. Auto-thread creation (existing behavior), after the claim.
    const alreadyInThread = data?.thread != null || data?.channel_type === 11 || data?.channel_type === 12;
    if (!alreadyInThread && autoCreateThreadChannelIds.has(channelId)) {
      try {
        const newThread = await rawAdapter.createDiscordThread(channelId, messageId);
        if (newThread?.id) {
          dataArg = {
            ...data,
            thread: { id: newThread.id, parent_id: channelId },
          };
          log.info('Created Discord thread for auto-thread channel', {
            channelId,
            messageId,
            threadId: newThread.id,
          });
        }
      } catch (error) {
        log.warn('Failed to create Discord thread for auto-thread channel', {
          channelId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 3. Forward, then record the outcome (fail-open on state errors).
    try {
      const result = await originalHandleForwardedMessage(dataArg, opts, ...rest);
      try {
        const routedAt = nowIso();
        markDiscordMessageRouted(channelId, messageId, routedAt);
        const monitored = monitoredChannelIds();
        const parentId = (dataArg as Record<string, any>)?.thread?.parent_id as string | undefined;
        if (monitored.has(channelId) || (parentId !== undefined && monitored.has(parentId))) {
          advanceDiscordChannelCursor(channelId, messageId, routedAt);
        }
      } catch (error) {
        log.error('Discord route bookkeeping failed', { channelId, messageId, error: String(error) });
      }
      return result;
    } catch (error) {
      try {
        markDiscordMessageFailed(
          channelId,
          messageId,
          nowIso(),
          error instanceof Error ? error.message : String(error),
        );
      } catch (stateError) {
        log.error('Discord route failure bookkeeping failed', { channelId, messageId, error: String(stateError) });
      }
      throw error;
    }
  };

  return adapter;
}
