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
import { createHash } from 'crypto';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { withRuntimeLock } from './db/runtime-locks.js';
import {
  assertHostGwsSideEffectsReconciledForScopes,
  assertNoUnresolvedGwsReconciliationRecords,
  countDueMessages,
  countDueMessagesExcludingRecovery,
  deleteOrphanProcessingClaims,
  discoverGwsCrashWindowDrafts,
  getContainerState,
  getHostAuthoritativeSideEffects,
  getMessageForRetry,
  getProcessingClaims,
  importHostSideEffects,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
  type ProcessingClaim,
  type ImportSideEffectsResult,
  type GwsManualReconciliation,
} from './db/session-db.js';
import { log } from './log.js';
import { resolveGwsSideEffectVerifyKey } from './gws-side-effect-key.js';
import {
  resolveGwsFinalizationConfig,
  sealAndDrainGwsCorrelation,
  type GwsFinalizationReceipt,
} from './gws-finalization.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  heartbeatPath,
  readSpawnSkillGeneration,
  sessionDir,
} from './session-manager.js';
import {
  getContainerStartedAtMs,
  isContainerRunning,
  killContainer,
  stopContainerAndVerify,
  wakeContainer,
} from './container-runner.js';
import { currentManagedSkillGeneration } from './yente/managed-skills.js';
import {
  ensureSessionSchedulerProjections,
  resolveProjectionContext,
  syncSessionSchedulerState,
} from './modules/scheduling/sync.js';
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
// Idle-reap tier: a running container holding NO processing claims whose
// heartbeat has been quiet this long is reaped well before the absolute
// ceiling. Warm containers are pure cache: continuations are persisted at
// turn init and pending work re-wakes a dead container via sweep step 3, so
// reaping an idle container loses only warm-start time -- while a burst of
// per-thread sessions would otherwise pin 20+ idle unbounded-memory runtimes
// for up to 30 minutes. Operator-overridable via NANOCLAW_IDLE_REAP_MS
// (same pattern as OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS).
export const IDLE_REAP_MS = Number(process.env.NANOCLAW_IDLE_REAP_MS) || 10 * 60 * 1000;
// A container whose skill generation is stale is recycled only once it has been
// quiet at least this long — confident it is between turns, not mid-flush.
export const IDLE_RECYCLE_GRACE_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

// Bounded alternative to retry-forever for side-effect import failures: after
// this many CONSECUTIVE IDENTICAL failures a route is quarantined. Exit is
// operator-only (no automatic retry-out). Operator-overridable via
// NANOCLAW_QUARANTINE_THRESHOLD (same pattern as NANOCLAW_IDLE_REAP_MS).
export const QUARANTINE_THRESHOLD = Number(process.env.NANOCLAW_QUARANTINE_THRESHOLD) || 5;

export type QuarantineDecision =
  | { action: 'track'; consecutive: number }
  | { action: 'quarantine'; consecutive: number };

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number }
  | { action: 'kill-idle'; idleAgeMs: number; idleReapMs: number };

export type SkillRecycleDecision =
  | { action: 'ok' }
  | { action: 'recycle-skills'; currentGeneration: string; spawnGeneration: string };

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
  /**
   * Spawn time of the currently-running container (ms epoch), 0/absent when
   * unknown. Claims persist in the session DB across service restarts, so a
   * pre-restart claim can look minutes old the instant a fresh container
   * spawns. A container cannot be claim-stuck-killed sooner than the claim
   * tolerance after ITS OWN start: effective quiet-age is measured from
   * max(claimLastSeen, containerStarted).
   */
  containerStartedAtMs?: number;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims, containerStartedAtMs } = args;
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
    // Clamp quiet-age by the container's own lifetime (see containerStartedAtMs
    // doc above) so a fresh container gets the full tolerance to heartbeat
    // before a stale pre-restart claim can kill it.
    const claimAge = now - Math.max(claimedAt, containerStartedAtMs ?? 0);
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  // Idle-reap tier: only for containers holding NO claims -- a claim means an
  // active turn, and active turns are governed exclusively by the ceiling and
  // claim-stuck rules above. heartbeatMtimeMs === 0 (freshly spawned, never
  // ticked) is left alone for the same reason as the ceiling check. A declared
  // active long tool widens the idle threshold just like it widens the claim
  // tolerance, so declared-long-tool extensions are unaffected.
  if (claims.length === 0 && heartbeatMtimeMs !== 0) {
    const idleThreshold = Math.max(IDLE_REAP_MS, declaredToolMs ?? 0);
    const idleAge = now - heartbeatMtimeMs;
    if (idleAge > idleThreshold) {
      return { action: 'kill-idle', idleAgeMs: idleAge, idleReapMs: idleThreshold };
    }
  }

  return { action: 'ok' };
}

