import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  initTestDb,
  closeDb,
  getDb,
  runMigrations,
  createAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  getAllAgentGroups,
  updateAgentGroup,
  deleteAgentGroup,
  createMessagingGroup,
  getMessagingGroup,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
  deleteMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupAgent,
  updateMessagingGroupAgent,
  deleteMessagingGroupAgent,
  createSession,
  getSession,
  findSession,
  getSessionsByAgentGroup,
  getActiveSessions,
  getRunningSessions,
  updateSession,
  deleteSession,
  createPendingQuestion,
  getPendingQuestion,
  deletePendingQuestion,
} from './index.js';

function now() {
  return new Date().toISOString();
}

function tableColumns(table: string): Set<string> {
  return new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function tableColumn(table: string, column: string): { notnull: 0 | 1; dflt_value: string | null } | undefined {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: 0 | 1;
    dflt_value: string | null;
  }>).find((row) => row.name === column);
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

// ── Migrations ──

describe('migrations', () => {
  it('should be idempotent', () => {
    const db = initTestDb();
    runMigrations(db);
    // Running again should not throw
    runMigrations(db);
  });
});

// ── Scheduler Central Schema ──

describe('scheduler central schema', () => {
  function insertScheduledTask(
    overrides: Partial<{
      agentGroupId: string;
      seriesId: string;
      status: string;
      isGroup: 0 | 1 | null;
    }> = {},
  ): void {
    const values = {
      agentGroupId: 'missing-agent-group',
      seriesId: 'series-1',
      status: 'pending',
      isGroup: null,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    };
    getDb()
      .prepare(
        `INSERT INTO scheduled_tasks (
          agent_group_id,
          series_id,
          status,
          content,
          is_group,
          created_at,
          updated_at
        ) VALUES (
          @agentGroupId,
          @seriesId,
          @status,
          '{}',
          @isGroup,
          @createdAt,
          @updatedAt
        )`,
      )
      .run(values);
  }

  it('creates all scheduler ledger and runtime lock tables', () => {
    const tables = new Set(
      (
        getDb()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    for (const table of [
      'scheduled_tasks',
      'scheduled_task_events',
      'scheduler_session_supersessions',
      'scheduler_drained_actions',
      'scheduler_incidents',
      'runtime_locks',
    ]) {
      expect(tables.has(table), table).toBe(true);
    }
  });

  it('creates the planned scheduler task columns', () => {
    const columns = tableColumns('scheduled_tasks');
    for (const column of [
      'series_id',
      'agent_group_id',
      'messaging_group_id',
      'thread_id',
      'platform_id',
      'channel_type',
      'is_group',
      'status',
      'process_after',
      'recurrence',
      'content',
      'generation',
      'projected_session_id',
      'projected_message_id',
      'created_by_session_id',
      'updated_by_session_id',
      'created_at',
      'updated_at',
      'completed_at',
      'last_error',
    ]) {
      expect(columns.has(column), column).toBe(true);
    }
    expect(columns.has('content_json')).toBe(false);
    expect(tableColumn('scheduled_tasks', 'generation')).toMatchObject({ dflt_value: '1' });
  });

  it('creates planned reset and incident fields', () => {
    const supersessionColumns = tableColumns('scheduler_session_supersessions');
    for (const column of ['command', 'finished_at', 'error_json']) {
      expect(supersessionColumns.has(column), column).toBe(true);
    }
    expect(tableColumn('scheduler_session_supersessions', 'session_mode')).toMatchObject({ notnull: 1 });

    expect(tableColumn('scheduler_incidents', 'next_attempt_at')).toMatchObject({ notnull: 0 });
    expect(tableColumn('scheduler_incidents', 'details_json')).toMatchObject({ notnull: 1 });
  });

  it('creates planned scheduler indexes', () => {
    const indexes = new Set(
      (
        getDb()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    expect(indexes.has('idx_scheduler_supersessions_new_session')).toBe(true);
    expect(indexes.has('idx_scheduler_incidents_pending')).toBe(true);
  });

  it('rejects unknown scheduled task statuses', () => {
    expect(() => insertScheduledTask({ status: 'unknown' })).toThrow();
  });

  it('does not require a legacy agent_group_id row for scheduled tasks', () => {
    expect(() => insertScheduledTask({ agentGroupId: 'missing-legacy-agent-group' })).not.toThrow();
  });

  it('scopes scheduled task identity by agent group', () => {
    insertScheduledTask({ agentGroupId: 'ag-1', seriesId: 'shared-series' });
    insertScheduledTask({ agentGroupId: 'ag-2', seriesId: 'shared-series' });

    const rows = getDb()
      .prepare('SELECT agent_group_id, series_id FROM scheduled_tasks WHERE series_id = ? ORDER BY agent_group_id')
      .all('shared-series') as Array<{ agent_group_id: string; series_id: string }>;

    expect(rows).toEqual([
      { agent_group_id: 'ag-1', series_id: 'shared-series' },
      { agent_group_id: 'ag-2', series_id: 'shared-series' },
    ]);
  });
});

// ── Agent Groups ──

describe('agent groups', () => {
  const ag = () => ({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });

  it('should create and retrieve', () => {
    createAgentGroup(ag());
    const result = getAgentGroup('ag-1');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Agent');
    expect(result!.folder).toBe('test-agent');
  });

  it('should find by folder', () => {
    createAgentGroup(ag());
    const result = getAgentGroupByFolder('test-agent');
    expect(result).toBeDefined();
    expect(result!.id).toBe('ag-1');
  });

  it('should list all', () => {
    createAgentGroup(ag());
    createAgentGroup({ ...ag(), id: 'ag-2', name: 'Another', folder: 'another' });
    expect(getAllAgentGroups()).toHaveLength(2);
  });

  it('should update', () => {
    createAgentGroup(ag());
    updateAgentGroup('ag-1', { name: 'Updated' });
    expect(getAgentGroup('ag-1')!.name).toBe('Updated');
  });

  it('should delete', () => {
    createAgentGroup(ag());
    deleteAgentGroup('ag-1');
    expect(getAgentGroup('ag-1')).toBeUndefined();
  });

  it('should enforce unique folder', () => {
    createAgentGroup(ag());
    expect(() => createAgentGroup({ ...ag(), id: 'ag-dup' })).toThrow();
  });
});

// ── Messaging Groups ──

describe('messaging groups', () => {
  const mg = () => ({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'strict' as const,
    created_at: now(),
  });

  it('should create and retrieve', () => {
    createMessagingGroup(mg());
    const result = getMessagingGroup('mg-1');
    expect(result).toBeDefined();
    expect(result!.channel_type).toBe('discord');
  });

  it('should find by platform', () => {
    createMessagingGroup(mg());
    const result = getMessagingGroupByPlatform('discord', 'chan-123');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mg-1');
  });

  it('should enforce unique channel_type + platform_id', () => {
    createMessagingGroup(mg());
    expect(() => createMessagingGroup({ ...mg(), id: 'mg-dup' })).toThrow();
  });

  it('should update', () => {
    createMessagingGroup(mg());
    updateMessagingGroup('mg-1', { name: 'Updated' });
    expect(getMessagingGroup('mg-1')!.name).toBe('Updated');
  });

  it('should delete', () => {
    createMessagingGroup(mg());
    deleteMessagingGroup('mg-1');
    expect(getMessagingGroup('mg-1')).toBeUndefined();
  });
});

// ── Messaging Group Agents ──

describe('messaging group agents', () => {
  beforeEach(() => {
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
      platform_id: 'chan-1',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  const mga = () => ({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern' as const,
    engage_pattern: '.',
    sender_scope: 'all' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'shared' as const,
    priority: 0,
    created_at: now(),
  });

  it('should create and list by messaging group', () => {
    createMessagingGroupAgent(mga());
    const results = getMessagingGroupAgents('mg-1');
    expect(results).toHaveLength(1);
    expect(results[0].agent_group_id).toBe('ag-1');
  });

  it('should order by priority descending', () => {
    createMessagingGroupAgent(mga());
    createAgentGroup({
      id: 'ag-2',
      name: 'Agent2',
      folder: 'agent2',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({ ...mga(), id: 'mga-2', agent_group_id: 'ag-2', priority: 10 });
    const results = getMessagingGroupAgents('mg-1');
    expect(results[0].agent_group_id).toBe('ag-2');
    expect(results[1].agent_group_id).toBe('ag-1');
  });

  it('should enforce unique messaging_group + agent_group', () => {
    createMessagingGroupAgent(mga());
    expect(() => createMessagingGroupAgent({ ...mga(), id: 'mga-dup' })).toThrow();
  });

  it('should update', () => {
    createMessagingGroupAgent(mga());
    updateMessagingGroupAgent('mga-1', { priority: 5 });
    expect(getMessagingGroupAgent('mga-1')!.priority).toBe(5);
  });

  it('should delete', () => {
    createMessagingGroupAgent(mga());
    deleteMessagingGroupAgent('mga-1');
    expect(getMessagingGroupAgents('mg-1')).toHaveLength(0);
  });

  it('should enforce foreign key on agent_group_id', () => {
    expect(() => createMessagingGroupAgent({ ...mga(), agent_group_id: 'nonexistent' })).toThrow();
  });

  it('auto-creates an agent_destinations row for the wiring', async () => {
    const { getDestinationByTarget, getDestinations } =
      await import('../modules/agent-to-agent/db/agent-destinations.js');
    createMessagingGroupAgent(mga());

    const dest = getDestinationByTarget('ag-1', 'channel', 'mg-1');
    expect(dest).toBeDefined();
    expect(dest!.local_name).toBe('gen'); // normalized from mg.name='Gen'
    expect(getDestinations('ag-1')).toHaveLength(1);
  });

  it('does not duplicate destination row on re-wiring', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    createMessagingGroupAgent(mga());
    // Re-create the same wiring throws (PK unique), but even if we got the
    // row in some other way (e.g. via createDestination directly followed
    // by createMessagingGroupAgent), we should not end up with two rows.
    deleteMessagingGroupAgent('mga-1');
    createMessagingGroupAgent(mga());
    expect(getDestinations('ag-1')).toHaveLength(1);
  });

  it('breaks local_name collisions within an agent group', async () => {
    const { getDestinations } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    // Two messaging groups with the same `name` wired to the same agent
    // should get distinct local_names (gen, gen-2).
    createMessagingGroupAgent(mga());
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'chan-2',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({ ...mga(), id: 'mga-2', messaging_group_id: 'mg-2' });

    const dests = getDestinations('ag-1')
      .map((d) => d.local_name)
      .sort();
    expect(dests).toEqual(['gen', 'gen-2']);
  });
});

// ── Sessions ──

describe('sessions', () => {
  beforeEach(() => {
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
      platform_id: 'chan-1',
      name: 'Gen',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  const sess = () => ({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: null,
    created_at: now(),
  });

  it('should create and retrieve', () => {
    createSession(sess());
    const result = getSession('sess-1');
    expect(result).toBeDefined();
    expect(result!.agent_group_id).toBe('ag-1');
  });

  it('should find by messaging group (shared, no thread)', () => {
    createSession(sess());
    const result = findSession('mg-1', null);
    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-1');
  });

  it('should find by messaging group + thread', () => {
    createSession({ ...sess(), thread_id: 'thread-1' });
    expect(findSession('mg-1', 'thread-1')).toBeDefined();
    expect(findSession('mg-1', 'thread-2')).toBeUndefined();
    expect(findSession('mg-1', null)).toBeUndefined();
  });

  it('should only find active sessions', () => {
    createSession({ ...sess(), status: 'closed' });
    expect(findSession('mg-1', null)).toBeUndefined();
  });

  it('should list by agent group', () => {
    createSession(sess());
    createSession({ ...sess(), id: 'sess-2', thread_id: 'thread-1' });
    expect(getSessionsByAgentGroup('ag-1')).toHaveLength(2);
  });

  it('should list active sessions', () => {
    createSession(sess());
    createSession({ ...sess(), id: 'sess-closed', status: 'closed', thread_id: 'thread-x' });
    expect(getActiveSessions()).toHaveLength(1);
  });

  it('should list running sessions', () => {
    createSession({ ...sess(), container_status: 'running' });
    createSession({ ...sess(), id: 'sess-idle', container_status: 'idle', thread_id: 'thread-1' });
    createSession({ ...sess(), id: 'sess-stopped', container_status: 'stopped', thread_id: 'thread-2' });
    expect(getRunningSessions()).toHaveLength(2);
  });

  it('should update', () => {
    createSession(sess());
    updateSession('sess-1', { container_status: 'running', last_active: now() });
    const result = getSession('sess-1')!;
    expect(result.container_status).toBe('running');
    expect(result.last_active).not.toBeNull();
  });

  it('should delete', () => {
    createSession(sess());
    deleteSession('sess-1');
    expect(getSession('sess-1')).toBeUndefined();
  });
});

// ── Pending Questions ──

describe('pending questions', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  });

  it('should create and retrieve', () => {
    createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: 'chan-1',
      channel_type: 'discord',
      thread_id: null,
      title: 'Test',
      options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    const result = getPendingQuestion('q-1');
    expect(result).toBeDefined();
    expect(result!.session_id).toBe('sess-1');
    expect(result!.title).toBe('Test');
    expect(result!.options[0].value).toBe('yes');
  });

  it('should delete', () => {
    createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Test',
      options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    deletePendingQuestion('q-1');
    expect(getPendingQuestion('q-1')).toBeUndefined();
  });
});
