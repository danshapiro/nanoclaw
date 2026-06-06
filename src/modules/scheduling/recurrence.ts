import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';

/** Compute the next recurring task run in the user's configured timezone. */
export function nextScheduledRun(recurrence: string, currentDate: Date = new Date()): string {
  const nextRun = CronExpressionParser.parse(recurrence, { currentDate, tz: TIMEZONE }).next().toISOString();
  if (!nextRun) throw new Error(`Unable to compute next run for recurrence "${recurrence}"`);
  return nextRun;
}

export async function handleRecurrence(_inDb?: unknown, _session?: unknown): Promise<void> {
  throw new Error('handleRecurrence is replaced by syncSessionSchedulerState(inDb, outDb, session)');
}
