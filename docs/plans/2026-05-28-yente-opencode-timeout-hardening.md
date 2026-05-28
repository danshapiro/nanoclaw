# Yente OpenCode Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yente must preserve conversation state and user trust when OpenCode is slow, silent, blocked on a native question, or affected by optional MCP/GWS failures, and the original Dvora and Fruma requests must succeed through the Yente injection path.

**Architecture:** Split OpenCode liveness into a bounded, session-scoped SSE pump and a provider turn state machine. The pump owns transport health and metadata; the provider turns pump results into `activity`, recoverable `notice`, terminal transport notices, or normal `result` events without treating inactivity as stale session corruption. The poll loop owns user delivery and scoped recovery context: every recoverable interruption is routed to the current user, stored per provider plus route, XML-escaped into the next successful provider prompt, and deleted only after that prompt is accepted. Native OpenCode questions are explicitly rejected/canceled through the OpenCode question path before the turn is released, so follow-up user answers resume the same continuation instead of queuing behind a stuck TUI prompt.

**Tech Stack:** TypeScript, Bun tests for `container/agent-runner`, Vitest for host-side NanoClaw, Go tests for `gws-skill`, SQLite session state, OpenCode SDK 1.15.10 event stream.

---

## Scope And Invariants

The requested implementation spans two repositories:

- `/home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening` owns Yente/OpenCode runtime hardening, poll-loop recovery behavior, optional host-managed MCP bridge degradation, exact local incident replay, and docs.
- `/home/dan/code/gws-skill` owns the GWS proxy audit-log correction. Do GWS work in a separate worktree under `/home/dan/code/gws-skill/.worktrees/` and commit it separately.

Do not mutate the live `shapiroserver2` host or run production deploys in this implementation pass. The required "inject requests into Yente" coverage is local but not fake at the wrong layer: insert the exact failed user messages into the NanoClaw session DB, run `runPollLoop()`, use the real `OpenCodeProvider` with a deterministic OpenCode runtime harness, and assert the outbound Yente-visible result. If production deployment is explicitly requested later, repeat the same prompts through the deployed smoke runner after deploy.

Core invariants:

- OpenCode inactivity is not a stale continuation. `continuation:opencode` is cleared only when OpenCode says that exact session id is missing/invalid.
- Generic transport failures such as `ECONNRESET`, plain `404`, or "event timeout" are not session-invalid by themselves.
- Every OpenCode SSE event, including heartbeat/connected events, refreshes host liveness through provider `activity`; heartbeat keeps the container alive but does not count as meaningful model progress.
- A five-minute meaningful-event gap emits a recoverable inactivity notice and continues waiting. It does not destroy the runtime, clear `activeSessionId`, clear continuation, or mark the turn failed.
- A no-SSE transport timeout, stream read error, stream end, or absolute turn ceiling is terminal for the current provider query. It emits a recoverable notice, preserves continuation, destroys the shared runtime when needed, settles the initial user batch, and returns from the provider stream.
- Native OpenCode `question` is an unsupported interaction path for Yente. Reject/cancel it through the OpenCode SDK, emit a recoverable notice with the question text when available, preserve continuation, settle the current user batch, and return so the user's answer can start the next provider turn.
- Provider recovery context is scoped by provider plus route (`platform_id`, `channel_type`, `thread_id`) inside the session DB. It cannot be consumed by another conversation in a shared session.
- Recovery context is never interpolated into XML/system markup without escaping.
- Recovery notices are read non-destructively before a query and deleted only after the provider accepts the prompt by yielding an initial `init`, `activity`, `progress`, or `result` event.
- `ProviderEvent.error` has explicit behavior: retryable errors are logged/progress-only; non-retryable errors are user-visible, settle the current batch, and are not hidden as "completed without sending".
- Optional MCP degradation is narrow: Granola is optional by backward-compatible default, bridges marked `required: false` are optional, and all other bridges fail closed unless explicitly configured otherwise.
- Optional MCP unavailability reasons shown to agents are sanitized categories, not raw errors with host paths, uid/gid values, or auth directory details.
- GWS help/schema/auth/version probes remain authenticated but are classified structurally so flag values like `--subject help` cannot bypass policy, rate limits, signatures, or audit semantics for real API calls.

## File Structure

### NanoClaw Agent Runner

- Create `container/agent-runner/src/providers/opencode-events.ts`
  - Single-reader OpenCode SSE pump.
  - Session-scoped event filtering.
  - Bounded/coalesced queues so idle periods cannot accumulate infinite heartbeats.
  - Result kinds: `event`, `keepalive`, `soft-timeout`, `transport-timeout`, `read-error`, `ended`.
  - Metadata: configured timeout, elapsed time, last event type/time, last meaningful event type/time.

