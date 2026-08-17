import fs from 'fs';
import { randomUUID } from 'crypto';

import {
  findByName,
  findByRouting,
  getAllDestinations,
  isBlockedChannelName,
  SUBAGENT_CHANNEL_BLOCKED_MESSAGE,
  type DestinationEntry,
} from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  returnProcessingToPending,
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut, harvestRouteScopedProgress } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks, getOutboundDb } from './db/connection.js';
import { withSqliteRetry } from './db/sqlite-retry.js';
import { zombieDecision } from './providers/opencode-errors.js';
import {
  appendRecoveryEntry,
  appendRecoveryEntryAndOwnRows,
  clearContinuation,
  clearProviderRetrySchedule,
  listRecoveryEntries,
  markProviderRetryUserErrorEmitted,
  markRecoveryInFlight,
  migrateLegacyContinuation,
  resolveRecoveryEntry,
  readProviderRetrySchedule,
  scheduleProviderRetry,
  setContinuation,
  type ProviderRecoveryEntry,
  type ProviderRecoveryScope,
} from './db/session-state.js';
import { markRecoveryCompleted } from './db/messages-in.js';
import { getSessionRouting } from './db/session-routing.js';
import { collectQueryAttachments, type InspectedFile } from './attachments.js';
import {
  formatMessages,
  formatRecoveryContext,
  extractRouting,
  categorizeMessage,
  normalizeRoute,
  sanitizeDeliveredText,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import {
  ProviderContainerStopRequired,
  ProviderQuiescenceError,
  type AgentProvider,
  type AgentQuery,
  type ProviderEvent,
} from './providers/types.js';
import { bindHostGwsCorrelation, GwsCorrelationLifecycleFault, releaseHostGwsCorrelation } from './gws-correlation.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const HOST_OWNED_COMMANDS = new Set(['/new', '/clear', '/stop']);
const DEFAULT_ACTIVE_INPUT_PATH = '/workspace/.active-input.json';
const STOP_COMMAND = '/stop';
const STOP_ACTIVE_ACK = 'Stopped the active turn.';
const STOP_IDLE_ACK = 'No active turn is running.';

/**
 * Path to the per-input correlation file. Production uses the static
 * `/workspace/.active-input.json` (legacy tools such as summarize-dnd read it;
 * GWS uses the separate host-owned accepted-input pointer);
 * `NANOCLAW_ACTIVE_INPUT_PATH` overrides it only for tests pointing at a temp
 * dir. The default is unchanged when the env var is unset.
 */
function activeInputPath(): string {
  return process.env.NANOCLAW_ACTIVE_INPUT_PATH || DEFAULT_ACTIVE_INPUT_PATH;
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function logAttachmentEvent(event: unknown): void {
  log(JSON.stringify(event));
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalized route key for a message row, using host-stamped metadata. */
function routeKeyForMessage(providerName: string, m: MessageInRow): string {
  return normalizeRoute(providerName, {
    platformId: m.platform_id,
    channelType: m.channel_type,
    threadId: m.thread_id,
    messagingGroupId: m.messaging_group_id ?? null,
    isGroup: (m.is_group as 0 | 1 | null) ?? null,
  }).routeKey;
}

/**
 * Full route-scoped recovery scope for a message row, derived from the SAME
 * host-stamped normalizer used for route splitting. Recovery is keyed by
 * provider + normalized route (Invariants 166/167), so an interrupted turn's
 * recovery is stored under the TRIGGER route, never the first-row route.
 */
function routeScopeForMessage(providerName: string, m: MessageInRow): ProviderRecoveryScope {
  const n = normalizeRoute(providerName, {
    platformId: m.platform_id,
    channelType: m.channel_type,
    threadId: m.thread_id,
    messagingGroupId: m.messaging_group_id ?? null,
    isGroup: (m.is_group as 0 | 1 | null) ?? null,
  });
  return {
    providerName,
    routeKey: n.routeKey,
    messagingGroupId: n.messagingGroupId,
    isGroup: n.isGroup,
    platformId: n.platformId,
    channelType: n.channelType,
    threadKey: n.threadKey,
  };
}

function recoveryIdFor(routeKey: string): string {
  return `rec-${routeKey}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * R1c: true when the host stamped the row's receipt identity at intake. A
 * wake-triggering row missing any of these can never be claimed (the claim
 * needs host_input_id; acceptance binds host_route_key/host_received_at), so
 * without intervention it loops forever: the batch gate below would reject it
 * every second, burning pre-task scripts/heartbeats. The poll loop parks such
 * rows in memory (see runPollLoop); the host sweep durably quarantines them
 * once aged (quarantineOrphanInboundRows in src/host-sweep.ts). Keep this
 * predicate in sync with that host quarantine predicate — separate packages,
 * comment-only link.
 */
function hasHostReceiptStamp(m: MessageInRow): boolean {
  return (
    Boolean(m.host_input_id) &&
    Boolean(m.host_route_key) &&
    typeof m.host_received_at === 'string' &&
    Number.isFinite(Date.parse(m.host_received_at))
  );
}

function sameMessageIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

async function ownExhaustedPreacceptRetry(
  scope: ProviderRecoveryScope,
  messageIds: string[],
  originalTasks: ProviderRecoveryEntry['originalTasks'],
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  const recoveryId = recoveryIdFor(scope.routeKey);
  const entry: ProviderRecoveryEntry = {
    id: recoveryId,
    status: 'pending',
    classification: 'pre_accept_retry_exhausted',
    agentMessage: 'Automatic startup retries were exhausted before this request was accepted.',
    fallbackUserMessage: 'I could not start this request after several retries. It is saved for recovery.',
    originalTasks,
    acceptedUnresolvedInputs: [],
    pendingFollowups: [],
    priorProgress: [],
    observations: [`pre_accept_retry_exhausted: ${errorMessage}`],
    sideEffects: [],
    continuationPolicy: 'preserve',
    createdAt: now,
    updatedAt: now,
  };
  await withSqliteRetry(() => appendRecoveryEntryAndOwnRows(scope, entry, messageIds, { recoveryId }), {
    label: 'ownExhaustedPreacceptRetry',
  });
}

/**
 * Write a user-visible outbound chat row stamped with the active route metadata
 * from `routing` (`route_key`/`messaging_group_id`/`is_group`). All poll-loop
 * outbound writes go through this so the agent's own progress/result/relay rows
 * are harvestable into route-scoped recovery and never leak across conversations.
 */
function writeRoutedMessage(routing: RoutingContext, text: string): void {
  // Delivery-side sanitation: fallback paths (e.g. delivering the agent's raw
  // final text after an ignored unwrapped-output nudge) can carry leftover
  // `<answer>`/`<message to=…>` wrapper tags or blocks addressed to
  // unresolvable destinations. Strip the tags (preserving inner content) and
  // drop unresolvable-destination blocks instead of delivering them verbatim.
  const sanitized = sanitizeDeliveredText(text, (name) => Boolean(findByName(name)));
  for (const dest of sanitized.droppedDestinations) {
    log(
      JSON.stringify({
        severity: 'warn',
        event: 'unresolvable_destination_block_dropped',
        to: dest,
        route_key: routing.routeKey ?? null,
      }),
    );
  }
  if (sanitized.changed && !sanitized.text) {
    log(
      JSON.stringify({
        severity: 'warn',
        event: 'delivered_text_empty_after_sanitization',
        route_key: routing.routeKey ?? null,
      }),
    );
    return;
  }
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    route_key: routing.routeKey ?? null,
    messaging_group_id: routing.messagingGroupId ?? null,
    is_group: routing.isGroup ?? null,
    content: JSON.stringify({ text: sanitized.text }),
  });
}

function textOfMessage(m: MessageInRow): string {
  try {
    const parsed = JSON.parse(m.content) as { text?: string; prompt?: string };
    return parsed.text ?? parsed.prompt ?? m.content;
  } catch {
    return m.content;
  }
}

function isStopControlMessage(m: MessageInRow): boolean {
  if (m.kind !== 'chat' && m.kind !== 'chat-sdk') return false;
  return categorizeMessage(m).text.trim().toLowerCase() === STOP_COMMAND;
}

function stampRoutingScope(routing: RoutingContext, scope: ProviderRecoveryScope): void {
  routing.routeKey = scope.routeKey;
  routing.messagingGroupId = scope.messagingGroupId;
  routing.isGroup = scope.isGroup;
}

/**
 * Atomically write the currently-accepted input correlation to
 * /workspace/.active-input.json (temp+rename) so the GWS shim and summarize-dnd
 * stamp the CURRENT input's correlation at tool-invocation time. Per-input
 * correlation must be a file (a long-lived tool child can't see env updates
 * across follow-ups). Silently no-ops when /workspace is absent (test DBs).
 */
function writeActiveInput(inputId: string, routeKey: string): void {
  try {
    const dest = activeInputPath();
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ inputId, routeKey, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, dest);
  } catch {
    // /workspace may not exist (in-memory test DBs) — non-fatal.
  }
}

const OPENCODE_CONTINUATION_FAILURE_LIMIT =
  Number(process.env.OPENCODE_CONTINUATION_FAILURE_LIMIT) > 0
    ? Number(process.env.OPENCODE_CONTINUATION_FAILURE_LIMIT)
    : 3;

/**
 * Bounded zombie backstop counter (Hard Invariant 152). Counts CONSECUTIVE
 * terminal interruptions on the SAME continuation with no successful event in
 * between, persisted across wakes in session_state so a genuinely dead session
 * that only emits bare 404s is not preserved forever. Keyed per provider +
 * continuation. A successful result resets it.
 */
function zombieCounterKey(providerName: string, continuation: string, continuationScope?: string): string {
  const provider = providerName.toLowerCase();
  const scope = continuationScope
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_');
  const providerKey = scope ? `${provider}:${scope}` : provider;
  return `zombie_failures:${providerKey}:${continuation}`;
}

function readZombieCounter(providerName: string, continuation: string, continuationScope?: string): number {
  try {
    const row = getOutboundDb()
      .prepare('SELECT value FROM session_state WHERE key = ?')
      .get(zombieCounterKey(providerName, continuation, continuationScope)) as { value: string } | undefined;
    const n = row ? Number(row.value) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeZombieCounter(
  providerName: string,
  continuation: string,
  count: number,
  continuationScope?: string,
): void {
  try {
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(zombieCounterKey(providerName, continuation, continuationScope), String(count), new Date().toISOString());
  } catch {
    /* non-fatal */
  }
}

function resetZombieCounter(providerName: string, continuation: string, continuationScope?: string): void {
  try {
    getOutboundDb()
      .prepare('DELETE FROM session_state WHERE key = ?')
      .run(zombieCounterKey(providerName, continuation, continuationScope));
  } catch {
    /* non-fatal */
  }
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  inspectAttachmentFile?: (filePath: string) => Promise<InspectedFile | null>;
  /**
   * Pre-task script runner override (testability seam). Production defaults to the
   * dynamically-imported scheduling `applyPreTaskScripts`; a throw here is treated
   * as a recoverable pre-query failure (rows returned to pending), never a raw
   * provider error.
   */
  runPreTaskScripts?: (messages: MessageInRow[]) => Promise<{ keep: MessageInRow[]; skipped: string[] }>;
  /** Internal deterministic seams; production uses authenticated host IPC. */
  bindGwsCorrelation?: typeof bindHostGwsCorrelation;
  releaseGwsCorrelation?: typeof releaseHostGwsCorrelation;
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  const continuationScope = config.provider.continuationScope;
  let continuation: string | undefined = await withSqliteRetry(
    () => migrateLegacyContinuation(config.providerName, continuationScope),
    { label: 'migrateLegacyContinuation' },
  );

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  await withSqliteRetry(() => clearStaleProcessingAcks(), { label: 'clearStaleProcessingAcks' });

  let pollCount = 0;
  // R1c: in-memory park set of unbacked wake-triggering rows (see
  // hasHostReceiptStamp). Persists for this container run; the host sweep's
  // quarantine is the durable fix spanning restarts.
  let parkedUnroutableIds = new Set<string>();
  while (!config.signal?.aborted) {
    // Per-wake guard: at most one user-facing provider-error row per route per
    // wake ("once per turn"). Resets each wake; the durable retry schedule's
    // userErrorEmittedAt covers de-dup across wakes within one retry series.
    const userErrorEmittedRoutes = new Set<string>();
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const rawMessages = (await withSqliteRetry(() => getPendingMessages(), { label: 'getPendingMessages' })).filter(
      (m) => m.kind !== 'system',
    );

    // R1c park-and-quiet: unbacked wake rows are filtered out BEFORE the
    // accumulate gate, route split, and pre-task scripts so they stop burning
    // work (and heartbeats) every second. Log ONE severity=error event when
    // the park set changes (first detection, new id parked, or all parked rows
    // resolved); untouched sets stay silent per poll. The provider retry
    // schedule for the parked routes is cleared only on set change, not per
    // tick. A set that shrinks to empty resolves quietly — the host quarantine
    // already logged the durable disposition.
    const unbacked = rawMessages.filter((m) => m.trigger === 1 && !hasHostReceiptStamp(m));
    const unbackedIds = new Set(unbacked.map((m) => m.id));
    if (!sameMessageIdSet(unbackedIds, parkedUnroutableIds)) {
      const routes = [...new Set(unbacked.map((m) => routeKeyForMessage(config.providerName, m)))];
      if (unbackedIds.size > 0) {
        log(
          JSON.stringify({
            severity: 'error',
            event: 'unroutable_pending_rows_parked',
            message_ids: [...unbackedIds].sort(),
            route_keys: routes,
          }),
        );
      }
      for (const routeKey of routes) {
        await withSqliteRetry(() => clearProviderRetrySchedule(config.providerName, routeKey), {
          label: 'clearProviderRetrySchedule',
        });
      }
      parkedUnroutableIds = unbackedIds;
    }
    const messages = rawMessages.filter((m) => !parkedUnroutableIds.has(m.id));
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    // Split by normalized route BEFORE claiming. The active route is the route
    // of the most-recent wake-triggering (trigger=1) row. Only that route's rows
    // are claimed/processed this wake; rows on other routes stay pending and are
    // never folded into the active route's prompt or recovery. Accumulated
    // trigger=0 context is partitioned the same way (a context row never chooses
    // the active route).
    const triggerRows = messages.filter((m) => m.trigger === 1);
    const activeRouteKey = routeKeyForMessage(config.providerName, triggerRows[triggerRows.length - 1]);
    const activeRouteMessages = messages.filter((m) => routeKeyForMessage(config.providerName, m) === activeRouteKey);
    const otherRouteCount = messages.length - activeRouteMessages.length;
    if (otherRouteCount > 0) {
      log(
        JSON.stringify({
          severity: 'info',
          event: 'route_split',
          active_route: activeRouteKey,
          active_rows: activeRouteMessages.length,
          deferred_other_route_rows: otherRouteCount,
        }),
      );
    }
    // Route scope for this wake — recovery is keyed by provider + the TRIGGER
    // route, never the first-row route. The wake-triggering rows on the active
    // route, in chronological order, become the recovery entry's originalTasks
    // (Invariant 166: not collapsed to a single newest task).
    const activeRouteScope = routeScopeForMessage(config.providerName, triggerRows[triggerRows.length - 1]);
    let activeMessages = activeRouteMessages;
    const idleStopMessages = activeMessages.filter(isStopControlMessage);
    if (idleStopMessages.length > 0) {
      const stopRouting = extractRouting(idleStopMessages);
      stampRoutingScope(stopRouting, activeRouteScope);
      await withSqliteRetry(() => markCompleted(idleStopMessages.map((m) => m.id)), { label: 'markCompleted' });
      await withSqliteRetry(() => writeRoutedMessage(stopRouting, STOP_IDLE_ACK), { label: 'writeRoutedMessage' });
      log(
        JSON.stringify({
          severity: 'info',
          event: 'idle_stop_acknowledged',
          route_key: activeRouteKey,
          message_ids: idleStopMessages.map((m) => m.id),
        }),
      );
      await withSqliteRetry(() => clearProviderRetrySchedule(config.providerName, activeRouteKey), {
        label: 'clearProviderRetrySchedule',
      });
      activeMessages = activeMessages.filter((m) => !isStopControlMessage(m));
      if (!activeMessages.some((m) => m.trigger === 1)) {
        continue;
      }
    }

    const retrySchedule = await withSqliteRetry(() => readProviderRetrySchedule(config.providerName, activeRouteKey), {
      label: 'readProviderRetrySchedule',
    });
    const activeTriggerInputId = activeMessages.filter((message) => message.trigger === 1).at(-1)?.host_input_id;
    if (retrySchedule?.status === 'exhausted') {
      // Exhaustion is durable and never ages back into an automatic eleventh
      // call. Only a distinct host-backed trigger explicitly opens a new retry
      // series; the exhausted request itself is recovery-owned below.
      if (!retrySchedule.triggerInputId || retrySchedule.triggerInputId === activeTriggerInputId) {
        // Close the crash window between persisting attempt 10 and the atomic
        // recovery-ownership transaction. Re-entry never calls the provider;
        // it only completes the durable exhausted disposition.
        await ownExhaustedPreacceptRetry(
          activeRouteScope,
          activeMessages.map((message) => message.id),
          activeMessages
            .filter((message) => message.trigger === 1)
            .map((message) => ({
              messageId: message.id,
              text: textOfMessage(message),
              timestamp: message.timestamp,
            })),
          'automatic retry schedule was already exhausted',
        );
        continue;
      }
      await withSqliteRetry(() => clearProviderRetrySchedule(config.providerName, activeRouteKey), {
        label: 'clearProviderRetrySchedule',
      });
    }
    // Captured BEFORE provider acceptance clears the durable schedule
    // (onInputAccepted): the post-accept catch below must still honor the
    // one-user-error-per-retry-series guard. An exhausted schedule cleared
    // just above (distinct new trigger) starts a fresh series, so it is
    // deliberately not captured.
    const priorUserErrorEmittedAt =
      retrySchedule?.status === 'exhausted' ? undefined : retrySchedule?.userErrorEmittedAt;
    const retryRemainingMs = retrySchedule?.nextAttemptAt ? Date.parse(retrySchedule.nextAttemptAt) - Date.now() : 0;
    if (retryRemainingMs > 0) {
      await sleep(Math.min(retryRemainingMs, 500), config.signal);
      continue;
    }

    const ids = activeMessages.map((m) => m.id);
    // Pending/in_flight recovery entries for THIS route are resumed on this
    // top-level turn: their XML-escaped context is prepended to the prompt so the
    // next Yente turn picks up interrupted work (original task + prior progress +
    // completed side effects + continuation policy), and they are marked in_flight
    // on acceptance and resolved (with their owned rows completed) only on a
    // successful result (Invariants 128/129/140; plan lines 743-744).
    const resumableRecovery = (
      await withSqliteRetry(() => listRecoveryEntries(activeRouteScope), { label: 'listRecoveryEntries' })
    ).filter((e) => e.status === 'pending' || e.status === 'in_flight');
    // Pre-query failures after rows are claimed are recoverable (Invariant 170):
    // a throw in pre-task script HANDLING, formatting, attachment inspection,
    // provider startup, session creation, or prompt acceptance must return the
    // claimed UNACCEPTED rows to pending (delete their transient 'processing'
    // acks) — or store route-scoped recovery — rather than writing a raw provider
    // error or stranding rows. None of these points has an accepted input yet, so
    // returning to pending is the correct disposition (the next wake retries).
    let keep: MessageInRow[] = activeMessages;
    let skipped: string[] = [];
    let prompt: string;
    let attachments: Awaited<ReturnType<typeof collectQueryAttachments>>;
    let query: AgentQuery;
    let processingIds: string[] = [];
    let claimToken = '';
    let topLevelInputId = '';
    const acceptanceContext: InputAcceptanceContext = {
      tail: Promise.resolve(),
      boundGwsInputs: new Set(),
      lifecycleFault: null,
      bind: config.bindGwsCorrelation ?? bindHostGwsCorrelation,
      release: config.releaseGwsCorrelation ?? releaseHostGwsCorrelation,
    };
    let initialClaim: InputClaimBatch | undefined;
    let routing: RoutingContext = extractRouting(activeMessages);
    let originalTasks: ProviderRecoveryEntry['originalTasks'] = activeMessages
      .filter((message) => message.trigger === 1)
      .map((message) => ({
        messageId: message.id,
        text: textOfMessage(message),
        timestamp: message.timestamp,
      }));
    try {
      // Pre-task scripts: for any task rows with a `script`, run it before the
      // provider call. Scripts returning wakeAgent=false (or erroring) gate
      // their own task row only — surviving messages still go to the agent.
      // A THROW in the pre-task handler itself (module import / handler crash) is
      // a recoverable pre-query failure handled by the catch below.
      // MODULE-HOOK:scheduling-pre-task:start
      const runPreTask = config.runPreTaskScripts ?? (await import('./scheduling/task-script.js')).applyPreTaskScripts;
      const preTask = await runPreTask(activeMessages);
      keep = preTask.keep;
      skipped = preTask.skipped;
      if (skipped.length > 0) {
        markCompleted(skipped);
        log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
      }
      // MODULE-HOOK:scheduling-pre-task:end

      if (keep.length === 0) {
        log(`All ${activeMessages.length} message(s) gated by script, skipping query`);
        clearProviderRetrySchedule(config.providerName, activeRouteKey);
        continue;
      }

      // Derive provider identity only from the FINAL pre-task-filtered batch.
      // A context-only survivor cannot invent an input id or reach a provider.
      // R1c: rows that never received host receipt stamps are parked in memory
      // BEFORE the batch reaches pre-task scripts (see the park gate at the
      // top of the loop); this check remains for pre-task-dropped triggers and
      // stamped rows whose host route key does not match the active route.
      const finalTriggerRows = keep.filter((message) => message.trigger === 1);
      const hostTrigger = finalTriggerRows.at(-1);
      if (
        !hostTrigger?.host_input_id ||
        hostTrigger.host_route_key !== activeRouteKey ||
        typeof hostTrigger.host_received_at !== 'string' ||
        !Number.isFinite(Date.parse(hostTrigger.host_received_at))
      ) {
        log(
          JSON.stringify({
            severity: 'info',
            event: 'no_host_backed_trigger_after_pre_task',
            route_key: activeRouteKey,
            remaining_message_ids: keep.map((message) => message.id),
          }),
        );
        clearProviderRetrySchedule(config.providerName, activeRouteKey);
        await sleep(POLL_INTERVAL_MS, config.signal);
        continue;
      }
      topLevelInputId = hostTrigger.host_input_id;
      processingIds = keep.map((message) => message.id);
      claimToken = randomUUID();
      await withSqliteRetry(() => markProcessing(processingIds, claimToken), { label: 'markProcessing' });
      routing = extractRouting(keep);
      originalTasks = finalTriggerRows.map((message) => ({
        messageId: message.id,
        text: textOfMessage(message),
        timestamp: message.timestamp,
      }));

      // Format messages: passthrough commands get raw text (only if the
      // provider natively handles slash commands), others get XML.
      prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

      // Prepend route-scoped recovery context (XML-escaped) so an interrupted
      // prior turn resumes as a normal top-level prompt (plan line 86).
      const recoveryBlock = formatRecoveryContext(resumableRecovery);
      if (recoveryBlock) prompt = `${recoveryBlock}\n\n${prompt}`;

      log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

      attachments = await collectQueryAttachments({
        messages: keep,
        pathReferenceMessages: keep,
        inspectFile: config.inspectAttachmentFile,
        log: logAttachmentEvent,
      });

      const visibleDestination = findByRouting(routing.channelType, routing.platformId);
      const visibleDestinationName = visibleDestination?.name;

      initialClaim = createInputClaim(acceptanceContext, {
        inputId: topLevelInputId,
        routeKey: activeRouteKey,
        messageIds: processingIds,
        claimToken,
        prompt: originalTasks.map((task) => task.text).join('\n') || '(initial turn)',
        scope: 'initial',
      });

      // Provider startup / session creation. A synchronous throw here (the
      // OpenCode server failing to spawn, session creation rejecting) is a
      // pre-acceptance failure: no input has been accepted, so it is recoverable.
      query = config.provider.query({
        inputId: topLevelInputId,
        acceptInput: initialClaim.acceptInput,
        prompt,
        attachments,
        messages: keep,
        visibleDestinationName,
        continuation,
        cwd: config.cwd,
        systemContext: config.systemContext,
      });
    } catch (preErr) {
      const preMsg = preErr instanceof Error ? preErr.message : String(preErr);
      const retry = await withSqliteRetry(
        () =>
          scheduleProviderRetry(
            config.providerName,
            activeRouteKey,
            Date.now(),
            topLevelInputId || activeTriggerInputId || undefined,
          ),
        { label: 'scheduleProviderRetry' },
      );
      log(
        JSON.stringify({
          severity: 'warn',
          event:
            retry.status === 'exhausted'
              ? 'pre_query_failure_retry_exhausted_recovery_owned'
              : 'pre_query_failure_returned_to_pending',
          route_key: activeRouteKey,
          message_ids: processingIds,
          error: preMsg,
          retry_attempt: retry.attempts,
          next_attempt_at: retry.nextAttemptAt ?? null,
        }),
      );
      // Store a route-scoped recovery entry so the next Yente turn has the
      // original-task context, then return the claimed rows to pending. The rows
      // are unaccepted (no provider input-accepted), so returning them to pending
      // is the correct lifecycle; recovery preserves the original-task context.
      const now = new Date().toISOString();
      if (retry.status === 'exhausted') {
        await ownExhaustedPreacceptRetry(
          activeRouteScope,
          processingIds.length > 0 ? processingIds : activeMessages.map((message) => message.id),
          originalTasks,
          preMsg,
        );
      } else {
        const recoveryEntry: ProviderRecoveryEntry = {
          id: recoveryIdFor(activeRouteScope.routeKey),
          status: 'pending',
          classification: 'pre_query_failure',
          agentMessage: 'A setup step failed before I started working; I will retry.',
          fallbackUserMessage: 'I hit a problem before starting your request and will retry it automatically.',
          originalTasks,
          acceptedUnresolvedInputs: [],
          pendingFollowups: [],
          priorProgress: [],
          observations: [`pre_query_failure: ${preMsg}`],
          sideEffects: [],
          continuationPolicy: 'preserve',
          createdAt: now,
          updatedAt: now,
        };
        await withSqliteRetry(() => appendRecoveryEntry(activeRouteScope, recoveryEntry), {
          label: 'appendRecoveryEntry',
        });
        await withSqliteRetry(() => returnProcessingToPending(processingIds, 'pre_query_failure'), {
          label: 'returnProcessingToPending',
        });
      }
      continue;
    }

    // Process the query while concurrently polling for new messages
    const replyAccounting = {
      initialRequiresUserVisibleReply: requiresUserVisibleReply(keep),
      initialUserTriggered: isUserTriggered(keep),
      outboundVisibleReplyCountBefore: await withSqliteRetry(
        () => countOutboundVisibleReplyMessages({ ...routing, routeKey: activeRouteScope.routeKey }),
        { label: 'countOutboundVisibleReplyMessages' },
      ),
    };
    try {
      if (!initialClaim) throw new Error('missing exact initial input claim');
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        replyAccounting,
        {
          topLevelInputId,
          initialClaim,
          acceptanceContext,
          activeRouteKey,
          activeRouteScope,
          originalTasks,
          resumableRecoveryIds: resumableRecovery.map((e) => e.id),
        },
        config.inspectAttachmentFile,
        config.signal,
        config,
      );
      if (result.clearContinuation) {
        // Authoritative clear (explicit provider clear-continuation, positive
        // existence not-found, or the bounded zombie path). Never on transport
        // text alone — that comes from the provider as a clear-continuation
        // event or a 'clear' continuationPolicy on a terminal interruption.
        continuation = undefined;
        clearContinuation(config.providerName, continuationScope);
      } else if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation, continuationScope);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // These failures mean accepted work may still be live or host-committed.
      // Leaving the process is intentional: host stop proof and recovery own
      // the correlation from here. Never release/retry inside this runner.
      if (err instanceof TrustedInputLifecycleError || err instanceof ProviderQuiescenceError) {
        if (
          err instanceof ProviderQuiescenceError &&
          initialClaim?.acceptanceObserved === false &&
          acceptanceContext.boundGwsInputs.size === 0
        ) {
          // Belt-and-braces: nothing was observed AND nothing was host-committed,
          // so this fatal exit must leave a durable, bounded retry schedule
          // behind for the next runner incarnation instead of an unbounded
          // crash loop on the route. acceptanceObserved alone is NOT a
          // host-commit discriminator (bind success sets state='accepted' +
          // boundGwsInputs.add without setting it — A11); retrying a
          // host-committed input from a fresh container is the duplicate-work
          // case, and its rows are already recovery-owned. Same discriminator
          // as processQuery's pre-accept unmask branch.
          await withSqliteRetry(
            () => scheduleProviderRetry(config.providerName, activeRouteKey, Date.now(), topLevelInputId),
            { label: 'scheduleProviderRetry' },
          );
          log(
            JSON.stringify({
              severity: 'warn',
              event: 'provider_quiescence_failure_preaccept_retry_persisted',
              route_key: activeRouteKey,
              error: errMsg,
            }),
          );
        }
        throw err;
      }

      if (err instanceof TrustedInputAcceptanceError) {
        log(
          JSON.stringify({
            severity: 'warn',
            event: 'trusted_input_acceptance_failed_returned_to_pending',
            route_key: activeRouteKey,
            message_ids: processingIds,
            error: errMsg,
          }),
        );
        // The row is intentionally retryable, but a missing/broken host IPC
        // channel must not turn that retry into a microtask-only busy loop.
        await sleep(POLL_INTERVAL_MS, config.signal);
        continue;
      }

      const failedBeforeAcceptance = initialClaim?.state === 'returned' && initialClaim.acceptanceObserved === false;
      if (failedBeforeAcceptance) {
        const retry = await withSqliteRetry(
          () => scheduleProviderRetry(config.providerName, activeRouteKey, Date.now(), topLevelInputId),
          { label: 'scheduleProviderRetry' },
        );
        log(
          JSON.stringify({
            severity: 'warn',
            event:
              retry.status === 'exhausted'
                ? 'provider_preaccept_failure_retry_exhausted_recovery_owned'
                : 'provider_preaccept_failure_scheduled',
            route_key: activeRouteKey,
            retry_attempt: retry.attempts,
            next_attempt_at: retry.nextAttemptAt ?? null,
            error: errMsg,
          }),
        );
        if (!retry.userErrorEmittedAt) {
          await withSqliteRetry(() => writeRoutedMessage(routing, `Error: ${sanitizeProviderErrorText(errMsg)}`), {
            label: 'writeRoutedMessage',
          });
          await withSqliteRetry(() => markProviderRetryUserErrorEmitted(config.providerName, activeRouteKey), {
            label: 'markProviderRetryUserErrorEmitted',
          });
        }
        if (retry.status === 'exhausted') {
          await ownExhaustedPreacceptRetry(activeRouteScope, processingIds, originalTasks, errMsg);
        }
        continue;
      }

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err, { attemptedContinuation: continuation })) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        await withSqliteRetry(() => clearContinuation(config.providerName, continuationScope), {
          label: 'clearContinuation',
        });
      }

      // Provider throw is a sanitized recoverable interruption. processQuery's
      // finally block has already chosen exactly one durable disposition:
      // accepted/submitted rows are recovery-owned; unsubmitted rows are back
      // to pending. Never overwrite either outcome with `completed` here.
      // User-facing text is sanitized + de-duped; the raw error stays in the
      // journal via the `Query error:` log line above.
      const priorSchedule = await withSqliteRetry(
        () => readProviderRetrySchedule(config.providerName, activeRouteKey),
        { label: 'readProviderRetrySchedule' },
      );
      if (
        !priorSchedule?.userErrorEmittedAt &&
        !priorUserErrorEmittedAt &&
        !userErrorEmittedRoutes.has(activeRouteKey)
      ) {
        await withSqliteRetry(
          () =>
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({ text: `Error: ${sanitizeProviderErrorText(errMsg)}` }),
            }),
          { label: 'writeMessageOut' },
        );
        userErrorEmittedRoutes.add(activeRouteKey);
        // Persists the guard when a retry schedule exists; no-ops otherwise
        // (the in-memory set covers the schedule-less case within this wake).
        await withSqliteRetry(() => markProviderRetryUserErrorEmitted(config.providerName, activeRouteKey), {
          label: 'markProviderRetryUserErrorEmitted',
        });
      }
    }
    log(`Completed wake for route ${activeRouteKey} (${ids.length} active row(s))`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (
        !HOST_OWNED_COMMANDS.has(cmdInfo.command) &&
        (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin')
      ) {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
  /** Authoritative clear request (provider clear-continuation / clear policy). */
  clearContinuation?: boolean;
}

interface ReplyAccounting {
  initialRequiresUserVisibleReply: boolean;
  /** True when the initial batch was triggered by a real user message (not system/a2a). */
  initialUserTriggered: boolean;
  outboundVisibleReplyCountBefore: number;
}

interface InputLedgerEntry {
  inputId: string;
  messageIds: string[];
  /** queued → accepted → resolved, or returned (unaccepted, sent back to pending). */
  state: 'queued' | 'accepted' | 'resolved' | 'returned' | 'recovery_owned';
  scope: 'initial' | 'followup';
  /** Prompt text for this input, used to seed recovery acceptedUnresolvedInputs. */
  prompt: string;
  requiresUserVisibleReply: boolean;
  outboundVisibleReplyCountBefore: number;
  claims: InputClaimBatch[];
}

interface InputClaimBatch {
  claimToken: string;
  messageIds: string[];
  prompt: string;
  scope: 'initial' | 'followup';
  state: 'queued' | 'binding' | 'accepted' | 'resolved' | 'returned' | 'recovery_owned';
  acceptanceObserved: boolean;
  /** Exact, memoized host-acceptance gate captured for this claim. */
  acceptInput: () => Promise<void>;
}

interface InputAcceptanceContext {
  tail: Promise<void>;
  boundGwsInputs: Set<string>;
  lifecycleFault: TrustedInputLifecycleError | null;
  bind: typeof bindHostGwsCorrelation;
  release: typeof releaseHostGwsCorrelation;
}

class TrustedInputAcceptanceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TrustedInputAcceptanceError';
  }
}

class TrustedInputLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TrustedInputLifecycleError';
  }
}

function createInputClaim(
  ctx: InputAcceptanceContext,
  opts: {
    inputId: string;
    routeKey: string;
    messageIds: string[];
    claimToken: string;
    prompt: string;
    scope: 'initial' | 'followup';
  },
): InputClaimBatch {
  let acceptance: Promise<void> | undefined;
  const claim: InputClaimBatch = {
    claimToken: opts.claimToken,
    messageIds: [...opts.messageIds],
    prompt: opts.prompt,
    scope: opts.scope,
    state: 'queued',
    acceptanceObserved: false,
    acceptInput: () => {
      if (acceptance) return acceptance;
      const operation = ctx.tail.then(async () => {
        if (claim.state !== 'queued') {
          if (claim.state === 'accepted') return;
          throw new TrustedInputAcceptanceError(`input claim cannot be accepted from state ${claim.state}`);
        }
        claim.state = 'binding';
        try {
          await ctx.bind(opts.inputId, opts.routeKey, claim.messageIds, claim.claimToken, claim.scope);
          ctx.boundGwsInputs.add(opts.inputId);
          claim.state = 'accepted';
          // Legacy agent-writable correlation remains for non-GWS tools only.
          writeActiveInput(opts.inputId, opts.routeKey);
        } catch (err) {
          if (err instanceof GwsCorrelationLifecycleFault) {
            // The host may have durably accepted this exact claim. Treat it as
            // accepted/recovery-owned, cancel the provider, and exit the runner;
            // returning it to pending could submit the same work twice.
            ctx.boundGwsInputs.add(opts.inputId);
            claim.state = 'accepted';
            claim.acceptanceObserved = true;
            ctx.lifecycleFault = new TrustedInputLifecycleError(
              `trusted host input acceptance became ambiguous for ${opts.inputId}`,
              { cause: err },
            );
            throw ctx.lifecycleFault;
          }
          claim.state = 'queued';
          throw new TrustedInputAcceptanceError(`trusted host input bind failed for ${opts.inputId}`, { cause: err });
        }
      });
      // A rejected bind must not poison later cleanup/retry bookkeeping.
      ctx.tail = operation.catch(() => undefined);
      acceptance = operation;
      return operation;
    },
  };
  return claim;
}

type ProviderStatusState = {
  inactivityStatusSent: boolean;
  terminalFallbackSent: boolean;
};

type ProviderStatusAction = { kind: 'write'; text: string } | { kind: 'log'; event: string } | { kind: 'none' };

export function decideProviderStatusAction(state: ProviderStatusState, event: ProviderEvent): ProviderStatusAction {
  if (event.type === 'notice' && event.classification === 'inactivity') {
    if (state.inactivityStatusSent) return { kind: 'log', event: 'inactivity_notice_suppressed' };
    state.inactivityStatusSent = true;
    return { kind: 'write', text: event.fallbackUserMessage };
  }
  if (event.type === 'interruption' && event.terminal) {
    if (state.terminalFallbackSent) return { kind: 'none' };
    state.terminalFallbackSent = true;
    return { kind: 'write', text: event.fallbackUserMessage };
  }
  return { kind: 'none' };
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  replyAccounting: ReplyAccounting,
  ledgerCtx: {
    topLevelInputId: string;
    initialClaim: InputClaimBatch;
    acceptanceContext: InputAcceptanceContext;
    activeRouteKey: string;
    activeRouteScope: ProviderRecoveryScope;
    originalTasks: ProviderRecoveryEntry['originalTasks'];
    /** Pending/in_flight recovery entry ids resumed by THIS top-level turn. */
    resumableRecoveryIds: string[];
  },
  inspectAttachmentFile?: (filePath: string) => Promise<InspectedFile | null>,
  signal?: AbortSignal,
  config?: PollLoopConfig,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let clearContinuationRequested = false;
  let zombieFailureCleared = false;
  let done = false;
  let userStopRequested = false;
  let initialBatchSettled = false;
  let abortPromise: Promise<void> | null = null;
  const abortQuery = (): void => {
    if (abortPromise) return;
    abortPromise = query.abort();
  };

  // Stamp the authoritative active route metadata onto the routing context so
  // EVERY route-bearing outbound row this turn writes (result text, relay status,
  // inactivity fallback) carries `route_key`/`messaging_group_id`/`is_group`.
  // This is what makes the agent's own user-visible progress harvestable into
  // route-scoped recovery (harvestRouteScopedProgress filters on route_key).
  stampRoutingScope(routing, ledgerCtx.activeRouteScope);

  const providerStatusState: ProviderStatusState = {
    inactivityStatusSent: false,
    terminalFallbackSent: false,
  };
  let unwrappedOutputNudged = false;
  let pendingUnwrappedOutputText: string | null = null;
  // Whether ANY input this turn (initial batch or a pushed follow-up) came from
  // a real user message. Gates user-visible fallback/interruption notices.
  let turnUserTriggered = replyAccounting.initialUserTriggered;
  // Side-effect evidence carried on a terminal interruption's recovery seed, so
  // the accepted-unresolved recovery entry records what already happened.
  const interruptionSideEffects: ProviderRecoveryEntry['sideEffects'] = [];

  // Input ledger: every prompt the poll loop sends is tracked by inputId. A
  // prompt is `accepted` only after the provider emits input-accepted for it,
  // and `resolved` only after a successful result resolves/supersedes it.
  const ledger = new Map<string, InputLedgerEntry>();
  const boundGwsInputs = ledgerCtx.acceptanceContext.boundGwsInputs;
  ledger.set(ledgerCtx.topLevelInputId, {
    inputId: ledgerCtx.topLevelInputId,
    messageIds: [...initialBatchIds],
    state: 'queued',
    scope: 'initial',
    prompt: ledgerCtx.originalTasks.map((t) => t.text).join('\n') || '(initial turn)',
    requiresUserVisibleReply: replyAccounting.initialRequiresUserVisibleReply,
    outboundVisibleReplyCountBefore: replyAccounting.outboundVisibleReplyCountBefore,
    claims: [ledgerCtx.initialClaim],
  });

  if (signal?.aborted) {
    abortQuery();
  } else {
    signal?.addEventListener('abort', abortQuery, { once: true });
  }

  function onInputAccepted(inputId: string, scope: 'initial' | 'followup'): void {
    const entry = ledger.get(inputId);
    if (!entry) throw new Error(`provider accepted unknown input ${inputId}`);
    const claim = entry.claims.find(
      (candidate) => candidate.state === 'accepted' && !candidate.acceptanceObserved && candidate.scope === scope,
    );
    if (!claim) {
      // A retry/nudge may reuse an already-accepted exact gate. Providers that
      // echo another observational event for that reused gate do not mutate or
      // advance host acceptance a second time.
      if (entry.claims.some((candidate) => candidate.state === 'accepted' && candidate.acceptanceObserved)) return;
      throw new Error(`provider acceptance event preceded trusted bind for ${inputId}`);
    }
    claim.acceptanceObserved = true;
    entry.state = 'accepted';
    clearProviderRetrySchedule(providerName, ledgerCtx.activeRouteKey);
    // Resuming a prior interrupted turn: mark its recovery entries in_flight for
    // THIS top-level input. They are NOT consumed yet (mere acceptance never
    // resolves recovery — Invariant 140); resolution happens only on success.
    if (inputId === ledgerCtx.topLevelInputId) {
      for (const recId of ledgerCtx.resumableRecoveryIds) {
        markRecoveryInFlight(ledgerCtx.activeRouteScope, recId, inputId);
      }
    }
  }

  /**
   * Resolve a result to exact input ids. If the provider declared
   * resolvedInputIds, use them. Otherwise apply the one-active-input rule:
   * resolve only when exactly one active (unresolved) input exists — the result
   * is unambiguous proof that single input was processed. Two active inputs
   * with no explicit ids is a recoverable implementation error that does NOT
   * complete rows (ambiguous success must never complete the wrong row).
   */
  function resolveResult(declared: string[]): string[] {
    if (declared.length > 0) return declared;
    const active = [...ledger.values()].filter((e) => e.state === 'queued' || e.state === 'accepted');
    if (active.length === 1) return [active[0].inputId];
    if (active.length > 1) {
      log(
        JSON.stringify({
          severity: 'error',
          event: 'ambiguous_result_resolution',
          active_inputs: active.map((e) => e.inputId),
        }),
      );
    }
    return [];
  }

  function completeResolved(inputIds: string[]): void {
    const idsToComplete: string[] = [];
    let topLevelResolved = false;
    for (const inputId of inputIds) {
      if (inputId === ledgerCtx.topLevelInputId) topLevelResolved = true;
      const entry = ledger.get(inputId);
      if (!entry || entry.state === 'resolved') continue;
      const acceptedClaims = entry.claims.filter((claim) => claim.state === 'accepted' && claim.acceptanceObserved);
      if (acceptedClaims.length === 0) continue;
      for (const claim of acceptedClaims) {
        claim.state = 'resolved';
        idsToComplete.push(...claim.messageIds);
      }
      entry.state = entry.claims.every((claim) => claim.state === 'resolved') ? 'resolved' : 'queued';
    }
    // A successful result that resolves the top-level input also resolves the
    // recovery entries this turn resumed (and completes their owned recovery rows).
    // Recovery is consumed ONLY on success, never on mere acceptance (Inv. 140).
    // The resuming turn supersedes the entry's own accepted-unresolved inputs, so
    // we resolve against THOSE owned input ids (not the new top-level id).
    if (topLevelResolved) completeResumedRecoveryEntries();
    if (idsToComplete.length > 0) markCompleted(idsToComplete);
  }

  function completeResumedRecoveryEntries(): void {
    if (ledgerCtx.resumableRecoveryIds.length === 0) return;
    const entries = listRecoveryEntries(ledgerCtx.activeRouteScope);
    for (const recId of ledgerCtx.resumableRecoveryIds) {
      const ownedInputIds = (entries.find((e) => e.id === recId)?.acceptedUnresolvedInputs ?? []).map((a) => a.inputId);
      const res = resolveRecoveryEntry(ledgerCtx.activeRouteScope, recId, { resolvedInputIds: ownedInputIds });
      if (res.resolvedMessageIds.length > 0) markRecoveryCompleted(res.resolvedMessageIds, recId);
    }
  }

  function hasMissingVisibleReply(inputIds: string[]): boolean {
    const outboundVisibleReplyCountAfter = countOutboundVisibleReplyMessages(routing);
    return inputIds.some((inputId) => {
      const entry = ledger.get(inputId);
      return Boolean(
        entry?.requiresUserVisibleReply && outboundVisibleReplyCountAfter <= entry.outboundVisibleReplyCountBefore,
      );
    });
  }

  function settleInitialBatch(topLevelResolved: boolean, providerErrorText: string | null = null): void {
    if (initialBatchSettled) return;
    if (!topLevelResolved) return;
    initialBatchSettled = true;

    if (hasMissingVisibleReply([ledgerCtx.topLevelInputId])) {
      writeMissingVisibleReplyError(routing, providerErrorText, replyAccounting.initialUserTriggered);
    }
  }

  // Concurrent polling: push route-matched follow-ups into the active query as
  // they arrive. Other-route rows are NOT claimed here — they stay pending and
  // are handled on their own wake (route splitting). We keep the query open
  // rather than close+reopen (no cold prompt cache, no reconnect).
  let pollingFollowups = false;
  const pollHandle = setInterval(() => {
    if (done || pollingFollowups) return;
    pollingFollowups = true;
    void pollFollowups()
      .catch((err) => {
        // A rejected voided promise is an unhandled rejection (process-fatal
        // under Bun's default). withSqliteRetry has already retried busy
        // errors, so anything landing here is exhausted/unexpected: log a
        // structured event instead of silently killing follow-up claiming.
        log(
          JSON.stringify({
            severity: 'error',
            event: 'poll_followups_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      })
      .finally(() => {
        pollingFollowups = false;
      });
  }, ACTIVE_POLL_INTERVAL_MS);

  async function pollFollowups(): Promise<void> {
    // Only claim follow-ups on the ACTIVE route. Rows on other routes remain
    // pending and are excluded from this turn (route splitting also applies to
    // follow-ups, not just the initial batch).
    const candidates = (await withSqliteRetry(() => getPendingMessages(), { label: 'getPendingMessages' })).filter(
      (m) => m.kind !== 'system',
    );
    const routeMessages = candidates.filter((m) => routeKeyForMessage(providerName, m) === ledgerCtx.activeRouteKey);
    const stopMessages = routeMessages.filter(isStopControlMessage);
    if (stopMessages.length > 0) {
      const stopIds = stopMessages.map((m) => m.id);
      const sameRouteIds = routeMessages.map((m) => m.id);
      await withSqliteRetry(() => markProcessing(sameRouteIds), { label: 'markProcessing' });
      await withSqliteRetry(() => markCompleted(sameRouteIds), { label: 'markCompleted' });
      if (!userStopRequested) {
        userStopRequested = true;
        await withSqliteRetry(() => writeRoutedMessage(routing, STOP_ACTIVE_ACK), { label: 'writeRoutedMessage' });
        log(
          JSON.stringify({
            severity: 'info',
            event: 'active_stop_requested',
            route_key: ledgerCtx.activeRouteKey,
            message_ids: stopIds,
            completed_same_route_message_ids: sameRouteIds,
          }),
        );
        abortQuery();
      }
      return;
    }
    const newMessages = routeMessages;
    if (newMessages.length === 0) return;

    const newIds = newMessages.map((m) => m.id);
    const followupTrigger = newMessages.filter((message) => message.trigger === 1).at(-1);
    let followupInputId: string;
    let entry: InputLedgerEntry;
    if (followupTrigger) {
      if (
        !followupTrigger.host_input_id ||
        followupTrigger.host_route_key !== ledgerCtx.activeRouteKey ||
        typeof followupTrigger.host_received_at !== 'string' ||
        !Number.isFinite(Date.parse(followupTrigger.host_received_at))
      ) {
        log(
          JSON.stringify({
            severity: 'warn',
            event: 'followup_missing_host_backed_trigger',
            route_key: ledgerCtx.activeRouteKey,
            message_ids: newIds,
          }),
        );
        return;
      }
      followupInputId = followupTrigger.host_input_id;
      if (ledger.has(followupInputId)) {
        log(JSON.stringify({ severity: 'warn', event: 'duplicate_host_input_id', input_id: followupInputId }));
        return;
      }
      entry = {
        inputId: followupInputId,
        messageIds: [],
        state: 'queued',
        scope: 'followup',
        prompt: '',
        requiresUserVisibleReply: requiresUserVisibleReply(newMessages),
        outboundVisibleReplyCountBefore: await withSqliteRetry(() => countOutboundVisibleReplyMessages(routing), {
          label: 'countOutboundVisibleReplyMessages',
        }),
        claims: [],
      };
    } else {
      // Accumulated context can only extend an input the provider already
      // accepted; it never receives a synthetic/random correlation id.
      const acceptedEntries = [...ledger.values()].filter((candidate) =>
        candidate.claims.some((claim) => claim.state === 'accepted'),
      );
      entry = acceptedEntries.at(-1)!;
      if (!entry) return;
      followupInputId = entry.inputId;
    }
    const outboundVisibleReplyCountBefore = await withSqliteRetry(() => countOutboundVisibleReplyMessages(routing), {
      label: 'countOutboundVisibleReplyMessages',
    });

    const prompt = formatMessages(newMessages);
    const attachments = await collectQueryAttachments({
      messages: newMessages,
      pathReferenceMessages: newMessages,
      inspectFile: inspectAttachmentFile,
      log: logAttachmentEvent,
    });
    const followupDestination = findByRouting(routing.channelType, routing.platformId);
    const claimToken = randomUUID();
    const claim = createInputClaim(ledgerCtx.acceptanceContext, {
      inputId: followupInputId,
      routeKey: ledgerCtx.activeRouteKey,
      messageIds: newIds,
      claimToken,
      prompt,
      scope: 'followup',
    });
    await withSqliteRetry(() => markProcessing(newIds, claimToken), { label: 'markProcessing' });
    entry.claims.push(claim);
    entry.messageIds.push(...newIds);
    entry.prompt = [entry.prompt, newMessages.map(textOfMessage).join('\n')].filter(Boolean).join('\n');
    if (!ledger.has(followupInputId)) ledger.set(followupInputId, entry);

    log(`Pushing ${newMessages.length} follow-up message(s) into active query (input ${followupInputId})`);
    try {
      unwrappedOutputNudged = false;
      pendingUnwrappedOutputText = null;
      query.push({
        inputId: followupInputId,
        acceptInput: claim.acceptInput,
        prompt,
        attachments,
        messages: newMessages,
        visibleDestinationName: followupDestination?.name,
      });
    } catch (err) {
      log(
        JSON.stringify({
          severity: 'error',
          event: 'followup_enqueue_failed',
          message_count: newMessages.length,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      entry.claims = entry.claims.filter((candidate) => candidate !== claim);
      entry.messageIds = entry.messageIds.filter((id) => !newIds.includes(id));
      if (entry.claims.length === 0) ledger.delete(followupInputId);
      await withSqliteRetry(() => returnProcessingToPending(newIds, 'followup_enqueue_failed'), {
        label: 'returnProcessingToPending',
      });
      return;
    }
    entry.requiresUserVisibleReply ||= requiresUserVisibleReply(newMessages);
    entry.outboundVisibleReplyCountBefore = Math.min(
      entry.outboundVisibleReplyCountBefore,
      outboundVisibleReplyCountBefore,
    );
    if (isUserTriggered(newMessages)) turnUserTriggered = true;
  }

  let topLevelResolvedAtLeastOnce = false;
  let providerStreamFailure: unknown;
  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation.
        setContinuation(providerName, event.continuation, config?.provider.continuationScope);
      } else if (event.type === 'input-accepted') {
        if (event.scope === 'initial' || event.scope === 'followup') onInputAccepted(event.inputId, event.scope);
      } else if (event.type === 'notice') {
        if (userStopRequested) {
          log(
            JSON.stringify({
              severity: 'info',
              event: 'user_stop_provider_notice_suppressed',
              input_id: event.inputId,
              classification: event.classification,
              route_key: ledgerCtx.activeRouteKey,
            }),
          );
          continue;
        }
        const action = decideProviderStatusAction(providerStatusState, event);
        if (action.kind === 'write') {
          writeRoutedMessage(routing, action.text);
        } else if (action.kind === 'log') {
          log(
            JSON.stringify({
              severity: 'info',
              event: action.event,
              input_id: event.inputId,
              route_key: ledgerCtx.activeRouteKey,
            }),
          );
        }
      } else if (event.type === 'clear-continuation') {
        // Authoritative continuation clear from the provider (explicit clear /
        // positive existence not-found / bounded zombie path).
        clearContinuationRequested = true;
        queryContinuation = undefined;
      } else if (event.type === 'interruption') {
        if (userStopRequested) {
          log(
            JSON.stringify({
              severity: 'info',
              event: 'user_stop_provider_interruption_suppressed',
              input_id: event.inputId,
              classification: event.classification,
              route_key: ledgerCtx.activeRouteKey,
            }),
          );
          continue;
        }
        // Typed terminal recoverable interruption (Invariant 159). The accepted-
        // but-unresolved rows are routed into recovery ownership by the
        // finally-block via the existing seam. Here we only honor the
        // continuation policy: a 'clear' policy is an authoritative clear.
        if (event.continuationPolicy === 'clear') {
          clearContinuationRequested = true;
          queryContinuation = undefined;
        } else if (event.continuationPolicy === 'preserve' && (event.attemptedContinuation ?? queryContinuation)) {
          // Bounded zombie backstop (Hard Invariant 152): count CONSECUTIVE
          // preserve-continuation terminal interruptions on the SAME
          // continuation. At the limit, the continuation is treated as a zombie,
          // cleared, and the next turn restarts from recovery with user-visible
          // context — so a dead session that only emits bare 404s is not
          // preserved forever. A successful result resets the counter.
          const cont = (event.attemptedContinuation ?? queryContinuation) as string;
          const failures = readZombieCounter(providerName, cont, config?.provider.continuationScope) + 1;
          const decision = zombieDecision({
            continuation: cont,
            consecutiveTerminalFailures: failures,
            limit: OPENCODE_CONTINUATION_FAILURE_LIMIT,
          });
          if (decision.clear) {
            clearContinuationRequested = true;
            queryContinuation = undefined;
            zombieFailureCleared = decision.userVisibleRestart;
            resetZombieCounter(providerName, cont, config?.provider.continuationScope);
            log(
              JSON.stringify({
                severity: 'warn',
                event: 'continuation_zombie_cleared',
                provider: providerName,
                consecutive_terminal_failures: failures,
              }),
            );
          } else {
            writeZombieCounter(providerName, cont, failures, config?.provider.continuationScope);
          }
        }
        // Seed the recovery payload with any provider-collected side effects so
        // the next Yente turn can report existing work rather than duplicate it.
        if (event.recoverySeed?.sideEffects && event.recoverySeed.sideEffects.length > 0) {
          interruptionSideEffects.push(...event.recoverySeed.sideEffects);
        }
        const action = decideProviderStatusAction(providerStatusState, event);
        if (action.kind === 'write') {
          if (turnUserTriggered) {
            writeRoutedMessage(routing, action.text);
          } else {
            // Same rule as the missing-visible-reply fallback: interruption
            // notices are log-only unless a real user triggered this turn.
            log(
              JSON.stringify({
                severity: 'warn',
                event: 'interruption_notice_suppressed_non_user_turn',
                input_id: event.inputId,
                classification: event.classification,
                route_key: ledgerCtx.activeRouteKey,
              }),
            );
          }
        }
      } else if (event.type === 'result') {
        if (userStopRequested) {
          const resolved = resolveResult(event.resolvedInputIds ?? []);
          if (resolved.length > 0) completeResolved(resolved);
          log(
            JSON.stringify({
              severity: 'info',
              event: 'user_stop_provider_result_suppressed',
              route_key: ledgerCtx.activeRouteKey,
              resolved_input_ids: resolved,
            }),
          );
          continue;
        }
        const currentResultErrorText = !event.text ? (event.errorText ?? null) : null;
        // A result — with or without text — means a turn segment is done.
        // Resolve exact input ids first without mutating the ledger, then dispatch
        // text so reply accounting sees direct result text and MCP send_message
        // rows before deciding whether this input still needs recovery.
        const resolved = resolveResult(event.resolvedInputIds ?? []);
        const dispatch = event.text ? dispatchResultText(event.text, routing) : { sent: 0, hasUnwrapped: false };
        const stillMissingVisibleReply = hasMissingVisibleReply(resolved);
        if (event.text) {
          if (
            dispatch.hasUnwrapped &&
            dispatch.sent === 0 &&
            resolved.length === 1 &&
            !unwrappedOutputNudged &&
            stillMissingVisibleReply
          ) {
            unwrappedOutputNudged = true;
            pendingUnwrappedOutputText = event.text;
            const resolvedEntry = ledger.get(resolved[0]);
            const acceptedClaim = resolvedEntry?.claims.find((claim) => claim.state === 'accepted');
            if (!acceptedClaim) throw new Error(`cannot nudge unresolved input without accepted claim ${resolved[0]}`);
            query.push({
              inputId: resolved[0],
              acceptInput: acceptedClaim.acceptInput,
              prompt: buildUnwrappedOutputNudge(routing, event.text),
            });
            continue;
          }
        }
        if (
          unwrappedOutputNudged &&
          dispatch.sent === 0 &&
          resolved.length === 1 &&
          pendingUnwrappedOutputText &&
          stillMissingVisibleReply
        ) {
          log(
            JSON.stringify({
              severity: 'warn',
              event: 'unwrapped_output_nudge_ignored_delivering_original',
              route_key: routing.routeKey ?? null,
            }),
          );
          writeRoutedMessage(routing, pendingUnwrappedOutputText);
          pendingUnwrappedOutputText = null;
        }
        if (resolved.length > 0) {
          completeResolved(resolved);
          if (resolved.includes(ledgerCtx.topLevelInputId)) {
            topLevelResolvedAtLeastOnce = true;
          }
        }
        // A successful result on this continuation resets the zombie backstop —
        // the session proved live.
        if (queryContinuation) resetZombieCounter(providerName, queryContinuation, config?.provider.continuationScope);
        settleInitialBatch(resolved.includes(ledgerCtx.topLevelInputId), currentResultErrorText);
      }
    }

    // Stream ended. Settle reply accounting for the initial batch.
    settleInitialBatch(topLevelResolvedAtLeastOnce, null);
  } catch (err) {
    providerStreamFailure = err;
    // A stream throw is itself a terminal provider boundary. Always drive the
    // provider's abort/quiescence path and await it below before releasing any
    // trusted correlation, even when the original stream error was untyped.
    // A clean-completion container-stop handoff already waited for observable
    // SDK/tool callbacks. Calling abort would replace that intentional outcome
    // with a generic cancellation failure; retain it for the host-stop path.
    if (!(err instanceof ProviderContainerStopRequired)) abortQuery();
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    signal?.removeEventListener('abort', abortQuery);

    // Once host acceptance is ambiguous the provider must stop immediately.
    // The claim remains accepted/recovery-owned because retrying it could
    // duplicate model or tool work that began after the host commit.
    if (ledgerCtx.acceptanceContext.lifecycleFault) abortQuery();

    // Terminal handling for un-resolved ledger entries. User-requested stop is a
    // discard/complete path; ordinary terminal interruptions keep the existing
    // retry/recovery split (Invariants 160/161/162).
    const acceptedUnresolved = [...ledger.values()].filter((entry) =>
      entry.claims.some((claim) => claim.state === 'accepted' && claim.acceptanceObserved),
    );
    if (userStopRequested) {
      const idsToComplete: string[] = [];
      for (const entry of ledger.values()) {
        for (const claim of entry.claims) {
          if (claim.state !== 'queued' && claim.state !== 'accepted') continue;
          idsToComplete.push(...claim.messageIds);
          claim.state = 'resolved';
        }
        entry.state = 'resolved';
      }
      markCompleted(idsToComplete);
      completeResumedRecoveryEntries();
      if (idsToComplete.length > 0) {
        log(
          JSON.stringify({
            severity: 'info',
            event: 'user_stop_completed_unresolved_inputs',
            route_key: ledgerCtx.activeRouteKey,
            message_ids: idsToComplete,
          }),
        );
      }
    } else if (acceptedUnresolved.length > 0) {
      const scope = ledgerCtx.activeRouteScope;
      const now = new Date().toISOString();
      // Harvest route-scoped progress / MCP send_message rows written during the
      // accepted-input window — ONLY for the active route, so a shared session's
      // other conversation can never leak in (Invariants 167; A2).
      const priorProgress = harvestRouteScopedProgress(scope.routeKey).map((p) => ({
        messageOutId: p.messageOutId,
        text: p.text,
        source: p.source,
        timestamp: p.timestamp,
      }));
      const recoveryId = recoveryIdFor(scope.routeKey);
      const ownedIds: string[] = [];
      const acceptedUnresolvedInputs = acceptedUnresolved.map((e) => {
        const acceptedClaims = e.claims.filter((claim) => claim.state === 'accepted' && claim.acceptanceObserved);
        const acceptedMessageIds = acceptedClaims.flatMap((claim) => claim.messageIds);
        ownedIds.push(...acceptedMessageIds);
        return {
          inputId: e.inputId,
          messageIds: acceptedMessageIds,
          prompt: acceptedClaims.map((claim) => claim.prompt).join('\n'),
        };
      });
      const entry: ProviderRecoveryEntry = {
        id: recoveryId,
        status: 'pending',
        classification: ledgerCtx.acceptanceContext.lifecycleFault
          ? 'trusted_acceptance_ambiguous'
          : zombieFailureCleared
            ? 'continuation_zombie_restart'
            : 'terminal_interruption_accepted_unresolved',
        agentMessage: ledgerCtx.acceptanceContext.lifecycleFault
          ? 'The trusted host accepted this input, but the runner lost the acceptance response. Resume only through recovery.'
          : zombieFailureCleared
            ? 'The previous session became unusable after repeated failures; I am restarting this work from scratch.'
            : 'I was interrupted mid-turn and will resume this work.',
        fallbackUserMessage: ledgerCtx.acceptanceContext.lifecycleFault
          ? 'I lost contact with the runtime after accepting your request. I still have it safely recorded — no need to resend.'
          : zombieFailureCleared
            ? 'I had to restart your request after the session repeatedly failed — I still have it and am retrying from scratch.'
            : 'Something interrupted me while I was working on your request. I still have it queued — no need to resend.',
        // Ordered same-route wake-triggering rows (A3, Invariant 166).
        originalTasks: ledgerCtx.originalTasks,
        acceptedUnresolvedInputs,
        pendingFollowups: [],
        priorProgress,
        observations: [],
        // Provider-collected side-effect evidence (Step 7) so the next Yente
        // turn reports existing work rather than duplicating it.
        sideEffects: [...interruptionSideEffects],
        continuationPolicy: clearContinuationRequested ? 'clear' : 'preserve',
        attemptedContinuation: queryContinuation,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const res = appendRecoveryEntryAndOwnRows(scope, entry, ownedIds, { recoveryId });
        if (res.pressureExceeded) {
          // Fail closed: don't complete or lose the rows. Write one user-visible
          // fallback and leave the rows claimed (recovery pressure is structurally
          // alerted; host sweep is the backstop).
          writeMissingVisibleReplyError(routing, null, turnUserTriggered);
        } else {
          for (const e of acceptedUnresolved) {
            for (const claim of e.claims) {
              if (claim.state === 'accepted' && claim.acceptanceObserved) claim.state = 'recovery_owned';
            }
            e.state = e.claims.some((claim) => claim.state === 'queued') ? 'queued' : 'recovery_owned';
          }
        }
      } catch (recErr) {
        // Atomic transaction rolled back (no partial state). Surface a structured
        // alert; the rows remain in 'processing' and stay retryable.
        log(
          JSON.stringify({
            severity: 'error',
            event: 'recovery_ownership_failed',
            route_key: scope.routeKey,
            recovery_id: recoveryId,
            error: recErr instanceof Error ? recErr.message : String(recErr),
          }),
        );
      }
    }

    for (const entry of ledger.values()) {
      const queuedClaims = entry.claims.filter(
        (claim) => claim.state === 'queued' || (claim.state === 'accepted' && !claim.acceptanceObserved),
      );
      if (queuedClaims.length > 0) {
        // Never accepted by the provider before the turn ended → return to
        // pending so a later wake retries them (route-matched and other-route
        // rows alike are returned to pending; other-route rows were never
        // claimed here).
        for (const claim of queuedClaims) {
          returnProcessingToPending(claim.messageIds, 'unaccepted_at_terminal');
          claim.state = 'returned';
        }
        if (entry.claims.every((claim) => claim.state === 'returned')) entry.state = 'returned';
      }
    }

    // Correlation can only be released after provider-controlled work has
    // definitely quiesced. Aborts are asynchronous because SDK callbacks,
    // tool hooks, and child processes may outlive signal dispatch. A failed
    // quiescence proof is fatal and deliberately leaves every bound input for
    // host stop/recovery instead of revoking its last trustworthy owner.
    let quiescenceFailure: unknown =
      providerStreamFailure instanceof ProviderQuiescenceError ? providerStreamFailure : null;
    if (abortPromise) {
      try {
        await abortPromise;
      } catch (err) {
        quiescenceFailure = err;
      }
    }
    if (ledgerCtx.acceptanceContext.lifecycleFault) {
      throw ledgerCtx.acceptanceContext.lifecycleFault;
    }
    if (quiescenceFailure) {
      // PRE-ACCEPT UNMASK (companion to the provider-level unmask): when a
      // non-quiescence body error is in flight and NOTHING was host-committed
      // for this query, the abort-await's rejection must not replace it — the
      // outer catch's designed pre-accept routing (TrustedInputAcceptanceError
      // → return-to-pending + poll backoff; other pre-accept errors → durable
      // retry schedule) is the correct disposition. boundGwsInputs is the
      // host-commit discriminator: entries are added on bind success and
      // lifecycle fault and removed only by successful release —
      // acceptanceObserved is NOT reliable here (bind success does not set it).
      // The rows were already returned to pending above and STAY pending: no
      // provider_quiescence_unproven recovery entry for this case. Accepted
      // work keeps the fatal path below — that protection is intentional.
      const bodyErrorInFlight =
        providerStreamFailure !== undefined && !(providerStreamFailure instanceof ProviderQuiescenceError);
      if (bodyErrorInFlight && boundGwsInputs.size === 0) {
        const failure =
          quiescenceFailure instanceof ProviderQuiescenceError
            ? quiescenceFailure
            : new ProviderQuiescenceError('provider did not prove quiescence before correlation release', {
                cause: quiescenceFailure,
              });
        if (providerStreamFailure instanceof Error && providerStreamFailure.cause === undefined) {
          (providerStreamFailure as Error & { cause?: unknown }).cause = failure;
        } else if (providerStreamFailure instanceof Error) {
          (providerStreamFailure as Error & { quiescenceFailure?: unknown }).quiescenceFailure = failure;
        }
        log(
          JSON.stringify({
            severity: 'warn',
            event: 'preaccept_body_error_kept_over_quiescence_failure',
            error:
              providerStreamFailure instanceof Error ? providerStreamFailure.message : String(providerStreamFailure),
            quiescence_error: failure.message,
          }),
        );
        // Rethrow the ORIGINAL body error: throwing from this finally replaces
        // the in-flight copy with the same object — identity preserved, so the
        // outer catch's instanceof routing works (Tasks 4/5 contract).
        throw providerStreamFailure;
      }
      const uncertainEntries = [...ledger.values()].filter((entry) =>
        entry.claims.some((claim) => claim.state === 'returned' || claim.state === 'queued'),
      );
      const uncertainMessageIds = uncertainEntries.flatMap((entry) =>
        entry.claims
          .filter((claim) => claim.state === 'returned' || claim.state === 'queued')
          .flatMap((claim) => claim.messageIds),
      );
      if (uncertainMessageIds.length > 0) {
        const now = new Date().toISOString();
        const recoveryId = recoveryIdFor(ledgerCtx.activeRouteScope.routeKey);
        appendRecoveryEntryAndOwnRows(
          ledgerCtx.activeRouteScope,
          {
            id: recoveryId,
            status: 'pending',
            classification: 'provider_quiescence_unproven',
            agentMessage: 'The provider stream failed and shutdown could not be proven; resume only through recovery.',
            fallbackUserMessage:
              'I lost contact with the provider while stopping safely. Your request is saved for recovery.',
            originalTasks: ledgerCtx.originalTasks,
            acceptedUnresolvedInputs: [],
            pendingFollowups: [],
            priorProgress: [],
            observations: [
              `provider_quiescence_unproven: ${
                quiescenceFailure instanceof Error ? quiescenceFailure.message : String(quiescenceFailure)
              }`,
            ],
            sideEffects: [],
            continuationPolicy: 'preserve',
            attemptedContinuation: queryContinuation,
            createdAt: now,
            updatedAt: now,
          },
          uncertainMessageIds,
          { recoveryId },
        );
      }
      if (quiescenceFailure instanceof ProviderQuiescenceError) throw quiescenceFailure;
      throw new ProviderQuiescenceError('provider did not prove quiescence before correlation release', {
        cause: quiescenceFailure,
      });
    }

    for (const inputId of boundGwsInputs) {
      try {
        await ledgerCtx.acceptanceContext.release(inputId);
        boundGwsInputs.delete(inputId);
      } catch (err) {
        log(
          JSON.stringify({
            severity: 'error',
            event: 'gws_correlation_release_failed',
            input_id: inputId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        throw new TrustedInputLifecycleError(`trusted host input release failed for ${inputId}`, { cause: err });
      }
    }
  }

  return { continuation: queryContinuation, clearContinuation: clearContinuationRequested };
}

function requiresUserVisibleReply(messages: MessageInRow[]): boolean {
  return messages.some((m) => (m.kind === 'chat' || m.kind === 'chat-sdk') && m.trigger === 1);
}

/**
 * True when the batch contains a wake trigger authored by a real user.
 * System/scheduled notifications (`sys-*` rows) and agent-to-agent rows
 * (`a2a-*`) are written by the host with `channel_type='agent'`, so any
 * trigger=1 chat row on a non-'agent' channel is the user-triggered signal.
 * Reply-accounting fallback errors and interruption notices are user-visible
 * ONLY for user-triggered turns; non-user turns log host-visibly instead.
 */
function isUserTriggered(messages: MessageInRow[]): boolean {
  return messages.some(
    (m) => (m.kind === 'chat' || m.kind === 'chat-sdk') && m.trigger === 1 && m.channel_type !== 'agent',
  );
}

function countOutboundVisibleReplyMessages(routing: RoutingContext): number {
  const row = getOutboundDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM messages_out
       WHERE kind <> 'system'
         AND (
           CASE
             WHEN json_valid(content) THEN json_extract(content, '$.operation') IS NULL
             ELSE 1
           END
         )
         AND (
           ($route_key IS NOT NULL AND route_key = $route_key)
           OR (
             route_key IS NULL
             AND (channel_type = $channel_type OR (channel_type IS NULL AND $channel_type IS NULL))
             AND (platform_id = $platform_id OR (platform_id IS NULL AND $platform_id IS NULL))
             AND (thread_id = $thread_id OR (thread_id IS NULL AND $thread_id IS NULL))
           )
         )`,
    )
    .get({
      $route_key: routing.routeKey ?? null,
      $channel_type: routing.channelType ?? null,
      $platform_id: routing.platformId ?? null,
      $thread_id: routing.threadId ?? null,
    }) as {
    count: number;
  };
  return row.count;
}

const PROVIDER_ERROR_MAX_LEN = 500;
/**
 * Defense-in-depth for surfacing provider error text to a user channel: strip
 * control chars, redact secret-shaped substrings (API keys, bearer tokens,
 * OneCLI gateway `aoc_` proxy tokens, token-bearing query params), and cap
 * length. Usage-limit / quota text passes through unchanged.
 */
function sanitizeProviderErrorText(raw: string): string {
  let s = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\baoc_[A-Za-z0-9]{16,}/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|api[_-]?key|secret|password|sig|access_token)=)[^\s&]+/gi, '$1[redacted]');
  return s.length > PROVIDER_ERROR_MAX_LEN ? s.slice(0, PROVIDER_ERROR_MAX_LEN - 1) + '\u2026' : s;
}

