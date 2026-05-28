# Yente OpenCode Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yente must survive slow OpenCode work, OpenCode inactivity/transport failures, native OpenCode question stalls, optional Granola credential failures, and misleading GWS probe audit logs without losing user state; the observed Dvora and Fruma failures must be replayed by injecting the same requests into local Yente and proving they ultimately succeed.

**Architecture:** Providers emit typed activity, prompt-acceptance, side-effect, continuation, and interruption events; they do not store recovery state or decide message-row lifecycle. The poll loop owns route-normalized recovery state, input ledgers, row acks, Yente-authored relay attempts, and fallback notices. OpenCode gets a single-reader SDK 1.15.10 event pump with long-work liveness, native-question denial, side-effect capture, and explicit continuation policy.

**Tech Stack:** TypeScript, Bun tests for `container/agent-runner`, Vitest for host-side NanoClaw, Go tests for `gws-skill`, SQLite session state, OpenCode SDK 1.15.10 event stream.

---

## Scope And Strategy

This work intentionally spans two repositories because the user's request includes both Yente state preservation and the GWS audit-log confusion found during root-cause analysis.

- NanoClaw work happens in `/home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening`.
- GWS audit-log work happens in a new `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening` worktree.
- Do not mutate the live `shapiroserver2` host or run production deploys.
- The required "inject requests into Yente" validation is local: insert `messages_in` rows, run `runPollLoop()`, use the real `OpenCodeProvider` against a deterministic OpenCode runtime harness, and assert `messages_out`, `processing_ack`, `session_state`, `container_state`, provider events, and tool side effects.
- Do not create a separate test-plan artifact. The executable replay and failure-mode requirements below are implemented as automated tests in the implementation tasks.

## Non-Negotiable Acceptance Contracts

A fresh readiness review should start here. The implementation details below may change during execution, but these contracts must not be weakened, replaced by synthetic provider-only checks, or satisfied by assistant text that is not backed by provider events, row lifecycle, recovery state, and tool-side evidence.

### Dvora Replay Contract

Automated local Yente injection must model both observed Dvora failures as one user-visible recovery sequence:

- The first failure path uses session `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- The replay emits the observed progress message through Yente-visible output, not seeded hidden history:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

- The old 300s meaningful-event timeout point produces a Yente-visible relay or terminal recoverable pause. It never clears continuation by stale-session heuristic, never marks the user turn done as a raw error, and never writes `OpenCode event timeout` to user output.
- If the exact inbound request before the progress message can be recovered from local logs or artifacts, use it as the fixture and cite that evidence in a test comment. If it cannot be recovered, state that evidence boundary in the fixture and use the transcript-provided progress line plus follow-up as the minimum exact replay. Implementation must not block on unavailable logs.
- The later follow-up is injected exactly:

```text
Great. Now do the 5/19 summary.
```

- The second historical path uses session `ses_19757b6f7ffeYulTtPz3gteQ84` and must also avoid raw timeout output and state loss.
- Final success is through Yente: the replay proves the original task, progress, continuation or restart recovery context, follow-up row, and Dvora summary side effect survive until the 5/19 summary is delivered.

### Fruma Replay Contract

Automated local Yente injection must model the May 24 Fruma Gmail draft failure:

- The initial user row is exactly:

```text
Actually create a draft in my gmail
```

- The replay uses session `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- GWS help/schema probe events occur before draft creation, including a `gws gmail users drafts create --help`-style probe that previously produced misleading audit records.
- Native OpenCode question handling is modeled with SDK 1.15.10 event shapes: `message.part.updated` carries a `ToolPart.callID` or equivalent part id, while `permission.updated` carries `Permission.callID` and `Permission.id` where available. Tests must correlate those fields; no fake `question.asked` API may appear in production code or acceptance fixtures.
- Yente visibly asks for Matt Van Horn's email before the test injects the answer. The test must fail if the answer is injected before a visible Yente question exists.
- The injected answer allows Gmail draft creation to complete. The test must assert tool-side draft creation evidence, not only final assistant text.
- GWS probe audit records are classified as non-API probes with `api_effect:false`, while the actual draft creation remains an API effect. This is audit classification only; command admission, authentication, policy, signature, and rate-limit behavior are not broadened.

### Inactivity Visibility Contract

The previous 300s no-meaningful-event condition is a user-visible recovery moment, not hidden context and not a host-authored raw error. It must be implemented as either:

- a bounded Yente-authored relay turn that is independent of the busy OpenCode turn becoming available; or
- a terminal recoverable pause that gives Yente enough recovery context to tell the user how to continue before any direct host fallback is sent.

The implementation must not queue a message into the same busy OpenCode turn and wait for that turn to process it before the user sees anything.

### Side-Effect And External-Failure Contract

Completed side effects before final assistant output are recovery facts. Gmail draft creation and Dvora summary artifact creation must be recorded with enough sanitized evidence to prevent duplicate work on retry. Terminal failure after a side effect but before final output, host-sweep kill/reset, container crash, provider startup failure, session creation failure, prompt-acceptance failure, and pre-query failure after row claim must all produce durable route-scoped recovery or a user-visible fallback without raw provider errors.

## State Lifecycle Contract

Provider code emits typed facts only. The poll loop owns route-scoped recovery, message-row lifecycle, relay/fallback behavior, and recovery resolution. The required transitions are:

| State source | Owner | Required transition |
| --- | --- | --- |
| Raw wake rows | Poll loop | Split by normalized route before claim; same-route triggers become ordered `originalTasks`; other routes remain pending. |
| Top-level and follow-up prompts | Poll loop plus provider fact | Generate `inputId`; treat prompt as accepted only after provider `input-accepted` for that exact id. |
| Accepted but unresolved rows | Poll loop | Move to recovery-owned ledger/ack on terminal interruption; complete only after successful result or explicit supersession. |
| Unaccepted route-matched follow-ups | Poll loop | Return to pending or store in recovery with message ids; never hide behind stale `processing` acks. |
| Unaccepted other-route rows | Poll loop | Return to pending and exclude from the active route's recovery payload. |
| Recovery entries | Poll loop | Store from raw rows, progress, follow-ups, accepted/unresolved inputs, side effects, provider interruption metadata, and safe tool state; do not delete on prompt acceptance. |
| Recovery `in_flight` entries | Poll loop | Retain until successful result, explicit supersession with an enriched replacement, or explicit completed recovery outcome; enrich on relay/retry failure. |
| Inactivity notices | Provider fact, poll-loop action | Provider reports liveness metadata; poll loop relays through Yente or terminal recoverable pause without clearing continuation by heuristic. |
| Continuation clearing | Provider fact, poll-loop storage | Clear only on exact attempted-session missing proof or explicit provider `clear-continuation`; transport errors, bare `404`, `ECONNRESET`, stream end, and event timeout text are not proof. |
| Side effects | Provider fact, poll-loop recovery | Persist sanitized evidence before final result; retry prompts must tell Yente what already happened and tests must fail on duplicate draft/summary creation. |
| Recovery relay turns | Poll loop | Disable normal all-session follow-up polling or route-filter it strictly so unrelated conversations remain pending. |