/**
 * Pure decision for whether a route's side-effect import failure streak has
 * crossed into quarantine -- the bounded alternative to retry-forever.
 * "Identical" = exact error-message string equality: a changing message means
 * progress or a different problem and resets the counter. Inputs are all
 * deterministic; filesystem/DB reads happen in the caller (same precedent as
 * decideStuckAction).
 */
export function decideQuarantine(args: {
  priorConsecutive: number;
  priorError: string | null;
  newError: string;
  threshold?: number;
}): QuarantineDecision {
  const threshold = args.threshold ?? QUARANTINE_THRESHOLD;
  const consecutive = args.priorError === args.newError ? args.priorConsecutive + 1 : 1;
  if (consecutive >= threshold) return { action: 'quarantine', consecutive };
  return { action: 'track', consecutive };
}

/**
 * Pure decision for whether an idle running container should be recycled to
 * pick up redeployed skills. Recycle ONLY when the deployed skill generation
 * differs from what this container spawned with AND the container is idle:
 * no in-flight processing claim, and the heartbeat has been quiet past the
 * grace window (a brand-new container with no heartbeat yet is left alone).
 * Filesystem/DB reads happen in the caller.
 */
export function decideSkillRecycle(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  claims: Array<{ message_id: string; status_changed: string }>;
  currentGeneration: string;
  spawnGeneration: string;
}): SkillRecycleDecision {
  const { now, heartbeatMtimeMs, claims, currentGeneration, spawnGeneration } = args;
  if (currentGeneration === spawnGeneration) return { action: 'ok' };
  if (claims.length > 0) return { action: 'ok' };
  if (heartbeatMtimeMs === 0) return { action: 'ok' };
  if (now - heartbeatMtimeMs < IDLE_RECYCLE_GRACE_MS) return { action: 'ok' };
  return { action: 'recycle-skills', currentGeneration, spawnGeneration };
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

  await runHostSweepPass();
  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

export async function runHostSweepPassForTest(): Promise<void> {
  await runHostSweepPass();
}

async function runHostSweepPass(): Promise<void> {
  try {
    const { deliverDueSchedulerIncidents } = await import('./yente/scheduler-alerts.js');
    await deliverDueSchedulerIncidents();
  } catch (err) {
    log.error('Scheduler incident delivery pass failed', { err });
  }

  try {
    const { resumeUnfinishedSchedulerSupersessions } = await import('./yente/scheduler-reset-repair.js');
    await resumeUnfinishedSchedulerSupersessions();
  } catch (err) {
    log.error('Scheduler reset repair pass failed', { err });
  }

  try {
    const { repairSchedulerProjections } = await import('./modules/scheduling/repair.js');
    await repairSchedulerProjections();
  } catch (err) {
    log.error('Scheduler repair pass failed', { err });
  }

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      try {
        await sweepSession(session);
      } catch (err) {
        log.error('Host sweep session error', { sessionId: session.id, err });
      }
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }
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

    // 2. Sync durable scheduler projection state before due-count so completed
    // recurring projections fan out centrally and reset-resistant projections
    // are repaired before the wake decision.
    try {
      await withRuntimeLock('scheduler-mutator', 120_000, async (owner) => {
        try {
          const { importLegacyActiveTasks } = await import('./modules/scheduling/legacy-import.js');
          const imported = await importLegacyActiveTasks(inDb, session, owner);
          if (imported > 0) {
            log.info('Imported active legacy scheduled tasks', { sessionId: session.id, imported });
          }
        } catch (err) {
          log.error('Legacy scheduler import failed during host sweep', { sessionId: session.id, err });
          const { reportSchedulerIncident } = await import('./yente/scheduler-alerts.js');
          await reportSchedulerIncident({
            dedupeKey: `legacy-import:${session.id}`,
            severity: 'error',
            message: `Scheduler legacy import failed for session ${session.id}. Scheduled tasks may be delayed until import succeeds.`,
            agentGroupId: session.agent_group_id,
            sessionId: session.id,
            messagingGroupId: session.messaging_group_id,
            threadId: session.thread_id,
            details: { err: err instanceof Error ? err.message : String(err) },
          });
        }
        syncSessionSchedulerState(inDb, outDb, session, owner);
        ensureSessionSchedulerProjections(inDb, session, resolveProjectionContext(session), owner);
      });
    } catch (err) {
      log.error('Scheduler sync failed during host sweep', { sessionId: session.id, err });
    }

    // 3. Recover a crashed accepted turn before any replacement can wake.
    // Import/discovery and durable recovery must precede reset/retry, otherwise
    // a replacement can repeat an already-completed external mutation.
    if (!isContainerRunning(session.id) && outDb && getProcessingClaims(outDb).length > 0) {
      await recoverAfterKill(inDb, session, 'container not running');
    }

    // 4. Wake a container if work is due and nothing is running.
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

    // 5. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      await enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }
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

async function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  const now = Date.now();
  const heartbeat = heartbeatMtimeMs(agentGroupId, session.id);
  const claims = getProcessingClaims(outDb);
  const decision = decideStuckAction({
    now,
    heartbeatMtimeMs: heartbeat,
    containerState: getContainerState(outDb),
    claims,
    containerStartedAtMs: getContainerStartedAtMs(session.id),
  });

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    await stopContainerAndVerify(session.id, 'absolute-ceiling');
    await recoverAfterKill(inDb, session, 'absolute-ceiling');
    return;
  }

  if (decision.action === 'kill-claim') {
    log.warn('Killing container — message claimed then silent', {
      sessionId: session.id,
      messageId: decision.messageId,
      claimAgeMs: decision.claimAgeMs,
      toleranceMs: decision.toleranceMs,
    });
    await stopContainerAndVerify(session.id, 'claim-stuck');
    await recoverAfterKill(inDb, session, 'claim-stuck');
    return;
  }

  if (decision.action === 'kill-idle') {
    // Same reap path as kill-ceiling (killContainer + resetStuckProcessingRows)
    // so state handling is identical; distinct action name for prod logs.
    log.info('Reaping idle container (kill-idle)', {
      sessionId: session.id,
      idleAgeMs: decision.idleAgeMs,
      idleReapMs: decision.idleReapMs,
    });
    await stopContainerAndVerify(session.id, 'kill-idle');
    return;
  }

  // Nothing is stuck. If skills were redeployed since this container spawned
  // and it is idle, recycle it so the next message respawns with fresh skills.
  // No processing rows are reset here: the idle gate means there are no claims
  // to recover, and the next inbound message (or due-message wake) respawns it.
  const recycle = decideSkillRecycle({
    now,
    heartbeatMtimeMs: heartbeat,
    claims,
    currentGeneration: currentManagedSkillGeneration(process.env),
    spawnGeneration: readSpawnSkillGeneration(sessionDir(agentGroupId, session.id)),
  });
  if (recycle.action === 'recycle-skills') {
    log.info('Recycling idle container to pick up redeployed skills', {
      sessionId: session.id,
      currentGeneration: recycle.currentGeneration,
      spawnGeneration: recycle.spawnGeneration,
    });
    await killContainer(session.id, 'skills-stale');
  }
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
 *   2. SEAL + DRAIN every exact accepted GWS input at the proxy. This closes
 *      the in-flight proxy race before any journal snapshot is trusted.
 *   3. IMPORT side effects from the host session path for /workspace/
 *      side-effects.jsonl (opens outbound DB writable only after the verified
 *      stop) so recovery does not duplicate completed drafts/summaries.
 *   4. WRITE recovery/fallback for active processing rows.
 *   5. CLEAR stale provider-owned tool state, then RESET the processing rows.
 *   6. Only AFTER all of the above may a replacement container be woken.
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
  /** Seal exact accepted correlations and wait for proxy postflight durability. */
  sealAndDrainAcceptedInputs: () => Promise<void>;
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

  // The proxy is a second writer of durable evidence. Container quiescence is
  // insufficient by itself: wait until every exact accepted correlation is
  // sealed and every admitted handler has completed postflight fsync.
  await opts.sealAndDrainAcceptedInputs();

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
 * Scoping for the host-only GWS crash-window discovery, derived from the
 * interrupted turn's recovery context so we import ONLY the active turn's
 * orphan draft-create — never another session's/route's drafts from the shared
 * global audit store.
 *
 * Source: host-only acceptance columns on the exact inbound rows named by
 * processing_ack. The host stamps the entire accepted batch atomically after
 * validating IPC against those immutable inbound rows. Every claim must have
 * the same exact accepted input, route, and acceptance time; mixed inputs fail
 * closed. The confirmed-stop time supplies a mandatory upper bound.
 */
