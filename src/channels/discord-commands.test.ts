import { describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import {
  buildYenteDiscordGuildCommandPayloads,
  fetchDiscordApplicationConfig,
  normalizeDiscordApplicationCommandInteraction,
  resolveDiscordGuildIdsForChannels,
  resolveDiscordStartupConfig,
  syncYenteDiscordApplicationCommands,
  syncYenteDiscordApplicationCommandsWithRetry,
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
      'stop',
    ]);
    expect(YENTE_DISCORD_COMMANDS.filter((command) => command.requiresAdmin).map((command) => command.name)).toEqual([
      'new',
      'clear',
      'compact',
      'stop',
    ]);

    expect(buildYenteDiscordGuildCommandPayloads()).toEqual([
      expect.objectContaining({ name: 'help', type: 1 }),
      expect.objectContaining({ name: 'status', type: 1 }),
      expect.objectContaining({ name: 'new', type: 1 }),
      expect.objectContaining({ name: 'clear', type: 1 }),
      expect.objectContaining({ name: 'compact', type: 1 }),
      expect.objectContaining({ name: 'stop', type: 1 }),
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
      data: { type: 1, name: 'stop' },
    };

    expect(normalizeDiscordApplicationCommandInteraction(interaction)).toEqual({
      commandName: 'stop',
      text: '/stop',
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

  it('normalizes Discord thread application commands to the parent channel platform id', () => {
    expect(
      normalizeDiscordApplicationCommandInteraction({
        type: 2,
        guild_id: 'guild-1',
        channel_id: 'thread-1',
        channel: { id: 'thread-1', type: 11, parent_id: 'channel-1' },
        member: { user: { id: 'user-3', username: 'Thread User' } },
        data: { type: 1, name: 'new' },
      }),
    ).toEqual({
      commandName: 'new',
      text: '/new',
      requiresAdmin: true,
      userId: 'discord:user-3',
      senderName: 'Thread User',
      platformId: 'channel-1',
      threadId: 'discord:guild-1:channel-1:thread-1',
    });
  });
});
describe('resolveDiscordStartupConfig', () => {
  it('resolves env-provided config immediately without any REST call', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 500 }));
    const scheduled: Array<() => Promise<void>> = [];
    const config = await resolveDiscordStartupConfig({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      scheduleCommandSync: (run) => scheduled.push(run),
    });
    expect(config).toEqual({ applicationId: 'app-123', publicKey: 'k'.repeat(64) });
    expect(fetchImpl).not.toHaveBeenCalled(); // no discovery needed, sync not yet run
    expect(scheduled).toHaveLength(1);
  });

  it('command-sync failures retry in the background and never kill startup (incident shape)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    let clearAttempts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/channel-1')) {
        return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), { status: 200 });
      }
      if (url.endsWith('/applications/app-123/commands') && init?.method === 'PUT') {
        clearAttempts += 1;
        if (clearAttempts < 3) throw new TypeError('fetch failed'); // cold network at boot
        return new Response('[]', { status: 200 });
      }
      if (url.endsWith('/applications/app-123/guilds/guild-1/commands') && init?.method === 'PUT') {
        return new Response('[]', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    let syncDone: Promise<void> = Promise.resolve();
    const config = await resolveDiscordStartupConfig({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [5000, 15000], capMs: 30000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      scheduleCommandSync: (run) => {
        syncDone = run(); // deterministic: awaiting the loop also releases the single-flight flag
      },
    });
    expect(config.applicationId).toBe('app-123'); // startup config resolved despite sync failures
    await syncDone;
    expect(clearAttempts).toBe(3);
    expect(sleeps).toEqual([5000, 15000]); // backoff ladder honored
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('still throws when config discovery itself fails (registry retries the factory)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(resolveDiscordStartupConfig({ botToken: 'bot-token', channelIds: [], fetchImpl })).rejects.toThrow(
      'fetch failed',
    );
  });
});

