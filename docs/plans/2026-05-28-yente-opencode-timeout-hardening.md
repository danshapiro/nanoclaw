# Yente OpenCode Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yente must survive slow OpenCode work, silent/failed OpenCode event streams, native OpenCode question stalls, optional Granola bridge failures, and misleading GWS probe audit logs without losing user-facing state; the observed Dvora and Fruma requests must be replayed through local Yente injection and ultimately succeed.

**Architecture:** Replace the current single `nextMeaningfulOpenCodeEvent()` watchdog with an SDK-compatible OpenCode turn supervisor: one session-scoped event pump owns SSE reading and liveness metadata, while `OpenCodeProvider` owns turn state, interruption classification, native-question cancellation, and runtime lifecycle. The poll loop treats provider interruptions as agent-visible recovery input first: Yente receives timeout/interruption context as a synthetic message and relays it when the provider can accept a recovery turn; direct host-authored user messages are bounded fallbacks only when relay acceptance fails. Recovery context is scoped to the wake-triggering route, includes the original user task and unaccepted follow-ups, is injected only at top-level query start, and is deleted only after provider prompt acceptance. Host liveness is maintained by provider activity ticks during long waits, and long OpenCode tool timeouts are tracked with an active-tool map so one completed tool cannot remove protection for another.

**Tech Stack:** TypeScript, Bun tests for `container/agent-runner`, Vitest for host-side NanoClaw, Go tests for `gws-skill`, SQLite session state, OpenCode SDK 1.15.10 event stream.

---

## Scope And Invariants

The implementation spans two repositories because the user asked for the full hardening around the observed failures:

- `/home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening` owns OpenCode runtime hardening, poll-loop recovery, local Yente incident replay, optional Granola MCP degradation, and docs.
- `/home/dan/code/gws-skill` owns the GWS proxy audit-log correction. Do that work in a separate GWS worktree and commit it separately.

Do not mutate the live `shapiroserver2` host or run production deploys in this pass. The required "inject requests into Yente" coverage is local: insert rows into the NanoClaw session DB, run `runPollLoop()`, use the real `OpenCodeProvider` with a deterministic OpenCode runtime harness, and assert `messages_out`, `processing_ack`, continuation, and recovery state.

Core invariants:

- OpenCode SDK 1.15.10 does not expose `client.question.*` or a `question.asked` event. Native-question handling must target the actual SDK surfaces: `message.part.updated` tool parts and `permission.updated` permission replies via `postSessionIdPermissionsPermissionId(...)`.
- `buildOpenCodeConfig()` must disable the native question tool through OpenCode's tool-availability config, not only through the unrelated `permission.question` key.
- OpenCode inactivity is not a stale continuation. `continuation:opencode` is cleared only when OpenCode returns a structured or exact missing-session error for the specific session id being resumed; every continuation invalidation check receives the attempted continuation/session id and generic transport failures cannot clear it.
- Generic transport/read failures such as `ECONNRESET`, bare `404`, stream end, "event timeout", or no-SSE transport timeout are not session-invalid by themselves.
- Every OpenCode event, OpenCode keepalive, and provider wait tick yields provider `activity` so the poll loop touches the heartbeat during long waits. Wait ticks keep the container alive but do not count as meaningful model progress.
- A meaningful-progress gap creates an agent-visible inactivity observation at a throttled interval and continues waiting. The normal path is not a host-authored direct user message: the observation is queued into the active OpenCode turn, or stored for the next accepted top-level recovery turn, so Yente sees the timeout context and can relay it. It does not settle the initial batch, destroy the runtime, clear `activeSessionId`, clear continuation, or store terminal recovery context. If the provider cannot accept the relay before a terminal interruption, the terminal recovery path carries the observation forward and may send a direct fallback only after bounded relay acceptance fails.
- A no-SSE transport timeout, stream read error, stream end, queue overflow, absolute turn ceiling, OpenCode `session.error`, prompt/startup acceptance timeout, or retry-limit exhaustion is terminal for the current provider query. It emits a typed interruption with agent-visible recovery text, stores resumable route-scoped recovery context, settles the current batch, preserves continuation only when the OpenCode session is proven reusable, destroys the runtime when the transport is no longer trustworthy, clears persisted OpenCode tool state, and returns from the provider stream.
- Native OpenCode questions are unsupported in Yente. If a question tool/permission can be denied through the SDK permission API, deny it and wait for proof that the interrupted OpenCode turn is reusable (`session.idle` or an equivalent SDK acknowledgement) before preserving the OpenCode continuation. If denial cannot be sent, or reuse proof does not arrive before the cancellation grace timeout, destroy the runtime, clear only the unusable OpenCode continuation through an explicit provider event, store restart-capable recovery context, and make the agent-visible recovery text clear that Yente kept conversation context but restarted the OpenCode side.
- Recovery context is scoped by provider plus the wake-triggering route (`platform_id`, `channel_type`, `thread_id`) inside the session DB, not by the first accumulated context row. It cannot be consumed by another conversation in a shared session.
- Recovery context is XML-escaped before prompt injection.
- Recovery context is injected only into a new top-level `provider.query(...)`, not into `query.push(...)` follow-ups. Delete injected recovery ids only after the provider yields prompt-accepted `init` for that top-level query.
- Recovery context always includes enough to restart work without an OpenCode continuation: the original wake-triggering user task, known prior progress, terminal classification, continuation policy, pending/unaccepted follow-up text, and any safe tool-side state summary. Restart-style recovery tests must pass with continuation cleared.
- Follow-up rows are not marked completed merely because `query.push(...)` accepted them into an in-process queue. They are completed only after the provider emits a follow-up prompt-accepted event, includes them in a completed result, or explicitly classifies them as superseded; terminal interruptions before provider acceptance reset them to pending or store them in recovery context so they are not lost.
- `ProviderEvent.error` behavior is explicit: retryable errors are logged/progress-only; non-retryable errors are converted to typed interruptions or user-visible relay/fallback handling and settle the current batch without leaking raw provider error text.
- Optional MCP degradation is narrow: Granola is optional by backward-compatible default, bridges marked `required: false` are optional, and all other bridges fail closed unless explicitly configured otherwise.
- Optional MCP unavailability reasons shown to agents are sanitized categories, not raw host paths, uid/gid values, or auth directory details.
- GWS help/schema/auth/version probes remain authenticated but are classified structurally so flag values like `--subject help` cannot bypass policy, rate limits, signatures, or audit semantics for real API calls.

## File Structure

### NanoClaw Agent Runner

- Create `container/agent-runner/src/providers/opencode-events.ts`
  - Single-reader OpenCode SSE pump.
  - Session-scoped filtering and liveness snapshots.
  - Deterministic clock/scheduler injection for tests.
  - Result kinds: `event`, `keepalive`, `wait-tick`, `soft-timeout`, `transport-timeout`, `absolute-timeout`, `read-error`, `ended`, `queue-overflow`.
  - Bounded queues with a documented overflow policy that never silently drops terminal/session-error/permission/question/final assistant text events.

