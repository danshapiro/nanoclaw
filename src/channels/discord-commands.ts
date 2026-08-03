import { log } from '../log.js';
import { startupRetryConfigFromEnv, startupRetryDelayMs, type StartupRetryConfig } from './startup-retry.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface YenteDiscordCommand {
  name: 'help' | 'status' | 'new' | 'clear' | 'compact' | 'stop';
  description: string;
  requiresAdmin: boolean;
}

export const YENTE_DISCORD_COMMANDS = [
  {
    name: 'help',
    description: 'Show Yente help.',
    requiresAdmin: false,
  },
  {
    name: 'status',
    description: 'Show Yente status.',
    requiresAdmin: false,
  },
  {
    name: 'new',
    description: 'Start a fresh Yente session for this conversation.',
    requiresAdmin: true,
  },
  {
    name: 'clear',
    description: 'Clear the active Yente session for this conversation.',
    requiresAdmin: true,
  },
  {
    name: 'compact',
    description: 'Compact the active Yente session.',
    requiresAdmin: true,
  },
  {
    name: 'stop',
    description: 'Stop the active Yente turn.',
    requiresAdmin: true,
  },
] as const satisfies readonly YenteDiscordCommand[];

export type YenteDiscordCommandName = (typeof YENTE_DISCORD_COMMANDS)[number]['name'];

export interface DiscordApplicationCommandPayload {
  name: YenteDiscordCommandName;
  description: string;
  type: 1;
}

export interface NormalizedDiscordCommandInteraction {
  commandName: YenteDiscordCommandName;
  text: `/${YenteDiscordCommandName}`;
  requiresAdmin: boolean;
  userId: string;
  senderName: string;
  platformId: string;
  threadId: string | null;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (
  url: string,
  init: { method: 'GET' | 'PUT' | 'POST'; headers: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

export interface DiscordApplicationConfig {
  applicationId: string;
  publicKey: string;
}

interface DiscordInteractionUser {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
}

interface DiscordApplicationCommandInteraction {
  type?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
  channel?: {
    id?: unknown;
    type?: unknown;
    parent_id?: unknown;
  };
  data?: {
    type?: unknown;
    name?: unknown;
  };
  member?: {
    user?: DiscordInteractionUser;
  };
  user?: DiscordInteractionUser;
}

function commandByName(name: unknown): YenteDiscordCommand | undefined {
  if (typeof name !== 'string') return undefined;
  return YENTE_DISCORD_COMMANDS.find((command) => command.name === name);
}

const DISCORD_THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

function channelAddressFromInteraction(interaction: DiscordApplicationCommandInteraction): {
  platformId: string;
  threadId: string | null;
} | null {
  const channelId =
    (typeof interaction.channel?.id === 'string' && interaction.channel.id) ||
    (typeof interaction.channel_id === 'string' && interaction.channel_id) ||
    '';
  if (!channelId) return null;
  const guildId = typeof interaction.guild_id === 'string' && interaction.guild_id ? interaction.guild_id : '@me';
  const parentId = typeof interaction.channel?.parent_id === 'string' ? interaction.channel.parent_id : '';
  if (parentId && DISCORD_THREAD_CHANNEL_TYPES.has(Number(interaction.channel?.type))) {
    return {
      platformId: parentId,
      threadId: `discord:${guildId}:${parentId}:${channelId}`,
    };
  }
  return {
    platformId: channelId,
    threadId: `discord:${guildId}:${channelId}`,
  };
}

export function buildYenteDiscordGuildCommandPayloads(): DiscordApplicationCommandPayload[] {
  return YENTE_DISCORD_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    type: 1,
  }));
}

export async function registerYenteDiscordGuildCommands(args: {
  applicationId: string;
  botToken: string;
  guildIds: readonly string[];
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = JSON.stringify(buildYenteDiscordGuildCommandPayloads());

  for (const guildId of args.guildIds) {
    const url = `${DISCORD_API_BASE}/applications/${encodeURIComponent(args.applicationId)}/guilds/${encodeURIComponent(
      guildId,
    )}/commands`;
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${args.botToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to register Yente Discord guild commands for guild ${guildId}: ${response.status} ${text}`,
      );
    }
  }
}

export async function clearYenteDiscordGlobalCommands(args: {
  applicationId: string;
  botToken: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${DISCORD_API_BASE}/applications/${encodeURIComponent(args.applicationId)}/commands`;
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${args.botToken}`,
      'Content-Type': 'application/json',
    },
    body: '[]',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to clear Yente Discord global commands: ${response.status} ${text}`);
  }
}

export async function fetchDiscordApplicationConfig(args: {
  botToken: string;
  fetchImpl?: FetchLike;
}): Promise<DiscordApplicationConfig> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DISCORD_API_BASE}/oauth2/applications/@me`, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${args.botToken}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to discover Discord application config: ${response.status} ${text}`);
  }

  const body = JSON.parse(await response.text()) as { id?: unknown; verify_key?: unknown };
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw new Error('Failed to discover Discord application config: response missing id');
  }
  if (typeof body.verify_key !== 'string' || body.verify_key.length === 0) {
    throw new Error('Failed to discover Discord application config: response missing verify_key');
  }
  return { applicationId: body.id, publicKey: body.verify_key };
}

