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
import { setDeliveryAdapter } from './delivery.js';
import { inboundDbPath, outboundDbPath, writeOutboundDirect } from './session-manager.js';

const cleanupContainerForSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  cleanupContainerForSession: cleanupContainerForSessionMock,
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router' };
});

function now(): string {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-router';
const DISCORD_PLATFORM_ID = 'channel';
const DISCORD_THREAD_ID = 'discord:guild:channel';
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
    platform_id: DISCORD_PLATFORM_ID,
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
    platformId: DISCORD_PLATFORM_ID,
    threadId: DISCORD_THREAD_ID,
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

function deliveredRows(sessionId: string): Array<{
  message_out_id: string;
  platform_message_id: string | null;
  status: string;
}> {
  const db = new Database(inboundDbPath('ag-yente', sessionId));
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

describe('Yente host command routing', () => {
  it('writes /help and bare help as host-authored responses without waking a container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event(JSON.stringify({ text: '/help' }), 'msg-help'));
    await routeInbound(event('help', 'msg-help-bare'));

    const session = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID);
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

    const session = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID);
    expect(inboundTexts(session!.id)).toEqual(['status please', 'new session', 'clear history']);
    expect(wakeMock).toHaveBeenCalledTimes(3);
  });

  it('archives and rolls the addressed session for admin /new and /clear', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event('hello first', 'msg-first'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

    await routeInbound(event('/new', 'msg-new'));
    const afterNew = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSession(original.id)?.status).toBe('archived');
    expect(afterNew.id).not.toBe(original.id);
    expect(outboundTexts(afterNew.id)[0]).toBe(`Started a fresh session: ${afterNew.id}`);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(original.id, 'yente-session-new');
    expect(inboundTexts(original.id)).not.toContain('/new');
    expect(inboundTexts(afterNew.id)).toEqual([]);

    await routeInbound(event(JSON.stringify({ text: '/clear' }), 'msg-clear'));
    const afterClear = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSession(afterNew.id)?.status).toBe('archived');
    expect(afterClear.id).not.toBe(afterNew.id);
    expect(outboundTexts(afterClear.id)[0]).toBe(`Started a fresh session: ${afterClear.id}`);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(afterNew.id, 'yente-session-clear');
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

    const session = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
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
    const compactSession = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
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

  it('routes normalized Discord slash commands to the same per-thread session as normal messages', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('hello first', 'msg-normal-discord'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

    const normalized = normalizeDiscordApplicationCommandInteraction({
      type: 2,
      guild_id: 'guild',
      channel_id: 'channel',
      data: { type: 1, name: 'new' },
      member: { user: { id: 'admin', username: 'Admin' } },
    });
    expect(normalized?.threadId).toBe(DISCORD_THREAD_ID);

    await routeInbound({
      channelType: 'discord',
      platformId: normalized!.platformId,
      threadId: normalized!.threadId,
      message: {
        id: 'msg-slash-new',
        kind: 'chat-sdk',
        content: JSON.stringify({
          text: normalized!.text,
          applicationCommand: true,
          commandName: normalized!.commandName,
        }),
        timestamp: now(),
        isMention: true,
        isGroup: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    expect(getSession(original.id)?.status).toBe('archived');
    expect(fresh.id).not.toBe(original.id);
    expect(outboundTexts(fresh.id)[0]).toBe(`Started a fresh session: ${fresh.id}`);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(original.id, 'yente-session-new');
  });

  it('reports cleanup failure after the success response is delivered', async () => {
    vi.useFakeTimers();
    try {
      const { routeInbound } = await import('./router.js');
      cleanupContainerForSessionMock.mockRejectedValueOnce(new Error('docker failed'));
      const deliveredTexts: string[] = [];
      setDeliveryAdapter({
        async deliver(_channelType, _platformId, _threadId, _kind, content) {
          deliveredTexts.push(JSON.parse(content).text);
          return `platform-${deliveredTexts.length}`;
        },
      });

      await routeInbound(event('/clear', 'msg-clear-cleanup-fails'));
      const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();

      expect(outboundTexts(fresh.id)).toContain('Error: old session cleanup failed.');
      expect(deliveredTexts).toEqual([`Started a fresh session: ${fresh.id}`, 'Error: old session cleanup failed.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds cleanup-error delivery behind a slow success delivery attempt', async () => {
    vi.useFakeTimers();
    try {
      const { routeInbound } = await import('./router.js');
      cleanupContainerForSessionMock.mockRejectedValueOnce(new Error('docker failed'));
      const successStarted = deferred();
      const successRelease = deferred();
      const deliveredTexts: string[] = [];
      setDeliveryAdapter({
        async deliver(_channelType, _platformId, _threadId, _kind, content) {
          const text = JSON.parse(content).text as string;
          deliveredTexts.push(text);
          if (text.startsWith('Started a fresh session:')) {
            successStarted.resolve();
            await successRelease.promise;
          }
          return `platform-${deliveredTexts.length}`;
        },
      });

      const route = routeInbound(event('/clear', 'msg-clear-slow-success'));
      await successStarted.promise;
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(deliveredTexts).toHaveLength(1);
      successRelease.resolve();
      await route;
      await Promise.resolve();
      await Promise.resolve();

      const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
      expect(deliveredTexts).toEqual([`Started a fresh session: ${fresh.id}`, 'Error: old session cleanup failed.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains late outbound from the superseded session during reset cleanup', async () => {
    vi.useFakeTimers();
    try {
      const { routeInbound } = await import('./router.js');
      const deliveredTexts: string[] = [];
      setDeliveryAdapter({
        async deliver(_channelType, _platformId, _threadId, _kind, content) {
          deliveredTexts.push(JSON.parse(content).text);
          return `platform-${deliveredTexts.length}`;
        },
      });

      await routeInbound(event('hello first', 'msg-first-before-drain'));
      const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
      await routeInbound(event('/new', 'msg-new-drain'));
      const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

      writeOutboundDirect('ag-yente', original.id, {
        id: 'late-old-session-outbound',
        kind: 'chat',
        platformId: DISCORD_PLATFORM_ID,
        channelType: 'discord',
        threadId: DISCORD_THREAD_ID,
        content: JSON.stringify({ text: 'late old output' }),
      });

      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();

      expect(fresh.id).not.toBe(original.id);
      expect(deliveredTexts).not.toContain('late old output');
      expect(deliveredRows(original.id)).toContainEqual({
        message_out_id: 'late-old-session-outbound',
        platform_message_id: null,
        status: 'delivered',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
