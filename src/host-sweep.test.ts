/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS,
  clearProviderToolState,
  decideStuckAction,
  effectiveCeilingMs,
  parseSqliteUtc,
  recoverInterruptedTurn,
  resetStuckProcessingRows,
} from './host-sweep.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date(BASE).toISOString(),
  };
}

function testDbs() {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      status        TEXT DEFAULT 'pending',
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER DEFAULT 1,
      process_after TEXT
    );
  `);

  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY,
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT
    );
  `);

  return { inDb, outDb };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

describe('parseSqliteUtc', () => {
  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp with no zone marker as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves explicit timezone markers', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T07:00:00-0500')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });
});

describe('resetStuckProcessingRows', () => {
  it('clears orphan processing claims when retrying a stale pending message', () => {
    const { inDb, outDb } = testDbs();
    inDb.prepare("INSERT INTO messages_in (id, status, tries) VALUES ('m-1', 'pending', 0)").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run('2026-04-20 11:00:00');

    resetStuckProcessingRows(inDb, outDb, fakeSession(), 'absolute-ceiling', outDb);

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare("SELECT tries, process_after as processAfter FROM messages_in WHERE id = 'm-1'").get() as {
      tries: number;
      processAfter: string | null;
    };
    expect(row.tries).toBe(1);
    expect(row.processAfter).not.toBeNull();

    inDb.close();
    outDb.close();
  });

  it('does not bump retries for a message already backed off into the future', () => {
    const { inDb, outDb } = testDbs();
    const future = new Date(Date.now() + 60_000).toISOString();
    inDb
      .prepare("INSERT INTO messages_in (id, status, tries, process_after) VALUES ('m-2', 'pending', 1, ?)")
      .run(future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run('2026-04-20 11:00:00');

    resetStuckProcessingRows(inDb, outDb, fakeSession(), 'claim-stuck', outDb);

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare("SELECT tries FROM messages_in WHERE id = 'm-2'").get() as { tries: number };
    expect(row.tries).toBe(1);

    inDb.close();
    outDb.close();
  });
});

describe('provider-generic declared-tool timeout widening (Task 2 Step 6)', () => {
  const twoHrMs = 2 * 60 * 60 * 1000;

  it('widens claim tolerance for ANY provider-owned active tool with a positive declared timeout (not just Bash)', () => {
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim — over the 60s default but under the declared timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'opencode-long-tool',
        tool_declared_timeout_ms: 10 * 60 * 1000,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('lets a declared long tool keep no-SSE/heartbeat-only work alive past the default 30-min ceiling, up to its cap', () => {
    // 45 min of silence: over the 30-min default ceiling, but under the declared
    // 2-hour tool cap, so a non-Bash provider tool should NOT be killed yet.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'summarize-dnd',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('caps the declared timeout under the absolute hard-death ceiling and STILL terminates a heartbeat-refreshing-but-stuck turn at OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS', () => {
    // A tool declares a timeout LARGER than the absolute turn ceiling. host-sweep
    // must clamp the effective ceiling to OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS and
    // kill once heartbeat age passes it — a heartbeat-refreshing-but-stuck turn
    // cannot live forever just by declaring an enormous tool timeout.
    const insaneTimeout = OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS + 24 * 60 * 60 * 1000;
    const ageJustPastCeiling = OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS + 60_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - ageJustPastCeiling,
      containerState: {
        current_tool: 'opencode-runaway',
        tool_declared_timeout_ms: insaneTimeout,
        tool_started_at: new Date(BASE - ageJustPastCeiling).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS);
  });

  it('keeps the host heartbeat fresh while wait ticks are flowing (no kill before the effective ceiling)', () => {
    // Heartbeat refreshed 1 minute ago via wait ticks; the effective ceiling is
    // the declared 2h tool window — nowhere near the heartbeat age.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 60_000,
      containerState: {
        current_tool: 'opencode-long-tool',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 60_000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });
});

describe('effectiveCeilingMs', () => {
  it('defaults to the 30-min ABSOLUTE_CEILING_MS with no active long tool', () => {
    expect(effectiveCeilingMs(null)).toBe(ABSOLUTE_CEILING_MS);
    expect(effectiveCeilingMs({ current_tool: null, tool_declared_timeout_ms: null, tool_started_at: null })).toBe(
      ABSOLUTE_CEILING_MS,
    );
  });

  it('raises the ceiling to a declared tool timeout above 30 min, regardless of tool name', () => {
    const tenMinMs = 10 * 60 * 1000;
    const fortyFiveMinMs = 45 * 60 * 1000;
    // 10 min < 30 min default → stays at the default.
    expect(
      effectiveCeilingMs({ current_tool: 'opencode-x', tool_declared_timeout_ms: tenMinMs, tool_started_at: null }),
    ).toBe(ABSOLUTE_CEILING_MS);
    // 45 min > 30 min default → raises.
    expect(
      effectiveCeilingMs({
        current_tool: 'opencode-x',
        tool_declared_timeout_ms: fortyFiveMinMs,
        tool_started_at: null,
      }),
    ).toBe(fortyFiveMinMs);
  });

  it('never raises the ceiling past OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS', () => {
    const insane = OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS + 60 * 60 * 1000;
    expect(
      effectiveCeilingMs({ current_tool: 'opencode-x', tool_declared_timeout_ms: insane, tool_started_at: null }),
    ).toBe(OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS);
  });
});

describe('clearProviderToolState', () => {
  it('clears stale OpenCode tool rows from container_state', () => {
    const { inDb, outDb } = testDbs();
    outDb
      .prepare(
        "INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at) VALUES (1, 'opencode-long-tool', 7200000, '2026-04-20 11:00:00')",
      )
      .run();

    clearProviderToolState(outDb);

    const row = outDb
      .prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state WHERE id = 1')
      .get() as { current_tool: string | null; tool_declared_timeout_ms: number | null } | undefined;
    // Either the row is gone or its tool fields are nulled — both are "no active tool".
    if (row) {
      expect(row.current_tool).toBeNull();
      expect(row.tool_declared_timeout_ms).toBeNull();
    }
    inDb.close();
    outDb.close();
  });
});

describe('recoverInterruptedTurn (kill/reset ordering)', () => {
  function processingDbs() {
    const { inDb, outDb } = testDbs();
    inDb.prepare("INSERT INTO messages_in (id, status, tries) VALUES ('m-1', 'pending', 0)").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run('2026-04-20 11:00:00');
    outDb
      .prepare(
        "INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at) VALUES (1, 'opencode-long-tool', 7200000, '2026-04-20 11:00:00')",
      )
      .run();
    return { inDb, outDb };
  }

  it('imports side effects and writes recovery BEFORE resetting rows or waking a replacement', async () => {
    const { inDb, outDb } = processingDbs();
    const order: string[] = [];

    await recoverInterruptedTurn({
      inDb,
      outDb,
      session: fakeSession(),
      reason: 'absolute-ceiling',
      writableOutDb: outDb,
      verifyContainerStopped: async () => {
        order.push('verify-stopped');
        return true;
      },
      importSideEffects: ({ containerStopped }) => {
        // Must not import until the container is verified stopped.
        expect(containerStopped).toBe(true);
        order.push('import-side-effects');
      },
      writeRecovery: () => {
        order.push('write-recovery');
      },
      wakeContainer: async () => {
        order.push('wake');
      },
    });

    // Ordering invariants: verify → import → recovery → (reset implied) → wake.
    expect(order).toEqual(['verify-stopped', 'import-side-effects', 'write-recovery', 'wake']);
    // Rows were reset and orphan claims cleared after recovery was written.
    expect(getProcessingClaims(outDb)).toEqual([]);

    inDb.close();
    outDb.close();
  });

  it('refuses to import/recover (and never wakes) while the container may still be running', async () => {
    const { inDb, outDb } = processingDbs();
    const order: string[] = [];

    await expect(
      recoverInterruptedTurn({
        inDb,
        outDb,
        session: fakeSession(),
        reason: 'claim-stuck',
        writableOutDb: outDb,
        verifyContainerStopped: async () => {
          order.push('verify-stopped');
          return false; // container is NOT confirmed stopped
        },
        importSideEffects: () => {
          order.push('import-side-effects');
        },
        writeRecovery: () => {
          order.push('write-recovery');
        },
        wakeContainer: async () => {
          order.push('wake');
        },
      }),
    ).rejects.toThrow(/container.*stop/i);

    // We probed stoppage but did nothing destructive/outbound-writable after.
    expect(order).toEqual(['verify-stopped']);

    inDb.close();
    outDb.close();
  });

  it('clears stale provider-owned tool state during recovery', async () => {
    const { inDb, outDb } = processingDbs();

    await recoverInterruptedTurn({
      inDb,
      outDb,
      session: fakeSession(),
      reason: 'absolute-ceiling',
      writableOutDb: outDb,
      verifyContainerStopped: async () => true,
      importSideEffects: () => {},
      writeRecovery: () => {},
      wakeContainer: async () => {},
    });

    const row = outDb.prepare('SELECT current_tool FROM container_state WHERE id = 1').get() as
      | { current_tool: string | null }
      | undefined;
    if (row) expect(row.current_tool).toBeNull();

    inDb.close();
    outDb.close();
  });
});

describe('host wake/sync preserves recovery-owned acks', () => {
  it('ignores processing_ack.status=recovery rows as due work and never resets them', () => {
    const { inDb, outDb } = testDbs();
    // One recovery-owned row, one orphan processing row.
    inDb.prepare("INSERT INTO messages_in (id, status, tries, trigger) VALUES ('m-rec', 'pending', 0, 1)").run();
    inDb.prepare("INSERT INTO messages_in (id, status, tries, trigger) VALUES ('m-proc', 'pending', 0, 1)").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-rec', 'recovery', ?)").run('2026-04-20 11:00:00');
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run('2026-04-20 11:00:00');

    // resetStuckProcessingRows must only touch the orphan 'processing' row.
    resetStuckProcessingRows(inDb, outDb, fakeSession(), 'container not running', outDb);

    // Recovery-owned ack survives; only the orphan processing claim is cleared.
    const remaining = outDb
      .prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id')
      .all() as Array<{ message_id: string; status: string }>;
    expect(remaining).toEqual([{ message_id: 'm-rec', status: 'recovery' }]);

    inDb.close();
    outDb.close();
  });
});