describe('syncYenteDiscordApplicationCommandsWithRetry', () => {
  it('gives up with an ERROR only when retries are disabled', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: true, delaysMs: [1], capMs: 1, jitterRatio: 0 },
    });
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Discord command sync failed permanently',
      expect.objectContaining({ attempt: 1 }),
    );
    errorSpy.mockRestore();
  });

  it('stops after maxAttempts when set', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [100], capMs: 100, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([100, 100]); // slept between attempts 1->2 and 2->3
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('keeps retrying while guild resolution is incomplete (brownout partial-registration shape)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let channelLookups = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/channel-1')) {
        channelLookups += 1;
        if (channelLookups === 1) return new Response('upstream unavailable', { status: 502 }); // brownout
        return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), { status: 200 });
      }
      if (init?.method === 'PUT') return new Response('[]', { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [5000], capMs: 5000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(ok).toBe(true);
    expect(channelLookups).toBe(2); // partial resolution = failed cycle, retried until complete
    expect(sleeps).toEqual([5000]);
    warnSpy.mockRestore();
  });

  it('treats 404 guild lookup as permanent: one WARN, cycle succeeds, other channels still applied', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/deleted-channel')) return new Response('missing', { status: 404 });
      if (url.endsWith('/channels/healthy-channel')) {
        return new Response(JSON.stringify({ id: 'healthy-channel', guild_id: 'guild-1' }), { status: 200 });
      }
      if (init?.method === 'PUT') return new Response('[]', { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: ['deleted-channel', 'healthy-channel'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      skippedChannelIds: new Set<string>(),
      retryConfig: { disabled: false, delaysMs: [5000], capMs: 5000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });
    expect(ok).toBe(true); // permanent failure does not fail the cycle
    expect(sleeps).toEqual([]); // no retry churn
    const permanentWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('permanent'));
    expect(permanentWarns).toHaveLength(1);
    expect(permanentWarns[0]?.[1]).toMatchObject({ channelId: 'deleted-channel', status: 404 });
    // the healthy channel's guild still got its commands registered
    expect(
      fetchImpl.mock.calls.some(
        ([url, init]) => String(url).endsWith('/guilds/guild-1/commands') && init?.method === 'PUT',
      ),
    ).toBe(true);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('treats 429 guild lookup as retryable: cycle fails and the loop retries', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    let channelLookups = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/rate-limited-channel')) {
        channelLookups += 1;
        if (channelLookups === 1) return new Response('slow down', { status: 429 });
        return new Response(JSON.stringify({ id: 'rate-limited-channel', guild_id: 'guild-1' }), { status: 200 });
      }
      if (init?.method === 'PUT') return new Response('[]', { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: ['rate-limited-channel'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      skippedChannelIds: new Set<string>(),
      retryConfig: { disabled: false, delaysMs: [5000], capMs: 5000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });
    expect(ok).toBe(true);
    expect(channelLookups).toBe(2); // 429 failed the cycle, loop retried
    expect(sleeps).toEqual([5000]);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('treats network errors during guild lookup as retryable: cycle fails and the loop retries', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    let channelLookups = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/flaky-channel')) {
        channelLookups += 1;
        if (channelLookups === 1) throw new TypeError('fetch failed'); // transport error
        return new Response(JSON.stringify({ id: 'flaky-channel', guild_id: 'guild-1' }), { status: 200 });
      }
      if (init?.method === 'PUT') return new Response('[]', { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: ['flaky-channel'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      skippedChannelIds: new Set<string>(),
      retryConfig: { disabled: false, delaysMs: [5000], capMs: 5000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });
    expect(ok).toBe(true);
    expect(channelLookups).toBe(2);
    expect(sleeps).toEqual([5000]);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('remembers permanent skips across cycles: no re-WARN, no repeated lookup churn', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const skippedChannelIds = new Set<string>();
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/dead-channel')) return new Response('missing', { status: 404 });
      if (init?.method === 'PUT') return new Response('[]', { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    const countDeadLookups = () =>
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/channels/dead-channel')).length;

    // first cycle: warns once, succeeds
    await syncYenteDiscordApplicationCommands({
      botToken: 'bot-token',
      channelIds: ['dead-channel'],
      fetchImpl,
      skippedChannelIds,
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
    });
    expect(countDeadLookups()).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // second cycle in the same process: no new WARN, no re-lookup of the dead channel
    await syncYenteDiscordApplicationCommands({
      botToken: 'bot-token',
      channelIds: ['dead-channel'],
      fetchImpl,
      skippedChannelIds,
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
    });
    expect(countDeadLookups()).toBe(1); // still just the first lookup
    expect(warnSpy).toHaveBeenCalledTimes(1); // no re-log
    warnSpy.mockRestore();
  });

  it('single-flights the loop: a duplicate call while one is in flight returns false without syncing', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    let sleepCalls = 0;
    let releaseSleep: () => void = () => {};
    const first = syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [100], capMs: 100, jitterRatio: 0 },
      sleep: () =>
        new Promise((resolve) => {
          sleepCalls += 1;
          releaseSleep = resolve; // parks the loop between attempts
        }),
      maxAttempts: 2,
    });
    const second = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: true, delaysMs: [1], capMs: 1, jitterRatio: 0 },
    });
    expect(second).toBe(false); // refused immediately: a loop is already active
    expect(warnSpy).toHaveBeenCalledWith('Discord command sync already in flight, skipping duplicate');
    await vi.waitFor(() => expect(sleepCalls).toBe(1));
    releaseSleep();
    await expect(first).resolves.toBe(false); // original loop exhausts maxAttempts as usual
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