The central design rule is ownership separation:

- Providers own SDK I/O and only emit facts: activity, prompt acceptance, side effects observed from SDK/tool events, typed interruptions, and explicit continuation policy.
- The poll loop owns recovery context. It builds recovery from raw wake rows, route-scoped follow-ups, user-visible progress, side-effect ledger entries, provider interruption metadata, and safe tool state.
- Recovery is not consumed when the provider merely accepts a prompt. It is marked `in_flight` for that `inputId` and resolved only after a successful provider result or explicit supersession. If the recovery attempt fails, hangs, is interrupted, or the container dies, the original recovery payload remains available and may be enriched, not deleted.

## Hard Invariants

- OpenCode SDK 1.15.10 does not expose `client.question.*` or a `question.asked` event. Native-question handling must use real SDK event shapes: correlate `message.part.updated` `ToolPart.callID` or equivalent part ids with `permission.updated` `Permission.callID` / `Permission.id`, and deny via `postSessionIdPermissionsPermissionId(...)` when possible.
- `buildOpenCodeConfig()` must disable the native question tool through OpenCode tool availability, not only through `permission.question`.
- OpenCode inactivity, transport errors, bare `404`, `ECONNRESET`, stream end, queue overflow, and "event timeout" text are not stale-session proof. Continuation is cleared only on exact missing-session evidence for the attempted continuation or an explicit provider `clear-continuation` event.
- The previous 300s "meaningful event" watchdog becomes a user-visible inactivity notice, not a raw error and not stale-session handling. On each throttled inactivity notice, the poll loop attempts a bounded Yente-authored status relay while the long OpenCode turn continues if the provider can support a concurrent relay. If relay cannot be accepted safely, the provider converts the condition into a terminal recoverable pause so Yente can relay before the user continues. Direct host-authored fallback is allowed only after relay acceptance/result failure.
- No-SSE and heartbeat-only long work must remain state-preserving for longer than the observed Dvora gap. Default no-SSE transport death must be at least 30 minutes, and wait ticks/keepalives must refresh host heartbeat before host sweep can kill the container. The absolute turn ceiling remains bounded and cannot be extended by declared tool timeouts.
- Declared tool timeouts are capped by `min(OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS, OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS - elapsedTurnMs - safetyMarginMs)`. A tool cannot widen host-sweep tolerance beyond the configured hard ceiling.
- Provider events must include `inputId`. Top-level prompts and follow-up pushes are considered accepted only after the provider emits `input-accepted` for the matching id. All provider implementations and tests must be updated: Claude, Codex, OpenCode, Mock, provider push tests, factory tests where needed, and poll-loop scripted test providers.
- User rows are completed only after the accepted input is resolved by a successful provider result or explicit supersession. Accepted-but-unresolved inputs that hit a terminal interruption move into recovery ownership and must not disappear merely because the SDK accepted them.
- Unaccepted follow-ups have a defined lifecycle. Route-matched unaccepted follow-ups are either kept in recovery or returned to pending by deleting only transient `processing_ack.status='processing'` rows. Other-route unaccepted rows are always returned to pending and never included in the active route's recovery payload.
- Accepted-but-unresolved rows use a durable recovery ack/ledger state so they stay hidden from normal pending scans while recovery owns them. They are marked completed only when the recovery attempt succeeds.
- Initial work is split by normalized route when multiple wake-triggering routes are present. Same-route wake-triggering messages are preserved as an ordered `originalTasks` array, not collapsed into one newest task. Other routes remain pending.
- Route matching must handle the existing null-thread/DM-thread mismatch. Implement a shared normalizer that treats known DM aliases as the same conversation but keeps distinct non-DM threads isolated. Recovery must not leak across conversations in shared sessions.
- Recovery prompt injection is XML-escaped and happens only for a new top-level `provider.query(...)`, never for `query.push(...)`.
- Follow-up polling is disabled or strictly route-filtered during bounded recovery relay turns so unrelated pending messages stay pending.
- Pre-query failures after rows are claimed are recoverable. Attachment inspection, formatting, pre-task script handling, provider startup, session creation, and prompt acceptance failures must either return unaccepted rows to pending or store route-scoped recovery before settling.
- Host-sweep kill/reset and container-crash recovery must create a user-visible recovery path. When the host resets active processing rows for an interrupted turn, it writes a scoped recovery record or a direct fallback notice with enough route and original-task context for the next Yente turn to resume.
- Side effects that complete before final assistant output must be durable recovery facts. For the observed scenarios this means Gmail draft creation and Dvora summary artifact creation are recorded in the recovery payload with id/path/output evidence so recovery does not duplicate drafts or redo completed summary artifacts.
- Optional MCP degradation is narrow. Only expected missing/expired credential classes for Granola, such as "auth required" or "auth expired", may degrade to unavailable optional state. Auth-directory integrity, ownership, symlink, mount-overlap, malformed config, and required bridge failures remain fail-closed.
- GWS help/schema/local probes remain subject to the same authentication and admission behavior they have today. The GWS change is audit classification only: classify before request/completion logging, set `request_class` and `api_effect:false`, and do not log local help/schema probes as successful Gmail API mutations. Do not broaden allowed commands or bypass policy controls beyond existing behavior.

## File Structure

### NanoClaw Agent Runner

- Create `container/agent-runner/src/providers/opencode-events.ts`
  - Single-reader OpenCode SSE pump.
  - Session-scoped event filtering and SDK 1.15.10 shape helpers.
  - Deterministic clock/scheduler injection for tests.
  - Result kinds: `event`, `keepalive`, `wait-tick`, `inactivity-notice`, `transport-timeout`, `absolute-timeout`, `read-error`, `ended`, `queue-overflow`.
  - Bounded queue policy that never silently drops terminal, permission, question, assistant text, or side-effect events.

- Create `container/agent-runner/src/providers/opencode-errors.ts`
  - Typed OpenCode interruption errors and metadata helpers.
  - Exact attempted-session missing-session classifier.

- Modify `container/agent-runner/src/providers/types.ts`
  - Add `inputId` to `QueryInput` and `QueryTurnInput`.
  - Add provider events for `input-accepted`, `interruption`, `notice`, `side-effect`, `clear-continuation`, and source-tagged `activity`.
  - Change `isSessionInvalid(err, { attemptedContinuation })`.
  - Clarify that providers report metadata only; recovery storage and row completion belong to the poll loop.

