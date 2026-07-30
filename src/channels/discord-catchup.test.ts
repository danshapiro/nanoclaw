import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  compareSnowflakes,
  createDiscordCatchup,
  DEFAULT_DISCORD_CATCHUP_INTERVAL_MS,
  DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS,
  DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES,
  DEFAULT_DISCORD_CATCHUP_MAX_THREADS,
  DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS,
  DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
  discordCatchupConfigFromEnv,
  snowflakeToUnixMs,
  unixMsToSnowflake,
} from './discord-catchup.js';
import {
  advanceDiscordChannelCursor,
  claimDiscordMessage,
  getDiscordChannelCursor,
  markDiscordMessageFailed,
  markDiscordMessageRouted,
} from './discord-state.js';

describe('discordCatchupConfigFromEnv', () => {
  it('returns spec defaults on an empty env', () => {
    expect(discordCatchupConfigFromEnv({})).toEqual({
      disabled: false,
      intervalMs: DEFAULT_DISCORD_CATCHUP_INTERVAL_MS,
      readyDebounceMs: DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS,
      maxMessages: DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES,
      maxAgeMs: DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS,
      routeLeaseMs: DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
      maxThreads: DEFAULT_DISCORD_CATCHUP_MAX_THREADS,
    });
    expect(DEFAULT_DISCORD_CATCHUP_INTERVAL_MS).toBe(300000);
    expect(DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS).toBe(15000);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES).toBe(200);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS).toBe(259200000);
    expect(DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS).toBe(120000);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_THREADS).toBe(25);
  });

  it('reads the kill switch and interval=0 (periodic disable)', () => {
    const config = discordCatchupConfigFromEnv({
      DISCORD_CATCHUP_DISABLED: '1',
      DISCORD_CATCHUP_INTERVAL_MS: '0',
    });
    expect(config.disabled).toBe(true);
    expect(config.intervalMs).toBe(0);
  });

  it('throws loudly on malformed values, naming the variable', () => {
    expect(() => discordCatchupConfigFromEnv({ DISCORD_CATCHUP_MAX_MESSAGES: 'lots' })).toThrow(
      /DISCORD_CATCHUP_MAX_MESSAGES/,
    );
    expect(() => discordCatchupConfigFromEnv({ DISCORD_CATCHUP_MAX_MESSAGES: '0' })).toThrow(
      /DISCORD_CATCHUP_MAX_MESSAGES/,
    );
  });
});

describe('snowflake helpers', () => {
  it('round-trips a unix timestamp through a synthetic snowflake', () => {
    const ms = 1753900000000; // well past the Discord epoch
    expect(snowflakeToUnixMs(unixMsToSnowflake(ms))).toBe(ms);
  });

  it('compares snowflakes numerically, not lexicographically', () => {
    expect(compareSnowflakes('999', '1000')).toBe(-1);
    expect(compareSnowflakes('1000', '999')).toBe(1);
    expect(compareSnowflakes('42', '42')).toBe(0);
  });
});

type FakeMessage = Record<string, unknown> & { id: string; type: number };

function restMessage(id: string, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    type: 0,
    channel_id: 'chan-1',
    content: `msg ${id}`,
    author: { id: 'user-1', bot: false },
    mentions: [],
    attachments: [],
    timestamp: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/**
 * Fake transport for both Discord REST (discord.com) and the local webhook.
 * `rest` maps URL substrings to queued responses (insertion order matters —
 * put more-specific needles first); webhook POSTs are recorded.
 * The fake webhook mirrors the production choke point (Task 10): it CLAIMS
 * each message and marks the row routed/failed, and answers a duplicate-drop
 * with 200 — because the engine verifies the ROW STATUS after every POST
 * (a bare 200 is not proof of routing, A16). The claim lease is zero-length
 * and stamped with the REAL clock: a failed row is immediately reclaimable by
 * the next in-test POST, while the sweep (which runs on the engine's injected
 * clock, kept EARLIER than the real clock in these tests) ignores it.
 */
function fakeTransport(rest: Record<string, Response[]>, webhookStatus: () => number = () => 200) {
  const webhookPosts: Array<{ type: string; data: Record<string, unknown> }> = [];
  const restCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/webhook')) {
      const event = JSON.parse(String(init?.body)) as { type: string; data: Record<string, unknown> };
      webhookPosts.push(event);
      const channelId = event.data.channel_id as string | undefined;
      const messageId = event.data.id as string | undefined;
      if (channelId && messageId) {
        const nowIso = new Date().toISOString();
        const claim = claimDiscordMessage(
          channelId,
          messageId,
          {
            guildId: (event.data.guild_id as string | undefined) ?? null,
            authorId: (event.data.author as { id?: string } | undefined)?.id ?? null,
            source: 'gateway',
          },
          nowIso,
          nowIso, // zero-length lease — see docblock
        );
        if (!claim.claimed) return new Response('{"ok":true}', { status: 200 }); // duplicate-drop -> 200 (wrapper behavior)
        const status = webhookStatus();
        if (status === 200) markDiscordMessageRouted(channelId, messageId, nowIso);
        else markDiscordMessageFailed(channelId, messageId, nowIso, `webhook ${status}`);
        return new Response(status === 200 ? '{"ok":true}' : '{"error":"internal"}', { status });
      }
      return new Response('{"ok":true}', { status: webhookStatus() });
    }
    restCalls.push(url);
    for (const [needle, queue] of Object.entries(rest)) {
      if (url.includes(needle) && queue.length > 0) return queue.shift() as Response;
    }
    return json([], 200);
  }) as typeof fetch;
  return { fetchImpl, webhookPosts, restCalls };
}

