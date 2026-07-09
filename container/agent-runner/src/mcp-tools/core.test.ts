import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getMessageTargetBySeq, getUndeliveredMessages, writeMessageOut } from '../db/messages-out.js';
import { addReaction, editMessage, sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  ensurePlatformMessageIdColumn();
  delete process.env.NANOCLAW_ACTIVE_INPUT_PATH;
  delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
});

afterEach(() => {
  delete process.env.NANOCLAW_ACTIVE_INPUT_PATH;
  delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
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

function createSessionRouting(opts: {
  channelType: string;
  platformId: string;
  threadId?: string | null;
  messagingGroupId?: string | null;
  isGroup?: 0 | 1 | null;
}): void {
  getInboundDb().exec(`
    CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT,
      messaging_group_id TEXT,
      is_group INTEGER
    );
  `);
  getInboundDb()
    .prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id, messaging_group_id, is_group)
       VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.channelType,
      opts.platformId,
      opts.threadId ?? null,
      opts.messagingGroupId ?? null,
      opts.isGroup ?? null,
    );
}

function insertDestination(name: string, platformId: string, channelType = 'discord'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function writeActiveInput(routeKey: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-active-input-'));
  const activeInputFile = path.join(dir, '.active-input.json');
  fs.writeFileSync(activeInputFile, JSON.stringify({ inputId: 'in-active', routeKey, updatedAt: new Date().toISOString() }));
  process.env.NANOCLAW_ACTIVE_INPUT_PATH = activeInputFile;
  return dir;
}

describe('core message action tools', () => {
  it('returns a clear invariant error when a subagent guesses a blocked channel destination', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('user-channel', 'User Channel', 'blocked_channel', 'discord', 'chan-user', NULL)`,
      )
      .run();

    const result = await sendMessage.handler({ to: 'user-channel', text: 'full diff text' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Subagents report to the caller/parent, not directly to the user.');
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM messages_out').get()).toEqual({ count: 0 });
  });

  it('stamps same-route send_message rows with the active route metadata', async () => {
    const routeKey = 'opencode|discord|chan-1|dm:mg-1';
    const dir = writeActiveInput(routeKey);
    createSessionRouting({
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: null,
      messagingGroupId: 'mg-1',
      isGroup: 0,
    });

    const result = await sendMessage.handler({ text: 'Working on it.' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].route_key).toBe(routeKey);
    expect(out[0].messaging_group_id).toBe('mg-1');
    expect(out[0].is_group).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not route-stamp cross-destination send_message rows', async () => {
    const dir = writeActiveInput('opencode|discord|chan-1|dm:mg-1');
    createSessionRouting({
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: null,
      messagingGroupId: 'mg-1',
      isGroup: 0,
    });
    insertDestination('other-channel', 'chan-2');

    const result = await sendMessage.handler({ to: 'other-channel', text: 'Heads up.' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].route_key).toBeNull();
    expect(out[0].messaging_group_id).toBeNull();
    expect(out[0].is_group).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });

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

describe('undelivered-target guards (no internal-id fallback)', () => {
  it('add_reaction on an inbound row with NULL platform_message_id returns a tool error and enqueues nothing', async () => {
    insertInboundMessage({
      seq: 4,
      id: '111122223333444455:ag-discord-test-agent',
      platformMessageId: null,
    });

    expect(getMessageTargetBySeq(4)).toBeNull();

    const result = await addReaction.handler({ messageId: 4, emoji: 'white_check_mark' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not yet delivered');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('add_reaction on an undelivered outbound row returns a tool error and enqueues nothing', async () => {
    const seq = writeMessageOut({
      id: 'msg-123-abc',
      kind: 'chat',
      platform_id: '987654321098765432',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'original' }),
    });

    // No `delivered` row yet — the internal msg-<ts>-<rand> id must not leak.
    expect(getMessageTargetBySeq(seq)).toBeNull();

    const result = await addReaction.handler({ messageId: seq, emoji: 'check' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not yet delivered');
    // Only the original outbound row exists — no doomed reaction row.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('msg-123-abc');
  });

  it('edit_message on an undelivered outbound row returns a tool error and enqueues nothing', async () => {
    const seq = writeMessageOut({
      id: 'msg-456-def',
      kind: 'chat',
      platform_id: '987654321098765432',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'original' }),
    });

    const result = await editMessage.handler({ messageId: seq, text: 'updated' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not yet delivered');
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('add_reaction resolves the delivered platform id for delivered outbound rows', async () => {
    const seq = writeMessageOut({
      id: 'msg-789-ghi',
      kind: 'chat',
      platform_id: '987654321098765432',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'original' }),
    });
    getInboundDb()
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
         VALUES ('msg-789-ghi', '555566667777', 'delivered', datetime('now'))`,
      )
      .run();

    const result = await addReaction.handler({ messageId: seq, emoji: 'clock3' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages().filter((m) => m.id !== 'msg-789-ghi');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toMatchObject({
      operation: 'reaction',
      messageId: '555566667777',
    });
  });

  it('still reports not-found for unknown seq numbers', async () => {
    const result = await addReaction.handler({ messageId: 99, emoji: 'check' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not found');
  });
});
