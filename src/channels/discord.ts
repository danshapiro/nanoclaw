/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { getDb, hasTable, isDbInitialized } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { syncYenteDiscordApplicationCommands } from './discord-commands.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
type DiscordAdapterInstance = ReturnType<typeof createDiscordAdapter>;

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
      transformOutboundText: (t) => t.replace(/^(\d+)\.$/gm, '$1\\.'),
    });
  },
});

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
