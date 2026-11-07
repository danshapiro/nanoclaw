import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  testDir: '/tmp/nanoclaw-test-write-destinations',
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: mocks.testDir };
});

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { inboundDbPath, outboundDbPath, resolveSession, sessionDir } from '../../session-manager.js';
import { deliverSessionMessages } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { archiveSession } from '../../db/sessions.js';
import { createDestination } from './db/agent-destinations.js';
import { routeAgentMessage } from './agent-route.js';
import { writeDestinations } from './write-destinations.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgent(id: string, name: string): void {
  createAgentGroup({
    id,
    name,
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function readDestinations(
  agentGroupId: string,
  sessionId: string,
): Array<{ name: string; type: string; channel_type: string | null }> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  try {
    return db.prepare('SELECT name, type, channel_type FROM destinations ORDER BY name').all() as Array<{
      name: string;
      type: string;
      channel_type: string | null;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fs.rmSync(mocks.testDir, { recursive: true, force: true });
  fs.mkdirSync(mocks.testDir, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  vi.mocked(wakeContainer).mockReset().mockResolvedValue(undefined);
  seedAgent('ag-primary', 'Primary');
  seedAgent('ag-child', 'Child');
  seedAgent('ag-parent', 'Parent');
  createMessagingGroup({
    id: 'mg-user',
    channel_type: 'discord',
    platform_id: 'discord:channel',
    name: 'User Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-cli-smoke',
    channel_type: 'cli',
    platform_id: 'cli-smoke:ag-primary:test',
    name: 'CLI Smoke',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(mocks.testDir, { recursive: true, force: true });
});

describe('writeDestinations channel projection policy', () => {
  it('projects channel destinations for a primary channel-wired agent', () => {
    createMessagingGroupAgent({
      id: 'mga-primary',
      messaging_group_id: 'mg-user',
      agent_group_id: 'ag-primary',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    const { session } = resolveSession('ag-primary', 'mg-user', null, 'shared');

    writeDestinations('ag-primary', session.id);

    expect(readDestinations('ag-primary', session.id)).toContainEqual({
      name: 'user-channel',
      type: 'channel',
      channel_type: 'discord',
    });
  });

  it('does not project stale CLI smoke destinations into a non-CLI session', () => {
    createMessagingGroupAgent({
      id: 'mga-primary',
      messaging_group_id: 'mg-user',
      agent_group_id: 'ag-primary',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-cli-smoke',
      messaging_group_id: 'mg-cli-smoke',
      agent_group_id: 'ag-primary',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 1000,
      created_at: now(),
    });
    const { session } = resolveSession('ag-primary', 'mg-user', null, 'shared');

    writeDestinations('ag-primary', session.id);

    expect(readDestinations('ag-primary', session.id)).toEqual([
      { name: 'user-channel', type: 'channel', channel_type: 'discord' },
    ]);
  });

  it('projects only the current CLI destination for a CLI smoke session', () => {
    createMessagingGroupAgent({
      id: 'mga-primary',
      messaging_group_id: 'mg-user',
      agent_group_id: 'ag-primary',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-cli-smoke',
      messaging_group_id: 'mg-cli-smoke',
      agent_group_id: 'ag-primary',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 1000,
      created_at: now(),
    });
    const { session } = resolveSession('ag-primary', 'mg-cli-smoke', null, 'shared');

    writeDestinations('ag-primary', session.id);

    expect(readDestinations('ag-primary', session.id)).toEqual([
      { name: 'cli-smoke', type: 'channel', channel_type: 'cli' },
    ]);
  });

  it('hides channel destinations from a subagent and keeps only a blocked marker for guessed-name errors', () => {
    createDestination({
      agent_group_id: 'ag-child',
      local_name: 'user-channel',
      target_type: 'channel',
      target_id: 'mg-user',
      created_at: now(),
    });
    createDestination({
      agent_group_id: 'ag-child',
      local_name: 'parent',
      target_type: 'agent',
      target_id: 'ag-parent',
      created_at: now(),
    });
    const { session } = resolveSession('ag-child', null, null, 'agent-shared');

    writeDestinations('ag-child', session.id);

    expect(readDestinations('ag-child', session.id)).toEqual([
      { name: 'parent', type: 'agent', channel_type: null },
      { name: 'user-channel', type: 'blocked_channel', channel_type: 'discord' },
    ]);
  });
});

describe('agent-to-agent attachment forwarding', () => {
  it('reuses one durable target message after a wake failure', async () => {
    createDestination({
      agent_group_id: 'ag-primary',
      local_name: 'child',
      target_type: 'agent',
      target_id: 'ag-child',
      created_at: now(),
    });
    const { session: source } = resolveSession('ag-primary', 'mg-user', null, 'shared');
    const { session: target } = resolveSession('ag-child', null, null, 'agent-shared');
    const msg = { id: 'source-id', platform_id: 'ag-child', content: JSON.stringify({ text: 'hello' }) };
    vi.mocked(wakeContainer).mockRejectedValueOnce(new Error('wake failed')).mockResolvedValueOnce(undefined);
    await expect(routeAgentMessage(msg, source)).rejects.toThrow('wake failed');
    await routeAgentMessage(msg, source);
    const db = new Database(inboundDbPath('ag-child', target.id));
    const rows = db.prepare("SELECT id FROM messages_in WHERE channel_type='agent'").all();
    db.close();
    expect(rows).toHaveLength(1);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('retries a failed wake through the real delivery loop without duplicating the agent message', async () => {
    createDestination({
      agent_group_id: 'ag-primary',
      local_name: 'child',
      target_type: 'agent',
      target_id: 'ag-child',
      created_at: now(),
    });
    const { session: source } = resolveSession('ag-primary', 'mg-user', null, 'shared');
    const { session: target } = resolveSession('ag-child', null, null, 'agent-shared');
    const out = new Database(outboundDbPath('ag-primary', source.id));
    out
      .prepare(
        "INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content) VALUES (?, datetime('now'), 'chat', ?, 'agent', NULL, ?)",
      )
      .run('agent-loop', 'ag-child', JSON.stringify({ text: 'hello' }));
    out.close();
    vi.mocked(wakeContainer).mockRejectedValueOnce(new Error('wake failed')).mockResolvedValueOnce(undefined);
    await deliverSessionMessages(source);
    const sourceDb = new Database(inboundDbPath('ag-primary', source.id));
    expect(sourceDb.prepare('SELECT state FROM delivery_attempts WHERE message_out_id=?').get('agent-loop')).toEqual({
      state: 'retry',
    });
    sourceDb.prepare('UPDATE delivery_attempts SET next_attempt_ms=0 WHERE message_out_id=?').run('agent-loop');
    sourceDb.close();
    await deliverSessionMessages(source);
    const targetDb = new Database(inboundDbPath('ag-child', target.id));
    expect(targetDb.prepare("SELECT count(*) AS n FROM messages_in WHERE channel_type='agent'").get()).toEqual({
      n: 1,
    });
    targetDb.close();
    const receiptDb = new Database(inboundDbPath('ag-primary', source.id));
    expect(receiptDb.prepare('SELECT status FROM delivered WHERE message_out_id=?').get('agent-loop')).toEqual({
      status: 'delivered',
    });
    receiptDb.close();
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('does not move a retry into a newly created target after its recorded target is archived', async () => {
    createDestination({
      agent_group_id: 'ag-primary',
      local_name: 'child',
      target_type: 'agent',
      target_id: 'ag-child',
      created_at: now(),
    });
    const { session: source } = resolveSession('ag-primary', 'mg-user', null, 'shared');
    const { session: target } = resolveSession('ag-child', null, null, 'agent-shared');
    const msg = { id: 'source-archive', platform_id: 'ag-child', content: JSON.stringify({ text: 'hello' }) };
    vi.mocked(wakeContainer).mockRejectedValueOnce(new Error('wake failed'));
    await expect(routeAgentMessage(msg, source)).rejects.toThrow('wake failed');
    archiveSession(target.id);
    await expect(routeAgentMessage(msg, source)).rejects.toThrow('target session is inactive');
    const db = new Database(inboundDbPath('ag-child', target.id));
    expect(db.prepare("SELECT count(*) AS n FROM messages_in WHERE channel_type='agent'").get()).toEqual({ n: 1 });
    db.close();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it.each(['missing.txt', '../escape.txt', 'link.txt'])(
    'fails closed on missing or unsafe attachment %s',
    async (filename) => {
      createDestination({
        agent_group_id: 'ag-primary',
        local_name: 'child',
        target_type: 'agent',
        target_id: 'ag-child',
        created_at: now(),
      });
      const { session: source } = resolveSession('ag-primary', 'mg-user', null, 'shared');
      const { session: target } = resolveSession('ag-child', null, null, 'agent-shared');
      const sourceOutbox = `${sessionDir('ag-primary', source.id)}/outbox/agent-missing`;
      fs.mkdirSync(sourceOutbox, { recursive: true });
      if (filename === 'link.txt') fs.symlinkSync(inboundDbPath('ag-child', target.id), `${sourceOutbox}/link.txt`);
      await expect(
        routeAgentMessage(
          {
            id: 'agent-missing',
            platform_id: 'ag-child',
            content: JSON.stringify({ text: 'hello', files: [filename] }),
          },
          source,
        ),
      ).rejects.toThrow();
      const db = new Database(inboundDbPath('ag-child', target.id));
      expect(db.prepare("SELECT count(*) AS n FROM messages_in WHERE channel_type='agent'").get()).toEqual({ n: 0 });
      db.close();
      expect(wakeContainer).not.toHaveBeenCalled();
    },
  );

  it('preserves the forwarded localPath when writeSessionMessage stores an agent message', async () => {
    createDestination({
      agent_group_id: 'ag-primary',
      local_name: 'child',
      target_type: 'agent',
      target_id: 'ag-child',
      created_at: now(),
    });
    const { session: sourceSession } = resolveSession('ag-primary', 'mg-user', null, 'shared');
    const sourceOutbox = `${sessionDir('ag-primary', sourceSession.id)}/outbox/agent-out-1`;
    fs.mkdirSync(sourceOutbox, { recursive: true });
    fs.writeFileSync(`${sourceOutbox}/report.docx`, 'forwarded file bytes');
    const { session: targetSession } = resolveSession('ag-child', null, null, 'agent-shared');

    await routeAgentMessage(
      {
        id: 'agent-out-1',
        platform_id: 'ag-child',
        content: JSON.stringify({ text: 'Review this report.', files: ['report.docx'] }),
      },
      sourceSession,
    );

    const inbound = new Database(inboundDbPath('ag-child', targetSession.id));
    try {
      const row = inbound.prepare("SELECT content FROM messages_in WHERE channel_type = 'agent'").get() as {
        content: string;
      };
      const content = JSON.parse(row.content) as {
        attachments: Array<{ localPath: string; name: string }>;
      };
      expect(content.attachments).toEqual([
        {
          name: 'report.docx',
          filename: 'report.docx',
          type: 'file',
          localPath: expect.stringMatching(/^inbox\/a2a-/),
        },
      ]);
    } finally {
      inbound.close();
    }
  });
});