- Create `container/agent-runner/src/providers/opencode-errors.ts`
  - Typed `OpenCodeTransportTimeoutError`, `OpenCodeStreamReadError`, and helpers.
  - Tight stale-session classifier helpers for exact missing-session cases only.

- Modify `container/agent-runner/src/providers/opencode.ts`
  - Use the event pump.
  - Remove timeout-driven `activeSessionId` clearing and `destroySharedRuntime()`.
  - Yield `activity` for every keepalive or meaningful event.
  - Yield recoverable `notice` events for soft inactivity, transport death, stream read errors, absolute turn ceiling, and native question interruptions.
  - Reject/cancel native `question.asked` events and question tool parts.
  - Stop auto-approving native question permissions.
  - Track OpenCode tool starts/stops in `container_state` when tool events expose a declared timeout.
  - Keep structured JSONL logs with `severity`, `event`, `session_id`, `classification`, and timeout metadata.

- Modify `container/agent-runner/src/providers/types.ts`
  - Add structured `notice` event fields.
  - Clarify `error` semantics.

- Modify `container/agent-runner/src/db/session-state.ts`
  - Add scoped recovery notice APIs with generated ids and non-destructive read/delete.

- Modify `container/agent-runner/src/formatter.ts`
  - Export `escapeXml()` for recovery prompt injection.

- Modify `container/agent-runner/src/poll-loop.ts`
  - Load scoped recovery notices before initial and follow-up prompts.
  - Delete recovery notices only after provider prompt acceptance.
  - Dispatch provider notices to `messages_out`.
  - Store recovery context by provider plus route.
  - Move provider event handling into `processQuery()` or pass callbacks so notice/error handling can settle the initial batch.
  - Handle non-retryable `ProviderEvent.error` visibly.

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
  - Keep existing Bash coverage and add OpenCode tool-state coverage.

- Modify `src/agent-mcp-config.ts`
  - Add `required?: boolean` to bridge config.
  - Default only `serverName === 'granola'` to optional for backward compatibility; all other omitted values default to required.

- Modify `src/container-config.ts`
  - Add sanitized `agentMcpUnavailable?: Record<string, { category: string; updatedAt: string }>` runtime state.

- Modify `src/agent-mcp-bridge.ts`
  - Export a helper for the bridge auth directory so mount-overlap checks can include failed optional bridges.

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

## Task 1: OpenCode Event Pump, Transport Errors, And Host Liveness

**Files:**
- Create: `container/agent-runner/src/providers/opencode-events.ts`
- Create: `container/agent-runner/src/providers/opencode-events.test.ts`
- Create: `container/agent-runner/src/providers/opencode-errors.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `src/host-sweep.ts`
- Modify: `src/host-sweep.test.ts`

- [ ] **Step 1: Write failing tests**

In `container/agent-runner/src/providers/opencode.test.ts`, change stale classification coverage:

```typescript
expect(isStaleSessionError(new Error('OpenCode event timeout (300000ms)'))).toBe(false);
expect(isStaleSessionError(new Error('ECONNRESET while reading OpenCode events'))).toBe(false);
expect(isStaleSessionError(new Error('HTTP 404 from OpenCode event stream'))).toBe(false);
expect(isStaleSessionError(new Error('OpenCode promptAsync: session not found'))).toBe(true);
```

In `container/agent-runner/src/providers/opencode-events.test.ts`, add tests for:

- Keepalive events return `kind: 'keepalive'` and update `lastEventType` without updating `lastMeaningfulEventType`.
- Soft timeout returns `kind: 'soft-timeout'` while the underlying stream reader remains alive and later returns `session.idle`.
- No SSE event of any kind before `transportTimeoutMs` returns/throws `OpenCodeTransportTimeoutError` with `sessionId`, `transportTimeoutMs`, `elapsedMs`, `lastEventType`, `lastEventAt`, `lastMeaningfulEventType`, and `lastMeaningfulEventAt`.
- Stream read exceptions surface as `OpenCodeStreamReadError` with the same metadata, not raw user-facing strings.
- Events with another session id do not wake the waiter for the active session.
- Heartbeats while no waiter is active are coalesced, not queued without bound.

Use a deterministic async generator harness:

```typescript
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
```

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

- [ ] **Step 2: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/host-sweep.test.ts
```

Expected: FAIL because `opencode-events.ts` does not exist, timeout/transport strings are still stale, and host sweep only honors `Bash`.

- [ ] **Step 3: Implement typed errors**