export function gwsDiscoveryScope(
  inDb: Database.Database,
  outDb: Database.Database,
  stoppedAt = new Date().toISOString(),
): { inputId?: string; routeKey?: string; notBefore?: string; notAfter?: string } {
  const plan = partitionGwsClaims(inDb, outDb, stoppedAt);
  if (plan.unacceptedClaimIds.length > 0 || plan.invalidClaimIds.length > 0 || plan.partitions.length !== 1) return {};
  return plan.partitions[0].scope;
}

interface ExactGwsClaimPartition {
  scope: { inputId: string; routeKey: string; notBefore: string; notAfter: string };
  claims: ProcessingClaim[];
}

function partitionGwsClaims(
  inDb: Database.Database,
  outDb: Database.Database,
  stoppedAt: string,
): { partitions: ExactGwsClaimPartition[]; unacceptedClaimIds: string[]; invalidClaimIds: string[] } {
  const stoppedMs = Date.parse(stoppedAt);
  if (!Number.isFinite(stoppedMs)) {
    return {
      partitions: [],
      unacceptedClaimIds: [],
      invalidClaimIds: getProcessingClaims(outDb)
        .map((claim) => claim.message_id)
        .sort(),
    };
  }
  const lookup = inDb.prepare(
    `SELECT host_accepted_input_id, host_accepted_route_key, host_accepted_at, host_acceptance_ended_at
       FROM messages_in WHERE id = ?`,
  );
  const grouped = new Map<
    string,
    { inputId: string; routeKey: string; acceptedAt: string; upperMs: number; claims: ProcessingClaim[] }
  >();
  const unacceptedClaimIds: string[] = [];
  const invalidClaimIds: string[] = [];
  for (const claim of getProcessingClaims(outDb)) {
    const row = lookup.get(claim.message_id) as
      | {
          host_accepted_input_id: string | null;
          host_accepted_route_key: string | null;
          host_accepted_at: string | null;
          host_acceptance_ended_at: string | null;
        }
      | undefined;
    if (!row) {
      invalidClaimIds.push(claim.message_id);
      continue;
    }
    const coreAcceptance = [row.host_accepted_input_id, row.host_accepted_route_key, row.host_accepted_at];
    const hasAnyAcceptance = coreAcceptance.some((value) => value !== null) || row.host_acceptance_ended_at !== null;
    if (!hasAnyAcceptance) {
      unacceptedClaimIds.push(claim.message_id);
      continue;
    }
    if (coreAcceptance.some((value) => typeof value !== 'string' || value.length === 0)) {
      invalidClaimIds.push(claim.message_id);
      continue;
    }
    const inputId = row.host_accepted_input_id!;
    const routeKey = row.host_accepted_route_key!;
    const acceptedAt = row.host_accepted_at!;
    const acceptedMs = Date.parse(acceptedAt);
    if (!Number.isFinite(acceptedMs)) {
      invalidClaimIds.push(claim.message_id);
      continue;
    }
    let upperMs = stoppedMs;
    if (row.host_acceptance_ended_at) {
      const endedMs = Date.parse(row.host_acceptance_ended_at);
      if (!Number.isFinite(endedMs)) {
        invalidClaimIds.push(claim.message_id);
        continue;
      }
      upperMs = Math.min(upperMs, endedMs);
    }
    if (upperMs < acceptedMs) {
      invalidClaimIds.push(claim.message_id);
      continue;
    }
    const key = `${inputId}\0${routeKey}\0${acceptedAt}`;
    const partition = grouped.get(key) ?? {
      inputId,
      routeKey,
      acceptedAt,
      upperMs,
      claims: [],
    };
    partition.upperMs = Math.min(partition.upperMs, upperMs);
    partition.claims.push(claim);
    grouped.set(key, partition);
  }
  return {
    partitions: [...grouped.values()].map((partition) => ({
      scope: {
        inputId: partition.inputId,
        routeKey: partition.routeKey,
        notBefore: new Date(Date.parse(partition.acceptedAt)).toISOString(),
        notAfter: new Date(partition.upperMs).toISOString(),
      },
      claims: partition.claims,
    })),
    unacceptedClaimIds: unacceptedClaimIds.sort(),
    invalidClaimIds: invalidClaimIds.sort(),
  };
}