const CHANNEL_INFO = { id: 'chan-1', guild_id: 'guild-1', last_message_id: '500' };

function makeEngine(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}, nowMs = () => 1753900000000) {
  return createDiscordCatchup({
    botToken: 'test-token',
    webhookUrl: 'http://127.0.0.1:9999/webhook',
    monitoredChannelIds: () => new Set(['chan-1']),
    env,
    fetchImpl,
    sleep: async () => {},
    now: nowMs,
  });
}

describe('createDiscordCatchup runOnce', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('initializes a missing cursor at the channel head and routes nothing (first deploy)', async () => {
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('startup');
    expect(webhookPosts).toHaveLength(0);
    expect(summary?.routed).toBe(0);
    expect(getDiscordChannelCursor('chan-1')).toBe('500');
  });

  it('fetches after the cursor ascending, injects guild_id, and POSTs GATEWAY_MESSAGE_CREATE', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('502'), restMessage('501')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['501', '502']); // ascending despite API order
    expect(webhookPosts[0]?.type).toBe('GATEWAY_MESSAGE_CREATE');
    expect(webhookPosts[0]?.data.guild_id).toBe('guild-1');
    expect(summary?.routed).toBe(2);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('skips terminal messages but advances the cursor past them', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    claimDiscordMessage(
      'chan-1',
      '501',
      { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:02:00.000Z',
    );
    markDiscordMessageRouted('chan-1', '501', '2026-07-30T00:00:01.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501'), restMessage('502')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['502']);
    expect(summary?.skippedTerminal).toBe(1);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('skips non-routable message types (keeps 0 and 19) while advancing the cursor', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [
        json([restMessage('501', { type: 18 }), restMessage('502', { type: 19 }), restMessage('503', { type: 0 })]),
        json([]),
      ],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['502', '503']);
    expect(getDiscordChannelCursor('chan-1')).toBe('503');
  });

  it('respects DISCORD_CATCHUP_MAX_MESSAGES per channel per run', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501'), restMessage('502'), restMessage('503')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl, { DISCORD_CATCHUP_MAX_MESSAGES: '2' });
    await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['501', '502']);
    expect(getDiscordChannelCursor('chan-1')).toBe('502'); // remainder next run
  });

  it('backfills active threads whose parent is monitored, with their own cursors', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    advanceDiscordChannelCursor('thread-1', '600', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      '/guilds/guild-1/threads/active': [
        json({ threads: [{ id: 'thread-1', parent_id: 'chan-1', last_message_id: '601' }] }),
      ],
      '/channels/chan-1/messages': [json([])],
      '/channels/thread-1/messages': [json([restMessage('601', { channel_id: 'thread-1' })]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['601']);
    expect(summary?.threads).toBe(1);
    expect(getDiscordChannelCursor('thread-1')).toBe('601');
  });

  it('clamps a stale cursor to the max-age horizon', async () => {
    // Cursor far older than maxAge: with maxAge=1000ms and now=1753900000000,
    // the clamp floor is snowflake(now-1000). The engine must query with
    // after >= that floor, not the ancient cursor.
    advanceDiscordChannelCursor('chan-1', '1', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, restCalls } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl, { DISCORD_CATCHUP_MAX_AGE_MS: '1000' });
    await engine.runOnce('periodic');
    const messagesCall = restCalls.find((u) => u.includes('messages?after='));
    const after = new URL(messagesCall as string).searchParams.get('after') as string;
    expect(BigInt(after)).toBeGreaterThan(1n);
  });

  it('returns null and fetches nothing when DISCORD_CATCHUP_DISABLED=1', async () => {
    const { fetchImpl, restCalls } = fakeTransport({});
    const engine = makeEngine(fetchImpl, { DISCORD_CATCHUP_DISABLED: '1' });
    expect(await engine.runOnce('startup')).toBeNull();
    expect(restCalls).toHaveLength(0);
  });
});
