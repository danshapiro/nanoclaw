import fs from 'fs';
import os from 'os';
import path from 'path';

import { Message, parseMarkdown } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('register Discord channel', () => {
  it('uses the bare parent channel id and creates a distinct session for each Discord thread', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-register-'));
    const wakeContainer = vi.fn().mockResolvedValue(undefined);
    try {
      process.chdir(root);
      fs.mkdirSync(path.join(root, 'container'));
      fs.writeFileSync(path.join(root, 'container', 'CLAUDE.md'), '# Andy\nGlobal instructions\n');
      fs.mkdirSync(path.join(root, 'groups', 'unrelated'), { recursive: true });
      fs.writeFileSync(path.join(root, 'groups', 'unrelated', 'CLAUDE.md'), '# Andy\nUnrelated instructions\n');
      fs.writeFileSync(path.join(root, '.env'), 'ASSISTANT_NAME="Andy"\nEXISTING_INSTANCE=unchanged\n');
      vi.resetModules();
      vi.doMock('../src/container-runner.js', () => ({ wakeContainer }));

      const { run } = await import('./register.js');
      const db = await import('../src/db/index.js');
      const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
        await import('../src/channels/channel-registry.js');
      const { routeInbound } = await import('../src/router.js');
      const { createChatSdkBridge } = await import('../src/channels/chat-sdk-bridge.js');
      const { createDiscordHandledTracker, wrapYenteDiscordChannelIds } = await import('../src/channels/discord.js');
      const { getMessagingGroupByPlatform } = await import('../src/db/messaging-groups.js');
      const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
      const { getSessionsByAgentGroup } = await import('../src/db/sessions.js');

      await run([
        '--platform-id',
        'parent-channel',
        '--name',
        'Yente Dev channel',
        '--group-name',
        'Yente Dev',
        '--folder',
        'discord_yente-dev',
        '--channel',
        'discord',
        '--session-mode',
        'per-thread',
        '--trigger',
        '.',
      ]);

      const group = getAgentGroupByFolder('discord_yente-dev');
      expect(group?.name).toBe('Yente Dev');
      expect(getMessagingGroupByPlatform('discord', 'parent-channel')?.platform_id).toBe('parent-channel');
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('ASSISTANT_NAME="Andy"\nEXISTING_INSTANCE=unchanged\n');
      expect(fs.readFileSync(path.join(root, 'container', 'CLAUDE.md'), 'utf8')).toBe('# Andy\nGlobal instructions\n');
      expect(fs.readFileSync(path.join(root, 'groups', 'unrelated', 'CLAUDE.md'), 'utf8')).toBe(
        '# Andy\nUnrelated instructions\n',
      );

      await run([
        '--platform-id',
        'parent-channel',
        '--name',
        'Yente Dev channel',
        '--group-name',
        'Renamed Yente Dev',
        '--folder',
        'discord_yente-dev',
        '--channel',
        'discord',
        '--session-mode',
        'per-thread',
      ]);
      expect(getAgentGroupByFolder('discord_yente-dev')?.name).toBe('Renamed Yente Dev');
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('ASSISTANT_NAME="Andy"\nEXISTING_INSTANCE=unchanged\n');
      expect(fs.readFileSync(path.join(root, 'groups', 'unrelated', 'CLAUDE.md'), 'utf8')).toBe(
        '# Andy\nUnrelated instructions\n',
      );

      await run([
        '--platform-id',
        'workspace-channel',
        '--name',
        'Slack channel',
        '--folder',
        'slack-agent',
        '--channel',
        'slack',
      ]);
      expect(getMessagingGroupByPlatform('slack', 'slack:workspace-channel')?.platform_id).toBe(
        'slack:workspace-channel',
      );

      const handledTracker = createDiscordHandledTracker();
      let chat: {
        handleIncomingMessage(adapter: unknown, threadId: string, message: Message): Promise<void>;
      } | null = null;
      const discordSdkAdapter = {
        name: 'discord',
        userName: 'yente-dev-test',
        initialize: async (instance: unknown) => {
          chat = instance as typeof chat;
        },
        channelIdFromThreadId: (threadId: string) => threadId,
        postMessage: vi.fn(async () => ({ id: 'outbound-message' })),
        editMessage: vi.fn(async () => undefined),
        deleteMessage: vi.fn(async () => undefined),
        addReaction: vi.fn(async () => undefined),
        removeReaction: vi.fn(async () => undefined),
        startTyping: vi.fn(async () => undefined),
        handleForwardedMessage: vi.fn(
          async (event: { id: string; channel_id: string; author: { id: string }; content: string }) => {
            if (!chat) throw new Error('Chat SDK did not initialize the Discord adapter');
            await chat.handleIncomingMessage(
              discordSdkAdapter,
              event.channel_id,
              new Message({
                id: event.id,
                threadId: event.channel_id,
                text: event.content,
                formatted: parseMarkdown(event.content),
                raw: event,
                author: {
                  userId: event.author.id,
                  userName: event.author.id,
                  fullName: event.author.id,
                  isBot: false,
                  isMe: false,
                },
                metadata: { dateSent: new Date(), edited: false },
                attachments: [],
              }),
            );
          },
        ),
      };
      const wrappedDiscordAdapter = wrapYenteDiscordChannelIds(discordSdkAdapter as never, 'test-token', new Set(), {
        routeLeaseMs: 120000,
        wasMessageHandled: handledTracker.wasHandled,
      });
      const discordBridge = createChatSdkBridge({
        adapter: wrappedDiscordAdapter as never,
        supportsThreads: true,
        onInboundForwarded: handledTracker.noteHandled,
      });
      registerChannelAdapter('discord', {
        factory: () => discordBridge,
      });
      await initChannelAdapters(
        (adapter) => ({
          onInbound: (platformId, threadId, message) =>
            routeInbound({
              channelType: adapter.channelType,
              platformId,
              threadId,
              message: {
                ...message,
                content: JSON.stringify(message.content),
              },
            }),
          onInboundEvent: async () => {},
          onMetadata: () => {},
          onAction: () => {},
        }),
        { firstAttemptWaitMs: 0 },
      );

      if (!chat) throw new Error('Chat SDK did not initialize the Discord bridge');
      const wrappedForwarder = wrappedDiscordAdapter as unknown as {
        handleForwardedMessage(event: unknown, options: unknown): Promise<void>;
      };
      const discordThreadIds = [
        'discord:guild-1:parent-channel:thread-one',
        'discord:guild-1:parent-channel:thread-two',
      ];

      for (const threadId of discordThreadIds) {
        await wrappedForwarder.handleForwardedMessage(
          {
            id: `message-${threadId}`,
            channel_id: threadId,
            guild_id: 'guild-1',
            author: { id: 'user-1', bot: false },
            content: 'start work',
            mentions: [],
            attachments: [],
          },
          {},
        );
      }

      expect(
        getSessionsByAgentGroup(group!.id)
          .map((session) => session.thread_id)
          .filter((threadId): threadId is string => threadId !== null)
          .sort(),
      ).toEqual(discordThreadIds);
      expect(wakeContainer).toHaveBeenCalledTimes(2);
      await teardownChannelAdapters();
      db.closeDb();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