- Modify `container/agent-runner/src/providers/claude.ts`
  - Pass through `inputId`.
  - Emit `input-accepted` when the SDK input stream accepts the top-level/follow-up prompt.
  - Keep current Claude behavior otherwise.

- Modify `container/agent-runner/src/providers/codex.ts`
  - Pass through `inputId`.
  - Emit `input-accepted` only after `turn/start` has accepted the matching input.
  - Update stale-thread classifier signature.

- Modify `container/agent-runner/src/providers/mock.ts`
  - Emit deterministic `input-accepted` events for tests.

- Modify `container/agent-runner/src/providers/opencode.ts`
  - Use the event pump and a runtime-controller test seam.
  - Disable and deny native OpenCode question through real SDK config/events/permission APIs.
  - Yield activity for event, keepalive, and wait ticks.
  - Yield `notice` for inactivity status relay and typed terminal `interruption` for true terminal conditions.
  - Track prompt acceptance by `inputId`.
  - Track side-effect completion evidence from tool parts.
  - Track overlapping active tool parts and persisted `container_state`.
  - Preserve or clear continuation only according to explicit reuse proof.
  - Log structured JSONL with `severity`, `event`, `session_id`, `classification`, and timeout metadata.

- Modify `container/agent-runner/src/db/session-state.ts`
  - Add route-scoped recovery APIs with entry status: `pending`, `in_flight`, `resolved`, `superseded`.
  - Add recovery input ledger APIs for original rows, follow-ups, accepted/unresolved rows, side-effect evidence, relay attempts, and malformed-json cleanup.
  - Add explicit continuation-clear helpers that require attempted-continuation metadata.

- Modify `container/agent-runner/src/db/messages-in.ts`
  - Add helpers to return unaccepted `processing` acks to pending.
  - Add helpers to move accepted/unresolved row ids into `recovery` ack status and later mark them completed or return them to pending on recovery deletion.

- Modify `container/agent-runner/src/db/connection.ts`
  - Clear stale provider-owned OpenCode tool state on startup.
  - Preserve recovery-owned ack rows on startup while clearing orphan `processing` rows.

- Modify `container/agent-runner/src/formatter.ts`
  - Export the existing XML escape helper.
  - Add route normalization helpers or import them from a new focused module if the implementation reads cleaner.

- Modify `container/agent-runner/src/poll-loop.ts`
  - Partition initial batches by normalized route.
  - Build and own route-scoped recovery payloads.
  - Own input ledger state and message-row completion.
  - Attempt bounded Yente-authored relay for inactivity notices and terminal recovery.
  - Disable or route-filter follow-up polling during relay.
  - Convert provider throws and non-retryable provider errors into sanitized recoverable interruptions.
  - Handle pre-query failures under the same recovery/ack lifecycle.

- Create `container/agent-runner/src/opencode-incident-replay.test.ts`
  - Local Yente injection harness using the real `OpenCodeProvider` and deterministic runtime/pump.

- Modify tests:
  - `container/agent-runner/src/providers/opencode-events.test.ts`
  - `container/agent-runner/src/providers/opencode.test.ts`
  - `container/agent-runner/src/providers/push.test.ts`
  - `container/agent-runner/src/providers/codex.factory.test.ts`
  - `container/agent-runner/src/db/session-state.test.ts`
  - `container/agent-runner/src/poll-loop.test.ts`
  - `container/agent-runner/src/integration.test.ts`

### NanoClaw Host

- Modify `src/host-sweep.ts`
  - Honor bounded declared tool timeout for any provider-owned active tool.
  - Clear stale tool rows after kill/reset.
  - Write recovery records or user-visible fallback notices before resetting active processing claims when a container dies or is killed.

- Modify `src/host-sweep.test.ts`
  - Add declared-timeout cap, no-SSE long-work, crash/kill recovery, and stale-tool cleanup coverage.

- Modify `src/agent-mcp-config.ts`, `src/agent-mcp-bridge.ts`, `src/container-config.ts`, `src/container-runner.ts`, `src/claude-md-compose.ts`
  - Implement narrow optional Granola auth degradation.

- Modify tests:
  - `src/agent-mcp-config.test.ts`
  - `src/agent-mcp-bridge.test.ts`
  - `src/container-runner.test.ts`
  - `src/claude-md-compose.test.ts`

### GWS Proxy

- Create worktree `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening`.
- Modify `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy.go`.
- Modify `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy_test.go`.

### Docs

- Modify `docs/agent-runner-details.md`.

## Task 1: Provider Contract, Input Ledger, And Route-Scoped Recovery

**Files:**
- Modify: `container/agent-runner/src/providers/types.ts`
- Modify: `container/agent-runner/src/providers/claude.ts`
- Modify: `container/agent-runner/src/providers/codex.ts`
- Modify: `container/agent-runner/src/providers/mock.ts`
- Modify: `container/agent-runner/src/providers/push.test.ts`
- Modify: `container/agent-runner/src/providers/codex.factory.test.ts`
- Modify: `container/agent-runner/src/db/session-state.ts`
- Modify: `container/agent-runner/src/db/session-state.test.ts`
- Modify: `container/agent-runner/src/db/messages-in.ts`
- Modify: `container/agent-runner/src/formatter.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`

- [ ] **Step 1: Write failing provider-contract tests**

In provider push/factory tests, require every provider to accept and echo `inputId`:

```typescript
const query = provider.query({ inputId: 'initial-1', prompt: 'hello', cwd: '/tmp' });
await expect(nextEvent(query.events, 'input-accepted')).resolves.toMatchObject({
  type: 'input-accepted',
  inputId: 'initial-1',
  scope: 'initial',
});

query.push({ inputId: 'followup-1', prompt: 'later' });
await expect(nextEvent(query.events, 'input-accepted')).resolves.toMatchObject({
  type: 'input-accepted',
  inputId: 'followup-1',
  scope: 'followup',
});
```

Update stale-session tests so `isSessionInvalid` must receive attempted continuation metadata:

```typescript
expect(provider.isSessionInvalid(new Error('thread not found'), { attemptedContinuation: 'thread-1' })).toBe(true);
expect(provider.isSessionInvalid(new Error('connection reset'), { attemptedContinuation: 'thread-1' })).toBe(false);
```

- [ ] **Step 2: Write failing recovery and ack lifecycle tests**

In `session-state.test.ts`, add tests for:

