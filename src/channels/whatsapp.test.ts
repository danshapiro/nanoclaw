import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { inboundDbPath, resolveSession, writeSessionMessage } from '../session-manager.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-whatsapp-attachments' };
});

const TEST_DIR = '/tmp/nanoclaw-test-whatsapp-attachments';

function now(): string {
  return new Date().toISOString();
}

describe('WhatsApp attachment contract', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-whatsapp',
      name: 'WhatsApp Agent',
      folder: 'whatsapp-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-whatsapp',
      channel_type: 'whatsapp',
      platform_id: '15555550100@s.whatsapp.net',
      name: 'WhatsApp',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('materializes inbound media under the WhatsApp workspace path', () => {
    const { session } = resolveSession('ag-whatsapp', 'mg-whatsapp', null, 'shared');
    writeSessionMessage('ag-whatsapp', session.id, {
      id: 'wa-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: '15555550100@s.whatsapp.net',
      channelType: 'whatsapp',
      threadId: null,
      content: JSON.stringify({
        text: 'file',
        attachments: [
          {
            id: 'document-wa-msg-1',
            name: 'invoice.pdf',
            mimeType: 'application/pdf',
            data: Buffer.from('whatsapp-file').toString('base64'),
          },
        ],
      }),
    });

    const hostPath = path.join(
      TEST_DIR,
      'groups',
      'whatsapp-agent',
      'attachments',
      'whatsapp',
      'wa-msg-1',
      'document-wa-msg-1-invoice.pdf',
    );
    expect(fs.readFileSync(hostPath, 'utf8')).toBe('whatsapp-file');

    const db = new Database(inboundDbPath('ag-whatsapp', session.id));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('wa-msg-1') as { content: string };
    db.close();
    expect(JSON.parse(row.content).text).toContain(
      '/workspace/agent/attachments/whatsapp/wa-msg-1/document-wa-msg-1-invoice.pdf',
    );
  });
});