In `opencode-errors.ts`:

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
  constructor(
    readonly metadata: Omit<OpenCodeLivenessMetadata, 'configuredTimeoutMs'>,
    readonly cause: unknown,
  ) {
    super(`OpenCode event stream failed for session ${metadata.sessionId}`);
  }
}

export function isMissingOpenCodeSessionError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /session.*not found|no conversation found|NotFoundError/i.test(text);
}
```

Update `isStaleSessionError()` in `opencode.ts` to use `isMissingOpenCodeSessionError()` plus any exact OpenCode missing-session response shape found in tests. Do not include `event timeout`, `connection reset`, `ECONNRESET`, or bare `404`.

- [ ] **Step 4: Implement the event pump**

In `opencode-events.ts`, implement:

```typescript
export type OpenCodeSseEvent = { type?: string; properties: Record<string, unknown> };

export type OpenCodePumpResult<T extends OpenCodeSseEvent> =
  | { kind: 'event'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'keepalive'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'soft-timeout'; metadata: OpenCodeLivenessSnapshot & { configuredTimeoutMs: number; elapsedMs: number } }
  | { kind: 'transport-timeout'; error: OpenCodeTransportTimeoutError }
  | { kind: 'read-error'; error: OpenCodeStreamReadError }
  | { kind: 'ended'; metadata: OpenCodeLivenessSnapshot };

export interface OpenCodePumpOptions<T extends OpenCodeSseEvent> {
  isKeepalive: (event: T) => boolean;
  sessionIdForEvent: (event: T) => string | undefined;
  maxQueuedEventsPerSession?: number;
}
```

Implementation requirements:

- Constructor starts exactly one background `readLoop()`.
- No code outside the pump calls `stream.next()` directly.
- Keepalives are not appended to unbounded queues; keep only latest keepalive metadata and wake active waiters.
- Non-keepalive events are queued by session id. Events without session id are delivered only when they are global/transport events; unrelated session events are ignored for the active waiter.
- `next(sessionId, { softTimeoutMs, transportTimeoutMs, absoluteDeadlineMs })` returns the earliest of a relevant event, keepalive, soft meaningful timeout, transport no-event timeout, absolute deadline, read error, or stream end.
- `lastEvent*` updates on every SSE event. `lastMeaningfulEvent*` updates only on non-keepalive events for the target session.
- A read-loop exception wakes all waiters with `kind: 'read-error'`.
- `close()` calls `stream.return?.(undefined)`, marks the pump closed, and wakes all waiters.

- [ ] **Step 5: Generalize host-sweep declared timeout handling**

In `src/host-sweep.ts`, replace the Bash-only helper with a helper that honors any positive declared timeout:

```typescript
function declaredToolTimeoutMs(containerState: ContainerState | null): number | null {
  if (!containerState) return null;
  const timeout = containerState.tool_declared_timeout_ms;
  return typeof timeout === 'number' && timeout > 0 ? timeout : null;
}
```

Use it for both the absolute ceiling and claim-stuck tolerance. Update comments from Bash-specific to declared-tool-specific while preserving existing Bash test meaning.

- [ ] **Step 6: Run tests green**

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

## Task 2: Provider Notices And Scoped Recovery Context

**Files:**
- Modify: `container/agent-runner/src/providers/types.ts`
- Modify: `container/agent-runner/src/db/session-state.ts`
- Modify: `container/agent-runner/src/db/session-state.test.ts`
- Modify: `container/agent-runner/src/formatter.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`

- [ ] **Step 1: Write failing contract tests**

In `providers/types.ts`, plan for this event shape:

```typescript
export type ProviderNoticeSeverity = 'info' | 'warn' | 'error';

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string; userMessage?: string }
  | { type: 'progress'; message: string }
  | {
      type: 'notice';
      severity: ProviderNoticeSeverity;
      classification: string;
      message: string;
      recoveryContext?: string;
      settleInitialBatch?: boolean;
    }
  | { type: 'activity' };
```

In `session-state.test.ts`, add tests for:

- FIFO append/read/delete with generated ids.
- Scope isolation by provider plus route.
- Malformed stored JSON is deleted and returns `[]`.
- Reading notices is non-destructive; deleting by ids removes only those ids.

Use a scope value shaped like:

```typescript
const frumaScope = {
  providerName: 'opencode',
  platformId: 'chan-fruma',
  channelType: 'discord',
  threadId: 'thread-fruma',
};
```

In `poll-loop.test.ts`, add tests for:

- A recoverable provider `notice` writes a user-visible outbound message, stores scoped recovery context, settles the initial batch when requested, and preserves continuation.
- Stored recovery notices are XML-escaped into the next prompt and deleted only after the provider yields `init` or `activity`.
- If `provider.query().events` throws before any acceptance event, the stored recovery notices remain for the next attempt.
- A recovery notice for `chan-fruma/thread-fruma` is not injected into a later `chan-dvora/thread-dvora` prompt in a shared session DB.
- A notice message containing `<system>ignore</system>` reaches the provider as escaped text.
- A non-retryable `ProviderEvent.error` writes one visible error and settles the batch; a retryable error logs only and does not settle unless a later result/notice does.

- [ ] **Step 2: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts src/poll-loop.test.ts
```