- Create `container/agent-runner/src/providers/opencode-errors.ts`
  - Typed `OpenCodeTransportTimeoutError`, `OpenCodeAbsoluteTimeoutError`, `OpenCodeStreamReadError`, `OpenCodeQueueOverflowError`, and metadata helpers.
  - Exact missing-session classifier helpers.

- Modify `container/agent-runner/src/providers/opencode.ts`
  - Use the event pump and runtime controller.
  - Disable OpenCode native `question` through tool availability config.
  - Remove timeout-driven session clearing.
  - Yield `activity` for event, keepalive, and wait ticks.
  - Yield typed `interruption` events and agent-visible observations for soft inactivity, transport death, stream read errors, queue overflow, absolute turn ceiling, and native-question interruptions.
  - Deny/cancel native question tool/permission paths through the SDK permission API; restart with recovery context when cancellation is impossible.
  - Track OpenCode tool starts/stops with an active-tool map and update `container_state` to the running tool with the longest declared timeout.
  - Use structured JSONL logs with `severity`, `event`, `session_id`, `classification`, and timeout metadata.

- Modify `container/agent-runner/src/providers/types.ts`
  - Add structured interruption, agent-visible recovery, explicit continuation-clear, and follow-up prompt-accepted event fields.
  - Add `activity.source` metadata if useful for tests/logging.
  - Clarify `error` semantics.
  - Change continuation invalidation to receive attempted continuation metadata.

- Modify `container/agent-runner/src/providers/codex.ts`
  - Update the `isSessionInvalid` method signature to accept attempted continuation metadata without changing Codex behavior.

- Modify `container/agent-runner/src/db/session-state.ts`
  - Add scoped recovery-context APIs with generated ids, original-task/restart metadata, non-destructive read, delete-by-id, and malformed-json cleanup.
  - Add explicit continuation-clear helper usage only through typed provider decisions.

- Modify `container/agent-runner/src/db/messages-in.ts`
  - Add a small helper for returning unaccepted follow-up rows from `processing` to `pending` when a terminal interruption happens before provider prompt acceptance.

- Modify `container/agent-runner/src/formatter.ts`
  - Export the existing XML escape helper for recovery prompt injection.

- Modify `container/agent-runner/src/poll-loop.ts`
  - Build recovery scope from the wake-triggering message in the batch.
  - Load scoped recovery context before top-level `provider.query(...)`.
  - Delete recovery context only after the provider yields prompt-accepted `init` for that query.
  - Route provider interruptions through Yente-visible relay first and use direct `messages_out` fallback only after bounded relay acceptance fails.
  - Store recovery context for terminal interruptions and for unrelayed soft observations that become terminal.
  - Keep follow-up message rows pending until provider prompt acceptance, not local enqueue.
  - Handle non-retryable `ProviderEvent.error` visibly.
  - Keep follow-up `query.push(...)` from consuming recovery context, while adding explicit provider-acceptance accounting for completion.

- Add/modify tests:
  - `container/agent-runner/src/providers/opencode-events.test.ts`
  - `container/agent-runner/src/providers/opencode.test.ts`
  - `container/agent-runner/src/db/session-state.test.ts`
  - `container/agent-runner/src/poll-loop.test.ts`
  - `container/agent-runner/src/opencode-incident-replay.test.ts`

### NanoClaw Host

- Modify `src/host-sweep.ts`
  - Honor any positive `container_state.tool_declared_timeout_ms`, not only `current_tool === 'Bash'`.

- Modify `src/host-sweep.test.ts`
  - Keep existing Bash coverage.
  - Add OpenCode declared-timeout and no-SSE wait-tick coverage.

- Modify `src/agent-mcp-config.ts`
  - Add `required?: boolean` to bridge config.
  - Default only `serverName === 'granola'` to optional for backward compatibility.

- Modify `src/container-config.ts`
  - Add sanitized `agentMcpUnavailable?: Record<string, { category: string; updatedAt: string }>` runtime state.

- Modify `src/agent-mcp-bridge.ts`
  - Export a helper for bridge auth directories so mount-overlap checks include failed optional bridges.

- Modify `src/container-runner.ts`
  - Degrade optional bridge startup failures.
  - Fail closed for required bridges.
  - Filter MCP servers and allowed tools to started bridges.
  - Preserve auth path mount protection for both started and failed bridges.
  - Recompose `CLAUDE.md` after bridge availability is resolved.

- Modify `src/claude-md-compose.ts`
  - Generate sanitized unavailable-MCP fragments.

- Add/modify tests:
  - `src/agent-mcp-config.test.ts`
  - `src/container-runner.test.ts`
  - `src/claude-md-compose.test.ts`

### GWS Proxy

- Create worktree `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening`.
- Modify `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy.go`.
- Modify `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy_test.go`.

### Docs

- Modify `docs/agent-runner-details.md`.

## Task 1: SDK-Compatible OpenCode Event Pump And Liveness

**Files:**
- Create: `container/agent-runner/src/providers/opencode-events.ts`
- Create: `container/agent-runner/src/providers/opencode-events.test.ts`
- Create: `container/agent-runner/src/providers/opencode-errors.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `src/host-sweep.ts`
- Modify: `src/host-sweep.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

In `container/agent-runner/src/providers/opencode.test.ts`, change stale classification coverage:

```typescript
expect(isStaleSessionError(new Error('OpenCode event timeout (300000ms)'))).toBe(false);
expect(isStaleSessionError(new Error('ECONNRESET while reading OpenCode events'))).toBe(false);
expect(isStaleSessionError(new Error('HTTP 404 from OpenCode event stream'))).toBe(false);
expect(isStaleSessionError(new Error('OpenCode promptAsync: session ses_old not found'))).toBe(true);
expect(isStaleSessionError(new Error('NotFoundError'))).toBe(false);
```

In `container/agent-runner/src/providers/opencode-events.test.ts`, add tests using a fake clock/scheduler:

- Keepalive events return `kind: 'keepalive'`, update `lastEventType`, and do not update `lastMeaningfulEventType`.
- A wait interval with no SSE returns `kind: 'wait-tick'` before `transportTimeoutMs`.
- Heartbeats for longer than `softTimeoutMs` return one throttled `kind: 'soft-timeout'` while the stream stays alive and later returns `session.idle`.
- No SSE event before `transportTimeoutMs` returns `kind: 'transport-timeout'` with `sessionId`, `transportTimeoutMs`, `elapsedMs`, `lastEventType`, `lastEventAt`, `lastMeaningfulEventType`, and `lastMeaningfulEventAt`.
- Reaching `absoluteDeadlineMs` returns distinct `kind: 'absolute-timeout'` with the same liveness metadata and never masquerades as stream end or transport timeout.
- Stream read exceptions surface as `OpenCodeStreamReadError` with metadata.
- Events with another session id do not wake the active session waiter.
- Queue overflow preserves terminal/action-required events and either drops only explicitly droppable low-value events or returns `kind: 'queue-overflow'`; it never silently drops `session.idle`, `session.error`, `permission.updated`, question tool parts, or assistant text parts.

