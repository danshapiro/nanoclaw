/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import fs from 'fs';
import { generateKeyPairSync, sign as edSign } from 'crypto';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countDueMessagesExcludingRecovery, getProcessingClaims } from './db/session-db.js';
import { OUTBOUND_SCHEMA } from './db/schema.js';
import { canonicalSideEffectPayload } from './db/side-effects-verify.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  IDLE_REAP_MS,
  IDLE_RECYCLE_GRACE_MS,
  OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS,
  clearProviderToolState,
  decideSkillRecycle,
  decideStuckAction,
  discoverGwsCrashWindowDraftsScoped,
  effectiveCeilingMs,
  gwsDiscoveryScope,
  parseSqliteUtc,
  recoverGwsClaimPartitions,
  recoverInterruptedTurn,
  resetStuckProcessingRows,
  writeHostInterruptedRecovery,
} from './host-sweep.js';
import { readSpawnSkillGeneration, skillGenerationPath, writeSpawnSkillGeneration } from './session-manager.js';
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

  it('does not kill on a stale pre-restart claim when the container just started (age clamped by container lifetime)', () => {
    // Live incident: service restart left a ~10 min old 'processing' claim in
    // the session DB; a fresh wake-container spawned and was kill-claimed 6ms
    // later (claimAgeMs=613751 vs 60s tolerance) before it could heartbeat.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0, // fresh container, never ticked
      containerState: null,
      claims: [claim('msg-1', 10 * 60 * 1000)], // claimed 10 min ago (pre-restart)
      containerStartedAtMs: BASE - 5_000, // container started 5s ago
    });
    expect(res.action).toBe('ok');
  });

  it('still kill-claims when the container itself has outlived the tolerance since ITS OWN start', () => {
    const containerAgeMs = CLAIM_STUCK_MS + 30_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0, // still never heartbeat
      containerState: null,
      claims: [claim('msg-1', 10 * 60 * 1000)],
      containerStartedAtMs: BASE - containerAgeMs, // started well past tolerance ago
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    // Quiet-age is measured from the container's own start, not the stale claim.
    expect(res.claimAgeMs).toBe(containerAgeMs);
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill a fresh claim regardless of container start time', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', 5_000)], // claimed 5s ago
      containerStartedAtMs: BASE - 10 * 60 * 1000, // long-lived container
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

  it('returns kill-idle when no claims and heartbeat quiet past IDLE_REAP_MS', () => {
    const idleAgeMs = IDLE_REAP_MS + 60_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - idleAgeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-idle');
    if (res.action !== 'kill-idle') return;
    expect(res.idleAgeMs).toBe(idleAgeMs);
    expect(res.idleReapMs).toBe(IDLE_REAP_MS);
  });

  it('does not idle-reap within the IDLE_REAP_MS threshold', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - IDLE_REAP_MS + 60_000, // quiet, but under threshold
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('never idle-reaps a claim-holding container -- existing rules apply instead', () => {
    // Heartbeat quiet past the idle threshold, but a claim is present:
    // a fresh claim means an active turn -> ok, not kill-idle.
    const staleHeartbeat = BASE - IDLE_REAP_MS - 60_000;
    const fresh = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: staleHeartbeat,
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(fresh.action).toBe('ok');

    // A stale claim on the same container falls through to kill-claim,
    // never kill-idle.
    const stale = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: staleHeartbeat,
      containerState: null,
      claims: [claim('msg-1', CLAIM_STUCK_MS + 10_000)],
    });
    expect(stale.action).toBe('kill-claim');
  });

  it('does not idle-reap when no heartbeat file exists (fresh container)', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('respects the NANOCLAW_IDLE_REAP_MS env override', async () => {
    vi.stubEnv('NANOCLAW_IDLE_REAP_MS', '120000');
    vi.resetModules();
    try {
      const mod = await import('./host-sweep.js');
      expect(mod.IDLE_REAP_MS).toBe(120_000);
      // 2.5 min idle: past the 2-min override, but well under the 10-min
      // default -- proves the override is what fired.
      const res = mod.decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 150_000,
        containerState: null,
        claims: [],
      });
      expect(res.action).toBe('kill-idle');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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

    // "as due work" half: the outbound-aware due count that sweepSession now uses
    // must also exclude the recovery-owned row, so it does not appear as due work
    // that would trigger wakeContainer.
    expect(countDueMessagesExcludingRecovery(inDb, outDb)).toBe(0);

    inDb.close();
    outDb.close();
  });
});

