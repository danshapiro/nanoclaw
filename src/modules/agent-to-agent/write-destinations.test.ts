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

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { inboundDbPath, resolveSession } from '../../session-manager.js';
import { createDestination } from './db/agent-destinations.js';
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
