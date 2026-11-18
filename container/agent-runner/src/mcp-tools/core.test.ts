import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getMessageTargetBySeq, getUndeliveredMessages, writeMessageOut } from '../db/messages-out.js';
// Match send-file.test.ts: virtualize only the container-only outbox prefix.
// Every source fixture and correlation read remains real local filesystem IO.
const realFs = fs;
const fsMock = {
  ...realFs,
  mkdirSync: (p: string, ...rest: Parameters<typeof realFs.mkdirSync>) =>
    p.startsWith('/workspace/outbox/') ? undefined : realFs.mkdirSync(p, ...rest),
  copyFileSync: (src: string, dst: string, ...rest: Parameters<typeof realFs.copyFileSync>) =>
    dst.startsWith('/workspace/outbox/') ? undefined : realFs.copyFileSync(src, dst, ...rest),
};
mock.module('fs', () => ({ ...fsMock, default: fsMock }));
const { addReaction, editMessage, sendMessage, sendFile } = await import('./core.js');
const { sendCard, askUserQuestion } = await import('./interactive.js');
const { scheduleTask } = await import('./scheduling.js');

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
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
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
    .run(opts.channelType, opts.platformId, opts.threadId ?? null, opts.messagingGroupId ?? null, opts.isGroup ?? null);
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
  fs.writeFileSync(
    activeInputFile,
    JSON.stringify({ inputId: 'in-active', routeKey, updatedAt: new Date().toISOString() }),
  );
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

  it('unwraps whole-body CDATA text in send_message deliveries', async () => {
    const dir = writeActiveInput('opencode|discord|chan-1|dm:mg-1');
    createSessionRouting({
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: null,
      messagingGroupId: 'mg-1',
      isGroup: 0,
    });

    const result = await sendMessage.handler({ text: '<![CDATA[Done — clean text.]]>' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done — clean text.');

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

describe('admin explicit reply_to default-tool contract', () => {
  const qa = '1500664250832785490';
  function redirectedInput(overrides: Record<string, unknown> = {}): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in
      (id,seq,kind,timestamp,status,platform_id,channel_type,thread_id,content,
       messaging_group_id,is_group,host_accepted_input_id,host_accepted_route_key,host_accepted_at,host_acceptance_ended_at)
      VALUES ($id,(SELECT COALESCE(MAX(seq),0)+1 FROM messages_in),'chat',datetime('now'),'pending',$platform,'discord',$thread,'{}',
       $mg,0,$input,$route,$accepted,$ended)`,
      )
      .run({
        $id: 'redirected',
        $platform: qa,
        $thread: null,
        $mg: 'mg-cli',
        $input: 'in-active',
        $route: 'codex|discord|qa|dm:mg-cli',
        $ended: null,
        $accepted: new Date().toISOString(),
        ...overrides,
      });
  }
  function cliSource(): string {
    createSessionRouting({
      channelType: 'cli',
      platformId: 'cli-smoke:fixture',
      messagingGroupId: 'mg-cli',
      isGroup: 0,
    });
    return writeActiveInput('codex|discord|qa|dm:mg-cli');
  }
  it('routes omitted-to progress and files through the accepted explicit reply with null thread', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      const file = path.join(dir, 'fixture.txt');
      fs.writeFileSync(file, 'fixture');
      expect((await sendMessage.handler({ text: 'Working...' })).isError).toBeUndefined();
      expect((await sendFile.handler({ path: file })).isError).toBeUndefined();
      const rows = getUndeliveredMessages();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.channel_type).toBe('discord');
        expect(row.platform_id).toBe(qa);
        expect(row.thread_id).toBeNull();
        expect(row.route_key).toBe('codex|discord|qa|dm:mg-cli');
        expect(row.messaging_group_id).toBe('mg-cli');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('ignores a newer unrelated input and uses exact accepted identity', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      redirectedInput({ $id: 'newer', $input: 'other-input', $platform: 'other-channel' });
      await sendMessage.handler({ text: 'OK' });
      expect(getUndeliveredMessages()[0].platform_id).toBe(qa);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses conflicting ended or foreign-source accepted evidence without queuing', async () => {
    for (const delta of [{ $ended: '2026-11-18T10:00:00Z' }, { $mg: 'foreign' }]) {
      const dir = cliSource();
      try {
        redirectedInput(delta);
        await expect(sendMessage.handler({ text: 'unsafe' })).rejects.toThrow(/routing/);
        expect(getUndeliveredMessages()).toHaveLength(0);
      } finally {
        getInboundDb().exec('DELETE FROM messages_in; DROP TABLE session_routing');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  it('refuses mixed reply addresses instead of choosing the last one', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      redirectedInput({ $id: 'conflict', $platform: 'other-channel' });
      await expect(sendMessage.handler({ text: 'unsafe' })).rejects.toThrow(/ambiguous/);
      expect(getUndeliveredMessages()).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses a relay route-lock mismatch before a default tool queues anything', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      process.env.NANOCLAW_RELAY_ROUTE_KEY = 'codex|discord|different|dm:other';
      await expect(sendMessage.handler({ text: 'must stay locked' })).rejects.toThrow(/relay route lock/);
      await expect(sendFile.handler({ path: path.join(dir, 'not-written.txt') })).rejects.toThrow(/relay route lock/);
      expect(getUndeliveredMessages()).toHaveLength(0);
      process.env.NANOCLAW_RELAY_ROUTE_KEY = 'codex|discord|qa|dm:mg-cli';
      expect((await sendMessage.handler({ text: 'same locked route' })).isError).toBeUndefined();
      expect(getUndeliveredMessages()[0].platform_id).toBe(qa);
    } finally {
      delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for relayed CLI default sends with missing identity or accepted proof', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      getInboundDb().exec("UPDATE session_routing SET platform_id='local'");
      process.env.NANOCLAW_RELAY_ROUTE_KEY = 'codex|discord|qa|dm:mg-cli';
      fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
      await expect(sendMessage.handler({ text: 'must not reach a terminal' })).rejects.toThrow(/identity/);
      expect(getUndeliveredMessages()).toHaveLength(0);
      fs.writeFileSync(
        process.env.NANOCLAW_ACTIVE_INPUT_PATH!,
        JSON.stringify({ inputId: 'missing', routeKey: process.env.NANOCLAW_RELAY_ROUTE_KEY }),
      );
      await expect(sendMessage.handler({ text: 'no accepted proof' })).rejects.toThrow(/Missing accepted proof/);
      expect(getUndeliveredMessages()).toHaveLength(0);
      getInboundDb().exec("UPDATE messages_in SET host_acceptance_ended_at=datetime('now')");
      delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
      fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
      await sendMessage.handler({ text: 'ordinary unrelayed terminal' });
      expect(getUndeliveredMessages()[0].platform_id).toBe('local');
    } finally {
      delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes cards and questions through the same accepted reply as other default tools', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      expect((await sendCard.handler({ card: { title: 'fixture' } })).isError).toBeUndefined();
      // Expired timeout keeps this a hermetic address/enqueue test, no polling.
      await askUserQuestion.handler({ title: 'fixture', question: 'fixture?', options: ['yes'], timeout: -1 });
      const rows = getUndeliveredMessages();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.channel_type).toBe('discord');
        expect(row.platform_id).toBe(qa);
        expect(row.thread_id).toBeNull();
        expect(row.route_key).toBe('codex|discord|qa|dm:mg-cli');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes newly requested tasks through the explicit reply without editing existing tasks', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      await scheduleTask.handler({ prompt: 'fixture only', processAfter: '2099-01-01T00:00:00Z' });
      const row = getOutboundDb().prepare("SELECT * FROM messages_out WHERE kind='system'").get() as {
        content: string;
        platform_id: string;
      };
      expect(row.platform_id).toBe(qa);
      expect(JSON.parse(row.content)).toMatchObject({
        channelType: 'discord',
        platformId: qa,
        threadId: null,
        messagingGroupId: 'mg-cli',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fall back to a destination when a relay has lost its session route and identity', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      getInboundDb().exec('DELETE FROM session_routing');
      process.env.NANOCLAW_RELAY_ROUTE_KEY = 'codex|discord|qa|dm:mg-cli';
      fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
      insertDestination('only-destination', 'must-not-send');
      await expect(sendMessage.handler({ text: 'no fallback' })).rejects.toThrow(/identity/);
      expect(getUndeliveredMessages()).toHaveLength(0);
    } finally {
      delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves unresolved redirects when unrelayed identity or accepted proof is missing', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      getInboundDb().exec("UPDATE session_routing SET platform_id='local'");
      fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
      await expect(sendMessage.handler({ text: 'no terminal leak' })).rejects.toThrow(/identity/);
      fs.writeFileSync(
        process.env.NANOCLAW_ACTIVE_INPUT_PATH!,
        JSON.stringify({ inputId: 'missing', routeKey: 'codex|discord|qa|dm:mg-cli' }),
      );
      await expect(sendMessage.handler({ text: 'no proof fallback' })).rejects.toThrow(/Missing accepted proof/);
      expect(getUndeliveredMessages()).toHaveLength(0);
      getInboundDb().exec("UPDATE messages_in SET host_acceptance_ended_at=datetime('now')");
      fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
      await sendMessage.handler({ text: 'ordinary terminal after redirect ended' });
      expect(getUndeliveredMessages()[0].platform_id).toBe('local');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing or malformed host acceptance timestamps', async () => {
    for (const accepted of [null, 'not-a-timestamp']) {
      const dir = cliSource();
      try {
        redirectedInput({ $accepted: accepted });
        await expect(sendMessage.handler({ text: 'incomplete proof' })).rejects.toThrow(/routing/);
        expect(getUndeliveredMessages()).toHaveLength(0);
      } finally {
        getInboundDb().exec('DELETE FROM messages_in; DROP TABLE session_routing');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('refuses relay-mode default sends when the route lock is missing or empty', async () => {
    for (const mode of ['1', 'true']) {
      for (const key of [undefined, '']) {
        const dir = cliSource();
        try {
          getInboundDb().exec("UPDATE session_routing SET platform_id='local'");
          fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
          process.env.NANOCLAW_RELAY_MODE = mode;
          if (key === undefined) delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
          else process.env.NANOCLAW_RELAY_ROUTE_KEY = key;
          await expect(sendMessage.handler({ text: 'no unlocked relay delivery' })).rejects.toThrow(/relay route lock/);
          expect(getUndeliveredMessages()).toHaveLength(0);
        } finally {
          delete process.env.NANOCLAW_RELAY_MODE;
          delete process.env.NANOCLAW_RELAY_ROUTE_KEY;
          getInboundDb().exec('DROP TABLE session_routing');
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  it('refuses total accepted-proof loss while an active CLI identity remains', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      getInboundDb().exec("DELETE FROM messages_in; UPDATE session_routing SET platform_id='local'");
      await expect(sendMessage.handler({ text: 'no terminal leak after total proof loss' })).rejects.toThrow(
        /Missing accepted proof/,
      );
      await expect(sendCard.handler({ card: { title: 'no fallback' } })).rejects.toThrow(/Missing accepted proof/);
      expect(getUndeliveredMessages()).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps explicit destinations and ordinary local CLI defaults unchanged', async () => {
    const dir = cliSource();
    try {
      redirectedInput();
      insertDestination('explicit-other', 'other-channel');
      await sendMessage.handler({ to: 'explicit-other', text: 'explicit' });
      expect(getUndeliveredMessages()[0].platform_id).toBe('other-channel');
      getInboundDb().exec("DELETE FROM messages_in; UPDATE session_routing SET platform_id='local'");
      fs.unlinkSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH!);
      await sendMessage.handler({ text: 'terminal' });
      expect(getUndeliveredMessages()[1].platform_id).toBe('local');
      expect(getUndeliveredMessages()[1].channel_type).toBe('cli');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
