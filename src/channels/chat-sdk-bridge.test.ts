import http from 'http';

import { describe, expect, it, vi } from 'vitest';
import { Message, parseMarkdown, type Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  createChatSdkBridge,
  disableWebhookServerKeepAlive,
  forwardChatSdkInboundMessage,
  handleForwardedEvent,
  isOwnChatSdkMessageForTest,
  serializeChatSdkAttachmentForInbound,
} from './chat-sdk-bridge.js';

describe('local webhook server keep-alive', () => {
  it('disables keepAliveTimeout so undici cannot race a server-side idle close', () => {
    const server = http.createServer();
    // Node default is 5000ms -- the exact window that produced the
    // burst -> idle gap -> first-forward `TypeError: fetch failed` race.
    expect(server.keepAliveTimeout).toBeGreaterThan(0);
    disableWebhookServerKeepAlive(server);
    expect(server.keepAliveTimeout).toBe(0);
  });
});

describe('Chat SDK bridge attachments', () => {
  it('downloads attachment data from serialized URLs when fetchData is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from('discord-file'), {
        status: 200,
        headers: { 'content-length': '12', 'content-type': 'image/png' },
      }),
    );
    globalThis.fetch = fetchMock;

    try {
      const entry = await serializeChatSdkAttachmentForInbound(
        {
          id: 'att-1',
          type: 'image',
          name: 'vision-fixture.png',
          mimeType: 'image/png',
          size: 12,
        },
        {
          url: 'https://cdn.discordapp.com/attachments/channel/message/vision-fixture.png',
        },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://cdn.discordapp.com/attachments/channel/message/vision-fixture.png',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(entry).toMatchObject({
        id: 'att-1',
        name: 'vision-fixture.png',
        data: Buffer.from('discord-file').toString('base64'),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Chat SDK bridge same-bot ingress guard', () => {
  const author = (userId: string, isBot: boolean, isMe: boolean) => ({
    userId,
    userName: userId,
    fullName: userId,
    isBot,
    isMe,
  });

  it('drops only messages authored by the current bot identity', () => {
    expect(
      isOwnChatSdkMessageForTest({
        id: 'm-self',
        author: author('bot-1', true, true),
      }),
    ).toBe(true);

    expect(
      isOwnChatSdkMessageForTest({
        id: 'm-other-bot',
        author: author('bot-2', true, false),
      }),
    ).toBe(false);

    expect(
      isOwnChatSdkMessageForTest({
        id: 'm-user',
        author: author('user-1', false, false),
      }),
    ).toBe(false);
  });

  it('drops own messages before inbound serialization or storage', async () => {
    const onInbound = vi.fn();
    const toInbound = vi.fn().mockResolvedValue({
      id: 'm-self',
      kind: 'chat-sdk',
      content: {},
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
    });

    await expect(
      forwardChatSdkInboundMessage({
        adapterName: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        message: { id: 'm-self', author: author('bot-1', true, true) },
        isMention: true,
        isGroup: true,
        source: 'mention',
        onInbound,
        toInbound,
      }),
    ).resolves.toBe('dropped');

    expect(toInbound).not.toHaveBeenCalled();
    expect(onInbound).not.toHaveBeenCalled();
  });
});