Expected: FAIL because scoped recovery APIs, notice handling, and error handling do not exist.

- [ ] **Step 3: Implement scoped recovery state**

In `session-state.ts`, add:

```typescript
export interface ProviderRecoveryScope {
  providerName: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

export interface ProviderRecoveryNotice {
  id: string;
  classification: string;
  message: string;
  createdAt: string;
}
```

Implement:

- `appendProviderRecoveryNotice(scope, noticeWithoutId): ProviderRecoveryNotice`
- `readProviderRecoveryNotices(scope): ProviderRecoveryNotice[]`
- `deleteProviderRecoveryNotices(scope, ids: string[]): void`
- `clearProviderRecoveryNotices(scope): void` for tests only if needed

Use a key like:

```typescript
function recoveryNoticeKey(scope: ProviderRecoveryScope): string {
  return [
    'recovery-notices',
    scope.providerName.toLowerCase(),
    scope.channelType ?? '',
    scope.platformId ?? '',
    scope.threadId ?? '',
  ].map(encodeURIComponent).join(':');
}
```

Keep at most the most recent 10 notices per scope.

- [ ] **Step 4: Export XML escaping**

In `formatter.ts`, export the existing helper:

```typescript
export function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

Do not create a second escaping implementation in `poll-loop.ts`.

- [ ] **Step 5: Implement poll-loop notice and recovery handling**

In `poll-loop.ts`:

- Build a recovery scope from `config.providerName` and `extractRouting(messages)`.
- Before the initial prompt, call `readProviderRecoveryNotices(scope)` but do not delete.
- Prepend notices with escaped XML:

```typescript
function prependRecoveryNotices(prompt: string, notices: ProviderRecoveryNotice[]): string {
  if (notices.length === 0) return prompt;
  const lines = notices.map(
    (notice) =>
      `  <event created_at="${escapeXml(notice.createdAt)}" classification="${escapeXml(notice.classification)}">` +
      `${escapeXml(notice.message)}</event>`,
  );
  return `<system>\nPrevious recoverable provider events for this conversation:\n${lines.join('\n')}\nUse this context to explain and resume without losing the thread.\n</system>\n\n${prompt}`;
}
```

- Pass the augmented prompt into `provider.query`.
- Delete the included notice ids only after the provider yields `init`, `activity`, `progress`, or `result`.
- Apply the same read/prepend/delete-on-accepted logic to follow-up prompts in `pollFollowups()`.
- Move `handleEvent()` inside `processQuery()` or pass callbacks so `notice` and `error` branches can call `settleInitialBatch()`.
- For `notice`:
  - Write a `messages_out` chat row to the current route using `event.message`.
  - If `event.recoveryContext` is present, append it to the scoped recovery queue.
  - If `event.settleInitialBatch`, call `settleInitialBatch()`.
- For `error`:
  - If `retryable`, log as structured warning and continue.
  - If non-retryable, write `event.userMessage ?? "Error: " + event.message`, call `settleInitialBatch()`, and continue until the provider stream returns.
- Keep catch-block provider throws visible, but do not clear continuation unless `config.provider.isSessionInvalid(err)` is true.

- [ ] **Step 6: Run targeted tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/types.ts \
  container/agent-runner/src/db/session-state.ts \
  container/agent-runner/src/db/session-state.test.ts \
  container/agent-runner/src/formatter.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: preserve scoped provider recovery context"
```

## Task 3: Wire OpenCode Provider Recovery, Native Questions, And Tool State

**Files:**
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `container/agent-runner/src/providers/types.ts` if Task 2 uncovered type gaps
- Modify: `container/agent-runner/src/db/connection.ts` only if a small helper is needed for tests

- [ ] **Step 1: Write failing provider tests**

In `opencode.test.ts`, add tests using a mocked `SharedRuntime`/OpenCode client seam:

