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
import { getScheduledTask } from './modules/scheduling/ledger.js';

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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router', GROUPS_DIR: '/tmp/nanoclaw-test-router/groups' };
});

function now(): string {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-router';
const DISCORD_PLATFORM_ID = 'channel';
const DISCORD_THREAD_ID = 'discord:guild:channel';
const DISCORD_RAW_CONVERSATION_THREAD_ID = 'thread-123';
const DISCORD_CANONICAL_CONVERSATION_THREAD_ID = `discord:guild:${DISCORD_PLATFORM_ID}:${DISCORD_RAW_CONVERSATION_THREAD_ID}`;
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

function event(
  content: string,
  id = `msg-${Math.random().toString(36).slice(2)}`,
  threadId: string | null = DISCORD_THREAD_ID,
): InboundEvent {
  return {
    channelType: 'discord',
    platformId: DISCORD_PLATFORM_ID,
    threadId,
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
  it('routes an attachment-only message (empty text) to the session and wakes the container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();

    const raw = 'todo list contents';
    await routeInbound({
      channelType: 'discord',
      platformId: DISCORD_PLATFORM_ID,
      threadId: DISCORD_THREAD_ID,
      message: {
        id: 'msg-attach-only',
        kind: 'chat-sdk',
        content: JSON.stringify({
          sender: 'discord:admin',
          senderId: 'discord:admin',
          senderName: 'Admin',
          text: '',
          attachments: [
            {
              id: 'att-1',
              name: 'message.txt',
              mimeType: 'text/plain; charset=utf-8',
              size: Buffer.from(raw).length,
              data: Buffer.from(raw).toString('base64'),
            },
          ],
        }),
        timestamp: now(),
        isMention: false,
        isGroup: true,
      },
    });

    const session = getSessionsByAgentGroup('ag-yente')[0];
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-yente', session.id));
    const rows = db
      .prepare("SELECT content, trigger FROM messages_in WHERE id LIKE 'msg-attach-only%'")
      .all() as Array<{ content: string; trigger: number }>;
    db.close();
    expect(rows).toHaveLength(1);

    const parsed = JSON.parse(rows[0].content) as {
      text: string;
      attachments: Array<{ workspacePath: string }>;
    };
    expect(rows[0].trigger).toBe(1); // engage '.' fired — this message wakes the session
    expect(parsed.text).toContain('message.txt');
    expect(parsed.text).toContain('/workspace/agent/attachments/discord/');
    expect(parsed.attachments[0].workspacePath).toMatch(/^\/workspace\/agent\/attachments\/discord\//);

    // Derive the host path from the workspace path exactly as the container
    // mount maps it, instead of hardcoding the sanitized message folder name.
    const hostPath = parsed.attachments[0].workspacePath.replace(
      '/workspace/agent',
      '/tmp/nanoclaw-test-router/groups/yente',
    );
    expect(fs.readFileSync(hostPath, 'utf8')).toBe(raw);

    expect(wakeContainer).toHaveBeenCalled();
  });

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
    const deliveredTexts: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        deliveredTexts.push(JSON.parse(content).text);
        return `platform-${deliveredTexts.length}`;
      },
    });

    await routeInbound(event('hello first', 'msg-first'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

    await routeInbound(event('/new', 'msg-new'));
    const afterNew = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSession(original.id)?.status).toBe('archived');
    expect(afterNew.id).not.toBe(original.id);
    expect(outboundTexts(afterNew.id)).toEqual([]);
    expect(deliveredTexts).toContain(`Started a fresh session: ${afterNew.id}`);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(original.id, 'yente-session-new-scheduler-preserve');
    expect(inboundTexts(original.id)).not.toContain('/new');
    expect(inboundTexts(afterNew.id)).toEqual([]);

    await routeInbound(event(JSON.stringify({ text: '/clear' }), 'msg-clear'));
    const afterClear = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSession(afterNew.id)?.status).toBe('archived');
    expect(afterClear.id).not.toBe(afterNew.id);
    expect(outboundTexts(afterClear.id)).toEqual([]);
    expect(deliveredTexts).toContain(`Started a fresh session: ${afterClear.id}`);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(afterNew.id, 'yente-session-clear-scheduler-preserve');
    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it('denies unauthorized /new, /clear, and /stop before waking a container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();
    currentUserId = 'discord:member';

    await routeInbound(event('/new', 'msg-deny-new'));
    await routeInbound(event('clear', 'msg-deny-clear'));
    await routeInbound(event('/stop', 'msg-deny-stop'));

    const session = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    expect(outboundTexts(session.id)).toEqual([
      'Permission denied: /new requires admin access.',
      'Permission denied: /clear requires admin access.',
      'Permission denied: /stop requires admin access.',
    ]);
    expect(inboundTexts(session.id)).toEqual([]);
    expect(getSessionsByAgentGroup('ag-yente')).toHaveLength(1);
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('keeps authorized compact and stop on the generic command path', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wakeMock.mockClear();

    await routeInbound(event('/compact', 'msg-compact'));
    await routeInbound(event('/stop', 'msg-stop'));

    const normalized = normalizeDiscordApplicationCommandInteraction({
      type: 2,
      guild_id: 'guild',
      channel_id: 'channel',
      data: { type: 1, name: 'stop' },
      member: { user: { id: 'admin', username: 'Admin' } },
    });
    expect(normalized).not.toBeNull();

    await routeInbound({
      channelType: 'discord',
      platformId: normalized!.platformId,
      threadId: normalized!.threadId,
      message: {
        id: 'msg-discord-stop',
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

    const commandSession = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    expect(inboundTexts(commandSession.id)).toEqual(['/compact', '/stop', '/stop']);
    expect(wakeMock).toHaveBeenCalledTimes(3);
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
    expect(outboundTexts(fresh.id)).toEqual([]);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(original.id, 'yente-session-new-scheduler-preserve');
  });

  it('routes admin CLI messages with raw Discord thread ids to the existing canonical session', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('hello first', 'msg-normal-thread', DISCORD_CANONICAL_CONVERSATION_THREAD_ID));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_CANONICAL_CONVERSATION_THREAD_ID)!;

    await routeInbound(event('/new', 'msg-admin-cli-raw-thread', DISCORD_RAW_CONVERSATION_THREAD_ID));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rawSession = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_RAW_CONVERSATION_THREAD_ID);
    const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_CANONICAL_CONVERSATION_THREAD_ID)!;
    expect(rawSession).toBeUndefined();
    expect(getSession(original.id)?.status).toBe('archived');
    expect(fresh.id).not.toBe(original.id);
    expect(outboundTexts(fresh.id)).toEqual([]);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(original.id, 'yente-session-new-scheduler-preserve');
  });

  it('retargets admin CLI null-thread resets to the sole active Discord thread session', async () => {
    const { routeInbound } = await import('./router.js');
    const deliveredTexts: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        deliveredTexts.push(JSON.parse(content).text);
        return `platform-${deliveredTexts.length}`;
      },
    });

    await routeInbound(event('hello first', 'msg-normal-thread-for-null', DISCORD_CANONICAL_CONVERSATION_THREAD_ID));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_CANONICAL_CONVERSATION_THREAD_ID)!;

    await routeInbound(event('/new', 'msg-admin-cli-null-thread', null));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const nullSession = findSessionForAgent('ag-yente', 'mg-discord', null);
    const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_CANONICAL_CONVERSATION_THREAD_ID)!;
    expect(nullSession).toBeUndefined();
    expect(getSession(original.id)?.status).toBe('archived');
    expect(fresh.id).not.toBe(original.id);
    expect(deliveredTexts).toContain(`Started a fresh session: ${fresh.id}`);
    expect(cleanupContainerForSessionMock).toHaveBeenCalledWith(original.id, 'yente-session-new-scheduler-preserve');
  });

  it('refuses ambiguous admin CLI null-thread resets when multiple Discord thread sessions are active', async () => {
    const { routeInbound } = await import('./router.js');
    const deliveredTexts: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        deliveredTexts.push(JSON.parse(content).text);
        return `platform-${deliveredTexts.length}`;
      },
    });

    await routeInbound(event('hello root thread', 'msg-root-thread', DISCORD_THREAD_ID));
    await routeInbound(
      event('hello conversation thread', 'msg-conversation-thread', DISCORD_CANONICAL_CONVERSATION_THREAD_ID),
    );
    const rootSession = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    const conversationSession = findSessionForAgent(
      'ag-yente',
      'mg-discord',
      DISCORD_CANONICAL_CONVERSATION_THREAD_ID,
    )!;

    await routeInbound(event('/new', 'msg-ambiguous-null-reset', null));

    expect(findSessionForAgent('ag-yente', 'mg-discord', null)).toBeUndefined();
    expect(getSession(rootSession.id)?.status).toBe('active');
    expect(getSession(conversationSession.id)?.status).toBe('active');
    expect(deliveredTexts).toEqual([
      expect.stringContaining('Cannot reset a Discord per-thread session without a thread id'),
    ]);
    expect(cleanupContainerForSessionMock).not.toHaveBeenCalledWith(
      rootSession.id,
      'yente-session-new-scheduler-preserve',
    );
    expect(cleanupContainerForSessionMock).not.toHaveBeenCalledWith(
      conversationSession.id,
      'yente-session-new-scheduler-preserve',
    );
  });

  it('does not deliver reset success until old-session delivery suppression is complete', async () => {
    const { routeInbound } = await import('./router.js');
    const oldDeliveryStarted = deferred();
    const oldDeliveryRelease = deferred();
    const deliveredTexts: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        const text = JSON.parse(content).text as string;
        deliveredTexts.push(text);
        if (text === 'old response') {
          oldDeliveryStarted.resolve();
          await oldDeliveryRelease.promise;
        }
        return `platform-${deliveredTexts.length}`;
      },
    });

    await routeInbound(event('hello first', 'msg-first-before-suppress'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    writeOutboundDirect('ag-yente', original.id, {
      id: 'old-session-outbound-in-flight',
      kind: 'chat',
      platformId: DISCORD_PLATFORM_ID,
      channelType: 'discord',
      threadId: DISCORD_THREAD_ID,
      content: JSON.stringify({ text: 'old response' }),
    });

    const oldDelivery = (await import('./delivery.js')).deliverSessionMessages(original);
    await oldDeliveryStarted.promise;
    const reset = routeInbound(event('/new', 'msg-new-during-old-delivery'));
    await Promise.resolve();

    expect(deliveredTexts).toEqual(['old response']);
    oldDeliveryRelease.resolve();
    await oldDelivery;
    await reset;

    const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    expect(deliveredTexts).toEqual(['old response', `Started a fresh session: ${fresh.id}`]);
    expect(deliveredRows(original.id)).toContainEqual({
      message_out_id: 'old-session-outbound-in-flight',
      platform_message_id: 'platform-1',
      status: 'delivered',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('does not deliver duplicate reset success when repair overlaps the host response', async () => {
    const { routeInbound } = await import('./router.js');
    const { resumeSchedulerSupersession } = await import('./yente/scheduler-reset-repair.js');
    const resetDeliveryStarted = deferred();
    const resetDeliveryRelease = deferred();
    const deliveredTexts: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        const text = JSON.parse(content).text as string;
        deliveredTexts.push(text);
        if (text.startsWith('Started a fresh session:')) {
          resetDeliveryStarted.resolve();
          await resetDeliveryRelease.promise;
        }
        return `platform-${deliveredTexts.length}`;
      },
    });

    await routeInbound(event('hello first', 'msg-first-before-overlap-repair'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

    const reset = routeInbound(event('/new', 'msg-new-overlap-repair'));
    await resetDeliveryStarted.promise;

    const repair = resumeSchedulerSupersession(original.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deliveredTexts).toHaveLength(1);

    resetDeliveryRelease.resolve();
    await reset;
    await repair;

    const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    expect(deliveredTexts).toEqual([`Started a fresh session: ${fresh.id}`]);
    expect(
      getDb().prepare('SELECT phase FROM scheduler_session_supersessions WHERE old_session_id = ?').get(original.id),
    ).toEqual({ phase: 'response-delivered' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM scheduler_incidents').get()).toEqual({ count: 0 });
  });

  it('reports reset failure through the host adapter when verified stop fails', async () => {
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

      expect(findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)).toBeUndefined();
      expect(deliveredTexts).toEqual([
        'Error: session reset hit a problem after the old session was disturbed. I recorded it for repair.',
      ]);
      expect(
        getDb().prepare("SELECT status FROM scheduler_incidents WHERE dedupe_key LIKE 'scheduler-reset:%'").get(),
      ).toEqual({ status: 'pending' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses old outbound during scheduler-aware reset', async () => {
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
    writeOutboundDirect('ag-yente', original.id, {
      id: 'late-old-session-outbound',
      kind: 'chat',
      platformId: DISCORD_PLATFORM_ID,
      channelType: 'discord',
      threadId: DISCORD_THREAD_ID,
      content: JSON.stringify({ text: 'late old output' }),
    });

    await routeInbound(event('/new', 'msg-new-drain'));
    const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

    expect(fresh.id).not.toBe(original.id);
    expect(deliveredTexts).not.toContain('late old output');
    expect(deliveredRows(original.id)).toContainEqual({
      message_out_id: 'late-old-session-outbound',
      platform_message_id: null,
      status: 'delivered',
    });
  });

  it('does not mark reset response delivered when old outbound suppression fails', async () => {
    const delivery = await import('./delivery.js');
    const suppressSpy = vi
      .spyOn(delivery, 'suppressSessionOutbound')
      .mockRejectedValueOnce(new Error('suppress failed'));
    const { routeInbound } = await import('./router.js');
    const deliveredTexts: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        deliveredTexts.push(JSON.parse(content).text);
        return `platform-${deliveredTexts.length}`;
      },
    });

    try {
      await routeInbound(event('hello first', 'msg-first-before-suppress-failure'));
      const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

      await routeInbound(event('/new', 'msg-new-suppress-failure'));
      const fresh = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

      expect(fresh.id).not.toBe(original.id);
      expect(deliveredTexts).toEqual([
        'Error: session reset finished but old output cleanup failed. I recorded it for repair.',
      ]);
      expect(
        getDb().prepare('SELECT phase FROM scheduler_session_supersessions WHERE old_session_id = ?').get(original.id),
      ).toEqual({ phase: 'fresh-activated' });
    } finally {
      suppressSpy.mockRestore();
    }
  });

  it('applies late scheduling actions from the superseded session before stale cleanup', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound(event('hello first', 'msg-first-before-schedule-drain'));
    const original = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;

    writeOutboundDirect('ag-yente', original.id, {
      id: 'late-old-session-schedule',
      kind: 'system',
      platformId: DISCORD_PLATFORM_ID,
      channelType: 'discord',
      threadId: DISCORD_THREAD_ID,
      content: JSON.stringify({
        action: 'schedule_task',
        taskId: 'task-reset-survives',
        prompt: 'heartbeat',
        script: null,
        processAfter: '2026-06-06T12:00:00.000Z',
        recurrence: null,
        platformId: DISCORD_PLATFORM_ID,
        channelType: 'discord',
        threadId: DISCORD_THREAD_ID,
        messagingGroupId: 'mg-discord',
        isGroup: 1,
      }),
    });

    await routeInbound(event('/new', 'msg-new-schedule-drain'));

    expect(getScheduledTask('ag-yente', 'task-reset-survives')).toMatchObject({
      status: 'pending',
      process_after: '2026-06-06T12:00:00.000Z',
    });
    expect(deliveredRows(original.id)).toContainEqual({
      message_out_id: 'late-old-session-schedule',
      platform_message_id: null,
      status: 'delivered',
    });
  });
});

