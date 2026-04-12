import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  ControlCommand,
  DISCORD_CONTROL_COMMANDS,
} from '../control-commands.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { storeMessageDirect } from '../db.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const CONNECT_TIMEOUT_MS = 30_000;

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onSlashCommand?: (command: {
    chatJid: string;
    chatName: string;
    command: ControlCommand;
    sender: string;
    senderName: string;
    timestamp: string;
  }) => Promise<string>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private latestThread = new Map<string, string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;

      let channelId = message.channelId;
      let channelForName: TextChannel | ThreadChannel =
        message.channel as TextChannel;
      if (message.channel.isThread()) {
        const thread = message.channel as ThreadChannel;
        const parentId = thread.parentId;
        if (parentId) {
          this.latestThread.set(parentId, channelId);
          channelId = parentId;
          channelForName = (thread.parent ?? thread) as TextChannel;
        }
      }

      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      let chatName: string;
      if (message.guild) {
        chatName = `${message.guild.name} #${(channelForName as TextChannel).name}`;
      } else {
        chatName = senderName;
      }

      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      const isGroup = !!message.guild;

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction);
    });

    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Discord connect timed out'));
      }, CONNECT_TIMEOUT_MS);

      this.client!.once(Events.ClientReady, async (readyClient) => {
        clearTimeout(timer);
        await this.syncSlashCommands();
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(`  Commands: /help /status /new /clear /compact\n`);
        resolve();
      });

      this.client!.login(this.botToken).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');

      const threadId = this.latestThread.get(channelId);
      const targetId = threadId ?? channelId;
      const channel = await this.client.channels.fetch(targetId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      const MAX_LENGTH = 2000;
      const chunks: string[] = [];
      if (text.length <= MAX_LENGTH) {
        chunks.push(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
      }

      for (const chunk of chunks) {
        const sent = await textChannel.send(chunk);
        storeMessageDirect({
          id: sent.id,
          chat_jid: jid,
          sender: this.client!.user!.id,
          sender_name: ASSISTANT_NAME,
          content: chunk,
          timestamp: sent.createdAt.toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
      logger.info(
        { jid, threadId: threadId ?? null, length: text.length },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const threadId = this.latestThread.get(channelId);
      const targetId = threadId ?? channelId;
      const channel = await this.client.channels.fetch(targetId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  private async handleSlashCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const command = interaction.commandName as ControlCommand;
    if (!DISCORD_CONTROL_COMMANDS.some((item) => item.name === command)) {
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      if (!this.opts.onSlashCommand) {
        await interaction.editReply('Slash commands are not configured.');
        return;
      }

      const senderName =
        interaction.member && 'displayName' in interaction.member
          ? interaction.member.displayName
          : interaction.user.globalName || interaction.user.username;

      const routing = await this.resolveRoutingContext({
        channelId: interaction.channelId,
        channel: interaction.channel as TextChannel | ThreadChannel | null,
        guildName: interaction.guild?.name,
        fallbackChatName: senderName,
      });

      const reply = await this.opts.onSlashCommand({
        chatJid: routing.chatJid,
        chatName: routing.chatName,
        command,
        sender: interaction.user.id,
        senderName,
        timestamp: new Date(interaction.createdTimestamp).toISOString(),
      });

      await interaction.editReply(reply);
    } catch (err) {
      logger.error({ err, command }, 'Discord slash command failed');
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply('Command failed. Check the NanoClaw logs for details.')
          .catch(() => undefined);
      } else {
        await interaction
          .reply({
            content: 'Command failed. Check the NanoClaw logs for details.',
            ephemeral: true,
          })
          .catch(() => undefined);
      }
    }
  }

  private async syncSlashCommands(): Promise<void> {
    if (!this.client?.application || !this.opts.onSlashCommand) return;

    await this.client.application.commands.set([]);

    const guildIds = await this.getRegisteredGuildIds();
    for (const guildId of guildIds) {
      try {
        const guild = await this.client.guilds.fetch(guildId);
        await guild.commands.set(DISCORD_CONTROL_COMMANDS);
      } catch (err) {
        logger.warn({ err, guildId }, 'Failed to sync Discord slash commands');
      }
    }

    logger.info(
      {
        guildCount: guildIds.length,
        commands: DISCORD_CONTROL_COMMANDS.map((command) => command.name),
      },
      'Discord slash commands synced',
    );
  }

  private async getRegisteredGuildIds(): Promise<string[]> {
    if (!this.client) return [];

    const guildIds = new Set<string>();
    for (const chatJid of Object.keys(this.opts.registeredGroups())) {
      if (!chatJid.startsWith('dc:')) continue;
      const channelId = chatJid.replace(/^dc:/, '');

      try {
        const channel = await this.client.channels.fetch(channelId);
        const guildId =
          channel && 'guildId' in channel
            ? (channel.guildId as string | null)
            : null;
        if (guildId) guildIds.add(guildId);
      } catch (err) {
        logger.debug(
          { err, channelId },
          'Failed to resolve Discord guild for slash command sync',
        );
      }
    }

    return [...guildIds];
  }

  private async resolveRoutingContext(opts: {
    channelId: string;
    channel: TextChannel | ThreadChannel | null;
    guildName?: string;
    fallbackChatName: string;
  }): Promise<{ chatJid: string; chatName: string }> {
    let channelId = opts.channelId;
    let channelName = opts.channel?.name || 'discord';

    if (opts.channel?.isThread()) {
      const thread = opts.channel as ThreadChannel;
      if (thread.parentId) {
        this.latestThread.set(thread.parentId, thread.id);
        channelId = thread.parentId;
        channelName = (thread.parent ?? thread).name;
      }
    }

    const chatName = opts.guildName
      ? `${opts.guildName} #${channelName}`
      : opts.fallbackChatName;

    return {
      chatJid: `dc:${channelId}`,
      chatName,
    };
  }
}

registerChannel('discord', (opts: ChannelOpts): DiscordChannel | null => {
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN || '';
  if (!token) return null;
  const discordOpts = opts as ChannelOpts & {
    onSlashCommand?: DiscordChannelOpts['onSlashCommand'];
  };
  return new DiscordChannel(token, {
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
    onSlashCommand: discordOpts.onSlashCommand,
  });
});
