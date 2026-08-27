/**
 * Per-run result threads for scheduled tasks.
 *
 * A task that declares a `headline` gets one short anchor message in the
 * channel per run; every user-visible message the run produces is delivered
 * into a platform thread opened on that anchor. These tests pin the decision
 * rules: opt-in, one anchor per run, straggler capture, and fail-open.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-run-thread' };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { openInboundDb, outboundDbPath, resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { clearRunThreadMemoForTest, resolveScheduledRunThread } from './run-thread.js';

const TEST_DIR = '/tmp/nanoclaw-test-run-thread';

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

/** Records what the delivery adapter was asked to do. */
function fakeAdapter(options: { openThread?: boolean } = {}) {
  const delivered: Array<{ platformId: string; threadId: string | null; content: string }> = [];
  const opened: Array<{ platformId: string; anchorMessageId: string; name: string }> = [];
  let anchorSeq = 0;
  const adapter: Record<string, unknown> = {
    async deliver(_channelType: string, platformId: string, threadId: string | null, _kind: string, content: string) {
      delivered.push({ platformId, threadId, content });
      anchorSeq += 1;
      return `anchor-msg-${anchorSeq}`;
    },
  };
  if (options.openThread !== false) {
    adapter.openThread = async (_channelType: string, platformId: string, anchorMessageId: string, name: string) => {
      opened.push({ platformId, anchorMessageId, name });
      return `thread-for-${anchorMessageId}`;
    };
  }
  return { adapter, delivered, opened };
}

function seedTaskProjection(inDb: Database.Database, id: string, content: Record<string, unknown>): void {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content)
       VALUES (?, ?, 'task', ?, 'processing', 1, 'channel-1', 'discord', ?)`,
    )
    .run(id, Date.now() % 1_000_000, now(), JSON.stringify(content));
}

function claimTask(session: Session, messageId: string): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)`,
  ).run(messageId, now());
  db.close();
}

function completeTask(session: Session, messageId: string): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(`UPDATE processing_ack SET status = 'completed', status_changed = ? WHERE message_id = ?`).run(
    now(),
    messageId,
  );
  db.close();
}

