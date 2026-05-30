/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Only writes to outbound.db after killing/no-running-container cleanup,
 *     when the container-owned writer is gone
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  countDueMessagesExcludingRecovery,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  importHostSideEffects,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  heartbeatPath,
  sessionDir,
} from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks offset by the host timezone. Append "Z" when no zone marker
 * is present so Date.parse interprets SQLite strings as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container with NO active declared long
// tool. If the heartbeat file hasn't been touched in this long, the container
// is either stuck or doing genuinely nothing — kill and restart on the next
// inbound. A declared active long tool may raise the effective ceiling (see
// effectiveCeilingMs) up to — but never past — OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Single source of truth for maximum turn lifetime. A heartbeat-refreshing-but-
// stuck/looping turn is terminated/recovered at this ceiling regardless of any
// declared tool window; the in-container pump enforces the same ceiling itself,
// and host-sweep is the backstop for a fully wedged pump. Operator-overridable.
export const OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS =
  Number(process.env.OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS) || 6 * 60 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredToolMs = declaredToolTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    // The declared tool may raise the ceiling, but NEVER past the absolute
    // turn ceiling — a heartbeat-refreshing-but-stuck turn dies at the hard cap.
    const ceiling = effectiveCeilingMs(containerState);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredToolMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    // Use the outbound-aware count when outDb is available so that
    // recovery-owned rows (processing_ack.status='recovery') are excluded and
    // do not trigger a redundant container wake. Fall back to the inbound-only
    // count when outDb does not exist yet (brand-new session: no outbound DB
    // means no recovery rows either, so the counts are equivalent).
    const dueCount = outDb ? countDueMessagesExcludingRecovery(inDb, outDb) : countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Declared timeout (ms) of the ANY provider-owned active tool, or null when no
 * tool with a positive declared timeout is active. Generalized from the former
 * Bash-only path: any provider (OpenCode long tools, summarize-dnd, Bash, …)
 * that persists `current_tool` + a positive `tool_declared_timeout_ms` widens
 * tolerance. A non-positive or missing timeout returns null.
 */
export function declaredToolTimeoutMs(state: ContainerState | null): number | null {
  if (!state || !state.current_tool) return null;
  const ms = state.tool_declared_timeout_ms;
  return typeof ms === 'number' && ms > 0 ? ms : null;
}

/**
 * Host-sweep's effective kill ceiling for a running OpenCode/agent turn:
 * `max(ABSOLUTE_CEILING_MS, declaredToolTimeoutMs)`, but a declared tool may
 * raise it ONLY up to OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS, never past it. The
 * in-container pump enforces that same hard cap itself (independent of
 * heartbeat); host-sweep is the backstop for a fully wedged pump.
 */
export function effectiveCeilingMs(state: ContainerState | null): number {
  const declared = declaredToolTimeoutMs(state) ?? 0;
  const raised = Math.max(ABSOLUTE_CEILING_MS, declared);
  return Math.min(raised, OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS);
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

/**
 * Reset retries on inbound rows the container claimed but never acked, and
 * delete orphan processing_ack rows so the next sweep does not kill a freshly
 * respawned container before its agent-runner startup cleanup can run.
 *
 * Safe to call only when the container that owned outbound.db is dead:
 * production callers use this in the !alive branch or immediately after
 * killContainer. Callers that already hold a writable outbound handle can
 * pass it as writableOutDb; production reopens by session path.
 */
export function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}

/**
 * Clear stale provider-owned tool state after a kill/reset so the next sweep
 * tick does not widen the ceiling based on a tool that the dead container was
 * "running". Generalized beyond Bash: nulls `current_tool` and its declared
 * timeout for any provider. Safe to call only when the container that owned
 * outbound.db is dead (single-writer invariant). No-op if the table is absent.
 */
export function clearProviderToolState(outDb: Database.Database): void {
  try {
    outDb
      .prepare(
        `UPDATE container_state
            SET current_tool = NULL, tool_declared_timeout_ms = NULL, tool_started_at = NULL
          WHERE id = 1`,
      )
      .run();
  } catch {
    /* table may not exist on an old/empty outbound DB — nothing to clear */
  }
}

