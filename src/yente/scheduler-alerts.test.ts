import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { clearDeliveryAdapterForTest, setDeliveryAdapter } from '../delivery.js';
import type { Session } from '../types.js';
import {
  deliverDueSchedulerIncidents,
  deliverPendingSchedulerIncident,
  reportSchedulerIncident,
  resetDedupeLogRateLimitForTest,
} from './scheduler-alerts.js';

const ORIGINAL_ENV = { ...process.env };

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.YENTE_SCHEDULER_ALERT_CHANNEL_TYPE;
  delete process.env.YENTE_SCHEDULER_ALERT_PLATFORM_ID;
  delete process.env.YENTE_SCHEDULER_ALERT_THREAD_ID;
  clearDeliveryAdapterForTest();
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroup();
});

afterEach(() => {
  clearDeliveryAdapterForTest();
  closeDb();
  process.env = { ...ORIGINAL_ENV };
});

describe('scheduler alerts', () => {
  it('records a durable pending incident without attempting network delivery', async () => {
    const inserted = await reportSchedulerIncident({
      dedupeKey: 'incident:pending-first',
      severity: 'error',
      message: 'scheduler failed',
      agentGroupId: 'ag-yente',
      details: { reason: 'test' },
    });

    expect(inserted).toBe(true);
    expect(incident('incident:pending-first')).toMatchObject({
      status: 'pending',
      severity: 'error',
      attempt_count: 0,
      message: 'scheduler failed',
    });
  });

  it('delivers affected-route alerts from central session and messaging group data', async () => {
    const session = seedSession();
    const delivered: Array<{ channelType: string; platformId: string; threadId: string | null; text: string }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, _kind, content) {
        delivered.push({ channelType, platformId, threadId, text: JSON.parse(content).text });
        return 'platform-alert-1';
      },
    });
    await reportSchedulerIncident({
      dedupeKey: 'incident:central-route',
      severity: 'warn',
      message: 'central route wins',
      agentGroupId: 'ag-yente',
      sessionId: session.id,
      channelType: 'discord',
      platformId: 'legacy-channel',
      threadId: 'legacy-thread',
      details: { reason: 'test' },
    });

    expect(await deliverDueSchedulerIncidents()).toBe(1);

    expect(delivered).toEqual([
      {
        channelType: 'discord',
        platformId: 'central-channel',
        threadId: 'central-thread',
        text: 'central route wins',
      },
    ]);
    expect(incident('incident:central-route')).toMatchObject({ status: 'reported', attempt_count: 0 });
  });

  it('uses owner/admin DM fallback before legacy row fields', async () => {
    seedOwnerDm();
    const delivered: Array<{ channelType: string; platformId: string; threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId) {
        delivered.push({ channelType, platformId, threadId });
        return 'platform-alert-owner';
      },
    });
    await reportSchedulerIncident({
      dedupeKey: 'incident:owner-fallback',
      severity: 'error',
      message: 'owner fallback',
      agentGroupId: 'ag-yente',
      channelType: 'discord',
      platformId: 'legacy-channel',
      threadId: 'legacy-thread',
      details: { reason: 'test' },
    });

    await deliverDueSchedulerIncidents();

    expect(delivered).toEqual([{ channelType: 'discord', platformId: 'owner', threadId: null }]);
  });

  it('uses complete non-CLI legacy route fields only when central and owner routes are unavailable', async () => {
    const delivered: Array<{ channelType: string; platformId: string; threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId) {
        delivered.push({ channelType, platformId, threadId });
        return 'platform-alert-legacy';
      },
    });
    await reportSchedulerIncident({
      dedupeKey: 'incident:legacy-route',
      severity: 'warn',
      message: 'legacy route',
      agentGroupId: 'ag-yente',
      sessionId: 'missing-session',
      channelType: 'discord',
      platformId: 'legacy-channel',
      threadId: 'legacy-thread',
      details: { reason: 'test' },
    });

    await deliverDueSchedulerIncidents();

    expect(delivered).toEqual([{ channelType: 'discord', platformId: 'legacy-channel', threadId: 'legacy-thread' }]);
  });

  it('uses configured fallback routes and rejects cli fallback routes', async () => {
    const delivered: Array<{ channelType: string; platformId: string; threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId) {
        delivered.push({ channelType, platformId, threadId });
        return 'platform-alert-config';
      },
    });
    process.env.YENTE_SCHEDULER_ALERT_CHANNEL_TYPE = 'discord';
    process.env.YENTE_SCHEDULER_ALERT_PLATFORM_ID = 'fallback-channel';
    process.env.YENTE_SCHEDULER_ALERT_THREAD_ID = 'fallback-thread';
    await reportSchedulerIncident({
      dedupeKey: 'incident:configured-fallback',
      severity: 'error',
      message: 'configured fallback',
      agentGroupId: 'ag-yente',
      details: { reason: 'test' },
    });

    await deliverDueSchedulerIncidents();
    expect(delivered).toEqual([
      { channelType: 'discord', platformId: 'fallback-channel', threadId: 'fallback-thread' },
    ]);

    process.env.YENTE_SCHEDULER_ALERT_CHANNEL_TYPE = 'cli';
    process.env.YENTE_SCHEDULER_ALERT_PLATFORM_ID = 'stdout';
    await reportSchedulerIncident({
      dedupeKey: 'incident:cli-fallback-rejected',
      severity: 'error',
      message: 'cli rejected',
      agentGroupId: 'ag-yente',
      details: { reason: 'test' },
    });

    await deliverPendingSchedulerIncident('incident:cli-fallback-rejected');
    expect(incident('incident:cli-fallback-rejected')).toMatchObject({ status: 'unroutable' });
  });

  it('dedupes repeated incident keys and does not spam delivery', async () => {
    seedSession();
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text);
        return 'platform-alert-dedupe';
      },
    });

    expect(
      await reportSchedulerIncident({
        dedupeKey: 'incident:dedupe',
        severity: 'warn',
        message: 'first message',
        agentGroupId: 'ag-yente',
        sessionId: 'sess-central',
        details: { reason: 'first' },
      }),
    ).toBe(true);
    expect(
      await reportSchedulerIncident({
        dedupeKey: 'incident:dedupe',
        severity: 'error',
        message: 'second message',
        agentGroupId: 'ag-yente',
        sessionId: 'sess-central',
        details: { reason: 'second' },
      }),
    ).toBe(false);

    await deliverDueSchedulerIncidents();
    await deliverDueSchedulerIncidents(new Date(Date.now() + 300_000));

    expect(delivered).toEqual(['first message']);
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM scheduler_incidents WHERE dedupe_key = 'incident:dedupe'").get(),
    ).toEqual({
      count: 1,
    });
  });

  it('rate-limits the scheduler_incident_deduped log line (R3)', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    resetDedupeLogRateLimitForTest();
    const args = {
      dedupeKey: 'test:dedupe-rate-limit',
      severity: 'warn' as const,
      message: 'x',
      details: {},
    };
    await reportSchedulerIncident(args); // inserts
    await reportSchedulerIncident(args); // duplicate #1 -> logs deduped
    await reportSchedulerIncident(args); // duplicate #2 -> suppressed (inside window)
    spy.mockRestore();
    const dedupedLines = writes.filter((w) => w.includes('scheduler_incident_deduped'));
    expect(dedupedLines).toHaveLength(1);
  });

  it('keeps routed incidents pending when the adapter is missing', async () => {
    const session = seedSession();
    await reportSchedulerIncident({
      dedupeKey: 'incident:missing-adapter',
      severity: 'error',
      message: 'adapter missing',
      agentGroupId: 'ag-yente',
      sessionId: session.id,
      details: { reason: 'test' },
    });

    await deliverDueSchedulerIncidents();

    expect(incident('incident:missing-adapter')).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'Delivery adapter is not ready',
    });
  });

  it('marks incidents unroutable only when no route source exists', async () => {
    await reportSchedulerIncident({
      dedupeKey: 'incident:no-route',
      severity: 'error',
      message: 'no route',
      agentGroupId: 'ag-yente',
      details: { reason: 'test' },
    });

    await deliverDueSchedulerIncidents();

    expect(incident('incident:no-route')).toMatchObject({
      status: 'unroutable',
      last_error: 'No scheduler alert route is available',
    });
  });

  it('leaves failed delivery pending and retries only when due', async () => {
    const session = seedSession();
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver() {
        throw new Error('adapter failed');
      },
    });
    await reportSchedulerIncident({
      dedupeKey: 'incident:retry',
      severity: 'error',
      message: 'retry me',
      agentGroupId: 'ag-yente',
      sessionId: session.id,
      details: { reason: 'test' },
    });

    await deliverDueSchedulerIncidents();
    expect(incident('incident:retry')).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'adapter failed',
    });

    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text);
        return 'platform-alert-retry';
      },
    });
    await deliverDueSchedulerIncidents();
    expect(delivered).toEqual([]);

    await deliverDueSchedulerIncidents(new Date(Date.now() + 301_000));
    expect(delivered).toEqual(['retry me']);
    expect(incident('incident:retry')).toMatchObject({ status: 'reported', attempt_count: 1 });
  });
});

function seedAgentGroup(): void {
  createAgentGroup({
    id: 'ag-yente',
    name: 'Yente',
    folder: 'yente',
    agent_provider: null,
    created_at: now(),
  });
}

function seedSession(): Session {
  createMessagingGroup({
    id: 'mg-central',
    channel_type: 'discord',
    platform_id: 'central-channel',
    name: 'Central',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const session: Session = {
    id: 'sess-central',
    agent_group_id: 'ag-yente',
    messaging_group_id: 'mg-central',
    thread_id: 'central-thread',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  createSession(session);
  return session;
}

function seedOwnerDm(): void {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run('discord:owner', 'discord', 'Owner', now());
  getDb()
    .prepare('INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)')
    .run('discord:owner', 'owner', null, null, now());
  createMessagingGroup({
    id: 'mg-owner-dm',
    channel_type: 'discord',
    platform_id: 'owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function incident(dedupeKey: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM scheduler_incidents WHERE dedupe_key = ?').get(dedupeKey) as
    | Record<string, unknown>
    | undefined;
}
