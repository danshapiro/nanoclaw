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
  };
}

describe('parseYenteHostCommandFromContent', () => {
  it('recognizes slash commands and exact bare aliases only', () => {
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: '/help' }))).toBe('help');
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: '/status now' }))).toBe('status');
    expect(parseYenteHostCommandFromContent('new')).toBe('new');
    expect(parseYenteHostCommandFromContent('clear')).toBe('clear');
    expect(parseYenteHostCommandFromContent('compact')).toBe('compact');
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
      data: { type: 1, name: 'clear' },
      member: { user: { id: 'u-1', username: 'Admin' } },
    });

    expect(normalized?.text).toBe('/clear');
    expect(parseYenteHostCommandFromContent(JSON.stringify({ text: normalized?.text }))).toBe('clear');
  });
});

describe('handleYenteHostCommand', () => {
  it('returns host-authored help and status responses without asking for a container wake', () => {
    grantAdmin('discord:admin');

    const help = handleYenteHostCommand(context(JSON.stringify({ text: '/help' })));
    expect(help.handled).toBe(true);
    expect(help.handled && help.outboundText).toContain('/status');

    const status = handleYenteHostCommand(context('/status'));
    expect(status.handled).toBe(true);
    if (status.handled) {
      expect(status.outboundText).toContain('Uptime:');
      expect(status.outboundText).toContain(`Session: ${status.sessionForOutbound.id}`);
      expect(status.outboundText).toContain('Token availability:');
      expect(status.outboundText).toContain('Service health:');
    }
  });

  it('archives the addressed active session and creates a fresh one for /new and /clear', () => {
    grantAdmin('discord:admin');
    const original = context('/new').session;

    const result = handleYenteHostCommand({
      ...context('/new'),
      session: original,
    });

    expect(result.handled).toBe(true);
    expect(getSession(original.id)?.status).toBe('archived');
    expect(result.handled && result.sessionForOutbound.id).not.toBe(original.id);
    expect(result.handled && result.sessionForOutbound.messaging_group_id).toBe(messagingGroup.id);
    expect(result.handled && result.sessionForOutbound.thread_id).toBe('thread-1');

    const clear = handleYenteHostCommand({
      ...context('/clear'),
      session: result.handled ? result.sessionForOutbound : original,
    });
    expect(clear.handled).toBe(true);
    expect(clear.handled && clear.sessionForOutbound.id).not.toBe(result.handled && result.sessionForOutbound.id);
  });

  it('uses the generic admin policy for denied and authorized admin commands', () => {
    const denied = handleYenteHostCommand(context('/new', 'discord:member'));
    expect(denied).toMatchObject({
      handled: true,
      outboundText: 'Permission denied: /new requires admin access.',
    });

    grantAdmin('discord:admin');
    const compact = handleYenteHostCommand(context('/compact', 'discord:admin'));
    expect(compact).toEqual({ handled: false });
  });
});