In `src/host-sweep.test.ts`, add:

```typescript
it('widens stuck tolerance for any active tool with a declared timeout', () => {
  const tenMinMs = 10 * 60 * 1000;
  const res = decideStuckAction({
    now: BASE,
    heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
    containerState: {
      current_tool: 'OpenCode:bash',
      tool_declared_timeout_ms: tenMinMs,
      tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
    },
    claims: [claim('msg-1', 5 * 60 * 1000)],
  });

  expect(res.action).toBe('ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/host-sweep.test.ts
```

Expected: FAIL because `opencode-events.ts` does not exist, transport strings are still stale-session matches, and host sweep only honors Bash.

- [ ] **Step 3: Implement typed errors and exact stale-session classification**

In `container/agent-runner/src/providers/opencode-errors.ts`:

```typescript
export interface OpenCodeLivenessMetadata {
  sessionId: string;
  configuredTimeoutMs: number;
  elapsedMs: number;
  lastEventType?: string;
  lastEventAt?: number;
  lastMeaningfulEventType?: string;
  lastMeaningfulEventAt?: number;
}

export class OpenCodeTransportTimeoutError extends Error {
  readonly name = 'OpenCodeTransportTimeoutError';
  constructor(readonly metadata: OpenCodeLivenessMetadata) {
    super(`OpenCode transport timeout after ${metadata.configuredTimeoutMs}ms for session ${metadata.sessionId}`);
  }
}

export class OpenCodeStreamReadError extends Error {
  readonly name = 'OpenCodeStreamReadError';
  constructor(readonly metadata: Omit<OpenCodeLivenessMetadata, 'configuredTimeoutMs'>, readonly cause: unknown) {
    super(`OpenCode event stream failed for session ${metadata.sessionId}`);
  }
}
```

Add `OpenCodeAbsoluteTimeoutError`, `OpenCodeQueueOverflowError`, and `isMissingOpenCodeSessionError(err, attemptedSessionId)` that returns true only for missing-session/conversation messages tied to the attempted session id or a structured OpenCode missing-session response from `promptAsync`. Do not match bare `NotFoundError`, bare `404`, `ECONNRESET`, stream errors, or timeout text. Thread `attemptedSessionId` through every caller; there must be no session-invalid check that runs without knowing which continuation was attempted.

- [ ] **Step 4: Implement the event pump**

In `opencode-events.ts`, implement a single-reader pump:

```typescript
export type OpenCodePumpResult<T extends OpenCodeSseEvent> =
  | { kind: 'event'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'keepalive'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'wait-tick'; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'soft-timeout'; metadata: OpenCodeLivenessSnapshot & { configuredTimeoutMs: number; elapsedMs: number } }
  | { kind: 'transport-timeout'; error: OpenCodeTransportTimeoutError }
  | { kind: 'absolute-timeout'; error: OpenCodeAbsoluteTimeoutError }
  | { kind: 'read-error'; error: OpenCodeStreamReadError }
  | { kind: 'queue-overflow'; error: OpenCodeQueueOverflowError }
  | { kind: 'ended'; metadata: OpenCodeLivenessSnapshot };
```

Requirements:

- No code outside the pump calls `stream.next()` directly.
- `next(sessionId, { softTimeoutMs, transportTimeoutMs, waitTickMs, absoluteDeadlineMs })` returns the earliest relevant event, keepalive, wait tick, soft timeout, transport timeout, absolute deadline, read error, queue overflow, or stream end.
- Heartbeats are coalesced, not queued without bound.
- Non-keepalive events are queued by session id.
- Overflow policy is explicit: preserve non-droppable terminal/action-required/final-text events; if the pump cannot make space safely, return `queue-overflow` as a terminal recoverable interruption.
- The tests use fake timers or the injected clock. Do not sleep for production durations.

- [ ] **Step 5: Generalize host-sweep declared timeout handling**

Replace the Bash-only helper in `src/host-sweep.ts` with:

```typescript
function declaredToolTimeoutMs(containerState: ContainerState | null): number | null {
  const timeout = containerState?.tool_declared_timeout_ms;
  return typeof timeout === 'number' && timeout > 0 ? timeout : null;
}
```

Use it for both the absolute ceiling and per-claim tolerance. Update comments from Bash-specific to declared-tool-specific.

- [ ] **Step 6: Run tests and typechecks**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/host-sweep.test.ts
timeout 120s pnpm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode-events.ts \
  container/agent-runner/src/providers/opencode-events.test.ts \
  container/agent-runner/src/providers/opencode-errors.ts \
  container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  src/host-sweep.ts src/host-sweep.test.ts
git commit -m "fix: make opencode liveness session scoped"
```

## Task 2: Provider Interruptions, Agent Relay, And Route-Scoped Recovery Context

**Files:**
- Modify: `container/agent-runner/src/providers/types.ts`
- Modify: `container/agent-runner/src/providers/codex.ts`
- Modify: `container/agent-runner/src/db/messages-in.ts`
- Modify: `container/agent-runner/src/db/session-state.ts`
- Modify: `container/agent-runner/src/db/session-state.test.ts`
- Modify: `container/agent-runner/src/formatter.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

In `providers/types.ts`, plan for:

```typescript
export type ProviderNoticeSeverity = 'info' | 'warn' | 'error';
export type ProviderContinuationPolicy = 'preserve' | 'clear' | 'unknown';

export interface ProviderRecoveryPayload {
  classification: string;
  originalUserTask: string;
  agentMessage: string;
  priorProgress?: string;
  pendingFollowups?: string[];
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
}

export interface ProviderInterruption {
  severity: ProviderNoticeSeverity;
  classification: string;
  terminal: boolean;
  settleInitialBatch: boolean;
  agentMessage: string;
  fallbackUserMessage: string;
  recovery?: ProviderRecoveryPayload;
  continuationPolicy: ProviderContinuationPolicy;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'input-accepted'; inputId: string; scope: 'initial' | 'followup' }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string; userMessage?: string }
  | { type: 'progress'; message: string }
  | ({ type: 'interruption' } & ProviderInterruption)
  | { type: 'clear-continuation'; reason: string; attemptedContinuation?: string }
  | { type: 'activity'; source?: 'opencode_event' | 'opencode_keepalive' | 'provider_wait_tick' | 'provider_internal' };
```

Update the provider interface so continuation invalidation cannot happen without attempted-session context:

```typescript
isSessionInvalid(err: unknown, context: { attemptedContinuation?: string }): boolean;
```

In `session-state.test.ts`, add tests for:

- FIFO append/read/delete with generated ids.
- Scope isolation by provider plus route.
- Reading recovery entries is non-destructive.
- Malformed stored JSON is deleted and returns `[]`.
- Keeping only the most recent 10 recovery entries per scope.
- Stored recovery payloads include `originalUserTask`, `agentMessage`, `pendingFollowups`, `continuationPolicy`, and `attemptedContinuation`.

