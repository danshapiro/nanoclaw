import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeDiscordApplicationCommandInteraction } from './channels/discord-commands.js';
import type { InboundEvent } from './channels/adapter.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { findSessionForAgent, getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router' };
});

function now(): string {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-router';
let currentUserId: string | null = 'discord:admin';

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  currentUserId = 'discord:admin';

  createAgentGroup({
    id: 'ag-yente',
    name: 'Yente',
    folder: 'yente',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'discord:guild:channel',
    name: 'Yente Test',
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

function event(content: string, id = `msg-${Math.random().toString(36).slice(2)}`): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'discord:guild:channel',
    threadId: 'thread-1',
    message: {
      id,
      kind: 'chat',
      content,
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

function outboundTexts(sessionId: string): string[] {
  const db = new Database(outboundDbPath('ag-yente', sessionId));
  try {
    return (db.prepare('SELECT content FROM messages_out ORDER BY seq').all() as Array<{ content: string }>).map(
      (row) => JSON.parse(row.content).text as string,
    );
  } finally {
    db.close();
  }
}

function inboundTexts(sessionId: string): string[] {
  const db = new Database(inboundDbPath('ag-yente', sessionId));
  try {
    return (db.prepare('SELECT content FROM messages_in ORDER BY timestamp').all() as Array<{ content: string }>).map(
      (row) => {
        if (!row.content.trim().startsWith('{')) {
          return row.content;
        }
        return JSON.parse(row.content).text as string;
      },
    );
  } finally {
    db.close();
  }
}

describe('Yente host command routing', () => {
  it('writes /help and bare help as host-authored responses without waking a container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event(JSON.stringify({ text: '/help' }), 'msg-help'));
    await routeInbound(event('help', 'msg-help-bare'));

    const session = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1');
    expect(session).toBeDefined();
    expect(outboundTexts(session!.id)).toEqual([expect.stringContaining('/new'), expect.stringContaining('/new')]);
    expect(inboundTexts(session!.id)).toEqual([]);
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('routes non-exact bare aliases as normal user messages', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event('status please', 'msg-status-prose'));
    await routeInbound(event(JSON.stringify({ text: 'new session' }), 'msg-new-prose'));
    await routeInbound(event(JSON.stringify({ text: 'clear history' }), 'msg-clear-prose'));

    const session = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1');
    expect(inboundTexts(session!.id)).toEqual(['status please', 'new session', 'clear history']);
    expect(wakeMock).toHaveBeenCalledTimes(3);
  });

  it('archives and rolls the addressed session for admin /new and /clear', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event('hello first', 'msg-first'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1')!;

    await routeInbound(event('/new', 'msg-new'));
    const afterNew = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1')!;

    expect(getSession(original.id)?.status).toBe('archived');
    expect(afterNew.id).not.toBe(original.id);
    expect(outboundTexts(afterNew.id)[0]).toContain('fresh session');

    await routeInbound(event(JSON.stringify({ text: '/clear' }), 'msg-clear'));
    const afterClear = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1')!;

    expect(getSession(afterNew.id)?.status).toBe('archived');
    expect(afterClear.id).not.toBe(afterNew.id);
    expect(outboundTexts(afterClear.id)[0]).toContain('fresh session');
    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it('denies unauthorized /new and /clear before waking a container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();
    currentUserId = 'discord:member';

    await routeInbound(event('/new', 'msg-deny-new'));
    await routeInbound(event('clear', 'msg-deny-clear'));

    const session = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1')!;
    expect(outboundTexts(session.id)).toEqual([
      'Permission denied: /new requires admin access.',
      'Permission denied: /clear requires admin access.',
    ]);
    expect(getSessionsByAgentGroup('ag-yente')).toHaveLength(1);
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('keeps authorized compact on the generic command path and handles Discord command interactions', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event('/compact', 'msg-compact'));
    const compactSession = findSessionForAgent('ag-yente', 'mg-discord', 'thread-1')!;
    expect(inboundTexts(compactSession.id)).toEqual(['/compact']);
    expect(wakeMock).toHaveBeenCalledTimes(1);

    const normalized = normalizeDiscordApplicationCommandInteraction({
      type: 2,
      guild_id: 'guild',
      channel_id: 'channel',
      data: { type: 1, name: 'status' },
      member: { user: { id: 'admin', username: 'Admin' } },
    });
    expect(normalized).not.toBeNull();

    await routeInbound(event(JSON.stringify({ text: normalized!.text }), 'msg-discord-status'));
    expect(outboundTexts(compactSession.id)[0]).toContain('Uptime:');
  });
});