describe('host sweep wake decision excludes recovery-owned rows', () => {
  it('does not count a recovery-owned pending row as due (no wake)', () => {
    const { inDb, outDb } = testDbs();
    // Only row is pending in inbound but recovery-owned in outbound.
    inDb.prepare("INSERT INTO messages_in (id, status, tries, trigger) VALUES ('m-rec', 'pending', 0, 1)").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-rec', 'recovery', ?)").run('2026-04-20 11:00:00');

    // sweepSession uses countDueMessagesExcludingRecovery(inDb, outDb) when outDb
    // is available. Verify: due count is 0 → wakeContainer must not be triggered.
    const dueCount = countDueMessagesExcludingRecovery(inDb, outDb);
    expect(dueCount).toBe(0);

    inDb.close();
    outDb.close();
  });

  it('counts a genuinely pending row (no recovery ack) as due (wake fires)', () => {
    const { inDb, outDb } = testDbs();
    // Pending row with no processing_ack at all — ordinary unprocessed message.
    inDb.prepare("INSERT INTO messages_in (id, status, tries, trigger) VALUES ('m-new', 'pending', 0, 1)").run();

    const dueCount = countDueMessagesExcludingRecovery(inDb, outDb);
    expect(dueCount).toBe(1);

    inDb.close();
    outDb.close();
  });

  it('counts genuinely pending but not recovery-owned rows when both kinds exist', () => {
    const { inDb, outDb } = testDbs();
    // m-rec is recovery-owned; m-new is a normal pending message.
    inDb.prepare("INSERT INTO messages_in (id, status, tries, trigger) VALUES ('m-rec', 'pending', 0, 1)").run();
    inDb.prepare("INSERT INTO messages_in (id, status, tries, trigger) VALUES ('m-new', 'pending', 0, 1)").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-rec', 'recovery', ?)").run('2026-04-20 11:00:00');

    // Only m-new should be counted as due.
    const dueCount = countDueMessagesExcludingRecovery(inDb, outDb);
    expect(dueCount).toBe(1);

    inDb.close();
    outDb.close();
  });
});

/**
 * PRODUCTION wiring for the host-only GWS crash-window discovery. The audit
 * store is a SHARED GLOBAL file across every session/route, so the recovery
 * path MUST scope the import to the interrupted turn (route + time window, plus
 * inputId when known) — otherwise one session's recovery would import every
 * other session's/route's orphan drafts into this session's ledger.
 *
 * These tests exercise `discoverGwsCrashWindowDraftsScoped` (the exact scope
 * derivation + discovery call that `recoverAfterKill` runs) against a real
 * session dir, real host-owned inbound correlation, real processing claims, and a global
 * audit store holding both a MATCHING and a NON-MATCHING entry.
 */