In `poll-loop.test.ts`, add tests for:

- A terminal provider `interruption` first creates a Yente-visible relay turn using `agentMessage`; only if that relay is not accepted within the bounded relay deadline does the poll loop write `fallbackUserMessage` directly to `messages_out`.
- The relay turn receives the stored recovery payload, and the user-visible output comes from the provider result when relay succeeds.
- A soft provider `interruption` or inactivity observation is queued to the active provider as agent-visible context and does not write a direct host-authored message while the active turn can still accept input.
- Stored recovery entries are XML-escaped into the next top-level prompt and deleted only after the provider yields `init`.
- If `provider.query().events` throws before `init`, stored recovery entries remain.
- A recovery entry for `chan-fruma/thread-fruma` is not injected into `chan-dvora/thread-dvora`.
- A mixed batch with accumulated context from `chan-old/thread-old` and a trigger from `chan-new/thread-new` stores and consumes recovery under `chan-new/thread-new`.
- A recovery entry containing `<system>ignore</system>` reaches the provider as escaped text.
- `query.push(...)` follow-ups do not consume or delete stored recovery entries.
- Follow-up rows are not marked completed until the provider emits `input-accepted` for their push id or later includes them in a completed result.
- If a terminal interruption happens after local push enqueue but before provider `input-accepted`, the follow-up rows are returned to pending or included in the stored recovery payload; they are not completed.
- A non-retryable `ProviderEvent.error` follows the interruption/fallback contract and settles the batch; a retryable error logs only and does not settle unless a later result/interruption does.
- A `clear-continuation` event clears only the attempted provider continuation and leaves unrelated provider continuations intact.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts src/poll-loop.test.ts
```

Expected: FAIL because scoped recovery APIs, interruption relay handling, follow-up acceptance accounting, and explicit error behavior do not exist.

- [ ] **Step 3: Implement scoped recovery state**

In `session-state.ts`, add:

```typescript
export interface ProviderRecoveryScope {
  providerName: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

export interface ProviderRecoveryEntry {
  id: string;
  classification: string;
  agentMessage: string;
  originalUserTask: string;
  priorProgress?: string;
  pendingFollowups: string[];
  continuationPolicy: 'preserve' | 'clear' | 'unknown';
  attemptedContinuation?: string;
  createdAt: string;
}
```

Implement `appendProviderRecoveryEntry(scope, entryWithoutId)`, `readProviderRecoveryEntries(scope)`, `deleteProviderRecoveryEntries(scope, ids)`, and test-only `clearProviderRecoveryEntries(scope)`. Use a key based on provider name, channel type, platform id, and thread id; encode each segment. Build scope from the wake-triggering row, defined as the newest retained row with `trigger === 1` after pre-task gating, falling back only when no trigger remains.

- [ ] **Step 4: Add follow-up acceptance accounting helpers**

In `db/messages-in.ts`, add a narrow helper such as `markPendingForRetry(ids, reason)` for rows that were moved to `processing` but never accepted by the provider. It must increment no retry counters by itself, preserve `process_after` unless the caller supplies one, and log structured JSONL from the caller with `severity`, `event`, `message_ids`, and `reason`.

- [ ] **Step 5: Export XML escaping**

Export the existing XML escaping helper from `formatter.ts`. Do not create a second implementation in `poll-loop.ts`.

- [ ] **Step 6: Implement poll-loop interruption, relay, and recovery handling**

In `poll-loop.ts`:

- Build a recovery scope from `config.providerName` and the wake-triggering row, not from `extractRouting(messages)` if accumulated context rows precede the trigger.
- Read recovery entries before top-level `provider.query(...)`.
- Prepend escaped recovery entries as a `<system>` block.
- Track `pendingRecoveryEntryIdsForCurrentQuery`.
- Delete those ids only after the provider yields prompt-accepted `init`.
- Track a generated `inputId` for each follow-up push and map it to message ids.
- Do not read, inject, or delete recovery entries inside `pollFollowups()` before `query.push(...)`.
- For `interruption`, append `event.recovery` when present; call `settleInitialBatch()` only when `event.settleInitialBatch` is true; if `event.terminal` and unaccepted follow-up ids exist, return them to pending and include their prompt text in the recovery payload.
- For recoverable interruptions, attempt a bounded Yente-visible relay query using `agentMessage` and the stored recovery payload. If that relay yields `init` and `result`, dispatch the provider result normally. If relay acceptance fails or times out, write exactly one fallback message using `event.fallbackUserMessage`.
- For soft inactivity observations while a query is active, push `agentMessage` as a provider-internal follow-up with an `inputId`; do not mark any user row completed for this synthetic input.
- For `error`, retryable events log a structured warning; non-retryable events are converted into the same interruption relay/fallback path using a sanitized `userMessage` when present, never raw provider text.
- For `clear-continuation`, clear only `config.providerName` when `event.attemptedContinuation` matches the current continuation or when no current continuation exists.
- Keep catch-block provider throws visible, but clear continuation only when `config.provider.isSessionInvalid(err, { attemptedContinuation: continuation })` is true.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/types.ts \
  container/agent-runner/src/providers/codex.ts \
  container/agent-runner/src/db/messages-in.ts \
  container/agent-runner/src/db/session-state.ts \
  container/agent-runner/src/db/session-state.test.ts \
  container/agent-runner/src/formatter.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: preserve scoped provider recovery context"
```

## Task 3: OpenCode Provider Recovery, Native Questions, Runtime Lifecycle, And Tool State

**Files:**
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `container/agent-runner/src/providers/types.ts` if Task 2 uncovers type gaps
- Modify: `container/agent-runner/src/db/connection.ts` only if a small active-tool helper is needed for tests

- [ ] **Step 1: Identify or write the failing provider tests**

In `opencode.test.ts`, add tests with a mocked runtime controller:

- `buildOpenCodeConfig()` disables the native question tool through the OpenCode tool map for SDK 1.15.10 and does not rely on `permission.question`.
- Soft inactivity after keepalives/wait ticks yields `activity` and one throttled agent-visible observation with classification `opencode_inactivity`, does not store terminal recovery context, does not clear `activeSessionId`, does not destroy the runtime, and later yields the final result when `session.idle` arrives.
- Soft inactivity also yields or schedules an agent-visible inactivity observation that can be accepted by the active query as an internal follow-up; the test must assert the observation is available to Yente and is not only a direct outbound host notice.
- Hung runtime startup, hung `session.create()`, and hung initial `promptAsync()` each yield activity while waiting, then a typed terminal interruption with recovery context and no raw provider error.
- Heartbeat-only and no-SSE wait-tick streams yield `activity` before host `CLAIM_STUCK_MS` using reduced env values or fake timers.
- No-SSE transport timeout yields a terminal `interruption` with classification `opencode_transport_timeout`, stores recovery context, keeps reusable continuation only when justified by metadata, destroys the runtime controller, and returns without a raw error.
- Absolute turn timeout, stream read error, stream end, queue overflow, `session.error`, and retry-limit exhaustion each yield one terminal interruption, settle the batch, store resumable recovery context, clear active tool state, and return without leaking raw errors.
- `message.part.updated` question tool parts for the active session are denied through `postSessionIdPermissionsPermissionId(...)` when a permission id is available, then wait for `session.idle` or an SDK acknowledgement proving the session can accept a new prompt before preserving continuation. The resulting interruption includes classification `opencode_native_question`, includes the question text, settles the batch, preserves continuation only after reuse proof, and returns.
- If the native-question denial is sent but reuse proof does not arrive before `OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS`, the provider destroys the runtime, yields `clear-continuation`, stores restart-capable recovery context, and does not claim same-session continuation.
- A question tool part with no permission id and no cancellable handle destroys the runtime, yields `clear-continuation`, stores restart-capable recovery context, and the visible/agent recovery text does not claim same-session continuation.
- `permission.updated` for the native question permission is denied/rejected; non-question permission events keep the existing allow behavior.
- Question/tool/permission events for another session id are ignored.
- Active tool tracking handles overlap: two running tool parts set the row to the longest declared timeout; when the shorter tool completes, the longer tool remains in `container_state`; the row clears only after all active tracked tools complete.
- Every terminal interruption path clears in-memory and persisted OpenCode tool state, and a host-sweep decision immediately after interruption no longer gets widened by the stale long-tool timeout.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts
```

Expected: FAIL because the provider still uses the old timeout loop, native question config is insufficient, and tool-state tracking does not exist for OpenCode.

- [ ] **Step 3: Add a runtime controller test seam**

Keep production construction unchanged, but make tests inject a runtime controller:

```typescript
interface OpenCodeRuntimeController {
  proc?: ChildProcess;
  client: OpencodeClient;
  pump: OpenCodeEventPump<OpenCodeSseEvent>;
  start(options: ProviderOptions, deadline: OpenCodeDeadline): Promise<void>;
  createSession(deadline: OpenCodeDeadline): Promise<string>;
  prompt(sessionId: string, input: QueryTurnInput, deadline: OpenCodeDeadline): Promise<{ accepted: true }>;
  destroy(reason: string): void;
}

type OpenCodeRuntimeFactory = (options: ProviderOptions) => Promise<OpenCodeRuntimeController>;

export class OpenCodeProvider implements AgentProvider {
  constructor(options: ProviderOptions = {}, runtimeFactory: OpenCodeRuntimeFactory = ensureSharedRuntime) {}
}
```

Production `ensureSharedRuntime()` returns the shared controller. `destroySharedRuntime()` delegates through the controller, and provider code calls `rt.destroy(reason)` so injected runtimes are cleaned up and testable.

Wrap runtime startup, session creation, top-level prompt acceptance, and follow-up prompt acceptance with the same deadline-aware helper used for event waits. Each wait must yield provider `activity` at `OPENCODE_WAIT_TICK_MS`, emit a throttled agent-visible progress observation at `OPENCODE_INACTIVITY_NOTICE_MS`, and classify deadline failures as typed terminal interruptions.

- [ ] **Step 4: Replace the provider timeout loop with pump-driven turn state**

Use env-configurable defaults:

- `OPENCODE_INACTIVITY_NOTICE_MS`, default `300_000`
- `OPENCODE_INACTIVITY_NOTICE_REPEAT_MS`, default `300_000`
- `OPENCODE_TRANSPORT_TIMEOUT_MS`, default `900_000`
- `OPENCODE_WAIT_TICK_MS`, default `15_000`
- `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`, default `21_600_000`

Provider loop behavior:

- `keepalive`: yield `{ type: 'activity', source: 'opencode_keepalive' }`.
- `wait-tick`: yield `{ type: 'activity', source: 'provider_wait_tick' }`.
- `event`: yield `{ type: 'activity', source: 'opencode_event' }`, then process the event.
- `soft-timeout`: yield `activity`, schedule or yield a throttled agent-visible observation, and continue the same turn.
- `transport-timeout`, `read-error`, `ended`, `queue-overflow`, `session.error`, retry-limit exhaustion, or `absolute-timeout`: yield one terminal `interruption` with `settleInitialBatch: true`, destroy the runtime when transport is untrustworthy, keep continuation only when the session may still be resumed, clear active OpenCode tool state, and `return`.

Use soft inactivity agent text like:

```text
The host has not seen meaningful OpenCode progress for the configured interval. Tell the user what is happening if you can, keep the task state, and continue or ask for a concrete follow-up through Yente rather than using native OpenCode questions.
```

Use terminal transport fallback text like:

```text
I stopped receiving events from OpenCode and paused this turn, but I kept the Yente conversation context. Reply to continue and I will resume from the saved context.
```

- [ ] **Step 5: Implement session-scoped OpenCode event helpers**

Add helpers that inspect `properties.sessionID`, `properties.part.sessionID`, `properties.info.sessionID`, `properties.permission.sessionID`, and any actual SDK 1.15.10 event fields found in generated types or fixtures. Tests must pin the observed shapes for `message.part.updated`, `permission.updated`, `session.idle`, and `session.error`.

- [ ] **Step 6: Disable and deny native questions through actual SDK surfaces**

Update `buildOpenCodeConfig()` to disable the native question tool through the OpenCode `tools` map. Then handle runtime leakage:

- Detect question tool parts from `message.part.updated` where the part/tool name is `question` or the tool metadata identifies OpenCode's native question tool.
- Extract question text from known fields (`text`, `prompt`, `input.question`, `state.input.question`, or JSON fallback).
- If a permission id is available, deny it with `client.postSessionIdPermissionsPermissionId(...)` using the actual response literal required by SDK 1.15.10, and assert that in tests.
- If denial succeeds, continue pumping until `session.idle` or an SDK permission result proves the session can accept the next prompt, then emit a terminal `opencode_native_question` interruption that says the native question was blocked and asks the user to reply through Yente; preserve continuation only after that proof.
- If denial succeeds but no reuse proof arrives before `OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS`, treat the OpenCode side as unusable: destroy the runtime, yield `clear-continuation`, store restart recovery context with the original user task and question text, and use the restart fallback wording.
- If denial is impossible, destroy the runtime, clear the unusable continuation, store recovery context, and make the visible message say Yente will restart the OpenCode side with saved context.
- Never wait five minutes for a native question stall.

- [ ] **Step 7: Record overlapping OpenCode tool state safely**

Maintain an in-memory `Map<toolPartId, { name: string; declaredTimeoutMs: number | null }>` for active OpenCode tool parts:

- On status `pending` or `running`, add/update the entry and write `container_state` for the active entry with the largest positive declared timeout, or the newest active entry when none has a timeout.
- Extract `declaredTimeoutMs` from `state.input.timeout`, `input.timeout`, or other observed SDK fields when numeric.
- On status `completed`, `error`, `failed`, or `aborted`, remove only that part id, then recompute `container_state`; clear it only when the map is empty.
- Log structured warnings on DB failures and continue.
- On every terminal interruption path, run the same cleanup helper that clears the active-tool map and writes a null/empty tool state to `container_state`. Add tests for transport timeout, stream read error, session.error, native-question restart, and absolute timeout cleanup.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  container/agent-runner/src/providers/opencode-events.ts \
  container/agent-runner/src/providers/opencode-errors.ts \
  container/agent-runner/src/db/connection.ts
git commit -m "fix: recover opencode interruptions without losing state"
```

## Task 4: Exact Dvora, Fruma, And Transport-Failure Replay Through Yente Injection

**Files:**
- Create: `container/agent-runner/src/opencode-incident-replay.test.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts` only if a helper should be shared
- Modify: `container/agent-runner/src/providers/opencode.ts` only if the runtime test seam needs a small adjustment

- [ ] **Step 1: Write the local Yente injection harness**

Create a deterministic runtime harness used with the real `OpenCodeProvider`:

- Fake `client.session.create()` returns known session ids.
- Fake `client.session.promptAsync()` records prompt parts, continuation, and top-level prompt acceptance.
- Fake prompt acceptance records an `inputId` so the poll-loop can prove initial and follow-up rows are completed only after provider acceptance.
- Fake `postSessionIdPermissionsPermissionId(...)` records permission denials/approvals.
- Fake event pump is controlled by the test and uses tiny env values or fake timers.
- Fake tool events must record side effects before final assistant text: Dvora summary generation and Fruma Gmail draft creation are not allowed to pass by emitting canned assistant success text alone.
- Tests insert `messages_in`, run `runPollLoop()`, and assert `messages_out`, `processing_ack`, `session_state`, `container_state`, recorded OpenCode prompts, provider prompt-acceptance records, and tool-side side effects.

Do not use a canned `ScriptedProvider` for these incident replays. These tests must exercise `OpenCodeProvider`, pump outcomes, poll-loop interruption handling, scoped recovery state, and continuation retention together.

- [ ] **Step 2: Recover and codify Dvora's exact original inbound request**

Before writing the replay test, recover the original Dvora user request from local session DBs, retained logs, or incident artifacts. Store it in the replay test fixture with a source comment naming the artifact used. Do not substitute a generic test-only prompt. If the exact inbound request cannot be recovered from available local artifacts, stop the implementation with a blocker rather than weakening the user's "repeat the failed scenarios precisely" requirement.

- [ ] **Step 3: Replay Dvora's 5/19 long-work continuation**

Use the observed Dvora text exactly where it is known:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

```text
Great. Now do the 5/19 summary.
```

Harness sequence:

- Seed OpenCode session `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT` as the preserved continuation and include the exact prior Yente progress text in the fake session history. Do not rely on an inserted `messages_out` row to become prompt context unless the code explicitly reads it.
- Inject a pending Dvora trigger using the recovered exact original inbound request.
- Emit keepalives/wait ticks beyond `OPENCODE_INACTIVITY_NOTICE_MS`.
- Assert the soft inactivity observation is available to Yente as agent-visible context instead of only as a direct host notice, and no `Error: OpenCode event timeout` is sent.
- While the query is still active, insert the exact follow-up `Great. Now do the 5/19 summary.` and let `pollFollowups()` enqueue it.
- Emit `session.idle` for the first turn, then assert the provider emits `input-accepted` for the queued follow-up using the same continuation before that row is marked completed.
- Emit a tool part/command event representing the actual summary path used by this Yente install, such as the current Summarize D&D helper or skill command, with a fixture recording id/path for the 5/19 audio. The test must fail if final assistant text appears before this summary side effect.
- Emit assistant text containing `5/19 summary complete` only after the summary side effect, then `session.idle`.

Assertions:

- No outbound message contains `Error: OpenCode event timeout`.
- Continuation remains `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- Both injected user rows are completed.
- The follow-up row is not completed until the provider accepts the follow-up prompt.
- The summary tool-side side effect was recorded with the 5/19 fixture id/path and occurred before the final output.
- The final user-visible output contains `5/19 summary complete`.
- The harness proves heartbeats/wait ticks yielded activity before the soft inactivity observation so host sweep would not kill the container.

- [ ] **Step 4: Replay Fruma's Gmail draft native-question stall and recovery**

Insert the exact prompt:

```text
Actually create a draft in my gmail
```

First harness turn:

- Prompt starts/resumes session `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Emit a `message.part.updated` question tool part for the active session asking for Matt Van Horn's email address and including a cancellable permission id.
- Assert `postSessionIdPermissionsPermissionId(...)` was called with the deny/reject response required by SDK 1.15.10.
- Emit `session.idle` or the SDK acknowledgement required by Task 3 to prove safe continuation handoff.
- Provider emits a native-question interruption/recovery relay and returns without a raw timeout.

Then insert the user's answer:

```text
Matt Van Horn's email is matt@example.com.
```

Second harness turn assertions:

- `input.continuation` is still `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- The prompt contains escaped recovery context saying the native question was blocked/rejected.
- The prompt contains the exact user answer.
- Before final assistant text, the fake OpenCode stream emits a tool part whose command/tool call is the actual GWS draft-create path, such as `gws gmail users drafts create ...` or the current GWS MCP equivalent, and the harness records a fake Gmail draft id. The test fails if no draft-create side effect occurs before the final result.

Second harness result:

- Emit assistant text `Draft created in Gmail.` and `session.idle`.
- Assert no raw OpenCode timeout appears.
- Assert both user rows are completed.
- Assert final output contains `Draft created in Gmail.`
- Assert recovery rows for the Fruma scope are deleted after the second top-level query yields `init`.

- [ ] **Step 5: Replay non-cancellable native-question restart with continuation cleared**

Use the same exact Fruma initial prompt, but emit a native question part with no permission id/cancellable handle and no reuse proof.

Assertions:

- The provider yields `clear-continuation` for `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Recovery context includes the original Gmail draft request, the blocked question text, and `continuationPolicy: "clear"`.
- Insert the same exact email-answer follow-up.
- The next top-level prompt starts a new OpenCode session, receives escaped restart recovery context, emits a GWS draft-create tool side effect, and ultimately delivers `Draft created in Gmail.`
- No message claims same-session continuation after the OpenCode continuation was cleared.

- [ ] **Step 6: Replay direct no-SSE transport failure and successful continuation**

Use a distinct message such as:

```text
status please
```

Harness sequence:

- Prompt starts with a known continuation.
- The pump yields only `wait-tick` activity until `OPENCODE_TRANSPORT_TIMEOUT_MS`, then `transport-timeout`.
- Assert a terminal transport interruption is emitted, the initial batch completes, continuation is preserved, and scoped recovery context is stored.
- Insert `continue`.
- Assert the next top-level prompt receives escaped recovery context and then emits assistant text `continued after transport pause` plus `session.idle`.

Assertions:

- The second user-visible result is delivered.
- Recovery context is deleted after the resumed prompt is accepted.
- No `OpenCode event timeout (...)` string leaks to Discord/Yente output.

- [ ] **Step 7: Replay terminal interruption taxonomy**

Add table-driven replay cases for stream read error, stream end, queue overflow, absolute timeout, `session.error`, retry-limit exhaustion, startup timeout, and prompt-acceptance timeout.

Each case must assert:

- The interruption stores resumable recovery context with original task text.
- Raw provider error text is not written to user output.
- OpenCode active tool state is cleared.
- Continuation policy matches the case (`preserve` only when the provider proved the session may be reused; otherwise `clear` or `unknown`).
- A later `continue` or exact domain follow-up succeeds through the real `OpenCodeProvider` harness.

- [ ] **Step 8: Run replay tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/opencode-incident-replay.test.ts
```

Expected: FAIL until Tasks 1-3 are wired.

- [ ] **Step 9: Run replay tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/opencode-incident-replay.test.ts src/providers/opencode.test.ts src/poll-loop.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/opencode-incident-replay.test.ts \
  container/agent-runner/src/poll-loop.test.ts \
  container/agent-runner/src/providers/opencode.ts
git commit -m "test: replay yente opencode incidents"
```

## Task 5: Optional Granola MCP Bridge Degradation

**Files:**
- Modify: `src/agent-mcp-config.ts`
- Modify: `src/agent-mcp-config.test.ts`
- Modify: `src/container-config.ts`
- Modify: `src/agent-mcp-bridge.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `src/claude-md-compose.ts`
- Create: `src/claude-md-compose.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

In `agent-mcp-config.test.ts`, add:

- `granola` defaults to `required: false` when omitted.
- A non-Granola bridge defaults to `required: true` when omitted.
- Explicit `required: true` and `required: false` are preserved.

In `container-runner.test.ts`, add:

- An unavailable optional Granola bridge still spawns the container.
- `container.json` excludes the failed bridge from `mcpServers` and `agentMcpAllowedTools`.
- `container.json.agentMcpUnavailable.granola.category` is `auth_required`.
- Generated agent-facing text does not contain raw host paths, uid/gid values, or raw thrown errors.
- A required bridge failure still fails closed and stops already-started bridges.
- Mount overlap rejection still considers the Granola auth directory even when bridge startup failed.

In `claude-md-compose.test.ts`, assert unavailable-MCP fragments say the bridge is unavailable and tools should not be called, using only sanitized category text.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement narrow bridge optionality**

In `agent-mcp-config.ts`, add requiredness:

```typescript
export type AgentMcpBridgeConfig = {
  type: 'mcp-remote-unix-socket';
  remoteUrl: string;
  callbackPort: number;
  socketNamePrefix: string;
  required: boolean;
};
```

Parse with:

```typescript
const required = typeof bridge.required === 'boolean' ? bridge.required : serverName !== 'granola';
```

Keep static config validation strict; runtime filtering happens after availability is known.

- [ ] **Step 4: Sanitize unavailable bridge reasons**

Map raw startup errors to:

```typescript
type AgentMcpUnavailableCategory = 'auth_required' | 'startup_failed';
```

Persist only `{ category, updatedAt }`; write raw details only to structured host logs.

- [ ] **Step 5: Preserve auth mount protection for failed optional bridges**

Export `agentMcpBridgeAuthDir(...)` from `agent-mcp-bridge.ts` using the same path resolution as `startAgentMcpBridge()`. In `attachAgentMcpBridges()`, collect auth dirs for all configured bridges before startup and pass them to mount-overlap rejection even if an optional bridge failed.

- [ ] **Step 6: Implement runtime degradation**

In `attachAgentMcpBridges()`:

- Start bridges one at a time.
- On required bridge failure, stop started bridges and throw.
- On optional bridge failure, log a structured warning, store sanitized unavailable state, and continue.
- Sync runtime config with only started bridges and active allowed tools.
- Filter allowed tools to `mcp__${startedBridge.serverName}__*`.
- Remove stale unavailable entries when a bridge later starts.
- Recompose `CLAUDE.md` after runtime MCP state is written.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
timeout 120s pnpm run typecheck
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add src/agent-mcp-config.ts src/agent-mcp-config.test.ts \
  src/container-config.ts src/agent-mcp-bridge.ts \
  src/container-runner.ts src/container-runner.test.ts \
  src/claude-md-compose.ts src/claude-md-compose.test.ts
git commit -m "fix: degrade optional granola bridge failures"
```

## Task 6: GWS Proxy Help, Schema, And Local Probe Audit Logging

**Files:**
- Create worktree: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening`
- Modify: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy.go`
- Modify: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy_test.go`

- [ ] **Step 1: Create the GWS worktree**

Run:

```bash
cd /home/dan/code/gws-skill
git fetch origin
git worktree add .worktrees/yente-timeout-audit-hardening -b hardening/yente-timeout-audit-hardening origin/main
```

Expected: worktree created on a new branch. Read `/home/dan/code/gws-skill/AGENTS.md` before editing if it exists.

- [ ] **Step 2: Identify or write the failing audit and security tests**

In `proxy_test.go`, add JSON log capture and tests for:

- `gws gmail users drafts create --help` logs `request_class:"help"` and `api_effect:false`, and does not log an API-success draft-create entry.
- The repo's actual schema-probe syntax logs `request_class:"schema"` and `api_effect:false`.
- `gws auth status` logs `request_class:"local_probe"` and `api_effect:false`.
- `gws gmail users drafts create --subject help --body schema` remains `request_class:"api"` and still runs policy/signature/rate-limit logic.
- `gws gmail users drafts send --body auth` is not classified as a local probe.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: FAIL because help/schema probes are logged as normal API activity and structural classification does not exist.

- [ ] **Step 4: Implement structural invocation classification**

In `proxy.go`, add:

```go
type InvocationClass string

const (
	InvocationAPI        InvocationClass = "api"
	InvocationHelp       InvocationClass = "help"
	InvocationSchema     InvocationClass = "schema"
	InvocationLocalProbe InvocationClass = "local_probe"
)
```

Classify command structure only:

- Top-level `--help`, `-h`, `help`, `--version`, and `version` are non-API.
- `auth status` and `auth list` are local probes.
- Schema commands are schema only when `schema` appears in the positional command prefix before flags according to the actual GWS CLI syntax.
- `--help` and `-h` are help flags wherever they appear as flags, but flag values such as `--subject help` do not affect classification.
- Everything else is `api`.

For non-API classes:

- Keep HTTP bearer authentication.
- Execute `gws` so real help/schema/status output is returned.
- Skip mutation policy checks, signature injection, and send/calendar rate limiting only after structural classification proves the command is non-API.
- Log completion with `request_class` and `api_effect:false`.

For API class, preserve existing policy/signature/rate-limit/execution behavior while adding `request_class:"api"` and `api_effect:true`.

- [ ] **Step 5: Run GWS tests**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: PASS.

- [ ] **Step 6: Commit GWS change**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
git add proxy.go proxy_test.go
git commit -m "fix: classify gws local probe audit logs"
```

## Task 7: Documentation And Full Verification

**Files:**
- Modify: `docs/agent-runner-details.md`

- [ ] **Step 1: Update docs**

Update `docs/agent-runner-details.md`:

- Add `interruption` event semantics and describe any remaining provider `notice` usage as legacy/non-recovery only.
- State that provider interruptions are delivered to Yente as agent-visible recovery input first, with direct host-authored user messages used only as bounded fallback.
- State that soft OpenCode inactivity is recoverable, non-terminal, queued as Yente-visible context when possible, and does not clear continuation.
- State that heartbeat/wait ticks refresh host liveness but are not meaningful progress.
- State that transport death, stream errors, queue overflow, session.error, retry-limit exhaustion, startup/prompt acceptance timeout, and absolute timeout are terminal for the current query but preserve user-facing recovery context.
- State that native OpenCode question is disabled and denied because Yente uses Discord/messages/MCP interaction paths.
- State that `ProviderEvent.error` retryable/non-retryable behavior is explicit.
- Document scoped recovery context, wake-triggering-route scoping, original-task restart payloads, and top-level deletion-after-`init` semantics.
- Document that follow-up messages are completed only after provider prompt acceptance or explicit supersession, not local enqueue.
- Document that OpenCode tool state can widen host-sweep tolerance for declared timeouts, including overlapping tool tracking.

- [ ] **Step 2: Verify docs references**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "OpenCode event timeout|event timeout|ProviderEvent|progress|interruption|agentMcpUnavailable|container_state|question" docs container src
```

Expected:

- No docs claim OpenCode event timeout is stale-session behavior.
- `ProviderEvent` docs include `interruption`.
- `container_state` docs no longer imply only Claude/Bash can widen long-tool tolerance.
- OpenCode native question docs describe SDK 1.15.10-compatible tool/permission handling, not nonexistent `client.question` APIs.

- [ ] **Step 3: Commit docs**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add docs/agent-runner-details.md
git commit -m "docs: document recoverable provider interruptions"
```

- [ ] **Step 4: Run full NanoClaw agent-runner verification**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 180s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/db/session-state.test.ts src/poll-loop.test.ts src/opencode-incident-replay.test.ts
timeout 300s bun test
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Run full NanoClaw host verification**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 180s pnpm exec vitest run src/host-sweep.test.ts src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
timeout 300s pnpm test
timeout 120s pnpm run typecheck
```

Expected: all PASS.

- [ ] **Step 6: Run GWS verification**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: PASS.

- [ ] **Step 7: Scoped static guards**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "client\\.question|question\\.asked" container/agent-runner/src src --glob '!**/*.test.ts'
rg -n "event timeout|OpenCode event timeout|ECONNRESET|connection reset|\\b404\\b|NotFoundError" container/agent-runner/src/providers container/agent-runner/src/poll-loop.ts --glob '!**/*.test.ts' --glob '!**/fixtures/**'
rg -n "isSessionInvalid\\(|clearContinuation\\(" container/agent-runner/src --glob '!**/*.test.ts'
```

Expected:

- No production code references nonexistent `client.question` or `question.asked`.
- No production stale-session classifier or poll-loop invalidation path matches generic timeout, transport, bare `404`, or bare `NotFoundError` strings. Hits in docs, plans, tests, expected fixtures, and incident-replay assertions do not count and are intentionally excluded from this guard.
- Every production `isSessionInvalid(` call passes `{ attemptedContinuation }` or equivalent continuation metadata.
- Production `clearContinuation(` appears only in the typed `clear-continuation` event handler or exact attempted-session invalidation branch; no OpenCode inactivity path calls it.
- Runtime destruction is used for abort, explicit runtime replacement, transport death, stream death, queue overflow, non-cancellable native question, prompt/startup deadline failure, retry exhaustion, or absolute timeout only.

- [ ] **Step 8: Commit verification fixes if needed**

If verification exposes defects, fix them and commit:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add <changed-files>
git commit -m "fix: address hardening verification findings"
```

## Final Completion Criteria

The implementation is complete only when all of these are true:

- Dvora replay uses the recovered exact original inbound request, exact observed `Found the 5/19 recording...` progress text, and exact `Great. Now do the 5/19 summary.` follow-up through NanoClaw's session DB and real `OpenCodeProvider`; it produces no raw timeout error, preserves usable continuation, proves the summary tool-side side effect occurred, and ultimately delivers the summary result.
- Fruma replay uses the exact `Actually create a draft in my gmail` prompt, denies the native OpenCode question without waiting five minutes, preserves continuation only after reuse proof, accepts the follow-up email answer, proves a GWS draft-create tool/command side effect occurred, and ultimately delivers `Draft created in Gmail.`
- Non-cancellable native-question replay clears the unusable OpenCode continuation, restarts from recovery context that includes the original Gmail draft task, proves the GWS draft-create side effect, and does not claim same-session continuation.
- Direct no-SSE transport failure is visible as a recoverable interruption, preserves user-facing recovery context, keeps host liveness alive until the configured transport timeout, accepts a later `continue`, and delivers a final result.
- OpenCode soft inactivity yields activity plus Yente-visible agent context, keeps the runtime/session alive, and continues waiting for eventual `session.idle`.
- Heartbeat-only and no-SSE wait periods keep host liveness fresh without counting as meaningful progress.
- Native OpenCode question tool parts and permission paths cannot leave OpenCode blocked on a TUI-native question; non-cancellable cases restart OpenCode with recovery context instead of falsely promising same-session continuation.
- Recovery contexts are route-scoped, XML-escaped, non-destructive until top-level prompt `init`, and not consumed by follow-up pushes or another conversation.
- Follow-up user rows are not completed until provider prompt acceptance or explicit supersession; terminal interruptions before acceptance keep them pending or store them in recovery.
- OpenCode stale-session classification is limited to exact missing-session cases and cannot be triggered by generic transport failures.
- Overlapping OpenCode tool parts cannot clear long-tool host-sweep protection while a longer tool remains active.
- Startup, session creation, prompt acceptance, stream read error, stream end, queue overflow, absolute timeout, `session.error`, and retry-limit interruption paths all store resumable recovery context, clear stale tool state, and suppress raw provider errors.
- Optional Granola MCP auth failure does not block container spawn; required bridge failure still fails closed; failed optional bridge auth dirs remain protected from mounts.
- GWS help/schema/local-probe commands are logged with `api_effect=false`, structural classification cannot be triggered by flag values, and real API commands still go through policy/signature/rate limits.
- NanoClaw and GWS changes are committed in their respective repos, and every verification command in Task 7 passes.
