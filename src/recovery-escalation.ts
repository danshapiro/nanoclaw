/**
 * R1/R2: bounded lifecycle for recovery-owned processing_ack rows.
 *
 * A quiet thread whose only work is recovery-owned wedges forever: recovery
 * rows are excluded from the wake due-count, and the container only resumes
 * recovery entries within a turn it woke for anyway (dvora incident 2026-07).
 *
 *  - past TTL, attempts < max: RELEASE — bump messages_in.recovery_wake_attempts
 *    and delete the recovery ack so the row is normal pending work again. The
 *    next turn re-processes it WITH the still-pending recovery context injected
 *    by the poll-loop resume machinery (do-not-repeat side effects preserved).
 *  - past TTL, attempts >= max: ESCALATE — user-visible notice row (doubles as
 *    the failedAckHasTerminalNotice proof), ack -> failed, messages_in -> failed,
 *    best-effort supersede of owning session_state recovery entries, and an
 *    error incident (reaches Discord via the incident->alert pass).
 *
 * Invariant: nothing sits hidden behind a recovery ack for more than TTL*K
 * without resolving or failing loudly. Never silently drops a message.
 *
 * Caller contract: the session's container is NOT running (RW outbound open).
 */
import type Database from 'better-sqlite3';
import {
  deleteRecoveryAcks,
  failRecoveryAck,
  getHostAcceptedInputId,
  getMessageRouting,
  getRecoveryWakeAttempts,
  incrementRecoveryWakeAttempts,
  listGwsUncertainInputIds,
  listRecoveryAcks,
  listReconciliationBlockedRecoveryIds,
  markMessageFailed,
} from './db/session-db.js';
import { openOutboundDbRw, writeOutboundDirect } from './session-manager.js';
import { reportSchedulerIncident } from './yente/scheduler-alerts.js';
import { log } from './log.js';
import type { Session } from './types.js';

export interface RecoveryReleaseOutcome {
  released: string[];
  escalated: string[];
}

