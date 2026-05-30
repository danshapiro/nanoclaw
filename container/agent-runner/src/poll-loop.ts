import fs from 'fs';

import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  returnProcessingToPending,
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks, getOutboundDb } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { collectQueryAttachments, type InspectedFile } from './attachments.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  normalizeRoute,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const HOST_OWNED_COMMANDS = new Set(['/new', '/clear']);
const ACTIVE_INPUT_PATH = '/workspace/.active-input.json';

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
 * Atomically write the currently-accepted input correlation to
 * /workspace/.active-input.json (temp+rename) so the GWS shim and summarize-dnd
 * stamp the CURRENT input's correlation at tool-invocation time. Per-input
 * correlation must be a file (a long-lived tool child can't see env updates
 * across follow-ups). Silently no-ops when /workspace is absent (test DBs).
 */
function writeActiveInput(inputId: string, routeKey: string): void {
  try {
    const tmp = `${ACTIVE_INPUT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ inputId, routeKey, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, ACTIVE_INPUT_PATH);
  } catch {
    // /workspace may not exist (in-memory test DBs) — non-fatal.
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
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

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
    const activeMessages = activeRouteMessages;

    const ids = activeMessages.map((m) => m.id);
    // Generate a top-level inputId for this wake's prompt. Acceptance is tracked
    // when the provider emits input-accepted for this id.
    const topLevelInputId = generateInputId('initial');
    markProcessing(ids);

    const routing = extractRouting(activeMessages);

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `messages`, and no gating happens.
    let keep: MessageInRow[] = activeMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(activeMessages);
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

    // Pre-query failures after rows are claimed are recoverable: a throw in
    // attachment inspection / formatting / pre-task handling must return the
    // claimed rows to pending (delete their transient 'processing' acks) rather
    // than writing a raw provider error. Wrap the pre-query setup so a failure
    // here is treated under the same recoverable lifecycle.
    let prompt: string;
    let attachments: Awaited<ReturnType<typeof collectQueryAttachments>>;
    try {
      // Format messages: passthrough commands get raw text (only if the
      // provider natively handles slash commands), others get XML.
      prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

      log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

      attachments = await collectQueryAttachments({
        messages: keep,
        pathReferenceMessages: keep,
        inspectFile: config.inspectAttachmentFile,
        log: logAttachmentEvent,
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
      // Return claimed rows to pending; the next wake retries them.
      returnProcessingToPending(ids, 'pre_query_failure');
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    const query = config.provider.query({
      inputId: topLevelInputId,
      prompt,
      attachments,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !skippedSet.has(id));
    const replyAccounting = {
      requiresUserVisibleReply: requiresUserVisibleReply(keep),
      outboundNonSystemCountBefore: countOutboundNonSystemMessages(),
    };
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        replyAccounting,
        { topLevelInputId, activeRouteKey },
        config.inspectAttachmentFile,
        config.signal,
      );
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
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
        clearContinuation(config.providerName);
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
}

interface ReplyAccounting {
  requiresUserVisibleReply: boolean;
  outboundNonSystemCountBefore: number;
}

interface InputLedgerEntry {
  inputId: string;
  messageIds: string[];
  /** queued → accepted → resolved, or returned (unaccepted, sent back to pending). */
  state: 'queued' | 'accepted' | 'resolved' | 'returned' | 'recovery_owned';
  scope: 'initial' | 'followup';
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  replyAccounting: ReplyAccounting,
  ledgerCtx: { topLevelInputId: string; activeRouteKey: string },
  inspectAttachmentFile?: (filePath: string) => Promise<InspectedFile | null>,
  signal?: AbortSignal,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let initialBatchSettled = false;
  const abortQuery = () => query.abort();

  // Input ledger: every prompt the poll loop sends is tracked by inputId. A
  // prompt is `accepted` only after the provider emits input-accepted for it,
  // and `resolved` only after a successful result resolves/supersedes it.
  const ledger = new Map<string, InputLedgerEntry>();
  ledger.set(ledgerCtx.topLevelInputId, {
    inputId: ledgerCtx.topLevelInputId,
    messageIds: [...initialBatchIds],
    state: 'queued',
    scope: 'initial',
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
    for (const inputId of inputIds) {
      const entry = ledger.get(inputId);
      if (!entry || entry.state === 'resolved') continue;
      entry.state = 'resolved';
      idsToComplete.push(...entry.messageIds);
    }
    if (idsToComplete.length > 0) markCompleted(idsToComplete);
  }

  function settleInitialBatch(resolvedAtLeastOne: boolean): void {
    if (initialBatchSettled) return;
    initialBatchSettled = true;

    if (
      resolvedAtLeastOne &&
      replyAccounting.requiresUserVisibleReply &&
      countOutboundNonSystemMessages() <= replyAccounting.outboundNonSystemCountBefore
    ) {
      writeMissingVisibleReplyError(routing);
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
    const newMessages = candidates.filter((m) => routeKeyForMessage(providerName, m) === ledgerCtx.activeRouteKey);
    if (newMessages.length === 0) return;

    const newIds = newMessages.map((m) => m.id);
    const followupInputId = generateInputId('followup');
    markProcessing(newIds);

    const prompt = formatMessages(newMessages);
    const attachments = await collectQueryAttachments({
      messages: newMessages,
      pathReferenceMessages: newMessages,
      inspectFile: inspectAttachmentFile,
      log: logAttachmentEvent,
    });
    log(`Pushing ${newMessages.length} follow-up message(s) into active query (input ${followupInputId})`);
    try {
      query.push({ inputId: followupInputId, prompt, attachments });
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
    ledger.set(followupInputId, { inputId: followupInputId, messageIds: newIds, state: 'queued', scope: 'followup' });
  }

  let resolvedAtLeastOne = false;
  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'input-accepted') {
        onInputAccepted(event.inputId);
      } else if (event.type === 'result') {
        // A result — with or without text — means a turn segment is done.
        // Dispatch text first so reply accounting sees direct result text and
        // MCP send_message rows. Then resolve the exact input ids and complete
        // only those rows.
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
        const resolved = resolveResult(event.resolvedInputIds ?? []);
        if (resolved.length > 0) {
          completeResolved(resolved);
          resolvedAtLeastOne = true;
        }
        settleInitialBatch(resolvedAtLeastOne);
      }
    }

    // Stream ended. Settle reply accounting for the initial batch.
    settleInitialBatch(resolvedAtLeastOne);
  } finally {
    done = true;
    clearInterval(pollHandle);
    signal?.removeEventListener('abort', abortQuery);

    // Terminal handling for un-resolved ledger entries. Accepted-but-unresolved
    // rows would be moved to recovery ownership (handled fully once the
    // recovery payload is built — see Task 2/3 wiring); for Task 1 the
    // load-bearing invariant proven here is that UNACCEPTED claimed rows are
    // returned to pending rather than stranded in 'processing'.
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

  return { continuation: queryContinuation };
}

function requiresUserVisibleReply(messages: MessageInRow[]): boolean {
  return messages.some((m) => (m.kind === 'chat' || m.kind === 'chat-sdk') && m.trigger === 1);
}

function countOutboundNonSystemMessages(): number {
  const row = getOutboundDb().prepare("SELECT COUNT(*) AS count FROM messages_out WHERE kind <> 'system'").get() as {
    count: number;
  };
  return row.count;
}

function writeMissingVisibleReplyError(routing: RoutingContext): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({
      text: 'Error: agent completed without sending a user-visible response. Please try again.',
    }),
  });
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
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
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

  // Single-destination shortcut: the agent wrote plain text — send to
  // the session's originating channel (from session_routing) if available,
  // otherwise fall back to the single destination.
  if (sent === 0 && scratchpad) {
    if (routing.channelType && routing.platformId) {
      // Reply to the channel/thread the message came from
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Inherit thread_id from the inbound routing context so replies land in the
  // same thread the conversation is in. For non-threaded adapters the router
  // strips thread_id at ingest, so this will already be null.
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: routing.threadId,
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
