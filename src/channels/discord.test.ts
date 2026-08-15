import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message, parseMarkdown } from 'chat';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { inboundDbPath, resolveSession, writeSessionMessage } from '../session-manager.js';
import { log } from '../log.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import {
  createDiscordHandledTracker,
  forwardDiscordGatewayEventWithRetry,
  monitoredDiscordChannelIds,
  normalizeDiscordOutboundMarkdown,
  toDiscordThreadId,
  wrapYenteDiscordChannelIds,
  yenteDiscordPlatformIdFromThreadId,
} from './discord.js';
import {
  getDiscordChannelCursor,
  getDiscordMessageRouteAttempts,
  getDiscordMessageRouteStatus,
  isDiscordMessageTerminal,
  listRetriableDiscordMessageRoutes,
} from './discord-state.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-discord-data',
    GROUPS_DIR: '/tmp/nanoclaw-test-discord-groups',
  };
});

const TEST_DATA_DIR = '/tmp/nanoclaw-test-discord-data';
const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-discord-groups';

function now(): string {
  return new Date().toISOString();
}

describe('Discord attachment contract', () => {
  beforeEach(() => {
    for (const dir of [TEST_DATA_DIR, TEST_GROUPS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-discord',
      name: 'Discord Agent',
      folder: 'discord-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'discord:guild:channel',
      name: 'Discord',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    for (const dir of [TEST_DATA_DIR, TEST_GROUPS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('materializes inbound files under the Discord workspace path', () => {
    const { session } = resolveSession('ag-discord', 'mg-discord', 'thread-1', 'per-thread');
    writeSessionMessage('ag-discord', session.id, {
      id: 'discord-msg-1',
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'discord:guild:channel',
      channelType: 'discord',
      threadId: 'thread-1',
      content: JSON.stringify({
        text: 'file',
        attachments: [
          {
            id: 'file-1',
            name: 'image.png',
            mimeType: 'image/png',
            data: Buffer.from('discord-file').toString('base64'),
          },
        ],
      }),
    });

    const hostPath = path.join(
      TEST_GROUPS_DIR,
      'discord-agent',
      'attachments',
      'discord',
      'discord-msg-1',
      'file-1-image.png',
    );
    expect(fs.readFileSync(hostPath, 'utf8')).toBe('discord-file');

    const db = new Database(inboundDbPath('ag-discord', session.id));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('discord-msg-1') as { content: string };
    db.close();
    expect(JSON.parse(row.content).text).toContain(
      '/workspace/agent/attachments/discord/discord-msg-1/file-1-image.png',
    );
  });
});

describe('Discord v1 channel-id compatibility', () => {
  it('uses the v1 channel id as the Yente platform id for encoded Discord thread ids', () => {
    expect(yenteDiscordPlatformIdFromThreadId('discord:guild-1:channel-1')).toBe('channel-1');
    expect(yenteDiscordPlatformIdFromThreadId('discord:guild-1:channel-1:thread-1')).toBe('channel-1');
    expect(yenteDiscordPlatformIdFromThreadId('channel-1')).toBe('channel-1');
  });

  it('resolves v1 channel ids to Chat SDK Discord thread ids for outbound delivery', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), {
        status: 200,
      }),
    );

    await expect(toDiscordThreadId('channel-1', 'bot-token')).resolves.toBe('discord:guild-1:channel-1');

    expect(globalThis.fetch).toHaveBeenCalledWith('https://discord.com/api/v10/channels/channel-1', {
      method: 'GET',
      headers: { Authorization: 'Bot bot-token' },
    });
    globalThis.fetch = originalFetch;
  });
});

describe('Discord outbound Markdown normalization', () => {
  it('rewrites URL-labeled Google Docs links with a plaintext label', () => {
    const url = 'https://docs.google.com/document/d/abc123/edit';

    expect(normalizeDiscordOutboundMarkdown(`The doc is at [${url}](${url}).`)).toBe(
      `The doc is at [Google Doc](${url}).`,
    );
  });

  it('rewrites bare Google Docs URLs before Discord autolink rendering', () => {
    const url = 'https://docs.google.com/document/d/1haogfNkDIsknGWbWcBoKtDL_afj2rDBKKJhamyG2zcU';

    expect(
      normalizeDiscordOutboundMarkdown(
        `Fable 5 rerun is complete. The new doc is at ${url} — both summaries are in there.`,
      ),
    ).toBe(`Fable 5 rerun is complete. The new doc is at [Google Doc](${url}) — both summaries are in there.`);
  });

  it('rewrites generic URL-labeled links without changing the target', () => {
    const url = 'https://example.com/report?run=1';

    expect(normalizeDiscordOutboundMarkdown(`[${url}](${url})`)).toBe(`[link](${url})`);
  });

  it('rewrites bare generic URLs and preserves trailing sentence punctuation', () => {
    const url = 'https://example.com/report?run=1';

    expect(normalizeDiscordOutboundMarkdown(`See ${url}.`)).toBe(`See [link](${url}).`);
  });

  it('rewrites angle-bracket autolinks as masked links', () => {
    const url = 'https://docs.google.com/spreadsheets/d/abc123/edit';

    expect(normalizeDiscordOutboundMarkdown(`Sheet: <${url}>`)).toBe(`Sheet: [Google Sheet](${url})`);
  });

  it('leaves already descriptive masked links unchanged', () => {
    const url = 'https://docs.google.com/document/d/abc123/edit';

    expect(normalizeDiscordOutboundMarkdown(`[summary doc](${url})`)).toBe(`[summary doc](${url})`);
  });

  it('does not rewrite markdown examples inside code spans or fenced code blocks', () => {
    const url = 'https://docs.google.com/document/d/abc123/edit';
    const text = [
      `Inline \`[${url}](${url})\` stays literal.`,
      '```md',
      `[${url}](${url})`,
      '```',
      `Inline raw \`${url}\` stays literal.`,
      `Outside [${url}](${url}) changes.`,
    ].join('\n');

    expect(normalizeDiscordOutboundMarkdown(text)).toBe(
      [
        `Inline \`[${url}](${url})\` stays literal.`,
        '```md',
        `[${url}](${url})`,
        '```',
        `Inline raw \`${url}\` stays literal.`,
        `Outside [Google Doc](${url}) changes.`,
      ].join('\n'),
    );
  });

  it('still escapes numbered-list lines that Discord would autoformat', () => {
    expect(normalizeDiscordOutboundMarkdown('1.\n2.')).toBe('1\\.\n2\\.');
  });
});

describe('forwardDiscordGatewayEventWithRetry', () => {
  const EVENT = { type: 'GATEWAY_MESSAGE_CREATE' };
  const URL = 'http://127.0.0.1:9999/webhook';
  const noSleep = async () => {};

  function okResponse(): Response {
    return { ok: true, status: 200, text: async () => '' } as unknown as Response;
  }

  function errorResponse(status: number, body = 'boom'): Response {
    return { ok: false, status, text: async () => body } as unknown as Response;
  }

  function fetchFailed(): TypeError {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = cause;
    return err;
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('retries a transient network failure and forwards exactly once, WARN but no ERROR', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(okResponse());
    const sleeps: number[] = [];

    await forwardDiscordGatewayEventWithRetry(URL, EVENT, 'bot-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([250]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Transient error forwarding Gateway event, retrying',
      expect.objectContaining({ attempt: 1, type: EVENT.type }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    // The forward request is preserved verbatim across the retry.
    expect(fetchImpl).toHaveBeenLastCalledWith(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': 'bot-token' },
      body: JSON.stringify(EVENT),
    });
  });

  it('gives up with ERROR after 3 network failures (backoff 250ms then 1000ms)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(fetchFailed());
    const sleeps: number[] = [];

    await forwardDiscordGatewayEventWithRetry(URL, EVENT, 'bot-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([250, 1000]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Error forwarding Gateway event',
      expect.objectContaining({ attempt: 3, type: EVENT.type }),
    );
  });

  it('does NOT retry a 4xx response — immediate ERROR', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(400, 'bad request'));

    await forwardDiscordGatewayEventWithRetry(URL, EVENT, 'bot-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to forward Gateway event',
      expect.objectContaining({ status: 400, attempt: 1, type: EVENT.type }),
    );
  });

  it('retries a 5xx response and succeeds without ERROR', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(503, 'unavailable'))
      .mockResolvedValueOnce(okResponse());

    await forwardDiscordGatewayEventWithRetry(URL, EVENT, 'bot-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry a non-transient thrown error — immediate ERROR', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('certificate has expired'));

    await forwardDiscordGatewayEventWithRetry(URL, EVENT, 'bot-token', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Error forwarding Gateway event', expect.objectContaining({ attempt: 1 }));
  });

  it('resolves true when the webhook accepts the event', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
      }),
    ).resolves.toBe(true);
  });

  it('resolves false after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
      }),
    ).resolves.toBe(false);
  });

  it('resolves false immediately on 4xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one attempt when retryDelaysMs is empty (engine mode)', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
        retryDelaysMs: [],
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('wrapYenteDiscordChannelIds ingress claim', () => {
  function fakeAdapter() {
    return {
      handleForwardedMessage: vi.fn(async (..._args: unknown[]) => 'handled'),
      createDiscordThread: vi.fn(async () => ({ id: 'thread-9' })),
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      channelIdFromThreadId: (threadId: string) => threadId,
    };
  }

  function wrap(
    fake: ReturnType<typeof fakeAdapter>,
    autoThread: string[] = [],
    monitored: string[] = ['chan-1'],
    // Default matches this fake adapter's semantics: its handleForwardedMessage always "handles" the message.
    wasMessageHandled: (messageId: string) => boolean = () => true,
  ) {
    return wrapYenteDiscordChannelIds(
      fake as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set(autoThread),
      { monitoredChannelIds: () => new Set(monitored), routeLeaseMs: 120000, wasMessageHandled },
    ) as unknown as {
      handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown>;
      forwardGatewayEvent: (webhookUrl: string, event: { type: string }) => Promise<void>;
    };
  }

  const message = (id: string, channelId = 'chan-1'): Record<string, unknown> => ({
    id,
    channel_id: channelId,
    guild_id: 'guild-1',
    author: { id: 'user-1', bot: false },
    content: 'hello',
    mentions: [],
    attachments: [],
  });

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it('claims before forwarding and drops a duplicate of the same channel+message', async () => {
    const fake = fakeAdapter();
    // Wrapping replaces the adapter's handleForwardedMessage property in place,
    // so capture the inner spy before wrapping to assert on actual forwards.
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake);
    await wrapped.handleForwardedMessage(message('m1'), {});
    await wrapped.handleForwardedMessage(message('m1'), {});
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    expect(isDiscordMessageTerminal('chan-1', 'm1')).toBe(true); // routed
  });

  it('advances the channel cursor for monitored channels after a successful route', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake);
    await wrapped.handleForwardedMessage(message('777'), {});
    expect(getDiscordChannelCursor('chan-1')).toBe('777');
  });

  it('does not advance a cursor for unmonitored channels (still claims)', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake, [], ['other-chan']);
    await wrapped.handleForwardedMessage(message('778'), {});
    expect(getDiscordChannelCursor('chan-1')).toBeNull();
    expect(isDiscordMessageTerminal('chan-1', '778')).toBe(true);
  });

  it('still creates auto-threads (after the claim) for auto-thread channels', async () => {
    const fake = fakeAdapter();
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake, ['chan-1']);
    await wrapped.handleForwardedMessage(message('m2'), {});
    expect(fake.createDiscordThread).toHaveBeenCalledWith('chan-1', 'm2');
    const forwarded = forwardSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(forwarded.thread).toEqual({ id: 'thread-9', parent_id: 'chan-1' });
  });

  it('marks the route failed (keeping the lease) and rethrows; immediate retries drop, post-lease retries route', async () => {
    const fake = fakeAdapter();
    const forwardSpy = fake.handleForwardedMessage;
    forwardSpy.mockRejectedValueOnce(new Error('dispatch exploded'));
    let nowMs = Date.parse('2026-07-30T00:00:00.000Z');
    const wrapped = wrapYenteDiscordChannelIds(
      fake as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set(),
      {
        monitoredChannelIds: () => new Set(['chan-1']),
        routeLeaseMs: 120000,
        now: () => new Date(nowMs).toISOString(),
        // Matches this fake adapter's semantics: its handleForwardedMessage always "handles" the message.
        wasMessageHandled: () => true,
      },
    ) as unknown as { handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown> };
    await expect(wrapped.handleForwardedMessage(message('m3'), {})).rejects.toThrow('dispatch exploded');
    expect(isDiscordMessageTerminal('chan-1', 'm3')).toBe(false); // failed but reclaimable
    expect(getDiscordMessageRouteAttempts('chan-1', 'm3')).toBe(1);
    // An IMMEDIATE retry (the live forwarder's 250ms/1000ms re-POSTs) hits the
    // KEPT lease -> duplicate-dropped: no attempt burned, nothing forwarded (A16).
    await wrapped.handleForwardedMessage(message('m3'), {});
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    expect(getDiscordMessageRouteAttempts('chan-1', 'm3')).toBe(1);
    expect(isDiscordMessageTerminal('chan-1', 'm3')).toBe(false);
    // After the lease expires (catch-up arrives minutes later) it re-claims and routes.
    nowMs += 120001;
    await wrapped.handleForwardedMessage(message('m3'), {});
    expect(isDiscordMessageTerminal('chan-1', 'm3')).toBe(true);
  });

  it('fails open: routes the message even when the claim state is unavailable', async () => {
    const errorSpy = vi.spyOn(log, 'error');
    const fake = fakeAdapter();
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake);
    closeDb(); // simulate DB outage: getDb() now throws
    await wrapped.handleForwardedMessage(message('m4'), {});
    expect(forwardSpy).toHaveBeenCalledTimes(1); // routed anyway
    expect(errorSpy).toHaveBeenCalled();
    initTestDb(); // restore for afterEach symmetry
  });

  it('passes non-message payloads through untouched', async () => {
    const fake = fakeAdapter();
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake);
    await wrapped.handleForwardedMessage({ some: 'interaction' }, {});
    expect(forwardSpy).toHaveBeenCalledWith({ some: 'interaction' }, {});
  });

  it('taps gateway event types before forwarding', async () => {
    // Stub fetch so the forwards don't hit the real network (and never retry/WARN after the test ends).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    try {
      const fake = fakeAdapter();
      const seen: string[] = [];
      wrapYenteDiscordChannelIds(
        fake as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
        'test-token',
        new Set(),
        {
          onGatewayEvent: (type) => seen.push(type),
          // Matches this fake adapter's semantics: its handleForwardedMessage always "handles" the message.
          wasMessageHandled: () => true,
        },
      );
      const forward = (fake as unknown as { forwardGatewayEvent: (url: string, e: { type: string }) => Promise<void> })
        .forwardGatewayEvent;
      const p1 = forward('http://127.0.0.1:1/webhook', { type: 'GATEWAY_READY' });
      const p2 = forward('http://127.0.0.1:1/webhook', { type: 'GATEWAY_RESUMED' });
      // The tap fires synchronously, before the forwards settle.
      expect(seen).toEqual(['GATEWAY_READY', 'GATEWAY_RESUMED']); // tap sees everything; filtering is the engine's job
      await Promise.all([p1, p2]); // cleanup: no floating promises outlive the test
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marks a message failed, not routed, when no dispatch handler accepted it', async () => {
    const fake = fakeAdapter();
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake, [], ['chan-1'], () => false);
    const cursorBefore = getDiscordChannelCursor('chan-1');

    await wrapped.handleForwardedMessage(message('m-unhandled'), {});

    expect(forwardSpy).toHaveBeenCalledTimes(1); // message is still forwarded to the SDK
    expect(getDiscordMessageRouteStatus('chan-1', 'm-unhandled')).toBe('failed');
    expect(isDiscordMessageTerminal('chan-1', 'm-unhandled')).toBe(false);
    expect(getDiscordChannelCursor('chan-1')).toBe(cursorBefore); // cursor not advanced

    // Catch-up eligibility: failed + attempts < max + lease expired (lease is 120s).
    const horizon = '2020-01-01T00:00:00.000Z';
    const afterLease = new Date(Date.now() + 121_000).toISOString();
    expect(listRetriableDiscordMessageRoutes(afterLease, horizon, 50).map((r) => r.message_id)).toContain(
      'm-unhandled',
    );
  });

  it("bypasses the ledger and the SDK entirely for the bot's own messages", async () => {
    const fake = { ...fakeAdapter(), botUserId: 'bot-1' };
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake, [], ['chan-1'], () => false);
    const cursorBefore = getDiscordChannelCursor('chan-1');
    const ownMessage = { ...message('m-own'), author: { id: 'bot-1', bot: true } };

    const result = await wrapped.handleForwardedMessage(ownMessage, {});

    expect(result).toBeUndefined();
    // The SDK filters isMe messages pre-dispatch, so forwarding them is
    // pointless — and no ledger row may exist for a message no dispatch
    // handler could ever accept (the requested invariant).
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(getDiscordMessageRouteStatus('chan-1', 'm-own')).toBeNull();
    expect(getDiscordChannelCursor('chan-1')).toBe(cursorBefore);
  });
});

