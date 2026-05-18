const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface YenteDiscordCommand {
  name: 'help' | 'status' | 'new' | 'clear' | 'compact';
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

export async function resolveDiscordGuildIdsForChannels(args: {
  botToken: string;
  channelIds: readonly string[];
  fetchImpl?: FetchLike;
}): Promise<string[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const guildIds = new Set<string>();

  for (const channelId of args.channelIds) {
    const normalized = channelIdFromPlatformId(channelId);
    if (!normalized) continue;
    const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${encodeURIComponent(normalized)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bot ${args.botToken}`,
      },
    });
    if (!response.ok) continue;
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
}): Promise<DiscordApplicationConfig & { guildIds: string[] }> {
  const discovered =
    args.applicationId && args.publicKey
      ? { applicationId: args.applicationId, publicKey: args.publicKey }
      : await fetchDiscordApplicationConfig({ botToken: args.botToken, fetchImpl: args.fetchImpl });
  const guildIds = await resolveDiscordGuildIdsForChannels({
    botToken: args.botToken,
    channelIds: args.channelIds,
    fetchImpl: args.fetchImpl,
  });

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