- Recovery entries are keyed by provider plus normalized route.
- Null-thread Discord DM and equivalent DM-thread alias resolve to the same route key.
- Distinct non-DM threads stay isolated.
- Entries are read non-destructively.
- `pending -> in_flight -> resolved` deletes only after successful resolution.
- An `in_flight` entry that gets another terminal interruption is retained and enriched, not deleted.
- Malformed recovery JSON is logged, deleted, and does not block startup.
- Only the newest 10 unresolved entries per scope are retained.

In `messages-in`/`poll-loop` tests, add:

- Unaccepted follow-up rows become pending again when a terminal interruption happens before provider `input-accepted`.
- Accepted-but-unresolved rows move to `processing_ack.status='recovery'` and are not marked completed until a later successful recovery result.
- Startup clears orphan `processing` acks but preserves `recovery` acks.
- Recovery deletion resolves associated row ids to completed.

- [ ] **Step 3: Write failing route and pre-query tests**

In `poll-loop.test.ts`, add:

- Multiple wake-triggering routes in the same pending scan are split; only the active route is claimed and processed, and other routes remain pending.
- Same-route multiple trigger rows are preserved in order as `originalTasks`.
- A mixed batch with accumulated context before the trigger stores recovery under the trigger route, not the first row route.
- Null-thread Discord DM follow-up matches the original DM-thread alias and is included in recovery.
- Different route follow-ups remain pending during terminal recovery and during bounded relay.
- Attachment inspection failure after claim stores recovery or returns rows to pending without writing raw provider errors.
- Pre-task script failure after claim follows the same recoverable lifecycle.
- Provider startup, session creation, and top-level prompt acceptance failures store recovery before settling.

- [ ] **Step 4: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/push.test.ts src/providers/codex.factory.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
```

Expected: FAIL because `inputId`, recovery states, route normalization, and durable row lifecycle do not exist.

- [ ] **Step 5: Implement the provider event contract**

In `providers/types.ts`, add:

```typescript
export type ProviderInputScope = 'initial' | 'followup' | 'relay';
export type ProviderContinuationPolicy = 'preserve' | 'clear' | 'unknown';
export type ProviderNoticeSeverity = 'info' | 'warn' | 'error';

export interface QueryTurnInput {
  inputId: string;
  prompt: string;
  attachments?: QueryAttachment[];
}

export interface QueryInput extends QueryTurnInput {
  continuation?: string;
  cwd: string;
  systemContext?: { instructions?: string };
  relayMode?: boolean;
}

export interface ProviderInterruption {
  classification: string;
  severity: ProviderNoticeSeverity;
  terminal: boolean;
  agentMessage: string;
  fallbackUserMessage: string;
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
  recoverySeed?: {
    observations?: string[];
    safeToolState?: string;
    sideEffects?: ProviderSideEffect[];
  };
}

export interface ProviderSideEffect {
  id: string;
  kind: 'gmail_draft_created' | 'dvora_summary_artifact' | 'tool_completed' | 'other';
  label: string;
  evidence: Record<string, string | number | boolean | null>;
  occurredAt: string;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'input-accepted'; inputId: string; scope: ProviderInputScope }
  | { type: 'result'; text: string | null; resolvedInputIds?: string[]; supersededInputIds?: string[] }
  | { type: 'error'; message: string; retryable: boolean; classification?: string; userMessage?: string }
  | { type: 'progress'; message: string }
  | { type: 'notice'; classification: string; severity: ProviderNoticeSeverity; agentMessage: string; fallbackUserMessage: string; relayRecommended: boolean }
  | ({ type: 'interruption' } & ProviderInterruption)
  | { type: 'side-effect'; sideEffect: ProviderSideEffect }
  | { type: 'clear-continuation'; reason: string; attemptedContinuation?: string }
  | { type: 'activity'; source?: 'sdk_event' | 'sdk_keepalive' | 'provider_wait_tick' | 'provider_internal' };
```

Update all providers to emit `input-accepted` only after the underlying SDK/input stream accepts the matching prompt. Mock can accept synchronously; Claude can accept when its `MessageStream.push` succeeds; Codex/OpenCode must wait for their actual turn/prompt acceptance seams.

- [ ] **Step 6: Implement scoped recovery and input ledger**

Add recovery types in `session-state.ts`:

```typescript
export interface ProviderRecoveryScope {
  providerName: string;
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
  priorProgress: string[];
  observations: string[];
  sideEffects: ProviderSideEffect[];
  safeToolState?: string;
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
  createdAt: string;
  updatedAt: string;
}
```

Implement append/read/mark-in-flight/resolve/enrich/supersede APIs. Recovery rows must remain available while `in_flight`; resolving a recovery entry also resolves its owned input ledger rows.

- [ ] **Step 7: Implement ack helpers**

In `messages-in.ts`, add helpers:

- `returnProcessingToPending(ids, reason)` deletes only `processing_ack.status='processing'`.
- `markRecoveryOwned(ids, recoveryId)` writes `processing_ack.status='recovery'`.
- `markRecoveryCompleted(ids, recoveryId)` transitions recovery-owned rows to `completed`.
- `clearRecoveryOwnership(ids, recoveryId)` deletes recovery acks when recovery is abandoned or malformed.

Log structured JSONL from callers with `severity`, `event`, `message_ids`, `recovery_id`, and `reason`.

- [ ] **Step 8: Implement route normalization and poll-loop ledger ownership**

Add one shared route normalizer. Use it for initial batch splitting, recovery scope, follow-up matching, relay routing, and tests. It must:

- Include provider name, channel type, platform id, and a normalized thread key.
- Treat known DM null-thread and DM-thread aliases as equal.
- Treat distinct non-DM thread ids as distinct.
- Never match on accumulated context rows before the wake trigger.

In `poll-loop.ts`:

- Split pending wake-triggering rows by normalized route before `markProcessing`.
- Generate top-level and follow-up `inputId` values.
- Track every input as `queued`, `accepted`, `resolved`, `recovery_owned`, or `returned`.
- Inject XML-escaped pending recovery entries only into top-level prompts.
- Mark recovery entries `in_flight` when the provider accepts the matching top-level recovery `inputId`.
- Resolve and delete recovery entries only after a successful provider result resolves that input.
- On accepted-but-unresolved terminal interruption, enrich recovery and mark those rows recovery-owned instead of completed.
- On unaccepted terminal interruption, return route-matched rows to pending or include them in recovery; return other-route rows to pending.
- Convert pre-query failures and provider throws into the same recovery path.

- [ ] **Step 9: Run tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/push.test.ts src/providers/codex.factory.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/types.ts \
  container/agent-runner/src/providers/claude.ts \
  container/agent-runner/src/providers/codex.ts \
  container/agent-runner/src/providers/mock.ts \
  container/agent-runner/src/providers/push.test.ts \
  container/agent-runner/src/providers/codex.factory.test.ts \
  container/agent-runner/src/db/session-state.ts \
  container/agent-runner/src/db/session-state.test.ts \
  container/agent-runner/src/db/messages-in.ts \
  container/agent-runner/src/formatter.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: preserve provider input recovery state"
```

