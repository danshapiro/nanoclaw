import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

import { describe, expect, it, vi } from 'vitest';
import { Message, parseMarkdown, type Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { createAgentGroup, createMessagingGroup, createMessagingGroupAgent } from '../db/index.js';
import { setMessagingGroupDeniedAt } from '../db/messaging-groups.js';
import { runMigrations } from '../db/migrations/index.js';
import { log } from '../log.js';
import { attachmentStagingDir, cleanupAttachmentStaging, MAX_INBOUND_ATTACHMENT_BYTES } from '../yente/attachments.js';
import {
  createChatSdkBridge,
  disableWebhookServerKeepAlive,
  forwardChatSdkInboundMessage,
  handleForwardedEvent,
  isOwnChatSdkMessageForTest,
  safeAttachmentDownloadError,
  serializeChatSdkAttachmentForInbound,
  shouldDownloadChatSdkAttachments,
} from './chat-sdk-bridge.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-chat-sdk-data' };
});

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
  function stagingDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-chat-sdk-staging-'));
  }

  it.each([undefined, 17 * 1024 * 1024])(
    'streams URL attachments to disk when Content-Length is %s',
    async (contentLength) => {
      const dir = stagingDir();
      const originalFetch = globalThis.fetch;
      const bytes = Buffer.alloc(17 * 1024 * 1024, 0x61);
      const responseHeaders: Record<string, string> =
        contentLength === undefined ? {} : { 'content-length': String(contentLength) };
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 5 * 1024 * 1024));
              controller.enqueue(bytes.subarray(5 * 1024 * 1024));
              controller.close();
            },
          }),
          { status: 200, headers: responseHeaders },
        ),
      );

      try {
        const entry = await serializeChatSdkAttachmentForInbound(
          {
            id: 'att-1',
            type: 'file',
            name: 'large.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: bytes.byteLength,
          },
          {
            url: 'https://cdn.discordapp.com/attachments/channel/message/large.docx',
          },
          { stagingDir: dir },
        );

        expect(entry).not.toHaveProperty('data');
        expect(typeof entry.stagedHostPath).toBe('string');
        const saved = fs.readFileSync(String(entry.stagedHostPath));
        expect(saved.byteLength).toBe(bytes.byteLength);
        expect(createHash('sha256').update(saved).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('prefers a URL over fetchData and never puts attachment bytes in inbound JSON', async () => {
    const dir = stagingDir();
    const originalFetch = globalThis.fetch;
    const fetchData = vi.fn().mockResolvedValue(Buffer.from('memory-path-must-not-win'));
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
          fetchData,
        },
        {
          url: 'https://cdn.discordapp.com/attachments/channel/message/vision-fixture.png',
        },
        { stagingDir: dir },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://cdn.discordapp.com/attachments/channel/message/vision-fixture.png',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchData).not.toHaveBeenCalled();
      expect(entry).toMatchObject({ id: 'att-1', name: 'vision-fixture.png' });
      expect(entry).not.toHaveProperty('data');
      expect(fs.readFileSync(String(entry.stagedHostPath))).toEqual(Buffer.from('discord-file'));
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a declared attachment larger than the fixed 1 GiB inbound limit', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(
        serializeChatSdkAttachmentForInbound(
          { id: 'too-big', type: 'file', name: 'huge.docx', size: 1024 ** 3 + 1 },
          { url: 'https://cdn.discordapp.com/signed?token=private-value' },
        ),
      ).rejects.toThrow(/1 GiB|1073741824|too large/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('enforces actual streamed bytes at and above a small test limit', async () => {
    const dir = stagingDir();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(Buffer.from('abc'), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('abcd'), { status: 200 })) as unknown as typeof fetch;
    try {
      const accepted = await serializeChatSdkAttachmentForInbound(
        { id: 'at-limit', type: 'file', name: 'three.bin' },
        { url: 'https://cdn.discordapp.com/attachments/at-limit' },
        { stagingDir: dir, maxBytes: 3 },
      );
      expect(fs.readFileSync(String(accepted.stagedHostPath))).toEqual(Buffer.from('abc'));

      await expect(
        serializeChatSdkAttachmentForInbound(
          { id: 'over-limit', type: 'file', name: 'four.bin' },
          { url: 'https://cdn.discordapp.com/attachments/over-limit' },
          { stagingDir: dir, maxBytes: 3 },
        ),
      ).rejects.toThrow(/size|limit|large/i);
      expect(fs.readdirSync(dir)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the size-limit message when a streamed attachment exceeds its limit', async () => {
    const dir = stagingDir();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from('abcd'))) as unknown as typeof fetch;
    try {
      await expect(
        serializeChatSdkAttachmentForInbound(
          { id: 'overflow', type: 'file', name: 'overflow.bin' },
          { url: 'https://cdn.discordapp.com/attachments/overflow' },
          { stagingDir: dir, maxBytes: 3 },
        ),
      ).rejects.toThrow('Attachment exceeds the 3-byte limit');
      expect(safeAttachmentDownloadError(new Error('Attachment exceeds the 3-byte limit'))).toBe(
        'Attachment exceeds the 3-byte limit',
      );
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts a stalled URL transfer after the fixed timeout and removes partial staging bytes', async () => {
    const dir = stagingDir();
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(Buffer.from('partial'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const pending = serializeChatSdkAttachmentForInbound(
      { id: 'stalled', type: 'file', name: 'stalled.docx' },
      { url: 'https://cdn.discordapp.com/attachments/stalled' },
      { stagingDir: dir, timeoutMs: 20 },
    );
    const timeoutAssertion = expect(pending).rejects.toThrow(/timed out/i);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await timeoutAssertion;
      expect(cancelled).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      await pending.catch(() => undefined);
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams the no-URL fetchData fallback to disk and enforces the same byte cap', async () => {
    const dir = stagingDir();
    const attachment = {
      id: 'fallback',
      type: 'file',
      name: 'fallback.bin',
      fetchData: vi.fn().mockResolvedValue(Buffer.from('abc')),
    };
    try {
      const entry = await serializeChatSdkAttachmentForInbound(attachment, undefined, {
        stagingDir: dir,
        maxBytes: 3,
      });
      expect(entry).not.toHaveProperty('data');
      expect(fs.readFileSync(String(entry.stagedHostPath))).toEqual(Buffer.from('abc'));

      const oversized = {
        ...attachment,
        fetchData: vi.fn().mockResolvedValue(Buffer.from('abcd')),
      };
      await expect(
        serializeChatSdkAttachmentForInbound(oversized, undefined, { stagingDir: dir, maxBytes: 3 }),
      ).rejects.toThrow(/too large|limit/i);
      expect(MAX_INBOUND_ATTACHMENT_BYTES).toBe(1024 ** 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes streamed bytes to staging before the response finishes', async () => {
    const dir = stagingDir();
    const originalFetch = globalThis.fetch;
    let releaseFinalChunk!: () => void;
    const finalChunk = new Promise<void>((resolve) => {
      releaseFinalChunk = resolve;
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('first-chunk'));
          },
          async pull(controller) {
            await finalChunk;
            controller.enqueue(Buffer.from('last-chunk'));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const pending = serializeChatSdkAttachmentForInbound(
      { id: 'streaming', type: 'file', name: 'large.docx' },
      { url: 'https://cdn.discordapp.com/attachments/streaming' },
      { stagingDir: dir },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stagedFiles = fs.readdirSync(dir);
      expect(stagedFiles).toHaveLength(1);
      expect(fs.statSync(path.join(dir, stagedFiles[0]!)).size).toBeGreaterThan(0);
    } finally {
      releaseFinalChunk();
      await pending.catch(() => undefined);
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Chat SDK attachment preflight', () => {
  it('keeps mentioned approval events but skips deterministic unwired drops', () => {
    expect(shouldDownloadChatSdkAttachments(null)).toBe(true);
    expect(shouldDownloadChatSdkAttachments(0)).toBe(false);
    expect(shouldDownloadChatSdkAttachments(0, true)).toBe(true);
    expect(shouldDownloadChatSdkAttachments(0, true, true)).toBe(false);
    expect(shouldDownloadChatSdkAttachments(0, false, true)).toBe(false);
    expect(shouldDownloadChatSdkAttachments(1)).toBe(true);
    expect(shouldDownloadChatSdkAttachments(1, true, true)).toBe(true);
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
    adapterOverrides: { isDM?: (threadId: string) => boolean } = {},
  ) {
    const db = initTestDb();
    runMigrations(db);
    // Loose mock type so callers can always assert `.mock` — with an
    // override provided the spy lives in the test that constructed it.
    const onInbound = (setupOverrides.onInbound ?? vi.fn().mockResolvedValue(undefined)) as ReturnType<typeof vi.fn>;
    const onInboundForwarded = vi.fn();
    let captured: DispatchDriver | null = null;
    // No startGatewayListener: these tests drive handleIncomingMessage
    // directly and never need the gateway branch, so setup takes the
    // SDK-owned webhook path and no per-test local server starts (delta
    // review round 8).
    const fakeAdapter = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async (chat: unknown) => {
        captured = chat as DispatchDriver;
      },
      channelIdFromThreadId: (threadId: string) => threadId,
      isDM: adapterOverrides.isDM,
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

  it.each([
    {
      label: 'a mention',
      channelId: 'thread-approval-mention',
      isDM: false,
      isGroup: true,
      text: '@yente-test please review this file',
    },
    {
      label: 'a DM',
      channelId: 'thread-approval-dm',
      isDM: true,
      isGroup: false,
      text: 'please review this file',
    },
  ])(
    'stages attachments for $label events with zero wired agents',
    async ({ label, channelId, isDM, isGroup, text }) => {
      const stagingDir = attachmentStagingDir();
      await cleanupAttachmentStaging(stagingDir);
      const bytes = Buffer.from(`${label} attachment bytes`);
      const fetchData = vi.fn().mockResolvedValue(bytes);
      const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness(
        {},
        {},
        { isDM: (threadId) => threadId === channelId && isDM },
      );

      try {
        createMessagingGroup({
          id: `mg-${channelId}`,
          channel_type: 'discord',
          platform_id: channelId,
          name: `Unwired ${label}`,
          is_group: isGroup ? 1 : 0,
          unknown_sender_policy: 'request_approval',
          created_at: new Date().toISOString(),
        });

        await driver.handleIncomingMessage(
          fakeAdapter,
          channelId,
          makeMessage({
            id: `m-${label.replaceAll(' ', '-')}`,
            text,
            formatted: parseMarkdown(text),
            attachments: [
              {
                id: 'approval-document',
                type: 'file',
                name: 'approval.docx',
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                fetchData,
              },
            ],
          }),
        );

        expect(onInbound).toHaveBeenCalledTimes(1);
        const inbound = onInbound.mock.calls[0]?.[2] as {
          isMention?: boolean;
          isGroup?: boolean;
          content: { attachments: Array<{ stagedHostPath?: string }> };
        };
        const stagedHostPath = inbound.content.attachments[0]?.stagedHostPath;
        expect(inbound.isMention).toBe(true);
        expect(inbound.isGroup).toBe(isGroup);
        expect(stagedHostPath).toBeTruthy();
        expect(fs.readFileSync(stagedHostPath!)).toEqual(bytes);
        expect(fetchData).toHaveBeenCalledOnce();
      } finally {
        await bridge.teardown();
        await cleanupAttachmentStaging(stagingDir);
        closeDb();
      }
    },
  );

  it('skips attachment download for non-mention messages on zero-wired channels', async () => {
    const stagingDir = attachmentStagingDir();
    await cleanupAttachmentStaging(stagingDir);
    const fetchData = vi.fn().mockResolvedValue(Buffer.from('drop this attachment'));
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();

    try {
      createMessagingGroup({
        id: 'mg-unwired-plain',
        channel_type: 'discord',
        platform_id: 'thread-unwired-plain',
        name: 'Unwired plain channel',
        is_group: 1,
        unknown_sender_policy: 'request_approval',
        created_at: new Date().toISOString(),
      });

      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-unwired-plain',
        makeMessage({
          id: 'm-unwired-plain',
          text: 'regular channel update',
          formatted: parseMarkdown('regular channel update'),
          attachments: [{ id: 'dropped-file', type: 'file', name: 'drop.pdf', fetchData }],
        }),
      );

      expect(onInbound).toHaveBeenCalledTimes(1);
      expect((onInbound.mock.calls[0]?.[2] as { isMention?: boolean }).isMention).toBe(false);
      expect(fetchData).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingDir)).toEqual([]);
    } finally {
      await bridge.teardown();
      await cleanupAttachmentStaging(stagingDir);
      closeDb();
    }
  });

  it('skips attachment download for denied zero-wired mentions', async () => {
    const stagingDir = attachmentStagingDir();
    await cleanupAttachmentStaging(stagingDir);
    const fetchData = vi.fn().mockResolvedValue(Buffer.from('denied attachment'));
    const { bridge, driver, fakeAdapter } = await makeDispatchHarness();

    try {
      createMessagingGroup({
        id: 'mg-denied-mention',
        channel_type: 'discord',
        platform_id: 'thread-denied-mention',
        name: 'Denied channel',
        is_group: 1,
        unknown_sender_policy: 'request_approval',
        created_at: new Date().toISOString(),
      });
      setMessagingGroupDeniedAt('mg-denied-mention', new Date().toISOString());

      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-denied-mention',
        makeMessage({
          id: 'm-denied-mention',
          text: '@yente-test please review this file',
          formatted: parseMarkdown('@yente-test please review this file'),
          attachments: [{ id: 'denied-file', type: 'file', name: 'denied.docx', fetchData }],
        }),
      );

      expect(fetchData).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingDir)).toEqual([]);
    } finally {
      await bridge.teardown();
      await cleanupAttachmentStaging(stagingDir);
      closeDb();
    }
  });

  it('sanitizes attachment download failures from signed URLs and removes partial staging files', async () => {
    const stagingDir = attachmentStagingDir();
    await cleanupAttachmentStaging(stagingDir);
    const signedUrl = 'https://cdn.discordapp.com/private-file?ex=secret-value';
    const originalFetch = globalThis.fetch;
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(Buffer.from('partial bytes'));
            controller.error(new Error(`connection reset for ${signedUrl}`));
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const harness = await makeDispatchHarness();
    try {
      createAgentGroup({
        id: 'ag-attachments',
        name: 'Attachment Test',
        folder: 'attachment-test',
        agent_provider: null,
        created_at: new Date().toISOString(),
      });
      createMessagingGroup({
        id: 'mg-attachments',
        channel_type: 'discord',
        platform_id: 'thread-1',
        name: 'Attachment Test',
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: new Date().toISOString(),
      });
      createMessagingGroupAgent({
        id: 'mga-attachments',
        messaging_group_id: 'mg-attachments',
        agent_group_id: 'ag-attachments',
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'per-thread',
        priority: 0,
        created_at: new Date().toISOString(),
      });
      await harness.driver.handleIncomingMessage(
        harness.fakeAdapter,
        'thread-1',
        makeMessage({
          id: 'm-interrupted-file',
          attachments: [
            {
              id: 'att-interrupted',
              type: 'file',
              name: 'private.docx',
              url: signedUrl,
            },
          ],
        }),
      );

      const inbound = harness.onInbound.mock.calls[0]?.[2] as {
        content: { attachments: Array<{ error?: string }> };
      };
      expect(inbound.content.attachments[0]?.error).toBe('Attachment download failed');
      expect(warning).toHaveBeenCalledWith('Failed to download attachment', {
        channel: 'discord',
        messageId: 'm-interrupted-file',
        attachmentId: 'att-interrupted',
        name: 'private.docx',
        type: 'file',
        error: 'Attachment download failed',
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(signedUrl);
      expect(fs.readdirSync(stagingDir)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      warning.mockRestore();
      await harness.bridge.teardown();
      await cleanupAttachmentStaging(stagingDir);
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