- Soft inactivity after heartbeats yields `activity` and one `notice` with classification `opencode_inactivity`, includes recovery context, does not clear `activeSessionId`, does not call `destroySharedRuntime()`, and later yields the final result when `session.idle` arrives.
- Heartbeat-only streams yield `activity` before the soft notice often enough that `touchHeartbeat()` callers can keep host liveness fresh.
- Repeated soft notices are throttled to one per `OPENCODE_INACTIVITY_NOTICE_MS` interval.
- No-SSE transport timeout yields a terminal `notice` with classification `opencode_transport_timeout`, metadata for configured timeout/elapsed/last event/last meaningful event, keeps continuation, destroys the shared runtime, and returns from the generator without a follow-on raw error.
- Absolute turn timeout yields classification `opencode_absolute_turn_timeout`, destroys runtime, keeps continuation, and returns.
- Stream read errors yield classification `opencode_stream_error`, keep continuation, destroy runtime, and return.
- `question.asked` for the active session calls `client.question.reject()` with a Yente-specific reason, yields classification `opencode_native_question`, includes the question text in both visible message and recovery context, settles the initial batch, and returns.
- `message.part.updated` question tool parts are handled even when the session id lives on `part.sessionID` instead of `properties.sessionID`.
- Question or question-permission events for a different session id are ignored.
- `permission.updated` for the native question permission is denied/rejected, while non-question permission events keep the existing allowed behavior.
- OpenCode tool running/completed parts call `setContainerToolInFlight()` and `clearContainerToolInFlight()` with declared timeout metadata when available.

- [ ] **Step 2: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts
```

Expected: FAIL because the provider still uses the old timeout loop and has no native-question handling.

- [ ] **Step 3: Add an OpenCode runtime test seam**

Keep production construction unchanged, but make tests able to inject a runtime:

```typescript
type OpenCodeRuntimeFactory = (options: ProviderOptions) => Promise<SharedRuntime>;

export class OpenCodeProvider implements AgentProvider {
  constructor(options: ProviderOptions = {}, runtimeFactory: OpenCodeRuntimeFactory = ensureSharedRuntime) {
    this.options = options;
    this.runtimeFactory = runtimeFactory;
  }
}
```

Do not expose this through provider registry; registry still calls `new OpenCodeProvider(opts)`.

- [ ] **Step 4: Replace timeout loop with pump-driven turn state**

In `ensureSharedRuntime()`, create the pump:

```typescript
const pump = new OpenCodeEventPump(stream, {
  isKeepalive: isOpenCodeKeepaliveEvent,
  sessionIdForEvent: sessionIdForOpenCodeEvent,
  maxQueuedEventsPerSession: 500,
});
```

Extend `SharedRuntime` with `pump`, and have `destroySharedRuntime()` close it.

In the provider event loop:

- Defaults:
  - `OPENCODE_INACTIVITY_NOTICE_MS`, default `300_000`
  - `OPENCODE_TRANSPORT_TIMEOUT_MS`, default `900_000`
  - `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`, default `21_600_000`
  - `OPENCODE_NATIVE_QUESTION_SETTLE_MS`, default `5_000`
- For `keepalive`: yield `{ type: 'activity' }`.
- For `event`: yield `{ type: 'activity' }`, then process event.
- For `soft-timeout`: yield `{ type: 'activity' }`, yield a throttled `notice`, and continue the same turn.
- For `transport-timeout`, `read-error`, `ended`, or absolute deadline: yield one terminal `notice` with `settleInitialBatch: true`, destroy runtime when the transport is no longer trustworthy, keep `activeSessionId`, and `return`.

Use visible inactivity text like:

```text
I stopped receiving useful progress from OpenCode, but I kept the Yente session state. Long work may still be running; reply with extra context or ask me to continue.
```

Use recovery context like:

```text
OpenCode inactivity: no meaningful event for 300000ms in session ses_..., last event server.heartbeat at ..., last meaningful message.part.updated at ...
```

- [ ] **Step 5: Implement session-scoped OpenCode event helpers**

Add helpers in `opencode.ts`:

```typescript
function sessionIdForOpenCodeEvent(ev: { type?: string; properties: Record<string, unknown> }): string | undefined {
  const props = ev.properties as Record<string, unknown>;
  if (typeof props.sessionID === 'string') return props.sessionID;
  const part = props.part as Record<string, unknown> | undefined;
  if (part && typeof part.sessionID === 'string') return part.sessionID;
  const info = props.info as Record<string, unknown> | undefined;
  if (info && typeof info.sessionID === 'string') return info.sessionID;
  const question = props as Record<string, unknown>;
  if (typeof question.sessionID === 'string') return question.sessionID;
  return undefined;
}
```

Update as needed after inspecting the installed SDK generated types. Tests must prove `message.part.updated` and `question.asked` are session-scoped correctly.

- [ ] **Step 6: Reject native questions**

Handle both event paths:

- `question.asked`
- `message.part.updated` where the part is a running/pending question tool

Extract the question text from known fields (`text`, `prompt`, `input.question`, `state.input.question`, or JSON fallback). Then:

```typescript
await rejectOpenCodeQuestion(client, sessionId, questionId, questionText);
yield {
  type: 'notice',
  severity: 'warn',
  classification: 'opencode_native_question',
  message: questionText
    ? `OpenCode tried to ask a native question: ${questionText}\n\nI kept the session state. Reply with the answer and I will continue.`
    : 'OpenCode tried to ask a native question. I kept the session state. Reply with the answer and I will continue.',
  recoveryContext: questionText
    ? `OpenCode native question was blocked and rejected: ${questionText}`
    : 'OpenCode native question was blocked and rejected.',
  settleInitialBatch: true,
};
return;
```

`rejectOpenCodeQuestion()` should prefer the SDK `client.question.reject(...)` API. If a question id is not available from a tool-part event, deny the corresponding permission if present, emit the notice, and return. Do not wait five minutes for question stalls.

- [ ] **Step 7: Stop auto-approving question permissions**

Replace unconditional permission `response: 'always'` with:

- Deny/reject permissions whose metadata/tool name is `question`.
- Auto-approve only the non-question permission events that existing tests already expect.
- Log structured warnings if permission replies fail, but do not convert the warning to a raw user-visible error unless it blocks the active turn.

- [ ] **Step 8: Record OpenCode tool state**

On tool-part status transitions:

- When status is `pending` or `running`, call `setContainerToolInFlight("OpenCode:" + toolName, declaredTimeoutMs)`.
- Extract `declaredTimeoutMs` from known fields such as `state.input.timeout` or `input.timeout` when numeric.
- When status is `completed`, `error`, `failed`, or `aborted`, call `clearContainerToolInFlight()`.
- Keep this best-effort. Log structured warnings on DB failures and continue.

- [ ] **Step 9: Run targeted tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  container/agent-runner/src/providers/opencode-events.ts \
  container/agent-runner/src/providers/opencode-errors.ts \
  container/agent-runner/src/db/connection.ts
git commit -m "fix: recover opencode interruptions without losing state"
```

