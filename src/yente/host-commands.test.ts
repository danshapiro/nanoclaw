import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeDiscordApplicationCommandInteraction } from '../channels/discord-commands.js';
import { getDb, initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../db/index.js';
import { getSession } from '../db/sessions.js';
import { resolveSession } from '../session-manager.js';
import type { AgentGroup, MessagingGroup } from '../types.js';
import {
  handleYenteHostCommand,
  parseYenteHostCommandFromContent,
  type YenteHostCommandContext,
} from './host-commands.js';

vi.mock('../container-runner.js', () => ({
  stopContainerAndVerify: vi.fn().mockResolvedValue(undefined),
  isSessionOutboundWriterRunning: vi.fn().mockResolvedValue(false),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-commands' };
});

function now(): string {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-host-commands';

let agentGroup: AgentGroup;
let messagingGroup: MessagingGroup;

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  agentGroup = {
    id: 'ag-yente',
    name: 'Yente',
    folder: 'yente',
    agent_provider: null,
    created_at: now(),
  };
  messagingGroup = {
    id: 'mg-discord',
    channel_type: 'discord',
    platform_id: 'discord:guild:channel',
    name: 'Yente Test',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  };
  createAgentGroup(agentGroup);
  createMessagingGroup(messagingGroup);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function grantAdmin(userId: string): void {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'discord', userId, now());
  getDb()
    .prepare('INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, 'admin', agentGroup.id, null, now());
}

function context(content: string, userId: string | null = 'discord:admin'): YenteHostCommandContext {
  const { session } = resolveSession(agentGroup.id, messagingGroup.id, 'thread-1', 'per-thread');
  return {
    content,
    userId,
    agentGroup,
    messagingGroup,
    session,
    sessionMode: 'per-thread',
    responseAddress: {
      channelType: messagingGroup.channel_type,
      platformId: messagingGroup.platform_id,
      threadId: 'thread-1',
    },
  };
}

describe('parseYenteHostCommandFromContent', () => {
  it('recognizes slash commands and exact bare aliases only', () => {
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: '/help' }))).toBe('help');
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: '/status now' }))).toBe('status');
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: '<@1464490804734197938> /new' }))).toBe('new');
    expect(parseYenteHostCommandFromContent('<@!1464490804734197938> /clear')).toBe('clear');
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: '/stop' }))).toBe('stop');
    expect(parseYenteHostCommandFromContent('new')).toBe('new');
    expect(parseYenteHostCommandFromContent('clear')).toBe('clear');
    expect(parseYenteHostCommandFromContent('compact')).toBe('compact');
    expect(parseYenteHostCommandFromContent('stop')).toBe('stop');
    expect(parseYenteHostCommandFromContent('status please')).toBeNull();
    expect(parseYenteHostCommandFromContent('new session')).toBeNull();
    expect(parseYenteHostCommandFromContent('clear history')).toBeNull();
    expect(parseYenteHostCommandFromContent('please help me')).toBeNull();
  });

  it('parses normalized Discord application-command interactions as the same slash text', () => {
    const normalized = normalizeDiscordApplicationCommandInteraction({
      type: 2,
      guild_id: 'guild',
      channel_id: 'channel',
      data: { type: 1, name: 'stop' },
      member: { user: { id: 'u-1', username: 'Admin' } },
    });

    expect(normalized?.text).toBe('/stop');
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: normalized?.text }))).toBe('stop');
  });
});

describe('handleYenteHostCommand', () => {
  it('returns host-authored help and status responses without asking for a container wake', async () => {
    grantAdmin('discord:admin');

    const help = await handleYenteHostCommand(context(JSON.stringify({ text: '/help' })));
    expect(help.handled).toBe(true);
    expect(help.handled && help.outboundText).toContain('/status');

    const status = await handleYenteHostCommand(context('/status'));
    expect(status.handled).toBe(true);
    if (status.handled) {
      expect(status.outboundText).toContain('Uptime:');
      expect(status.outboundText).toContain(`Session: ${status.sessionForOutbound.id}`);
      expect(status.outboundText).toContain('Token availability:');
      expect(status.outboundText).toContain('Service health:');
    }
  });

  it('archives the addressed active session and creates a fresh one for /new and /clear', async () => {
    grantAdmin('discord:admin');
    const original = context('/new').session;

    const result = await handleYenteHostCommand({
      ...context('/new'),
      session: original,
    });

    expect(result.handled).toBe(true);
    expect(getSession(original.id)?.status).toBe('archived');
    expect(result.handled && result.sessionForOutbound.id).not.toBe(original.id);
    expect(result.handled && result.supersededSessionId).toBe(original.id);
    expect(result.handled && result.sessionForOutbound.messaging_group_id).toBe(messagingGroup.id);
    expect(result.handled && result.sessionForOutbound.thread_id).toBe('thread-1');

    const clear = await handleYenteHostCommand({
      ...context('/clear'),
      session: result.handled ? result.sessionForOutbound : original,
    });
    expect(clear.handled).toBe(true);
    expect(clear.handled && clear.sessionForOutbound.id).not.toBe(result.handled && result.sessionForOutbound.id);
    expect(clear.handled && clear.supersededSessionId).toBe(result.handled && result.sessionForOutbound.id);
  });

  it('uses the generic admin policy for denied and authorized admin commands', async () => {
    const denied = await handleYenteHostCommand(context('/new', 'discord:member'));
    expect(denied).toMatchObject({
      handled: true,
      outboundText: 'Permission denied: /new requires admin access.',
    });
    expect(denied.handled && 'supersededSessionId' in denied).toBe(false);

    const deniedNew = await handleYenteHostCommand(context('/new', 'discord:member'));
    const deniedClear = await handleYenteHostCommand(context('/clear', 'discord:member'));
    const deniedStop = await handleYenteHostCommand(context('/stop', 'discord:member'));
    expect(deniedNew).toMatchObject({ handled: true, outboundText: 'Permission denied: /new requires admin access.' });
    expect(deniedClear).toMatchObject({
      handled: true,
      outboundText: 'Permission denied: /clear requires admin access.',
    });
    expect(deniedStop).toMatchObject({
      handled: true,
      outboundText: 'Permission denied: /stop requires admin access.',
    });

    grantAdmin('discord:admin');
    const compact = await handleYenteHostCommand(context('/compact', 'discord:admin'));
    expect(compact).toEqual({ handled: false });
    const stop = await handleYenteHostCommand(context('/stop', 'discord:admin'));
    expect(stop).toEqual({ handled: false });
  });
});
