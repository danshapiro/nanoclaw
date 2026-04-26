import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveSession,
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  findSession,
  getActiveSessions,
  getSession,
  initTestDb,
  runMigrations,
} from './index.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'discord-channel',
    name: 'Discord Channel',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('archiveSession', () => {
  it('archives the session, stops its container state, and removes it from active lookup', () => {
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: now(),
    });

    archiveSession('sess-1');

    expect(getSession('sess-1')).toMatchObject({
      id: 'sess-1',
      status: 'archived',
      container_status: 'stopped',
    });
    expect(findSession('mg-1', 'thread-1')).toBeUndefined();
    expect(getActiveSessions()).toHaveLength(0);
  });
});
