import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveSession,
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  findLatestArchivedSessionByAgentGroup,
  findLatestArchivedSessionForAgent,
  findSession,
  findSessionForAgent,
  getActiveSessions,
  getSession,
  initTestDb,
  reactivateSession,
  runMigrations,
} from './index.js';
import type { Session } from '../types.js';

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

describe('archived-session revival helpers', () => {
  function seedSession(id: string, overrides: Partial<Session> = {}): void {
    createSession({
      id,
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
      ...overrides,
    });
  }

  it('findLatestArchivedSessionForAgent returns only archived rows for the exact route', () => {
    seedSession('sess-active'); // active — must be ignored
    seedSession('sess-resetting', { status: 'resetting' }); // must be ignored
    seedSession('sess-arch-old', { status: 'archived', last_active: '2026-01-01T00:00:00.000Z' });
    seedSession('sess-arch-new', { status: 'archived', last_active: '2026-06-01T00:00:00.000Z' });
    seedSession('sess-arch-other-thread', { status: 'archived', thread_id: 'thread-2' });

    expect(findLatestArchivedSessionForAgent('ag-1', 'mg-1', 'thread-1')?.id).toBe('sess-arch-new');
    expect(findLatestArchivedSessionForAgent('ag-1', 'mg-1', 'no-such-thread')).toBeUndefined();
  });

  it('findLatestArchivedSessionForAgent matches NULL thread ids', () => {
    seedSession('sess-arch-null-thread', { status: 'archived', thread_id: null });
    expect(findLatestArchivedSessionForAgent('ag-1', 'mg-1', null)?.id).toBe('sess-arch-null-thread');
  });

  it('findLatestArchivedSessionByAgentGroup returns the most recent archived session', () => {
    seedSession('sess-arch-a', { status: 'archived', last_active: '2026-01-01T00:00:00.000Z' });
    seedSession('sess-arch-b', { status: 'archived', last_active: '2026-06-01T00:00:00.000Z', thread_id: 'thread-2' });
    expect(findLatestArchivedSessionByAgentGroup('ag-1')?.id).toBe('sess-arch-b');
    expect(findLatestArchivedSessionByAgentGroup('ag-none')).toBeUndefined();
  });

  it('reactivateSession makes an archived session active again and stamps last_active', () => {
    seedSession('sess-revive', { status: 'archived', last_active: null });

    reactivateSession('sess-revive');

    const revived = getSession('sess-revive')!;
    expect(revived.status).toBe('active');
    expect(revived.last_active).not.toBeNull();
    expect(findSessionForAgent('ag-1', 'mg-1', 'thread-1')?.id).toBe('sess-revive');
    expect(getActiveSessions().map((s) => s.id)).toContain('sess-revive');
  });
});