## Task 2: OpenCode Event Pump, Liveness, And Continuation Classification

**Files:**
- Create: `container/agent-runner/src/providers/opencode-events.ts`
- Create: `container/agent-runner/src/providers/opencode-events.test.ts`
- Create: `container/agent-runner/src/providers/opencode-errors.ts`
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `src/host-sweep.ts`
- Modify: `src/host-sweep.test.ts`

- [ ] **Step 1: Write failing stale-classifier tests**

In `opencode.test.ts`:

```typescript
expect(isMissingOpenCodeSessionError(new Error('OpenCode event timeout (300000ms)'), 'ses_old')).toBe(false);
expect(isMissingOpenCodeSessionError(new Error('ECONNRESET while reading OpenCode events'), 'ses_old')).toBe(false);
expect(isMissingOpenCodeSessionError(new Error('HTTP 404 from OpenCode event stream'), 'ses_old')).toBe(false);
expect(isMissingOpenCodeSessionError(new Error('NotFoundError'), 'ses_old')).toBe(false);
expect(isMissingOpenCodeSessionError(new Error('OpenCode promptAsync: session ses_old not found'), 'ses_old')).toBe(true);
expect(isMissingOpenCodeSessionError(new Error('OpenCode promptAsync: session ses_other not found'), 'ses_old')).toBe(false);
```

- [ ] **Step 2: Write failing pump and long-work tests**

In `opencode-events.test.ts`, use fake clock/scheduler tests for:

- Keepalives update liveness and yield `keepalive`.
- Wait ticks yield before transport timeout.
- Heartbeat-only/no-SSE wait ticks run beyond 16 observed Dvora minutes without terminal timeout when `transportTimeoutMs` is above that duration.
- Inactivity notices fire at `OPENCODE_INACTIVITY_NOTICE_MS`, repeat at the throttle interval, and do not end the stream.
- A later `session.idle` after inactivity returns normally.
- No events until configured `transportTimeoutMs` returns `transport-timeout` with liveness metadata.
- Absolute deadline returns `absolute-timeout` and is distinct from transport timeout.
- Read errors and stream end return typed terminal results.
- Other-session events do not wake the active session waiter.
- Queue overflow preserves non-droppable terminal/action-required/final-text/question/permission/side-effect events or returns `queue-overflow`.

In `host-sweep.test.ts`, add:

- Any provider-owned active tool with a positive declared timeout widens claim tolerance.
- Declared timeout is capped under the absolute hard-death ceiling.
- Host heartbeat stays fresh during wait ticks.
- Host kill/reset clears stale OpenCode tool state and writes route-scoped recovery/fallback for processing rows.

- [ ] **Step 3: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/host-sweep.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement typed OpenCode errors and classifier**

Create `opencode-errors.ts` with liveness metadata, typed errors for transport timeout, absolute timeout, stream read error, stream end, and queue overflow, plus `isMissingOpenCodeSessionError(err, attemptedSessionId)`. The classifier must require attempted session context and must not match generic transport/read/timeout strings.

- [ ] **Step 5: Implement the event pump**

Create `opencode-events.ts` with:

```typescript
export type OpenCodePumpResult<T> =
  | { kind: 'event'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'keepalive'; event: T; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'wait-tick'; metadata: OpenCodeLivenessSnapshot }
  | { kind: 'inactivity-notice'; metadata: OpenCodeLivenessSnapshot & { configuredTimeoutMs: number; elapsedMs: number } }
  | { kind: 'transport-timeout'; error: OpenCodeTransportTimeoutError }
  | { kind: 'absolute-timeout'; error: OpenCodeAbsoluteTimeoutError }
  | { kind: 'read-error'; error: OpenCodeStreamReadError }
  | { kind: 'ended'; error: OpenCodeStreamEndedError }
  | { kind: 'queue-overflow'; error: OpenCodeQueueOverflowError };
```

No production code outside this pump should call `stream.next()` directly.

- [ ] **Step 6: Implement host-sweep bounded declared-timeout handling**

Replace Bash-only timeout handling with provider/tool-generic declared timeout handling. Cap every declared timeout under the hard ceiling. After host kill/reset, clear provider-owned tool rows and write a recovery record or fallback notice for active processing rows before resetting them.

- [ ] **Step 7: Run tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/host-sweep.test.ts
timeout 120s pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode-events.ts \
  container/agent-runner/src/providers/opencode-events.test.ts \
  container/agent-runner/src/providers/opencode-errors.ts \
  container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  src/host-sweep.ts src/host-sweep.test.ts
