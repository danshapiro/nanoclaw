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
import { resolveSession, outboundDbPath, inboundDbPath } from './session-manager.js';
import {
  deliverSessionMessages,
  dropInactiveSessionOutbound,
  quiesceSessionDelivery,
  setDeliveryAdapter,
  suppressSessionOutbound,
} from './delivery.js';

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
      { message_out_id: 'stale-1', platform_message_id: null, status: 'delivered' },
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
      { message_out_id: 'out-2', platform_message_id: null, status: 'delivered' },
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
      { message_out_id: 'late-1', platform_message_id: null, status: 'delivered' },
      { message_out_id: 'late-2', platform_message_id: null, status: 'delivered' },
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
      { message_out_id: 'out-2', platform_message_id: null, status: 'delivered' },
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
      { message_out_id: 'out-2', platform_message_id: null, status: 'delivered' },
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

  it('keeps the 3-attempt retry behavior for transient (non-4xx) errors', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky', 'transient');

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        throw new Error('Discord API error: 502 Bad Gateway');
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toBe(1);
    expect(deliveredRows('ag-1', session.id)).toEqual([]);

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(calls).toBe(3);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-flaky', platform_message_id: null, status: 'failed' },
    ]);
  });

  it('treats 429 rate-limit errors as transient and retries them', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-limited', 'rate limited once');

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        if (calls === 1) {
          throw new Error('Discord API error: 429 {"message": "You are being rate limited.", "retry_after": 0.3}');
        }
        return 'plat-limited';
      },
    });

    await deliverSessionMessages(session);
    // 429 is transient -- not marked failed on attempt 1.
    expect(calls).toBe(1);
    expect(deliveredRows('ag-1', session.id)).toEqual([]);

    await deliverSessionMessages(session);
    expect(calls).toBe(2);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-limited', platform_message_id: 'plat-limited', status: 'delivered' },
    ]);
  });

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
      { message_out_id: 'stale-chat', platform_message_id: null, status: 'delivered' },
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
