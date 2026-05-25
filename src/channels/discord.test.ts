import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { inboundDbPath, resolveSession, writeSessionMessage } from '../session-manager.js';
import { toDiscordThreadId, yenteDiscordPlatformIdFromThreadId } from './discord.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-discord-data',
    GROUPS_DIR: '/tmp/nanoclaw-test-discord-groups',
  };
});

const TEST_DATA_DIR = '/tmp/nanoclaw-test-discord-data';
const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-discord-groups';

function now(): string {
  return new Date().toISOString();
}

describe('Discord attachment contract', () => {
  beforeEach(() => {
    for (const dir of [TEST_DATA_DIR, TEST_GROUPS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-discord',
      name: 'Discord Agent',
      folder: 'discord-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'discord:guild:channel',
      name: 'Discord',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    for (const dir of [TEST_DATA_DIR, TEST_GROUPS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('materializes inbound files under the Discord workspace path', () => {
    const { session } = resolveSession('ag-discord', 'mg-discord', 'thread-1', 'per-thread');
    writeSessionMessage('ag-discord', session.id, {
      id: 'discord-msg-1',
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'discord:guild:channel',
      channelType: 'discord',
      threadId: 'thread-1',
      content: JSON.stringify({
        text: 'file',
        attachments: [
          {
            id: 'file-1',
            name: 'image.png',
            mimeType: 'image/png',
            data: Buffer.from('discord-file').toString('base64'),
          },
        ],
      }),
    });

    const hostPath = path.join(
      TEST_GROUPS_DIR,
      'discord-agent',
      'attachments',
      'discord',
      'discord-msg-1',
      'file-1-image.png',
    );
    expect(fs.readFileSync(hostPath, 'utf8')).toBe('discord-file');

    const db = new Database(inboundDbPath('ag-discord', session.id));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('discord-msg-1') as { content: string };
    db.close();
    expect(JSON.parse(row.content).text).toContain(
      '/workspace/agent/attachments/discord/discord-msg-1/file-1-image.png',
    );
  });
});

describe('Discord v1 channel-id compatibility', () => {
  it('uses the v1 channel id as the Yente platform id for encoded Discord thread ids', () => {
    expect(yenteDiscordPlatformIdFromThreadId('discord:guild-1:channel-1')).toBe('channel-1');
    expect(yenteDiscordPlatformIdFromThreadId('discord:guild-1:channel-1:thread-1')).toBe('channel-1');
    expect(yenteDiscordPlatformIdFromThreadId('channel-1')).toBe('channel-1');
  });

  it('resolves v1 channel ids to Chat SDK Discord thread ids for outbound delivery', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), {
        status: 200,
      }),
    );

    await expect(toDiscordThreadId('channel-1', 'bot-token')).resolves.toBe('discord:guild-1:channel-1');

    expect(globalThis.fetch).toHaveBeenCalledWith('https://discord.com/api/v10/channels/channel-1', {
      method: 'GET',
      headers: { Authorization: 'Bot bot-token' },
    });
    globalThis.fetch = originalFetch;
  });
});