git commit -m "fix: make opencode liveness recoverable"
```

## Task 3: OpenCode Provider Runtime, Native Questions, Relays, And Side Effects

**Files:**
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `container/agent-runner/src/db/connection.ts`
- Modify: `container/agent-runner/src/index.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`

- [ ] **Step 1: Write failing OpenCode provider tests**

In `opencode.test.ts`, add mocked runtime-controller tests for:

- `buildOpenCodeConfig()` disables native `question` through OpenCode tool availability for SDK 1.15.10.
- Runtime startup, session creation, top-level prompt acceptance, and follow-up prompt acceptance yield wait-tick activity and fail as typed interruptions if deadlines expire.
- Inactivity notices yield `notice` with relay text, do not clear continuation, do not destroy the runtime, and do not settle user rows by themselves.
- If concurrent relay is unavailable, inactivity is converted into a terminal recoverable pause before direct fallback.
- No-SSE wait ticks/keepalives beyond 16 minutes keep heartbeat alive and do not produce `OpenCode event timeout`.
- Transport timeout at the configured longer deadline yields terminal `opencode_transport_timeout`, clears continuation unless reuse was proved, clears active tool state, stores side-effect evidence, and returns without raw error.
- Absolute timeout, stream read error, stream end, queue overflow, `session.error`, startup timeout, prompt-acceptance timeout, and retry exhaustion each yield one typed terminal interruption and clear active tool state.
- `message.part.updated` tool parts with native question and matching `permission.updated` events are correlated by `callID`/permission id and denied through `postSessionIdPermissionsPermissionId(...)`.
- Cancellable native question waits only for bounded reuse proof; it preserves continuation only after `session.idle` or equivalent SDK acknowledgement.
- Non-cancellable native question or denial without reuse proof destroys runtime, emits `clear-continuation`, and stores restart-capable recovery metadata.
- Question/tool/permission events for other session ids are ignored.
- GWS draft-create and Dvora summary tool completions emit `side-effect` events before final assistant text.
- Terminal failure after side effect but before final result includes the side-effect evidence in the interruption seed.
- Overlapping tool parts keep the longest bounded declared timeout active until all longer tools complete.
- Startup clears stale OpenCode tool state left by a prior crash.

- [ ] **Step 2: Write failing relay and recovery tests**

In `poll-loop.test.ts`, add:

- Inactivity notice triggers a bounded Yente-authored relay query with recovery context while the original long turn remains active when provider relay support exists.
- Relay output is routed to the wake-triggering route.
- Normal follow-up polling is disabled or route-filtered during relay.
- If relay prompt is accepted but then fails/hangs/interrupts, the original recovery payload remains unresolved and direct fallback is sent only after bounded relay failure.
- Terminal interruption relay uses the same recovery lifecycle and does not delete recovery on `input-accepted`.
- Direct fallback is emitted only once and only after relay acceptance/result failure.

- [ ] **Step 3: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/poll-loop.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Add a runtime-controller seam**

Keep production construction unchanged, but make tests inject:

```typescript
interface OpenCodeRuntimeController {
  proc?: ChildProcess;
  client: OpencodeClient;
  pump: OpenCodeEventPump<OpenCodeSseEvent>;
  start(options: ProviderOptions, deadline: OpenCodeDeadline): Promise<void>;
  createSession(deadline: OpenCodeDeadline): Promise<string>;
  prompt(sessionId: string, input: QueryTurnInput, deadline: OpenCodeDeadline): Promise<void>;
  denyPermission(sessionId: string, permissionId: string, reason: string): Promise<void>;
  destroy(reason: string): void;
}
```

The provider emits `input-accepted` only after `prompt(...)` returns for that exact `inputId`.

- [ ] **Step 5: Implement pump-driven OpenCode turn state**

Use env-configurable defaults:

- `OPENCODE_INACTIVITY_NOTICE_MS=300000`
- `OPENCODE_INACTIVITY_NOTICE_REPEAT_MS=300000`
- `OPENCODE_TRANSPORT_TIMEOUT_MS=1800000`
- `OPENCODE_WAIT_TICK_MS=15000`
- `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS=21600000`
- `OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS=15000`
- `OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS=21600000`

For every `inactivity-notice`, yield `activity` then `notice` with agent-facing wording. Do not push the notice into the busy OpenCode turn. The poll loop will relay it through a bounded relay query if possible.

For terminal pump results, yield one typed `interruption`, emit any collected `side-effect` entries, clear active tool state, and return.

- [ ] **Step 6: Implement native-question denial**

Implement SDK shape helpers that inspect `message.part.updated` and `permission.updated` actual fields. Detect native question by tool name/metadata, extract question text from observed fields, correlate by call id, and deny permission when possible.

Visible recovery text must include the blocked question. In the Fruma replay this must visibly ask the user for Matt Van Horn's email before the email answer is injected.

- [ ] **Step 7: Implement side-effect ledger capture**

Capture safe side-effect evidence from OpenCode tool completion events:

- Gmail draft creation: command/tool path, sanitized subject/body hints, draft id when present.
- Dvora summary artifact: recording id/path, output artifact path/id, summary completion marker.
- Generic tool completion: tool name, call id, sanitized status/output snippet.

On terminal interruption after a side effect but before assistant result, emit a recovery seed with the side-effect ledger. The poll loop must include this in the next recovery prompt so the agent can report existing work rather than duplicating it.

- [ ] **Step 8: Implement active tool tracking**

Maintain an active tool map keyed by part id/call id. Persist the active entry with the largest bounded timeout to `container_state`; clear only when all active tools complete or on terminal interruption. Clear stale OpenCode-owned tool state on startup in `index.ts`.

- [ ] **Step 9: Run tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  container/agent-runner/src/db/connection.ts \
  container/agent-runner/src/index.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: recover opencode interruptions through yente"
```

## Task 4: Exact Dvora, Fruma, And Failure-Mode Replays Through Local Yente Injection

**Files:**
- Create: `container/agent-runner/src/opencode-incident-replay.test.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts` only if a shared helper is needed
- Modify: `container/agent-runner/src/providers/opencode.ts` only if the runtime test seam needs a small adjustment

- [ ] **Step 1: Build the incident replay harness and encode acceptance contracts first**

Before adding Task 4 support code, write the Dvora, Fruma, side-effect, and terminal-taxonomy replay assertions in this file so the exact incident contracts fail for concrete reasons. The executor may keep this file uncommitted until Step 10 if intermediate task commits must keep the suite green, but the assertions must be written before implementation details are adjusted for them.

The harness must use the real `OpenCodeProvider`, not a canned `ScriptedProvider` or success-text-only scripted provider. It should provide:

- Fake OpenCode SDK client and runtime controller.
- Fake event pump controlled by the test.
- Known session ids.
- Recorded prompt parts, `inputId`, continuation, and prompt acceptance.
- Recorded permission denials.
- Recorded tool side effects that must occur before final assistant text.
- Local `messages_in` injection plus `runPollLoop()` assertions for `messages_out`, `processing_ack`, `session_state`, `container_state`, provider prompt acceptance, relay attempts, and side-effect ledger.
- Test failures when user-visible success appears without matching provider `input-accepted`, recovery-state, ack-lifecycle, and side-effect evidence.

- [ ] **Step 2: Recover the exact Dvora original trigger if available**

Search local session DBs, retained logs, and incident artifacts for the original Dvora prompt that preceded the observed progress line. If found, store it as a fixture with a source comment. If not found, document that evidence boundary in the fixture and use the transcript-provided observed progress and follow-up as the minimum exact replay.

- [ ] **Step 3: Replay Dvora failure turn 1 with session `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`**

Inject the recovered trigger or evidence-boundary substitute. The first OpenCode turn must:

