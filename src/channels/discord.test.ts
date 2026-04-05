import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockReadEnvFile = vi.hoisted(() =>
  vi.fn<() => Record<string, string>>(() => ({
    DISCORD_BOT_TOKEN: 'test-token',
  })),
);

vi.mock('../env.js', () => ({
  readEnvFile: mockReadEnvFile,
}));

const mockStoreMessageDirect = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  storeMessageDirect: mockStoreMessageDirect,
}));

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

const loginShouldFail = vi.hoisted(() => ({
  value: false,
  error: new Error('Invalid bot token'),
}));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      if (loginShouldFail.value) {
        throw loginShouldFail.error;
      }
      this._ready = true;
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        h({ user: this.user });
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({
          id: 'mock-msg-id',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    };

    destroy() {
      this._ready = false;
    }
  }

  class TextChannel {}
  class ThreadChannel {}

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    TextChannel,
    ThreadChannel,
  };
});

import { DiscordChannel, DiscordChannelOpts } from './discord.js';
import { registerChannel } from './registry.js';

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
  ChannelOpts: undefined,
}));

const registrationArgs = vi.mocked(registerChannel).mock.calls[0];
const registeredFactory = registrationArgs?.[1];

function createTestOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
  threadParentId?: string;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777';

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  const isThread = !!overrides.threadParentId;

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName ? { name: overrides.guildName } : null,
    channel: {
      name: overrides.channelName ?? 'general',
      isThread: () => isThread,
      parentId: overrides.threadParentId ?? null,
      parent: overrides.threadParentId
        ? { name: overrides.channelName ?? 'general' }
        : null,
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('self-registration', () => {
    it('calls registerChannel with name discord', () => {
      expect(registrationArgs).toBeDefined();
      expect(registrationArgs![0]).toBe('discord');
      expect(typeof registeredFactory).toBe('function');
    });

    it('returns null when DISCORD_BOT_TOKEN is absent', () => {
      mockReadEnvFile.mockReturnValue({});
      const originalEnv = process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_BOT_TOKEN;

      const result = registeredFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
      });

      expect(result).toBeNull();
      if (originalEnv !== undefined)
        process.env.DISCORD_BOT_TOKEN = originalEnv;
    });

    it('returns DiscordChannel instance when token exists', () => {
      mockReadEnvFile.mockReturnValue({ DISCORD_BOT_TOKEN: 'test-token' });
      const result = registeredFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
      });

      expect(result).toBeInstanceOf(DiscordChannel);
    });

    it('prefers process.env over readEnvFile', () => {
      const originalEnv = process.env.DISCORD_BOT_TOKEN;
      process.env.DISCORD_BOT_TOKEN = 'env-token';

      const result = registeredFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
      }) as DiscordChannel;

      expect(result).toBeInstanceOf(DiscordChannel);
      if (originalEnv !== undefined) {
        process.env.DISCORD_BOT_TOKEN = originalEnv;
      } else {
        delete process.env.DISCORD_BOT_TOKEN;
      }
    });
  });

  describe('Channel interface', () => {
    it('implements required Channel.name', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });

    it('implements required Channel.connect', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(typeof channel.connect).toBe('function');
    });

    it('implements required Channel.sendMessage', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(typeof channel.sendMessage).toBe('function');
    });

    it('implements required Channel.isConnected', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(typeof channel.isConnected).toBe('function');
    });

    it('implements required Channel.ownsJid', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(typeof channel.ownsJid).toBe('function');
    });

    it('implements required Channel.disconnect', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(typeof channel.disconnect).toBe('function');
    });

    it('implements optional Channel.setTyping', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(typeof channel.setTyping).toBe('function');
    });
  });

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('rejects connect() when login fails', async () => {
      loginShouldFail.value = true;
      const opts = createTestOpts();
      const channel = new DiscordChannel('bad-token', opts);

      await expect(channel.connect()).rejects.toThrow('Invalid bot token');

      loginShouldFail.value = false;
    });
  });

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
        'discord',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
        'discord',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('passes isGroup=false for DMs (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
        'discord',
        false,
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
        'discord',
        true,
      );
    });
  });

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> @Andy hello',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> ping',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy ping',
        }),
      );
    });
  });

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: photo.png]',
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[File: report.pdf]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.jpg', contentType: 'image/jpeg' }],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'Check this out\n[Image: photo.jpg]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'a.png', contentType: 'image/png' }],
        ['att2', { name: 'b.txt', contentType: 'text/plain' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: a.png]\n[File: b.txt]',
        }),
      );
    });
  });

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Reply to Bob] I agree with that',
        }),
      );
    });
  });

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Hello');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('throws on send failure so caller can handle it', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).rejects.toThrow('Channel not found');
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue({
          id: 'mock-msg-id',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });

    it('calls storeMessageDirect for each sent chunk', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const sentId1 = 'sent-msg-001';
      const sentId2 = 'sent-msg-002';
      const sentDate1 = new Date('2026-01-01T00:00:00Z');
      const sentDate2 = new Date('2026-01-01T00:00:01Z');

      const mockChannel = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            id: sentId1,
            createdAt: sentDate1,
          })
          .mockResolvedValueOnce({
            id: sentId2,
            createdAt: sentDate2,
          }),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'a'.repeat(2500);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockStoreMessageDirect).toHaveBeenCalledTimes(2);
      expect(mockStoreMessageDirect).toHaveBeenCalledWith({
        id: sentId1,
        chat_jid: 'dc:1234567890123456',
        sender: '999888777',
        sender_name: 'Andy',
        content: 'a'.repeat(2000),
        timestamp: sentDate1.toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
      expect(mockStoreMessageDirect).toHaveBeenCalledWith({
        id: sentId2,
        chat_jid: 'dc:1234567890123456',
        sender: '999888777',
        sender_name: 'Andy',
        content: 'a'.repeat(500),
        timestamp: sentDate2.toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    });

    it('calls storeMessageDirect for single short message', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const sentId = 'sent-msg-short';
      const sentDate = new Date('2026-02-15T12:00:00Z');

      const mockChannel = {
        send: vi.fn().mockResolvedValue({
          id: sentId,
          createdAt: sentDate,
        }),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessage('dc:1234567890123456', 'Short message');

      expect(mockStoreMessageDirect).toHaveBeenCalledTimes(1);
      expect(mockStoreMessageDirect).toHaveBeenCalledWith({
        id: sentId,
        chat_jid: 'dc:1234567890123456',
        sender: '999888777',
        sender_name: 'Andy',
        content: 'Short message',
        timestamp: sentDate.toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    });
  });

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('dc:1234567890123456', false);

      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await expect(
        channel.setTyping('dc:1234567890123456', true),
      ).resolves.toBeUndefined();
    });

    it('routes typing to active thread', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: 'thread_typing',
        threadParentId: '1234567890123456',
        content: 'Hello from thread',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      const mockThreadChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockThreadChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        'thread_typing',
      );
      expect(mockThreadChannel.sendTyping).toHaveBeenCalled();
    });
  });

  describe('thread support', () => {
    it('resolves thread messages to parent channel for group lookup', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: 'thread_111',
        threadParentId: '1234567890123456',
        content: 'Thread reply',
        guildName: 'Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'Thread reply',
          chat_jid: 'dc:1234567890123456',
        }),
      );
    });

    it('routes replies to latest active thread', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: 'thread_111',
        threadParentId: '1234567890123456',
        content: 'Thread message',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      await channel.sendMessage('dc:1234567890123456', 'Reply in thread');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('thread_111');
    });

    it('falls back to parent channel when no active thread', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'No thread active');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('tracks latest thread when multiple threads exist on same parent', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg1 = createMessage({
        channelId: 'thread_A',
        threadParentId: '1234567890123456',
        content: 'First thread',
        guildName: 'Server',
      });
      await triggerMessage(msg1);

      const msg2 = createMessage({
        channelId: 'thread_B',
        threadParentId: '1234567890123456',
        content: 'Second thread',
        guildName: 'Server',
      });
      await triggerMessage(msg2);

      await channel.sendMessage('dc:1234567890123456', 'Reply');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('thread_B');
    });

    it('still routes to first thread after second thread message', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg1 = createMessage({
        channelId: 'thread_A',
        threadParentId: '1234567890123456',
        content: 'First thread',
        guildName: 'Server',
      });
      await triggerMessage(msg1);

      const msg2 = createMessage({
        channelId: 'thread_B',
        threadParentId: '1234567890123456',
        content: 'Second thread',
        guildName: 'Server',
      });
      await triggerMessage(msg2);

      const msg3 = createMessage({
        channelId: 'thread_A',
        threadParentId: '1234567890123456',
        content: 'Back to first',
        guildName: 'Server',
      });
      await triggerMessage(msg3);

      await channel.sendMessage('dc:1234567890123456', 'Reply');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('thread_A');
    });
  });

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });
});
