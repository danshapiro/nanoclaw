/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { archiveSession } from './db/sessions.js';
import { DeliveryUnavailableError } from './delivery-errors.js';
import { deliverToChannel } from './channel-delivery.js';
import { resolveSession, openOutboundDbHealing, outboundDbPath, inboundDbPath } from './session-manager.js';
import {
  deliverSessionMessages,
  dropInactiveSessionOutbound,
  quiesceSessionDelivery,
  recoverInterruptedDeliveries,
  registerOutboundThreadResolver,
  clearOutboundThreadResolverForTest,
  setDeliveryAdapter,
  suppressSessionOutbound,
} from './delivery.js';
import {
  applyDiscordTypingActivity,
  setTypingContainerOwner,
  startTypingRefresh,
  stopTypingRefresh,
} from './modules/typing/index.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string, text = 'hello'): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', NULL, ?)`,
  ).run(msgId, JSON.stringify({ text }));
  db.close();
}

function insertReactionOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', NULL, ?)`,
  ).run(msgId, JSON.stringify({ operation: 'reaction', messageId: 'plat-1', emoji: 'x' }));
  db.close();
}

function insertSchedulingOutbound(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  action: Record<string, unknown> = { action: 'schedule_task', taskId: 'task-1' },
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'system', 'telegram:123', 'telegram', NULL, ?)`,
  ).run(msgId, JSON.stringify(action));
  db.close();
}

/**
 * R9 fixture (deliberate test-island duplicate of the session-db.test.ts
 * helper): materialize a REAL hot rollback journal. Copy the live journal
 * aside mid-transaction (AFTER forcing a spill+sync so the header magic is
 * written), commit, then restore the copy — a valid-header journal with no
 * owning process is precisely SQLite's "hot" condition.
 */
function plantHotJournal(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  // Tiny pager cache forces a mid-transaction journal spill+sync, which is
  // what writes the journal header magic. Without this the journal FILE
  // exists but its header is zeroed and SQLite ignores it (not hot).
  db.pragma('cache_size = 10');
  db.exec('CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, data BLOB)');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO filler (data) VALUES (?)').run(Buffer.alloc(1024 * 1024));
  const journalPath = `${dbPath}-journal`;
  if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) {
    throw new Error('test setup failed to materialize a rollback journal');
  }
  fs.copyFileSync(journalPath, `${journalPath}.saved`);
  db.exec('COMMIT');
  db.close();
  fs.copyFileSync(`${journalPath}.saved`, journalPath);
  fs.rmSync(`${journalPath}.saved`);
}

function deliveredRows(
  agentGroupId: string,
  sessionId: string,
): Array<{
  message_out_id: string;
  platform_message_id: string | null;
  status: string;
}> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  try {
    return db
      .prepare('SELECT message_out_id, platform_message_id, status FROM delivered ORDER BY message_out_id')
      .all() as Array<{
      message_out_id: string;
      platform_message_id: string | null;
      status: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('stops the cancelled pending and pushed requests after the real runner acknowledgement', async () => {
    const bun = spawnSync('bun', ['--version']).status === 0 ? 'bun' : path.join(os.homedir(), '.bun/bin/bun');
    const root = path.join(process.cwd(), '.test-tmp');
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'stop-typing-'));
    const output = path.join(dir, 'scenario.json');
    try {
      const child = spawnSync(bun, ['container/agent-runner/src/stop-typing.test-scenario.ts', output], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(child.status, child.stderr).toBe(0);
      const { ack, afterStopSnapshots } = JSON.parse(fs.readFileSync(output, 'utf8')) as {
        ack: { content: string; channel_type: string; platform_id: string; thread_id: string | null };
        afterStopSnapshots: Array<Array<{ platformId: string; threadId: string | null }>>;
      };
      vi.useFakeTimers();
      seedAgentAndChannel();
      createMessagingGroup({
        id: 'mg-discord-stop',
        channel_type: 'discord',
        platform_id: 'channel',
        name: 'Discord',
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      createMessagingGroupAgent({
        id: 'mga-discord-stop',
        messaging_group_id: 'mg-discord-stop',
        agent_group_id: 'ag-1',
        engage_mode: 'mention',
        engage_pattern: null,
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now(),
      });
      const { session } = resolveSession('ag-1', 'mg-discord-stop', null, 'shared');
      insertOutbound('ag-1', session.id, 'runner-stop');
      const db = new Database(outboundDbPath('ag-1', session.id));
      db.prepare(
        'UPDATE messages_out SET content = ?, channel_type = ?, platform_id = ?, thread_id = ? WHERE id = ?',
      ).run(ack.content, ack.channel_type, ack.platform_id, ack.thread_id, 'runner-stop');
      db.close();
      const setTyping = vi.fn().mockResolvedValue(undefined);
      const deliver = vi.fn().mockResolvedValue('sent');
      setDeliveryAdapter({ deliver, setTyping });
      try {
        for (const [thread, id] of [
          ['pushed-thread', 'pushed'],
          ['pending-thread', 'pending'],
          ['stop-thread', 'stop'],
          ['stop-thread', 'later'],
        ]) {
          startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', thread, id);
        }
        await deliverSessionMessages(session);
        expect(deliver).toHaveBeenCalledWith(
          'discord',
          'channel',
          'initial-thread',
          'chat',
          expect.any(String),
          undefined,
        );
        for (const snapshot of afterStopSnapshots) applyDiscordTypingActivity(session.id, 'ag-1', snapshot);
        setTyping.mockClear();
        await vi.advanceTimersByTimeAsync(8000);
        expect(setTyping.mock.calls).toEqual([
          ['discord', 'channel', 'stop-thread'],
          ['discord', 'channel', 'stop-thread'],
        ]);
      } finally {
        stopTypingRefresh(session.id);
        vi.useRealTimers();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
  it('preserves a newer wake grace across another delivery and previous activity completion', async () => {
    vi.useFakeTimers();
    seedAgentAndChannel();
    createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'channel',
      name: 'Discord',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-discord',
      messaging_group_id: 'mg-discord',
      agent_group_id: 'ag-1',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'previous-response');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      "UPDATE messages_out SET channel_type = 'discord', platform_id = 'channel', thread_id = 'one' WHERE id = ?",
    ).run('previous-response');
    db.close();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockResolvedValue('sent');
    setDeliveryAdapter({ deliver, setTyping });
    try {
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'one');
      applyDiscordTypingActivity(session.id, 'ag-1', [{ platformId: 'channel', threadId: 'one' }]);
      await vi.advanceTimersByTimeAsync(4000);
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'one');
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'two');
      await deliverSessionMessages(session);
      expect(deliver).toHaveBeenCalledWith('discord', 'channel', 'one', 'chat', expect.any(String), undefined);
      applyDiscordTypingActivity(session.id, 'ag-1', []);
      setTyping.mockClear();
      await vi.advanceTimersByTimeAsync(8000);
      expect(setTyping.mock.calls).toEqual([
        ['discord', 'channel', 'one'],
        ['discord', 'channel', 'two'],
        ['discord', 'channel', 'one'],
        ['discord', 'channel', 'two'],
      ]);
      await vi.advanceTimersByTimeAsync(8000);
      expect(setTyping).toHaveBeenCalledTimes(6);
    } finally {
      stopTypingRefresh(session.id);
      vi.useRealTimers();
    }
  });

  it('ends only the stop command wake grace when its acknowledgement is delivered', async () => {
    vi.useFakeTimers();
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'stop-ack');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(
      JSON.stringify({
        text: 'No active turn is running.',
        stopTypingFor: [{ platformId: 'channel', threadId: 'stopped', inputId: 'stop' }],
      }),
      'stop-ack',
    );
    db.close();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver: vi.fn().mockResolvedValue('sent'), setTyping });
    try {
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'stopped', 'stop');
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'other');
      await deliverSessionMessages(session);
      setTyping.mockClear();
      await vi.advanceTimersByTimeAsync(8000);
      expect(setTyping.mock.calls).toEqual([
        ['discord', 'channel', 'other'],
        ['discord', 'channel', 'other'],
      ]);
    } finally {
      stopTypingRefresh(session.id);
      vi.useRealTimers();
    }
  });

  it('does not end a later request in the same thread when an older stop acknowledgement arrives', async () => {
    vi.useFakeTimers();
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'stop-ack');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(
      JSON.stringify({
        text: 'Stopped.',
        stopTypingFor: [{ platformId: 'channel', threadId: 'thread', inputId: 'stop' }],
      }),
      'stop-ack',
    );
    db.close();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver: vi.fn().mockResolvedValue('sent'), setTyping });
    try {
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'thread', 'stop');
      startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'thread', 'newer');
      await deliverSessionMessages(session);
      setTyping.mockClear();
      await vi.advanceTimersByTimeAsync(8000);
      expect(setTyping).toHaveBeenCalledTimes(2);
    } finally {
      stopTypingRefresh(session.id);
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    'refreshes activity after a stop acknowledgement when a newer selected request exists: %s',
    async (newerSelected) => {
      vi.useFakeTimers();
      seedAgentAndChannel();
      const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
      insertOutbound('ag-1', session.id, 'stop-race');
      const db = new Database(outboundDbPath('ag-1', session.id));
      const snapshot = (destinations: Array<{ platformId: string; threadId: string | null }>) =>
        JSON.stringify({
          leaseId: 'current',
          updatedAt: Date.now(),
          destinations,
          acknowledgedMessageIds: [],
        });
      const updateActivity = db.prepare(
        'INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)',
      );
      updateActivity.run(
        'discord_typing_activity',
        snapshot([{ platformId: 'channel', threadId: 'cancelled' }]),
        now(),
      );
      db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(
        JSON.stringify({
          text: 'Stopped.',
          stopTypingFor: [{ platformId: 'channel', threadId: 'cancelled', inputId: 'stop' }],
        }),
        'stop-race',
      );
      const setTyping = vi.fn().mockResolvedValue(undefined);
      setTypingContainerOwner(session.id, 'current');
      setDeliveryAdapter({
        deliver: vi.fn().mockImplementation(async () => {
          updateActivity.run(
            'discord_typing_activity',
            snapshot(newerSelected ? [{ platformId: 'channel', threadId: 'cancelled' }] : []),
            now(),
          );
          return 'sent';
        }),
        setTyping,
      });
      try {
        startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'cancelled', 'stop');
        startTypingRefresh(session.id, 'ag-1', 'discord', 'channel', 'later', 'later');
        await deliverSessionMessages(session);
        setTyping.mockClear();
        await vi.advanceTimersByTimeAsync(8000);
        expect(setTyping.mock.calls.filter((call) => call[2] === 'cancelled')).toHaveLength(newerSelected ? 2 : 0);
        expect(setTyping.mock.calls.filter((call) => call[2] === 'later')).toHaveLength(2);
      } finally {
        stopTypingRefresh(session.id);
        db.close();
        vi.useRealTimers();
      }
    },
  );
  it('reads current runner typing activity even when there are no outgoing messages', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'discord_typing_activity',
      JSON.stringify({
        leaseId: 'current',
        updatedAt: Date.now(),
        destinations: [{ platformId: 'channel', threadId: 'thread' }],
      }),
      new Date().toISOString(),
    );
    db.close();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver: vi.fn(), setTyping });
    setTypingContainerOwner(session.id, 'current');
    try {
      await deliverSessionMessages(session);
      expect(setTyping).toHaveBeenCalledWith('discord', 'channel', 'thread');
    } finally {
      stopTypingRefresh(session.id);
    }
  });

  it('observes the end of typing while a delivery is still waiting on its adapter', async () => {
    vi.useFakeTimers();
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'slow-typing-delivery');
    const write = (destinations: unknown[]) => {
      const db = new Database(outboundDbPath('ag-1', session.id));
      db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
        'discord_typing_activity',
        JSON.stringify({ leaseId: 'current', updatedAt: Date.now(), destinations }),
        now(),
      );
      db.close();
    };
    write([{ platformId: 'channel', threadId: 'thread' }]);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn(async () => {
      await waiting;
      return 'sent';
    });
    setDeliveryAdapter({ deliver, setTyping });
    setTypingContainerOwner(session.id, 'current');
    const first = deliverSessionMessages(session);
    try {
      await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
      expect(setTyping).toHaveBeenCalledTimes(1);
      write([]);
      await deliverSessionMessages(session);
      await vi.advanceTimersByTimeAsync(8000);
      expect(setTyping).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await first;
      stopTypingRefresh(session.id);
      vi.useRealTimers();
    }
  });
  it('blocks non-channel-wired origin-chat channel outbound before adapter delivery', async () => {
    seedAgentAndChannel();
    createAgentGroup({
      id: 'ag-child',
      name: 'Child Agent',
      folder: 'child-agent',
      agent_provider: null,
      created_at: now(),
    });
    const { session } = resolveSession('ag-child', 'mg-1', null, 'shared');
    insertOutbound('ag-child', session.id, 'out-child-channel', 'should not send');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'platform-message';
      },
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(delivered).toEqual([]);
    expect(deliveredRows('ag-child', session.id)).toEqual([
      { message_out_id: 'out-child-channel', platform_message_id: null, status: 'failed' },
    ]);
  });

  it('continues to allow primary channel-wired agent delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-primary-channel', 'primary sends');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text as string);
        return 'platform-message';
      },
    });

    await deliverSessionMessages(session);

    expect(delivered).toEqual(['primary sends']);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-primary-channel', platform_message_id: 'platform-message', status: 'delivered' },
    ]);
  });

  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('defers a transient outbound database lock and delivers on a later poll', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-after-lock');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text as string);
        return 'platform-message';
      },
    });

    const lockDb = new Database(outboundDbPath('ag-1', session.id));
    lockDb.pragma('journal_mode = DELETE');
    lockDb.exec('BEGIN EXCLUSIVE');
    try {
      await expect(deliverSessionMessages(session)).resolves.toBeUndefined();
      expect(delivered).toEqual([]);
    } finally {
      lockDb.exec('ROLLBACK');
      lockDb.close();
    }

    await deliverSessionMessages(session);

    expect(delivered).toEqual(['hello']);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      {
        message_out_id: 'out-after-lock',
        platform_message_id: 'platform-message',
        status: 'delivered',
      },
    ]);
  }, 10_000);

  it('defers a hot-journal session without healing inline, and delivers after the gated heal (R9)', async () => {
    // Arrange exactly like the transient-lock test: session + outbound.db with
    // one due message and a capturing adapter.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-hot-journal');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text as string);
        return 'platform-message';
      },
    });

    plantHotJournal(outboundDbPath('ag-1', session.id));
    // The 1s poll must NOT perform the RW heal (a live container writer cannot
    // be ruled out here): contained, no throw, journal untouched.
    await expect(deliverSessionMessages(session)).resolves.toBeUndefined();
    expect(delivered).toEqual([]);
    expect(fs.existsSync(`${outboundDbPath('ag-1', session.id)}-journal`)).toBe(true); // NOT healed inline
    // The gated sweep path (container verified not running) performs the heal:
    openOutboundDbHealing('ag-1', session.id).close();
    expect(fs.existsSync(`${outboundDbPath('ag-1', session.id)}-journal`)).toBe(false); // healed
    await deliverSessionMessages(session);
    expect(delivered.length).toBeGreaterThan(0); // and delivery proceeds
  });

  it('contains a non-transient per-session failure instead of throwing (R9)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    fs.writeFileSync(outboundDbPath('ag-1', session.id), 'this is not a sqlite database');
    await expect(deliverSessionMessages(session)).resolves.toBeUndefined();
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });

  it('marks archived-session outbound as delivered without calling the adapter', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'stale-1');
    archiveSession(session.id);

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'should-not-send';
      },
    });

    await deliverSessionMessages(session);
    expect(delivered).toEqual([]);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'stale-1', platform_message_id: null, status: 'dropped' },
    ]);

    await deliverSessionMessages(session);
    expect(delivered).toEqual([]);
  });

  it('waits for in-flight delivery before suppressing remaining reset outbound', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1', 'first');
    insertOutbound('ag-1', session.id, 'out-2', 'second');

    const deliveryStarted = deferred();
    const deliveryRelease = deferred();
    let suppressResolved = false;
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text as string);
        deliveryStarted.resolve();
        await deliveryRelease.promise;
        return 'platform-first';
      },
    });

    const delivery = deliverSessionMessages(session);
    await deliveryStarted.promise;

    archiveSession(session.id);
    const suppression = suppressSessionOutbound(session.id, 'yente-session-reset').then((count) => {
      suppressResolved = true;
      return count;
    });
    await Promise.resolve();

    expect(suppressResolved).toBe(false);
    deliveryRelease.resolve();
    await expect(suppression).resolves.toBe(0);
    await delivery;

    expect(delivered).toEqual(['first']);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-1', platform_message_id: 'platform-first', status: 'delivered' },
      { message_out_id: 'out-2', platform_message_id: null, status: 'dropped' },
    ]);
  });

  it('explicitly drains inactive-session outbound without re-marking rows', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    archiveSession(session.id);
    insertOutbound('ag-1', session.id, 'late-1', 'late one');
    insertOutbound('ag-1', session.id, 'late-2', 'late two');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'should-not-send';
      },
    });

    await expect(dropInactiveSessionOutbound(session.id, 'yente-session-reset')).resolves.toBe(2);
    expect(delivered).toEqual([]);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'late-1', platform_message_id: null, status: 'dropped' },
      { message_out_id: 'late-2', platform_message_id: null, status: 'dropped' },
    ]);

    await expect(dropInactiveSessionOutbound(session.id, 'yente-session-reset')).resolves.toBe(0);
    expect(delivered).toEqual([]);
  });

  it('fails inactive-session suppression when the old outbox cannot be inspected', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    archiveSession(session.id);
    fs.rmSync(outboundDbPath('ag-1', session.id), { force: true });

    await expect(dropInactiveSessionOutbound(session.id, 'yente-session-reset')).rejects.toThrow(
      'Cannot inspect outbound for inactive session',
    );
  });

  it('quiesces delivery without marking undelivered rows itself', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1', 'first');

    const deliveryStarted = deferred();
    const deliveryRelease = deferred();
    let quiesceResolved = false;
    setDeliveryAdapter({
      async deliver() {
        deliveryStarted.resolve();
        await deliveryRelease.promise;
        return 'platform-first';
      },
    });

    const delivery = deliverSessionMessages(session);
    await deliveryStarted.promise;

    const quiesce = quiesceSessionDelivery(session.id, 'scheduler-reset-drain').then(() => {
      quiesceResolved = true;
    });
    await Promise.resolve();

    expect(quiesceResolved).toBe(false);
    deliveryRelease.resolve();
    await delivery;
    await quiesce;

    insertOutbound('ag-1', session.id, 'out-2', 'second');
    await deliverSessionMessages(session);

    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-1', platform_message_id: 'platform-first', status: 'delivered' },
      { message_out_id: 'out-2', platform_message_id: null, status: 'dropped' },
    ]);
  });

  it('suppresses remaining in-flight chat rows but preserves scheduler actions for reset drain', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1', 'first');
    insertOutbound('ag-1', session.id, 'out-2', 'second');
    insertSchedulingOutbound('ag-1', session.id, 'out-schedule', {
      action: 'schedule_task',
      taskId: 'task-1',
      prompt: 'heartbeat',
      processAfter: '2026-06-06T12:00:00.000Z',
    });

    const deliveryStarted = deferred();
    const deliveryRelease = deferred();
    setDeliveryAdapter({
      async deliver() {
        deliveryStarted.resolve();
        await deliveryRelease.promise;
        return 'platform-first';
      },
    });

    const delivery = deliverSessionMessages(session);
    await deliveryStarted.promise;
    const quiesce = quiesceSessionDelivery(session.id, 'scheduler-reset-drain');
    deliveryRelease.resolve();
    await delivery;
    await quiesce;

    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-1', platform_message_id: 'platform-first', status: 'delivered' },
      { message_out_id: 'out-2', platform_message_id: null, status: 'dropped' },
    ]);
  });

  it('marks 4xx delivery errors failed after a single attempt without retries', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReactionOutbound('ag-1', session.id, 'out-4xx');
    insertOutbound('ag-1', session.id, 'out-ok', 'still delivers');

    const attempts: string[] = [];
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        const parsed = JSON.parse(content) as { operation?: string; text?: string };
        if (parsed.operation === 'reaction') {
          attempts.push('reaction');
          throw new Error('Discord API error: 404 {"message": "Unknown Message", "code": 10008}');
        }
        delivered.push(parsed.text as string);
        return 'plat-ok';
      },
    });

    await deliverSessionMessages(session);
    // 4xx is deterministic — marked failed on attempt 1, other rows unaffected.
    expect(attempts).toHaveLength(1);
    expect(delivered).toEqual(['still delivers']);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-4xx', platform_message_id: null, status: 'failed' },
      { message_out_id: 'out-ok', platform_message_id: 'plat-ok', status: 'delivered' },
    ]);

    // Subsequent polls must not retry the failed row.
    await deliverSessionMessages(session);
    expect(attempts).toHaveLength(1);
  });

  it('quarantines an ambiguous platform error without automatic replay', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky', 'transient');
    const deliver = vi.fn(async () => {
      throw new Error('Discord API error: 502 Bad Gateway');
    });
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliveredRows('ag-1', session.id)).toEqual([]);
    const db = new Database(inboundDbPath('ag-1', session.id));
    expect(db.prepare('SELECT state FROM delivery_attempts WHERE message_out_id = ?').get('out-flaky')).toEqual({
      state: 'unknown',
    });
    db.close();
  });

  it('does not assume a rate-limit error proves that a multi-part send was not accepted', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-limited');
    const deliver = vi.fn(async () => {
      throw new Error('Discord API error: 429 rate limited');
    });
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliveredRows('ag-1', session.id)).toEqual([]);
    const db = new Database(inboundDbPath('ag-1', session.id));
    expect(db.prepare('SELECT state FROM delivery_attempts WHERE message_out_id = ?').get('out-limited')).toEqual({
      state: 'unknown',
    });
    db.close();
  });

  it('marks a retired channel failed without deleting its attachment', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retired');
    const out = new Database(outboundDbPath('ag-1', session.id));
    out
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'hello', files: ['proof.txt'] }), 'out-retired');
    out.close();
    const file = path.join(path.dirname(inboundDbPath('ag-1', session.id)), 'outbox', 'out-retired', 'proof.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'attachment');
    setDeliveryAdapter({ deliver: deliverToChannel });
    await deliverSessionMessages(session);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-retired', platform_message_id: null, status: 'failed' },
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe('attachment');
  });

  it('persists safe startup retries across polls and preserves files until the receipt', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-starting');
    const out = new Database(outboundDbPath('ag-1', session.id));
    out
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'hello', files: ['proof.txt'] }), 'out-starting');
    out.close();
    const file = path.join(path.dirname(inboundDbPath('ag-1', session.id)), 'outbox', 'out-starting', 'proof.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'attachment');
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new DeliveryUnavailableError('starting', true))
      .mockRejectedValueOnce(new DeliveryUnavailableError('still starting', true))
      .mockImplementationOnce(async () => {
        expect(fs.existsSync(file)).toBe(true);
        return undefined; // a successful adapter need not return a platform ID
      });
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(true);
    const db = new Database(inboundDbPath('ag-1', session.id));
    expect(
      db.prepare('SELECT state, attempts FROM delivery_attempts WHERE message_out_id = ?').get('out-starting'),
    ).toEqual({ state: 'retry', attempts: 1 });
    const first = (
      db.prepare('SELECT first_attempt_ms FROM delivery_attempts WHERE message_out_id = ?').get('out-starting') as {
        first_attempt_ms: number;
      }
    ).first_attempt_ms;
    expect(first).toBeGreaterThan(0);
    db.prepare('UPDATE delivery_attempts SET next_attempt_ms = 0 WHERE message_out_id = ?').run('out-starting');
    db.close();
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(2);
    const retryDb = new Database(inboundDbPath('ag-1', session.id));
    expect(
      retryDb
        .prepare('SELECT state, attempts, first_attempt_ms FROM delivery_attempts WHERE message_out_id = ?')
        .get('out-starting'),
    ).toEqual({ state: 'retry', attempts: 2, first_attempt_ms: first });
    retryDb.prepare('UPDATE delivery_attempts SET next_attempt_ms = 0 WHERE message_out_id = ?').run('out-starting');
    retryDb.close();
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-starting', platform_message_id: null, status: 'delivered' },
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('migrates an older retry ledger and preserves its attempt count', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-old-ledger');
    const db = new Database(inboundDbPath('ag-1', session.id));
    db.exec(
      "CREATE TABLE delivery_attempts (message_out_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '')",
    );
    db.prepare("INSERT INTO delivery_attempts (message_out_id, state, attempts) VALUES (?, 'retry', 2)").run(
      'out-old-ledger',
    );
    db.close();
    setDeliveryAdapter({ deliver: vi.fn().mockRejectedValue(new DeliveryUnavailableError('starting', true)) });
    await deliverSessionMessages(session);
    const reopened = new Database(inboundDbPath('ag-1', session.id));
    const row = reopened
      .prepare(
        'SELECT state, attempts, updated_at_ms, first_attempt_ms FROM delivery_attempts WHERE message_out_id = ?',
      )
      .get('out-old-ledger');
    expect(row).toEqual({
      state: 'retry',
      attempts: 3,
      updated_at_ms: expect.any(Number),
      first_attempt_ms: expect.any(Number),
    });
    expect((row as { first_attempt_ms: number }).first_attempt_ms).toBeGreaterThan(0);
    reopened.close();
  });

  it('fails before calling the platform when a declared file is missing', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-missing');
    const out = new Database(outboundDbPath('ag-1', session.id));
    out
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'hello', files: ['missing.txt'] }), 'out-missing');
    out.close();
    const deliver = vi.fn();
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-missing', platform_message_id: null, status: 'failed' },
    ]);
  });

  it('does not follow a symlink supplied as an outbox attachment', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-link');
    const out = new Database(outboundDbPath('ag-1', session.id));
    out
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'hello', files: ['link.txt'] }), 'out-link');
    out.close();
    const dir = path.join(path.dirname(inboundDbPath('ag-1', session.id)), 'outbox', 'out-link');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(inboundDbPath('ag-1', session.id), path.join(dir, 'link.txt'));
    const deliver = vi.fn();
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-link', platform_message_id: null, status: 'failed' },
    ]);
  });

  it('quarantines an interrupted send after a restart instead of resending', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-crashed');
    const deliver = vi.fn().mockRejectedValue(new DeliveryUnavailableError('starting', true));
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    const db = new Database(inboundDbPath('ag-1', session.id));
    db.prepare("UPDATE delivery_attempts SET state = 'sending' WHERE message_out_id = ?").run('out-crashed');
    db.close();
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    const reopened = new Database(inboundDbPath('ag-1', session.id));
    expect(reopened.prepare('SELECT state FROM delivery_attempts WHERE message_out_id = ?').get('out-crashed')).toEqual(
      { state: 'unknown' },
    );
    reopened.close();
  });

  it('recovers interrupted sends in inactive sessions at startup without waiting for a poll', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-inactive-crashed');
    setDeliveryAdapter({ deliver: vi.fn().mockRejectedValue(new DeliveryUnavailableError('starting', true)) });
    await deliverSessionMessages(session);
    const db = new Database(inboundDbPath('ag-1', session.id));
    db.prepare("UPDATE delivery_attempts SET state = 'sending' WHERE message_out_id = ?").run('out-inactive-crashed');
    db.close();
    archiveSession(session.id);
    recoverInterruptedDeliveries();
    await dropInactiveSessionOutbound(session.id, 'test-reset');
    expect(deliveredRows('ag-1', session.id)).toEqual([]);
    const reopened = new Database(inboundDbPath('ag-1', session.id));
    expect(
      reopened
        .prepare('SELECT state, updated_at_ms FROM delivery_attempts WHERE message_out_id = ?')
        .get('out-inactive-crashed'),
    ).toEqual({ state: 'unknown', updated_at_ms: expect.any(Number) });
    reopened.close();
  });

  it('quarantines a failed thread resolver after it has posted an anchor', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-anchor');
    const deliver = vi.fn().mockResolvedValue('anchor-id');
    setDeliveryAdapter({ deliver });
    registerOutboundThreadResolver(async (ctx) => {
      await ctx.adapter.deliver('telegram', 'telegram:123', null, 'chat', JSON.stringify({ text: 'anchor' }));
      throw new Error('thread creation timed out after anchor');
    });
    try {
      await deliverSessionMessages(session);
      await deliverSessionMessages(session);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliveredRows('ag-1', session.id)).toEqual([]);
      const db = new Database(inboundDbPath('ag-1', session.id));
      expect(db.prepare('SELECT state FROM delivery_attempts WHERE message_out_id = ?').get('out-anchor')).toEqual({
        state: 'unknown',
      });
      db.close();
    } finally {
      clearOutboundThreadResolverForTest();
    }
  });

  it('keeps files and quarantines when the platform succeeds but receipt persistence fails', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-receipt-error');
    const out = new Database(outboundDbPath('ag-1', session.id));
    out
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'hello', files: ['proof.txt'] }), 'out-receipt-error');
    out.close();
    const file = path.join(path.dirname(inboundDbPath('ag-1', session.id)), 'outbox', 'out-receipt-error', 'proof.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'attachment');
    const db = new Database(inboundDbPath('ag-1', session.id));
    db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON delivered BEGIN SELECT RAISE(ABORT, 'receipt failed'); END",
    );
    db.close();
    const deliver = vi.fn().mockResolvedValue('accepted');
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    expect(fs.existsSync(file)).toBe(true);
    const reopened = new Database(inboundDbPath('ag-1', session.id));
    expect(
      reopened.prepare('SELECT state FROM delivery_attempts WHERE message_out_id = ?').get('out-receipt-error'),
    ).toEqual({ state: 'unknown' });
    reopened.exec('DROP TRIGGER reject_receipt');
    reopened.close();
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('never resends after a cleanup failure following a durable receipt', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-cleanup-error');
    const file = path.join(path.dirname(inboundDbPath('ag-1', session.id)), 'outbox', 'out-cleanup-error', 'proof.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'attachment');
    const actualRemove = fs.rmSync.bind(fs);
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === path.dirname(file)) throw new Error('cleanup failed');
      return actualRemove(target, options);
    });
    const deliver = vi.fn().mockResolvedValue('accepted');
    setDeliveryAdapter({ deliver });
    try {
      await deliverSessionMessages(session);
      await deliverSessionMessages(session);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliveredRows('ag-1', session.id)).toEqual([
        { message_out_id: 'out-cleanup-error', platform_message_id: 'accepted', status: 'delivered' },
      ]);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      remove.mockRestore();
    }
  });

  it.each(['--confirmed-delivered', '--confirmed-not-delivered'])(
    'reconciles a quarantined send using %s only with explicit confirmation',
    async (confirmation) => {
      seedAgentAndChannel();
      const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
      insertOutbound('ag-1', session.id, 'out-reconcile');
      const deliver = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue('accepted');
      setDeliveryAdapter({ deliver });
      await deliverSessionMessages(session);
      const dbPath = inboundDbPath('ag-1', session.id);
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', 'scripts/reconcile-delivery.ts', dbPath, ...args],
          { encoding: 'utf8' },
        );
      expect(run('out-reconcile').status).not.toBe(0);
      const inspect = run();
      expect(inspect.status, inspect.stderr).toBe(0);
      expect(JSON.parse(inspect.stdout)).toEqual([
        expect.objectContaining({ message_out_id: 'out-reconcile', state: 'unknown' }),
      ]);
      const result = run('out-reconcile', confirmation);
      expect(result.status, result.stderr).toBe(0);
      await deliverSessionMessages(session);
      expect(deliver).toHaveBeenCalledTimes(confirmation === '--confirmed-delivered' ? 1 : 2);
      expect(deliveredRows('ag-1', session.id)).toEqual([
        {
          message_out_id: 'out-reconcile',
          platform_message_id: confirmation === '--confirmed-delivered' ? null : 'accepted',
          status: 'delivered',
        },
      ]);
    },
  );

  it('does not stale-drop scheduling system actions during inactive suppression', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    archiveSession(session.id);
    insertOutbound('ag-1', session.id, 'stale-chat', 'stale chat');
    insertSchedulingOutbound('ag-1', session.id, 'stale-schedule', {
      action: 'schedule_task',
      taskId: 'task-1',
      prompt: 'heartbeat',
      processAfter: '2026-06-06T12:00:00.000Z',
    });

    await expect(suppressSessionOutbound(session.id, 'yente-session-reset')).resolves.toBe(1);

    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'stale-chat', platform_message_id: null, status: 'dropped' },
    ]);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