function strictAcceptedGwsRecoveryPlan(
  inDb: Database.Database,
  outDb: Database.Database,
  stoppedAt: string,
): { partitions: ExactGwsClaimPartition[]; unacceptedClaimIds: string[]; invalidClaimIds: string[] } {
  const plan = partitionGwsClaims(inDb, outDb, stoppedAt);
  if (plan.invalidClaimIds.length > 0) {
    throw new Error(
      `interrupted turn has malformed or only partially committed host acceptance: ${plan.invalidClaimIds.join(', ')}`,
    );
  }
  return plan;
}

/**
 * Seal every host-authenticated accepted input and wait for proxy durability.
 * Genuinely unaccepted claims need no barrier: the host never published a
 * correlation for them, so the proxy could not admit a write for that input.
 */
export async function sealAndDrainAcceptedGwsClaims(opts: {
  inDb: Database.Database;
  outDb: Database.Database;
  stoppedAt: string;
  env?: NodeJS.ProcessEnv;
  sealAndDrain?: typeof sealAndDrainGwsCorrelation;
}): Promise<GwsFinalizationReceipt[]> {
  const plan = strictAcceptedGwsRecoveryPlan(opts.inDb, opts.outDb, opts.stoppedAt);
  const partitions = [...plan.partitions].sort((left, right) =>
    `${left.scope.inputId}\0${left.scope.routeKey}`.localeCompare(`${right.scope.inputId}\0${right.scope.routeKey}`),
  );
  if (partitions.length === 0) return [];
  const config = resolveGwsFinalizationConfig(opts.env);
  const finalize = opts.sealAndDrain ?? sealAndDrainGwsCorrelation;
  const receipts: GwsFinalizationReceipt[] = [];
  for (const partition of partitions) {
    receipts.push(
      await finalize({
        inputId: partition.scope.inputId,
        routeKey: partition.scope.routeKey,
        socketPath: config.socketPath,
        tokenFile: config.tokenFile,
        credentialDirectory: config.credentialDirectory,
      }),
    );
  }
  return receipts;
}