## Task 4: Exact Dvora And Fruma Incident Replay Through Yente Injection

**Files:**
- Create: `container/agent-runner/src/opencode-incident-replay.test.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts` only if a helper should be shared
- Modify: `container/agent-runner/src/providers/opencode.ts` only if the runtime test seam needs a small adjustment

- [ ] **Step 1: Write the replay harness**

Create a deterministic OpenCode runtime harness used with the real `OpenCodeProvider`:

- Fake `client.session.create()` returns known session ids.
- Fake `client.session.promptAsync()` records prompt parts and returns success for the requested session.
- Fake `client.question.reject()` records rejected native questions.
- Fake event stream is an async generator controlled by the test.
- The test inserts messages into the in-memory NanoClaw session DB and runs `runPollLoop()` with the real provider instance.

Do not use a canned `ScriptedProvider` for these incident replays. These tests must exercise `OpenCodeProvider`, the pump, poll-loop notice handling, scoped recovery state, and continuation retention together.

- [ ] **Step 2: Replay Dvora 5/19 long work**

Insert the prior outbound context exactly:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

Insert the exact user follow-up:

```text
Great. Now do the 5/19 summary.
```

Harness events:

- `init`/prompt starts session `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- Emit `server.heartbeat` events across more than `OPENCODE_INACTIVITY_NOTICE_MS`.
- Emit a meaningful assistant text part with `5/19 summary complete`.
- Emit `session.idle`.

Assertions:

- The inbound user row is completed.
- No outbound message contains `Error: OpenCode event timeout`.
- At least one outbound notice explains preserved state if no prior user-visible result was sent during the wait.
- `continuation:opencode` remains `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- The final user-visible output contains `5/19 summary complete`.
- The harness proves the provider yielded `activity` for heartbeats before the soft notice.

- [ ] **Step 3: Replay Fruma Gmail draft native question**

Insert the exact user prompt:

```text
Actually create a draft in my gmail
```

First harness turn:

- Prompt starts/resumes session `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Emit `question.asked` for the active session with text asking for Matt Van Horn's email address.
- Assert `client.question.reject()` was called.
- Provider emits a visible native-question notice and returns.

Then insert the user's answer:

```text
Matt Van Horn's email is matt@example.com.
```

Second harness turn assertions before returning a result:

- `input.continuation` is still `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- The prompt contains escaped recovery context saying the native question was blocked/rejected.
- The prompt contains the exact user answer.

Second harness emits assistant text `Draft created in Gmail.` and `session.idle`.

Final assertions:

- No raw OpenCode timeout appears.
- Both user rows are completed.
- Final output contains `Draft created in Gmail.`
- Recovery notice rows for the Fruma scope are deleted after the second prompt is accepted.