/**
 * Host-side crash/kill recovery for an interrupted turn. Enforces the ordering
 * required by the Hard Invariants:
 *
 *   1. VERIFY the container is stopped. Refuse to do anything outbound-writable
 *      while the runner process might still be writing the outbound DB.
 *   2. IMPORT side effects from the host session path for /workspace/
 *      side-effects.jsonl (opens outbound DB writable only after the verified
 *      stop) so recovery does not duplicate completed drafts/summaries.
 *   3. WRITE recovery/fallback for active processing rows.
 *   4. CLEAR stale provider-owned tool state, then RESET the processing rows.
 *   5. Only AFTER all of the above may a replacement container be woken.
 *
 * The DB writes + side-effect import + recovery write are injected so callers
 * (and tests) can assert ordering and so production wires the real
 * importHostSideEffects / recovery writer / wakeContainer.
 */
export async function recoverInterruptedTurn(opts: {
  inDb: Database.Database;
  outDb: Database.Database;
  session: Session;
  reason: string;
  /** Already-writable outbound handle (caller owns lifecycle). */
  writableOutDb?: Database.Database;
  /** Proof the container is stopped; must resolve true before any write. */
  verifyContainerStopped: () => Promise<boolean>;
  /** Import staged side effects (must run before recovery is written). */
  importSideEffects: (args: { containerStopped: boolean }) => void;
  /** Write route-scoped recovery / fallback for the active processing rows. */
  writeRecovery: () => void;
  /** Wake a replacement container (must run only after recovery is written). */
  wakeContainer: () => Promise<void>;
}): Promise<void> {
  const stopped = await opts.verifyContainerStopped();
  if (!stopped) {
    // Fail closed: never open the outbound DB writable or wake a replacement
    // while the container may still be running.
    throw new Error(
      `recoverInterruptedTurn: container for session ${opts.session.id} is not verified stopped; ` +
        'refusing to import side effects, write recovery, reset rows, or wake a replacement',
    );
  }

  // Side effects first, so recovery facts include already-completed work.
  opts.importSideEffects({ containerStopped: true });

  // Recovery/fallback BEFORE we reset rows or wake anything.
  opts.writeRecovery();

  // Clear stale tool state and reset the interrupted processing rows.
  const useDb = opts.writableOutDb ?? opts.outDb;
  clearProviderToolState(useDb);
  resetStuckProcessingRows(opts.inDb, opts.outDb, opts.session, opts.reason, opts.writableOutDb);

  // Replacement wake last.
  await opts.wakeContainer();
}

/**
 * Production wiring for recoverInterruptedTurn from the sweep loop. Reopens the
 * outbound DB writable only after a verified container stop, imports the host
 * session path for /workspace/side-effects.jsonl, writes recovery, then resets.
 */
export async function recoverAfterKill(inDb: Database.Database, session: Session, reason: string): Promise<void> {
  const dir = sessionDir(session.agent_group_id, session.id);
  // Verify stop BEFORE opening the outbound DB writable (single-writer invariant).
  if (isContainerRunning(session.id)) {
    throw new Error(`recoverAfterKill: container for session ${session.id} is still running; refusing recovery writes`);
  }
  const writableOutDb = openOutboundDbRw(session.agent_group_id, session.id);
  try {
    await recoverInterruptedTurn({
      inDb,
      outDb: writableOutDb,
      session,
      reason,
      writableOutDb,
      verifyContainerStopped: async () => !isContainerRunning(session.id),
      importSideEffects: ({ containerStopped }) => {
        try {
          importHostSideEffects({ sessionDir: dir, containerStopped });
        } catch (err) {
          log.warn('Side-effect import failed during recovery', { sessionId: session.id, err });
        }
      },
      writeRecovery: () => {
        // Route-scoped recovery payload construction is owned by the poll loop /
        // session-state recovery APIs (Task 3 wires the full payload). The
        // backstop here ensures rows are reset with backoff so the next turn
        // resumes; the user-visible recovery context lands in Task 3.
      },
      wakeContainer: async () => {
        /* replacement wake is driven by the next sweep tick's due-count path */
      },
    });
  } finally {
    writableOutDb.close();
  }
}
