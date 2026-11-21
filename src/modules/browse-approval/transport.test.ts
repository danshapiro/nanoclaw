import { expect, it, vi } from 'vitest';
import { handleForwardedEvent } from '../../channels/chat-sdk-bridge.js';
import { deleteHostQuestionRender, setHostQuestionRender } from '../../channels/ask-question.js';
import type { ChannelSetup } from '../../channels/adapter.js';

it('carries the actual Discord click identity before changing a card and retains a rejected card', async () => {
  const onAction = vi.fn();
  const onActionPreflight = vi.fn().mockReturnValue(false);
  const setup: ChannelSetup = {
    onAction,
    onActionPreflight,
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
  };
  const adapter = { name: 'discord', handleWebhook: vi.fn() };
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  setHostQuestionRender('browse-test', {
    title: 'Chrome browser session',
    options: [{ label: 'Allow session', selectedLabel: 'Allowed', value: 'allow' }],
  });
  const event = {
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 3,
      id: 'interaction',
      token: 'click-token',
      channel_id: 'thread',
      member: { user: { id: 'dan' } },
      message: { id: 'card' },
      data: { custom_id: 'ncq:browse-test:0' },
    },
  };
  try {
    await handleForwardedEvent(JSON.stringify(event), adapter, setup, 'bot-token', fetch);
    expect(onActionPreflight).toHaveBeenCalledExactlyOnceWith('browse-test', 'allow', 'dan', {
      source: 'discord-component',
      channelId: 'thread',
      messageId: 'card',
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(JSON.parse(fetch.mock.calls[0][1].body).data).not.toHaveProperty('components');
    expect(onAction).not.toHaveBeenCalled();
    onActionPreflight.mockReturnValue(true);
    await handleForwardedEvent(JSON.stringify(event), adapter, setup, 'bot-token', fetch);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('browse-test', 'allow', 'dan', {
      source: 'discord-component',
      channelId: 'thread',
      messageId: 'card',
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ type: 7, data: { components: [] } });
  } finally {
    deleteHostQuestionRender('browse-test');
  }
});