describe('monitoredDiscordChannelIds', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('unions registered discord channels (normalized) with auto-thread channels, excluding quarantined', () => {
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'discord:guild-1:chan-a',
      name: 'a',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: '2026-07-30T00:00:00.000Z',
    });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'chan-b',
      name: 'b',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: '2026-07-30T00:00:00.000Z',
    });
    createMessagingGroup({
      id: 'mg-3',
      channel_type: 'discord',
      platform_id: 'quarantined:chan-c',
      name: 'c',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: '2026-07-30T00:00:00.000Z',
    });
    expect(monitoredDiscordChannelIds(new Set(['chan-d']))).toEqual(new Set(['chan-a', 'chan-b', 'chan-d']));
  });
});

describe('dedupeTtlForRouteLease', () => {
  it('derives a dedupe TTL never zero, strictly below for every lease >= 2 ms', async () => {
    const mod = (await import('./discord.js')) as unknown as {
      dedupeTtlForRouteLease?: (routeLeaseMs: number) => number;
    };
    if (!mod.dedupeTtlForRouteLease) throw new Error('dedupeTtlForRouteLease not exported');
    const derive = mod.dedupeTtlForRouteLease;
    expect(derive(120_000)).toBe(30_000); // default lease
    expect(derive(100)).toBe(25);
    expect(derive(3)).toBe(1); // clamped: 0 would mean permanent dedupe in the SDK
    expect(derive(1)).toBe(1);
    for (const lease of [2, 3, 4, 5, 8, 100, 120_000]) {
      expect(derive(lease)).toBeLessThan(lease);
    }
  });
});