- [ ] **Step 4: Replay direct no-SSE transport failure**

Add a third replay using a different exact chat message like `status please`:

- Prompt starts with a known continuation.
- The event stream produces no SSE events until `OPENCODE_TRANSPORT_TIMEOUT_MS`.
- Assert a terminal transport notice is sent, the initial batch completes, continuation is preserved, and the next injected `continue` message receives the scoped recovery context.

- [ ] **Step 5: Run replay tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/opencode-incident-replay.test.ts
```

Expected: FAIL until Tasks 1-3 are wired.

- [ ] **Step 6: Run replay tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/opencode-incident-replay.test.ts src/providers/opencode.test.ts src/poll-loop.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Write failing tests**

In `agent-mcp-config.test.ts`, add:

- `granola` defaults to `required: false` when omitted.
- A non-Granola bridge defaults to `required: true` when omitted.
- Explicit `required: true` and `required: false` are preserved.

In `container-runner.test.ts`, add tests that:

- An unavailable optional Granola bridge still spawns the container.
- `container.json` excludes the failed bridge from `mcpServers` and `agentMcpAllowedTools`.
- `container.json.agentMcpUnavailable.granola.category` is `auth_required`.
- The generated agent-facing text does not contain raw host paths, uid/gid values, or the raw thrown error.
- A required bridge failure still fails closed and stops already-started bridges.
- Mount overlap rejection still considers the Granola auth directory even when bridge startup failed before returning an `AgentMcpBridge`.

In `claude-md-compose.test.ts`, assert unavailable-MCP fragments say the bridge is unavailable and tools should not be called, using only sanitized category text.

- [ ] **Step 2: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement narrow bridge optionality**

In `agent-mcp-config.ts`, extend the type:

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
const required =
  typeof bridge.required === 'boolean' ? bridge.required : serverName !== 'granola';
```

Keep `validateMergedConfig()` strict: configured `allowedTools` still must match configured bridge servers. Runtime filtering happens after availability is known.

- [ ] **Step 4: Sanitize unavailable bridge reasons**

In `container-runner.ts`, convert raw startup errors to categories:

```typescript
type AgentMcpUnavailableCategory = 'auth_required' | 'startup_failed';

function classifyBridgeStartupFailure(err: unknown): AgentMcpUnavailableCategory {
  const message = err instanceof Error ? err.message : String(err);
  return /auth required/i.test(message) ? 'auth_required' : 'startup_failed';
}
```

Persist only `{ category, updatedAt }`.

- [ ] **Step 5: Preserve auth mount protection for failed optional bridges**

In `agent-mcp-bridge.ts`, export:

```typescript
export function agentMcpBridgeAuthDir(options: {
  dataDir?: string;
  agentGroupId: string;
  serverName: string;
}): string;
```

Use the same path resolution as `startAgentMcpBridge()`. In `attachAgentMcpBridges()`, collect auth dirs for all configured bridges before startup and pass them to `rejectAuthOverlappingMounts()` after all ordinary mounts are assembled, even if an optional bridge failed.

- [ ] **Step 6: Implement runtime degradation**

In `attachAgentMcpBridges()`:

- Start bridges one at a time.
- On required bridge failure, stop started bridges and throw.
- On optional bridge failure, log a structured warning with raw error only in host logs, store sanitized unavailable state, and continue.
- Call `syncAgentMcpRuntimeConfig()` with started bridges, active allowed tools, and unavailable map.
- Filter allowed tools to `mcp__${startedBridge.serverName}__*`.
- Remove stale unavailable entries when a bridge later starts successfully.
- Re-compose `CLAUDE.md` after runtime MCP state is written and before mounts are finalized.

In `claude-md-compose.ts`, add a fragment like:

```markdown
## Unavailable MCP bridge: granola

The `granola` MCP bridge is unavailable for this container run (`auth_required`).

Do not call `mcp__granola__*` tools. If the user asks for Granola-backed work, say Granola is currently unavailable and continue with any non-Granola work you can do.
```

- [ ] **Step 7: Run targeted tests green**

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

Expected: worktree created on a new branch.

- [ ] **Step 2: Write failing audit and security tests**

In `proxy_test.go`, add JSON log capture and tests for:

- `gws gmail users drafts create --help` logs `request_class:"help"` and `api_effect:false`, and does not log an API-success `executed` entry.
- `gws schema gmail users drafts create` or the repo's actual schema-probe syntax logs `request_class:"schema"` and `api_effect:false`.
- `gws auth status` logs `request_class:"local_probe"` and `api_effect:false`.
- `gws gmail users drafts create --subject help --body schema` remains `request_class:"api"` and still runs policy/signature/rate-limit logic.
- `gws gmail users drafts send --body auth` is not classified as a local probe.

