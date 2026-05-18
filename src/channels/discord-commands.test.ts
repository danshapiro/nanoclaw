import { describe, expect, it, vi } from 'vitest';

import {
  buildYenteDiscordGuildCommandPayloads,
  fetchDiscordApplicationConfig,
  normalizeDiscordApplicationCommandInteraction,
  resolveDiscordGuildIdsForChannels,
  syncYenteDiscordApplicationCommands,
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

  it('discovers missing application config from the bot token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'app-123', verify_key: 'a'.repeat(64) }), { status: 200 }));

    await expect(
      fetchDiscordApplicationConfig({
        botToken: 'bot-token',
        fetchImpl,
      }),
    ).resolves.toEqual({
      applicationId: 'app-123',
      publicKey: 'a'.repeat(64),
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://discord.com/api/v10/oauth2/applications/@me', {
      method: 'GET',
      headers: { Authorization: 'Bot bot-token' },
    });
  });

  it('resolves registered channel ids to unique guild ids', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/channels/channel-1')) {
        return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), { status: 200 });
      }
      if (url.endsWith('/channels/channel-2')) {
        return new Response(JSON.stringify({ id: 'channel-2', guild_id: 'guild-1' }), { status: 200 });
      }
      if (url.endsWith('/channels/dm-1')) {
        return new Response(JSON.stringify({ id: 'dm-1' }), { status: 200 });
      }
      return new Response('missing', { status: 404 });
    });

    await expect(
      resolveDiscordGuildIdsForChannels({
        botToken: 'bot-token',
        channelIds: ['channel-1', 'channel-2', 'dm-1'],
        fetchImpl,
      }),
    ).resolves.toEqual(['guild-1']);
  });

  it('clears global commands and registers only resolved guild commands', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/oauth2/applications/@me')) {
        return new Response(JSON.stringify({ id: 'app-123', verify_key: 'b'.repeat(64) }), { status: 200 });
      }
      if (url.endsWith('/channels/channel-1')) {
        return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), { status: 200 });
      }
      if (url.endsWith('/applications/app-123/commands') && init?.method === 'PUT') {
        return new Response('[]', { status: 200 });
      }
      if (url.endsWith('/applications/app-123/guilds/guild-1/commands') && init?.method === 'PUT') {
        return new Response('[]', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await syncYenteDiscordApplicationCommands({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      fetchImpl,
    });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['https://discord.com/api/v10/oauth2/applications/@me', 'GET'],
      ['https://discord.com/api/v10/channels/channel-1', 'GET'],
      ['https://discord.com/api/v10/applications/app-123/commands', 'PUT'],
      ['https://discord.com/api/v10/applications/app-123/guilds/guild-1/commands', 'PUT'],
    ]);
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
      platformId: 'channel-1',
      threadId: 'discord:guild-1:channel-1',
    });
  });

  it('normalizes Discord DM application commands into a stable DM thread id', () => {
    expect(
      normalizeDiscordApplicationCommandInteraction({
        type: 2,
        channel_id: 'dm-channel-1',
        user: { id: 'user-2', username: 'DM User' },
        data: { type: 1, name: 'new' },
      }),
    ).toEqual({
      commandName: 'new',
      text: '/new',
      requiresAdmin: true,
      userId: 'discord:user-2',
      senderName: 'DM User',
      platformId: 'dm-channel-1',
      threadId: 'discord:@me:dm-channel-1',
    });
  });
});