/** Strict ledger import used by normal host-sweep crash recovery. */
export function importInterruptedTurnSideEffects(opts: {
  sessionDir: string;
  inDb: Database.Database;
  outDb: Database.Database;
  containerStopped: boolean;
  stoppedAt: string;
  allowedArtifactRoots?: string[];
  gwsPublicKey?: string;
}): ImportSideEffectsResult {
  const plan = strictAcceptedGwsRecoveryPlan(opts.inDb, opts.outDb, opts.stoppedAt);
  if (plan.partitions.length === 0) return { imported: 0, skipped: 0, validated: 0 };
  return importHostSideEffects({
    sessionDir: opts.sessionDir,
    containerStopped: opts.containerStopped,
    allowedArtifactRoots: opts.allowedArtifactRoots,
    gwsPublicKey: opts.gwsPublicKey,
    requireCompleteLedger: true,
    strictGwsScopes: plan.partitions.map((partition) => partition.scope),
  });
}

/**
 * Production crash-window discovery wiring: compute the active turn's scope from
 * the host session dir + outbound DB, then run the host-only GWS audit-store
 * discovery bounded to THAT scope. Exported so the production wiring (not just
 * the unscoped primitive) is directly testable: a shared global audit store
 * with a draft-create for THIS route/window plus one for a DIFFERENT route must
 * import only the matching one.
 */
