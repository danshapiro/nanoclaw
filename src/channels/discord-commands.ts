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
  init: { method: 'PUT'; headers: Record<string, string>; body: string },
) => Promise<FetchResponse>;

interface DiscordInteractionUser {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
}

interface DiscordApplicationCommandInteraction {
  type?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
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
  const channelId = typeof interaction.channel_id === 'string' ? interaction.channel_id : '';
  const guildId = typeof interaction.guild_id === 'string' ? interaction.guild_id : null;

  return {
    commandName: command.name,
    text: `/${command.name}`,
    requiresAdmin: command.requiresAdmin,
    userId: `discord:${userId}`,
    senderName,
    platformId: guildId ? `discord:${guildId}:${channelId}` : `discord:@me:${channelId}`,
    threadId: null,
  };
}