export async function releaseOrEscalateExpiredRecoveryAcks(opts: {
  session: Session;
  inDb: Database.Database;
  outDb: Database.Database;
  nowMs: number;
  ttlMs: number;
  maxAttempts: number;
  /** GWS reconciliation store (env NANOCLAW_GWS_RECONCILIATION_STORE); undefined = GWS not configured. */
  reconciliationStorePath?: string;
}): Promise<RecoveryReleaseOutcome> {
  const blockedIds = listReconciliationBlockedRecoveryIds(opts.outDb);
  // Persist the replay gate before notifying, then retry its idempotent
  // incident on later sweeps if reporting failed/crashed after the hold.
  if (blockedIds.size > 0) {
    const heldRows = opts.outDb.prepare("SELECT value FROM session_state WHERE key LIKE 'recovery:%'").all() as Array<{
      value: string;
    }>;
    for (const row of heldRows)
      for (const held of JSON.parse(row.value) as Array<{ id?: string; status?: string }>) {
        if (held.status === 'reconciliation_required') await reportReconciliationHold(opts.session, held.id);
      }
  }
  const expired = listRecoveryAcks(opts.outDb)
    .filter((ack) => !blockedIds.has(ack.messageId))
    .filter(
      // Unparseable timestamps count as expired: fail loud, never fail hidden.
      (ack) => !Number.isFinite(ack.statusChangedMs) || opts.nowMs - ack.statusChangedMs >= opts.ttlMs,
    );
  if (expired.length === 0) return { released: [], escalated: [] };

  // R2 GWS-cleanliness gate (A8, validator-V5 N1): a row whose ORIGINAL
  // accepted input has unresolved GWS reconciliation evidence must NEVER be
  // auto-released — the re-run would repeat a GWS write whose outcome is
  // unknown, and re-acceptance mints a NEW input_id so R8's fail-closed
  // machinery structurally cannot catch it. Such rows escalate directly.
  let gwsUncertainInputIds: Set<string>;
  try {
    gwsUncertainInputIds = listGwsUncertainInputIds(opts.reconciliationStorePath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- deliberate: ANY gate-read failure must defer the pass loudly (fail closed), never release
  } catch (err) {
    // Configured store unreadable: neither release (unsafe) nor terminally
    // escalate (unfair to the message) — defer the whole pass LOUDLY and let
    // the next sweep retry; R3's stale-ack escalation keeps alerting.
    log.error('Recovery release pass deferred: GWS reconciliation store unreadable', {
      sessionId: opts.session.id,
      err,
    });
    return { released: [], escalated: [] };
  }

  const toRelease: string[] = [];
  const toEscalate: string[] = [];
  const gatedInputIds = new Map<string, string>();
  for (const ack of expired) {
    const inputId = getHostAcceptedInputId(opts.inDb, ack.messageId);
    const gwsUncertain = inputId !== null && gwsUncertainInputIds.has(inputId);
    const exhausted = getRecoveryWakeAttempts(opts.inDb, ack.messageId) >= opts.maxAttempts;
    (gwsUncertain || exhausted ? toEscalate : toRelease).push(ack.messageId);
    if (gwsUncertain) {
      gatedInputIds.set(ack.messageId, inputId);
      log.error('Recovery release blocked by unresolved GWS reconciliation; escalating', {
        sessionId: opts.session.id,
        messageId: ack.messageId,
        inputId,
      });
    }
  }

  // An accepted input's shared prompt cannot be split safely by message id.
  // If only part exhausts, preserve its entire evidence and block replay until
  // reconciliation rather than executing the failed member again or dropping
  // the live sibling. No attempts/acks/notices change on this ambiguous pass.
  const recoveryRows = opts.outDb
    .prepare("SELECT key,value FROM session_state WHERE key LIKE 'recovery:%'")
    .all() as Array<{ key: string; value: string }>;
  for (const row of recoveryRows) {
    const entries = JSON.parse(row.value) as Array<{
      id?: string;
      status?: string;
      updatedAt?: string;
      reconciliationReason?: string;
      acceptedUnresolvedInputs?: Array<{ inputId?: string; messageIds?: string[] }>;
    }>;
    if (!Array.isArray(entries)) throw new Error('Recovery release blocked: malformed recovery evidence');
    for (const entry of entries) {
      if (entry.status !== 'pending' && entry.status !== 'in_flight') continue;
      for (const accepted of entry.acceptedUnresolvedInputs ?? []) {
        const ids = accepted.messageIds ?? [];
        if (!ids.some((id) => toEscalate.includes(id))) continue;
        const liveIds = ids.filter((id) => !toEscalate.includes(id) && recoveryMemberIsLive(opts.inDb, opts.outDb, id));
        if (liveIds.length === 0) continue;
        // Durable replay gate: an unrelated same-route wake must not inject
        // this shared prompt either. Keep every payload/ack intact; only an
        // explicitly reconciled repair may clear this lifecycle state.
        entry.status = 'reconciliation_required';
        entry.updatedAt = new Date(opts.nowMs).toISOString();
        entry.reconciliationReason = 'partial shared accepted-input retry exhaustion';
        const heldDb = openOutboundDbRw(opts.session.agent_group_id, opts.session.id);
        try {
          heldDb
            .prepare('UPDATE session_state SET value=?,updated_at=? WHERE key=?')
            .run(JSON.stringify(entries), entry.updatedAt, row.key);
        } finally {
          heldDb.close();
        }
        await reportReconciliationHold(opts.session, entry.id);
        return { released: [], escalated: [] };
      }
    }
  }

  // Notices first (writeOutboundDirect owns its own short-lived write handle).
  // Deterministic ids + INSERT OR IGNORE make escalation idempotent across
  // partially-failed sweeps.
  const noticeIds = new Map<string, string>();
  for (const messageId of toEscalate) {
    const routing = getMessageRouting(opts.inDb, messageId);
    const noticeId = `recovery-escalation-${messageId}`;
    const text =
      routing?.kind === 'task'
        ? `NanoClaw could not finish a scheduled task's work after ${opts.maxAttempts} interrupted attempts; the task run has been marked failed. (message ${messageId})`
        : `NanoClaw gave up on a message in this conversation after ${opts.maxAttempts} interrupted processing attempts; it has been marked failed and will not be retried automatically. (message ${messageId})`;
    writeOutboundDirect(opts.session.agent_group_id, opts.session.id, {
      id: noticeId,
      kind: 'chat',
      platformId: routing?.platformId ?? null,
      channelType: routing?.channelType ?? null,
      threadId: routing?.threadId ?? null,
      content: JSON.stringify({ text }),
    });
    noticeIds.set(messageId, noticeId);
  }

  // Count the wake attempt BEFORE deleting the recovery ack (final-review
  // deferred fix; validator-V6 A9): with delete-first, a crash between the two
  // writes deleted the ack without bumping the counter -- one uncounted free
  // release per crash. Increment-first makes that window fail toward EARLIER
  // escalation (attempts bumped, ack still 'recovery', re-selected next
  // sweep): louder, never a silent extra retry, and no message is dropped.
  incrementRecoveryWakeAttempts(opts.inDb, toRelease);

  const outDbRw = openOutboundDbRw(opts.session.agent_group_id, opts.session.id);
  try {
    deleteRecoveryAcks(outDbRw, toRelease);
    for (const messageId of toEscalate) {
      failRecoveryAck(outDbRw, messageId, noticeIds.get(messageId)!);
      supersedeRecoveryEntriesForMessage(opts.inDb, outDbRw, messageId);
    }
  } finally {
    outDbRw.close();
  }

  for (const messageId of toEscalate) markMessageFailed(opts.inDb, messageId);

  for (const messageId of toRelease) {
    log.warn('Released expired recovery ack back to pending', {
      sessionId: opts.session.id,
      messageId,
      ttlMs: opts.ttlMs,
    });
  }
  for (const messageId of toEscalate) {
    log.error('Escalated exhausted recovery ack to terminal failure', {
      sessionId: opts.session.id,
      messageId,
      maxAttempts: opts.maxAttempts,
    });
    await reportSchedulerIncident({
      dedupeKey: `recovery-escalation:${opts.session.id}:${messageId}`,
      severity: 'error',
      agentGroupId: opts.session.agent_group_id,
      sessionId: opts.session.id,
      messagingGroupId: opts.session.messaging_group_id ?? null,
      threadId: opts.session.thread_id ?? null,
      message: `Recovery-owned message ${messageId} in session ${opts.session.id} was abandoned after ${opts.maxAttempts} wake attempts; it has been marked failed and the user was notified.`,
      details: {
        reason: 'recovery-escalation',
        messageId,
        maxAttempts: opts.maxAttempts,
        ttlMs: opts.ttlMs,
        // Distinguishes gate escalations from attempt exhaustion for operators.
        ...(gatedInputIds.has(messageId) ? { gwsUncertainInputId: gatedInputIds.get(messageId) } : {}),
      },
    });
  }
  return { released: toRelease, escalated: toEscalate };
}

/**
 * Best-effort: mark pending/in_flight session_state recovery entries that own
 * this message as superseded, so future turns stop injecting their context.
 * Advisory cleanup — failures are logged and swallowed (fail-open).
 */
function supersedeRecoveryEntriesForMessage(
  inDb: Database.Database,
  outDbRw: Database.Database,
  messageId: string,
): void {
  try {
    const rows = outDbRw.prepare("SELECT key, value FROM session_state WHERE key LIKE 'recovery:%'").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const row of rows) {
      let entries: unknown;
      try {
        entries = JSON.parse(row.value);
        // eslint-disable-next-line no-catch-all/no-catch-all -- deliberate: advisory path skips unparseable entries (fail-open per contract)
      } catch {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      let changed = false;
      for (const entry of entries as Array<{
        status?: string;
        updatedAt?: string;
        originalTasks?: Array<{ messageId?: string; [key: string]: unknown }>;
        pendingFollowups?: Array<{ messageId?: string; [key: string]: unknown }>;
        acceptedUnresolvedInputs?: Array<{ messageIds?: string[]; [key: string]: unknown }>;
        observations?: string[];
      }>) {
        if (entry?.status !== 'pending' && entry?.status !== 'in_flight') continue;
        if (
          !entry.originalTasks?.some((t) => t?.messageId === messageId) &&
          !entry.pendingFollowups?.some((t) => t?.messageId === messageId) &&
          !entry.acceptedUnresolvedInputs?.some((t) => t?.messageIds?.includes(messageId))
        )
          continue;
        const ownedIds = [
          ...new Set([
            ...(entry.originalTasks ?? []).flatMap((t) => (t.messageId ? [t.messageId] : [])),
            ...(entry.pendingFollowups ?? []).flatMap((t) => (t.messageId ? [t.messageId] : [])),
            ...(entry.acceptedUnresolvedInputs ?? []).flatMap((t) => t.messageIds ?? []),
          ]),
        ];
        const hasLiveSibling = ownedIds.some((id) => {
          if (id === messageId) return false;
          return recoveryMemberIsLive(inDb, outDbRw, id);
        });
        if (hasLiveSibling) {
          // Retire only the exhausted member; preserve live siblings, shared
          // accepted prompts and ALL do-not-repeat side-effect evidence.
          const retired = {
            messageId,
            originalTasks: entry.originalTasks?.filter((t) => t.messageId === messageId),
            pendingFollowups: entry.pendingFollowups?.filter((t) => t.messageId === messageId),
          };
          entry.originalTasks = entry.originalTasks?.filter((t) => t.messageId !== messageId);
          entry.pendingFollowups = entry.pendingFollowups?.filter((t) => t.messageId !== messageId);
          entry.acceptedUnresolvedInputs = entry.acceptedUnresolvedInputs
            ?.map((t) => ({
              ...t,
              messageIds: t.messageIds?.filter((id) => id !== messageId),
            }))
            .filter((t) => t.messageIds?.length);
          entry.observations = [
            ...(entry.observations ?? []),
            `Terminally failed input (historical context only; do NOT retry this member, including in shared prompts): ${JSON.stringify(retired)}`,
          ];
        } else {
          entry.status = 'superseded';
        }
        entry.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) {
        outDbRw
          .prepare('UPDATE session_state SET value = ?, updated_at = ? WHERE key = ?')
          .run(JSON.stringify(entries), new Date().toISOString(), row.key);
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- deliberate: supersede is best-effort advisory cleanup; log and swallow (fail-open)
  } catch (err) {
    log.warn('Best-effort recovery-entry supersede failed', { messageId, err });
  }
}

/** A missing ack alone proves neither pending work nor completion. */
function recoveryMemberIsLive(inDb: Database.Database, outDb: Database.Database, messageId: string): boolean {
  const ack = outDb.prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
    | { status: string }
    | undefined;
  if (ack?.status === 'completed' || ack?.status === 'failed') return false;
  if (ack) return true;
  const row = inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(messageId) as
    | { status: string }
    | undefined;
  return row?.status === 'pending' || row?.status === 'processing';
}

async function reportReconciliationHold(session: Session, recoveryId: string | undefined): Promise<void> {
  await reportSchedulerIncident({
    dedupeKey: `recovery-shared-input:${session.id}:${recoveryId}`,
    severity: 'error',
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    messagingGroupId: session.messaging_group_id ?? null,
    threadId: session.thread_id ?? null,
    message:
      'Recovery needs reconciliation: one member of a shared accepted input exhausted retries; queued sibling work and side-effect evidence are preserved and automatic replay is blocked.',
    details: { reason: 'recovery-shared-input-reconciliation', recoveryId },
  });
}
