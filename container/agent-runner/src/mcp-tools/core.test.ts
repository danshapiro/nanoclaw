import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction, editMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  ensurePlatformMessageIdColumn();
});

afterEach(() => {
  closeSessionDb();
});

function ensurePlatformMessageIdColumn(): void {
  const db = getInboundDb();
  const cols = new Set((db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN platform_message_id TEXT').run();
  }
}

function insertInboundMessage(opts: {
  seq: number;
  id: string;
  platformMessageId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
}): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (
        id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, platform_message_id
      )
      VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, ?, '{}', ?)`,
    )
    .run(
      opts.id,
      opts.seq,
      opts.platformId ?? '987654321098765432',
      opts.channelType ?? 'discord',
      opts.threadId ?? null,
      opts.platformMessageId ?? null,
    );
}

describe('core message action tools', () => {
  it('uses the raw platform message ID when reacting to a routed inbound message', async () => {
    insertInboundMessage({
      seq: 4,
      id: '111122223333444455:ag-discord-test-agent',
      platformMessageId: '111122223333444455',
    });

    const result = await addReaction.handler({ messageId: 4, emoji: 'clock3' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({
      operation: 'reaction',
      messageId: '111122223333444455',
      emoji: 'clock3',
    });
  });

  it('rejects edits targeting inbound user messages', async () => {
    insertInboundMessage({
      seq: 4,
      id: '111122223333444455:ag-discord-test-agent',
      platformMessageId: '111122223333444455',
    });

    const result = await editMessage.handler({ messageId: 4, text: 'updated text' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Cannot edit inbound message #4');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