describe('discord ingress chain: bridge dispatch → acceptance hook → ledger', () => {
  it('marks routed only when the real dispatch chain accepted the message', async () => {
    const db = initTestDb();
    runMigrations(db);
    const onInbound = vi.fn().mockResolvedValue(undefined);
    // Same tracker constructor as the production factory; bridge hook writes,
    // wrapper consults via consume-on-read delete.
    const tracker = createDiscordHandledTracker();
    let captured: {
      handleIncomingMessage(adapter: unknown, threadId: string, message: Message): Promise<void>;
    } | null = null;
    const fake = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async (chat: unknown) => {
        captured = chat as never;
      },
      channelIdFromThreadId: (threadId: string) => threadId,
      startGatewayListener: async () => new Response('ok'),
      // The wrapper binds the outbound methods at wrap time; stub them like fakeAdapter().
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      // Mirrors the vendored adapter: its forward awaits chat.handleIncomingMessage.
      handleForwardedMessage: vi.fn(
        async (data: { id: string; channel_id: string; author: { id: string }; content: string }) => {
          const driver = captured; // closure assignment defeats narrowing; re-check
          if (!driver) throw new Error('Chat SDK did not initialize the adapter');
          await driver.handleIncomingMessage(
            fake,
            data.channel_id,
            new Message({
              id: data.id,
              threadId: data.channel_id,
              text: data.content,
              formatted: parseMarkdown(data.content),
              raw: data,
              author: {
                userId: data.author.id,
                userName: data.author.id,
                fullName: data.author.id,
                isBot: false,
                isMe: false,
              },
              metadata: { dateSent: new Date(), edited: false },
              attachments: [],
            }),
          );
          return 'handled';
        },
      ),
    };
    const wrappedAdapter = wrapYenteDiscordChannelIds(fake as never, 'test-token', new Set(), {
      monitoredChannelIds: () => new Set(['chan-1']),
      routeLeaseMs: 120000,
      wasMessageHandled: tracker.wasHandled,
    });
    // Same structural cast as the wrap() helper: handleForwardedMessage is
    // private on the vendored adapter's class type.
    const wrapped = wrappedAdapter as unknown as {
      handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown>;
    };
    const bridge = createChatSdkBridge({
      adapter: wrappedAdapter as never,
      supportsThreads: true,
      botToken: 'test-token',
      onInboundForwarded: tracker.noteHandled,
    });
    try {
      await bridge.setup({
        onInbound,
        onInboundEvent: async () => {},
        onMetadata: async () => {},
        onAction: async () => {},
      } as never);
      if (!captured) throw new Error('Chat SDK did not initialize the adapter');

      await wrapped.handleForwardedMessage(
        {
          id: 'm-chain',
          channel_id: 'chan-1',
          guild_id: 'guild-1',
          author: { id: 'user-1', bot: false },
          content: 'hello',
          mentions: [],
          attachments: [],
        },
        {},
      );

      // A real dispatch handler accepted the message.
      expect(onInbound).toHaveBeenCalledTimes(1);
      // The wrapper consumed the acceptance signal (regression pin: pre-fix
      // the wrapper never consults the probe, so the entry is still pending
      // and this second consult observes it).
      expect(tracker.wasHandled('m-chain')).toBe(false);
      // ...so the ledger says routed and the monitored cursor advanced.
      expect(getDiscordMessageRouteStatus('chan-1', 'm-chain')).toBe('routed');
      expect(isDiscordMessageTerminal('chan-1', 'm-chain')).toBe(true);
      expect(getDiscordChannelCursor('chan-1')).toBe('m-chain');
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
});
