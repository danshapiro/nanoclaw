import { EventEmitter } from 'events';
import type { AgentMail } from 'agentmail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ChannelSetup, OutboundMessage } from './adapter.js';
import type { AgentMailApi, AgentMailSocketLike } from './agentmail-api.js';
import { createAgentMailAdapter } from './agentmail.js';

class FakeSocket extends EventEmitter implements AgentMailSocketLike {
  subscriptions: unknown[] = [];
  sendSubscribe(payload: { type: 'subscribe'; inboxIds: string[]; eventTypes: AgentMail.EventType[] }): void {
    this.subscriptions.push(payload);
  }
  close(): void {
    this.emit('close', { code: 1000, reason: 'test close' });
  }
}

function fakeApi(socket: FakeSocket): AgentMailApi & {
  replies: Array<{
    inboxId: string;
    messageId: string;
    text: string;
    labels?: string[];
    headers?: Record<string, string>;
  }>;
  listed: Array<{ inboxId: string; pageToken?: string }>;
} {
  const state = {
    replies: [] as Array<{
      inboxId: string;
      messageId: string;
      text: string;
      labels?: string[];
      headers?: Record<string, string>;
    }>,
    listed: [] as Array<{ inboxId: string; pageToken?: string }>,
  };
  return {
    replies: state.replies,
    listed: state.listed,
    connectWebSocket: vi.fn(async () => socket),
    listMessages: vi.fn(async (inboxId: string, options: { pageToken?: string }) => {
      state.listed.push({ inboxId, pageToken: options.pageToken });
      return { messages: [] };
    }),
    getMessage: vi.fn(),
    updateLabels: vi.fn(async () => undefined),
    replyToMessage: vi.fn(
      async (
        inboxId: string,
        messageId: string,
        payload: { text: string; labels?: string[]; headers?: Record<string, string> },
      ) => {
        state.replies.push({
          inboxId,
          messageId,
          text: payload.text,
          labels: payload.labels,
          headers: payload.headers,
        });
        return { messageId: 'reply-1' };
      },
    ),
    downloadAttachment: vi.fn(),
  } as AgentMailApi & {
    replies: Array<{
      inboxId: string;
      messageId: string;
      text: string;
      labels?: string[];
      headers?: Record<string, string>;
    }>;
    listed: Array<{ inboxId: string; pageToken?: string }>;
  };
}

let fake: ReturnType<typeof fakeApi>;