describe('discoverGwsCrashWindowDraftsScoped (production crash-window scoping)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-scope-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setupSession(): { sessionPath: string; inPath: string; outPath: string } {
    const sessionPath = path.join(tmpRoot, 'sess');
    fs.mkdirSync(sessionPath, { recursive: true });
    const outPath = path.join(sessionPath, 'outbound.db');
    const inPath = path.join(sessionPath, 'inbound.db');
    const inbound = new Database(inPath);
    inbound.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, status TEXT DEFAULT 'pending', tries INTEGER DEFAULT 0,
      process_after TEXT, timestamp TEXT, content TEXT,
      host_input_id TEXT, host_route_key TEXT, host_received_at TEXT,
      host_accepted_input_id TEXT, host_accepted_route_key TEXT,
      host_accepted_at TEXT, host_acceptance_ended_at TEXT
    )`);
    inbound.close();
    const out = new Database(outPath);
    out.exec(OUTBOUND_SCHEMA);
    out.close();
    return { sessionPath, inPath, outPath };
  }

  function writeAuditStore(p: string, entries: object[]): void {
    fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  function signedAuditEntry(
    key: ReturnType<typeof generateKeyPairSync>,
    values: { auditId: string; inputId: string; routeKey: string; occurredAt: string },
  ) {
    const payloadValue = {
      schema_version: 2,
      audit_id: values.auditId,
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: values.inputId,
      route_key: values.routeKey,
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: values.occurredAt,
      result_digest: '0123456789abcdef',
    };
    const payload = canonicalSideEffectPayload(payloadValue);
    return {
      ...payloadValue,
      payload,
      signature: edSign(null, Buffer.from(payload), key.privateKey).toString('base64'),
    };
  }

  it('imports ONLY this turn’s route/window draft, excluding other-session/route entries from the shared global store', () => {
    const { sessionPath, inPath, outPath } = setupSession();
    const auditStore = path.join(tmpRoot, 'gws-audit.jsonl');

    const thisRoute = 'opencode|discord|chan-1|dm:mg-1';
    const otherRoute = 'opencode|discord|chan-9|dm:mg-9';
    const turnStart = '2026-05-29T12:00:00.000Z';
    const key = generateKeyPairSync('ed25519');
    const gwsPublicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const inbound = new Database(inPath);
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, timestamp, content, host_input_id, host_route_key, host_received_at,
            host_accepted_input_id, host_accepted_route_key, host_accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'm-this',
        turnStart,
        '{"text":"create the draft"}',
        'receipt-this',
        thisRoute,
        turnStart,
        'in-this',
        thisRoute,
        turnStart,
      );
    inbound.close();
    // Agent-writable legacy correlation is malicious and must be ignored.
    fs.writeFileSync(
      path.join(sessionPath, '.active-input.json'),
      JSON.stringify({ inputId: 'in-other', routeKey: otherRoute, updatedAt: turnStart }),
    );

    // The interrupted turn's processing claim sets the turn-start (notBefore).
    const out = new Database(outPath);
    out
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('m-this', 'processing', '2026-05-29 12:00:00');
    out.close();

    writeAuditStore(auditStore, [
      // MATCHING: this route, this input, after turn-start.
      signedAuditEntry(key, {
        auditId: 'draft-this',
        inputId: 'in-this',
        routeKey: thisRoute,
        occurredAt: '2026-05-29T12:00:05.000Z',
      }),
      // NON-MATCHING (other session/route): must be excluded.
      signedAuditEntry(key, {
        auditId: 'draft-other-route',
        inputId: 'in-other',
        routeKey: otherRoute,
        occurredAt: '2026-05-29T12:00:06.000Z',
      }),
      // NON-MATCHING (this route but BEFORE turn-start — an older, already-
      // recovered turn): excluded by notBefore.
      signedAuditEntry(key, {
        auditId: 'draft-stale',
        inputId: 'in-old',
        routeKey: thisRoute,
        occurredAt: '2026-05-29T11:00:00.000Z',
      }),
      // NON-MATCHING cross-turn input on the SAME route and inside the time
      // window: exact accepted input binding must still exclude it.
      signedAuditEntry(key, {
        auditId: 'draft-other-input-same-route',
        inputId: 'in-other-turn',
        routeKey: thisRoute,
        occurredAt: '2026-05-29T12:00:06.000Z',
      }),
      // Matching input/route but AFTER confirmed stop: excluded by notAfter.
      signedAuditEntry(key, {
        auditId: 'draft-after-stop',
        inputId: 'in-this',
        routeKey: thisRoute,
        occurredAt: '2026-05-29T12:00:11.000Z',
      }),
    ]);

    const writableOutDb = new Database(outPath);
    const readableInDb = new Database(inPath);
    try {
      // Agent-writable SQL cannot squat on the root audit id. A conflicting
      // unauthenticated row must be replaced by the verified root evidence.
      writableOutDb
        .prepare(
          `INSERT INTO side_effect_ledger
             (id, source, kind, operation, payload_schema_version, evidence_json, validation_json, imported_at)
           VALUES (?, 'tool', 'tool_completed', 'forged', 1, '{}', '{"authoritative":true}', ?)`,
        )
        .run('draft-this', turnStart);
      const r = discoverGwsCrashWindowDraftsScoped({
        sessionDir: sessionPath,
        inDb: readableInDb,
        outDb: writableOutDb,
        containerStopped: true,
        auditStorePath: auditStore,
        gwsPublicKey,
        stoppedAt: '2026-05-29T12:00:10.000Z',
      });
      expect(r.discovered).toBe(1);
    } finally {
      readableInDb.close();
      writableOutDb.close();
    }

    const verify = new Database(outPath, { readonly: true });
    const rows = verify
      .prepare(
        "SELECT id, source, validation_json FROM side_effect_ledger WHERE kind = 'gmail_draft_created' ORDER BY id",
      )
      .all() as Array<{ id: string; source: string; validation_json: string }>;
    verify.close();
    // Only the matching draft was imported; the other route's and the stale
    // pre-turn drafts were excluded.
    expect(rows.map((x) => x.id)).toEqual(['draft-this']);
    expect(rows[0].source).toBe('gws');
    expect(JSON.parse(rows[0].validation_json).authoritative).toBe(true);
  });

  it('fails closed when the processing claim lacks host-owned route/time correlation', () => {
    const { sessionPath, inPath, outPath } = setupSession();
    const auditStore = path.join(tmpRoot, 'gws-audit.jsonl');

    const thisRoute = 'opencode|discord|chan-1|dm:mg-1';
    const otherRoute = 'opencode|discord|chan-9|dm:mg-9';
    const key = generateKeyPairSync('ed25519');
    const gwsPublicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();

    // An agent-controlled correlation file cannot fill missing host columns.
    fs.writeFileSync(
      path.join(sessionPath, '.active-input.json'),
      JSON.stringify({ inputId: 'in-a', routeKey: thisRoute, updatedAt: '2026-05-29T12:00:00.000Z' }),
    );
    const inbound = new Database(inPath);
    inbound
      .prepare('INSERT INTO messages_in (id, timestamp, content) VALUES (?, ?, ?)')
      .run('m-this', '2026-05-29T12:00:00.000Z', '{"text":"create draft"}');
    inbound.close();

    const out = new Database(outPath);
    out
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('m-this', 'processing', '2026-05-29 12:00:00');
    out.close();

    writeAuditStore(auditStore, [
      signedAuditEntry(key, {
        auditId: 'draft-this',
        inputId: 'in-a',
        routeKey: thisRoute,
        occurredAt: '2026-05-29T12:00:05.000Z',
      }),
      signedAuditEntry(key, {
        auditId: 'draft-other-route',
        inputId: 'in-b',
        routeKey: otherRoute,
        occurredAt: '2026-05-29T12:00:06.000Z',
      }),
    ]);

    const writableOutDb = new Database(outPath);
    const readableInDb = new Database(inPath);
    try {
      const r = discoverGwsCrashWindowDraftsScoped({
        sessionDir: sessionPath,
        inDb: readableInDb,
        outDb: writableOutDb,
        containerStopped: true,
        auditStorePath: auditStore,
        gwsPublicKey,
      });
      expect(r.discovered).toBe(0);
    } finally {
      readableInDb.close();
      writableOutDb.close();
    }

    const verify = new Database(outPath, { readonly: true });
    const rows = verify.prepare("SELECT id FROM side_effect_ledger WHERE kind = 'gmail_draft_created'").all() as Array<{
      id: string;
    }>;
    verify.close();
    expect(rows.map((x) => x.id)).toEqual([]);
  });

  it('returns no recovery scope for mixed accepted input ids on one route', () => {
    const { sessionPath, inPath, outPath } = setupSession();
    const routeKey = 'opencode|discord|chan-1|dm:mg-1';
    const key = generateKeyPairSync('ed25519');
    const gwsPublicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const auditStore = path.join(tmpRoot, 'mixed-gws-audit.jsonl');
    writeAuditStore(auditStore, [
      signedAuditEntry(key, {
        auditId: 'mixed-first',
        inputId: 'in-first',
        routeKey,
        occurredAt: '2026-05-29T12:00:02.000Z',
      }),
      signedAuditEntry(key, {
        auditId: 'mixed-second',
        inputId: 'in-second',
        routeKey,
        occurredAt: '2026-05-29T12:01:02.000Z',
      }),
    ]);
    const inDb = new Database(inPath);
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, timestamp, content, host_input_id, host_route_key, host_received_at,
            host_accepted_input_id, host_accepted_route_key, host_accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'm-first',
        '2026-05-29T12:00:00.000Z',
        '{}',
        'receipt-first',
        routeKey,
        '2026-05-29T12:00:00.000Z',
        'in-first',
        routeKey,
        '2026-05-29T12:00:01.000Z',
      );
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, timestamp, content, host_input_id, host_route_key, host_received_at,
            host_accepted_input_id, host_accepted_route_key, host_accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'm-second',
        '2026-05-29T12:01:00.000Z',
        '{}',
        'receipt-second',
        routeKey,
        '2026-05-29T12:01:00.000Z',
        'in-second',
        routeKey,
        '2026-05-29T12:01:01.000Z',
      );
    const outDb = new Database(outPath);
    outDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('m-first', 'processing', '2026-05-29 12:00:00');
    outDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('m-second', 'processing', '2026-05-29 12:01:00');

    expect(gwsDiscoveryScope(inDb, outDb)).toEqual({});
    expect(
      discoverGwsCrashWindowDraftsScoped({
        sessionDir: sessionPath,
        inDb,
        outDb,
        containerStopped: true,
        auditStorePath: auditStore,
        gwsPublicKey,
        stoppedAt: '2026-05-29T12:02:00.000Z',
      }).discovered,
    ).toBe(0);
    expect((outDb.prepare('SELECT COUNT(*) AS n FROM side_effect_ledger').get() as { n: number }).n).toBe(0);
    inDb.close();
    outDb.close();
  });

  it('recovers each exact accepted partition and returns coexisting unaccepted claims without aborting recovery', () => {
    const { sessionPath, inPath, outPath } = setupSession();
    const routeKey = 'opencode|discord|chan-1|dm:mg-1';
    const key = generateKeyPairSync('ed25519');
    const gwsPublicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const auditStore = path.join(tmpRoot, 'partitioned-gws-audit.jsonl');
    writeAuditStore(auditStore, [
      signedAuditEntry(key, {
        auditId: 'partition-a-draft',
        inputId: 'in-partition-a',
        routeKey,
        occurredAt: '2026-05-29T12:00:02.000Z',
      }),
    ]);

    const inDb = new Database(inPath);
    const insert = inDb.prepare(
      `INSERT INTO messages_in
         (id, timestamp, content, host_input_id, host_route_key, host_received_at,
          host_accepted_input_id, host_accepted_route_key, host_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'accepted-a',
      '2026-05-29T12:00:00.000Z',
      '{"text":"draft A"}',
      'in-partition-a',
      routeKey,
      '2026-05-29T12:00:00.000Z',
      'in-partition-a',
      routeKey,
      '2026-05-29T12:00:01.000Z',
    );
    insert.run(
      'accepted-b',
      '2026-05-29T12:01:00.000Z',
      '{"text":"work B"}',
      'in-partition-b',
      routeKey,
      '2026-05-29T12:01:00.000Z',
      'in-partition-b',
      routeKey,
      '2026-05-29T12:01:01.000Z',
    );
    insert.run(
      'queued-unaccepted',
      '2026-05-29T12:02:00.000Z',
      '{"text":"not accepted yet"}',
      'in-queued',
      routeKey,
      '2026-05-29T12:02:00.000Z',
      null,
      null,
      null,
    );
    const outDb = new Database(outPath);
    const claim = outDb.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)');
    claim.run('accepted-a', 'processing', '2026-05-29 12:00:01');
    claim.run('accepted-b', 'processing', '2026-05-29 12:01:01');
    claim.run('queued-unaccepted', 'processing', '2026-05-29 12:02:01');

    const result = recoverGwsClaimPartitions({
      sessionDir: sessionPath,
      inDb,
      outDb,
      reason: 'claim-stuck',
      containerStopped: true,
      stoppedAt: '2026-05-29T12:03:00.000Z',
      auditStorePath: auditStore,
      gwsPublicKey,
    });

    expect(result.recoveryIds).toHaveLength(2);
    expect(result.returnedUnacceptedClaimIds).toEqual(['queued-unaccepted']);
    expect(
      outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing' ORDER BY message_id").all(),
    ).toEqual([{ message_id: 'accepted-a' }, { message_id: 'accepted-b' }]);
    const state = outDb
      .prepare('SELECT value FROM session_state WHERE key = ?')
      .get(`recovery:opencode:${routeKey}`) as {
      value: string;
    };
    const recoveries = JSON.parse(state.value) as Array<{
      acceptedUnresolvedInputs: Array<{ inputId: string }>;
      sideEffects: Array<{ inputId: string }>;
    }>;
    expect(recoveries.map((entry) => entry.acceptedUnresolvedInputs[0].inputId).sort()).toEqual([
      'in-partition-a',
      'in-partition-b',
    ]);
    expect(
      recoveries.find((entry) => entry.acceptedUnresolvedInputs[0].inputId === 'in-partition-a')?.sideEffects,
    ).toHaveLength(1);
    expect(
      recoveries.find((entry) => entry.acceptedUnresolvedInputs[0].inputId === 'in-partition-b')?.sideEffects,
    ).toHaveLength(0);
    inDb.close();
    outDb.close();
  });

  it('persists discovered completed work into durable recovery before reset so retry cannot blindly repeat it', () => {
    const { sessionPath, inPath, outPath } = setupSession();
    const auditStore = path.join(tmpRoot, 'gws-audit.jsonl');
    const routeKey = 'opencode|discord|chan-1|dm:mg-1';
    const turnStart = '2026-05-29T12:00:00.000Z';
    const key = generateKeyPairSync('ed25519');
    const gwsPublicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeAuditStore(auditStore, [
      signedAuditEntry(key, {
        auditId: 'completed-before-kill',
        inputId: 'in-this',
        routeKey,
        occurredAt: '2026-05-29T12:00:05.000Z',
      }),
    ]);

    const inDb = new Database(inPath);
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, timestamp, content, host_input_id, host_route_key, host_received_at,
            host_accepted_input_id, host_accepted_route_key, host_accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'm-this',
        turnStart,
        '{"text":"create the draft"}',
        'receipt-this',
        routeKey,
        turnStart,
        'in-this',
        routeKey,
        turnStart,
      );
    const outDb = new Database(outPath);
    outDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('m-this', 'processing', '2026-05-29 12:00:00');

    expect(
      discoverGwsCrashWindowDraftsScoped({
        sessionDir: sessionPath,
        inDb,
        outDb,
        containerStopped: true,
        auditStorePath: auditStore,
        gwsPublicKey,
      }).discovered,
    ).toBe(1);
    expect(writeHostInterruptedRecovery({ inDb, outDb, reason: 'claim-stuck', gwsPublicKey })).toMatch(/^rec-host-/);
    const state = outDb.prepare("SELECT value FROM session_state WHERE key LIKE 'recovery:opencode:%'").get() as {
      value: string;
    };
    const [entry] = JSON.parse(state.value) as Array<{ sideEffects: Array<{ id: string; kind: string }> }>;
    expect(entry.sideEffects).toEqual([
      expect.objectContaining({ id: 'completed-before-kill', kind: 'gmail_draft_created' }),
    ]);

    resetStuckProcessingRows(inDb, outDb, fakeSession(), 'claim-stuck', outDb);
    expect(getProcessingClaims(outDb)).toEqual([]);
    expect(inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-this')).toEqual({ tries: 1 });
    expect(outDb.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key LIKE 'recovery:opencode:%'").get()).toEqual(
      {
        n: 1,
      },
    );
    inDb.close();
    outDb.close();
  });
});

