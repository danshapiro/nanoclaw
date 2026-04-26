import { describe, expect, it, vi } from 'vitest';

import {
  buildYenteDiscordGuildCommandPayloads,
  normalizeDiscordApplicationCommandInteraction,
  registerYenteDiscordGuildCommands,
  YENTE_DISCORD_COMMANDS,
} from './discord-commands.js';

describe('Yente Discord application commands', () => {
  it('defines one canonical guild command catalog for every visible host command', () => {
    expect(YENTE_DISCORD_COMMANDS.map((command) => command.name)).toEqual([
      'help',
      'status',
      'new',
      'clear',
      'compact',
    ]);
    expect(YENTE_DISCORD_COMMANDS.filter((command) => command.requiresAdmin).map((command) => command.name)).toEqual([
      'new',
      'clear',
      'compact',
    ]);

    expect(buildYenteDiscordGuildCommandPayloads()).toEqual([
      expect.objectContaining({ name: 'help', type: 1 }),
      expect.objectContaining({ name: 'status', type: 1 }),
      expect.objectContaining({ name: 'new', type: 1 }),
      expect.objectContaining({ name: 'clear', type: 1 }),
      expect.objectContaining({ name: 'compact', type: 1 }),
    ]);
  });

  it('registers commands only on configured guilds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));

    await registerYenteDiscordGuildCommands({
      applicationId: 'app-123',
      botToken: 'bot-token',
      guildIds: ['guild-1', 'guild-2'],
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://discord.com/api/v10/applications/app-123/guilds/guild-1/commands',
      'https://discord.com/api/v10/applications/app-123/guilds/guild-2/commands',
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/applications/app-123/commands'))).toBe(false);
  });

  it('normalizes Discord application command interactions into host-command text', () => {
    const interaction = {
      type: 2,
      id: 'interaction-1',
      token: 'token-1',
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      member: { user: { id: 'user-1', username: 'User One' } },
      data: { type: 1, name: 'clear' },
    };

    expect(normalizeDiscordApplicationCommandInteraction(interaction)).toEqual({
      commandName: 'clear',
      text: '/clear',
      requiresAdmin: true,
      userId: 'discord:user-1',
      senderName: 'User One',
      platformId: 'discord:guild-1:channel-1',
      threadId: null,
    });
  });
});
