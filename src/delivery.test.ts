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

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { archiveSession } from './db/sessions.js';
import { resolveSession, outboundDbPath, inboundDbPath } from './session-manager.js';
import {
  deliverSessionMessages,
  dropInactiveSessionOutbound,
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
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string, text = 'hello'): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', NULL, ?)`,
  ).run(msgId, JSON.stringify({ text }));
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
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
