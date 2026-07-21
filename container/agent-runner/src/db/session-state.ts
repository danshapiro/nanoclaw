/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Providers may
 * add a runtime-config scope when their continuation ids are tied to
 * model/provider settings; switching either providers or scoped runtime
 * configs then starts fresh without deleting the old slot.
 */
import { getOutboundDb } from './connection.js';
import type { ProviderContinuationPolicy, ProviderSideEffect } from '../providers/types.js';

const LEGACY_KEY = 'sdk_session_id';

function keyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_');
}

function continuationKey(providerName: string, continuationScope?: string): string {
  const provider = keyPart(providerName);
  const scope = continuationScope ? keyPart(continuationScope) : '';
  return scope ? `continuation:${provider}:${scope}` : `continuation:${provider}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no unscoped continuation of its own,
 * adopt the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). Scoped continuations
 * deliberately do NOT adopt the legacy value because the prior runtime config
 * is unknowable; using it would reintroduce stale model/provider resumes. The
 * legacy row is always deleted so future provider flips never re-read a stale
 * id through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string, continuationScope?: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName, continuationScope);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  if (continuationScope) return undefined;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string, continuationScope?: string): string | undefined {
  return getValue(continuationKey(providerName, continuationScope));
}

export function setContinuation(providerName: string, id: string, continuationScope?: string): void {
  setValue(continuationKey(providerName, continuationScope), id);
}

export function clearContinuation(providerName: string, continuationScope?: string): void {
  deleteValue(continuationKey(providerName, continuationScope));
}

export interface ProviderRetrySchedule {
  attempts: number;
  nextAttemptAt: string;
  lastErrorAt: string;
  userErrorEmittedAt?: string;
}

function providerRetryKey(providerName: string, routeKey: string): string {
  return `provider_retry:${keyPart(providerName)}:${Buffer.from(routeKey).toString('base64url')}`;
}

export function readProviderRetrySchedule(providerName: string, routeKey: string): ProviderRetrySchedule | undefined {
  const raw = getValue(providerRetryKey(providerName, routeKey));
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ProviderRetrySchedule>;
    if (
      !Number.isSafeInteger(value.attempts) ||
      (value.attempts as number) < 1 ||
      typeof value.nextAttemptAt !== 'string' ||
      !Number.isFinite(Date.parse(value.nextAttemptAt)) ||
      typeof value.lastErrorAt !== 'string' ||
      !Number.isFinite(Date.parse(value.lastErrorAt)) ||
      (value.userErrorEmittedAt !== undefined &&
        (typeof value.userErrorEmittedAt !== 'string' || !Number.isFinite(Date.parse(value.userErrorEmittedAt))))
    ) {
      return undefined;
    }
    return value as ProviderRetrySchedule;
  } catch {
    return undefined;
  }
}

export function scheduleProviderRetry(
  providerName: string,
  routeKey: string,
  nowMs = Date.now(),
): ProviderRetrySchedule {
  const prior = readProviderRetrySchedule(providerName, routeKey);
  const attempts = Math.min(10, (prior?.attempts ?? 0) + 1);
  const delayMs = Math.min(30_000, 1_000 * 2 ** (attempts - 1));
  const schedule: ProviderRetrySchedule = {
    attempts,
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    lastErrorAt: new Date(nowMs).toISOString(),
    userErrorEmittedAt: prior?.userErrorEmittedAt,
  };
  setValue(providerRetryKey(providerName, routeKey), JSON.stringify(schedule));
  return schedule;
}

export function markProviderRetryUserErrorEmitted(
  providerName: string,
  routeKey: string,
  emittedAt = new Date().toISOString(),
): void {
  const schedule = readProviderRetrySchedule(providerName, routeKey);
  if (!schedule || schedule.userErrorEmittedAt) return;
  setValue(providerRetryKey(providerName, routeKey), JSON.stringify({ ...schedule, userErrorEmittedAt: emittedAt }));
}

export function clearProviderRetrySchedule(providerName: string, routeKey: string): void {
  deleteValue(providerRetryKey(providerName, routeKey));
}

// ── Continuation-clear helper requiring attempted-continuation metadata ──────

/**
 * Clear a continuation only with explicit attempted-continuation metadata. The
 * poll loop owns the authoritative decision (explicit clear-continuation,
 * positive existence check, or the bounded zombie path); this helper just
 * records the clear and refuses to act without the metadata, so a bare
 * transport error can never silently clear a live session.
 */
export function clearContinuationWithProof(
  providerName: string,
  meta: { attemptedContinuation: string; reason: string },
  continuationScope?: string,
): void {
  if (!meta.attemptedContinuation) {
    throw new Error('clearContinuationWithProof requires attemptedContinuation metadata');
  }
  clearContinuation(providerName, continuationScope);
}

// ── Route-scoped provider recovery (Task 1 Step 8) ───────────────────────────

export interface ProviderRecoveryScope {
  providerName: string;
  routeKey: string;
  messagingGroupId: string | null;
  isGroup: 0 | 1 | null;
  platformId: string | null;
  channelType: string | null;
  threadKey: string | null;
}

export interface ProviderRecoveryEntry {
  id: string;
  status: 'pending' | 'in_flight' | 'resolved' | 'superseded';
  inFlightInputId?: string;
  classification: string;
  agentMessage: string;
  fallbackUserMessage: string;
  originalTasks: Array<{ messageId: string; text: string; timestamp: string }>;
  acceptedUnresolvedInputs: Array<{ inputId: string; messageIds: string[]; prompt: string }>;
  pendingFollowups: Array<{ messageId: string; text: string; timestamp: string }>;
  priorProgress: Array<{
    messageOutId: string;
    text: string;
    source: 'provider_progress' | 'mcp_send_message' | 'relay';
    timestamp: string;
  }>;
  observations: string[];
  sideEffects: ProviderSideEffect[];
  safeToolState?: string;
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
  createdAt: string;
  updatedAt: string;
}

function recoveryKey(scope: ProviderRecoveryScope): string {
  return `recovery:${scope.providerName}:${scope.routeKey}`;
}

function readRecoveryRaw(scope: ProviderRecoveryScope): string | undefined {
  return getValue(recoveryKey(scope));
}

function writeRecoveryEntries(scope: ProviderRecoveryScope, entries: ProviderRecoveryEntry[]): void {
  setValue(recoveryKey(scope), JSON.stringify(entries));
}

/**
 * Read recovery entries non-destructively. A malformed payload returns [] from
 * this reader (use recoverMalformedRecovery for non-destructive repair).
 */
export function listRecoveryEntries(scope: ProviderRecoveryScope): ProviderRecoveryEntry[] {
  const raw = readRecoveryRaw(scope);
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProviderRecoveryEntry[]) : [];
  } catch {
    return [];
  }
}

function isUnresolved(e: ProviderRecoveryEntry): boolean {
  return e.status === 'pending' || e.status === 'in_flight';
}

export interface AppendRecoveryResult {
  pressureExceeded?: boolean;
}

/**
 * Append a recovery entry for a route. Unresolved entries are NEVER discarded:
 * if appending would push the unresolved count over `maxUnresolved`, this fails
 * closed (returns `{ pressureExceeded: true }`) and leaves all existing
 * unresolved entries recoverable rather than pruning them.
 */
export function appendRecoveryEntry(
  scope: ProviderRecoveryScope,
  entry: ProviderRecoveryEntry,
  opts: { maxUnresolved?: number } = {},
): AppendRecoveryResult {
  const entries = listRecoveryEntries(scope);
  if (opts.maxUnresolved !== undefined) {
    const unresolvedCount = entries.filter(isUnresolved).length;
    if (unresolvedCount >= opts.maxUnresolved) {
      // Fail closed with a structured alert; do not delete unresolved work.
      console.error(
        JSON.stringify({
          severity: 'error',
          event: 'recovery_pressure_exceeded',
          provider: scope.providerName,
          route_key: scope.routeKey,
          unresolved: unresolvedCount,
          max_unresolved: opts.maxUnresolved,
        }),
      );
      return { pressureExceeded: true };
    }
  }
  entries.push(entry);
  writeRecoveryEntries(scope, entries);
  return {};
}

/**
 * Atomically move row ids into `processing_ack.status='recovery'` AND append the
 * route-scoped recovery payload in ONE outbound-DB transaction (Hard Invariant
 * 164). Both writes live in the outbound DB (recovery payload in `session_state`,
 * ownership in `processing_ack`), so a single `db.transaction` makes them
 * all-or-nothing: a crash mid-transaction strands NO accepted row in `recovery`
 * with no payload, and loses no payload with no ownership.
 *
 * Pressure is checked first (fail-closed): if appending would exceed
 * `maxUnresolved`, nothing is written and `{ pressureExceeded: true }` is
 * returned so the caller can fall back without discarding unresolved work.
 *
 * `opts.__injectMidTransactionThrow` is a test-only seam to prove rollback.
 */
export function appendRecoveryEntryAndOwnRows(
  scope: ProviderRecoveryScope,
  entry: ProviderRecoveryEntry,
  messageIds: string[],
  opts: { maxUnresolved?: number; recoveryId?: string; __injectMidTransactionThrow?: () => void } = {},
): AppendRecoveryResult {
  const existing = listRecoveryEntries(scope);
  if (opts.maxUnresolved !== undefined) {
    const unresolvedCount = existing.filter(isUnresolved).length;
    if (unresolvedCount >= opts.maxUnresolved) {
      console.error(
        JSON.stringify({
          severity: 'error',
          event: 'recovery_pressure_exceeded',
          provider: scope.providerName,
          route_key: scope.routeKey,
          unresolved: unresolvedCount,
          max_unresolved: opts.maxUnresolved,
        }),
      );
      return { pressureExceeded: true };
    }
  }

  const db = getOutboundDb();
  const key = recoveryKey(scope);
  const now = new Date().toISOString();
  const nextPayload = JSON.stringify([...existing, entry]);
  const setStateStmt = db.prepare(
    'INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES ($key, $value, $updated_at)',
  );
  const ownStmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES ($id, 'recovery', datetime('now'))",
  );
  db.transaction(() => {
    setStateStmt.run({ $key: key, $value: nextPayload, $updated_at: now });
    // Test seam: throw AFTER the payload write but before the ownership move
    // commits, to prove the whole transaction rolls back (no partial state).
    opts.__injectMidTransactionThrow?.();
    for (const id of messageIds) ownStmt.run({ $id: id });
  })();

  console.error(
    JSON.stringify({
      severity: 'info',
      event: 'recovery_owned_atomic',
      provider: scope.providerName,
      route_key: scope.routeKey,
      recovery_id: opts.recoveryId ?? entry.id,
      message_ids: messageIds,
    }),
  );
  return {};
}

/** Mark an entry in_flight for the given input id. Retained while in_flight. */
export function markRecoveryInFlight(scope: ProviderRecoveryScope, recoveryId: string, inputId: string): void {
  const entries = listRecoveryEntries(scope);
  const e = entries.find((x) => x.id === recoveryId);
  if (!e) return;
  e.status = 'in_flight';
  e.inFlightInputId = inputId;
  e.updatedAt = new Date().toISOString();
  writeRecoveryEntries(scope, entries);
}

export interface ResolveRecoveryResult {
  resolvedMessageIds: string[];
}

/**
 * Resolve a recovery entry after a successful provider result resolves/
 * supersedes the exact input ids it owns. Resolving an entry also resolves its
 * owned input ledger rows (returns their message ids so the caller can mark
 * them completed). The entry is marked resolved but kept until pruning.
 */
export function resolveRecoveryEntry(
  scope: ProviderRecoveryScope,
  recoveryId: string,
  resolution: { resolvedInputIds: string[]; supersededInputIds?: string[] },
): ResolveRecoveryResult {
  const entries = listRecoveryEntries(scope);
  const e = entries.find((x) => x.id === recoveryId);
  if (!e) return { resolvedMessageIds: [] };

  const resolvedSet = new Set([...(resolution.resolvedInputIds ?? []), ...(resolution.supersededInputIds ?? [])]);
  const resolvedMessageIds: string[] = [];
  for (const acc of e.acceptedUnresolvedInputs) {
    if (resolvedSet.has(acc.inputId)) {
      for (const id of acc.messageIds) resolvedMessageIds.push(id);
    }
  }
  const superseded = (resolution.supersededInputIds ?? []).some((id) =>
    e.acceptedUnresolvedInputs.some((a) => a.inputId === id),
  );
  e.status = superseded && resolution.resolvedInputIds.length === 0 ? 'superseded' : 'resolved';
  e.updatedAt = new Date().toISOString();
  writeRecoveryEntries(scope, entries);
  return { resolvedMessageIds };
}

/**
 * Enrich an unresolved recovery entry with more observations/progress/side
 * effects. An in_flight entry that hits another terminal interruption is
 * enriched and retained, never deleted.
 */
export function enrichRecoveryEntry(
  scope: ProviderRecoveryScope,
  recoveryId: string,
  enrichment: {
    observations?: string[];
    priorProgress?: ProviderRecoveryEntry['priorProgress'];
    sideEffects?: ProviderSideEffect[];
    pendingFollowups?: ProviderRecoveryEntry['pendingFollowups'];
    acceptedUnresolvedInputs?: ProviderRecoveryEntry['acceptedUnresolvedInputs'];
    safeToolState?: string;
  },
): void {
  const entries = listRecoveryEntries(scope);
  const e = entries.find((x) => x.id === recoveryId);
  if (!e) return;
  if (enrichment.observations) e.observations.push(...enrichment.observations);
  if (enrichment.priorProgress) e.priorProgress.push(...enrichment.priorProgress);
  if (enrichment.sideEffects) e.sideEffects.push(...enrichment.sideEffects);
  if (enrichment.pendingFollowups) e.pendingFollowups.push(...enrichment.pendingFollowups);
  if (enrichment.acceptedUnresolvedInputs) e.acceptedUnresolvedInputs.push(...enrichment.acceptedUnresolvedInputs);
  if (enrichment.safeToolState) e.safeToolState = enrichment.safeToolState;
  e.updatedAt = new Date().toISOString();
  writeRecoveryEntries(scope, entries);
}

/** Mark an entry superseded by an enriched replacement (never deletes work). */
export function supersedeRecoveryEntry(scope: ProviderRecoveryScope, recoveryId: string): void {
  const entries = listRecoveryEntries(scope);
  const e = entries.find((x) => x.id === recoveryId);
  if (!e) return;
  e.status = 'superseded';
  e.updatedAt = new Date().toISOString();
  writeRecoveryEntries(scope, entries);
}

/**
 * Prune only `resolved`/`superseded` entries. Unresolved entries are NEVER
 * count-pruned. `keep` (default unlimited) bounds how many resolved/superseded
 * entries are retained (most recent first); unresolved entries always survive.
 */
export function pruneResolvedRecoveryEntries(scope: ProviderRecoveryScope, opts: { keep?: number } = {}): void {
  const entries = listRecoveryEntries(scope);
  const unresolved = entries.filter(isUnresolved);
  const terminal = entries.filter((e) => !isUnresolved(e));
  const keep = opts.keep ?? Infinity;
  const keptTerminal = keep === Infinity ? terminal : terminal.slice(Math.max(0, terminal.length - keep));
  writeRecoveryEntries(scope, [...unresolved, ...keptTerminal]);
}

export interface MalformedRecoveryOutcome {
  destroyedSilently: boolean;
  disposition: 'reconstructed' | 'fallback' | 'returned_to_pending' | 'noop';
}

/**
 * Non-destructive malformed-recovery repair. If the stored payload is not valid
 * JSON, we do NOT silently delete it: we attempt to reconstruct a replacement
 * entry from any recoverable fragments, and otherwise leave a route-scoped
 * fallback marker so owned work is never lost. `destroyedSilently` is always
 * false — that is the contract this enforces.
 */
export function recoverMalformedRecovery(scope: ProviderRecoveryScope): MalformedRecoveryOutcome {
  const raw = readRecoveryRaw(scope);
  if (raw === undefined) return { destroyedSilently: false, disposition: 'noop' };
  try {
    JSON.parse(raw);
    return { destroyedSilently: false, disposition: 'noop' };
  } catch {
    // Malformed. Try to salvage any messageId fragments so owned work survives.
    const salvagedIds = Array.from(raw.matchAll(/"messageId"\s*:\s*"([^"]+)"/g)).map((m) => m[1]);
    const now = new Date().toISOString();
    const replacement: ProviderRecoveryEntry = {
      id: `rec-reconstructed-${Date.now()}`,
      status: 'pending',
      classification: 'malformed_recovery_reconstructed',
      agentMessage: 'Recovering interrupted work after a corrupted recovery record.',
      fallbackUserMessage: 'I hit a problem restoring my place. If your last request is unfinished, please resend it.',
      originalTasks: salvagedIds.map((id) => ({ messageId: id, text: '(reconstructed)', timestamp: now })),
      acceptedUnresolvedInputs: [],
      pendingFollowups: [],
      priorProgress: [],
      observations: ['reconstructed from malformed recovery payload'],
      sideEffects: [],
      continuationPolicy: 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    writeRecoveryEntries(scope, [replacement]);
    return {
      destroyedSilently: false,
      disposition: salvagedIds.length > 0 ? 'reconstructed' : 'fallback',
    };
  }
}
