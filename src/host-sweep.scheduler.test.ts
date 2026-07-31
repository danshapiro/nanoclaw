import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './types.js';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('./yente/scheduler-alerts.js');
  vi.doUnmock('./yente/scheduler-reset-repair.js');
  vi.doUnmock('./modules/scheduling/repair.js');
  vi.doUnmock('./db/sessions.js');
  vi.doUnmock('./db/agent-groups.js');
});

describe('host sweep scheduler passes', () => {
  it('runs scheduler passes in isolated order before normal session sweep', async () => {
    const calls: string[] = [];
    vi.doMock('./yente/scheduler-alerts.js', () => ({
      deliverDueSchedulerIncidents: vi.fn(async () => {
        calls.push('alerts');
        throw new Error('alerts failed');
      }),
    }));
    vi.doMock('./yente/scheduler-reset-repair.js', () => ({
      resumeUnfinishedSchedulerSupersessions: vi.fn(async () => {
        calls.push('reset-repair');
        throw new Error('reset repair failed');
      }),
    }));
    vi.doMock('./modules/scheduling/repair.js', () => ({
      repairSchedulerProjections: vi.fn(async () => {
        calls.push('projection-repair');
        throw new Error('projection repair failed');
      }),
    }));
    vi.doMock('./db/sessions.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./db/sessions.js')>();
      return {
        ...actual,
        getSweepableSessions: vi.fn(() => {
          calls.push('session-sweep');
          return [];
        }),
      };
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(calls).toEqual(['alerts', 'reset-repair', 'projection-repair', 'session-sweep']);
  });

  it('yields to urgent recovery work between historical sessions', async () => {
    const calls: string[] = [];
    const session = (id: string, agentGroupId: string): Session => ({
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-25T00:00:00.000Z',
    });

    vi.doMock('./yente/scheduler-alerts.js', () => ({
      deliverDueSchedulerIncidents: vi.fn(async () => undefined),
    }));
    vi.doMock('./yente/scheduler-reset-repair.js', () => ({
      resumeUnfinishedSchedulerSupersessions: vi.fn(async () => undefined),
    }));
    vi.doMock('./modules/scheduling/repair.js', () => ({
      repairSchedulerProjections: vi.fn(async () => undefined),
    }));
    vi.doMock('./db/sessions.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./db/sessions.js')>();
      return {
        ...actual,
        getSweepableSessions: vi.fn(() => [session('sess-old-1', 'ag-old-1'), session('sess-old-2', 'ag-old-2')]),
      };
    });
    vi.doMock('./db/agent-groups.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./db/agent-groups.js')>();
      return {
        ...actual,
        getAgentGroup: vi.fn((id: string) => {
          calls.push(id);
          return undefined;
        }),
      };
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    setImmediate(() => calls.push('urgent-recovery'));
    await runHostSweepPassForTest();

    expect(calls).toEqual(['ag-old-1', 'urgent-recovery', 'ag-old-2']);
  });
});
