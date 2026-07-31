import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  getSweepableSessions,
  initTestDb,
  runMigrations,
  SWEEP_RECENCY_WINDOW_MS,
} from './index.js';
import { withRuntimeLock } from './runtime-locks.js';
import { createOrReplaceScheduledTask, type CreateScheduledTaskInput } from '../modules/scheduling/ledger.js';
import type { Session } from '../types.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const RECENT = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
const STALE = new Date(NOW.getTime() - SWEEP_RECENCY_WINDOW_MS - 24 * 60 * 60 * 1000).toISOString(); // 31 days ago

function now(): string {
  return NOW.toISOString();
}

function seedSession(id: string, overrides: Partial<Session> = {}): void {
  createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: RECENT,
    created_at: STALE,
    ...overrides,
  });
}

async function seedLiveTask(seriesId: string, overrides: Partial<CreateScheduledTaskInput> = {}): Promise<void> {
  await withRuntimeLock('scheduler-mutator', 120_000, (owner) => {
    createOrReplaceScheduledTask(
      {
        seriesId,
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        threadId: 'thread-1',
        platformId: 'channel',
        channelType: 'discord',
        isGroup: 1,
        processAfter: '2099-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'heartbeat', script: null }),
        sessionId: 'sess-seed',
        sourceMessageId: `msg-${seriesId}`,
        ...overrides,
      },
      owner,
    );
  });
}

/** Wire the (ag-1, mg-1) route agent-shared — the archived arm's per-route mode source. */
function wireAgentShared(): void {
  createMessagingGroupAgent({
    id: 'mga-shared',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: now(),
  });
}

function sweepableIds(): string[] {
  return getSweepableSessions(NOW)
    .map((s) => s.id)
    .sort();
}

