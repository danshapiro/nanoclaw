export type SchedulerLogSeverity = 'info' | 'warn' | 'error';

export interface SchedulerLogEntry {
  timestamp: string;
  severity: SchedulerLogSeverity;
  event: string;
  [field: string]: unknown;
}

function isSeverity(value: unknown): value is SchedulerLogSeverity {
  return value === 'info' || value === 'warn' || value === 'error';
}

export function logSchedulerEvent(
  severity: SchedulerLogSeverity,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    JSON.stringify({
      ...fields,
      timestamp: new Date().toISOString(),
      severity,
      event,
    }) + '\n',
  );
}

export function parseSchedulerLogLine(line: string): SchedulerLogEntry {
  const normalized = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (normalized.includes('\n')) {
    throw new Error('Scheduler log line must contain exactly one JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (err) {
    throw new Error('Scheduler log line is not valid JSON', { cause: err });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Scheduler log line must be a JSON object');
  }

  const entry = parsed as Record<string, unknown>;
  if (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) {
    throw new Error('Scheduler log line is missing a valid timestamp');
  }
  if (!isSeverity(entry.severity)) {
    throw new Error('Scheduler log line is missing a valid severity');
  }
  if (typeof entry.event !== 'string' || entry.event.length === 0) {
    throw new Error('Scheduler log line is missing a valid event');
  }

  return entry as SchedulerLogEntry;
}
