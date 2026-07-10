import http from 'http';

import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
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
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
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

  it('retargets thread-starter edits to the parent channel', async () => {
    const { bridge, editMessage } = makeBridge();

    await bridge.deliver('discord:guild-1:parent-1', 'discord:guild-1:parent-1:thread-9', {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'thread-9', text: 'updated' },
    });

    expect(editMessage).toHaveBeenCalledWith('discord:guild-1:parent-1', 'thread-9', { markdown: 'updated' });
  });
});
