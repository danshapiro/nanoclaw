import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { defaultAgentMailRouteFile, resolveAgentMailRoutes } from './agentmail-config.js';
import {
  claimAgentMailMessage,
  findLatestAgentMailReplyContext,
  isAgentMailMessageTerminal,
  markAgentMailMessageFailed,
  markAgentMailMessageRouted,
  markAgentMailMessageSuppressed,
  reconcileAgentMailRoutes,
  recordAgentMailMessageRoute,
} from './agentmail-state.js';

const SUPPRESSED_INPUT = {
  inboxId: 'yente@agentmail.to',
  messageId: 'm-suppressed',
  eventId: null,
  agentmailThreadId: 'am-thread-s',
  nanoThreadId: 'agentmail:yente:am-thread-s',
  messagingGroupId: 'mg-agentmail-yente',
  senderEmail: 'yente-aidy@agentmail.to',
  subject: 'Re: Hello',
  receivedAt: '2026-06-12T00:00:00.000Z',
  suppressedAt: '2026-06-12T00:00:01.000Z',
  reason: 'label:nanoclaw:outbound',
};

describe('AgentMail state helpers', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-main',
      name: 'Yente Aidy',
      folder: 'main',
      agent_provider: null,
      created_at: '2026-06-12T00:00:00.000Z',
    });
  });

  afterEach(() => closeDb());

  it('claims each provider message once while its processing lease is active', () => {
    expect(
      claimAgentMailMessage('yente@agentmail.to', 'm1', '2026-06-12T00:00:00.000Z', '2026-06-12T00:05:00.000Z'),
    ).toEqual({ claimed: true, status: 'processing' });
    expect(
      claimAgentMailMessage('yente@agentmail.to', 'm1', '2026-06-12T00:00:01.000Z', '2026-06-12T00:05:01.000Z'),
    ).toEqual({ claimed: false, status: 'active-lease' });
  });

  it('reclaims an unrouted provider message after its processing lease expires', () => {
    claimAgentMailMessage('yente@agentmail.to', 'm1', '2026-06-12T00:00:00.000Z', '2026-06-12T00:05:00.000Z');
    expect(
      claimAgentMailMessage('yente@agentmail.to', 'm1', '2026-06-12T00:05:01.000Z', '2026-06-12T00:10:01.000Z'),
    ).toEqual({ claimed: true, status: 'processing' });
  });

  it('records and retrieves latest reply context for a NanoClaw thread', () => {
    claimAgentMailMessage('yente@agentmail.to', 'm1', '2026-06-12T00:00:00.000Z', '2026-06-12T00:05:00.000Z');
    recordAgentMailMessageRoute({
      inboxId: 'yente@agentmail.to',
      messageId: 'm1',
      eventId: 'evt-1',
      agentmailThreadId: 'am-thread-1',
      nanoThreadId: 'agentmail:yente:am-thread-1',
      messagingGroupId: 'mg-agentmail-yente',
      senderEmail: 'person@example.com',
      subject: 'Hello',
      receivedAt: '2026-06-12T00:00:00.000Z',
    });
    markAgentMailMessageRouted('yente@agentmail.to', 'm1', '2026-06-12T00:00:01.000Z');

    const context = findLatestAgentMailReplyContext('yente@agentmail.to', 'agentmail:yente:am-thread-1');
    expect(context?.message_id).toBe('m1');
    expect(context?.agentmail_thread_id).toBe('am-thread-1');
  });

  it('marks suppressed messages terminal so catch-up skips them', () => {
    markAgentMailMessageSuppressed(SUPPRESSED_INPUT);
    expect(isAgentMailMessageTerminal('yente@agentmail.to', 'm-suppressed')).toBe(true);
  });

  it('does not downgrade an already-routed message to suppressed', () => {
    claimAgentMailMessage('yente@agentmail.to', 'm1', '2026-06-12T00:00:00.000Z', '2026-06-12T00:05:00.000Z');
    recordAgentMailMessageRoute({
      inboxId: 'yente@agentmail.to',
      messageId: 'm1',
      eventId: 'evt-1',
      agentmailThreadId: 'am-thread-1',
      nanoThreadId: 'agentmail:yente:am-thread-1',
      messagingGroupId: 'mg-agentmail-yente',
      senderEmail: 'person@example.com',
      subject: 'Hello',
      receivedAt: '2026-06-12T00:00:00.000Z',
    });
    markAgentMailMessageRouted('yente@agentmail.to', 'm1', '2026-06-12T00:00:01.000Z');

    markAgentMailMessageSuppressed({ ...SUPPRESSED_INPUT, messageId: 'm1' });

    const context = findLatestAgentMailReplyContext('yente@agentmail.to', 'agentmail:yente:am-thread-1');
    expect(context?.message_id).toBe('m1');
    expect(isAgentMailMessageTerminal('yente@agentmail.to', 'm1')).toBe(true);
  });

  it('refuses to claim a suppressed message', () => {
    markAgentMailMessageSuppressed(SUPPRESSED_INPUT);
    expect(
      claimAgentMailMessage(
        'yente@agentmail.to',
        'm-suppressed',
        '2026-06-12T00:00:02.000Z',
        '2026-06-12T00:05:02.000Z',
      ),
    ).toEqual({ claimed: false, status: 'already-suppressed' });
  });

  it('keeps failed messages non-terminal and claimable for retry', () => {
    claimAgentMailMessage('yente@agentmail.to', 'm-fail', '2026-06-12T00:00:00.000Z', '2026-06-12T00:05:00.000Z');
    markAgentMailMessageFailed('yente@agentmail.to', 'm-fail', '2026-06-12T00:00:01.000Z', 'route failed');

    expect(isAgentMailMessageTerminal('yente@agentmail.to', 'm-fail')).toBe(false);
    expect(
      claimAgentMailMessage('yente@agentmail.to', 'm-fail', '2026-06-12T00:00:02.000Z', '2026-06-12T00:05:02.000Z'),
    ).toEqual({ claimed: true, status: 'processing' });
  });

  it('reconciles the three inboxes as public, pre-wired messaging groups to main', () => {
    const routes = resolveAgentMailRoutes(defaultAgentMailRouteFile(), { AGENTMAIL_DOMAIN: 'agentmail.to' });
    reconcileAgentMailRoutes(routes, '2026-06-12T00:00:00.000Z');

    for (const route of routes) {
      const mg = getMessagingGroupByPlatform('agentmail', route.inboxId);
      expect(mg?.id).toBe(route.messagingGroupId);
      expect(mg?.unknown_sender_policy).toBe('public');
      expect(mg?.is_group).toBe(1);
      const agents = getMessagingGroupAgents(route.messagingGroupId);
      expect(agents).toHaveLength(1);
      expect(agents[0]?.agent_group_id).toBe('ag-main');
      expect(agents[0]?.engage_mode).toBe('pattern');
      expect(agents[0]?.engage_pattern).toBe('.');
      expect(agents[0]?.session_mode).toBe('per-thread');
    }
  });
});