describe('spawn skill generation marker', () => {
  it('round-trips the recorded generation for a session dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skillgen-'));
    writeSpawnSkillGeneration(dir, 'gen-xyz');
    expect(readSpawnSkillGeneration(dir)).toBe('gen-xyz');
    expect(fs.existsSync(skillGenerationPath(dir))).toBe(true);
  });

  it('returns an empty string when no marker has been written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skillgen-'));
    expect(readSpawnSkillGeneration(dir)).toBe('');
  });
});

describe('decideSkillRecycle', () => {
  const idleArgs = {
    now: BASE,
    heartbeatMtimeMs: BASE - IDLE_RECYCLE_GRACE_MS - 1_000, // idle past the grace window
    claims: [] as Array<{ message_id: string; status_changed: string }>,
    currentGeneration: 'g2',
    spawnGeneration: 'g1',
  };

  it('recycles an idle container whose skill generation is stale', () => {
    expect(decideSkillRecycle(idleArgs)).toEqual({
      action: 'recycle-skills',
      currentGeneration: 'g2',
      spawnGeneration: 'g1',
    });
  });

  it('does not recycle when the generation is unchanged', () => {
    expect(decideSkillRecycle({ ...idleArgs, currentGeneration: 'g1' })).toEqual({ action: 'ok' });
  });

  it('does not recycle while a message is being processed', () => {
    expect(decideSkillRecycle({ ...idleArgs, claims: [claim('m1', 1_000)] })).toEqual({ action: 'ok' });
  });

  it('does not recycle until the container has been idle past the grace window', () => {
    expect(decideSkillRecycle({ ...idleArgs, heartbeatMtimeMs: BASE - 5_000 })).toEqual({ action: 'ok' });
  });

  it('does not recycle a brand-new container that has not ticked a heartbeat yet', () => {
    expect(decideSkillRecycle({ ...idleArgs, heartbeatMtimeMs: 0 })).toEqual({ action: 'ok' });
  });

  it('recycles a pre-feature container that never recorded a spawn generation', () => {
    expect(decideSkillRecycle({ ...idleArgs, spawnGeneration: '' }).action).toBe('recycle-skills');
  });
});