function writeMissingVisibleReplyError(
  routing: RoutingContext,
  providerErrorText?: string | null,
  userTriggered = true,
): void {
  // Non-user-triggered turns (system/scheduled `sys-*`, agent-to-agent `a2a-*`)
  // never surface the fallback error into the channel: the reply-accounting
  // scope is keyed to the TRIGGERING row's route, so the agent's real in-thread
  // reply legitimately lands elsewhere. Same for 'agent' routes: the fallback
  // error text is user-channel only, never enqueued to a2a destinations.
  if (!userTriggered || routing.channelType === 'agent') {
    log(
      JSON.stringify({
        severity: 'error',
        event: 'missing_visible_reply_suppressed',
        reason: !userTriggered ? 'non_user_triggered_turn' : 'a2a_destination',
        route_key: routing.routeKey ?? null,
        channel_type: routing.channelType ?? null,
        provider_error: providerErrorText ? sanitizeProviderErrorText(providerErrorText) : null,
      }),
    );
    return;
  }
  const verbatim = providerErrorText?.trim();
  if (verbatim) {
    writeRoutedMessage(routing, sanitizeProviderErrorText(verbatim));
    log(
      JSON.stringify({
        severity: 'info',
        event: 'provider_error_surfaced_verbatim',
        route_key: routing.routeKey ?? null,
      }),
    );
    return;
  }
  writeRoutedMessage(routing, 'Error: agent completed without sending a user-visible response in this conversation.');
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'input-accepted':
      log(`Input accepted: ${event.inputId} (${event.scope})`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'notice':
      // Non-terminal liveness/quota/retry signal — the turn continues. Full
      // relay/fallback handling for inactivity notices lands in Task 3; here we
      // log it with input correlation so it's never silently dropped.
      log(
        JSON.stringify({
          severity: event.severity,
          event: 'provider_notice',
          input_id: event.inputId,
          classification: event.classification,
          relay_recommended: event.relayRecommended,
        }),
      );
      break;
    case 'interruption':
      // Typed terminal/recoverable interruption. Full recovery storage lands in
      // Task 2/3; here we log it with input correlation and continuation policy
      // so the terminal path is never a raw, uncorrelated error.
      log(
        JSON.stringify({
          severity: event.severity,
          event: 'provider_interruption',
          input_id: event.inputId,
          classification: event.classification,
          terminal: event.terminal,
          continuation_policy: event.continuationPolicy,
        }),
      );
      break;
    case 'clear-continuation':
      log(`Clear-continuation requested: ${event.reason} (input ${event.inputId})`);
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Explicit destination addressing is required even when the agent has exactly
 * one configured destination. Bare final text is scratchpad/log output only.
 */
function buildUnwrappedOutputNudge(routing: RoutingContext, previousText: string): string {
  const current = findByRouting(routing.channelType, routing.platformId);
  const destinations = getAllDestinations();
  const names = destinations.map((d) => d.name).join(', ');
  const destinationLine = current
    ? `The current inbound message came from \`${current.name}\`; address the block to \`${current.name}\`.`
    : `Use the destination from the current inbound message's \`from="name"\` attribute. Available destinations: ${names || '(none)'}.`;
  return [
    'Your last answer was not delivered because it was not wrapped in a final `<message to="name">...</message>` block.',
    'Do not redo work. Do not call tools. Reply now with only the corrected final message block.',
    destinationLine,
    '',
    'Put this exact answer text inside the block:',
    '<answer>',
    previousText.trim(),
    '</answer>',
  ].join('\n');
}

function dispatchResultText(text: string, routing: RoutingContext): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to=(["'])([^"']+)\1\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let messageBlocks = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[2];
    const body = match[3].trim();
    messageBlocks++;
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      if (isBlockedChannelName(toName)) {
        log(`Blocked channel destination in <message to="${toName}">: ${SUBAGENT_CHANNEL_BLOCKED_MESSAGE}`);
        scratchpadParts.push(`[dropped: ${SUBAGENT_CHANNEL_BLOCKED_MESSAGE}] ${body}`);
        continue;
      }
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    if (messageBlocks > 0) {
      log(
        `WARNING: agent output had <message to="..."> blocks, but none resolved to a known destination — nothing was sent`,
      );
    } else {
      log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
    }
  }
  return { sent, hasUnwrapped: sent === 0 && scratchpad.length > 0 };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const sameRoute = routing.channelType === channelType && routing.platformId === platformId;
  // Only the active route can inherit reply/thread metadata and recovery stamps.
  // Cross-destination final messages are delivered as new outbound messages, not
  // harvested as progress for the conversation that triggered this turn.
  let threadId: string | null = sameRoute ? routing.threadId : null;
  let messagingGroupId: string | null = sameRoute ? (routing.messagingGroupId ?? null) : null;
  let isGroup: 0 | 1 | null = sameRoute ? (routing.isGroup ?? null) : null;
  // Turns triggered by injected route-less rows (agent-to-agent errors/relays,
  // legacy rows with no user route) carry no user thread, so a reply addressed
  // to the session's own channel destination would otherwise be written
  // thread-less and delivered to the PARENT channel instead of the
  // conversation thread (2026-07-10 invoice-thread misroute). Fall back to the
  // host-committed session_routing default — the same source of truth the MCP
  // tools use for "reply in the thread this session belongs to". User-triggered
  // cross-destination sends keep the existing thread-less behavior.
  if (!sameRoute && dest.type === 'channel' && (routing.channelType === null || routing.channelType === 'agent')) {
    const session = getSessionRouting();
    if (session.channel_type === channelType && session.platform_id === platformId) {
      threadId = session.thread_id;
      messagingGroupId = session.messaging_group_id;
      isGroup = session.is_group;
      log(
        JSON.stringify({
          severity: 'info',
          event: 'session_default_route_inherited',
          reason: 'routeless_trigger',
          trigger_channel_type: routing.channelType,
          channel_type: channelType,
          platform_id: platformId,
          thread_id: threadId,
        }),
      );
    }
  }
  writeMessageOut({
    id: generateId(),
    in_reply_to: sameRoute ? routing.inReplyTo : null,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: threadId,
    route_key: sameRoute ? (routing.routeKey ?? null) : null,
    messaging_group_id: messagingGroupId,
    is_group: isGroup,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
