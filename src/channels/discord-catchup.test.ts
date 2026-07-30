import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
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
  getDiscordMessageRouteAttempts,
  getDiscordMessageRouteStatus,
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

  it('stops advancing the cursor at a POST failure and retries from there next run', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    let webhookOk = false;
    const { fetchImpl, webhookPosts } = fakeTransport(
      {
        '/channels/chan-1?': [json(CHANNEL_INFO)],
        'messages?after=': [
          json([restMessage('501'), restMessage('502')]),
          json([restMessage('501'), restMessage('502')]),
          json([]),
        ],
        '/channels/chan-1': [json(CHANNEL_INFO)],
      },
      () => (webhookOk ? 200 : 500),
    );
    const engine = makeEngine(fetchImpl);
    const first = await engine.runOnce('periodic');
    expect(first?.failed).toBe(1);
    expect(getDiscordChannelCursor('chan-1')).toBe('500'); // did not advance past the failure
    expect(webhookPosts.filter((p) => p.data.id === '502')).toHaveLength(0); // stopped at 501

    webhookOk = true;
    const second = await engine.runOnce('periodic');
    expect(second?.routed).toBe(2);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('treats an attempts-exhausted message as terminal and advances past it', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    // Simulate a poison message: the route row already burned all attempts
    // (each failed live/catch-up traversal claims then fails).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      claimDiscordMessage(
        'chan-1',
        '501',
        { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
        `2026-07-30T00:0${attempt}:00.000Z`,
        `2026-07-30T00:0${attempt}:30.000Z`,
      );
      markDiscordMessageFailed('chan-1', '501', `2026-07-30T00:0${attempt}:01.000Z`, 'poison');
    }
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501'), restMessage('502')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    // 501 is terminal (failed, attempts exhausted) -> skipped, cursor advances, 502 still routes
    expect(summary?.skippedTerminal).toBe(1);
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['502']);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('honors 429 Retry-After on REST fetches', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const sleeps: number[] = [];
    const { fetchImpl } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [
        new Response('{"retry_after":2}', { status: 429, headers: { 'Retry-After': '2' } }),
        json([restMessage('501')]),
        json([]),
      ],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = createDiscordCatchup({
      botToken: 'test-token',
      webhookUrl: 'http://127.0.0.1:9999/webhook',
      monitoredChannelIds: () => new Set(['chan-1']),
      env: {},
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1753900000000,
    });
    const summary = await engine.runOnce('periodic');
    expect(sleeps).toContain(2000); // Retry-After: 2s honored
    expect(summary?.routed).toBe(1);
  });

  it('prunes old routed rows on periodic runs only', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    // makeEngine's default clock is 1753900000000 = 2025-07-30T18:26:40Z, so
    // the periodic prune cutoff (now - 30d) is ~2025-06-30. The "ancient"
    // routed row must predate THAT cutoff — 2025-01-01, NOT a 2026 date
    // (2026 would be in the engine clock's future and never pruned).
    claimDiscordMessage(
      'chan-1',
      'ancient',
      { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:02:00.000Z',
    );
    markDiscordMessageRouted('chan-1', 'ancient', '2025-01-01T00:00:01.000Z');
    const transport = () =>
      fakeTransport({
        '/channels/chan-1?': [json(CHANNEL_INFO)],
        'messages?after=': [json([])],
        '/channels/chan-1': [json(CHANNEL_INFO)],
      });
    const countRows = () =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM discord_message_routes`).get() as { n: number }).n;

    await makeEngine(transport().fetchImpl).runOnce('ready');
    expect(countRows()).toBe(1); // ready runs do not prune
    await makeEngine(transport().fetchImpl).runOnce('periodic');
    expect(countRows()).toBe(0); // periodic runs prune >30-day routed rows
  });

  it('burns exactly ONE claim attempt per run on a persistent 500 (single-attempt POST)', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl } = fakeTransport(
      {
        '/channels/chan-1?': [json(CHANNEL_INFO)],
        'messages?after=': [json([restMessage('501')]), json([])],
        '/channels/chan-1': [json(CHANNEL_INFO)],
      },
      () => 500,
    );
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    // The claiming fake webhook saw exactly ONE claim: with the old 3-retry
    // POST this would be 3 — all attempts burned in ~1.3 s (A16 trace 1).
    expect(getDiscordMessageRouteAttempts('chan-1', '501')).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(getDiscordChannelCursor('chan-1')).toBe('500');
  });

  it('does not count a duplicate-drop 200 as routed (row-status verification)', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    // A live delivery of 501 is still in flight: processing row, unexpired lease.
    claimDiscordMessage(
      'chan-1',
      '501',
      { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
      '2026-07-30T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    );
    const { fetchImpl } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    // The webhook claim was refused (active lease) -> it answered 200 -> but
    // the row is NOT 'routed': the engine must not count it routed, mislabel
    // the source, or advance the cursor past a message that was never routed
    // (A16 trace 2 / its active-lease variant).
    expect(summary?.routed).toBe(0);
    expect(summary?.failed).toBe(1);
    expect(getDiscordMessageRouteStatus('chan-1', '501')).toBe('processing');
    expect(getDiscordChannelCursor('chan-1')).toBe('500');
  });

  it('sweeps a stranded failed row from BEHIND the cursor and re-routes it without moving the cursor', async () => {
    // A11 counterexample: live 498 failed (cursor untouched), then live 500
    // succeeded (cursor advanced past 498) -> the after=cursor walk can never
    // see 498 again. The sweep must re-present it.
    claimDiscordMessage(
      'chan-1',
      '498',
      { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:02:00.000Z',
    );
    markDiscordMessageFailed('chan-1', '498', '2026-07-30T00:00:01.000Z', 'transient dispatch error');
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:02.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([])],
      // Insertion order matters: this single-message needle must precede the
      // '/channels/chan-1' catch-all below.
      '/channels/chan-1/messages/498': [json(restMessage('498', { channel_id: 'chan-1' }))],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    // Engine clock past the KEPT lease (00:02) so the row is sweep-eligible.
    const engine = makeEngine(fetchImpl, {}, () => Date.parse('2026-07-30T01:00:00.000Z'));
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['498']);
    expect(webhookPosts[0]?.data.guild_id).toBe('guild-1'); // hard-required injection, in the sweep too
    expect(summary?.routed).toBe(1);
    expect(getDiscordMessageRouteStatus('chan-1', '498')).toBe('routed');
    expect(getDiscordChannelCursor('chan-1')).toBe('500'); // the sweep NEVER moves the cursor
  });
});

describe('createDiscordCatchup triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const db = initTestDb();
    runMigrations(db);
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  function timerEngine(env: NodeJS.ProcessEnv = {}) {
    // Empty pages: each run costs 1 channel-info fetch (first run only) + 1 messages fetch.
    const transport = fakeTransport({
      // Insertion order matters: this needle must precede the '/channels/chan-1' catch-all.
      'messages?after=': [json([]), json([]), json([])],
      '/channels/chan-1?': [json(CHANNEL_INFO), json(CHANNEL_INFO), json(CHANNEL_INFO)],
      '/channels/chan-1': [json(CHANNEL_INFO), json(CHANNEL_INFO), json(CHANNEL_INFO)],
    });
    const engine = createDiscordCatchup({
      botToken: 'test-token',
      webhookUrl: 'http://127.0.0.1:9999/webhook',
      monitoredChannelIds: () => new Set(['chan-1']),
      env,
      fetchImpl: transport.fetchImpl,
      sleep: async () => {},
      now: () => Date.now(), // fake-timer controlled
    });
    return { engine, transport };
  }

  const messagesCalls = (transport: ReturnType<typeof fakeTransport>) =>
    transport.restCalls.filter((u) => u.includes('/messages?after=')).length;

  it('debounces a READY burst into a single run and ignores GATEWAY_RESUMED', async () => {
    const { engine, transport } = timerEngine();
    engine.onGatewayEvent('GATEWAY_READY');
    engine.onGatewayEvent('GATEWAY_READY');
    engine.onGatewayEvent('GATEWAY_RESUMED');
    engine.onGatewayEvent('GATEWAY_READY');
    await vi.advanceTimersByTimeAsync(14999);
    expect(messagesCalls(transport)).toBe(0); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(20000);
    expect(messagesCalls(transport)).toBe(1); // exactly one coalesced run
    engine.stop();
  });

  it('start() runs startup immediately and then periodically', async () => {
    const { engine, transport } = timerEngine({ DISCORD_CATCHUP_INTERVAL_MS: '60000' });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messagesCalls(transport)).toBe(1); // startup run
    await vi.advanceTimersByTimeAsync(60000);
    expect(messagesCalls(transport)).toBe(2); // first periodic run
    engine.stop();
    await vi.advanceTimersByTimeAsync(180000);
    expect(messagesCalls(transport)).toBe(2); // stop() disarms the timer
  });

  it('interval 0 disables the periodic timer but not the startup run', async () => {
    const { engine, transport } = timerEngine({ DISCORD_CATCHUP_INTERVAL_MS: '0' });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messagesCalls(transport)).toBe(1);
    await vi.advanceTimersByTimeAsync(3600000);
    expect(messagesCalls(transport)).toBe(1);
    engine.stop();
  });

  it('kill switch disables start() and onGatewayEvent()', async () => {
    const { engine, transport } = timerEngine({ DISCORD_CATCHUP_DISABLED: '1' });
    engine.start();
    engine.onGatewayEvent('GATEWAY_READY');
    await vi.advanceTimersByTimeAsync(600000);
    expect(transport.restCalls).toHaveLength(0);
    engine.stop();
  });

  it('single-flight: concurrent runOnce calls share one run', async () => {
    vi.useRealTimers();
    const { engine, transport } = timerEngine();
    const [a, b] = await Promise.all([engine.runOnce('periodic'), engine.runOnce('ready')]);
    expect(a).toBe(b); // coalesced into the same run/promise result
    expect(messagesCalls(transport)).toBe(1);
  });
});
