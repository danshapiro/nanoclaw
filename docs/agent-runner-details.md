# NanoClaw Agent-Runner Details

Implementation-level details for the agent-runner inside the container. See [architecture.md](architecture.md) for the high-level design.

## Separation of Concerns

The agent-runner has two layers:

1. **Agent-runner core** — owns the poll loop, message formatting, DB reads/writes, MCP tool implementations, routing, status management, media handling. This is NanoClaw-specific and shared across all providers.

2. **Agent provider** — owns the SDK interaction. Takes formatted prompts, pushes them to the SDK, yields events back. Trunk ships the `claude` provider; additional providers (OpenCode, Codex, etc.) are installed by `/add-<provider>` skills from the `providers` branch.

The boundary: the agent-runner decides **what** to send and **what to do** with results. The provider decides **how** to talk to the SDK.

## AgentProvider Interface

```typescript
interface AgentProvider {
  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;
}

interface QueryInput {
  /** Initial prompt (already formatted by agent-runner).
   *  String for text-only. ContentBlock[] for multimodal (images, PDFs, audio). */
  prompt: string | ContentBlock[];

  /** Session ID to resume, if any */
  sessionId?: string;

  /** Resume from a specific point in the session (provider-specific, may be ignored) */
  resumeAt?: string;

  /** Working directory inside the container */
  cwd: string;

  /** MCP server configurations (normalized format — provider translates) */
  mcpServers: Record<string, McpServerConfig>;

  /** System prompt / developer instructions */
  systemPrompt?: string;

  /** Environment variables for the SDK process */
  env: Record<string, string | undefined>;

  /** Additional directories the agent can access */
  additionalDirectories?: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentQuery {
  /** Push a follow-up message into the active query */
  push(message: string): void;

  /** Signal that no more input will be sent */
  end(): void;

  /** Output event stream */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query (e.g., container shutting down) */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'input-accepted'; inputId: string; scope: 'initial' | 'followup' | 'relay' }
  | ({ type: 'result'; text: string | null } & { inputId?: string; resolvedInputIds: string[]; supersededInputIds?: string[] })
  | { type: 'notice'; inputId: string; classification: string; severity; agentMessage; fallbackUserMessage; relayRecommended: boolean; liveness? }
  | ({ type: 'interruption' } & ProviderInterruption)
  | { type: 'side-effect'; sideEffect: ProviderSideEffect }
  | { type: 'clear-continuation'; inputId: string; reason: string; attemptedContinuation? }
  | { type: 'activity'; inputId?: string; source?: 'sdk_event' | 'sdk_keepalive' | 'provider_wait_tick' | 'provider_internal'; liveness? }
  | { type: 'progress'; inputId?: string; message: string };
```

