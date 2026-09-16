/**
 * End-to-end (in-process) proof of the catch-up story:
 * gateway gap -> catch-up fetches the missed message via REST -> POSTs a
 * synthesized GATEWAY_MESSAGE_CREATE to a real local webhook server (standing
 * in for the chat-sdk-bridge server, which dispatches event.data to
 * handleForwardedMessage exactly like the vendored adapter does) -> the
 * wrapped choke point claims, auto-creates the thread, and forwards ->
 * duplicates are dropped everywhere.
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createDiscordCatchup, unixMsToSnowflake } from './discord-catchup.js';
import { wrapYenteDiscordChannelIds } from './discord.js';
import { advanceDiscordChannelCursor, getDiscordChannelCursor } from './discord-state.js';

const CHANNEL = '1516341314621276171'; // the incident channel
const GUILD = 'guild-1';

// The engine clamps stale cursors to now - 72h (default maxAgeMs), and the
// REST fake below keys pages on the EXACT `after` value — so the cursor and
// message ids MUST be realistic snowflakes inside the 72h window of the
// injected clock. Toy ids like '600'/'601' decode to ~2015 timestamps: the
// clamp would rewrite the cursor and the fake would return [] for everything.
const NOW_MS = 1753900000000;
const CURSOR = unixMsToSnowflake(NOW_MS - 60 * 60 * 1000); // 1h before "now"
const MSG_1 = unixMsToSnowflake(NOW_MS - 30 * 60 * 1000);
const MSG_2 = unixMsToSnowflake(NOW_MS - 15 * 60 * 1000);

function restMessage(id: string): Record<string, unknown> {
  return {
    id,
    type: 0,
    channel_id: CHANNEL,
    content: `missed ${id}`,
    author: { id: 'dan', bot: false },
    mentions: [],
    attachments: [],
    timestamp: '2026-07-30T00:00:00.000Z',
  };
}

describe('discord catch-up integration: gap message routed exactly once', () => {
  let server: http.Server;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(async () => {
    closeDb();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function startWebhookServer(
    dispatch: (event: { type: string; data: Record<string, unknown> }) => Promise<unknown>,
  ): Promise<http.Server> {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const event = JSON.parse(Buffer.concat(chunks).toString()) as {
            type: string;
            data: Record<string, unknown>;
          };
          void dispatch(event).then(
            () => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end('{"ok":true}');
            },
            () => {
              res.writeHead(500);
              res.end('{"error":"internal"}');
            },
          );
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
  }

  function serverUrl(srv: http.Server): string {
    const port = (srv.address() as { port: number }).port;
    return `http://127.0.0.1:${port}/webhook`;
  }

  it('recovers a missed auto-thread-channel message with a thread, then drops the live duplicate', async () => {
    // --- the production ingress choke point, on a fake vendored adapter ---
    const inner = {
      handleForwardedMessage: vi.fn(async (..._args: unknown[]) => 'handled'),
      createDiscordThread: vi.fn(async () => ({ id: 'thread-new' })),
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      channelIdFromThreadId: (threadId: string) => threadId,
    };
    // Wrapping replaces the adapter's handleForwardedMessage property in place
    // (required in production: the vendored adapter dispatches to
    // this.handleForwardedMessage internally), so capture the inner spy before
    // wrapping to assert on actual forwards.
    const forwardSpy = inner.handleForwardedMessage;
    const wrapped = wrapYenteDiscordChannelIds(
      inner as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set([CHANNEL]),
      {
        monitoredChannelIds: () => new Set([CHANNEL]),
        routeLeaseMs: 120000,
        // Matches this fake adapter's semantics: its handleForwardedMessage always "handles" the message.
        wasMessageHandled: () => true,
      },
    ) as unknown as { handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown> };

    // --- a REAL local webhook server, dispatching like the bridge + vendored adapter ---
    server = await startWebhookServer((event) => wrapped.handleForwardedMessage(event.data, {}));
    const webhookUrl = serverUrl(server);

    // --- fake Discord REST; real fetch for the loopback webhook ---
    const pages: Record<string, unknown[]> = { [CURSOR]: [restMessage(MSG_1), restMessage(MSG_2)], [MSG_2]: [] };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1')) return fetch(input as never, init);
      if (url.includes(`/channels/${CHANNEL}/messages`)) {
        const after = new URL(url).searchParams.get('after') ?? '';
        return new Response(JSON.stringify(pages[after] ?? []), { status: 200 });
      }
      if (url.includes(`/channels/${CHANNEL}`)) {
        return new Response(JSON.stringify({ id: CHANNEL, guild_id: GUILD, last_message_id: MSG_2 }), { status: 200 });
      }
      if (url.includes('/threads/active')) return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    // The gap: the cursor sits 1h back; MSG_1 and MSG_2 arrived while disconnected.
    advanceDiscordChannelCursor(CHANNEL, CURSOR, '2026-07-30T00:00:00.000Z');

    const engine = createDiscordCatchup({
      botToken: 'test-token',
      botUserId: 'bot-1',
      webhookUrl,
      monitoredChannelIds: () => new Set([CHANNEL]),
      env: {},
      fetchImpl,
      sleep: async () => {},
      now: () => NOW_MS, // pins the 72h clamp window CURSOR/MSG_1/MSG_2 are built against
    });

    const summary = await engine.runOnce('ready');

    // Exactly-once routing with auto-thread creation, in order.
    expect(summary?.routed).toBe(2);
    expect(forwardSpy).toHaveBeenCalledTimes(2);
    expect(inner.createDiscordThread).toHaveBeenCalledTimes(2);
    const first = forwardSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(first.id).toBe(MSG_1);
    expect(first.guild_id).toBe(GUILD); // injected for thread-id derivation
    expect(first.thread).toEqual({ id: 'thread-new', parent_id: CHANNEL });
    expect(getDiscordChannelCursor(CHANNEL)).toBe(MSG_2);

    // Route rows are terminal and attributed to catch-up.
    const rows = getDb()
      .prepare(`SELECT message_id, status, source FROM discord_message_routes ORDER BY message_id`)
      .all() as Array<{ message_id: string; status: string; source: string }>;
    // MSG_1 and MSG_2 are same-length snowflakes, so ORDER BY message_id
    // (lexicographic) matches numeric order here.
    expect(rows).toEqual([
      { message_id: MSG_1, status: 'routed', source: 'catchup' },
      { message_id: MSG_2, status: 'routed', source: 'catchup' },
    ]);

    // NO-DUPLICATE: a late live gateway replay of MSG_1 is dropped at the choke point.
    await wrapped.handleForwardedMessage(restMessage(MSG_1), {});
    expect(forwardSpy).toHaveBeenCalledTimes(2); // unchanged
    expect(inner.createDiscordThread).toHaveBeenCalledTimes(2); // no second thread

    // Restart idempotency: a second run finds nothing new and routes nothing.
    const second = await engine.runOnce('periodic');
    expect(second?.routed).toBe(0);
    expect(forwardSpy).toHaveBeenCalledTimes(2);
  });

  it('recovers a missed in-thread message with thread context and advances the thread cursor at the choke point', async () => {
    // 2026-09-16 incident shape: a user message arrived in an ACTIVE thread
    // of a monitored channel while the service was restarting. Pre-fix, the
    // synthesized payload lost the thread context, the choke point could not
    // see the monitored parent, and the message vanished behind a terminal
    // 'routed' row.
    const THREAD = '1549090599121059931'; // the incident thread
    // Distinct from CURSOR (the channel cursor): the REST fake below keys
    // pages on the EXACT `after` snowflake alone, so the thread and channel
    // cursors must differ or their first pages collide.
    const THREAD_CURSOR = unixMsToSnowflake(NOW_MS - 45 * 60 * 1000);
    const MSG_T1 = unixMsToSnowflake(NOW_MS - 30 * 60 * 1000);
    const threadRestMessage = (id: string): Record<string, unknown> => ({
      id,
      type: 0,
      channel_id: THREAD,
      content: `missed thread message ${id}`,
      author: { id: 'dan', bot: false },
      mentions: [],
      attachments: [],
      timestamp: '2026-07-30T00:00:00.000Z',
    });

    const inner = {
      handleForwardedMessage: vi.fn(async (..._args: unknown[]) => 'handled'),
      createDiscordThread: vi.fn(async () => ({ id: 'thread-new' })),
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      channelIdFromThreadId: (threadId: string) => threadId,
    };
    const forwardSpy = inner.handleForwardedMessage;
    const wrapped = wrapYenteDiscordChannelIds(
      inner as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set([]), // no auto-thread channels: this thread pre-exists
      {
        monitoredChannelIds: () => new Set([CHANNEL]),
        routeLeaseMs: 120000,
        wasMessageHandled: () => true,
      },
    ) as unknown as { handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown> };

    server = await startWebhookServer((event) => wrapped.handleForwardedMessage(event.data, {}));
    const webhookUrl = serverUrl(server);

    const pages: Record<string, unknown[]> = {
      [THREAD_CURSOR]: [threadRestMessage(MSG_T1)],
      [MSG_T1]: [],
      [CURSOR]: [], // parent channel has nothing new
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1')) return fetch(input as never, init);
      if (url.includes(`/channels/${THREAD}/messages`)) {
        const after = new URL(url).searchParams.get('after') ?? '';
        return new Response(JSON.stringify(pages[after] ?? []), { status: 200 });
      }
      if (url.includes(`/channels/${CHANNEL}/messages`)) {
        const after = new URL(url).searchParams.get('after') ?? '';
        return new Response(JSON.stringify(pages[after] ?? []), { status: 200 });
      }
      if (url.includes('/threads/active')) {
        return new Response(
          JSON.stringify({ threads: [{ id: THREAD, parent_id: CHANNEL, last_message_id: MSG_T1 }] }),
          { status: 200 },
        );
      }
      if (url.includes(`/channels/${CHANNEL}`)) {
        return new Response(JSON.stringify({ id: CHANNEL, guild_id: GUILD, last_message_id: MSG_1 }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    // The gap: the channel cursor sits 1h back, the thread cursor 45min back;
    // MSG_T1 arrived in the thread while the gateway was down.
    advanceDiscordChannelCursor(CHANNEL, CURSOR, '2026-07-30T00:00:00.000Z');
    advanceDiscordChannelCursor(THREAD, THREAD_CURSOR, '2026-07-30T00:00:00.000Z');

    const engine = createDiscordCatchup({
      botToken: 'test-token',
      botUserId: 'bot-1',
      webhookUrl,
      monitoredChannelIds: () => new Set([CHANNEL]),
      env: {},
      fetchImpl,
      sleep: async () => {},
      now: () => NOW_MS,
    });

    const summary = await engine.runOnce('ready');

    // The missed thread message is presented WITH thread context.
    expect(summary?.routed).toBe(1);
    expect(summary?.threads).toBe(1);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    const presented = forwardSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(presented.thread).toEqual({ id: THREAD, parent_id: CHANNEL });
    expect(presented.guild_id).toBe(GUILD);
    // Thread context means the choke point treats it as already-in-thread:
    // no auto-thread attempt from a thread message.
    expect(inner.createDiscordThread).not.toHaveBeenCalled();
    // The choke point sees the monitored parent and advances the THREAD cursor
    // (monitored.has(data.thread.parent_id)) — the same bookkeeping live
    // in-thread traffic gets.
    expect(getDiscordChannelCursor(THREAD)).toBe(MSG_T1);

    const rows = getDb()
      .prepare(`SELECT message_id, status, source FROM discord_message_routes ORDER BY message_id`)
      .all() as Array<{ message_id: string; status: string; source: string }>;
    expect(rows).toEqual([{ message_id: MSG_T1, status: 'routed', source: 'catchup' }]);

    // Restart idempotency: nothing new on the second run.
    const second = await engine.runOnce('periodic');
    expect(second?.routed).toBe(0);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });
});
