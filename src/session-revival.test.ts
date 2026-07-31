import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from './channels/adapter.js';
import {
  archiveSession,
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { findSessionForAgent, getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { setDeliveryAdapter } from './delivery.js';
import { inboundDbPath } from './session-manager.js';

const cleanupContainerForSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: cleanupContainerForSessionMock,
  stopContainerAndVerify: cleanupContainerForSessionMock,
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-revival' };
});

const TEST_DIR = '/tmp/nanoclaw-test-session-revival';
const PLATFORM_ID = 'channel';
const THREAD_ID = 'discord:guild:channel';

function now(): string {
  return new Date().toISOString();
}

let currentUserId: string | null = 'discord:admin';

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  currentUserId = 'discord:admin';
  cleanupContainerForSessionMock.mockReset();
  cleanupContainerForSessionMock.mockResolvedValue(true);
  setDeliveryAdapter({
    async deliver() {
      return undefined;
    },
  });

  createAgentGroup({ id: 'ag-yente', name: 'Yente', folder: 'yente', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: PLATFORM_ID,
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-yente',
    messaging_group_id: 'mg-discord',
    agent_group_id: 'ag-yente',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
  grantAdmin('discord:admin');

  const { setSenderResolver } = await import('./router.js');
  setSenderResolver(() => currentUserId);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function grantAdmin(userId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'discord', userId, now());
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, 'admin', 'ag-yente', null, now());
}

function event(content: string, id: string, isMention: boolean): InboundEvent {
  return {
    channelType: 'discord',
    platformId: PLATFORM_ID,
    threadId: THREAD_ID,
    message: { id, kind: 'chat', content, timestamp: now(), isMention, isGroup: true },
  };
}

function inboundTexts(sessionId: string): string[] {
  const db = new Database(inboundDbPath('ag-yente', sessionId));
  try {
    return (db.prepare('SELECT content FROM messages_in ORDER BY timestamp').all() as Array<{ content: string }>).map(
      (row) => (row.content.trim().startsWith('{') ? (JSON.parse(row.content).text as string) : row.content),
    );
  } finally {
    db.close();
  }
}

describe('archived-session revival (HARD REQUIREMENT: revive and deliver, never drop)', () => {
  it('an inbound mention for an archived session revives the SAME session and delivers into it', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;

    await routeInbound(event('hello before archive', 'msg-1', true));
    const original = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    expect(original).toBeDefined();

    // Simulate the stale-session archival (host migration / rollup).
    archiveSession(original.id);
    expect(getSession(original.id)?.status).toBe('archived');
    wakeMock.mockClear();

    await routeInbound(event('hello after archive', 'msg-2', true));

    // Revived: same session id, active again, message landed in ITS inbound.db.
    const revived = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    expect(revived.id).toBe(original.id);
    expect(getSession(original.id)?.status).toBe('active');
    expect(getSession(original.id)?.last_active).not.toBeNull();
    expect(inboundTexts(original.id)).toEqual(['hello before archive', 'hello after archive']);
    // No duplicate session was created for the route.
    expect(getSessionsByAgentGroup('ag-yente')).toHaveLength(1);
    // The wake path fired for the revived session.
    expect(wakeMock).toHaveBeenCalled();
    expect((wakeMock.mock.calls.at(-1)?.[0] as { id: string }).id).toBe(original.id);
  });

  it('a NON-mention follow-up in an archived mention-sticky thread still revives and delivers', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('engage me', 'msg-1', true));
    const original = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    archiveSession(original.id);

    await routeInbound(event('follow-up without mention', 'msg-2', false));

    expect(getSession(original.id)?.status).toBe('active');
    expect(inboundTexts(original.id)).toContain('follow-up without mention');
    expect(getSessionsByAgentGroup('ag-yente')).toHaveLength(1);
  });

  it('regression: /new still rolls to a FRESH session and must NOT revive the one it just archived', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('hello first', 'msg-1', true));
    const original = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;

    await routeInbound(event('/new', 'msg-new', true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterNew = findSessionForAgent('ag-yente', 'mg-discord', THREAD_ID)!;
    expect(afterNew.id).not.toBe(original.id);
    expect(getSession(original.id)?.status).toBe('archived');
  });
});