describe('AgentMail adapter', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-main',
      name: 'Yente Aidy',
      folder: 'main',
      agent_provider: null,
      created_at: '2026-06-12T00:00:00.000Z',
    });
  });

  afterEach(() => closeDb());

  it('subscribes one socket to the three configured inboxes', async () => {
    const socket = new FakeSocket();
    fake = fakeApi(socket);
    const adapter = createAgentMailAdapter({
      api: fake,
      env: { AGENTMAIL_ENABLED: '1', AGENTMAIL_DOMAIN: 'agentmail.to' },
      now: () => '2026-06-12T00:00:00.000Z',
    })!;

    await adapter.setup(setupCollector());
    socket.emit('open');
    socket.emit('message', {
      type: 'subscribed',
      inboxIds: ['yente@agentmail.to', 'yente-threads@agentmail.to', 'yente-aidy@agentmail.to'],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.subscriptions).toEqual([
      {
        type: 'subscribe',
        inboxIds: ['yente@agentmail.to', 'yente-threads@agentmail.to', 'yente-aidy@agentmail.to'],
        eventTypes: ['message.received', 'message.received.unauthenticated'],
      },
    ]);
    expect(fake.listed.map((entry) => entry.inboxId)).toEqual([
      'yente@agentmail.to',
      'yente-threads@agentmail.to',
      'yente-aidy@agentmail.to',
    ]);
  });

  it('routes a message.received event into NanoClaw once', async () => {
    const socket = new FakeSocket();
    fake = fakeApi(socket);
    const inbound: Parameters<ChannelSetup['onInbound']>[] = [];
    const adapter = createAgentMailAdapter({
      api: fake,
      env: { AGENTMAIL_ENABLED: '1', AGENTMAIL_DOMAIN: 'agentmail.to' },
      now: () => '2026-06-12T00:00:00.000Z',
    })!;

    await adapter.setup(setupCollector(inbound));
    const event = {
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt-1',
      message: {
        inboxId: 'yente-threads@agentmail.to',
        messageId: 'm1',
        threadId: 'thread-1',
        from_: 'ci@example.com',
        subject: 'QA result',
        text: 'run failed',
      },
    };
    socket.emit('message', event);
    socket.emit('message', event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(inbound).toHaveLength(1);
    expect(inbound[0]![0]).toBe('yente-threads@agentmail.to');
    expect(inbound[0]![1]).toBe('agentmail:yente-threads:thread-1');
    expect(JSON.stringify(inbound[0]![2].content)).toContain('"senderId":"agentmail:ci@example.com"');
  });

  it('does not re-deliver a routed message when provider label update fails', async () => {
    const socket = new FakeSocket();
    fake = fakeApi(socket);
    vi.mocked(fake.updateLabels).mockRejectedValueOnce(new Error('provider 429'));
    const inbound: Parameters<ChannelSetup['onInbound']>[] = [];
    const adapter = createAgentMailAdapter({
      api: fake,
      env: { AGENTMAIL_ENABLED: '1', AGENTMAIL_DOMAIN: 'agentmail.to' },
      now: () => '2026-06-12T00:00:00.000Z',
    })!;

    await adapter.setup(setupCollector(inbound));
    const event = {
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt-1',
      message: {
        inboxId: 'yente-threads@agentmail.to',
        messageId: 'm1',
        threadId: 'thread-1',
        from_: 'ci@example.com',
        subject: 'QA result',
        text: 'run failed',
      },
    };
    socket.emit('message', event);
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('message', event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(inbound).toHaveLength(1);
  });

  it('suppresses live auto-submitted messages after fetching full headers', async () => {
    const socket = new FakeSocket();
    fake = fakeApi(socket);
    vi.mocked(fake.getMessage).mockResolvedValueOnce({
      inboxId: 'yente@agentmail.to',
      messageId: 'm-auto',
      threadId: 'thread-auto',
      from_: 'service@example.com',
      subject: 'Automated',
      text: 'machine generated',
      headers: { 'auto-submitted': 'auto-generated' },
    });
    const inbound: Parameters<ChannelSetup['onInbound']>[] = [];
    const adapter = createAgentMailAdapter({
      api: fake,
      env: { AGENTMAIL_ENABLED: '1', AGENTMAIL_DOMAIN: 'agentmail.to' },
      now: () => '2026-06-12T00:00:00.000Z',
    })!;

    await adapter.setup(setupCollector(inbound));
    socket.emit('message', {
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt-auto',
      message: {
        inboxId: 'yente@agentmail.to',
        messageId: 'm-auto',
        threadId: 'thread-auto',
        from_: 'service@example.com',
        subject: 'Automated',
        text: 'machine generated',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.getMessage).toHaveBeenCalledWith('yente@agentmail.to', 'm-auto');
    expect(inbound).toHaveLength(0);
  });

  it('serializes first messages for the same AgentMail thread', async () => {
    const socket = new FakeSocket();
    fake = fakeApi(socket);
    const routed: string[] = [];
    let releaseFirst!: () => void;
    const firstRoute = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const setup = setupCollector();
    setup.onInbound = vi.fn(async (_platformId, _threadId, message) => {
      routed.push(message.id);
      if (message.id.endsWith(':m1')) await firstRoute;
    });
    const adapter = createAgentMailAdapter({
      api: fake,
      env: { AGENTMAIL_ENABLED: '1', AGENTMAIL_DOMAIN: 'agentmail.to' },
      now: () => '2026-06-12T00:00:00.000Z',
    })!;

    await adapter.setup(setup);
    for (const messageId of ['m1', 'm2']) {
      socket.emit('message', {
        type: 'event',
        eventType: 'message.received',
        eventId: `evt-${messageId}`,
        message: {
          inboxId: 'yente-threads@agentmail.to',
          messageId,
          threadId: 'thread-1',
          from_: 'ci@example.com',
          subject: messageId,
          text: messageId,
        },
      });
    }

    await new Promise((resolve) => setImmediate(resolve));
    expect(routed).toEqual(['agentmail:yente-threads@agentmail.to:m1']);
    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    expect(routed).toEqual(['agentmail:yente-threads@agentmail.to:m1', 'agentmail:yente-threads@agentmail.to:m2']);
  });

  it('replies through AgentMail using the latest stored provider message', async () => {
    const socket = new FakeSocket();
    fake = fakeApi(socket);
    const adapter = createAgentMailAdapter({
      api: fake,
      env: { AGENTMAIL_ENABLED: '1', AGENTMAIL_DOMAIN: 'agentmail.to' },
      now: () => '2026-06-12T00:00:00.000Z',
    })!;

    await adapter.setup(setupCollector());
    socket.emit('message', {
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt-1',
      message: {
        inboxId: 'yente@agentmail.to',
        messageId: 'm1',
        threadId: 'thread-1',
        from_: 'person@example.com',
        subject: 'Hello',
        text: 'hi',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const outbound: OutboundMessage = { kind: 'chat', content: { text: 'hello back' } };
    await adapter.deliver('yente@agentmail.to', 'agentmail:yente:thread-1', outbound);

    expect(fake.replies).toEqual([
      {
        inboxId: 'yente@agentmail.to',
        messageId: 'm1',
        text: 'hello back',
        labels: ['nanoclaw:outbound'],
        headers: { 'Auto-Submitted': 'auto-generated', 'X-NanoClaw-Outbound': '1' },
      },
    ]);
  });
});

function setupCollector(inbound: Parameters<ChannelSetup['onInbound']>[] = []): ChannelSetup {
  return {
    onInbound(platformId, threadId, message) {
      inbound.push([platformId, threadId, message]);
    },
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
}
