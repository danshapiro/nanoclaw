import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, TIMEZONE: 'America/Los_Angeles' };
});

import { handleRecurrence, nextScheduledRun } from './recurrence.js';

describe('nextScheduledRun', () => {
  it('interprets cron expressions in the configured user timezone', () => {
    expect(nextScheduledRun('0 9 * * *', new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01-01T17:00:00.000Z',
    );
  });
});

describe('handleRecurrence compatibility guard', () => {
  it('fails loudly if the removed legacy clone hook is still called', async () => {
    await expect(handleRecurrence()).rejects.toThrow(/syncSessionSchedulerState/);
  });
});