describe('forward acknowledgment hook', () => {
  const userAuthor = { userId: 'user-1', userName: 'user-1', fullName: 'User One', isBot: false, isMe: false };
  const botSelfAuthor = { userId: 'bot-1', userName: 'bot-1', fullName: 'bot-1', isBot: true, isMe: true };

  function ackHarness() {
    return {
      onInbound: vi.fn().mockResolvedValue(undefined),
      toInbound: vi.fn().mockResolvedValue({
        id: 'm1',
        kind: 'chat-sdk',
        content: {},
        timestamp: new Date().toISOString(),
        isMention: false,
        isGroup: true,
      }),
      onForwarded: vi.fn(),
    };
  }

  it('fires onForwarded with the message id after a successful inbound forward', async () => {
    const { onInbound, toInbound, onForwarded } = ackHarness();
    await expect(
      forwardChatSdkInboundMessage({
        adapterName: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        message: { id: 'm1', author: userAuthor },
        isMention: false,
        isGroup: true,
        source: 'plain',
        onInbound,
        toInbound,
        onForwarded,
      }),
    ).resolves.toBe('forwarded');
    expect(onForwarded).toHaveBeenCalledTimes(1);
    expect(onForwarded).toHaveBeenCalledWith('m1');
  });

  it('does not fire onForwarded when the same-bot guard drops the message', async () => {
    const { onInbound, toInbound, onForwarded } = ackHarness();
    await expect(
      forwardChatSdkInboundMessage({
        adapterName: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        message: { id: 'm-self', author: botSelfAuthor },
        isMention: false,
        isGroup: true,
        source: 'plain',
        onInbound,
        toInbound,
        onForwarded,
      }),
    ).resolves.toBe('dropped');
    expect(onForwarded).not.toHaveBeenCalled();
    expect(onInbound).not.toHaveBeenCalled();
  });
});

