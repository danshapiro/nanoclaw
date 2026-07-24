/**
 * route_quarantine accessors -- bounded quarantine state for side-effect
 * import failures, keyed by host route key and stored in the host-owned
 * per-session inbound DB (where routes/messages already live; no new IPC).
 *
 * The pure decision lives in host-sweep.ts (decideQuarantine); these
 * functions own the DB reads/upserts around it. A row with quarantined_at
 * NULL is tracking-only state. Exit is operator-only (clearRouteQuarantine)
 * -- nothing here retries a quarantined route out automatically.
 */
import type Database from 'better-sqlite3';

import { decideQuarantine, type QuarantineDecision } from '../host-sweep.js';

interface TrackingRow {
  consecutive_failures: number;
  last_error: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Record one side-effect import failure for a route: applies decideQuarantine
 * against the stored streak, upserts the tracking state, and returns the
 * decision. Does NOT set quarantined_at -- the caller acts on an
 * `action: 'quarantine'` decision via markRouteQuarantined (with a reason).
 */
export function recordImportFailure(inDb: Database.Database, routeKey: string, error: string): QuarantineDecision {
  const prior = inDb
    .prepare('SELECT consecutive_failures, last_error FROM route_quarantine WHERE route_key = ?')
    .get(routeKey) as TrackingRow | undefined;
  const decision = decideQuarantine({
    priorConsecutive: prior?.consecutive_failures ?? 0,
    priorError: prior?.last_error ?? null,
    newError: error,
  });
  inDb
    .prepare(
      `INSERT INTO route_quarantine (route_key, consecutive_failures, last_error, updated_at)
       VALUES (@routeKey, @consecutive, @error, @now)
       ON CONFLICT(route_key) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run({ routeKey, consecutive: decision.consecutive, error, now: nowIso() });
  return decision;
}

/**
 * Reset the failure streak after a successful import. Leaves quarantined_at
 * and reason untouched (no automatic retry-out). No-op for untracked routes.
 */
export function clearImportFailures(inDb: Database.Database, routeKey: string): void {
  inDb
    .prepare(
      `UPDATE route_quarantine
       SET consecutive_failures = 0, last_error = NULL, updated_at = @now
       WHERE route_key = @routeKey`,
    )
    .run({ routeKey, now: nowIso() });
}

/** Quarantine a route, recording when and why. Preserves the tracked streak. */
export function markRouteQuarantined(inDb: Database.Database, routeKey: string, reason: string): void {
  const now = nowIso();
  inDb
    .prepare(
      `INSERT INTO route_quarantine (route_key, consecutive_failures, last_error, quarantined_at, reason, updated_at)
       VALUES (@routeKey, 0, NULL, @now, @reason, @now)
       ON CONFLICT(route_key) DO UPDATE SET
         quarantined_at = excluded.quarantined_at,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    )
    .run({ routeKey, reason, now });
}

export function isRouteQuarantined(inDb: Database.Database, routeKey: string): boolean {
  const row = inDb.prepare('SELECT quarantined_at FROM route_quarantine WHERE route_key = ?').get(routeKey) as
    | { quarantined_at: string | null }
    | undefined;
  return row?.quarantined_at != null;
}

/**
 * Explicit operator exit from quarantine -- the ONLY path out (NFR6). Clears
 * the quarantine marker and the failure streak so the route restarts clean.
 */
export function clearRouteQuarantine(inDb: Database.Database, routeKey: string): void {
  inDb
    .prepare(
      `UPDATE route_quarantine
       SET quarantined_at = NULL, reason = NULL, consecutive_failures = 0, last_error = NULL, updated_at = @now
       WHERE route_key = @routeKey`,
    )
    .run({ routeKey, now: nowIso() });
}