export function discoverGwsCrashWindowDraftsScoped(opts: {
  sessionDir: string;
  inDb: Database.Database;
  outDb: Database.Database;
  containerStopped: boolean;
  auditStorePath: string | undefined;
  gwsPublicKey?: string;
  stoppedAt?: string;
  scope?: { inputId: string; routeKey: string; notBefore: string; notAfter: string };
  requireAuditAccess?: boolean;
  requireCompleteAudit?: boolean;
  failOnUnresolved?: boolean;
}): ReturnType<typeof discoverGwsCrashWindowDrafts> {
  const scope = opts.scope ?? gwsDiscoveryScope(opts.inDb, opts.outDb, opts.stoppedAt);
  return discoverGwsCrashWindowDrafts({
    sessionDir: opts.sessionDir,
    containerStopped: opts.containerStopped,
    auditStorePath: opts.auditStorePath,
    inputId: scope.inputId,
    routeKey: scope.routeKey,
    notBefore: scope.notBefore,
    notAfter: scope.notAfter,
    gwsPublicKey: opts.gwsPublicKey,
    requireAuditAccess: opts.requireAuditAccess,
    requireCompleteAudit: opts.requireCompleteAudit,
    failOnUnresolved: opts.failOnUnresolved,
  });
}

function inboundTaskText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown; prompt?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.prompt === 'string') return parsed.prompt;
  } catch {
    // Preserve opaque legacy content below.
  }
  return content;
}

