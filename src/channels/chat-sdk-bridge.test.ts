import { describe, expect, it, vi } from 'vitest';

import type { ChannelSetup } from './adapter.js';
import { handleForwardedEvent } from './chat-sdk-bridge.js';

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
      null,
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
});
