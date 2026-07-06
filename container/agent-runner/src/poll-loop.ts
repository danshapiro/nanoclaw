import fs from 'fs';

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
import { zombieDecision } from './providers/opencode-errors.js';
import {
  appendRecoveryEntry,
  appendRecoveryEntryAndOwnRows,
  clearContinuation,
  listRecoveryEntries,
  markRecoveryInFlight,
  migrateLegacyContinuation,
  resolveRecoveryEntry,
  setContinuation,
  type ProviderRecoveryEntry,
  type ProviderRecoveryScope,
} from './db/session-state.js';
import { markRecoveryCompleted } from './db/messages-in.js';
import { collectQueryAttachments, type InspectedFile } from './attachments.js';
import {
  formatMessages,
  formatRecoveryContext,
  extractRouting,
  categorizeMessage,
  normalizeRoute,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const HOST_OWNED_COMMANDS = new Set(['/new', '/clear', '/stop']);
const DEFAULT_ACTIVE_INPUT_PATH = '/workspace/.active-input.json';
const STOP_COMMAND = '/stop';
const STOP_ACTIVE_ACK = 'Stopped the active turn.';
const STOP_IDLE_ACK = 'No active turn is running.';

/**
 * Path to the per-input correlation file. Production uses the static
 * `/workspace/.active-input.json` (what the GWS shim and summarize-dnd read);
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

let inputCounter = 0;
function generateInputId(scope: string): string {
  inputCounter += 1;
  return `in-${scope}-${Date.now()}-${inputCounter}-${Math.random().toString(36).slice(2, 6)}`;
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
 * Write a user-visible outbound chat row stamped with the active route metadata
 * from `routing` (`route_key`/`messaging_group_id`/`is_group`). All poll-loop
 * outbound writes go through this so the agent's own progress/result/relay rows
 * are harvestable into route-scoped recovery and never leak across conversations.
 */
function writeRoutedMessage(routing: RoutingContext, text: string): void {
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
    content: JSON.stringify({ text }),
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
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName, continuationScope);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (!config.signal?.aborted) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
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
      markCompleted(idleStopMessages.map((m) => m.id));
      writeRoutedMessage(stopRouting, STOP_IDLE_ACK);
      log(
        JSON.stringify({
          severity: 'info',
          event: 'idle_stop_acknowledged',
          route_key: activeRouteKey,
          message_ids: idleStopMessages.map((m) => m.id),
        }),
      );
      activeMessages = activeMessages.filter((m) => !isStopControlMessage(m));
      if (!activeMessages.some((m) => m.trigger === 1)) {
        continue;
      }
    }

    const ids = activeMessages.map((m) => m.id);
    const originalTasks: ProviderRecoveryEntry['originalTasks'] = activeMessages
      .filter((m) => m.trigger === 1)
      .map((m) => ({ messageId: m.id, text: textOfMessage(m), timestamp: m.timestamp }));
    // Pending/in_flight recovery entries for THIS route are resumed on this
    // top-level turn: their XML-escaped context is prepended to the prompt so the
    // next Yente turn picks up interrupted work (original task + prior progress +
    // completed side effects + continuation policy), and they are marked in_flight
    // on acceptance and resolved (with their owned rows completed) only on a
    // successful result (Invariants 128/129/140; plan lines 743-744).
    const resumableRecovery = listRecoveryEntries(activeRouteScope).filter(
      (e) => e.status === 'pending' || e.status === 'in_flight',
    );
    // Generate a top-level inputId for this wake's prompt. Acceptance is tracked
    // when the provider emits input-accepted for this id.
    const topLevelInputId = generateInputId('initial');
    markProcessing(ids);

    const routing = extractRouting(activeMessages);

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
        continue;
      }

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

      // Provider startup / session creation. A synchronous throw here (the
      // OpenCode server failing to spawn, session creation rejecting) is a
      // pre-acceptance failure: no input has been accepted, so it is recoverable.
      query = config.provider.query({
        inputId: topLevelInputId,
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
      log(
        JSON.stringify({
          severity: 'warn',
          event: 'pre_query_failure_returned_to_pending',
          route_key: activeRouteKey,
          message_ids: ids,
          error: preMsg,
        }),
      );
      // Store a route-scoped recovery entry so the next Yente turn has the
      // original-task context, then return the claimed rows to pending. The rows
      // are unaccepted (no provider input-accepted), so returning them to pending
      // is the correct lifecycle; recovery preserves the original-task context.
      const now = new Date().toISOString();
      appendRecoveryEntry(activeRouteScope, {
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
      });
      returnProcessingToPending(ids, 'pre_query_failure');
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !skippedSet.has(id));
    const replyAccounting = {
      initialRequiresUserVisibleReply: requiresUserVisibleReply(keep),
      outboundVisibleReplyCountBefore: countOutboundVisibleReplyMessages({
        ...routing,
        routeKey: activeRouteScope.routeKey,
      }),
    };
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        replyAccounting,
        {
          topLevelInputId,
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

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err, { attemptedContinuation: continuation })) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName, continuationScope);
      }

      // Provider throw is a sanitized recoverable interruption. Write a
      // user-visible fallback so the user knows to retry, then settle the
      // claimed rows (the provider never resolved their inputId).
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
      // The claimed rows have a written user-visible fallback; complete them so
      // they don't loop forever (the existing provider-throw contract).
      markCompleted(processingIds);
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
  const abortQuery = () => query.abort();

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
  // Side-effect evidence carried on a terminal interruption's recovery seed, so
  // the accepted-unresolved recovery entry records what already happened.
  const interruptionSideEffects: ProviderRecoveryEntry['sideEffects'] = [];

  // Input ledger: every prompt the poll loop sends is tracked by inputId. A
  // prompt is `accepted` only after the provider emits input-accepted for it,
  // and `resolved` only after a successful result resolves/supersedes it.
  const ledger = new Map<string, InputLedgerEntry>();
  ledger.set(ledgerCtx.topLevelInputId, {
    inputId: ledgerCtx.topLevelInputId,
    messageIds: [...initialBatchIds],
    state: 'queued',
    scope: 'initial',
    prompt: ledgerCtx.originalTasks.map((t) => t.text).join('\n') || '(initial turn)',
    requiresUserVisibleReply: replyAccounting.initialRequiresUserVisibleReply,
    outboundVisibleReplyCountBefore: replyAccounting.outboundVisibleReplyCountBefore,
  });

  if (signal?.aborted) {
    abortQuery();
  } else {
    signal?.addEventListener('abort', abortQuery, { once: true });
  }

  function onInputAccepted(inputId: string): void {
    const entry = ledger.get(inputId);
    if (!entry) return;
    entry.state = 'accepted';
    // Stamp the current accepted input for tool-time side-effect correlation.
    writeActiveInput(inputId, ledgerCtx.activeRouteKey);
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
      entry.state = 'resolved';
      idsToComplete.push(...entry.messageIds);
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
      writeMissingVisibleReplyError(routing, providerErrorText);
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
    void pollFollowups().finally(() => {
      pollingFollowups = false;
    });
  }, ACTIVE_POLL_INTERVAL_MS);

  async function pollFollowups(): Promise<void> {
    // Only claim follow-ups on the ACTIVE route. Rows on other routes remain
    // pending and are excluded from this turn (route splitting also applies to
    // follow-ups, not just the initial batch).
    const candidates = getPendingMessages().filter((m) => m.kind !== 'system');
    const routeMessages = candidates.filter((m) => routeKeyForMessage(providerName, m) === ledgerCtx.activeRouteKey);
    const stopMessages = routeMessages.filter(isStopControlMessage);
    if (stopMessages.length > 0) {
      const stopIds = stopMessages.map((m) => m.id);
      const sameRouteIds = routeMessages.map((m) => m.id);
      markProcessing(sameRouteIds);
      markCompleted(sameRouteIds);
      if (!userStopRequested) {
        userStopRequested = true;
        writeRoutedMessage(routing, STOP_ACTIVE_ACK);
        log(
          JSON.stringify({
            severity: 'info',
            event: 'active_stop_requested',
            route_key: ledgerCtx.activeRouteKey,
            message_ids: stopIds,
            completed_same_route_message_ids: sameRouteIds,
          }),
        );
        query.abort();
      }
      return;
    }
    const newMessages = routeMessages;
    if (newMessages.length === 0) return;

    const newIds = newMessages.map((m) => m.id);
    const followupInputId = generateInputId('followup');
    const outboundVisibleReplyCountBefore = countOutboundVisibleReplyMessages(routing);
    markProcessing(newIds);

    const prompt = formatMessages(newMessages);
    const attachments = await collectQueryAttachments({
      messages: newMessages,
      pathReferenceMessages: newMessages,
      inspectFile: inspectAttachmentFile,
      log: logAttachmentEvent,
    });
    const followupDestination = findByRouting(routing.channelType, routing.platformId);

    log(`Pushing ${newMessages.length} follow-up message(s) into active query (input ${followupInputId})`);
    try {
      unwrappedOutputNudged = false;
      pendingUnwrappedOutputText = null;
      query.push({
        inputId: followupInputId,
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
      // Enqueue failed — do NOT register a ledger entry (so terminal handling
      // never returns it to pending) and leave the rows in 'processing'. The
      // throwing-push contract keeps them retryable via host sweep / next wake.
      return;
    }
    // Registered only on a SUCCESSFUL push. The row is completed only when the
    // provider resolves followupInputId via a result; if never accepted by the
    // turn's end it is returned to pending.
    ledger.set(followupInputId, {
      inputId: followupInputId,
      messageIds: newIds,
      state: 'queued',
      scope: 'followup',
      prompt: newMessages.map(textOfMessage).join('\n'),
      requiresUserVisibleReply: requiresUserVisibleReply(newMessages),
      outboundVisibleReplyCountBefore,
    });
  }

  let topLevelResolvedAtLeastOnce = false;
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
        onInputAccepted(event.inputId);
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
          writeRoutedMessage(routing, action.text);
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
            query.push({ inputId: resolved[0], prompt: buildUnwrappedOutputNudge(routing, event.text) });
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
  } finally {
    done = true;
    clearInterval(pollHandle);
    signal?.removeEventListener('abort', abortQuery);

    // Terminal handling for un-resolved ledger entries. User-requested stop is a
    // discard/complete path; ordinary terminal interruptions keep the existing
    // retry/recovery split (Invariants 160/161/162).
    const acceptedUnresolved = [...ledger.values()].filter((e) => e.state === 'accepted');
    if (userStopRequested) {
      const idsToComplete: string[] = [];
      for (const entry of ledger.values()) {
        if (entry.state !== 'queued' && entry.state !== 'accepted') continue;
        idsToComplete.push(...entry.messageIds);
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
        ownedIds.push(...e.messageIds);
        return { inputId: e.inputId, messageIds: [...e.messageIds], prompt: e.prompt };
      });
      const entry: ProviderRecoveryEntry = {
        id: recoveryId,
        status: 'pending',
        classification: zombieFailureCleared
          ? 'continuation_zombie_restart'
          : 'terminal_interruption_accepted_unresolved',
        agentMessage: zombieFailureCleared
          ? 'The previous session became unusable after repeated failures; I am restarting this work from scratch.'
          : 'I was interrupted mid-turn and will resume this work.',
        fallbackUserMessage: zombieFailureCleared
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
          writeMissingVisibleReplyError(routing);
        } else {
          for (const e of acceptedUnresolved) e.state = 'recovery_owned';
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
      if (entry.state === 'queued') {
        // Never accepted by the provider before the turn ended → return to
        // pending so a later wake retries them (route-matched and other-route
        // rows alike are returned to pending; other-route rows were never
        // claimed here).
        returnProcessingToPending(entry.messageIds, 'unaccepted_at_terminal');
        entry.state = 'returned';
      }
    }
  }

  return { continuation: queryContinuation, clearContinuation: clearContinuationRequested };
}

function requiresUserVisibleReply(messages: MessageInRow[]): boolean {
  return messages.some((m) => (m.kind === 'chat' || m.kind === 'chat-sdk') && m.trigger === 1);
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
  let s = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\baoc_[A-Za-z0-9]{16,}/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|api[_-]?key|secret|password|sig|access_token)=)[^\s&]+/gi, '$1[redacted]');
  return s.length > PROVIDER_ERROR_MAX_LEN ? s.slice(0, PROVIDER_ERROR_MAX_LEN - 1) + '\u2026' : s;
}

function writeMissingVisibleReplyError(routing: RoutingContext, providerErrorText?: string | null): void {
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
  writeMessageOut({
    id: generateId(),
    in_reply_to: sameRoute ? routing.inReplyTo : null,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: sameRoute ? routing.threadId : null,
    route_key: sameRoute ? (routing.routeKey ?? null) : null,
    messaging_group_id: sameRoute ? (routing.messagingGroupId ?? null) : null,
    is_group: sameRoute ? (routing.isGroup ?? null) : null,
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