describe('Chat SDK bridge outbound splitting', () => {
  it('posts oversized text as multiple messages when an adapter limit is configured', async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ id: 'first-message' })
      .mockResolvedValueOnce({ id: 'second-message' })
      .mockResolvedValueOnce({ id: 'third-message' });
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'discord',
        postMessage,
      } as unknown as Adapter,
      supportsThreads: true,
      maxTextLength: 10,
      onInboundForwarded: vi.fn(),
    });

    const result = await bridge.deliver('discord:guild:channel', null, {
      kind: 'chat',
      content: { text: '12345\n\n67890 12345' },
    });

    expect(result).toBe('first-message');
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls.map(([, message]) => message)).toEqual([
      { markdown: '12345' },
      { markdown: '67890' },
      { markdown: '12345' },
    ]);
    for (const [, message] of postMessage.mock.calls) {
      expect((message as { markdown: string }).markdown.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('Chat SDK bridge Discord gateway forwarding', () => {
  it('routes forwarded Discord application commands as host-command inbound messages', async () => {
    const adapter = {
      name: 'discord',
      handleWebhook: vi.fn(),
    };
    const setupConfig: ChannelSetup = {
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await handleForwardedEvent(
      JSON.stringify({
        type: 'GATEWAY_INTERACTION_CREATE',
        data: {
          id: 'interaction-1',
          token: 'interaction-token',
          type: 2,
          guild_id: 'guild-1',
          channel_id: 'channel-1',
          data: { type: 1, name: 'status' },
          member: { user: { id: 'user-1', username: 'Dan' } },
        },
      }),
      adapter,
      setupConfig,
      'bot-token',
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.com/api/v10/interactions/interaction-1/interaction-token/callback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 5, data: { flags: 64 } }),
      },
    );
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
    expect(setupConfig.onInbound).toHaveBeenCalledWith(
      'channel-1',
      'discord:guild-1:channel-1',
      expect.objectContaining({
        kind: 'chat-sdk',
        isMention: true,
        isGroup: true,
        content: {
          text: '/status',
          sender: 'Dan',
          senderName: 'Dan',
          senderId: 'user-1',
          applicationCommand: true,
          commandName: 'status',
        },
      }),
    );
  });

  it('routes forwarded Discord thread commands through the parent channel messaging group', async () => {
    const adapter = {
      name: 'discord',
      handleWebhook: vi.fn(),
    };
    const setupConfig: ChannelSetup = {
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await handleForwardedEvent(
      JSON.stringify({
        type: 'GATEWAY_INTERACTION_CREATE',
        data: {
          id: 'interaction-thread-1',
          token: 'interaction-token',
          type: 2,
          guild_id: 'guild-1',
          channel_id: 'thread-1',
          channel: { id: 'thread-1', type: 11, parent_id: 'channel-1' },
          data: { type: 1, name: 'new' },
          member: { user: { id: 'user-1', username: 'Dan' } },
        },
      }),
      adapter,
      setupConfig,
      'bot-token',
      fetchImpl,
    );

    expect(setupConfig.onInbound).toHaveBeenCalledWith(
      'channel-1',
      'discord:guild-1:channel-1:thread-1',
      expect.objectContaining({
        kind: 'chat-sdk',
        isMention: true,
        isGroup: true,
        content: expect.objectContaining({
          text: '/new',
          applicationCommand: true,
          commandName: 'new',
        }),
      }),
    );
  });
});

describe('Chat SDK bridge deliver — reactions', () => {
  function makeBridge() {
    const addReaction = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      name: 'discord',
      addReaction,
      editMessage,
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, onInboundForwarded: vi.fn() });
    return { bridge, addReaction, editMessage };
  }

  const reactionMessage = (messageId: string, emoji: string) => ({
    kind: 'chat',
    content: { operation: 'reaction', messageId, emoji },
  });

  it('swallows 4xx adapter errors so the delivery row succeeds-as-skipped', async () => {
    const { bridge, addReaction } = makeBridge();
    addReaction.mockRejectedValue(new Error('Discord API error: 404 {"message": "Unknown Message", "code": 10008}'));

    await expect(
      bridge.deliver('discord:guild-1:chan-1', 'discord:guild-1:chan-1', reactionMessage('msg-1', '✅')),
    ).resolves.toBeUndefined();
    expect(addReaction).toHaveBeenCalledTimes(1);
  });

  it('retargets thread-starter reactions to the parent channel', async () => {
    const { bridge, addReaction } = makeBridge();

    // Discord thread id == starter message id; the starter message lives in
    // the PARENT channel, so the reaction must target discord:guild:parent.
    await bridge.deliver(
      'discord:guild-1:parent-1',
      'discord:guild-1:parent-1:thread-9',
      reactionMessage('thread-9', '✅'),
    );

    expect(addReaction).toHaveBeenCalledWith('discord:guild-1:parent-1', 'thread-9', '✅');
  });

  it('does not retarget reactions to regular in-thread messages', async () => {
    const { bridge, addReaction } = makeBridge();

    await bridge.deliver(
      'discord:guild-1:parent-1',
      'discord:guild-1:parent-1:thread-9',
      reactionMessage('other-msg', '✅'),
    );

    expect(addReaction).toHaveBeenCalledWith('discord:guild-1:parent-1:thread-9', 'other-msg', '✅');
  });

  it('resolves white_check_mark shortcode to the unicode emoji', async () => {
    const { bridge, addReaction } = makeBridge();

    await bridge.deliver(
      'discord:guild-1:chan-1',
      'discord:guild-1:chan-1',
      reactionMessage('msg-1', 'white_check_mark'),
    );

    expect(addReaction).toHaveBeenCalledWith('discord:guild-1:chan-1', 'msg-1', '✅');
  });

  it('passes unicode emoji through untouched', async () => {
    const { bridge, addReaction } = makeBridge();

    await bridge.deliver('discord:guild-1:chan-1', 'discord:guild-1:chan-1', reactionMessage('msg-1', '🎯'));

    expect(addReaction).toHaveBeenCalledWith('discord:guild-1:chan-1', 'msg-1', '🎯');
  });

  it('rethrows 5xx adapter errors so transient failures still retry', async () => {
    const { bridge, addReaction } = makeBridge();
    addReaction.mockRejectedValue(new Error('Discord API error: 502 Bad Gateway'));

    await expect(
      bridge.deliver('discord:guild-1:chan-1', 'discord:guild-1:chan-1', reactionMessage('msg-1', '✅')),
    ).rejects.toThrow('502');
  });

  it('rethrows 429 rate-limit errors so the delivery retry loop handles them', async () => {
    const { bridge, addReaction } = makeBridge();
    addReaction.mockRejectedValue(
      new Error('Discord API error: 429 {"message": "You are being rate limited.", "retry_after": 0.3}'),
    );

    await expect(
      bridge.deliver('discord:guild-1:chan-1', 'discord:guild-1:chan-1', reactionMessage('msg-1', '✅')),
    ).rejects.toThrow('429');
  });

  it.each([400, 403, 404])('still swallows deterministic %i client errors', async (status) => {
    const { bridge, addReaction } = makeBridge();
    addReaction.mockRejectedValue(new Error(`Discord API error: ${status} {"message": "client error"}`));

    await expect(
      bridge.deliver('discord:guild-1:chan-1', 'discord:guild-1:chan-1', reactionMessage('msg-1', '✅')),
    ).resolves.toBeUndefined();
    expect(addReaction).toHaveBeenCalledTimes(1);
  });

  it('retargets thread-starter edits to the parent channel', async () => {
    const { bridge, editMessage } = makeBridge();

    await bridge.deliver('discord:guild-1:parent-1', 'discord:guild-1:parent-1:thread-9', {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'thread-9', text: 'updated' },
    });

    expect(editMessage).toHaveBeenCalledWith('discord:guild-1:parent-1', 'thread-9', { markdown: 'updated' });
  });
});

