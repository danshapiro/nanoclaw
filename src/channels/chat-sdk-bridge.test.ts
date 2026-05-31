import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent, serializeChatSdkAttachmentForInbound } from './chat-sdk-bridge.js';

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