describe('getSweepableSessions', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'AG', folder: 'ag', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'channel',
      name: 'MG',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('includes recently-active sessions and excludes stale ones', () => {
    seedSession('sess-recent');
    seedSession('sess-stale', { last_active: STALE, thread_id: 'thread-2' });
    expect(sweepableIds()).toEqual(['sess-recent']);
  });

  it('treats a NULL last_active session as recent via created_at', () => {
    seedSession('sess-new', { last_active: null, created_at: RECENT });
    seedSession('sess-old-never-active', { last_active: null, created_at: STALE, thread_id: 'thread-2' });
    expect(sweepableIds()).toEqual(['sess-new']);
  });

  it('keeps a stale ACTIVE session sweepable while its agent group has a live task', async () => {
    seedSession('sess-stale-with-task', { last_active: STALE });
    await seedLiveTask('task-live');
    expect(sweepableIds()).toEqual(['sess-stale-with-task']);
  });

  it('excludes archived sessions with no live scheduled work', () => {
    seedSession('sess-archived', { status: 'archived' });
    expect(sweepableIds()).toEqual([]);
  });

  it('includes an archived session whose exact route has a live task and no active sibling', async () => {
    seedSession('sess-archived-due', { status: 'archived', last_active: STALE });
    await seedLiveTask('task-orphaned');
    expect(sweepableIds()).toEqual(['sess-archived-due']);
  });

  it('excludes an archived session when an ACTIVE sibling on the same route serves the task', async () => {
    seedSession('sess-active-sibling');
    seedSession('sess-archived-shadowed', { status: 'archived', last_active: STALE });
    await seedLiveTask('task-served');
    expect(sweepableIds()).toEqual(['sess-active-sibling']);
  });

  it('revives only the LATEST archived sibling on an orphaned route', async () => {
    seedSession('sess-arch-old', { status: 'archived', last_active: STALE, created_at: '2026-01-01T00:00:00.000Z' });
    seedSession('sess-arch-new', { status: 'archived', last_active: STALE, created_at: '2026-02-01T00:00:00.000Z' });
    await seedLiveTask('task-orphaned');
    expect(sweepableIds()).toEqual(['sess-arch-new']);
  });

  it('never includes resetting sessions', () => {
    seedSession('sess-resetting', { status: 'resetting' });
    expect(sweepableIds()).toEqual([]);
  });

  it('keeps a stale ACTIVE session with a non-stopped container sweepable', () => {
    // Obligation-servicing loops (wedged containers, SLA kills, orphaned
    // claims after a host restart) never stamp last_active — the
    // container_status clause keeps them under sweep supervision.
    seedSession('sess-wedged', { last_active: STALE, container_status: 'running' });
    expect(sweepableIds()).toEqual(['sess-wedged']);
  });

  it('agent-shared: a cross-route live task makes the LATEST archived group session sweepable', async () => {
    wireAgentShared();
    // Archived agent-shared sessions carry the RAW mg of whichever route
    // created them (or NULL for a2a-created ones) — a due task's stored
    // route may differ. Exact-route IS matching would drop this work.
    seedSession('sess-arch-shared-old', {
      status: 'archived',
      last_active: STALE,
      thread_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedSession('sess-arch-shared-new', {
      status: 'archived',
      last_active: STALE,
      thread_id: null,
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await seedLiveTask('task-null-route', { messagingGroupId: null, threadId: null });
    expect(sweepableIds()).toEqual(['sess-arch-shared-new']);
  });

  it('agent-shared: any active session in the group shadows every archived sibling (no double-active)', async () => {
    wireAgentShared();
    seedSession('sess-shared-active', { thread_id: null }); // active + recent
    seedSession('sess-arch-shared', { status: 'archived', last_active: STALE, thread_id: null });
    // Task route-matches the ARCHIVED sibling's raw columns (post-roll shape):
    // the group-scoped sibling guard must still refuse revival.
    await seedLiveTask('task-post-roll', { threadId: null });
    expect(sweepableIds()).toEqual(['sess-shared-active']);
  });

  it('a RESETTING sibling on the route blocks archived revival without being swept itself', async () => {
    seedSession('sess-resetting-sib', { status: 'resetting', last_active: STALE });
    seedSession('sess-arch-behind-reset', { status: 'archived', last_active: STALE });
    await seedLiveTask('task-mid-reset');
    // Neither: resetting sessions are never swept (pinned semantics), and
    // the archived sibling must not be revived mid-reset (validation A4).
    expect(sweepableIds()).toEqual([]);
  });

  it('MIXED-mode group: exact-route revival on the per-thread route survives an active agent-shared session elsewhere in the group', async () => {
    // ag-1 wired per-thread on mg-1 and agent-shared on mg-2. Mode is
    // determined per SESSION ROUTE: the archived mg-1 session must take the
    // exact-route branch — group-level detection would put it under the
    // group-scoped sibling guard and the active mg-2 session would block
    // its revival (an under-revive, violating never-drop).
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-2',
      name: 'MG2',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-per-thread',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-shared-mg2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now(),
    });

    seedSession('sess-shared-active-mg2', { messaging_group_id: 'mg-2', thread_id: null }); // active + recent
    seedSession('sess-arch-thread', { status: 'archived', last_active: STALE }); // mg-1/thread-1
    await seedLiveTask('task-exact-route'); // exact route: mg-1/thread-1

    // Both: the active session via recency, the archived per-thread session
    // via its OWN route's exact-route branch.
    expect(sweepableIds()).toEqual(['sess-arch-thread', 'sess-shared-active-mg2']);
  });

  it('8a: a NEWER archived NULL-mg (a2a) sibling wins the classified tiebreak for an mg-routed group task', async () => {
    wireAgentShared(); // (ag-1, mg-1) agent-shared
    // Post-roll-via-a2a shape: older archived sibling carries the mg route,
    // newer one carries NULL mg (agent-route.ts:139 provenance). BOTH are
    // agent-shared-classified — the NULL-mg one via resolveProjectionContext's
    // group-wide fallback — and either would deliver the group task once
    // active. The tiebreak must pick the newer NULL-mg sibling, not exile it
    // to the exact-route branch (where 'mg-1' IS NULL fails -> silent drop).
    seedSession('sess-arch-mg', {
      status: 'archived',
      last_active: STALE,
      thread_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedSession('sess-arch-null', {
      status: 'archived',
      last_active: STALE,
      messaging_group_id: null,
      thread_id: null,
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await seedLiveTask('task-mg-routed', { threadId: null });
    expect(sweepableIds()).toEqual(['sess-arch-null']);
  });

  it('8b: an active PER-THREAD session cannot block agent-shared revival in a mixed-mode group', async () => {
    // ag-1: per-thread on mg-1, agent-shared on mg-2. The active per-thread
    // session CANNOT serve the group task (ledger.ts non-agent-shared arm is
    // strict-route), so the classification-scoped guard must ignore it —
    // a group-blind guard would stall delivery for as long as ANY session
    // in the group stays active.
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-2',
      name: 'MG2',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-pt-mg1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-as-mg2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now(),
    });

    seedSession('sess-pt-active', { thread_id: 'thread-x' }); // per-thread route, active + recent
    seedSession('sess-arch-as', {
      status: 'archived',
      last_active: STALE,
      messaging_group_id: 'mg-2',
      thread_id: null,
    });
    await seedLiveTask('task-group', { messagingGroupId: 'mg-2', threadId: null });

    // Both: the per-thread session via recency, the archived agent-shared
    // session (the ONLY session that can deliver the task) via revival.
    expect(sweepableIds()).toEqual(['sess-arch-as', 'sess-pt-active']);
  });

  it('8c: the agent-shared tiebreak ignores NEWER archived per-thread siblings (mode-blind pick would drop the work)', async () => {
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-2',
      name: 'MG2',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-pt-mg1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-as-mg2',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now(),
    });

    // Older archived agent-shared candidate vs NEWER archived per-thread
    // sibling. A mode-blind group-latest pick would select the per-thread
    // one — which then fails its own exact-route task match — reviving
    // nothing. The classified tiebreak must pick the agent-shared session.
    seedSession('sess-arch-as', {
      status: 'archived',
      last_active: STALE,
      messaging_group_id: 'mg-2',
      thread_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedSession('sess-arch-pt', {
      status: 'archived',
      last_active: STALE,
      thread_id: 'thread-y',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await seedLiveTask('task-group', { messagingGroupId: 'mg-2', threadId: null });

    expect(sweepableIds()).toEqual(['sess-arch-as']);
  });
});