function context(session: Session, overrides: Record<string, unknown> = {}) {
  const inDb = openInboundDb(session.agent_group_id, session.id);
  const outDb = new Database(outboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const { adapter, delivered, opened } = (overrides.fake as ReturnType<typeof fakeAdapter>) ?? fakeAdapter();
  return {
    ctx: {
      session,
      message: {
        id: (overrides.messageId as string) ?? 'out-1',
        kind: 'chat',
        inReplyTo: (overrides.inReplyTo as string | null) ?? null,
        channelType: 'discord',
        platformId: 'channel-1',
      },
      inDb,
      outDb,
      adapter: adapter as never,
    },
    delivered,
    opened,
    close: () => {
      inDb.close();
      outDb.close();
    },
  };
}

let session: Session;

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  clearRunThreadMemoForTest();
  const db = initTestDb();
  runMigrations(db);
  seedRoute();
  session = resolveSession('ag-yente', 'mg-discord', null, 'shared').session;
  // Materialize the outbound DB the way a container wake does.
  const inDb = openInboundDb(session.agent_group_id, session.id);
  inDb.close();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('scheduled run threads', () => {
  it('leaves delivery alone when the running task declares no headline', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing' });
    inDb.close();
    claimTask(session, 'task-nightly-g1');

    const { ctx, delivered, opened, close } = context(session);
    try {
      expect(await resolveScheduledRunThread(ctx)).toBeNull();
      expect(delivered).toEqual([]);
      expect(opened).toEqual([]);
    } finally {
      close();
    }
  });

  it('posts the headline once and threads every later message of the same run under it', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing', headline: 'Nightly run results' });
    inDb.close();
    claimTask(session, 'task-nightly-g1');

    const fake = fakeAdapter();
    const first = context(session, { fake, messageId: 'out-1' });
    try {
      expect(await resolveScheduledRunThread(first.ctx)).toBe('thread-for-anchor-msg-1');
    } finally {
      first.close();
    }

    const second = context(session, { fake, messageId: 'out-2' });
    try {
      expect(await resolveScheduledRunThread(second.ctx)).toBe('thread-for-anchor-msg-1');
    } finally {
      second.close();
    }

    expect(fake.delivered).toEqual([
      { platformId: 'channel-1', threadId: null, content: JSON.stringify({ text: 'Nightly run results' }) },
    ]);
    expect(fake.opened).toEqual([
      { platformId: 'channel-1', anchorMessageId: 'anchor-msg-1', name: 'Nightly run results' },
    ]);
  });

  it('still threads a straggler written before the run finished but delivered after the ack', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing', headline: 'Nightly run results' });
    inDb.close();
    claimTask(session, 'task-nightly-g1');

    const fake = fakeAdapter();
    const first = context(session, { fake });
    try {
      await resolveScheduledRunThread(first.ctx);
    } finally {
      first.close();
    }

    completeTask(session, 'task-nightly-g1');

    const straggler = context(session, { fake, messageId: 'out-2' });
    try {
      expect(await resolveScheduledRunThread(straggler.ctx)).toBe('thread-for-anchor-msg-1');
    } finally {
      straggler.close();
    }
    expect(fake.delivered).toHaveLength(1);
  });

  it('stops threading once a real inbound message lands after the run', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing', headline: 'Nightly run results' });
    inDb.close();
    claimTask(session, 'task-nightly-g1');

    const fake = fakeAdapter();
    const first = context(session, { fake });
    try {
      await resolveScheduledRunThread(first.ctx);
    } finally {
      first.close();
    }
    completeTask(session, 'task-nightly-g1');

    const chatDb = openInboundDb(session.agent_group_id, session.id);
    chatDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('msg-user', 999998, 'chat', ?, 'pending', 1, 'channel-1', 'discord', '{"text":"hi"}')`,
      )
      .run(now());
    chatDb.close();

    const afterUser = context(session, { fake, messageId: 'out-3' });
    try {
      expect(await resolveScheduledRunThread(afterUser.ctx)).toBeNull();
    } finally {
      afterUser.close();
    }
  });

  it('correlates by in_reply_to when the run claim is already gone', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing', headline: 'Nightly run results' });
    inDb.close();

    const fake = fakeAdapter();
    const c = context(session, { fake, inReplyTo: 'task-nightly-g1' });
    try {
      expect(await resolveScheduledRunThread(c.ctx)).toBe('thread-for-anchor-msg-1');
    } finally {
      c.close();
    }
  });

  it('opens a new anchor for the next generation of the same series', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing', headline: 'Nightly run results' });
    seedTaskProjection(inDb, 'task-nightly-g2', { prompt: 'do the thing', headline: 'Nightly run results' });
    inDb.close();

    const fake = fakeAdapter();
    const g1 = context(session, { fake, inReplyTo: 'task-nightly-g1' });
    try {
      expect(await resolveScheduledRunThread(g1.ctx)).toBe('thread-for-anchor-msg-1');
    } finally {
      g1.close();
    }
    const g2 = context(session, { fake, inReplyTo: 'task-nightly-g2', messageId: 'out-2' });
    try {
      expect(await resolveScheduledRunThread(g2.ctx)).toBe('thread-for-anchor-msg-2');
    } finally {
      g2.close();
    }
    expect(fake.delivered).toHaveLength(2);
  });

  it('delivers in the channel when the platform cannot open threads, without posting an orphan headline', async () => {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    seedTaskProjection(inDb, 'task-nightly-g1', { prompt: 'do the thing', headline: 'Nightly run results' });
    inDb.close();
    claimTask(session, 'task-nightly-g1');

    const fake = fakeAdapter({ openThread: false });
    const c = context(session, { fake });
    try {
      expect(await resolveScheduledRunThread(c.ctx)).toBeNull();
      expect(fake.delivered).toEqual([]);
    } finally {
      c.close();
    }
  });
});
