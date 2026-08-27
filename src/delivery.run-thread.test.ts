/**
 * End-to-end: a scheduled run that declares a headline delivers one short
 * anchor message to the channel and everything else into a thread under it.
 *
 * Exercises the whole delivery path (drain -> permission checks -> thread
 * resolution -> adapter) rather than the resolver in isolation, because the
 * clutter this removes is a property of what actually reaches Discord.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery-run-thread' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-run-thread';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import {
  clearDeliveryAdapterForTest,
  clearOutboundThreadResolverForTest,
  deliverSessionMessages,
  registerOutboundThreadResolver,
  setDeliveryAdapter,
} from './delivery.js';
import { clearRunThreadMemoForTest, resolveScheduledRunThread } from './modules/scheduling/run-thread.js';
import { inboundDbPath, openInboundDb, outboundDbPath, resolveSession } from './session-manager.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function seedRoute(): void {
  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'channel-1',
    name: 'yente-threaded',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function recordingAdapter() {
  const posts: Array<{ threadId: string | null; text: string }> = [];
  let seq = 0;
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, threadId, _kind, content) {
      seq += 1;
      posts.push({ threadId, text: (JSON.parse(content) as { text: string }).text });
      return `discord-msg-${seq}`;
    },
    canOpenThread: () => true,
    async openThread(_channelType, _platformId, anchorMessageId) {
      return `thread-of-${anchorMessageId}`;
    },
  });
  return posts;
}

function seedNightlyRun(session: Session, headline: string | null): void {
  const inDb = openInboundDb(session.agent_group_id, session.id);
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content, series_id)
       VALUES ('task-nightly-g7', 2, 'task', ?, 'processing', 1, 'channel-1', 'discord', ?, 'task-nightly')`,
    )
    .run(now(), JSON.stringify(headline === null ? { prompt: 'morning pass' } : { prompt: 'morning pass', headline }));
  inDb.close();

  const outDb = new Database(outboundDbPath(session.agent_group_id, session.id));
  outDb
    .prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('task-nightly-g7', 'processing', ?)",
    )
    .run(now());
  outDb.close();
}

let outboundSeq = 10;

function writeRunOutput(session: Session, rows: Array<{ id: string; text: string; inReplyTo?: string }>): void {
  const outDb = new Database(outboundDbPath(session.agent_group_id, session.id));
  for (const row of rows) {
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, ?, datetime('now'), 'chat', 'channel-1', 'discord', NULL, ?)`,
      )
      .run(row.id, (outboundSeq += 1), row.inReplyTo ?? null, JSON.stringify({ text: row.text }));
  }
  outDb.close();
}

let session: Session;

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  clearDeliveryAdapterForTest();
  clearOutboundThreadResolverForTest();
  clearRunThreadMemoForTest();
  outboundSeq = 10;
  registerOutboundThreadResolver(resolveScheduledRunThread);
  const db = initTestDb();
  runMigrations(db);
  seedRoute();
  session = resolveSession('ag-yente', 'mg-discord', null, 'shared').session;
  expect(fs.existsSync(inboundDbPath(session.agent_group_id, session.id))).toBe(true);
});

afterEach(() => {
  clearDeliveryAdapterForTest();
  clearOutboundThreadResolverForTest();
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('nightly run delivery', () => {
  it('posts the headline to the channel and every run message into its thread', async () => {
    seedNightlyRun(session, 'Nightly run results');
    const posts = recordingAdapter();
    writeRunOutput(session, [
      { id: 'out-notice', text: "I'm still working on your request.", inReplyTo: 'task-nightly-g7' },
      { id: 'out-balls', text: 'Dropped balls: 3' },
      { id: 'out-projects', text: 'Major projects: 2' },
    ]);

    await deliverSessionMessages(session);

    expect(posts).toEqual([
      { threadId: null, text: 'Nightly run results' },
      { threadId: 'thread-of-discord-msg-1', text: "I'm still working on your request." },
      { threadId: 'thread-of-discord-msg-1', text: 'Dropped balls: 3' },
      { threadId: 'thread-of-discord-msg-1', text: 'Major projects: 2' },
    ]);
  });

  it('leaves a run without a headline exactly as it was', async () => {
    seedNightlyRun(session, null);
    const posts = recordingAdapter();
    writeRunOutput(session, [
      { id: 'out-balls', text: 'Dropped balls: 3' },
      { id: 'out-projects', text: 'Major projects: 2' },
    ]);

    await deliverSessionMessages(session);

    expect(posts).toEqual([
      { threadId: null, text: 'Dropped balls: 3' },
      { threadId: null, text: 'Major projects: 2' },
    ]);
  });

  it('records the anchor thread so a later poll reuses it instead of posting a second headline', async () => {
    seedNightlyRun(session, 'Nightly run results');
    const posts = recordingAdapter();
    writeRunOutput(session, [{ id: 'out-balls', text: 'Dropped balls: 3' }]);
    await deliverSessionMessages(session);

    writeRunOutput(session, [{ id: 'out-late', text: 'One more thing' }]);
    await deliverSessionMessages(session);

    expect(posts.filter((p) => p.text === 'Nightly run results')).toHaveLength(1);
    expect(posts.at(-1)).toEqual({ threadId: 'thread-of-discord-msg-1', text: 'One more thing' });
  });
});