The provider emits **facts** about an input-correlated turn; the poll loop owns
recovery, row-lifecycle, and continuation decisions. See
[Recoverable Provider Interruptions](#recoverable-provider-interruptions) for
the full contract. (`init` carries the resumable `continuation`, not a bare
`sessionId`; the legacy retryable-`error` event is replaced by the typed
`interruption` event.)

### What the interface does NOT include

- **Message formatting** — the agent-runner formats messages before passing to the provider. The provider receives a ready-to-send prompt string.
- **Hooks** — Claude-specific. The Claude provider registers hooks internally (PreCompact, PreToolUse, etc.). Other providers don't need them.
- **Tool allowlists** — Claude uses `allowedTools`. Codex uses `approvalPolicy`. OpenCode uses `permission`. Each provider configures this internally based on the same intent: "allow everything, no prompting."
- **Session persistence** — Claude persists sessions to disk automatically. Codex and OpenCode manage their own session state. The agent-runner doesn't control this — it just passes `sessionId` and `resumeAt`.
- **Sandbox configuration** — provider-specific. Each provider configures its own sandbox internally.

### Provider event semantics

Every input-correlated event carries the `inputId` the poll loop assigned to the
triggering turn, so the poll loop can resolve exactly the rows that input owns.

- **`init`** — emitted once per session establish/resume. Carries the resumable `continuation`; the poll loop persists it immediately so a mid-turn crash can resume.
- **`input-accepted`** — emitted when the provider has accepted a specific `inputId` for processing (`scope`: `initial`, `followup`, or `relay`). Acceptance is **not** completion: the poll loop marks the input accepted-but-unresolved and only completes its rows on a successful `result`.
- **`result`** — a turn segment finished. `resolvedInputIds` (and optional `supersededInputIds`) name exactly which inputs this result settles. Those — and only those — rows are completed. May be emitted multiple times per query.
- **`notice`** — a non-terminal liveness/quota/retry signal; the turn continues. The poll loop relays it (see [Inactivity Relay](#inactivity-relay)); it never settles rows or clears continuation.
- **`interruption`** — a typed, terminal, recoverable interruption (never a raw throw). Carries `classification`, sanitized `agentMessage`/`fallbackUserMessage`, a `continuationPolicy` (`preserve`/`clear`), `attemptedContinuation`, liveness, and an optional `recoverySeed`. The poll loop routes accepted-but-unresolved rows into recovery ownership.
- **`side-effect`** — a reference to a (validated or hint-only) side effect observed this turn. Seeds recovery so a resumed turn reports existing work instead of duplicating it.
- **`clear-continuation`** — the only provider-originated authoritative continuation clear (explicit clear, positive session-existence not-found, or the bounded zombie path). Carries `reason` and `attemptedContinuation`.
- **`activity`** — a liveness pulse (`source`: `sdk_event`, `sdk_keepalive`, `provider_wait_tick`, `provider_internal`). Refreshes the host heartbeat; no row effect.
- **`progress`** — optional, for logging only.

**Successful-result input resolution.** When a `result` names `resolvedInputIds`,
exactly those inputs are resolved. When it names none, the **one-active-input
fallback** applies: if exactly one input is still unresolved, that input is
resolved. If two or more inputs are active and the result names none, nothing is
resolved (the ambiguity is logged), and the rows fall through to recovery at turn
end. The fallback is a **safety net**, not a normal path: all providers — Claude,
Codex, OpenCode, and Mock — emit `input-accepted` with an `inputId` and carry
`resolvedInputIds` (or `supersededInputIds`) in their `result` (Task 1 updated
Claude and Codex to do this; see the Deploy Ordering section of the plan). In
normal operation every result names its resolved inputs explicitly, and the
fallback only fires if a result somehow declares none.

## Provider Implementations

Only the `claude` provider ships in trunk. The Codex and OpenCode sections below document the provider interface for reference and for skills that install additional providers — they are not baked into the core image.

### Claude Provider

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

```typescript
class ClaudeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();  // AsyncIterable<SDKUserMessage>
    stream.push(input.prompt);

    const sdkQuery = query({
      prompt: stream,
      options: {
        cwd: input.cwd,
        resume: input.sessionId,
        resumeSessionAt: input.resumeAt,
        systemPrompt: input.systemPrompt
          ? { type: 'preset', preset: 'claude_code', append: input.systemPrompt }
          : undefined,
        mcpServers: input.mcpServers,  // already the right shape
        additionalDirectories: input.additionalDirectories,
        env: input.env,
        allowedTools: NANOCLAW_TOOL_ALLOWLIST,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: {
          PreCompact: [{ hooks: [preCompactHook] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [sanitizeBashHook] }],
        },
      },
    });

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      abort: () => sdkQuery.close(),
      events: translateClaudeEvents(sdkQuery),
    };
  }
}
```

`translateClaudeEvents` is an async generator that maps SDK messages to `ProviderEvent`:
- `message.type === 'system' && message.subtype === 'init'` → `{ type: 'init', sessionId }`
- `message.type === 'result'` → `{ type: 'result', text }`
- `message.type === 'system' && message.subtype === 'api_retry'` → `{ type: 'error', retryable: true }`
- `message.type === 'system' && message.subtype === 'rate_limit_event'` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `message.type === 'system' && message.subtype === 'task_notification'` → `{ type: 'progress', message }`
- Everything else → logged, not emitted

**Claude-specific features preserved inside the provider:**
- `MessageStream` for async iterable input (push-based)
- `resumeSessionAt` for resume at specific message UUID
- PreCompact hook for transcript archiving
- PreToolUse hook for sanitizing bash env vars
- Full tool allowlist
- `additionalDirectories` for multi-directory access

### Codex Provider

Wraps `@openai/codex-sdk`.

```typescript
class CodexProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const codex = new Codex(this.buildOptions(input));
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, this.threadOptions(input))
      : codex.startThread(this.threadOptions(input));

    const abortController = new AbortController();
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        // Codex doesn't support streaming input.
        // Store the follow-up and abort the current turn.
        pendingFollowUp = msg;
        abortController.abort();
      },
      end: () => { /* no-op — Codex turns end naturally */ },
      abort: () => abortController.abort(),
      events: this.run(thread, input.prompt, abortController, () => pendingFollowUp),
    };
  }

  private async *run(thread, prompt, abortController, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    let currentPrompt = prompt;

    while (true) {
      try {
        const streamed = await thread.runStreamed(currentPrompt, {
          signal: abortController.signal,
        });

        let sessionId: string | undefined;
        let resultText = '';

        for await (const event of streamed.events) {
          if (event.type === 'thread.started') {
            sessionId = event.thread_id;
            yield { type: 'init', sessionId };
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            resultText = event.item.text || resultText;
          }
          if (event.type === 'turn.failed') {
            yield { type: 'error', message: event.error.message, retryable: false };
            return;
          }
        }

        yield { type: 'result', text: resultText || null };

        // Check if a follow-up was queued during this turn
        const followUp = getPendingFollowUp();
        if (followUp) {
          currentPrompt = followUp;
          // Reset for next iteration
          continue;
        }

        return;
      } catch (err) {
        if (abortController.signal.aborted && getPendingFollowUp()) {
          // Aborted because of follow-up — restart with new prompt
          currentPrompt = getPendingFollowUp();
          abortController = new AbortController();
          continue;
        }
        throw err;
      }
    }
  }
}
```

**Codex-specific behavior inside the provider:**
- `developer_instructions` for system prompt (loaded from CLAUDE.md)
- `git init` in workspace (Codex requires a git repo)
- Abort+restart pattern for follow-up messages
- `sandboxMode`, `approvalPolicy`, `networkAccessEnabled` from env vars
- Conversation archiving (Codex doesn't have PreCompact)

### OpenCode Provider

Wraps `@opencode-ai/sdk`.

```typescript
class OpenCodeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    // OpenCode runs a local server — create it once, reuse across queries
    const { client, server } = await createOpencode({ config: this.buildConfig(input) });
    const { stream } = await client.event.subscribe();

    let aborted = false;
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        pendingFollowUp = msg;
        server.close();  // interrupt current query
      },
      end: () => { /* no-op */ },
      abort: () => { aborted = true; server.close(); },
      events: this.run(client, server, stream, input, () => pendingFollowUp),
    };
  }

  private async *run(client, server, stream, input, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    const session = await client.session.create();
    yield { type: 'init', sessionId: session.data.id };

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { parts: [{ type: 'text', text: input.prompt }] },
    });

    for await (const event of stream) {
      if (event.type === 'session.idle') {
        // Collect result text from accumulated message parts
        const resultText = this.extractResult(event);
        yield { type: 'result', text: resultText };

        const followUp = getPendingFollowUp();
        if (followUp) {
          await client.session.promptAsync({
            path: { id: session.data.id },
            body: { parts: [{ type: 'text', text: followUp }] },
          });
          continue;
        }

        return;
      }

      if (event.type === 'session.error') {
        yield { type: 'error', message: event.properties?.error?.data?.message, retryable: false };
        return;
      }
    }
  }
}
```

> The sketch above is simplified for the interface contract. The production
> OpenCode provider is substantially more involved: it owns a per-query runtime
> controller, a single-reader event pump, native-question denial, liveness
> notices, and typed terminal interruptions. See
> [Recoverable Provider Interruptions](#recoverable-provider-interruptions) and
> [OpenCode Long-Work Liveness](#opencode-long-work-liveness) below.

**OpenCode-specific behavior inside the provider:**
- A **per-query runtime controller** (`OpenCodeRuntimeController`) owns exactly one `opencode serve` process + root client + SSE event stream. There is no module-global singleton: a relay (below) builds a *separate* controller, so a timeout/abort on one turn cannot kill a concurrent relay turn. `destroy()` quiesces the in-flight read (`stream.return()`) before killing the process so a retiring runtime cannot steal a new query's first event.
- Provider/model selection via config (`OPENCODE_PROVIDER` — default `anthropic` in-container, only OneCLI-managed built-in auth providers allowed; `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL`, `OPENCODE_VISION_MODEL`).
- MCP config format translation (`type: 'local'`, `command: [cmd, ...args]`, `environment`).
- Shared base + per-group fragments + per-group memory loaded through OpenCode's native `instructions` pipeline (`/app/CLAUDE.md`, `/workspace/agent/.claude-fragments/*.md`, `/workspace/agent/CLAUDE.local.md`) — concrete files, because OpenCode does not expand `@./...` includes.
- Stale-session recovery: a verbatim stale-session phrase on `promptAsync` starts a fresh session once (`recoveredFromStale`), re-emitting `init`.
- **Native questions are disabled and denied** — see [Native Question Handling](#opencode-native-question-handling).

## Recoverable Provider Interruptions

A long Yente turn must never end in a raw timeout, a silently-dropped row, or a
lost session. The contract: **the provider reports facts, the poll loop owns
recovery and the row lifecycle.** A terminal failure surfaces as a typed
`interruption` event (sanitized, input-correlated, continuation-policy-tagged),
and the poll loop converts accepted-but-unresolved rows into durable, route-scoped
recovery rather than completing or re-queuing them blindly.

### Input ledger and row lifecycle

The poll loop assigns each batch of work an `inputId` and tracks it in an in-turn
ledger with states `queued → accepted → resolved`, plus `returned` (unaccepted,
sent back to pending) and `recovery_owned`.

- A claimed row is marked `processing` (`processing_ack.status='processing'`) only after a *successful* `query.push`; a throwing push leaves rows in `processing` (host-sweep retries) and registers no ledger entry.
- `input-accepted` moves the entry to `accepted`. Acceptance is never completion.
- A `result` naming the `inputId` (or the one-active-input fallback) resolves it; only resolved inputs' rows are completed.
- At turn end (the `finally` block), any entry still `accepted` is moved into recovery ownership; any entry still `queued` (never accepted) is returned to pending so a later wake retries it. Neither is silently completed.

### Recovery lifecycle

Route-scoped recovery entries (`ProviderRecoveryEntry`, stored in `session_state`)
move through `pending → in_flight → resolved`/`superseded`:

- On a wake, `pending`/`in_flight` recovery entries for the **active route** are resumed: their context is injected (XML-escaped) into the **top-level** prompt only, and the entries are marked `in_flight` on acceptance.
- An entry is marked `resolved` (and its owned rows completed) **only on a successful provider result** that resolves/supersedes the exact inputs it owns — never on mere acceptance, relay notice, or fallback notice (the "deletion only on success" invariant).
- **Unresolved entries are never count-pruned.** `pruneResolvedRecoveryEntries` only trims `resolved`/`superseded` entries; `pending`/`in_flight` always survive. Appending under pressure fails closed (`pressureExceeded`) and keeps existing unresolved work rather than discarding it.
- Recovery-ownership is **atomic**: `appendRecoveryEntryAndOwnRows` writes the recovery payload (`session_state`) and the row ownership (`processing_ack.status='recovery'`) in one outbound-DB transaction, so a crash mid-transaction strands no half-owned state. If it fails, rows stay `processing` (retryable) and a structured alert is logged.
- A malformed recovery payload is repaired **non-destructively** (`recoverMalformedRecovery`): salvage any `messageId` fragments into a reconstructed `pending` entry, otherwise leave a fallback marker. It never silently deletes owned work (`destroyedSilently` is always false).

### Recovery-owned ack host sync

Recovery-owned rows (`processing_ack.status='recovery'`) are **excluded from the
host due-count** (`countDueMessagesExcludingRecovery`) so they don't trigger a
redundant wake, and are **preserved across container startup and host sweep**
(recovery owns them until it succeeds; startup orphan-cleanup only removes
transient `processing` acks, never `recovery`). A `processing_ack.status='failed'`
row syncs to a completed inbound row **only with notice-proof** — its
`notice_message_out_id` must point at an existing user-visible terminal notice in
`messages_out`; a failed ack with a NULL or dangling notice id is invalid host
state and is left uncompleted (so a failure never silently swallows inbound work).

### Route normalization and route-scoped recovery

All routing uses a single host-stamped normalizer (`normalizeRoute`) over
`platform_id`/`channel_type`/`thread_id` plus host-stamped `messaging_group_id`
and `is_group`. The same normalizer drives both route splitting and recovery
scope:

- Only rows on the **trigger route** (the route of the wake-triggering message) are claimed into a turn; other-route rows stay pending and are never folded into the active prompt, accumulated context, or recovery — both in the initial batch and in follow-up polling.
- Recovery is keyed by `provider + normalized route`, stored under the **trigger** route (not the first-row route).
- Same-route, multi-trigger rows become the recovery entry's ordered `originalTasks`.
- Same-route outbound rows (`messages_out`) are stamped with the active route (`route_key`/`messaging_group_id`/`is_group`) so the agent's progress, results, relay messages, and fallbacks are harvestable into route-scoped recovery. Cross-destination rows are not stamped with the active route.
- Null-thread DMs are aliased consistently by the normalizer so a DM's recovery route is stable.

### Inactivity relay

On a non-terminal `notice` (inactivity), the poll loop keeps the original turn
draining and surfaces a status message out-of-band:

- If the provider advertises `supportsSeparateRelayRuntime`, the loop starts at most one bounded **relay** per throttle window as a *child task* (never awaited in the main loop). The relay is a **separate restricted runtime**: its own process/client/event pump/session id, no continuation, and a route-locked, `send_message`-only MCP allowlist (its NanoClaw MCP subprocess is launched in relay mode; native mutation/shell/file/web/question tools are denied via the OpenCode `tools`/`permission` maps).
- The relay races a `relayDeadlineMs` deadline. If the relay fails at setup or misses its deadline (and nothing was delivered), the loop sends **one** direct sanitized fallback (`fallbackUserMessage`) — guarded once per turn by `directFallbackSent`.
- While a relay is in flight, follow-up polling is disabled so the relay never claims user rows and unrelated rows stay pending.
- If the provider has no relay capability, a single direct sanitized fallback is sent instead.

### OpenCode native question handling

OpenCode's native interactive-question tool is **disabled and denied** — NanoClaw
routes user questions through its own `ask_user_question` MCP tool, not the
provider's native surface. The behavior is driven by the *probed* SDK 1.15.10
surface (recorded in `fixtures/opencode-sdk-question-surface.json`):

- The provider uses the **root** `createOpencodeClient`, whose event union has no `question.*` events and no `client.question` namespace. So native questions are detected on the root surface: a `message.part.updated` whose part is a `ToolPart` with `tool === 'question'`, correlated by `callID` to the matching `permission.updated`, which is denied via the real reject API (`postSessionIdPermissionsPermissionId(..., { response: 'reject' })`). The v2 `client.question`/`question.asked` surface is recorded in the probe fixture so a future client swap is caught, but production uses root.
- The native question tool is disabled at config time via `tools.question = false` (the real surface — a `permission.question` key would silently no-op, since the only real permission keys are `edit|bash|webfetch|doom_loop|external_directory`).
- **Current behavior:** when a native question is denied, the continuation is cleared (`clear-continuation`) and the turn ends with a user-visible terminal interruption whose recovery seed visibly names the blocked question, so the next turn restarts with that context. The cancellable-preserve-on-reuse optimization is **not implemented** — `OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS` is reserved for that future path; today every native question is denied and cleared with restart recovery.

### Continuation clearing

A continuation is cleared **only** through one of three sanctioned paths — never
on transport error text, a bare `404`, `ECONNRESET`, or any timeout string:

1. An explicit provider `clear-continuation` event.
2. A **positive session-existence check** (`client.session.get`; a `NotFoundError` result ⇒ session gone). This is wired only on a terminal `transport-timeout` / `stream-read-error` / `stream-ended` interruption that carries an attempted continuation, and is consulted on the live controller *before* teardown. A throwing/transport-failing check is inconclusive ⇒ continuation is preserved.
3. The bounded **zombie** path: `OPENCODE_CONTINUATION_FAILURE_LIMIT` consecutive preserve-continuation terminal interruptions on the *same* continuation (counter persisted per provider+continuation in `session_state`, reset by any successful result) ⇒ clear and restart with user-visible context.

The diagnostic predicate `isMissingOpenCodeSessionError` is trigger-only (requires
the exact attempted id verbatim alongside a missing-session phrase) and is never
itself authoritative. `clearContinuationWithProof` refuses to act without
attempted-continuation metadata.

## OpenCode Long-Work Liveness

A long Yente turn (minutes to hours of tool work, often with no SSE traffic) must
stay alive and state-preserving. The provider runs a **single-reader event pump**
(`OpenCodeEventPump`) over the runtime's SSE stream:

- **Heartbeat / wait-tick.** The pump emits non-terminal `wait-tick`, `keepalive`, and `inactivity-notice` results (`OPENCODE_WAIT_TICK_MS`, `OPENCODE_INACTIVITY_NOTICE_MS` / `..._REPEAT_MS`). Each maps to an `activity`/`notice` provider event, refreshing the host heartbeat. The inactivity-notice clock tracks **meaningful** events only, so a heartbeat-only stream still surfaces inactivity, while the transport clock tracks **any** event so a heartbeat keeps the transport alive.
- **No-SSE transport timeout.** `OPENCODE_TRANSPORT_TIMEOUT_MS` (default 30 min) is the silence window after the last event; hitting it yields a typed `transport-timeout` interruption.
- **Absolute turn ceiling, enforced by the pump independent of heartbeat.** `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS` (default 6 h) is computed from turn start, so heartbeats cannot push it out; hitting it yields a typed `absolute-timeout` interruption. Host-sweep mirrors this: its kill ceiling is `max(ABSOLUTE_CEILING_MS, declaredToolTimeoutMs)` but a declared long tool may raise it only up to `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`, never past it.
- **Declared-tool timeout caps.** A long OpenCode tool's declared timeout is persisted to `container_state` (so host-sweep widens its tolerance) but is capped by `min(OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS, declared, absolute-budget − elapsed − margin)`; a non-positive cap is treated as "no widening tool."
- **Injected clock/scheduler.** The pump takes a mandatory injected `now()`/`schedule()` and **never** calls global `setTimeout`/`setInterval`/`Date.now` (production wires real timers in the provider; tests inject a fake clock so a 6-hour scenario runs instantly).
- **Single-reader rule.** Exactly one perpetual reader calls `stream.next()` for the stream's whole lifetime, so a read-ahead past one turn's terminal event survives the turn boundary in the bounded queue. The queue never silently drops a *protected* event (terminal/permission/question/assistant-text/side-effect) — it signals `queue-overflow` instead.
- **Model-provider request timeout.** Set under the *active* provider name: `provider[OPENCODE_PROVIDER || 'anthropic'].options.timeout` (a large positive ms value, default = the absolute ceiling; **never** `0`, which means immediate abort). SDK 1.15.10 has no top-level `Config.options.timeout`, so this is the correct key to stop the hidden 5-minute provider request abort from undercutting the liveness pump.

**`OPENCODE_*` knobs (10).** The host forwards only present overrides (omitting
unset keys so the in-container default applies):
`OPENCODE_TRANSPORT_TIMEOUT_MS`, `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`,
`OPENCODE_INACTIVITY_NOTICE_MS`, `OPENCODE_INACTIVITY_NOTICE_REPEAT_MS`,
`OPENCODE_WAIT_TICK_MS`, `OPENCODE_RELAY_DEADLINE_MS`,
`OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS`, `OPENCODE_MODEL_PROVIDER_TIMEOUT_MS`,
`OPENCODE_CONTINUATION_FAILURE_LIMIT`, and the reserved
`OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS`.

## Side-Effect Trust Mechanism

A recovered/resumed turn must report work it already did (a sent Gmail draft, a
generated D&D summary) instead of duplicating it — but agent-writable evidence can
never be trusted. The mechanism is asymmetric **Ed25519**: the GWS proxy holds the
*private* signing key; the container and host hold only the *public* verify key.
The pure verify + canonical-JSON + classify/sanitize logic lives in
`side-effects-verify.ts`, kept **byte-identical** as a container copy and a host
copy (the host TS project cannot import `bun:sqlite`; a cross-check test diffs the
two copies against the same signed/forged/tampered vectors).

- **GWS split (Task 4A vs 4B).** Audit *classification* (4A) labels every GWS proxy call (API-effect vs non-API probe/help/schema) for the audit log. The *signed ledger* (4B) is the separate trust path: the proxy emits `X-GWS-Side-Effect-*` headers and a detached Ed25519 signature; the shim's ledger write is gated on `X-GWS-Api-Effect: true`.
- **Per-input correlation file.** The poll loop atomically writes `/workspace/.active-input.json` (`{inputId, routeKey, updatedAt}`, temp+rename) at acceptance time. The GWS shim and summarize-dnd read it to stamp staged JSONL with the *current* input's correlation (a file, not env, because a long-lived tool child can't see env updates across follow-ups). Staleness is judged by timestamp.
- **Validation rules.** Staged JSONL is a staging channel, not truth. `importSideEffectLedger` is idempotent on the record id (`audit_id` for GWS). A `gmail_draft_created` entry is authoritative **only** when its detached Ed25519 signature verifies over the exact forwarded canonical payload bytes AND that payload's `audit_id` binds to the record's idempotency key (so a real signature can't be replayed under a different id). A `summarize_dnd_summary_artifact` is authoritative only when the referenced artifact exists under an allowed root and matches the staged size. Unsigned / no-key / forged / tampered entries fail closed and stay **unvalidated hints**; only authoritative entries seed recovery or satisfy success assertions. The agent never holds the private key, so it cannot fabricate a valid entry.
- **Host import + crash-window discovery.** On recovery-after-kill, the host reopens the outbound DB writable only after verified container exit, then imports the host session path's staged JSONL. A **host-only** `GWS_AUDIT_STORE` crash-window fallback catches a completed `drafts.create` whose JSONL append was lost to a kill in the window. Because the audit store is a shared global file, the discovery is **scoped** to this turn (route + inputId from `.active-input.json`, plus a `notBefore` turn-start bound) so it never imports another conversation's drafts.
- **Partial success.** If the external mutation succeeded but staging/import failed, the durable proof is the signed audit record (crash-window discovery), so recovery still records the side effect rather than redoing it.
- **Feature status.** The GWS side-effect feature is **inactive** until the Ed25519 keypair is provisioned: with no configured verify key, every `gmail_draft_created` entry stays an unvalidated hint. It can be enabled/disabled independently of code (key present vs absent).

## Optional MCP Bridge Credential Degradation

An optional MCP bridge (e.g. Granola) degrades to a sanitized "unavailable" state
**only** for known, expected credential failures — never for anything that could
mask a real problem:

- The marker-check is the production path: a missing auth marker ⇒ `auth_required`; a present-but-expired marker ⇒ `auth_expired`. Both surface as the typed `AgentMcpCredentialUnavailableError`, which the container-runner degrades to unavailable **only for an optional bridge** (`required === false`); a required bridge fails closed.
- Integrity gates run first and always **fail closed** (never degrade): auth-dir ownership must match the service uid/gid, the auth path must contain no symlinks, and private-perm / mount-overlap / malformed-marker / missing-required-bridge conditions all propagate as plain startup errors.
- When a bridge degrades, its MCP entry and allowed tools are omitted, and a sanitized always-in-context fragment (`mcp-<name>-unavailable.md`) is written into the agent's `.claude-fragments` so the unavailable state reaches the OpenCode-loaded context Yente reads. Fragments are cleared once every optional bridge is healthy again.

## Deploy Ordering, Rollback, and Backward Compatibility

Each cross-repo change is an additive no-op against an old peer, so a partial
deploy fails safe to "feature inactive," never to a half-present contract. Safe
deploy order is GWS proxy (4A then 4B) and summarize-dnd first, then provision the
Ed25519 keypair, then NanoClaw last; revert in reverse. The full deploy-ordering,
rollback, and cross-repo backward-compatibility contract (including the in-flight
outbound-DB self-migration and the `inputId` provider-contract-flip regression
gate) lives in the implementation plan's **"Deploy Ordering, Rollback, And
Backward Compatibility"** section
(`docs/plans/2026-05-28-yente-opencode-timeout-hardening.md`).

## Agent-Runner Core

Everything below is handled by the agent-runner, not the provider.

### Poll Loop

```
┌─────────────────────────────────────────┐
│                                         │
│  1. Query messages_in for pending rows  │
│     WHERE status = 'pending'            │
│     AND (process_after IS NULL          │
│          OR process_after <= now())     │
│                                         │
│  2. If rows found:                      │
│     a. Set status = 'processing'        │
│     b. Format messages by kind          │
│     c. Strip routing fields             │
│     d. Call provider.query(prompt)      │
│     e. Process provider events          │
│     f. Write results to messages_out    │
│     g. Set status = 'completed'         │
│                                         │
│  3. While query is active:              │
│     - Continue polling messages_in      │
│     - New messages → provider.push()    │
│                                         │
│  4. When query finishes:                │
│     - Back to step 1                    │
│     - If no messages, sleep + re-poll   │
│                                         │
└─────────────────────────────────────────┘
```

**Concurrent polling during active query:** While the provider is running a query, the agent-runner continues polling messages_in on a short interval (~500ms). New pending messages are formatted and pushed into the active query via `provider.push()`. This lets follow-up messages arrive while the agent is processing — Claude handles this natively, Codex/OpenCode handle it via abort+restart internally.

**Idle behavior:** When no messages are pending and no query is active, the agent-runner sleeps briefly (1s) and re-polls. The container stays warm until the host kills it (idle timeout).

**Idle detection exceptions:** The container should NOT be considered idle when:
- An `ask_user_question` tool call is pending (waiting for user response in messages_in)
- The agent is actively working (tool calls in progress, subagents running)

The agent-runner signals "busy" status to the host. The mechanism for this is provider-specific — for Claude, the query AsyncGenerator is still yielding events. For others, the agent-runner can write a heartbeat or status indicator to the session DB that the host checks before killing.

### Message Formatting

The agent-runner transforms messages_in rows into a prompt string. The provider receives a ready-to-send string — it doesn't know about message kinds or routing.

**Routing field stripping:** `platform_id`, `channel_type`, `thread_id` are never included in the prompt. They're stored as context for writing messages_out.

**Single message formatting by kind:**

- **`chat`** — format into message XML:
  ```xml
  <message sender="John" time="2024-01-01 10:00">
    Check this PR
  </message>
  ```

- **`chat-sdk`** — extract fields from serialized Chat SDK message:
  ```xml
  <message sender="John (john@slack)" time="2024-01-01 10:00">
    Check this PR
    [image: screenshot.png — https://signed-url...]
  </message>
  ```
  Attachments are listed inline. Images/PDFs that Claude handles natively are passed as content blocks (see Media Handling below).

- **`task`** — task prompt, optionally with script output:
  ```
  [SCHEDULED TASK]

  Script output:
  {"data": ...}

  Instructions:
  Review open PRs
  ```

- **`webhook`** — webhook payload:
  ```
  [WEBHOOK: github/pull_request]

  {"action": "opened", "pull_request": {...}}
  ```

- **`system`** — host action result (response to an earlier system request):
  ```
  [SYSTEM RESPONSE]

  Action: register_agent_group
  Status: success
  Result: {"agent_group_id": "ag-456"}
  ```

**Batch formatting:** Multiple pending messages are combined into one prompt:

```xml
<context timezone="America/Los_Angeles">
<messages>
<message sender="John" time="10:00">Check this PR</message>
<message sender="Jane" time="10:01">Already on it</message>
</messages>
```

Mixed kinds (e.g., a chat message + a system response) are combined with clear delimiters. Each section is labeled by kind.

**Command detection:** Messages starting with `/` are checked against a command list. Recognized commands bypass formatting and are passed raw to the provider (for Claude's slash command handling) or intercepted by the agent-runner (for NanoClaw-level commands like session reset).

### Routing

When the agent-runner picks up messages_in rows, it captures the routing fields from the batch:

```typescript
interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;  // messages_in.id of the triggering message
  routeKey?: string | null;
  messagingGroupId?: string | null;
  isGroup?: 0 | 1 | null;
}
```

The agent never sees raw routing fields in the prompt. The runner keeps them as delivery metadata and fills `routeKey`/`messagingGroupId`/`isGroup` from the normalized active route when a provider turn starts.

Provider final text is explicitly routed, not implicitly delivered. The runner sends only `<message to="destination-name">...</message>` blocks from the final provider result. Text outside those blocks, including `<internal>...</internal>`, is scratchpad: it is logged and not sent. Unknown destinations are dropped with a warning and added to scratchpad.

For a final `<message>` addressed to the active route, the runner writes a `messages_out` row with the active reply/thread metadata and the active route stamp so recovery can harvest it as prior progress. For a final `<message>` addressed to another destination, the runner writes to that destination but leaves the active `in_reply_to`, `thread_id`, `route_key`, `messaging_group_id`, and `is_group` fields unset so a cross-destination message cannot be recovered as progress for the triggering conversation.

MCP tools that send to a named destination resolve the name through the `destinations` table. `send_message` applies the same route-stamp rule: current-route messages are stamped for recovery; cross-destination messages are not.

### Status Management

The agent-runner manages the `status` and `status_changed` fields on messages_in:

```
pending → processing → completed
                    → failed (if provider returns error and max retries exhausted)
```

- **Pick up:** `UPDATE messages_in SET status = 'processing', status_changed = now(), tries = tries + 1 WHERE id IN (...)`
- **Complete:** `UPDATE messages_in SET status = 'completed', status_changed = now() WHERE id IN (...)`
- **Error:** Agent-runner does NOT set `failed` — it leaves the message as `processing`. The host detects stale processing via `status_changed` and handles retry logic (reset to pending with backoff). This keeps retry policy on the host side.
- **Recovery:** A terminal interruption with accepted-but-unresolved rows is a fourth disposition: those rows are moved into recovery ownership (`processing_ack.status='recovery'`) instead of completed or returned to pending. See [Recoverable Provider Interruptions](#recoverable-provider-interruptions) for the input ledger and recovery lifecycle, and [Recovery-owned ack host sync](#recovery-owned-ack-host-sync) for how recovery and `failed` acks sync to inbound status.

### MCP Tools

The agent-runner runs an MCP server that exposes NanoClaw tools to the agent. All tools write to the session DB.

**DB path:** The MCP server receives the session DB path via environment variable. It opens a second connection to the same SQLite file (WAL mode allows concurrent access).

#### send_message

Send a chat message to the current conversation (or a specified destination).

```typescript
{
  name: 'send_message',
  params: {
    text: string,          // message content
    to?: string,           // optional destination name
  }
}
```

Implementation: resolve `to` against the destination map and write a `messages_out` row with `kind: 'chat'`. If `to` is omitted, the tool replies to the session's current conversation when session routing is available; otherwise the legacy single-destination shortcut applies. A same-route send preserves the session thread and is stamped with the active route for recovery. A cross-destination send starts with `thread_id = NULL` and no active route stamp.

#### send_file

Send a file to the current conversation or a named destination.

```typescript
{
  name: 'send_file',
  params: {
    to?: string,           // optional destination name
    path: string,          // file path (relative to /workspace/agent/ or absolute)
    text?: string,         // optional accompanying message
    filename?: string,     // display name (default: basename of path)
  }
}
```

Implementation:
1. Generate a message ID
2. Create `outbox/{messageId}/` directory
3. Copy the file into the outbox directory
4. Write a `messages_out` row with `files: [filename]` in the content

#### send_card

Send a structured card (interactive or display-only).

```typescript
{
  name: 'send_card',
  params: {
    card: CardElement,     // card structure (title, children, actions)
    fallbackText?: string, // text fallback for platforms without card support
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat-sdk'` and the card structure in content.

#### ask_user_question

Send an interactive question and wait for the user's response. This is a **blocking tool call** — the tool doesn't return until the user responds.

```typescript
{
  name: 'ask_user_question',
  params: {
    title: string,         // short card title, e.g. "Confirm deletion"
    question: string,
    options: (string | { label: string; selectedLabel?: string; value?: string })[],
    timeout?: number,      // seconds (default: 300)
  }
}
```

Implementation:
1. Generate a `questionId`
2. Write a `messages_out` row with `operation: 'ask_question'`, the question, options, and questionId
3. Poll `messages_in` for a row with matching `questionId` in content
4. When found, return the `selectedOption` as the tool result
5. If timeout expires, return a timeout error as the tool result

The agent's execution is paused at this tool call. The provider's query keeps running (Claude holds the tool call open). The agent-runner polls for the response in a separate loop.

#### edit_message

Edit a previously sent message.

```typescript
{
  name: 'edit_message',
  params: {
    messageId: string,     // integer ID as shown to the agent
    text: string,          // new content
  }
}
```

Implementation: write a `messages_out` row with `operation: 'edit'`, the message ID, and new text.

#### add_reaction

Add an emoji reaction to a message.

```typescript
{
  name: 'add_reaction',
  params: {
    messageId: string,     // integer ID as shown to the agent
    emoji: string,         // emoji name (e.g., 'thumbs_up')
  }
}
```

Implementation: write a `messages_out` row with `operation: 'reaction'`.

#### Agent destinations

There is no separate `send_to_agent` tool. Agents and channels share the same destination namespace, so sending to another agent group uses `send_message({ to: "<agent-name>", text })`. The destination row resolves to `channel_type: 'agent'` and `platform_id: agentGroupId`.

#### schedule_task

Schedule a one-shot or recurring task.

```typescript
{
  name: 'schedule_task',
  params: {
    prompt: string,             // task prompt
    processAfter: string,       // ISO timestamp for first run
    recurrence?: string,        // cron expression (optional)
    script?: string,            // pre-agent script (optional)
  }
}
```

Implementation: write a `messages_in` row (to self) with `kind: 'task'`, `process_after`, and optionally `recurrence`. The host sweep picks it up when due.

#### list_tasks

List active scheduled/recurring tasks.

```typescript
{
  name: 'list_tasks',
  params: {}
}
```

Implementation: query `messages_in WHERE recurrence IS NOT NULL AND status != 'failed'`.

#### cancel_task / pause_task / resume_task / update_task

Modify a scheduled task.

```typescript
{
  name: 'cancel_task',
  params: { taskId: string }
}
// pause_task: set status = 'paused' (new status value for recurring tasks)
// resume_task: set status = 'pending'
// update_task: merge { prompt?, recurrence?, processAfter?, script? } into the live row
```

Implementation: cancel/pause/resume update the live row(s) directly. update_task is sent as a system action — the host reads current content, merges supplied fields, and writes back. All four match by `(id = ? OR series_id = ?) AND kind='task' AND status IN ('pending','paused')`, so they reach the live next occurrence of a recurring task even when the agent passes the original (now-completed) id.

#### register_agent_group

Register a new agent group (admin only).

```typescript
{
  name: 'register_agent_group',
  params: {
    name: string,
    folder: string,
    platformId: string,        // messaging group to wire to
    channelType: string,
    triggerRules?: object,
    sessionMode?: 'shared' | 'per-thread',
  }
}
```

Implementation: write a `messages_out` row with `kind: 'system'`, `action: 'register_agent_group'`. The host reads, validates admin permission, creates the entity rows in the central DB, and writes a `system` messages_in response.

### Media Handling

#### Inbound (messages_in → agent prompt)

The agent-runner inspects attachments in chat/chat-sdk messages and handles them based on type and provider capability:

**Provider-native content blocks:**

| Type | Claude | Codex / OpenCode |
|------|--------|------------------|
| Images (JPEG, PNG, GIF, WebP) | Native image content block | Save to disk |
| PDFs | Native document content block | Save to disk |
| Audio | Native audio content block | Save to disk |
| Other files (code, data, video, archives) | Save to disk | Save to disk |

**"Save to disk"** means: download to `/workspace/downloads/{messageId}/`, reference in the prompt text:

```
<message sender="John" time="10:00">
  Check this spreadsheet
  [file available at: /workspace/downloads/msg-123/data.xlsx]
</message>
```

The agent can use tools (Read, Bash) to access saved files.

For channels where direct download isn't possible (e.g., WhatsApp buffered streams), the channel adapter serves the media via a local URL. The agent-runner downloads from that URL.

**Content block construction (Claude):** The agent-runner builds multi-part `MessageParam` content: `[{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text: '...' }]`. The prompt passed to the provider is not a plain string in this case — the `QueryInput.prompt` field needs to support structured content for Claude. The provider's `query()` method handles the format-specific construction.

**Content block construction (Codex/OpenCode):** Everything is text. File references are inlined in the prompt string. The provider receives a plain string prompt.

#### Outbound (agent → messages_out)

Handled via the `send_file` MCP tool (see above). The agent explicitly decides to send a file — the agent-runner doesn't scan output for file references.

### Pre-Agent Scripts (Tasks)

For `task` kind messages with a `script` field in the content:

1. Agent-runner writes the script to a temp file
2. Executes with `bash` (30s timeout)
3. Parses last line of stdout as JSON: `{ wakeAgent: boolean, data?: unknown }`
4. If `wakeAgent === false`: mark message as completed, don't invoke the provider
5. If `wakeAgent === true`: enrich the prompt with script output, then invoke the provider

### Transcript Archiving

The agent-runner archives conversation transcripts before context compaction. For Claude, this is handled via the PreCompact hook (provider-internal). For other providers that don't have hooks, the agent-runner archives after each query completes based on the provider's output.

Archive location: `/workspace/agent/conversations/{date}-{summary}.md`

### Session Resume

The agent-runner tracks `sessionId` and `resumeAt` across queries:

- `sessionId` — captured from `ProviderEvent { type: 'init' }`. Passed back to `QueryInput.sessionId` on the next query.
- `resumeAt` — Claude-specific (last assistant message UUID). Stored by the agent-runner, passed to `QueryInput.resumeAt`. Providers that don't support this ignore it.

These are ephemeral to the container's lifetime. When the container is killed and restarted, the host passes the stored `sessionId` from the central DB's sessions table. `resumeAt` is lost on container restart (the provider resumes from the end of the session).

### Container Startup

The agent-runner receives configuration via:

- **Environment variables:** `AGENT_PROVIDER` (claude/codex/opencode), `NANOCLAW_ADMIN_USER_ID`, provider-specific vars (API keys, model overrides), `TZ`
- **Fixed mount paths:** Session DB at `/workspace/session.db`. Agent group folder at `/workspace/agent/`. System prompt from `/workspace/agent/CLAUDE.md` and `/workspace/global/CLAUDE.md`.
- **Optional startup config:** Some config may be passed as a JSON file at a fixed path (e.g., `/workspace/config.json`) for things like the session ID to resume, assistant name, and admin user ID. This avoids overloading environment variables.

The agent-runner reads config, creates the provider, and enters the poll loop. No stdin, no initial prompt — messages are already in the session DB.

### Provider Factory

```typescript
type ProviderName = 'claude' | string;

function createProvider(name: ProviderName, config: ProviderConfig): AgentProvider {
  // Trunk registers 'claude'; additional providers self-register when installed via skills.
  const factory = providerRegistry.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}`);
  return factory(config);
}
```

The provider name comes from the container's environment (`AGENT_PROVIDER` env var), set by the host based on `agent_groups.agent_provider` or `sessions.agent_provider`.

`ProviderConfig` contains provider-specific settings (API keys, model overrides, etc.) passed via environment variables — not via the interface. Each provider reads what it needs from `env`.

## Agent-Runner Properties

- MCP server is a separate Node process spawned by the provider (via `mcpServers` config)
- The MCP server binary is shared across providers — same tools, same DB access
- CLAUDE.md loading (global + per-group) — agent-runner reads and passes as `systemPrompt`
- Additional directories discovery (`/workspace/extra/*`)
- Logging via stderr (`[agent-runner] ...`)

## Related Documents

- **[architecture.md](architecture.md)** — High-level architecture (session DB schema, central DB, channel adapters, message flow)
- **[api-details.md](api-details.md)** — Channel adapter interface, message content examples, host delivery logic
