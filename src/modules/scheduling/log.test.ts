import { afterEach, describe, expect, it, vi } from 'vitest';

import { logSchedulerEvent, parseSchedulerLogLine } from './log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduler JSONL log helper', () => {
  it('emits one valid JSON object with required scheduler reliability fields', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logSchedulerEvent('warn', 'scheduler_reset_phase', {
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      timestamp: 'caller-cannot-override',
      severity: 'info',
      event: 'caller_cannot_override',
    });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toMatch(/^\{.*\}\n$/);
    expect(line).not.toContain('\u001b[');

    const parsed = parseSchedulerLogLine(line);
    expect(parsed).toMatchObject({
      severity: 'warn',
      event: 'scheduler_reset_phase',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
    });
    expect(Date.parse(parsed.timestamp)).not.toBeNaN();
  });

  it('rejects malformed or incomplete scheduler log lines', () => {
    expect(() =>
      parseSchedulerLogLine('\u001b[31m{"timestamp":"2026-06-05T12:00:00.000Z","severity":"info","event":"x"}\n'),
    ).toThrow(/not valid JSON/);
    expect(() => parseSchedulerLogLine('{"severity":"info","event":"x"}\n')).toThrow(/timestamp/);
    expect(() => parseSchedulerLogLine('{"timestamp":"2026-06-05T12:00:00.000Z","event":"x"}\n')).toThrow(/severity/);
    expect(() => parseSchedulerLogLine('{"timestamp":"2026-06-05T12:00:00.000Z","severity":"info"}\n')).toThrow(
      /event/,
    );
  });
});