/** Persist a route-scoped recovery entry before interrupted rows are reset. */
export function writeHostInterruptedRecovery(opts: {
  inDb: Database.Database;
  outDb: Database.Database;
  reason: string;
  gwsPublicKey?: string;
  scope?: { inputId: string; routeKey: string; notBefore: string; notAfter: string };
  claims?: ProcessingClaim[];
  manualReconciliations?: GwsManualReconciliation[];
}): string | null {
  const scope = opts.scope ?? gwsDiscoveryScope(opts.inDb, opts.outDb);
  if (!scope.inputId || !scope.routeKey || !scope.notBefore || !scope.notAfter) return null;
  const claims = opts.claims ?? getProcessingClaims(opts.outDb);
  if (claims.length === 0) return null;

  const ids = claims.map((claim) => claim.message_id).sort();
  const recoveryId = `rec-host-${createHash('sha256')
    .update(`${scope.routeKey}\0${ids.join('\0')}`)
    .digest('hex')
    .slice(0, 24)}`;
  const rowStmt = opts.inDb.prepare('SELECT id, timestamp, content FROM messages_in WHERE id = ?');
  const rows = claims
    .map((claim) => rowStmt.get(claim.message_id) as { id: string; timestamp: string; content: string } | undefined)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (rows.length !== claims.length) return null;

  const now = new Date().toISOString();
  const providerName = scope.routeKey.split('|', 1)[0] || 'unknown';
  const sideEffects = getHostAuthoritativeSideEffects(opts.outDb, {
    routeKey: scope.routeKey,
    inputId: scope.inputId,
    gwsPublicKey: opts.gwsPublicKey,
  });
  for (const resolution of opts.manualReconciliations ?? []) {
    if (resolution.disposition !== 'completed') continue;
    sideEffects.push({
      id: `manual-reconciliation:${resolution.auditId}`,
      inputId: resolution.inputId,
      kind: 'gws_mutation_completed',
      label: `${resolution.operation}${resolution.accountLabel ? ` (${resolution.accountLabel})` : ''} — manually confirmed completed`,
      payloadSchemaVersion: 2,
      accountLabel: resolution.accountLabel,
      accountEmail: resolution.accountEmail,
      evidence: {
        manual_reconciliation: true,
        audit_id: resolution.auditId,
        disposition: resolution.disposition,
        operator: resolution.operator,
        note: resolution.note,
      },
      occurredAt: resolution.resolvedAt,
    });
  }
  const entry = {
    id: recoveryId,
    status: 'pending',
    classification: 'host_confirmed_container_interruption',
    agentMessage: 'The prior container stopped mid-turn; resume from the durable recovery evidence.',
    fallbackUserMessage:
      'I was interrupted while working, but I kept the completed-work record and will resume safely.',
    originalTasks: rows.map((row) => ({
      messageId: row.id,
      text: inboundTaskText(row.content),
      timestamp: row.timestamp,
    })),
    acceptedUnresolvedInputs: [
      {
        inputId: scope.inputId,
        messageIds: rows.map((row) => row.id),
        prompt: rows.map((row) => inboundTaskText(row.content)).join('\n'),
      },
    ],
    pendingFollowups: [],
    priorProgress: [],
    observations: [
      `host_stop_reason: ${opts.reason}`,
      ...(opts.manualReconciliations ?? []).map(
        (resolution) =>
          `gws_manual_reconciliation audit=${resolution.auditId} disposition=${resolution.disposition} operator=${resolution.operator}: ${resolution.note}`,
      ),
    ],
    sideEffects,
    continuationPolicy: 'preserve',
    createdAt: now,
    updatedAt: now,
  };
  const key = `recovery:${providerName}:${scope.routeKey}`;
  opts.outDb.transaction(() => {
    const prior = opts.outDb.prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    let entries: unknown[] = [];
    if (prior) {
      const parsed = JSON.parse(prior.value) as unknown;
      if (!Array.isArray(parsed)) throw new Error(`malformed recovery state for ${key}`);
      entries = parsed;
    }
    if (!entries.some((candidate) => (candidate as { id?: unknown })?.id === recoveryId)) entries.push(entry);
    opts.outDb
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(entries), now);
  })();
  return recoveryId;
}

/**
 * Recover every independently authenticated accepted claim partition only
 * after all three durable evidence sources prove complete: the session ledger
 * (imported immediately before this function), the root mutation audit, and
 * the proxy reconciliation journal. Any incomplete proof keeps every claim in
 * processing and prevents automatic retry.
 */
export function recoverGwsClaimPartitions(opts: {
  sessionDir: string;
  inDb: Database.Database;
  outDb: Database.Database;
  reason: string;
  containerStopped: boolean;
  stoppedAt?: string;
  auditStorePath: string | undefined;
  reconciliationStorePath: string | undefined;
  gwsPublicKey?: string;
}): { recoveryIds: string[]; returnedUnacceptedClaimIds: string[] } {
  const plan = strictAcceptedGwsRecoveryPlan(opts.inDb, opts.outDb, opts.stoppedAt ?? new Date().toISOString());
  if (plan.unacceptedClaimIds.length > 0) {
    const remove = opts.outDb.prepare("DELETE FROM processing_ack WHERE message_id = ? AND status = 'processing'");
    opts.outDb.transaction(() => {
      for (const id of plan.unacceptedClaimIds) {
        if (remove.run(id).changes !== 1) {
          throw new Error(`failed to return genuinely unaccepted processing claim ${id} to pending`);
        }
      }
    })();
  }
  if (plan.partitions.length === 0) {
    return { recoveryIds: [], returnedUnacceptedClaimIds: plan.unacceptedClaimIds };
  }
  const scopes = plan.partitions.map((partition) => partition.scope);

  const manualReconciliations = assertNoUnresolvedGwsReconciliationRecords({
    reconciliationStorePath: opts.reconciliationStorePath,
    scopes,
  });

  for (const partition of plan.partitions) {
    discoverGwsCrashWindowDraftsScoped({
      sessionDir: opts.sessionDir,
      inDb: opts.inDb,
      outDb: opts.outDb,
      containerStopped: opts.containerStopped,
      auditStorePath: opts.auditStorePath,
      gwsPublicKey: opts.gwsPublicKey,
      scope: partition.scope,
      requireAuditAccess: true,
      requireCompleteAudit: true,
      failOnUnresolved: true,
    });
  }
  assertHostGwsSideEffectsReconciledForScopes(opts.outDb, { scopes, gwsPublicKey: opts.gwsPublicKey });

  const recoveryIds: string[] = [];
  for (const partition of plan.partitions) {
    const recoveryId = writeHostInterruptedRecovery({
      inDb: opts.inDb,
      outDb: opts.outDb,
      reason: opts.reason,
      gwsPublicKey: opts.gwsPublicKey,
      scope: partition.scope,
      claims: partition.claims,
      manualReconciliations: manualReconciliations.filter(
        (resolution) =>
          resolution.inputId === partition.scope.inputId && resolution.routeKey === partition.scope.routeKey,
      ),
    });
    if (!recoveryId) {
      throw new Error(`failed to persist interrupted-turn recovery for accepted input ${partition.scope.inputId}`);
    }
    recoveryIds.push(recoveryId);
  }
  return { recoveryIds, returnedUnacceptedClaimIds: plan.unacceptedClaimIds };
}