- Start/resume `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- Emit the exact observed progress line through user-visible output, not seeded history:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

- Emit no-SSE wait ticks/keepalives beyond the old 300s watchdog and beyond 16 observed minutes without host sweep killing the container.
- Trigger a Yente-authored inactivity relay or terminal recoverable pause; no outbound text may contain `OpenCode event timeout`.
- If the harness drives a terminal no-reuse interruption, recovery must include the exact progress line and original task.

- [ ] **Step 4: Replay Dvora failure turn 2 with exact follow-up and session `ses_19757b6f7ffeYulTtPz3gteQ84`**

Inject the exact follow-up:

```text
Great. Now do the 5/19 summary.
```

Drive the second historical failure path by starting or attempting session `ses_19757b6f7ffeYulTtPz3gteQ84` according to the recovery policy under test. Assertions:

- The follow-up row is not completed until the provider resolves it successfully or recovery owns it.
- Recovery context includes the first turn's exact progress line and any unresolved accepted inputs.
- The second old timeout path is also converted into recovery/relay, not a raw `Error: OpenCode event timeout`.
- The eventual successful resumed turn emits a Dvora summary tool side effect for the 5/19 recording before final assistant text.
- The final user-visible output contains `5/19 summary complete`.
- Both observed session ids appear in the harness assertions so the original sequence was actually replayed.

- [ ] **Step 5: Replay Fruma Gmail draft with GWS probes and native question**

Inject the exact prompt:

```text
Actually create a draft in my gmail
```

The first harness turn must:

- Start/resume `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Emit GWS help/schema probe tool events before the native question, including a `gws gmail users drafts create --help`-style probe.
- Assert those probe side effects/audit records are classified as non-API probes, not draft creation.
- Emit a `message.part.updated` question tool carrying `ToolPart.callID` or equivalent part id plus matching `permission.updated` events carrying `Permission.callID` and `Permission.id` where available, asking for Matt Van Horn's email address.
- Assert the provider correlates the tool and permission events by call id/permission id and denies the native question through `postSessionIdPermissionsPermissionId(...)` when a cancellable permission exists.
- Emit a Yente-visible outbound question asking for Matt Van Horn's email before the test injects the answer; the test must fail if the answer row is inserted first.
- Return without any raw OpenCode timeout.

Then inject:

```text
Matt Van Horn's email is matt@example.com.
```

The second harness turn must:

- Preserve `ses_1a47da93effeJdpKh0oiDUOP2Q` only if reuse proof was observed; otherwise start a new session with restart recovery context.
- Include escaped recovery context saying the native question was blocked.
- Include the exact email answer.
- Emit a real GWS draft-create tool/command side effect before final assistant text.
- Emit final assistant text `Draft created in Gmail.`
- Complete both user rows only after successful result.
- Resolve Fruma recovery only after the successful result, not after prompt acceptance.

- [ ] **Step 6: Replay non-cancellable native-question restart**

Use the same Fruma initial prompt but emit a native question with no permission id/cancellable handle and no reuse proof. Assertions:

- Provider emits `clear-continuation` for `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Recovery context includes the original Gmail draft request, blocked question text, and `continuationPolicy: "clear"`.
- The email-answer follow-up starts a new OpenCode session, creates the Gmail draft side effect, and delivers `Draft created in Gmail.`
- No message claims same-session continuation after continuation was cleared.

- [ ] **Step 7: Replay terminal after side effect before final assistant output**

Add two cases:

- Gmail draft side effect completes, then the stream dies before final assistant text.
- Dvora summary artifact completes, then the stream dies before final assistant text.

Assertions:

- Recovery includes durable side-effect evidence.
- The resumed prompt tells Yente the side effect already happened.
- The harness fails if the draft or summary side effect is repeated.
- The final user-visible answer reports the existing draft/summary instead of duplicating work.

- [ ] **Step 8: Replay direct transport and terminal taxonomy**

Add table-driven cases for no-SSE transport timeout, stream read error, stream end, queue overflow, absolute timeout, `session.error`, retry exhaustion, startup timeout, and prompt-acceptance timeout.

Each case must assert:

- Recovery has original task text, accepted/unresolved input rows, side effects, and continuation policy.
- Raw provider error text is not written to user output.
- OpenCode active tool state is cleared.
- A later `continue` or exact domain follow-up succeeds through the real OpenCode harness.

- [ ] **Step 9: Run replay tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/opencode-incident-replay.test.ts
```

Expected: FAIL until Tasks 1-3 are wired.

- [ ] **Step 10: Run replay tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 180s bun test src/opencode-incident-replay.test.ts src/providers/opencode.test.ts src/poll-loop.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/opencode-incident-replay.test.ts \
  container/agent-runner/src/poll-loop.test.ts \
  container/agent-runner/src/providers/opencode.ts
git commit -m "test: replay yente opencode incidents"
```

## Task 5: Narrow Optional Granola Credential Degradation

**Files:**
- Modify: `src/agent-mcp-config.ts`
- Modify: `src/agent-mcp-config.test.ts`
- Modify: `src/agent-mcp-bridge.ts`
- Modify: `src/agent-mcp-bridge.test.ts`
- Modify: `src/container-config.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `src/claude-md-compose.ts`
- Create: `src/claude-md-compose.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

- `granola` defaults to optional only for expected missing/expired credential classes.
- Non-Granola bridges default required.
- Explicit required/optional config is preserved.
- Granola auth-required or auth-expired unavailability still spawns the container with Granola omitted.
- Container config records `agentMcpUnavailable.granola.category` as `auth_required` or `auth_expired`.
- Agent-facing unavailable text is sanitized and contains no host paths, uid/gid values, or raw thrown errors.
- Auth path ownership, symlink, mount-overlap, malformed config, and required bridge failures remain fail-closed even for Granola.
- Started bridges are stopped if a required bridge fails.

- [ ] **Step 2: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/agent-mcp-bridge.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement narrow degradation**

Add `required?: boolean` to bridge config, defaulting to `serverName !== 'granola'`. Map only known credential errors to sanitized categories. Keep all auth-directory integrity and mount checks before optional degradation and fail closed on those failures.

- [ ] **Step 4: Filter runtime MCP config**

When Granola degrades due to auth, omit its MCP server and allowed tools from container runtime config, add sanitized unavailable state, and recompose `CLAUDE.md`. Remove stale unavailable entries when Granola starts successfully later.

- [ ] **Step 5: Run tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/agent-mcp-bridge.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
timeout 120s pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add src/agent-mcp-config.ts src/agent-mcp-config.test.ts \
  src/agent-mcp-bridge.ts src/agent-mcp-bridge.test.ts \
  src/container-config.ts src/container-runner.ts src/container-runner.test.ts \
  src/claude-md-compose.ts src/claude-md-compose.test.ts
git commit -m "fix: degrade granola credential failures safely"
```

## Task 6: GWS Probe Audit Classification Without Behavior Broadening

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

Expected: worktree created. Read `/home/dan/code/gws-skill/AGENTS.md` before editing if it exists.

- [ ] **Step 2: Write failing audit tests**

In `proxy_test.go`, capture JSON request and completion logs. Add tests for:

