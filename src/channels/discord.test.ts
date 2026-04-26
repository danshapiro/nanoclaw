import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { inboundDbPath, resolveSession, writeSessionMessage } from '../session-manager.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-discord-attachments' };
});

const TEST_DIR = '/tmp/nanoclaw-test-discord-attachments';

function now(): string {
  return new Date().toISOString();
}

describe('Discord attachment contract', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
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
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
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
      TEST_DIR,
      'groups',
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