/**
 * Production wiring for recoverInterruptedTurn from the sweep loop. Reopens the
 * outbound DB writable only after a verified container stop, imports the host
 * session path for /workspace/side-effects.jsonl, writes recovery, then resets.
 */
export async function recoverAfterKill(inDb: Database.Database, session: Session, reason: string): Promise<void> {
  const dir = sessionDir(session.agent_group_id, session.id);
  const gwsPublicKey = resolveGwsSideEffectVerifyKey(process.env);
  // Confirm both the tracked process and runtime-label writer are gone BEFORE
  // opening outbound.db writable.
  await stopContainerAndVerify(session.id, `recovery-${reason}`);
  const stoppedAt = new Date().toISOString();
  const writableOutDb = openOutboundDbRw(session.agent_group_id, session.id);
  let shouldWake = false;
  try {
    await recoverInterruptedTurn({
      inDb,
      outDb: writableOutDb,
      session,
      reason,
      writableOutDb,
      verifyContainerStopped: async () => !isContainerRunning(session.id),
      sealAndDrainAcceptedInputs: async () => {
        const receipts = await sealAndDrainAcceptedGwsClaims({
          inDb,
          outDb: writableOutDb,
          stoppedAt,
        });
        if (receipts.length > 0) {
          log.info('Sealed and drained accepted GWS inputs before recovery snapshot', {
            sessionId: session.id,
            inputCount: receipts.length,
          });
        }
      },
      importSideEffects: ({ containerStopped }) => {
        const allowedArtifactRoots = process.env.NANOCLAW_ARTIFACT_ROOTS
          ? process.env.NANOCLAW_ARTIFACT_ROOTS.split(':').filter(Boolean)
          : undefined;
        importInterruptedTurnSideEffects({
          sessionDir: dir,
          inDb,
          outDb: writableOutDb,
          containerStopped,
          stoppedAt,
          gwsPublicKey,
          allowedArtifactRoots,
        });
      },
      writeRecovery: () => {
        const recovered = recoverGwsClaimPartitions({
          sessionDir: dir,
          inDb,
          outDb: writableOutDb,
          reason,
          containerStopped: true,
          stoppedAt,
          auditStorePath: process.env.GWS_AUDIT_STORE,
          reconciliationStorePath: process.env.NANOCLAW_GWS_RECONCILIATION_STORE,
          gwsPublicKey,
        });
        log.info('Partitioned interrupted claims before reset', {
          sessionId: session.id,
          recoveryCount: recovered.recoveryIds.length,
          returnedUnacceptedCount: recovered.returnedUnacceptedClaimIds.length,
        });
      },
      wakeContainer: async () => {
        shouldWake = true;
      },
    });
  } finally {
    writableOutDb.close();
  }
  if (shouldWake) await wakeContainer(session);
}