- `gws gmail users drafts create --help` logs `request_class:"help"` and `api_effect:false` in both request and completion records.
- The repo's actual schema-probe syntax logs `request_class:"schema"` and `api_effect:false`.
- `gws auth status` logs `request_class:"local_probe"` and `api_effect:false`.
- No request or completion log for a help/schema/local probe says `method:"users.drafts.create"` with API success semantics.
- `gws gmail users drafts create --subject help --body schema` remains `request_class:"api"` and `api_effect:true`.
- `gws gmail users drafts send --body auth` remains API.
- If existing behavior rejects a non-API-looking command because of auth/policy/admission, the log classification is still non-API but the command is not newly allowed.

- [ ] **Step 3: Run tests red**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: FAIL.

- [ ] **Step 4: Implement structural classification before logging**

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

- `--help`, `-h`, `help`, `--version`, and `version` as help/version.
- `auth status` and `auth list` as local probes.
- Schema only when the actual GWS CLI positional structure indicates schema, before flags.
- Flag values such as `--subject help` or `--body schema` must not affect classification.

Do not broaden execution behavior. Keep existing authentication, admission, policy, signature, and rate-limit paths for commands exactly as they are unless an existing test already proves a non-API probe was allowed before this change. The only required behavioral change is audit semantics: request and completion logs carry `request_class` plus `api_effect`, and non-API probes are not logged as successful Gmail API mutations.

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
git commit -m "fix: classify gws probe audit logs"
```

## Task 7: Documentation And Full Verification

**Files:**
- Modify: `docs/agent-runner-details.md`

- [ ] **Step 1: Update agent-runner docs**

Update `docs/agent-runner-details.md` to document:

- `inputId`, `input-accepted`, `notice`, `interruption`, `side-effect`, and `clear-continuation` provider events.
- Provider metadata ownership versus poll-loop recovery ownership.
- Recovery lifecycle: `pending`, `in_flight`, `resolved`, `superseded`.
- Recovery deletion only after successful result/explicit supersession, not prompt acceptance.
- Route normalization, route-scoped recovery, same-route multi-trigger preservation, and null-thread DM alias handling.
- Follow-up row lifecycle and accepted-but-unresolved recovery ownership.
- Inactivity relay behavior and direct fallback limits.
- OpenCode native question disable/deny behavior using SDK 1.15.10 tool/permission events.
- Long-work heartbeat/wait tick behavior, no-SSE transport timeout, absolute turn ceiling, and declared-tool timeout caps.
- Side-effect ledger semantics for recovery after Gmail draft or summary artifact completion.
- Optional Granola credential degradation limits.

- [ ] **Step 2: Run targeted verification**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 180s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/db/session-state.test.ts src/poll-loop.test.ts src/opencode-incident-replay.test.ts src/providers/push.test.ts
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 180s pnpm exec vitest run src/host-sweep.test.ts src/agent-mcp-config.test.ts src/agent-mcp-bridge.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
timeout 120s pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full NanoClaw verification**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 300s bun test
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 300s pnpm test
timeout 120s pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run GWS verification**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: PASS.

- [ ] **Step 5: Run static guards**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "client\\.question|question\\.asked" container/agent-runner/src src --glob '!**/*.test.ts'
rg -n "event timeout|OpenCode event timeout|ECONNRESET|connection reset|\\b404\\b|NotFoundError" container/agent-runner/src/providers container/agent-runner/src/poll-loop.ts --glob '!**/*.test.ts' --glob '!**/fixtures/**'
rg -n "isSessionInvalid\\(" container/agent-runner/src --glob '!**/*.test.ts'
rg -n "clearContinuation\\(" container/agent-runner/src --glob '!**/*.test.ts'
```

Expected:

- No production code references nonexistent `client.question` or `question.asked`.
- No production stale-session classifier or poll-loop invalidation path matches generic timeout, transport, bare `404`, or bare `NotFoundError`.
- Every production `isSessionInvalid(` call passes attempted-continuation metadata.
- Production `clearContinuation(` appears only in typed continuation-clear or exact attempted-session invalidation paths.

- [ ] **Step 6: Commit docs**

If verification exposes implementation defects, return to the owning task, fix the defect with a focused test, rerun that task's verification, and commit the concrete changed files there. This step commits only the documentation update.

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add docs/agent-runner-details.md
git commit -m "docs: document recoverable provider interruptions"
```

## Final Completion Criteria

Implementation is complete only when all of these are true:

- Dvora replay uses the recovered exact original inbound request when available, otherwise documents the evidence boundary, injects the transcript-known progress and follow-up through local Yente, includes both observed session ids `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT` and `ses_19757b6f7ffeYulTtPz3gteQ84`, emits no raw OpenCode timeout, preserves or clears continuation only according to proof, records the 5/19 summary side effect, and ultimately delivers the summary result.
- Fruma replay injects `Actually create a draft in my gmail`, includes GWS help/schema probes before the native question, visibly asks for Matt Van Horn's email before the answer is injected, creates a Gmail draft side effect before final output, emits no raw timeout, and ultimately delivers `Draft created in Gmail.`
- Non-cancellable native-question replay clears the unusable continuation, restarts from recovery, and succeeds without claiming same-session continuation.
- Direct no-SSE/heartbeat-only long work exceeds the observed 16-minute window in tests while remaining state-preserving and host-alive; terminal transport failure at the configured longer deadline recovers successfully.
- Inactivity notices are relayed by Yente when possible, or converted to terminal recoverable pause before direct fallback; they never clear continuation by stale-session heuristic.
- Recovery context is route-scoped, XML-escaped, retained through failed accepted recovery attempts, and deleted only after successful result or explicit supersession.
- Initial batches with multiple wake-triggering routes are split; same-route multi-trigger tasks are stored and resumed in order.
- Follow-up rows are completed only after successful result or explicit supersession; unaccepted rows do not get hidden or duplicated; accepted-unresolved rows remain recovery-owned until resolved.
- Pre-query, provider startup, prompt acceptance, stream, queue, absolute-timeout, session.error, host-kill, and container-crash paths all produce resumable recovery or a user-visible fallback without raw provider errors.
- Side effects completed before a provider failure are carried into recovery and not duplicated in Gmail draft and Dvora summary tests.
- OpenCode native question handling uses actual SDK 1.15.10 tool/permission event correlation, not fake `question.asked` surfaces.
- OpenCode stale-session classification is limited to exact attempted-session missing cases.
- Declared tool timeouts cannot exceed the hard-death ceiling, and overlapping tool tracking cannot clear long-tool protection while a longer tool remains active.
- Optional Granola credential failure no longer prevents container spawn, while auth-directory security and required bridge failures still fail closed.
- GWS probe logs classify request and completion records before logging with `api_effect:false` and do not broaden allowed behavior.
- NanoClaw and GWS changes are committed in their respective repos, and every verification command in Task 7 passes.
