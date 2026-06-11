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
import { syncYenteDiscordApplicationCommands } from './discord-commands.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_MESSAGE_TEXT_LIMIT = 2000;
const URL_LABELED_MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
type DiscordAdapterInstance = ReturnType<typeof createDiscordAdapter>;
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
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    const botToken = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
    if (!botToken) return null;
    const commandSync = await syncYenteDiscordApplicationCommands({
      botToken,
      applicationId: process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID,
      publicKey: process.env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY,
      channelIds: getRegisteredDiscordChannelIds(),
    });
    const discordAdapter = createDiscordAdapter({
      botToken,
      publicKey: process.env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY || commandSync.publicKey,
      applicationId: process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID || commandSync.applicationId,
    });
    return createChatSdkBridge({
      adapter: wrapYenteDiscordChannelIds(discordAdapter, botToken),
      concurrency: 'concurrent',
      botToken,
      extractReplyContext,
      supportsThreads: true,
      maxTextLength: DISCORD_MESSAGE_TEXT_LIMIT,
      transformOutboundText: normalizeDiscordOutboundMarkdown,
    });
  },
});

export function normalizeDiscordOutboundMarkdown(text: string): string {
  let rewriteCount = 0;
  const normalized = splitMarkdownProtectedRegions(text)
    .map(({ content, isProtected }) => {
      if (isProtected) return content;
      return content.replace(URL_LABELED_MARKDOWN_LINK, (match, rawLabel: string, targetUrl: string) => {
        if (!isHttpUrlLabel(rawLabel)) return match;
        rewriteCount++;
        return `[${labelForUrl(targetUrl)}](${targetUrl})`;
      });
    })
    .join('')
    .replace(/^(\d+)\.$/gm, '$1\\.');

  if (rewriteCount > 0) {
    log.info('Discord outbound URL-labeled links normalized', { count: rewriteCount });
  }
  return normalized;
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

function wrapYenteDiscordChannelIds(adapter: DiscordAdapterInstance, botToken: string): DiscordAdapterInstance {
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

  return adapter;
}