describe('replay idempotency', () => {
  it('recovers a write-succeeded/wake-failed route when catch-up replays the same message', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = vi.mocked(wakeContainer);
    wakeMock.mockClear();

    // First attempt: the session write lands durably, then the wake throws —
    // the strict inbound path propagates so catch-up re-presents the message.
    // The replay is the IDENTICAL event object: production catch-up
    // re-presents the original message, whose timestamp (the platform's
    // message-creation time) is stable across re-presentations.
    const replayed = event('ping', 'msg-replay');
    wakeMock.mockRejectedValueOnce(new Error('container spawn failed'));
    await expect(routeInbound(replayed)).rejects.toThrow('container spawn failed');

    // Catch-up replay of the SAME message: the durable row must not collide.
    wakeMock.mockResolvedValue(undefined);
    await routeInbound(replayed);

    const session = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-yente', session.id));
    const rows = db.prepare("SELECT id FROM messages_in WHERE id LIKE 'msg-replay%'").all() as Array<{ id: string }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('msg-replay:ag-yente');

    const wakesForAgent = wakeMock.mock.calls.filter((call) => call[0].agent_group_id === 'ag-yente');
    expect(wakesForAgent).toHaveLength(2); // failed attempt + successful retry
  });

  it('replays a multi-agent fan-out without colliding on the earlier row and retries the later agent', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const wakeMock = vi.mocked(wakeContainer);
    wakeMock.mockClear();

    createAgentGroup({
      id: 'ag-second',
      name: 'Second',
      folder: 'second',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-second',
      messaging_group_id: 'mg-discord',
      agent_group_id: 'ag-second',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      // Fan-out orders by priority DESC; pin below mga-yente (0) so the wake
      // sequence below maps deterministically to ag-yente then ag-second.
      priority: -1,
      created_at: now(),
    });

    // First pass: fan-out is sequential in agent order; the first wake
    // succeeds, the second agent's wake fails after BOTH rows are durable.
    // The replay is the IDENTICAL event object: production catch-up
    // re-presents the original message, whose timestamp (the platform's
    // message-creation time) is stable across re-presentations.
    const replayed = event('ping', 'msg-multi');
    wakeMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second agent spawn failed'));
    await expect(routeInbound(replayed)).rejects.toThrow('second agent spawn failed');

    // Catch-up replay: neither deterministic id may collide; both wakes retry.
    wakeMock.mockResolvedValue(undefined);
    await routeInbound(replayed);

    for (const agentGroupId of ['ag-yente', 'ag-second']) {
      const session = getSessionsByAgentGroup(agentGroupId)[0];
      expect(session).toBeDefined();
      const db = new Database(inboundDbPath(agentGroupId, session.id));
      const rows = db.prepare("SELECT id FROM messages_in WHERE id LIKE 'msg-multi%'").all() as Array<{
        id: string;
      }>;
      db.close();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(`msg-multi:${agentGroupId}`);
    }
    expect(wakeMock).toHaveBeenCalledTimes(4); // 2 attempts on first pass, 2 retries on replay
  });

  it('throws loudly when a distinct message reuses a provider-local id instead of silently skipping', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(event(JSON.stringify({ text: 'first' }), 'msg-x'));
    // Distinct message, same provider-local id (different timestamp/content):
    // the guard must refuse, not silently swallow.
    const distinct = event(JSON.stringify({ text: 'second' }), 'msg-x');
    distinct.message = { ...distinct.message, timestamp: '2026-08-15T05:00:00.000Z' };
    await expect(routeInbound(distinct)).rejects.toThrow(/Refusing to skip distinct message/);
    const session = findSessionForAgent('ag-yente', 'mg-discord', DISCORD_THREAD_ID)!;
    const db = new Database(inboundDbPath('ag-yente', session.id));
    const rows = db.prepare("SELECT content FROM messages_in WHERE id = 'msg-x:ag-yente'").all() as Array<{
      content: string;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('first');
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