/**
 * Retryable guild-lookup failures: rate limiting and server/transport
 * trouble. Every other non-OK status (404 deleted channel, 403 kicked
 * guild, ...) is permanent — retrying it every cycle forever only
 * produces WARN noise and PUT churn.
 */
function isRetryableDiscordStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Channels whose guild lookup failed permanently (non-retryable 4xx).
 * Process-lifetime memory so a deleted/kicked channel is warned about
 * exactly once, not every sync cycle; a process restart re-evaluates.
 */
const permanentlySkippedDiscordChannelIds = new Set<string>();

export async function resolveDiscordGuildIdsForChannels(
  args: {
    botToken: string;
    channelIds: readonly string[];
    fetchImpl?: FetchLike;
    skippedChannelIds?: Set<string>;
  },
  failedChannelIds?: string[],
): Promise<string[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const skippedChannelIds = args.skippedChannelIds ?? permanentlySkippedDiscordChannelIds;
  const guildIds = new Set<string>();

  for (const channelId of args.channelIds) {
    const normalized = channelIdFromPlatformId(channelId);
    if (!normalized) continue;
    if (skippedChannelIds.has(normalized)) continue;
    const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${encodeURIComponent(normalized)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bot ${args.botToken}`,
      },
    });
    if (!response.ok) {
      if (isRetryableDiscordStatus(response.status)) {
        failedChannelIds?.push(channelId);
      } else {
        skippedChannelIds.add(normalized);
        log.warn('Discord command sync: permanent guild-lookup failure, skipping channel until process restart', {
          channelId,
          status: response.status,
        });
      }
      continue;
    }
    const body = JSON.parse(await response.text()) as { guild_id?: unknown };
    if (typeof body.guild_id === 'string' && body.guild_id.length > 0) {
      guildIds.add(body.guild_id);
    }
  }

  return [...guildIds].sort();
}

export async function syncYenteDiscordApplicationCommands(args: {
  botToken: string;
  channelIds: readonly string[];
  applicationId?: string | null;
  publicKey?: string | null;
  fetchImpl?: FetchLike;
  skippedChannelIds?: Set<string>;
}): Promise<DiscordApplicationConfig & { guildIds: string[] }> {
  const discovered =
    args.applicationId && args.publicKey
      ? { applicationId: args.applicationId, publicKey: args.publicKey }
      : await fetchDiscordApplicationConfig({ botToken: args.botToken, fetchImpl: args.fetchImpl });
  const failedChannelIds: string[] = [];
  const guildIds = await resolveDiscordGuildIdsForChannels(
    {
      botToken: args.botToken,
      channelIds: args.channelIds,
      fetchImpl: args.fetchImpl,
      skippedChannelIds: args.skippedChannelIds,
    },
    failedChannelIds,
  );

  await clearYenteDiscordGlobalCommands({
    applicationId: discovered.applicationId,
    botToken: args.botToken,
    fetchImpl: args.fetchImpl,
  });
  await registerYenteDiscordGuildCommands({
    applicationId: discovered.applicationId,
    botToken: args.botToken,
    guildIds,
    fetchImpl: args.fetchImpl,
  });

  if (failedChannelIds.length > 0) {
    throw new Error(`Discord command sync incomplete: guild resolution failed for ${failedChannelIds.join(', ')}`);
  }

  return { ...discovered, guildIds };
}

export function normalizeDiscordApplicationCommandInteraction(
  interaction: DiscordApplicationCommandInteraction,
): NormalizedDiscordCommandInteraction | null {
  if (interaction.type !== 2 || interaction.data?.type !== 1) return null;

  const command = commandByName(interaction.data.name);
  if (!command) return null;

  const user = interaction.member?.user ?? interaction.user;
  const userId = typeof user?.id === 'string' ? user.id : '';
  const senderName =
    (typeof user?.global_name === 'string' && user.global_name) ||
    (typeof user?.username === 'string' && user.username) ||
    userId ||
    'Discord user';
  const channelAddress = channelAddressFromInteraction(interaction);
  if (!channelAddress) return null;

  return {
    commandName: command.name,
    text: `/${command.name}`,
    requiresAdmin: command.requiresAdmin,
    userId: `discord:${userId}`,
    senderName,
    platformId: channelAddress.platformId,
    threadId: channelAddress.threadId,
  };
}

function channelIdFromPlatformId(platformId: string): string | null {
  if (!platformId) return null;
  if (!platformId.startsWith('discord:')) return platformId;
  const parts = platformId.split(':');
  return parts[2] ?? null;
}
let commandSyncLoopActive = false;

/**
 * Background application-command sync with backoff — command sync must never
 * be load-bearing for Discord adapter startup (2026-08-02: a pre-connect
 * REST call died on cold network and killed the whole channel). Retries
 * until it succeeds; returns false only when retries are disabled or
 * maxAttempts is exhausted. Never throws. SINGLE-FLIGHT: one loop per
 * process — a duplicate call while one is active logs a WARN and returns
 * false (validated: without this, every factory retry attempt / re-init
 * would spawn another immortal loop).
 */
export async function syncYenteDiscordApplicationCommandsWithRetry(args: {
  botToken: string;
  channelIds: readonly string[];
  applicationId: string;
  publicKey: string;
  fetchImpl?: FetchLike;
  retryConfig?: StartupRetryConfig;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  skippedChannelIds?: Set<string>;
}): Promise<boolean> {
  if (commandSyncLoopActive) {
    log.warn('Discord command sync already in flight, skipping duplicate');
    return false;
  }
  commandSyncLoopActive = true;
  const retryConfig = args.retryConfig ?? startupRetryConfigFromEnv(process.env, 'DISCORD_COMMAND_SYNC_RETRY');
  const sleep =
    args.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const random = args.random ?? Math.random;
  const maxAttempts = args.maxAttempts ?? 0; // 0 = retry forever
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await syncYenteDiscordApplicationCommands({
          botToken: args.botToken,
          channelIds: args.channelIds,
          applicationId: args.applicationId,
          publicKey: args.publicKey,
          fetchImpl: args.fetchImpl,
          skippedChannelIds: args.skippedChannelIds,
        });
        log.info('Discord command sync complete', { attempt });
        return true;
      } catch (err) {
        if (retryConfig.disabled || (maxAttempts > 0 && attempt >= maxAttempts)) {
          log.error('Discord command sync failed permanently', { attempt, err });
          return false;
        }
        const retryInMs = startupRetryDelayMs(retryConfig, attempt, random);
        log.warn('Discord command sync failed, will retry', { attempt, retryInMs, err });
        await sleep(retryInMs);
      }
    }
  } finally {
    commandSyncLoopActive = false;
  }
}

/**
 * Resolve the application config needed to construct the Discord adapter,
 * then kick off command sync in the background. Only config discovery (one
 * REST GET, skipped entirely when applicationId+publicKey come from env)
 * can throw — command sync failures never propagate to the caller.
 */
export async function resolveDiscordStartupConfig(args: {
  botToken: string;
  channelIds: readonly string[];
  applicationId?: string | null;
  publicKey?: string | null;
  fetchImpl?: FetchLike;
  retryConfig?: StartupRetryConfig;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  scheduleCommandSync?: (run: () => Promise<void>) => void;
}): Promise<DiscordApplicationConfig> {
  const discovered =
    args.applicationId && args.publicKey
      ? { applicationId: args.applicationId, publicKey: args.publicKey }
      : await fetchDiscordApplicationConfig({ botToken: args.botToken, fetchImpl: args.fetchImpl });
  const runSync = async (): Promise<void> => {
    await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: args.botToken,
      channelIds: args.channelIds,
      applicationId: discovered.applicationId,
      publicKey: discovered.publicKey,
      fetchImpl: args.fetchImpl,
      retryConfig: args.retryConfig,
      sleep: args.sleep,
      random: args.random,
    });
  };
  const schedule = args.scheduleCommandSync ?? ((run: () => Promise<void>) => void run());
  schedule(runSync);
  return discovered;
}