- [ ] **Step 3: Run tests red**

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

Implement classification over command structure only:

- Treat top-level `--help`, `-h`, `help`, `--version`, and `version` as non-API.
- Treat `auth status` and `auth list` as `local_probe`; do not treat arbitrary flag values containing `auth` as local probes.
- Treat schema commands only when `schema` appears in the positional command prefix before flags according to the actual GWS CLI syntax.
- Treat `--help` and `-h` as help flags wherever they appear as flags, but do not inspect the value after flags such as `--subject help`.
- Return `api` for everything else.

Use the classifier before audit logging:

```go
requestClass := classifyInvocation(req.Args)
apiEffect := requestClass == InvocationAPI
```

For non-API classes:

- Keep HTTP bearer authentication.
- Execute `gws` so real help/schema/status output is returned.
- Skip mutation policy checks, signature injection, and send/calendar rate limiting only because the structural classifier proved the command is non-API.
- Log completion as `local_cli_executed` or `executed` with `api_effect:false`; tests must pin the chosen name.

For `api` class, keep existing policy, ownership, signature, rate-limit, execution, and audit behavior, while adding `request_class:"api"` and `api_effect:true`.

- [ ] **Step 5: Run GWS tests green**

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

- Add `notice` event semantics.
- State that OpenCode inactivity is recoverable and does not clear continuation.
- State that heartbeat events refresh host liveness but are not meaningful progress.
- State that transport death/stream errors/absolute timeout are terminal for the current query but preserve continuation and recovery context.
- State that native OpenCode `question` is rejected because Yente uses Discord/messages/MCP interaction paths.
- State that `ProviderEvent.error` retryable/non-retryable behavior is explicit.
- Document scoped recovery context and deletion-after-acceptance semantics.

- [ ] **Step 2: Verify docs references**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "OpenCode event timeout|event timeout|ProviderEvent|progress|notice|agentMcpUnavailable|container_state" docs container src
```

Expected:

- No docs claim OpenCode event timeout is stale-session behavior.
- `ProviderEvent` docs include `notice`.
- `container_state` docs no longer imply only Claude/Bash can widen long-tool tolerance.

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

- [ ] **Step 7: Static guards**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "event timeout|OpenCode event timeout|destroySharedRuntime\\(|clearContinuation\\(|isSessionInvalid|ECONNRESET|connection reset|\\b404\\b" container/agent-runner/src src docs
```

Expected:

- Any remaining `OpenCode event timeout` string is in tests asserting it is not stale or not leaked.
- No OpenCode inactivity path calls `clearContinuation`.
- `destroySharedRuntime()` is used for abort, explicit runtime replacement, transport death, stream death, or absolute timeout only.
- Generic transport/status substrings are not stale-session patterns.

- [ ] **Step 8: Commit verification fixes if needed**

If verification exposes defects, fix them and commit:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add <changed-files>
git commit -m "fix: address hardening verification findings"
```

## Final Completion Criteria

The implementation is complete only when all of these are true:

- Dvora replay with the exact 5/19 Drive-recording wording is injected through NanoClaw's session DB, runs through `runPollLoop()` plus the real `OpenCodeProvider`, produces no raw timeout error, preserves continuation, and ultimately delivers the summary result.
- Fruma replay with `Actually create a draft in my gmail` is injected through the same path, rejects the native OpenCode question without waiting five minutes, preserves continuation, accepts the follow-up email answer, and ultimately delivers `Draft created in Gmail.`
- Direct no-SSE transport failure is visible to the user as a recoverable notice, preserves continuation, stores scoped recovery context, and does not leak `OpenCode event timeout (...)`.
- OpenCode soft inactivity yields `activity` plus a structured notice, keeps the runtime/session alive, and continues waiting for eventual `session.idle`.
- Heartbeat-only OpenCode streams keep host liveness fresh without counting as meaningful progress.
- Native OpenCode `question.asked`, question tool parts, and question permission paths cannot leave OpenCode blocked on a TUI-native question.
- Recovery notices are route-scoped, XML-escaped, non-destructive until prompt acceptance, and not consumed by another conversation.
- Optional Granola MCP auth failure does not block container spawn; required bridge failure still fails closed; failed optional bridge auth dirs remain protected from mounts.
- GWS help/schema/local-probe commands are logged with `api_effect=false`, structural classification cannot be triggered by flag values, and real API commands still go through policy/signature/rate limits.
- NanoClaw and GWS changes are committed in their respective repos, and all verification commands in Task 7 pass.
