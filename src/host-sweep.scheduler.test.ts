import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('./yente/scheduler-alerts.js');
  vi.doUnmock('./yente/scheduler-reset-repair.js');
  vi.doUnmock('./modules/scheduling/repair.js');
  vi.doUnmock('./db/sessions.js');
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
        getActiveSessions: vi.fn(() => {
          calls.push('session-sweep');
          return [];
        }),
      };
    });

    const { runHostSweepPassForTest } = await import('./host-sweep.js');
    await runHostSweepPassForTest();

    expect(calls).toEqual(['alerts', 'reset-repair', 'projection-repair', 'session-sweep']);
  });
});