describe('onGatewayWebhookReady hook', () => {
  it('is invoked once with the local webhook URL during setup', async () => {
    const db = initTestDb();
    runMigrations(db);
    const seen: string[] = [];
    const fakeAdapter = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      startGatewayListener: async () => new Response('ok'),
    } as unknown as Parameters<typeof createChatSdkBridge>[0]['adapter'];

    const bridge = createChatSdkBridge({
      adapter: fakeAdapter,
      supportsThreads: true,
      botToken: 'test-token',
      onGatewayWebhookReady: (webhookUrl) => seen.push(webhookUrl),
      onInboundForwarded: vi.fn(),
    });
    try {
      await bridge.setup({
        onInbound: async () => {},
        onInboundEvent: async () => {},
        onMetadata: async () => {},
        onAction: async () => {},
      } as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook$/);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
});

describe('plain-message catch-all dispatch', () => {
  type DispatchDriver = {
    handleIncomingMessage: (adapter: unknown, threadId: string, message: Message) => Promise<void>;
  };

  function makeMessage(overrides: Record<string, unknown> = {}): Message {
    return new Message({
      id: 'm-1',
      threadId: 'thread-1',
      text: '',
      formatted: parseMarkdown(''),
      raw: {},
      author: { userId: 'user-1', userName: 'user-1', fullName: 'User One', isBot: false, isMe: false },
      metadata: { dateSent: new Date('2026-08-15T04:09:31.975Z'), edited: false },
      attachments: [],
      ...overrides,
    });
  }

  async function makeDispatchHarness(
    bridgeConfig: { dedupeTtlMs?: number } = {},
    setupOverrides: {
      onInbound?: ChannelSetup['onInbound'];
      onInboundStrict?: ChannelSetup['onInboundStrict'];
    } = {},
  ) {
    const db = initTestDb();
    runMigrations(db);
    // Loose mock type so callers can always assert `.mock` — with an
    // override provided the spy lives in the test that constructed it.
    const onInbound = (setupOverrides.onInbound ?? vi.fn().mockResolvedValue(undefined)) as ReturnType<typeof vi.fn>;
    const onInboundForwarded = vi.fn();
    let captured: DispatchDriver | null = null;
    const fakeAdapter = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async (chat: unknown) => {
        captured = chat as DispatchDriver;
      },
      channelIdFromThreadId: (threadId: string) => threadId,
      startGatewayListener: async () => new Response('ok'),
    };
    const bridge = createChatSdkBridge({
      adapter: fakeAdapter as never,
      supportsThreads: true,
      botToken: 'test-token',
      onInboundForwarded,
      ...bridgeConfig,
    });
    await bridge.setup({
      onInbound,
      onInboundEvent: async () => {},
      onMetadata: async () => {},
      onAction: async () => {},
      ...(setupOverrides.onInboundStrict ? { onInboundStrict: setupOverrides.onInboundStrict } : {}),
    } as never);
    if (!captured) throw new Error('Chat SDK did not initialize the adapter');
    const driver: DispatchDriver = captured;
    return { bridge, driver, fakeAdapter, onInbound, onInboundForwarded };
  }

  it('forwards an attachment-only message (empty text) to the router', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();
    try {
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({
          id: 'm-empty-attach',
          attachments: [{ type: 'file', name: 'report.pdf', size: 3 }],
        }),
      );
      expect(onInbound).toHaveBeenCalledTimes(1);
      const [channelId, threadId, inbound] = onInbound.mock.calls[0] as [
        string,
        string,
        { content: { text?: unknown; attachments?: Array<Record<string, unknown>> } },
      ];
      expect(channelId).toBe('thread-1');
      expect(threadId).toBe('thread-1');
      expect(inbound.content.text).toBe('');
      expect(inbound.content.attachments?.[0]?.name).toBe('report.pdf');
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('still forwards ordinary text messages (control)', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();
    try {
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({ id: 'm-text', text: 'hello', formatted: parseMarkdown('hello') }),
      );
      expect(onInbound).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('delivers exactly once for a subscribed thread (widening must not double-fire)', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();
    try {
      // bridge.subscribe(_platformId, threadId) blind-upserts into
      // chat_sdk_subscriptions (no thread-existence prerequisite); the SDK's
      // subscribed dispatch branch early-returns before the pattern loop, so
      // a subscribed thread takes the subscribed path exactly once even with
      // the widened catch-all.
      await bridge.subscribe!('ignored', 'thread-1');
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({ id: 'm-sub', text: 'hi there', formatted: parseMarkdown('hi there') }),
      );
      expect(onInbound).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('re-dispatches a re-presented message id once the configured dedupeTtlMs has elapsed', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness({ dedupeTtlMs: 1 });
    try {
      const msg = makeMessage({
        id: 'm-redeliver',
        threadId: 'thread-9',
        text: 'ping',
        formatted: parseMarkdown('ping'),
      });
      await driver.handleIncomingMessage(fakeAdapter, 'thread-9', msg);
      expect(onInbound).toHaveBeenCalledTimes(1);
      // Configured dedupe TTL is 1ms; the awaited dispatch above plus this
      // sleep guarantee expiry. This models catch-up re-presentation (minutes
      // later in production); the SDK's 300s default would swallow it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await driver.handleIncomingMessage(fakeAdapter, 'thread-9', msg);
      expect(onInbound).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('fires the acceptance hook through onInboundStrict when the host provides it', async () => {
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const onInboundStrict = vi.fn().mockResolvedValue(undefined);
    const { bridge, driver, fakeAdapter, onInboundForwarded } = await makeDispatchHarness(
      {},
      { onInbound, onInboundStrict },
    );
    try {
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({ id: 'm-strict-ok', text: 'up', formatted: parseMarkdown('up') }),
      );
      expect(onInboundStrict).toHaveBeenCalledTimes(1);
      expect(onInbound).not.toHaveBeenCalled();
      expect(onInboundForwarded).toHaveBeenCalledWith('m-strict-ok');
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('suppresses the acceptance hook when onInboundStrict rejects (router failure stays catch-up eligible)', async () => {
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const onInboundStrict = vi.fn().mockRejectedValue(new Error('router blew up'));
    const { bridge, driver, fakeAdapter, onInboundForwarded } = await makeDispatchHarness(
      {},
      { onInbound, onInboundStrict },
    );
    try {
      // Whether the SDK surfaces or swallows a handler failure, the acceptance
      // contract is observable either way: the hook must not fire.
      await driver
        .handleIncomingMessage(
          fakeAdapter,
          'thread-1',
          makeMessage({ id: 'm-strict-fail', text: 'up', formatted: parseMarkdown('up') }),
        )
        .catch(() => {});
      expect(onInboundForwarded).not.toHaveBeenCalled();
      expect(onInbound).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
});
