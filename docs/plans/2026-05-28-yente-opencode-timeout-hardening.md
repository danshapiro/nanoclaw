# Yente OpenCode Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yente must survive slow OpenCode work, OpenCode inactivity/transport failures, native OpenCode question stalls, optional Granola credential failures, and misleading GWS probe audit logs without losing user state; the observed Dvora and Fruma failures must be replayed by injecting the same requests into local Yente and proving they ultimately succeed.

**Architecture:** Tool/proxy boundaries stage side-effect evidence before returning success, but only validated imports into outbound DB recovery state are authoritative. Providers emit typed activity, prompt acceptance, side-effect references, continuation, and interruption facts, but the poll loop owns route-scoped recovery, row lifecycle, Yente-authored relays, and fallback notices. OpenCode gets a single-reader SDK 1.15.10-compatible event pump, exact stale-session classification, a separate restricted relay runtime for status messages, SDK-surface probing for native questions, route-locked status output, and explicit continuation policy.

**Tech Stack:** TypeScript, Bun tests for `container/agent-runner`, Vitest for host-side NanoClaw, Go tests for `gws-skill`, Python/pytest for `summarize-dnd`, SQLite session state, OpenCode SDK 1.15.10 event stream.

---

## Scope And Strategy

This work intentionally spans three repositories because the user's request includes Yente state preservation, the GWS audit-log confusion found during root-cause analysis, and `summarize-dnd` side-effect recovery for the observed Dvora incident. `summarize-dnd` is a generic local skill used by any Yente instance, not a Dvora-specific skill; Dvora is the incident agent whose workflow exposed the gap.

- NanoClaw work happens in `/home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening`.
- GWS audit-log work happens in a new `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening` worktree.
- Generic `summarize-dnd` side-effect marker work happens in a new `/home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger` worktree.
- Do not mutate the live `shapiroserver2` host or run production deploys.
- The required "inject requests into Yente" validation is local: insert `messages_in` rows, run `runPollLoop()`, use the real `OpenCodeProvider` against a deterministic OpenCode runtime harness whose events match probed SDK fixtures, route Fruma through the production GWS shim/proxy boundary, route Dvora through the production `summarize-dnd` side-effect boundary, and assert `messages_out`, `processing_ack`, `session_state`, `container_state`, provider events, audit records, and validated tool-side effects.
- The trycycle test-plan phase remains required, but the user has explicitly waived test-plan confirmation. Build the test-plan artifact without asking for approval unless the test strategy materially changes scope or violates these contracts. The executable replay and failure-mode requirements below are implemented as automated tests in the implementation tasks.
- Production smoke is the ship blocker. Unit/integration/replay coverage is sufficient for ongoing development, but this change is not ready to ship until the canonical Yente production smoke proves the fixed Dvora/Fruma paths do not regress in the real runtime.
- Environment preconditions are handled once in **Task 0** before any red/green cycle: `bun install` in `container/agent-runner`, the dependent-repo worktrees and their Python venv, dependent-repo test-invocation discovery, and the GWS Ed25519 keypair note. Do not assume any of these exist.
- Execution granularity: any checkbox that spans more than three ownership boundaries is a grouping header, not a single implementation commit. In particular, Task 1 Step 6, **Task 1 Step 7** (the shared `ProviderEvent`/`QueryInput` type change — the real breaking-type-change epicenter), Task 1 Step 10, and Task 3 Step 5 must be split into smaller red/green commits during execution. Task 1 Step 7 in particular must follow the additive-optional-then-required ordering specified in that step so each intermediate commit type-checks green.
- GWS audit hardening covers observed probe classes that reach `/exec`: help/version probes, schema/introspection probes, and local validation/dry-run probes. Work that does not reach `/exec`, such as `gws auth status`, remains outside the GWS proxy audit fix.

## Non-Negotiable Acceptance Contracts

A fresh readiness review should start here. The implementation details below may change during execution, but these contracts must not be weakened, replaced by synthetic provider-only checks, or satisfied by assistant text that is not backed by provider events, row lifecycle, recovery state, and tool-side evidence.

### Replay Integrity Contract

Incident replay tests may replace network/model calls with a deterministic runtime, but they must not replace the NanoClaw state machine with a scripted success provider. Final success text is not accepted unless the test has also observed the real `OpenCodeProvider` consume probed SDK-shaped events, emit matching `input-accepted` and input-resolution facts, cross the GWS or Dvora tool boundary, import validated side-effect evidence, preserve route-scoped row lifecycle, and resolve recovery through `runPollLoop()`.

**Fake-leaf boundary (so the exact-string assertions are achievable, not a contradiction).** The LLM is a faked SDK leaf: the test MAY inject the assistant message-part/`result` SDK event that carries a literal string such as the Dvora progress line, `5/19 summary complete`, or `Draft created in Gmail.`. That is permitted because the real `OpenCodeProvider` still parses that event, the real poll loop still routes/delivers it, and the literal-string assertions verify ROUTING and DELIVERY of that faked leaf to `messages_out` on the correct route — not LLM authorship. What the contract forbids is bypassing the state machine: a `ScriptedProvider` that emits `messages_out` success WITHOUT the real provider's `input-accepted`/result-resolution, recovery lifecycle, route-scoping, and validated side-effect import. In short: fake the model's output event (allowed); never fake the NanoClaw machinery that must carry it (banned).

### Dvora Replay Contract

Automated local Yente injection must model both observed Dvora failures as one user-visible recovery sequence:

- The first failure path uses session `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- The replay emits the observed progress message through Yente-visible output, not seeded hidden history:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

- The old 300s meaningful-event timeout point produces a Yente-visible relay through the separate restricted relay runtime, or one sanitized direct fallback if relay setup/deadline fails. It never clears continuation by stale-session heuristic, never marks the user turn done as a raw error, never stops legitimate long work, and never writes `OpenCode event timeout` to user output.
- If the exact inbound request before the progress message can be recovered from local logs or artifacts, use it as the fixture and cite that evidence in a test comment. If it cannot be recovered, state that evidence boundary in the fixture and use the transcript-provided progress line plus follow-up as the minimum exact replay. Implementation must not block on unavailable logs.
- The later follow-up is injected exactly:

```text
Great. Now do the 5/19 summary.
```

- The second historical path uses session `ses_19757b6f7ffeYulTtPz3gteQ84` and must also avoid raw timeout output and state loss.
- Final success is through Yente: the replay proves the original task, progress, continuation or restart recovery context, follow-up row, and generic `summarize-dnd` summary side effect survive until the 5/19 summary is delivered.

### Fruma Replay Contract

Automated local Yente injection must model the May 24 Fruma Gmail draft failure:

- The initial user row is exactly:

```text
Actually create a draft in my gmail
```

- The replay uses session `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Before replaying the prompt, search/recover the prior Fruma conversation context that made "Actually create a draft in my gmail" refer to Matt Van Horn. If unavailable, record the evidence boundary in the fixture and provide the minimal context that establishes Matt Van Horn as the intended recipient.
- The observed GWS help probe occurs before draft creation: `gws gmail users drafts create --help`, which previously produced misleading audit records. If the recovered/probed Fruma path also performs schema/introspection or local validation probes through `/exec`, those probes are included and classified as non-API effects.
- The replay must cross the production GWS shim/proxy boundary with fake network/API leaves only. Fabricated provider side-effect events or alternate audit writers are insufficient.
- Native OpenCode question handling is modeled from a checked SDK surface. The OpenCode implementation task must probe the active root/v2 SDK event and client APIs; production code must handle whichever real event surface is available and statically guard only invented or still-unhandled assumptions. Existing evidence suggests `message.part.updated` carries a `ToolPart.callID` or equivalent part id, while `permission.updated` carries `Permission.callID` and `Permission.id` where available, but the tests must be driven by the probe result instead of a hard-coded belief that `client.question` cannot exist.
- Yente visibly asks for Matt Van Horn's email before the test injects the answer. The test must fail if the answer is injected before a visible Yente question exists.
- The injected answer allows Gmail draft creation to complete. The test must assert tool-side draft creation evidence, not only final assistant text.
- GWS probe audit records are classified as non-API probes with `api_effect:false`, while the actual draft creation remains an API effect. This is audit classification only; command admission, authentication, policy, signature, and rate-limit behavior are not broadened.

### Inactivity Visibility Contract

The previous 300s no-meaningful-event condition is a user-visible liveness moment, not a fatal timeout, hidden context, or host-authored raw error.

- During non-terminal long work, the poll loop starts at most one bounded Yente-authored status relay per throttle window through a separate restricted OpenCode runtime. The relay runtime has its own process/client/event pump/session id, no continuation, no access to mutation tools, and no ownership over the original input rows.
- The original OpenCode turn's event stream continues to be read while the relay is running. The relay's `send_message` appends only user-visible status `messages_out` rows route-locked to the active route; it never writes `processing_ack`, `session_state`, recovery rows, or original input rows. Concurrency safety is NOT a cross-process "transaction queue" (the relay's `send_message` executes in its own MCP-server subprocess, so the poll-loop process cannot serialize it in-process). It comes from the existing in-container `outbound.db` discipline: every in-container writer — the poll loop and each MCP-server subprocess, including the relay's — coordinates only through SQLite file locking (`PRAGMA busy_timeout=5000`, DELETE journaling), the host stays the sole reader across the mount, and correctness rests on row-level ownership (a relay write can never resolve or complete another input's rows). Relay appends are small and bounded, so the only contention is short `SQLITE_BUSY` retry within the 30s relay window.
- If the separate relay runtime cannot start, accept the relay prompt, or finish before its deadline, the poll loop sends one sanitized direct fallback and keeps the original turn/recovery state intact.
- Terminal interruptions such as transport timeout, native-question deadlock, stream end, queue overflow, startup timeout, or prompt-acceptance timeout create a recoverable pause. Because the original turn is no longer usable at that point, the next Yente turn receives the recovery payload as a normal top-level prompt before any direct fallback is sent.
- Every terminal interruption path must produce either a Yente-authored recovery message or, if recovery query startup/acceptance misses its bounded deadline, one sanitized direct fallback. No terminal path may leave the user unaware that they need to continue or retry.

The implementation must not queue a message into the same busy OpenCode turn and wait for that turn to process it before the user sees anything.

### Side-Effect And External-Failure Contract

Completed side effects before final assistant output are recovery facts. Gmail draft creation and generic `summarize-dnd` summary artifact creation must be staged before the tool returns success to OpenCode, then validated into outbound DB before recovery uses them:

- NanoClaw sets the static path `NANOCLAW_SIDE_EFFECT_LEDGER=/workspace/side-effects.jsonl` in the OpenCode/Yente runtime and child tool environment at container construction. The per-input correlation fields `inputId` and `routeKey` are NOT process env vars: a child tool process inherits env once at fork, but the OpenCode server and its MCP/tool children are long-lived across many accepted inputs/follow-ups in one wake, so a stale env would mis-stamp a follow-up's side effect with the initial input id. Instead the poll loop writes the current accepted input to `/workspace/.active-input.json` (`{ "inputId", "routeKey", "updatedAt" }`) atomically (temp+rename) on each `input-accepted`, and the GWS shim and `summarize-dnd` read that file at invocation time to stamp staged JSONL. This is an in-container file read (the heartbeat/no-IPC rule governs the host↔container boundary, not poll-loop↔tool inside the container). The host-side path for the ledger is derived from `sessionDir(agentGroupId, sessionId)/side-effects.jsonl`; host recovery never imports using the container literal path. If `/workspace/.active-input.json` is absent or stale-by-timestamp, the tool stages an uncorrelated diagnostic record (no `inputId`) that cannot resolve recovery by itself.
- GWS draft creation: on a successful API-effect mutation the GWS proxy returns an **Ed25519 detached signature** over canonical side-effect metadata plus the `X-GWS-*` headers (see "Side-Effect Trust Mechanism" below); the NanoClaw `container/shim/gws` writes a sanitized `gmail_draft_created` JSONL entry carrying that signature only after the successful API-effect response and before printing success to OpenCode. The shim does not verify the signature (it cannot meaningfully in POSIX sh, and staged JSONL is untrusted regardless) — it forwards it for the container/host importer to verify.
- `summarize-dnd` summary artifact creation: `summarize-dnd` writes a sanitized `summarize_dnd_summary_artifact` JSONL entry to `NANOCLAW_SIDE_EFFECT_LEDGER` immediately after writing the summary output files and before returning the stage/full-run success payload.
- NanoClaw treats workspace JSONL as a staging channel, not as authoritative truth. Import validates GWS `gmail_draft_created` entries by verifying the proxy's Ed25519 signature with the **public** key (held by both the container and the host; the agent never holds the private key, so it cannot forge a valid entry), and validates `summarize-dnd` entries against actual artifact files under allowed output roots (existence + hash/size under an allowed root). Only validated entries become idempotent outbound DB `side_effect_ledger` rows (idempotency key = the proxy-generated `audit_id` for GWS, the stable artifact-path/run-id key for `summarize-dnd`), written during normal provider polling before recovery writes, or from the host only after the container is verified stopped. An entry that fails verification is retained as an unvalidated hint only and can never satisfy recovery or final-success assertions.
- Side-effect recovery kind is separate from GWS `api_effect`. `api_effect` only describes whether a GWS invocation could mutate Google APIs; recovery uses durable kinds such as `gmail_draft_created` and `summarize_dnd_summary_artifact` with operation-specific evidence and replay policy. `summarize_dnd_recording_cached` is a RESERVED kind with NO producer implemented in this plan — the Drive recording selection/download is modeled in the replay as faked SDK tool-call leaf events (the harness fakes the multi-GB download), not a durable side effect. The enum value is retained for forward use but no task writes it; recovery does not depend on it.
- If an external mutation or artifact write succeeds but the staging ledger append or validation import fails (the tool process is still alive), the tool must not print ordinary success. It returns a structured partial-success/recoverable error with safe evidence and emits structured JSONL so recovery can tell Yente what already happened without duplicating it.
- The crash window is bounded explicitly. If the tool process is SIGKILLed/host-swept BETWEEN external mutation success and the JSONL append, there is no JSONL entry and no partial-success return, so the JSONL-rooted importer cannot see it. The no-duplication guarantee therefore holds whenever the tool process survives to append; for the kill-in-the-window case the spec provides a discovery fallback (defined in Task 4B): the shim forwards `inputId`/`routeKey` to the proxy on every call, the proxy records them in its append-only audit store at `GWS_AUDIT_STORE` (a root-owned, host-readable JSONL file the co-located NanoClaw host reads directly), and GWS recovery queries that store by `inputId`/`routeKey`/time-window to detect a completed draft-create with no JSONL entry; `summarize-dnd` recovery scans allowed artifact roots for an output matching the active run with no ledger reference. This discovery channel is gated on `GWS_AUDIT_STORE` (and the signing key) being configured; where it is not wired the spec states the residual as "no duplication when the tool process survives to append" rather than claiming an unconditional guarantee.

Provider-observed tool events may reference or enrich these entries but are not the sole source of truth. Terminal failure after a side effect but before final output, host-sweep kill/reset, container crash, provider startup failure, session creation failure, prompt-acceptance failure, and pre-query failure after row claim must all produce durable route-scoped recovery or a user-visible fallback without raw provider errors.

### Side-Effect Trust Mechanism

Validation must work on BOTH sides of the mount: the container importer (during normal provider polling) and the host importer (during sweep/crash recovery). The agent runs in the container, and per the NanoClaw rules the container/agent must never hold GWS secrets. A symmetric HMAC is therefore unusable (the verifier would need the signing secret, which would let the agent forge). The mechanism is **asymmetric Ed25519 signing**:

- The `gws-proxy` holds the Ed25519 **private** key, loaded from a root-owned file referenced by `GWS_SIDE_EFFECT_SIGN_KEY_FILE` (provisioned under the existing gitignored `/srv/nanoclaw/secrets/` path; see Task 0). On a successful API-effect mutation the proxy computes a detached signature over a canonical JSON payload `{ audit_id, service, method, request_class, api_effect, operation_succeeded, occurred_at, result_digest }` and returns it plus the `X-GWS-*` headers. `audit_id` is a proxy-generated unique id; `result_digest` is a hash of the response/parsed draft id.
- The Ed25519 **public** key is distributed to both the container (read-only, safe — verification grants no forging power) and the host, via `GWS_SIDE_EFFECT_VERIFY_KEY` / a mounted public-key file. The agent cannot fabricate a valid `gmail_draft_created` entry because it lacks the private key.
- Importers (`container/agent-runner/src/db/side-effects.ts` and the host helper) accept a `gmail_draft_created` row as authoritative only if the Ed25519 signature verifies over the staged canonical payload. `inputId`/`routeKey` are NanoClaw correlation hints stapled by the shim, not part of the signed payload; a wrong correlation only mis-routes a *real* draft's recovery, it can never fabricate a draft. Idempotency key = `audit_id`, so replaying a genuine past signature is an idempotent no-op, not a new draft.
- `summarize-dnd` artifacts need no key: validation is artifact existence + hash/size under an allowed output root. The signing mechanism is GWS-only.
- The feature degrades safely when keys are absent (e.g. dev, or pre-deploy): the proxy emits classification headers but no signature, and the importer treats unsigned `gmail_draft_created` JSONL as an unvalidated hint only — never authoritative — so the security invariant "agent-writable staged JSONL is never authoritative" holds with or without the key. Side-effect recovery for Gmail is simply inactive (falls back to safe partial-success/audit evidence) until the keypair is provisioned.

## State Lifecycle Contract

Provider code emits typed facts only. The poll loop owns route-scoped recovery, message-row lifecycle, relay/fallback behavior, and recovery resolution. The required transitions are:

| State source | Owner | Required transition |
| --- | --- | --- |
| Raw wake rows | Poll loop | Split by normalized route before claim; same-route triggers become ordered `originalTasks`; other routes remain pending. |
| Accumulated context rows | Poll loop | Partition `trigger=0` rows by normalized route before prompt formatting and recovery. Context from unrelated routes is excluded rather than carried with the active trigger. |
| Top-level and follow-up prompts | Poll loop plus provider fact | Generate `inputId`; treat prompt as accepted only after provider `input-accepted` for that exact id. |
| Successful provider results | Provider plus poll loop | Resolve input ids deterministically. Each result must declare resolved or superseded input ids, or the poll loop must have exactly one active accepted input and map the result to that id. Ambiguous success is a recoverable implementation error, not row completion. |
| Accepted but unresolved rows | Poll loop | Move to recovery-owned ledger/ack on terminal interruption; complete only after successful result or explicit supersession. |
| Unaccepted route-matched follow-ups | Poll loop | Return to pending by deleting only transient `processing_ack.status='processing'` rows; never hide behind stale or recovery-owned acks until the provider accepts their `inputId`. |
| Unaccepted other-route rows | Poll loop | Return to pending and exclude from the active route's recovery payload. |
| Recovery entries | Poll loop | Store from raw rows, route-matched prior progress harvested from `messages_out`, MCP `send_message` outputs, follow-ups, accepted/unresolved inputs, durable side-effect ledger entries, provider interruption metadata, and safe tool state; do not delete on prompt acceptance. |
| Recovery `in_flight` entries | Poll loop | Retain until a successful provider result resolves the owning input ids, or until an explicit superseding user request creates an enriched replacement. Relay notices, fallback notices, prompt acceptance, and failed recovery attempts never delete the underlying unresolved work. |
| Recovery-owned acks | Poll loop plus host sync | Store `processing_ack.status='recovery'` and recovery payload updates in one atomic transaction. Host wake/sync excludes recovery-owned rows from due counts and preserves them on sweep/startup; only `processing` acks are reset as orphan claims. |
| Inactivity notices | Provider fact, poll-loop action | Provider reports liveness metadata including configured timeout, elapsed time, last event type, and last meaningful-event timestamp; poll loop relays through a separate restricted Yente runtime or sends one sanitized direct fallback without clearing continuation by heuristic. |
| Continuation clearing | Provider fact, poll-loop storage | Clear only on (a) an explicit provider `clear-continuation`, (b) a positive existence check proving the attempted session is gone — query the SDK for that exact session id (`client.session.get`/list resolves not-found), never string-match error text — or (c) the bounded zombie path: `OPENCODE_CONTINUATION_FAILURE_LIMIT` (default 3) consecutive terminal interruptions on the same continuation with no successful event in between, which clears with user-visible restart recovery. Transport errors, bare `404`, `ECONNRESET`, stream end, and event-timeout text are never proof on their own. This closes both the false-positive (clearing a live session, the Dvora bug) and the false-negative (a dead session preserved forever with no bounded recovery). |
| Side effects | Tool/proxy boundary plus validated import | Stage sanitized evidence into `/workspace/side-effects.jsonl` before returning external success, then validate and import it into outbound DB `side_effect_ledger` before recovery writes. Provider side-effect events reference or enrich imported rows only. Retry prompts must tell Yente what already happened and tests must fail on duplicate draft/summary creation. |
| Recovery relay turns | Poll loop plus separate relay provider | Run only through a separate restricted OpenCode runtime with its own process, client, event pump, session id, deadline, route-locked `send_message`, status-only MCP allowlist (its own MCP-server subprocess launched in relay mode), and native OpenCode mutation/shell tools disabled. Relay turns never use the original busy session, never resolve original input rows, and never mutate external systems. Relay outbound writes append only route-locked status `messages_out` rows and rely on SQLite-level serialization (`busy_timeout`), not a cross-process transaction queue. Providers without separate-runtime relay support keep the original long turn running and use one direct sanitized fallback after relay setup/deadline failure. |

The central design rule is ownership separation:

- Providers own SDK I/O and only emit facts correlated to an `inputId` or explicit active-ledger correlation: activity, prompt acceptance, result resolution, side-effect ledger references, typed interruptions, and explicit continuation policy.
- The poll loop owns recovery context. It builds recovery from raw wake rows, route-scoped follow-ups, user-visible progress rows written during the accepted-input window, MCP `send_message` outputs, side-effect ledger entries, provider interruption metadata, and safe tool state.
- Recovery is not consumed when the provider merely accepts a prompt. It is marked `in_flight` for that `inputId` and resolved only after a successful provider result resolves/supersedes the exact input ids. If the recovery attempt fails, hangs, is interrupted, or the container dies, the original recovery payload remains available and may be enriched, not deleted.
- Unresolved recovery entries are never pruned by count. Pruning may apply only to entries already `resolved` or `superseded`; pressure from too many unresolved entries must fail closed with structured alerts and user-visible fallback rather than discard state.
- Host recovery writes obey the existing single-writer invariant for outbound DB. The host may open outbound DB writable for recovery only after it has verified that the container is exited or killed and no runner process can still write the DB. Sweep/startup recovery imports side effects and writes recovery/fallback before any fresh container wake for the same session.
- Route identity uses host-stamped messaging metadata, not inference from nullable thread ids. The router/session-manager path writes `messaging_group_id` and `is_group` into `session_routing`, `messages_in`, and route-bearing `messages_out`; the container normalizer may collapse null-thread/threaded aliases only when that host data proves the route is a DM/non-group conversation.

## Hard Invariants

- Native-question handling must be based on a checked active SDK surface, not an assumption that a root/v2 API is absent. Add an SDK compatibility probe that records whether native questions appear as `message.part.updated`/`permission.updated`, `client.question` helpers, `question.*` events, or another exported surface. Implement the real surface in production and statically guard only fake or still-unhandled surfaces.
- `buildOpenCodeConfig()` must disable the native question tool through OpenCode tool availability, not only through `permission.question`.
- Relay-mode `buildOpenCodeConfig()` must disable native OpenCode mutation/shell/file/web/question tools using the REAL SDK identifiers, not invented category names. SDK 1.15.10 `Config.permission` keys are exactly `edit | bash | webfetch | doom_loop | external_directory`, and `Config.tools` is an arbitrary `{ [id]: boolean }` map — so a guessed id like `shell`/`filesystem`/`web` silently no-ops and leaves the real tool enabled. Deny via the real permission keys (`bash:'deny'`, `webfetch:'deny'`, `edit:'deny'`, `external_directory:'deny'`) AND set each probe-discovered tool id to `false` in `tools`. A test must POSITIVELY assert the relay runtime's actually-reachable tool set equals the allowlist (only the route-locked `send_message` + listed read-only status tools) — not merely that some deny keys were written. The only write tool available to relay mode is a NanoClaw `send_message` variant locked to the original normalized route.
- `buildOpenCodeConfig()` must raise or disable OpenCode's model-provider request timeout for long Yente turns so NanoClaw's liveness pump is not undercut by a hidden 5-minute provider request timeout. In SDK 1.15.10 `Config.provider` is keyed by provider name and the field is `provider[<activeProvider>].options.timeout` — there is no top-level `Config.options.timeout`. The active provider is `process.env.OPENCODE_PROVIDER || 'anthropic'`; the field type is `number | false` and the SDK docs say "Default is 300000 (5 minutes). Set to false to disable timeout." So set `options.timeout` to `false` (disable) or a large positive ms value (e.g. the absolute turn ceiling) — NEVER `0`, which is a 0 ms timeout (immediate abort) and would recreate or worsen the production failure. Emitting `{ provider: { options: { timeout } } }` is also a bug (it creates a provider literally named `options` and leaves the real abort in place). Tests must assert the value resolves under the ACTIVE provider name, not merely that a `timeout` key exists somewhere, and the field name must come from the SDK-surface probe rather than a hard-coded belief.
- OpenCode inactivity, transport errors, bare `404`, `ECONNRESET`, stream end, queue overflow, and "event timeout" text are not stale-session proof. Continuation is cleared only on (a) an explicit provider `clear-continuation`, (b) a positive existence check that the attempted session is gone, or (c) the bounded zombie path below. Note: in SDK 1.15.10 the missing-session error is a `NotFoundError` whose only payload is a free-form `data.message: string` with no structured session id, so the attempted id is NOT guaranteed to appear in the error text — string matching is therefore unsound for the false-negative direction. Use a positive existence check instead: query the SDK for the exact attempted session id (in SDK 1.15.10 the call is options-object form, `client.session.get({ path: { id: attemptedSessionId } })`, returning a `RequestResult` discriminated on `.data`/`.error` — a `NotFoundError` means gone) as the proof source. The Task 2/3 SDK-surface probe must capture the real missing-session API/error shape, the existence-check API, AND which client construction is in use — the native-question surface differs by client (the root `createOpencodeClient` exposes `message.part.updated`/`permission.updated` and has no `question` namespace; the v2 client exposes `question.asked`/`client.question`), so the probe records both.
- The zombie-session backstop is bounded and never silent. After `OPENCODE_CONTINUATION_FAILURE_LIMIT` (default 3) consecutive terminal interruptions on the same continuation with no successful event in between, the continuation is treated as unusable, cleared, and the next turn restarts from recovery with user-visible context — so a genuinely dead session that emits only bare 404s is not preserved forever and does not retry indefinitely.
- Transport timeout preserves continuation unless a positive existence check proves the attempted session is missing, an explicit provider `clear-continuation` event is observed, or the zombie limit is reached.
- The previous 300s "meaningful event" watchdog becomes a non-terminal inactivity notice, not a raw error and not stale-session handling. On each throttled inactivity notice, the poll loop attempts a bounded Yente-authored status relay only through a separate restricted relay runtime. Relay failure or deadline expiry sends one sanitized direct fallback while the original long turn continues; it does not settle, hide, or clear the original work.
- No-SSE and heartbeat-only long work must remain state-preserving for longer than the observed Dvora gap. Default no-SSE transport death must be at least 30 minutes when no bounded long tool is active; a declared active long tool may continue through wait ticks up to its capped timeout and the absolute turn ceiling. Wait ticks/keepalives must refresh host heartbeat before host sweep can kill the container.
- Declared tool timeouts are capped by `min(OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS, OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS - elapsedTurnMs - safetyMarginMs)`. A tool cannot widen host-sweep tolerance beyond the configured hard ceiling.
- `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS` (default 6h) is the single source of truth for maximum turn lifetime. host-sweep's effective kill ceiling for an OpenCode turn is the existing `max(ABSOLUTE_CEILING_MS=30min, declaredToolTimeoutMs)` (generalized from the current Bash-only `declaredBashMs` path to any provider-owned tool), and a declared long tool may raise it up to — but never beyond — `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`. Critically, the pump must enforce `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS` itself, INDEPENDENT of heartbeat refresh, so a heartbeat-refreshing-but-stuck/looping turn is terminated with recovery at the ceiling rather than living for the full declared-tool window. A test must prove a turn that keeps refreshing the heartbeat via wait ticks is still terminated/recovered at the absolute ceiling (the pump kills it; host-sweep at the same effective ceiling is only the backstop for a fully wedged pump). Note the host-sweep widening does not exist for OpenCode today — `bashTimeoutMs` returns non-null only when `current_tool==='Bash'` and only Claude persists `container_state` tool timeouts — so raising an OpenCode turn's effective ceiling above the bare 30-min `ABSOLUTE_CEILING_MS` requires BOTH Task 2 Step 6 (generalize the host-sweep filter beyond Bash) AND Task 3 Step 8 (OpenCode persists the active long tool's declared timeout to `container_state`); the no-SSE long-work contract depends on both being wired.
- Provider events related to a turn must include `inputId` or an explicit correlation to the active input ledger. Top-level prompts and follow-up pushes are considered accepted only after the provider emits `input-accepted` for the matching id. Results must resolve or supersede exact input ids unless the poll loop has a provable one-active-input mapping. All provider implementations and tests must be updated: Claude, Codex, OpenCode, Mock, provider push tests, factory tests where needed, and poll-loop scripted test providers.
- Provider `error` events cannot be log-only. Remove them from the normal provider event contract or classify them as terminal recoverable interruptions with input correlation, recovery metadata, continuation policy, and fallback handling.
- User rows are completed only after the accepted input is resolved by a successful provider result or explicit supersession. Accepted-but-unresolved inputs that hit a terminal interruption move into recovery ownership and must not disappear merely because the SDK accepted them.
- Unaccepted follow-ups have one defined lifecycle. Route-matched unaccepted follow-ups are returned to pending by deleting only transient `processing_ack.status='processing'` rows. Other-route unaccepted rows are always returned to pending and never included in the active route's recovery payload.
- Accepted-but-unresolved rows use a durable recovery ack/ledger state so they stay hidden from normal pending scans while recovery owns them. They are marked completed only when the recovery attempt succeeds.
- `processing_ack.status='failed'` is not a recoverable-interruption state. It is reserved for rows with an already-written user-visible terminal fallback and no resumable work; host sync must not silently complete a failed ack that lacks that notice proof.
- Moving rows into recovery ownership and appending/enriching the recovery payload must be one atomic database transaction. Crash-point tests must prove no accepted row can be stranded without either recovery state or pending visibility.
- Malformed recovery cleanup is non-destructive for owned work. Before deleting malformed payload JSON, reconstruct from recovery-owned rows and prior progress when possible; if reconstruction is impossible, return owned rows to pending or send a route-scoped fallback notice before clearing recovery ownership.
- Initial work is split by normalized route when multiple wake-triggering routes are present. Same-route wake-triggering messages are preserved as an ordered `originalTasks` array, not collapsed into one newest task. Other routes remain pending. Accumulated `trigger=0` rows are also partitioned by normalized route before prompt formatting and recovery.
- Route matching must handle the existing null-thread/DM-thread mismatch using host-provided `messaging_group_id` and `is_group`, not a guess from thread id shape. Known DM aliases may be collapsed only when `is_group=0` and the rows share the same `messaging_group_id`/platform identity. Distinct non-DM threads remain isolated. Recovery must not leak across conversations in shared sessions. Rows missing `messaging_group_id`/`is_group` (legacy rows, or scheduling-inserted task rows — see Task 1 Step 6) are never collapsible: null fails the positive collapse predicate and is treated as its own distinct route, so the only failure mode is a missed merge, never a cross-conversation leak. A test must assert a follow-up row lacking the new metadata is NOT collapsed onto a route.
- Recovery prompt injection is XML-escaped and happens only for a new top-level `provider.query(...)`, never for `query.push(...)`.
- Follow-up polling is disabled or strictly route-filtered during bounded recovery relay turns so unrelated pending messages stay pending. Relay turns must not claim normal user rows; they can only read a route-scoped recovery snapshot and write relay output/attempt metadata.
- Pre-query failures after rows are claimed are recoverable. Attachment inspection, formatting, pre-task script handling, provider startup, session creation, and prompt acceptance failures must either return unaccepted rows to pending or store route-scoped recovery before settling.
- Host-sweep kill/reset and container-crash recovery must create a user-visible recovery path before re-wake. When the host resets active processing rows for an interrupted turn, it first verifies the container is stopped, imports the host path corresponding to `/workspace/side-effects.jsonl`, then writes a scoped recovery record or a direct fallback notice with enough route and original-task context for the next Yente turn to resume.
- Side effects that complete before final assistant output must become durable recovery facts only after validated import. For the observed scenarios this means Gmail draft creation and `summarize-dnd` summary artifact creation are recorded in `side_effect_ledger` with verified id/path/output evidence so recovery does not duplicate drafts or redo completed summary artifacts.
- Optional MCP degradation is narrow. Only expected missing/expired credential classes for Granola, such as "auth required" or "auth expired", may degrade to unavailable optional state. Auth-directory integrity, ownership, symlink, mount-overlap, malformed config, and required bridge failures remain fail-closed.
- Optional Granola degradation must reach the actual OpenCode prompt/system context that Yente loads, not just host-side config. Tests must assert the sanitized unavailable state appears in the runner files or system-context payload consumed by OpenCode.
- Optional Granola degradation tests must cover the actual bridge auth-stall/startup-abort shape: an auth-required bridge that never becomes ready within its startup deadline degrades only when the failure is categorized as missing/expired credentials, and all integrity or required-bridge failures remain fail-closed.
- GWS `/exec` help, version, schema/introspection, and local validation/dry-run probes remain subject to the same authentication and admission behavior they have today. The GWS change is audit classification plus response metadata only: classify before request/completion logging, set `request_class` and `api_effect:false`, add response headers for the shim ledger, and do not log probes as successful Gmail API mutations. The classification is audit-only and does NOT short-circuit admission or execution: a probe still authenticates, still flows through `checker.Check(service, method, params)` (so a `drafts.create` policy denial still denies a `drafts.create --help` probe), still passes the rate limiter for rate-limited methods (note: only `gmail.send` and `calendar` have limiters — `users.drafts.create` is not rate-limited today, so a drafts help probe consumes no token), and still invokes the real `gws … --help` binary via `ExecGWS`. A `proxy_test.go` case must assert that a help probe of a rate-limited method (e.g. a `+send`/calendar method) still consumes/denies under the existing limiter, so the "admission unchanged" claim is provable rather than asserted. Do not add schema command admission, do not change `gws auth status`, and do not bypass policy controls beyond existing behavior.

## File Structure

### NanoClaw Agent Runner

- Create `container/agent-runner/src/providers/opencode-events.ts`
  - Single-reader OpenCode SSE pump.
  - Session-scoped event filtering and SDK 1.15.10 surface-probe/shape helpers.
  - Deterministic clock/scheduler injection for tests.
  - Result kinds: `event`, `keepalive`, `wait-tick`, `inactivity-notice`, `transport-timeout`, `absolute-timeout`, `read-error`, `ended`, `queue-overflow`.
  - Every notice/interruption/terminal result carries configured timeout, elapsed time, last event type, and last meaningful-event timestamp.
  - Bounded queue policy that never silently drops terminal, permission, question, assistant text, or side-effect events.

- Create `container/agent-runner/src/providers/opencode-errors.ts`
  - Typed OpenCode interruption errors and metadata helpers.
  - Exact attempted-session missing-session classifier.

- Modify `container/agent-runner/src/providers/types.ts`
  - Add `inputId` to `QueryInput` and `QueryTurnInput`.
  - Add provider events for `input-accepted`, `result` with mandatory input resolution, `interruption`, `notice`, `side-effect`, `clear-continuation`, and source-tagged `activity`.
  - Add provider capability metadata for separate-runtime relay support, relay deadlines, and relay tool policy.
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
  - Probe, disable, and deny native OpenCode question through the real active SDK config/events/permission APIs.
  - Build relay-mode OpenCode config with native mutation, shell, filesystem, edit, web, and question tools disabled.
  - Raise or disable OpenCode model-provider request timeout in generated config for long Yente turns.
  - Yield activity for event, keepalive, and wait ticks.
  - Yield `notice` for inactivity status relay and typed terminal `interruption` for true terminal conditions, each correlated to the active input ledger and carrying liveness metadata.
  - Track prompt acceptance by `inputId`.
  - Track side-effect completion evidence from durable tool/proxy ledger entries and SDK tool parts.
  - Track overlapping active tool parts and persisted `container_state`.
  - Preserve or clear continuation only according to explicit reuse proof.
  - Log structured JSONL with `severity`, `event`, `session_id`, `classification`, and timeout metadata.

- Modify `container/agent-runner/src/providers/mcp-to-opencode.ts` and `container/agent-runner/src/mcp-tools/server.ts`
  - Support a relay-mode MCP allowlist that exposes only `send_message` and explicitly listed read-only status tools.
  - Deny shell, filesystem, GWS, scheduling mutation, self-modification, and external side-effect tools in relay mode.
  - Route-lock relay `send_message` to the wake-triggering normalized route; ignore or reject any `to` argument that would leave that route.

- Modify `container/agent-runner/src/db/session-state.ts`
  - Add route-scoped recovery APIs with entry status: `pending`, `in_flight`, `resolved`, `superseded`.
  - Add recovery input ledger APIs for original rows, follow-ups, accepted/unresolved rows, route-scoped prior progress, side-effect evidence, relay attempts, and non-destructive malformed-json cleanup.
  - Enforce that unresolved recovery entries are never count-pruned; pressure fails closed with structured alerts/fallback.
  - Provide atomic transaction helpers that move rows into `recovery` ownership and append/enrich the recovery payload together.
  - Add explicit continuation-clear helpers that require attempted-continuation metadata.

- Create `container/agent-runner/src/db/side-effects.ts`
  - Idempotently import staged `/workspace/side-effects.jsonl` into outbound DB `side_effect_ledger` (idempotency key = `audit_id` for GWS, stable artifact/run key for `summarize-dnd`).
  - Validate/sanitize known side-effect kinds: `gmail_draft_created`, `summarize_dnd_recording_cached`, `summarize_dnd_summary_artifact`, and `tool_completed`.
  - Treat JSONL entries as untrusted hints until validation succeeds: `gmail_draft_created` requires a valid **Ed25519** signature over the proxy's canonical payload, verified with the **public** key (the `verifyGwsSideEffectSignature(payload, signature, publicKey)` helper, added in **Task 4B** — Task 1 creates this module with the fail-closed default that unsigned Gmail entries are never authoritative); `summarize-dnd` entries require artifact existence + hash/size under an allowed output root (validated in Task 1). The Ed25519 verification logic is reused by the host import helper.
  - When no verify key is configured, leave `gmail_draft_created` entries as unvalidated hints (never authoritative) so the build is green and the feature is inactive rather than insecure.
  - Expose query helpers for recovery prompt construction and replay tests.

- Modify `container/agent-runner/src/db/messages-in.ts`
  - Add helpers to return unaccepted `processing` acks to pending.
  - Add helpers to move accepted/unresolved row ids into `recovery` ack status and later mark them completed or return them to pending on recovery deletion.
  - Add host-sync-visible semantics so recovery-owned acks are hidden from normal due scans but preserved by startup and host sweep.

- Modify `container/agent-runner/src/db/messages-out.ts`
  - Add helpers to harvest route-scoped outbound progress rows and MCP `send_message` outputs written during the accepted-input window for recovery.
  - Persist `input_id`, `route_key`, `messaging_group_id`, and `is_group` on route-bearing progress/relay rows so recovery can harvest only the active conversation.

- Modify `container/agent-runner/src/db/connection.ts`
  - Add outbound DB `side_effect_ledger` forward-compatible schema.
  - Add the `messages_out` route columns (`input_id`, `route_key`, `messaging_group_id`, `is_group`) and the `processing_ack.notice_message_out_id` column (for the `failed`-ack notice-proof rule). These outbound tables are created host-side in `src/db/schema.ts`, which owns the authoritative column additions; `getOutboundDb` today only `CREATE`s `session_state`/`container_state`, so this ADDS new read-compatible `ALTER`/guards there for `messages_out`/`processing_ack` so a container opening an old-schema outbound DB self-migrates instead of failing. (`processing_ack` lives in the outbound DB per `connection.ts` today.)
  - Clear stale provider-owned OpenCode tool state on startup.
  - Preserve recovery-owned ack rows on startup while clearing orphan `processing` rows.

- Modify `container/agent-runner/src/formatter.ts`
  - Export the existing XML escape helper.
  - Add route normalization helpers or import them from a new focused module if the implementation reads cleaner.

- Modify `container/shim/gws`
  - On a successful API-effect response (`X-GWS-Api-Effect: true`, `X-GWS-Operation-Succeeded: true`), append a sanitized `gmail_draft_created` JSONL record carrying the proxy's Ed25519 signature + canonical payload to `${NANOCLAW_SIDE_EFFECT_LEDGER:-/workspace/side-effects.jsonl}` via a true atomic append — `O_APPEND` (POSIX guarantees atomicity for a single write under `PIPE_BUF`) or `flock` — NOT temp+rename. Temp+rename replaces the whole file and would clobber lines written concurrently by other tool processes (other shim invocations, `summarize-dnd`, the relay's tools). Append after the response is received and before stdout is returned to OpenCode. The shim does not verify the signature.
  - Read `inputId`/`routeKey` from `/workspace/.active-input.json` at invocation time (not from process env, which is stale across follow-ups) and staple them into the record as correlation hints; if the file is absent or stale-by-timestamp, stage an uncorrelated diagnostic record that cannot resolve recovery by itself.

- Modify `container/agent-runner/src/poll-loop.ts`
  - Partition initial batches and accumulated `trigger=0` context by normalized route.
  - Build and own route-scoped recovery payloads.
  - Own input ledger state and message-row completion.
  - Resolve successful provider results to exact input ids or fail closed when resolution is ambiguous.
  - Write `/workspace/.active-input.json` (`{inputId, routeKey, updatedAt}`, atomic temp+rename) on each `input-accepted`, so the GWS shim and `summarize-dnd` stamp the correct per-input correlation at tool-invocation time.
  - Attempt bounded Yente-authored relay for non-terminal inactivity notices only when provider capabilities declare separate-runtime relay support.
  - Restrict relay mode to status/message-only behavior with mutation/side-effect tools denied.
  - Lock relay output to the active normalized route. Relay correctness is row-level ownership (relay `send_message` only appends route-locked status `messages_out` rows and never resolves another input's rows), not a cross-process write queue; in-container `outbound.db` writers coordinate through SQLite `busy_timeout` (see the Inactivity Visibility Contract).
  - Disable or route-filter follow-up polling during relay.
  - Convert provider throws and non-retryable provider errors into sanitized recoverable interruptions.
  - Send a Yente-authored terminal recovery message or one sanitized direct fallback when recovery startup/acceptance cannot happen by deadline.
  - Handle pre-query failures under the same recovery/ack lifecycle.

- Create `container/agent-runner/src/opencode-incident-replay.test.ts`
  - Local Yente injection harness using the real `OpenCodeProvider`, deterministic runtime/pump, and local GWS shim/proxy boundary for Fruma replay.

- Create tests:
  - `container/agent-runner/src/providers/opencode-events.test.ts` (new file, Task 2)
- Modify tests:
  - `container/agent-runner/src/providers/opencode.test.ts`
  - `container/agent-runner/src/providers/push.test.ts`
  - `container/agent-runner/src/providers/codex.factory.test.ts`
  - `container/agent-runner/src/providers/mcp-to-opencode.test.ts` (relay-mode allowlist boundary, Task 3)
  - `container/agent-runner/src/db/session-state.test.ts`
  - `container/agent-runner/src/poll-loop.test.ts`
  - `container/agent-runner/src/integration.test.ts` (owned and updated by Task 1: its end-to-end MockProvider `pending=0`-after-result assertions must move to the new `input-accepted`/result-resolution completion semantics)

### NanoClaw Host

- Modify `src/db/schema.ts`
  - Add forward-compatible host schema columns for `messages_in.messaging_group_id`, `messages_in.is_group`, `session_routing.messaging_group_id`, `session_routing.is_group`, and route metadata on outbound `messages_out`.
  - Add outbound DB `side_effect_ledger` schema and imported-side-effect validation metadata.

- Modify `src/db/session-db.ts`
  - Stamp host route metadata into inbound rows and `session_routing`.
  - Own host-side migrations for existing session DBs; container migrations are forward-compatible readers, not the primary writer for host-owned inbound schema.
  - Add host due-count/sync helpers that exclude `processing_ack.status='recovery'` without completing or resetting those rows.
  - Add host-only recovery writer/import helpers that open outbound DB writable only after verified container exit.

- Modify `src/router.ts`
  - Pass `messaging_group_id` and `is_group` from the resolved messaging group into `writeSessionMessage()`.

- Modify `src/session-manager.ts`
  - Pass `messaging_group_id` and `is_group` into session routing and inbound message writes.

- Modify `src/modules/scheduling/db.ts`
  - `insertTask()`/`insertRecurrence()` write wake-eligible `messages_in` task rows but currently omit the new route columns. Stamp `messaging_group_id` and `is_group` here too (or explicitly leave them null), so scheduled-task follow-ups follow the same fail-safe route rule: null metadata is never collapsed, only matched metadata is.

- Modify `src/container-config.ts` and `src/container-runner.ts`
  - Set the static `NANOCLAW_SIDE_EFFECT_LEDGER=/workspace/side-effects.jsonl` in every Yente/OpenCode runtime environment.
  - Mount/inject the Ed25519 **public** verify key (`GWS_SIDE_EFFECT_VERIFY_KEY` or a read-only key file path) into the container; never the private key.
  - Do NOT pass per-input `NANOCLAW_ACTIVE_INPUT_ID`/`NANOCLAW_ROUTE_KEY` as process env (a long-lived child cannot see updates). The per-input correlation is file-based: the poll loop writes `/workspace/.active-input.json` on each `input-accepted` (see `poll-loop.ts`), and the shim/`summarize-dnd` read it at invocation. Container config only needs to ensure `/workspace` is writable by the poll loop and readable by tools.

- Modify `src/host-sweep.ts`
  - Honor bounded declared tool timeout for any provider-owned active tool.
  - Clear stale tool rows after kill/reset.
  - Preserve `processing_ack.status='recovery'` rows during wake/sync and exclude them from due counts.
  - After verified container exit, import side-effect JSONL from the host session path and write recovery records or user-visible fallback notices before resetting active processing claims when a container dies or is killed.
  - Run crash/sweep recovery before waking a replacement container for the same session.

- Modify `src/host-sweep.test.ts`
  - Add declared-timeout cap, no-SSE long-work, crash/kill recovery, and stale-tool cleanup coverage.

- Modify `src/agent-mcp-config.ts`, `src/agent-mcp-bridge.ts`, `src/container-config.ts`, `src/container-runner.ts`, `src/claude-md-compose.ts`
  - Implement narrow optional Granola auth degradation.
  - Ensure sanitized Granola unavailable state reaches the OpenCode-loaded runner files or prompt/system context.

- Create tests:
  - `src/claude-md-compose.test.ts` (new file, Task 5)
- Modify tests:
  - `src/db/session-db.test.ts` (host schema, recovery-ack sync, host-path side-effect import — Task 1)
  - `src/gws-shim.test.ts` (GWS shim ledger writing against a fake proxy — Task 4B)
  - `src/agent-mcp-config.test.ts`
  - `src/agent-mcp-bridge.test.ts`
  - `src/container-runner.test.ts`

### GWS Proxy

Worktree created in Task 0 Step 2. Within `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening`:

- Modify `proxy.go`:
  - Task 4A (audit-only): structural request classification + `request_class`/`api_effect` in audit logs + `X-GWS-*` response headers. No signing, no admission change.
  - Task 4B (signed side-effect channel): add optional `input_id`/`route_key` to `ExecRequest`; generate a unique `audit_id` per request; on a successful API-effect mutation, Ed25519-sign the canonical payload with the key from `GWS_SIDE_EFFECT_SIGN_KEY_FILE` and return `X-GWS-Side-Effect-Signature` + `X-GWS-Side-Effect-Payload`; append `{audit_id, input_id, route_key, service, method, occurred_at}` (no body) via `O_APPEND` to the append-only JSONL store at `GWS_AUDIT_STORE` (root-owned, host-readable) for the crash-window discovery fallback. Uses Go stdlib `crypto/ed25519`. Gated on the two env vars being set.
- Modify `proxy_test.go` (audit classification cases, admission-unchanged cases, signing/verify cases, audit-store query cases).

### Summarize D&D

Worktree + venv created in Task 0 Steps 2-3. Within `/home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger`:

- Modify `summary_writer.py` (shared write+ledger helper called by both `stage_generate_short()` and the full-run `main()` path; ledger append gated on `NANOCLAW_SIDE_EFFECT_LEDGER`; `inputId`/`routeKey` read from `/workspace/.active-input.json`; no transcript/summary body in the record).
- Modify `tests/test_stage_status.py` (stage path + a full-run-path ledger test with stdin/LLM mocked).

### Docs

- Modify `docs/agent-runner-details.md`.

## Task 0: Preconditions And Environment Bootstrap

No red/green cycle in later tasks can run until these exist. None of them are present today; do not assume them.

- [ ] **Step 1: Install agent-runner dependencies**

`@opencode-ai/sdk` is pinned to `1.15.10` in `container/agent-runner/package.json` + `bun.lock`, but `container/agent-runner/node_modules` is absent, so the first `bun test`/typecheck/SDK-surface probe fails at module resolution. Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
bun install
bun pm ls | grep '@opencode-ai/sdk'   # confirm 1.15.10 is resolved before recording probe fixtures
```

The root pnpm/Vitest workspace is already installed, so host-side `pnpm` steps need no extra install; if a host `node_modules` is missing, run `pnpm install` at the repo root.

- [ ] **Step 2: Create dependent-repo worktrees and discover their real test invocation**

Neither `gws-skill` nor `summarize-dnd` has an `AGENTS.md`/`CLAUDE.md`, so the "read the repo's AGENTS.md first" rule cannot be satisfied and the `.venv-wsl` interpreter the later Python steps invoke does not exist. Base each worktree on LOCAL `main`, not `origin/main`: `summarize-dnd`'s local `main` is ahead of `origin/main` by a revert (`01bb0eb Revert daughter speaker hint…`), so branching off `origin/main` would silently drop it; check `git -C <repo> status -sb` for an `[ahead N]` before creating each worktree. Discover the real test invocation before writing tests:

```bash
cd /home/dan/code/gws-skill
git fetch origin
git worktree add .worktrees/yente-timeout-audit-hardening -b hardening/yente-timeout-audit-hardening main   # local main, not origin/main
test ! -f AGENTS.md || sed -n '1,220p' AGENTS.md   # absent today — fall back to README/Makefile/CI
go test ./... >/dev/null 2>&1 && echo "go toolchain ok"

cd /home/dan/code/summarize-dnd
git fetch origin
git worktree add .worktrees/nanoclaw-side-effect-ledger -b hardening/nanoclaw-side-effect-ledger main   # local main — summarize-dnd is ahead of origin/main by a revert (01bb0eb); origin/main would drop it
```

If either branch already exists, create a clean worktree from it instead of rewriting it.

- [ ] **Step 3: Provision the summarize-dnd Python environment**

There is no `.venv-wsl`, `.venv`, `venv`, or requirements/pyproject manifest in `summarize-dnd`, and system `python3` lacks pytest, so every `.venv-wsl/bin/python -m pytest` invocation in Tasks 4B/7 fails before any test logic runs. Provision the venv and record the dependency set (`.venv-wsl` matches the local convention used by sibling repo `ringdown-prod`; it is an uncommitted local environment, not a tracked path):

```bash
cd /home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger
python3 -m venv .venv-wsl
.venv-wsl/bin/python -m pip install -U pip pytest
# install summary_writer's runtime deps if a manifest exists; otherwise pin the minimum:
#   jsonschema is required at import; litellm is import-guarded (optional)
.venv-wsl/bin/python -m pip install jsonschema
.venv-wsl/bin/python -c "import summary_writer" && echo "import ok"
.venv-wsl/bin/python -m pytest -q   # baseline green before adding red tests
```

Record the exact dependency set and interpreter path in a short note (and, if the repo owner agrees, add a minimal `AGENTS.md` to `summarize-dnd` documenting the test command so the next agent is not blocked the same way). If `import summary_writer` or the baseline run fails, stop and resolve the dependency set before proceeding — do not write red tests against a non-importable module.

- [ ] **Step 4: GWS side-effect signing keypair (deploy precondition, not a code step)**

Task 4B's `gmail_draft_created` recovery evidence is trusted via Ed25519 (see "Side-Effect Trust Mechanism"). Generation/installation of the keypair is an operator/deploy action, out of scope for local TDD, but record it so the feature is shippable:

- Generate an Ed25519 keypair; install the **private** key root-owned under `/srv/nanoclaw/secrets/` (already gitignored and excluded from the gitleaks scan), referenced to the proxy via `GWS_SIDE_EFFECT_SIGN_KEY_FILE`.
- Distribute the **public** key to the host and into the container (read-only mount / `GWS_SIDE_EFFECT_VERIFY_KEY`); never place the private key in the container or any agent-facing env.
- Provision `GWS_AUDIT_STORE` (a root-owned, host-readable append-only JSONL path) for the proxy so crash-window discovery can wire; if unset, that discovery path is inactive and the no-duplication guarantee degrades to "no duplication when the tool process survives to append."
- Local tests use ephemeral test keypairs generated in-process; they must NOT depend on the production key. With no key present the importer treats unsigned `gmail_draft_created` JSONL as an unvalidated hint only, so the build is green and the feature is simply inactive until the key is provisioned in production.

## Task 1: Schema, Provider Contract, Input Ledger, And Route-Scoped Recovery

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/session-db.ts`
- Modify: `src/db/session-db.test.ts`
- Modify: `src/router.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/container-config.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `src/modules/scheduling/db.ts`
- Create: `container/agent-runner/src/db/side-effects.ts`
- Modify: `container/agent-runner/src/providers/types.ts`
- Modify: `container/agent-runner/src/providers/claude.ts`
- Modify: `container/agent-runner/src/providers/codex.ts`
- Modify: `container/agent-runner/src/providers/mock.ts`
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/push.test.ts`
- Modify: `container/agent-runner/src/providers/codex.factory.test.ts`
- Modify: `container/agent-runner/src/db/session-state.ts`
- Modify: `container/agent-runner/src/db/session-state.test.ts`
- Modify: `container/agent-runner/src/db/messages-in.ts`
- Modify: `container/agent-runner/src/db/messages-out.ts`
- Modify: `container/agent-runner/src/db/connection.ts`
- Modify: `container/agent-runner/src/formatter.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`
- Modify: `container/agent-runner/src/integration.test.ts`

(host-sweep.ts/host-sweep.test.ts are intentionally NOT in Task 1 — all host-sweep work and its commit live in Task 2. Task 1 only depends on the pre-existing host-sweep unit tests staying green.)

- [ ] **Step 1: Write failing schema, host-sync, and side-effect-ledger tests**

In `src/db/session-db.test.ts`, add host-side tests for:

- `insertMessage()` and `upsertSessionRouting()` persist `messaging_group_id` and `is_group`.
- `routeInbound()` passes `messaging_group_id` and `is_group` through `writeSessionMessage()` into host-owned `messages_in`, and `writeSessionRouting()` stores the same fields in `session_routing`.
- Host due-count excludes rows with outbound `processing_ack.status='recovery'` but still counts truly pending rows.
- `syncProcessingAcks()` preserves recovery-owned rows, syncs `completed`, syncs `failed` only when the `processing_ack.notice_message_out_id` linkage column points to an existing user-visible terminal notice row, and resets only orphan `processing` rows when asked. A `failed` ack with `notice_message_out_id` NULL (or pointing at a missing row) is treated as invalid and is NOT completed. (The current `syncProcessingAcks` uses `WHERE status IN ('completed','failed')` and would blindly complete `failed`; this test forces the gate.)
- Host recovery import opens outbound DB writable only after a verified stopped-container flag; the test must fail if the helper writes while `containerRunning:true`.
- Host recovery import reads `sessionDir(...)/side-effects.jsonl`, imports only validated records idempotently into `side_effect_ledger`, then writes scoped recovery/fallback before deleting `processing` claims.
- Container runtime config propagates the static `NANOCLAW_SIDE_EFFECT_LEDGER=/workspace/side-effects.jsonl` and the Ed25519 public verify key, and never the GWS private key. Per-input correlation is file-based: assert the poll loop writes `/workspace/.active-input.json` (`{inputId, routeKey, updatedAt}`) on each `input-accepted`, and that a tool invoked during a follow-up reads the follow-up's `inputId` from that file — NOT a stale env value. (Add a focused test that a side effect produced during an accepted follow-up is stamped with the follow-up's input id, not the initial input id.)

In `container/agent-runner/src/db/session-state.test.ts`, add container-side tests for:

- `side_effect_ledger` imports known JSONL records idempotently.
- Invalid or over-detailed side-effect evidence is rejected or sanitized before recovery prompt use.
- Gmail and `summarize-dnd` side effects are available to recovery construction before provider-observed tool events.
- Agent-written or unsigned `gmail_draft_created` JSONL is NEVER authoritative. In Task 1 the Ed25519 verifier is not wired yet, so EVERY `gmail_draft_created` entry stays an unvalidated hint — that fail-closed default is what Task 1 ships and tests. The positive "valid Ed25519 signature → authoritative" path and the `verifyGwsSideEffectSignature` helper are added and tested in Task 4B (Step 4/9), so Task 1's green checkpoint does not depend on a working verifier.
- `summarize-dnd` JSONL cannot become authoritative recovery evidence unless the referenced summary artifact exists under an allowed output root and matches the staged hash/size metadata.

In `container/agent-runner/src/poll-loop.test.ts`, add a route-normalization test that proves a null-thread Discord DM and a threaded DM alias normalize together only when `messaging_group_id` matches and `is_group=0`; group routes with different `thread_id` values remain isolated.

- [ ] **Step 2: Write failing provider-contract tests**

**Scope note (Task 1 → Task 3 dependency).** Only Mock (synchronous) and Claude (the Anthropic SDK is `mock.module`-mockable) can have their `query.events` `input-accepted`/`result` asserted in Task 1: awaiting an event off the lazy `query.events` generator forces the generator body to run, and OpenCode's `query()` (`ensureSharedRuntime → spawnOpencodeServer`) and Codex's (`codex app-server`) spawn a real binary with no injection seam until Task 3 Step 4 (`OpenCodeRuntimeController`). So in Task 1, assert the `input-accepted`/`result` event contract against **Mock and Claude only**. OpenCode gets the identical `query.events` assertions in Task 3 Step 1, once its `OpenCodeRuntimeController` seam exists. Codex's `input-accepted` emission is implemented in Task 1, but a full `query.events` assertion needs a Codex runtime seam this plan does not introduce (Codex is not a Yente production provider — OpenCode is); Codex's emission is verified by typecheck and the existing Codex push-test shape, and the missing `query.events` assertion for Codex is a stated coverage boundary, not an oversight. All four providers DO get the `inputId` pass-through and the 2-arg `isSessionInvalid(err, { attemptedContinuation })` signature change in this task (compile-time/synchronous, no spawn required).

For Mock and Claude, require the provider to accept and echo `inputId`:

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

await expect(nextEvent(query.events, 'result')).resolves.toMatchObject({
  type: 'result',
  inputId: 'followup-1',
  resolvedInputIds: ['initial-1', 'followup-1'],
});
```

Update stale-session tests so `isSessionInvalid` must receive attempted continuation metadata:

```typescript
expect(provider.isSessionInvalid(new Error('thread not found'), { attemptedContinuation: 'thread-1' })).toBe(true);
expect(provider.isSessionInvalid(new Error('connection reset'), { attemptedContinuation: 'thread-1' })).toBe(false);
```

- [ ] **Step 3: Write failing recovery and ack lifecycle tests**

In `session-state.test.ts`, add tests for:

- Recovery entries are keyed by provider plus normalized route.
- Null-thread Discord DM and equivalent DM-thread alias resolve to the same route key only with matching host-stamped DM metadata.
- Distinct non-DM threads stay isolated.
- Entries are read non-destructively.
- `pending -> in_flight -> resolved` deletes only after successful resolution.
- An `in_flight` entry that gets another terminal interruption is retained and enriched, not deleted.
- Malformed recovery JSON is not destructively deleted until owned rows are reconstructed into a replacement recovery entry, returned to pending, or covered by a route-scoped fallback notice.
- Unresolved recovery entries are never pruned by count; only `resolved`/`superseded` entries are count-pruned.
- Excess unresolved recovery pressure fails closed with a structured alert/fallback and leaves recovery-owned rows recoverable.
- Moving row ids into `processing_ack.status='recovery'` and appending the recovery payload is atomic across crash-point tests.

In `messages-in`/`poll-loop` tests, add:

- Unaccepted follow-up rows become pending again when a terminal interruption happens before provider `input-accepted`.
- Accepted-but-unresolved rows move to `processing_ack.status='recovery'` and are not marked completed until a later successful recovery result.
- Host wake/sync excludes recovery-owned rows from due counts through `src/db/session-db.ts` helpers and startup preserves `recovery` acks while clearing only orphan `processing` acks.
- Startup clears orphan `processing` acks but preserves `recovery` acks.
- Recovery deletion resolves associated row ids to completed.
- Successful provider result without explicit `resolvedInputIds`/`supersededInputIds` resolves only when the poll loop has exactly one active accepted input; two active inputs without explicit ids is a recoverable implementation error that does not complete rows.
- Route-scoped outbound progress rows and MCP `send_message` rows written during the accepted-input window are harvested into `priorProgress` before recovery is stored.
- Outbound progress and relay rows carry `input_id`, `route_key`, `messaging_group_id`, and `is_group`; recovery tests fail if progress from another conversation is harvested.
- `processing_ack.status='failed'` without a linked user-visible terminal notice is treated as an invalid host-sync state and does not silently complete inbound work.

- [ ] **Step 4: Write failing route and pre-query tests**

In `poll-loop.test.ts`, add:

- Multiple wake-triggering routes in the same pending scan are split; only the active route is claimed and processed, and other routes remain pending.
- Same-route multiple trigger rows are preserved in order as `originalTasks`.
- A mixed batch with accumulated context before the trigger partitions `trigger=0` context by normalized route and stores recovery under the trigger route, not the first row route.
- Unrelated accumulated `trigger=0` context never appears in the active route's prompt or recovery payload.
- Null-thread Discord DM follow-up matches the original DM-thread alias only because host route metadata proves both rows are the same DM; group-channel thread mismatches are not collapsed.
- Different route follow-ups remain pending during terminal recovery and during bounded relay.
- Attachment inspection failure after claim stores recovery or returns rows to pending without writing raw provider errors.
- Pre-task script failure after claim follows the same recoverable lifecycle.
- Provider startup, session creation, and top-level prompt acceptance failures store recovery before settling.

- [ ] **Step 5: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/push.test.ts src/providers/codex.factory.test.ts src/db/session-state.test.ts src/poll-loop.test.ts src/integration.test.ts
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/db/session-db.test.ts src/container-runner.test.ts
```

Expected: FAIL because `inputId`, host route metadata, side-effect ledger import, recovery states, route normalization, and durable row lifecycle do not exist.

- [ ] **Step 6: Implement host schema, side-effect ledger, and recovery-visible due counts**

In `src/db/schema.ts`, `src/db/session-db.ts`, `src/router.ts`, `src/session-manager.ts`, `src/container-config.ts`, `src/container-runner.ts`, `container/agent-runner/src/db/connection.ts`, and `container/agent-runner/src/db/side-effects.ts`:

- Add nullable `messaging_group_id` and `is_group` columns to inbound `messages_in` and `session_routing`; host `ensureSchema()`/session DB migration owns existing DB upgrades, and the container connection path has read-compatible `ALTER TABLE` guards.
- Add route metadata columns to outbound `messages_out` where recovery-harvested progress/relay rows are written.
- Add outbound `side_effect_ledger(id, source, kind, operation, input_id, route_key, evidence_json, validation_json, replay_policy, occurred_at, imported_at)` with `id` as the idempotency key. `kind` is the recovery side-effect kind, not merely `api`/`non_api`.
- Add host due-count/sync helpers that read outbound `processing_ack` read-only and exclude `status='recovery'` rows from wake counts without completing them. (New behavior: the current `countDueMessages` queries only the inbound DB and never opens `processing_ack`, so this is a new outbound-aware due check, not a tweak to an existing filter.)
- Add host recovery writer/import helpers that require an explicit `containerStopped:true` proof before opening outbound DB writable.
- Add JSONL importer helpers for both the container path and host session path; unknown kinds are retained only as sanitized `tool_completed` entries and never expose raw secrets, paths outside allowed artifact roots, or full email bodies.
- Add validation hooks: in Task 1, `gmail_draft_created` entries are never authoritative (fail-closed default — the Ed25519 `verifyGwsSideEffectSignature` helper that promotes a signed Gmail entry to authoritative is added in Task 4B Step 9); `summarize-dnd` entries require artifact existence plus hash/size/path validation under an allowed root (implemented here).
- Add the `notice_message_out_id` column on `processing_ack` and the `messages_out` route columns through the container's on-demand `CREATE`/`ALTER` path so an old-schema outbound DB self-migrates.

In `src/router.ts` and `src/session-manager.ts` (and `src/modules/scheduling/db.ts`), stamp `messaging_group_id` and `is_group` when writing `session_routing`, host inbound rows, and scheduled task rows; note `writeSessionRouting()` derives `is_group`/`messaging_group_id` from the already-loaded `messaging_groups` row (per-wake), distinct from the per-message values stamped via `writeSessionMessage()`. In `src/container-config.ts` and `src/container-runner.ts`, set the static side-effect ledger path and mount the Ed25519 public verify key into every Yente/OpenCode runtime environment (never the private key; per-input correlation is the `/workspace/.active-input.json` file written by the poll loop, not env).

- [ ] **Step 7: Implement the provider event contract**

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
  relayDeadlineMs?: number;
  toolPolicy?: 'normal' | 'status_only';
}

export interface ProviderLivenessMetadata {
  configuredTimeoutMs?: number;
  elapsedMs?: number;
  lastEventType?: string;
  lastMeaningfulEventAt?: string | null;
}

export interface ProviderInputResolution {
  inputId?: string;
  resolvedInputIds: string[];
  supersededInputIds?: string[];
}

export interface ProviderInterruption {
  inputId: string;
  classification: string;
  severity: ProviderNoticeSeverity;
  terminal: boolean;
  agentMessage: string;
  fallbackUserMessage: string;
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
  liveness?: ProviderLivenessMetadata;
  recoverySeed?: {
    observations?: string[];
    safeToolState?: string;
    sideEffects?: ProviderSideEffect[];
  };
}

export interface ProviderSideEffect {
  id: string;
  inputId: string;
  kind: 'gmail_draft_created' | 'summarize_dnd_recording_cached' | 'summarize_dnd_summary_artifact' | 'tool_completed' | 'other';
  label: string;
  evidence: Record<string, string | number | boolean | null>;
  occurredAt: string;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'input-accepted'; inputId: string; scope: ProviderInputScope }
  | ({ type: 'result'; text: string | null } & ProviderInputResolution)
  | { type: 'progress'; inputId: string; message: string }
  | { type: 'notice'; inputId: string; classification: string; severity: ProviderNoticeSeverity; agentMessage: string; fallbackUserMessage: string; relayRecommended: boolean; liveness?: ProviderLivenessMetadata }
  | ({ type: 'interruption' } & ProviderInterruption)
  | { type: 'side-effect'; sideEffect: ProviderSideEffect }
  | { type: 'clear-continuation'; inputId: string; reason: string; attemptedContinuation?: string }
  | { type: 'activity'; inputId?: string; source?: 'sdk_event' | 'sdk_keepalive' | 'provider_wait_tick' | 'provider_internal'; liveness?: ProviderLivenessMetadata };
```

**Removing the log-only `error` event — explicit disposition per site.** The new `ProviderEvent` union has no `error` variant, but `{ type: 'error' }` is emitted today at `claude.ts:345` (`API retry`, `retryable:true`), `claude.ts:347` (`Rate limit`, `classification:'quota'`), and `codex.ts:342`, and consumed at `poll-loop.ts:411` (`case 'error':`). Assign each a disposition rather than leaving dangling code:

- `claude.ts:345` (`API retry`, `retryable:true`) is a mid-turn, non-terminal signal: reclassify as a non-terminal `notice` (`severity:'warn'`, `relayRecommended:false`) correlated to the active `inputId` — the turn continues; not a terminal `interruption`, not a throw. `claude.ts:347` (`Rate limit`, `retryable:false`, `classification:'quota'`) must NOT be flattened into the same "turn continues" notice: confirm the runtime behavior of the `retryable:false` branch first — if it ends the Claude turn, give it a terminal recoverable `interruption` disposition (so the recovery path is preserved); only treat it as a continue-the-turn `notice` if the turn provably continues.
- `codex.ts:342` carries a real turn error: emit it as a terminal `interruption` with input correlation, recovery metadata, and continuation policy.
- Delete the `poll-loop.ts:411` `case 'error':` and route the above through the `notice`/`interruption` handlers.

**Additive-then-required migration ordering (this is the breaking-type-change epicenter — split into red/green sub-commits per the line-24 directive).** Land the shared-union change in this order so every intermediate commit type-checks green:

1. Additive types only: add the new `ProviderEvent` variants and add `inputId` to `QueryTurnInput`/`QueryInput` as **optional**, keeping a temporary back-compat `error` variant in the union so all four providers + the poll-loop switch still compile. Green checkpoint.
2. Per-provider `input-accepted` emission + the `error`-site dispositions above. Green checkpoint.
3. Host schema + `side_effect_ledger` + ack columns. Green checkpoint.
4. Flip `inputId` to **required**, remove the back-compat `error` variant, and finalize poll-loop ledger ownership/result-resolution last. Final green checkpoint.

Providers emit `input-accepted` only after the underlying SDK/input stream accepts the matching prompt. Mock accepts synchronously; Claude accepts when its `MessageStream.push` succeeds; Codex/OpenCode emit after their real turn/prompt-acceptance seam (their `query.events` assertions land in Task 3 per the Step 2 scope note, but the emission code is added here).

- [ ] **Step 8: Implement scoped recovery and input ledger**

Add recovery types in `session-state.ts`:

```typescript
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
  priorProgress: Array<{ messageOutId: string; text: string; source: 'provider_progress' | 'mcp_send_message' | 'relay'; timestamp: string }>;
  observations: string[];
  sideEffects: ProviderSideEffect[];
  safeToolState?: string;
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
  createdAt: string;
  updatedAt: string;
}
```

Implement append/read/mark-in-flight/resolve/enrich/supersede APIs. Recovery rows must remain available while `in_flight`; resolving a recovery entry also resolves its owned input ledger rows. Implement pruning only for `resolved`/`superseded` entries. If unresolved entries exceed configured pressure limits, emit structured JSONL and user-visible fallback without deleting them.

- [ ] **Step 9: Implement ack helpers**

In `messages-in.ts`, add helpers:

- `returnProcessingToPending(ids, reason)` deletes only `processing_ack.status='processing'`.
- `markRecoveryOwned(ids, recoveryId)` writes `processing_ack.status='recovery'`.
- `markRecoveryCompleted(ids, recoveryId)` transitions recovery-owned rows to `completed`.
- `clearRecoveryOwnership(ids, recoveryId)` deletes recovery acks only after rows have been returned to pending, completed, or covered by a replacement recovery/fallback.

Log structured JSONL from callers with `severity`, `event`, `message_ids`, `recovery_id`, and `reason`.

- [ ] **Step 10: Implement route normalization and poll-loop ledger ownership**

Add one shared route normalizer. Use it for initial batch splitting, recovery scope, follow-up matching, relay routing, and tests. It must:

- Include provider name, channel type, platform id, `messaging_group_id`, `is_group`, and a normalized thread key in the route key/scope.
- Treat known DM null-thread and DM-thread aliases as equal only when `messaging_group_id` and `is_group=0` prove both rows are the same DM route.
- Treat distinct non-DM thread ids as distinct.
- Partition accumulated context rows before prompt formatting; never let an unrelated context row choose the active route.

In `poll-loop.ts`:

- Split pending wake-triggering rows by normalized route before `markProcessing`.
- Generate top-level and follow-up `inputId` values.
- Write `/workspace/.active-input.json` (`{inputId, routeKey, updatedAt}`, atomic temp+rename) on each `input-accepted`, so the GWS shim and `summarize-dnd` stamp the current input's correlation at tool-invocation time (this is what the Step 1 follow-up-stamping test asserts).
- Track every input as `queued`, `accepted`, `resolved`, `recovery_owned`, or `returned`.
- Inject XML-escaped pending recovery entries only into top-level prompts.
- Mark recovery entries `in_flight` when the provider accepts the matching top-level recovery `inputId`.
- Resolve and delete recovery entries only after a successful provider result resolves/supersedes exact input ids, or after the one-active-input rule deterministically maps the result to that id.
- On accepted-but-unresolved terminal interruption, enrich recovery and mark those rows recovery-owned instead of completed.
- On unaccepted terminal interruption, return route-matched rows and other-route rows to pending.
- Convert pre-query failures and provider throws into the same recovery path.

- [ ] **Step 11: Run tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/push.test.ts src/providers/codex.factory.test.ts src/db/session-state.test.ts src/poll-loop.test.ts src/integration.test.ts
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/db/session-db.test.ts src/container-runner.test.ts
timeout 120s pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add src/db/schema.ts src/db/session-db.ts src/db/session-db.test.ts \
  src/router.ts src/session-manager.ts src/modules/scheduling/db.ts \
  src/container-config.ts \
  src/container-runner.ts src/container-runner.test.ts \
  container/agent-runner/src/db/side-effects.ts \
  container/agent-runner/src/providers/types.ts \
  container/agent-runner/src/providers/claude.ts \
  container/agent-runner/src/providers/codex.ts \
  container/agent-runner/src/providers/mock.ts \
  container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/push.test.ts \
  container/agent-runner/src/providers/codex.factory.test.ts \
  container/agent-runner/src/db/session-state.ts \
  container/agent-runner/src/db/session-state.test.ts \
  container/agent-runner/src/db/messages-in.ts \
  container/agent-runner/src/db/messages-out.ts \
  container/agent-runner/src/db/connection.ts \
  container/agent-runner/src/formatter.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts \
  container/agent-runner/src/integration.test.ts
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

`isMissingOpenCodeSessionError` is only valid proof when the attempted id appears verbatim. In SDK 1.15.10 the missing-session error is a `NotFoundError` whose `data.message` is free-form and may NOT carry the id, so the string classifier alone cannot prove a dead session (false-negative). Add a positive-existence-check seam and a bounded zombie path, and test them:

```typescript
// Positive existence check is the authoritative proof source (probe-discovered API).
// The runtime controller exposes sessionExists(id) backed by client.session.get/list.
expect(await classifyContinuation({ attemptedContinuation: 'ses_old', sessionExists: async () => false }))
  .toMatchObject({ policy: 'clear', reason: 'session-missing' });
expect(await classifyContinuation({ attemptedContinuation: 'ses_old', sessionExists: async () => true, err: new Error('HTTP 404 from OpenCode event stream') }))
  .toMatchObject({ policy: 'preserve' }); // bare 404 with a live session is NOT proof

// Bounded zombie path: OPENCODE_CONTINUATION_FAILURE_LIMIT consecutive terminal
// interruptions on the same continuation with no success in between clears it with
// user-visible restart recovery — never silently, never forever.
expect(zombieDecision({ continuation: 'ses_old', consecutiveTerminalFailures: 3, limit: 3 }))
  .toMatchObject({ clear: true, userVisibleRestart: true });
expect(zombieDecision({ continuation: 'ses_old', consecutiveTerminalFailures: 2, limit: 3 }))
  .toMatchObject({ clear: false });
```

- [ ] **Step 2: Write failing pump and long-work tests**

**Determinism requirement.** `bun test` has NO fake-timer facility (no `useFakeTimers`/`setSystemTime` under `container/agent-runner`; only host-side Vitest has fake timers), and a 16-minute / 6-hour test must not hang to wall clock under `timeout 120s`. So the pump must take an INJECTED clock and scheduler — `now(): number` and `schedule(delayMs, cb): cancel` — as mandatory, total constructor dependencies, and must never call global `setTimeout`/`setInterval`/`Date.now`. The tests drive a deterministic fake clock/scheduler that advances virtual time instantly. Add a guard (see Task 7 Step 5) that `opencode-events.ts` contains no direct `setTimeout(`/`setInterval(`/`Date.now(` outside the injected seam, so a regression to real timers turns into a failing guard, not a 16-minute wall-clock run.

In `opencode-events.test.ts`, use the injected fake clock/scheduler for:

- Keepalives update liveness and yield `keepalive`.
- Wait ticks yield before transport timeout.
- Heartbeat-only/no-SSE wait ticks run beyond 16 observed Dvora minutes without terminal timeout when `transportTimeoutMs` is above that duration.
- Inactivity notices fire at `OPENCODE_INACTIVITY_NOTICE_MS`, repeat at the throttle interval, and do not end the stream.
- Inactivity notice, transport timeout, read-error, stream-end, absolute-timeout, and queue-overflow results all include configured timeout, elapsed time, last event type, and last meaningful-event timestamp where applicable.
- A later `session.idle` after inactivity returns normally.
- No events until configured `transportTimeoutMs` returns `transport-timeout` with liveness metadata.
- Absolute deadline returns `absolute-timeout` and is distinct from transport timeout.
- Read errors and stream end return typed terminal results.
- Other-session events do not wake the active session waiter.
- Queue overflow preserves non-droppable terminal/action-required/final-text/question/permission/side-effect events or returns `queue-overflow`.

In `host-sweep.test.ts`, add:

- Any provider-owned active tool with a positive declared timeout widens claim tolerance.
- Declared timeout is capped under the absolute hard-death ceiling.
- A declared active long tool can keep no-SSE/heartbeat-only work alive beyond the default 30-minute transport timeout, up to its capped timeout and never beyond the absolute turn ceiling.
- A turn that keeps refreshing the heartbeat via wait ticks is still terminated/recovered at `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`: the pump enforces the ceiling independent of heartbeat, and host-sweep's effective ceiling `max(ABSOLUTE_CEILING_MS=30min, declaredToolTimeoutMs)` may be raised by a declared tool only up to that turn ceiling, never past it. (Prevents a stuck/looping but heartbeat-refreshing container from living indefinitely.)
- Host heartbeat stays fresh during wait ticks.
- Host kill/reset clears stale OpenCode tool state and writes route-scoped recovery/fallback for processing rows only after the container is verified stopped.
- Host kill/reset imports the host session path for `/workspace/side-effects.jsonl` before writing recovery, and the test fails if outbound DB is opened writable while the container may still be running.
- Host kill/reset writes recovery/fallback before any replacement wake; the test must fail if `wakeContainer()` runs before side-effect import and recovery write complete.
- Host wake/sync ignores `processing_ack.status='recovery'` rows as due work and preserves them while resetting only orphan `processing` rows.

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

Create `opencode-errors.ts` with liveness metadata, typed errors for transport timeout, absolute timeout, stream read error, stream end, and queue overflow, plus `isMissingOpenCodeSessionError(err, attemptedSessionId)`. The classifier must require attempted session context and must not match generic transport/read/timeout strings. Typed errors must preserve continuation by default; only exact attempted-session missing proof or explicit provider clear-continuation metadata may clear it.

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

`OpenCodeLivenessSnapshot` must include `configuredTimeoutMs`, `elapsedMs`, `lastEventType`, and `lastMeaningfulEventAt` for every notice/terminal path that Yente may see.

The pump constructor takes the injected `now()`/`schedule()` clock+scheduler (mandatory, no global timers) and the absolute-turn-ceiling, which it enforces itself.

**Single-reader migration (required, or the build breaks).** `opencode.ts` today exports `nextOpenCodeEvent` (calls `stream.next()` at ~:439) and `nextMeaningfulOpenCodeEvent` (~:456), both of which throw `OpenCode event timeout`, and `opencode.test.ts` imports and exercises both. The "no `stream.next()` outside the pump" rule (and the Task 7 guards banning `OpenCode event timeout` text and confining `stream.next(`) require deleting or internalizing those two readers and migrating their `opencode.test.ts` cases onto the pump. Do this here; do not leave the old readers alongside the pump.

- [ ] **Step 6: Implement host-sweep bounded declared-timeout handling**

Replace Bash-only timeout handling (`declaredBashMs`) with provider/tool-generic declared-timeout handling reading the same `tool_declared_timeout_ms` state. Cap every declared timeout under the hard ceiling. Treat the default 30-minute `ABSOLUTE_CEILING_MS` as the no-active-long-tool limit; active long tools continue on wait ticks until their capped deadline or the absolute turn ceiling. A declared tool may raise host-sweep's effective ceiling `max(ABSOLUTE_CEILING_MS, declaredToolTimeoutMs)` only up to `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`, never past it; the pump (Step 5) independently enforces that same ceiling so a heartbeat-refreshing-but-stuck turn is terminated/recovered there rather than living for the full declared window (host-sweep is only the backstop for a fully wedged pump). After host kill/reset, verify the container is stopped, import side-effect JSONL from the host session path, clear provider-owned tool rows, and write a recovery record or fallback notice for active processing rows before resetting them or waking a replacement container. Preserve recovery-owned acks during host sync/startup, and ensure recovery-owned rows do not trigger duplicate container wakes.

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
- Create: `container/agent-runner/src/providers/opencode-sdk-surface.ts`
- Create: `container/agent-runner/src/providers/fixtures/opencode-sdk-question-surface.json`
- Create: `container/agent-runner/scripts/opencode-sdk-surface-probe.ts`
- Modify: `container/agent-runner/src/providers/mcp-to-opencode.ts`
- Modify: `container/agent-runner/src/providers/mcp-to-opencode.test.ts`
- Modify: `container/agent-runner/src/mcp-tools/server.ts`
- Modify: `container/agent-runner/src/db/connection.ts`
- Modify: `container/agent-runner/src/index.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`

- [ ] **Step 1: Write failing OpenCode provider tests**

In `opencode.test.ts`, add mocked runtime-controller tests for:

- `buildOpenCodeConfig()` disables native `question` through OpenCode tool availability (the typed `tools: { question: false }` map) for SDK 1.15.10, NOT through `permission.question` (SDK 1.15.10 `Config.permission` only accepts `edit|bash|webfetch|doom_loop|external_directory`). The existing `opencode.test.ts` permission assertion (`permission: { '*': 'allow', question: 'deny' }`) must be reconciled to the new tool-availability config in this step.
- Relay-mode `buildOpenCodeConfig()` disables native OpenCode tools via the REAL SDK ids — `permission` keys `bash`/`webfetch`/`edit`/`external_directory` set to `deny`, plus each probe-discovered `tools` id set to `false`; the test POSITIVELY asserts the relay runtime exposes only the allowlist (route-locked `send_message` + listed read-only status tools) and fails if `bash`, any file tool, or `webfetch` is reachable. (`Config.tools` is an arbitrary string→bool map, so a category name that doesn't match a real id silently leaves the tool enabled — assert reachability, not just the deny keys.)
- `buildOpenCodeConfig()` raises or disables the model-provider request timeout under the ACTIVE provider name: `provider[process.env.OPENCODE_PROVIDER || 'anthropic'].options.timeout` (SDK 1.15.10 has no top-level `Config.options.timeout`). The test must assert the value resolves under that provider key; a config that emits a provider literally named `options` must fail. The exact field name comes from the SDK-surface probe, not a hard-coded belief.
- OpenCode `query.events` emits `input-accepted` only after the controller's `prompt(...)` resolves for that exact `inputId`. The `input-accepted`/`result` `query.events` assertions deferred from Task 1 Step 2 land here, now that the Step 4 runtime-controller seam makes OpenCode unit-testable without spawning a real server.
- SDK-surface probe fixtures cover the active root/v2 exports: when native questions appear as `message.part.updated`/`permission.updated`, `client.question`, or `question.*` events, production code handles that surface; any unhandled invented surface fails a static guard.
- Runtime startup, session creation, top-level prompt acceptance, and follow-up prompt acceptance yield wait-tick activity and fail as typed interruptions if deadlines expire.
- Inactivity notices yield `notice` with relay text and liveness metadata, do not clear continuation, do not destroy the runtime, and do not settle user rows by themselves.
- Inactivity notices can start a separate restricted relay runtime without pausing reads from the original event pump.
- If the separate relay runtime cannot start, accept the prompt, or finish by deadline, the original long turn remains active and the poll loop sends one sanitized direct fallback.
- Terminal interruptions start a recovery query when possible; if recovery query startup or prompt acceptance misses its deadline, one sanitized direct fallback is written so the user is not left silent.
- No-SSE wait ticks/keepalives beyond 16 minutes keep heartbeat alive and do not produce `OpenCode event timeout`.
- Transport timeout at the configured longer deadline yields terminal `opencode_transport_timeout`, preserves continuation unless exact attempted-session missing proof or explicit clear-continuation is observed, clears active tool state, stores side-effect evidence, and returns without raw error.
- Absolute timeout, stream read error, stream end, queue overflow, `session.error`, startup timeout, prompt-acceptance timeout, and retry exhaustion each yield one typed terminal interruption and clear active tool state.
- `message.part.updated` tool parts with native question and matching `permission.updated` events are correlated by `callID`/permission id and denied through `postSessionIdPermissionsPermissionId(...)`.
- Cancellable native question waits only for bounded reuse proof; it preserves continuation only after `session.idle` or equivalent SDK acknowledgement.
- Non-cancellable native question or denial without reuse proof destroys runtime, emits `clear-continuation`, and stores restart-capable recovery metadata.
- Question/tool/permission events for other session ids are ignored.
- GWS draft-create and `summarize-dnd` summary tool completions first stage side-effect evidence at the local tool/proxy boundary, validate/import it into `side_effect_ledger`, then emit provider `side-effect` references before final assistant text.
- Unsigned or unvalidated staged side-effect entries are not emitted as provider `side-effect` references and cannot satisfy recovery assertions.
- Terminal failure after side effect but before final result includes the side-effect ledger evidence in the interruption seed.
- Overlapping tool parts keep the longest bounded declared timeout active until all longer tools complete.
- Startup clears stale OpenCode tool state left by a prior crash.

- [ ] **Step 2: Write failing relay and recovery tests**

In `poll-loop.test.ts`, add:

- Inactivity notice triggers a bounded Yente-authored relay query with recovery context while the original long turn remains active when provider relay support exists.
- Providers without declared separate-runtime relay support never run a concurrent relay; the poll loop sends one direct sanitized fallback for non-terminal inactivity and uses terminal recovery only for terminal interruptions.
- Relay mode passes an explicit `relayDeadlineMs` and `toolPolicy:'status_only'`.
- Relay mode creates a fresh OpenCode runtime with a fresh session id, no continuation, no shared `activeSessionId`, no shared event stream, and an MCP allowlist containing only `send_message` plus any read-only status tools explicitly listed in the test fixture.
- Relay output is routed to the wake-triggering route through a route-locked `send_message`; a relay attempt with a different `to` destination is rejected and does not write `messages_out`.
- Normal follow-up polling is disabled or route-filtered during relay.
- MCP mutation/side-effect tools and OpenCode native shell/filesystem/edit/web/question tools are denied during relay mode; only route-locked status/message tools can run.
- Boundary test (in `mcp-to-opencode.test.ts` plus a `mcp-tools/server.ts` test): an MCP server built with `NANOCLAW_RELAY_MODE=1`/`NANOCLAW_RELAY_ROUTE_KEY` exposes ONLY route-locked `send_message` (plus any explicitly listed read-only status tools), rejects every mutation/side-effect tool, and rejects an off-route `to`; a non-relay MCP server still exposes the full tool map. This exercises the actual filtering code at the server admission point, not only the provider/poll-loop layer.
- If relay prompt is accepted but then fails/hangs/interrupts, the original turn and recovery payload remain unresolved and direct fallback is sent only after bounded relay failure.
- Terminal interruption relay uses the same recovery lifecycle and does not delete recovery on `input-accepted`.
- Direct fallback is emitted only once and only after relay acceptance/result failure or relay deadline expiry.

- [ ] **Step 3: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/mcp-to-opencode.test.ts src/poll-loop.test.ts
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

Add a separate relay construction path:

```typescript
interface OpenCodeRelayRuntimeFactory {
  createRelayRuntime(options: ProviderOptions, policy: {
    allowedTools: string[];
    deniedNativeTools: string[];
    routeKey: string;
    deadlineMs: number;
  }): Promise<OpenCodeRuntimeController>;
}
```

This seam necessarily replaces the current module-global singleton. Today `opencode.ts` keeps `sharedRuntime`/`sharedConfigKey`/`ensureSharedRuntime`/`destroySharedRuntime` and a single `activeSessionId` at module scope; a naive relay reusing `ensureSharedRuntime` would collide on `runtimeConfigKey` (relay differs only in denied tools) and return the SAME runtime/stream, and a timeout/abort during the relay window would call the global `destroySharedRuntime()` and kill BOTH turns. Refactor that module-global state into per-instance `OpenCodeRuntimeController` state with `destroy(reason)` targeting one specific runtime, and make `runtimeConfigKey` distinguish relay-vs-normal so the relay never lands on the original runtime.

The relay runtime must build a separate OpenCode config key, a separate process/client/event pump, no continuation, and a tool policy enforced at the NanoClaw MCP server boundary plus disabled native OpenCode mutation tools. Concretely, since `index.ts` launches ONE shared MCP-server subprocess per turn, the relay `OpenCodeRuntimeController` must launch its OWN NanoClaw MCP-server subprocess with `NANOCLAW_RELAY_MODE=1` and `NANOCLAW_RELAY_ROUTE_KEY=<route>` in its env; `mcp-tools/server.ts` reads those to build a `send_message`-only, route-locked tool map for that instance. The concurrent original turn keeps its full-tool MCP server; the relay's MCP server exposes only route-locked status tools. Do not multiplex relay events through the original OpenCode SSE stream, and do not share one MCP server between the two turns.

- [ ] **Step 5: Implement pump-driven OpenCode turn state**

Use env-configurable defaults:

- `OPENCODE_INACTIVITY_NOTICE_MS=300000`
- `OPENCODE_INACTIVITY_NOTICE_REPEAT_MS=300000`
- `OPENCODE_TRANSPORT_TIMEOUT_MS=1800000`
- `OPENCODE_WAIT_TICK_MS=15000`
- `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS=21600000`
- `OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS=15000`
- `OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS=21600000`
- `OPENCODE_RELAY_DEADLINE_MS=30000`
- `OPENCODE_CONTINUATION_FAILURE_LIMIT=3` (consecutive terminal interruptions on one continuation before the zombie path clears it with user-visible restart)
- `OPENCODE_MODEL_PROVIDER_TIMEOUT_MS=21600000` (a large positive ms value = absolute turn ceiling), applied under the active provider name (`provider[OPENCODE_PROVIDER].options.timeout`), to avoid a hidden 5-minute request abort. The disable sentinel `0` is forbidden (it means 0 ms = immediate abort); to fully disable, the config emits `timeout: false` (the SDK's documented sentinel), never `0`.

For every `inactivity-notice`, yield `activity` then `notice` with agent-facing wording and liveness metadata. Do not push the notice into the busy OpenCode turn. The poll loop will relay it only through an isolated bounded relay query when provider capabilities say that is safe.

Provider capabilities for OpenCode must declare relay support only when the separate relay runtime factory and MCP allowlist are available:

```typescript
relay: {
  mode: 'separate-runtime',
  deadlineMs: OPENCODE_RELAY_DEADLINE_MS,
  allowedTools: ['send_message'],
  deniedNativeTools: probedNativeToolIds, // REAL SDK ids from the probe (e.g. bash, webfetch, edit, write, read, …) + permission keys bash/webfetch/edit/external_directory; NOT category names. Relay asserts only allowedTools remain reachable.
  routeLocked: true,
}
```

The poll loop starts the relay as a child async task and continues draining the original provider event generator. The relay's `send_message` runs in the relay's OWN MCP-server subprocess — a different OS process from the poll loop and the original turn's MCP server — so there is NO shared in-process transaction helper (that design is discarded). They coordinate only through SQLite file locking (`PRAGMA busy_timeout=5000`, DELETE journaling), and relay output cannot race row resolution because of row-level ownership: a relay `send_message` only appends route-locked status `messages_out` rows and can never write or resolve `processing_ack`, `session_state`, recovery, or original input rows (see the Inactivity Visibility Contract).

For terminal pump results, yield one typed `interruption` with input correlation and liveness metadata, emit any durable collected `side-effect` entries, clear active tool state, and return.

- [ ] **Step 6: Implement native-question denial**

Create and run `container/agent-runner/scripts/opencode-sdk-surface-probe.ts` for the active OpenCode SDK root/v2 question surface; do not reuse the Claude-oriented `sdk-signal-probe.ts`. Commit the sanitized probe fixture to `container/agent-runner/src/providers/fixtures/opencode-sdk-question-surface.json`. Implement `container/agent-runner/src/providers/opencode-sdk-surface.ts` helpers that inspect the discovered surface, including `message.part.updated`, `permission.updated`, `client.question`, or `question.*` if present. Detect native question by tool name/metadata, extract question text from observed fields, correlate by call id/permission id or the discovered equivalent, and deny/cancel through the exported API when possible.

Visible recovery text must include the blocked question. In the Fruma replay this must visibly ask the user for Matt Van Horn's email before the email answer is injected.

- [ ] **Step 7: Implement side-effect ledger capture**

Import safe side-effect evidence first from the JSONL/tool boundary, then enrich it from OpenCode tool completion events:

- Gmail draft creation: local GWS shim/proxy invocation id, audit record id, request class, command/tool path, sanitized subject/body hints, draft id when present.
- `summarize-dnd` summary artifact: run id, recording id/path, output artifact path/id, summary completion marker.
- Generic tool completion: tool name, call id, sanitized status/output snippet.

On terminal interruption after a side effect but before assistant result, emit a recovery seed with the validated imported side-effect ledger. The poll loop must include this in the next recovery prompt so the agent can report existing work rather than duplicating it. If external success happened but validation/import is still pending or failed, emit a partial-success interruption that points to safe audit/artifact evidence and does not allow ordinary success output.

- [ ] **Step 8: Implement active tool tracking**

Maintain an active tool map keyed by part id/call id. Persist the active entry with the largest bounded timeout to `container_state`; clear only when all active tools complete or on terminal interruption. Clear stale OpenCode-owned tool state on startup in `index.ts`.

- [ ] **Step 9: Run tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/providers/mcp-to-opencode.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  container/agent-runner/src/providers/opencode-sdk-surface.ts \
  container/agent-runner/src/providers/fixtures/opencode-sdk-question-surface.json \
  container/agent-runner/scripts/opencode-sdk-surface-probe.ts \
  container/agent-runner/src/providers/mcp-to-opencode.ts \
  container/agent-runner/src/providers/mcp-to-opencode.test.ts \
  container/agent-runner/src/mcp-tools/server.ts \
  container/agent-runner/src/db/connection.ts \
  container/agent-runner/src/index.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: recover opencode interruptions through yente"
```

## Task 4: Tool Boundary Side-Effect Data Paths And GWS Audit

This task is split into two independently-shippable parts. **Task 4A** is the audit-classification fix that resolves the Fruma misleading-log root cause — small, low-risk, no new trust surface. **Task 4B** is the signed side-effect-ledger recovery channel — the higher-risk, optional feature that introduces the Ed25519 trust surface and the cross-repo data path. Ship 4A even if 4B is deferred. Both dependent-repo worktrees and the Python venv are created in Task 0 Step 2-3; do not re-create them here.

### Task 4A — GWS Probe Audit Classification (audit-only)

**Files:**
- Modify: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy.go`
- Modify: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy_test.go`

- [ ] **Step 1: Confirm preconditions and read repo conventions**

The worktree exists from Task 0 Step 2. `gws-skill` has no `AGENTS.md`, so the test command is the Go toolchain (`go test ./...`); skim `README`/`proxy*.go` for conventions. Do not re-create the worktree.

- [ ] **Step 2: Write failing GWS audit-classification tests**

In `proxy_test.go`, capture JSON request/denial/execution/completion logs plus response headers. Classification is computed from command STRUCTURE, before request logging, and is independent of the method parser. Add tests for:

- `/exec` with args `["gmail","users","drafts","create","--help"]` logs `request_class:"help"` and `api_effect:false` in request, denial, execution, or completion records.
- The same help request does not log API-success semantics for `method:"users.drafts.create"` (this is the Fruma misleading-log fix: today the `executed` record logs `method:"users.drafts.create"` for a `--help` probe).
- The response includes `X-GWS-Audit-Id`, `X-GWS-Request-Class: help`, `X-GWS-Api-Effect: false`, and `X-GWS-Operation-Succeeded` when the request reaches the response path.
- `/exec` schema/introspection probes such as `["gmail","users","drafts","create","schema"]` or the repo's actual schema flag log `request_class:"schema"` and `api_effect:false` without changing admission behavior.
- `/exec` local validation/dry-run probes such as `["gmail","users","drafts","create","--validate"]` or the repo's actual dry-run flag log `request_class:"local_validation"` and `api_effect:false` without changing admission behavior.
- `["gmail","users","drafts","create","--subject","help","--body","schema"]` remains `request_class:"api"` and `api_effect:true` (flag VALUES do not affect classification).
- `["gmail","users","drafts","send","--body","auth"]` remains API.
- **Admission unchanged, proven:** a `--help` probe still authenticates, still flows through `checker.Check` (a `drafts.create` policy denial still denies the help probe), and still invokes the real binary via `ExecGWS`. Add an explicit case that a help probe of a RATE-LIMITED method (a `+send`/calendar method, which `rateLimitKeyForMethod` maps to a real limiter — note `users.drafts.create` maps to `"gmail"`, which has no limiter today) still consumes/denies under the existing limiter, so "admission unchanged" is proven rather than asserted.

Do not add `gws auth status` expectations (the shim handles that through `/health`, not `/exec`). Do not add schema command admission; classify schema/local-validation probes only on paths that already reach request logging.

- [ ] **Step 3: Run tests red**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: FAIL.

- [ ] **Step 4: Implement GWS structural classification and classification headers**

In `proxy.go`, add:

```go
type InvocationClass string

const (
	InvocationAPI  InvocationClass = "api"
	InvocationHelp InvocationClass = "help"
	InvocationSchema InvocationClass = "schema"
	InvocationLocalValidation InvocationClass = "local_validation"
)
```

Classify command structure before request logging (in `handleExec`, right after `parseGWSArgs`, before `h.logger.Info("request", …)`):

- `--help`, `-h`, `help`, `--version`, and `version` in positional/flag structure as help/version.
- Schema/introspection commands or flags that already reach `/exec` as schema.
- Local validation/dry-run commands or flags that already reach `/exec` as local validation.
- Flag VALUES such as `--subject help` or `--body schema` must not affect classification.
- For non-API invocations, set `api_effect:false` and avoid API-success wording in the `executed` record even though `parseGWSArgs` still returns `users.drafts.create`.

Generate a unique `audit_id` per request (used in logs and headers; reused by Task 4B). Add classification response headers where a response is written: `X-GWS-Audit-Id`, `X-GWS-Request-Class`, `X-GWS-Api-Effect`, `X-GWS-Operation-Succeeded`. Do NOT broaden execution: keep authentication, `checker.Check`, the calendar-ownership guard, `InjectSignature`, the rate limiter, and `ExecGWS` exactly as they are. (Cryptographic side-effect signing is Task 4B, not here.)

- [ ] **Step 5: Run tests green**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: PASS.

- [ ] **Step 6: Commit (gws-skill)**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
git add proxy.go proxy_test.go
git commit -m "fix: classify gws probe audit logs"
```

### Task 4B — Signed Side-Effect Ledger Data Paths

Depends on Task 4A (audit id + headers) and Task 1 (`side_effect_ledger` schema + import skeleton). This is the optional side-effect-recovery channel and the only place the Ed25519 trust surface is introduced. It degrades safely without keys (Task 0 Step 4): unsigned `gmail_draft_created` JSONL stays an unvalidated hint, so the build is green and the feature is simply inactive.

**Files:**
- Modify: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy.go`
- Modify: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy_test.go`
- Modify: `container/shim/gws`
- Modify: `container/agent-runner/src/db/side-effects.ts`
- Modify: `container/agent-runner/src/db/session-state.test.ts`
- Modify: `src/gws-shim.test.ts`
- Modify: `/home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger/summary_writer.py`
- Modify: `/home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger/tests/test_stage_status.py`

- [ ] **Step 1: Write failing GWS signing + audit-store tests**

In `proxy_test.go`, using an in-process ephemeral Ed25519 test keypair (`crypto/ed25519`):

- On a successful API-effect mutation, the proxy returns `X-GWS-Side-Effect-Signature` (detached Ed25519 signature) and `X-GWS-Side-Effect-Payload` (canonical JSON `{audit_id, service, method, request_class, api_effect, operation_succeeded, occurred_at, result_digest}`), and the signature verifies with the test public key.
- A non-API (help/schema/local-validation) response carries no signature.
- The proxy reads optional `input_id`/`route_key` from the request and appends `{audit_id, input_id, route_key, service, method, occurred_at}` via `O_APPEND` to the JSONL store at `GWS_AUDIT_STORE`; a query helper finds a successful `drafts.create` by `input_id`/`route_key`/time window. A test reads `GWS_AUDIT_STORE` as the NanoClaw host would (direct read-only file access, co-located) and confirms the lookup; with `GWS_AUDIT_STORE` unset, no audit entry is written and discovery is inactive.
- With no signing key configured, the proxy emits classification headers but no signature and logs a single warning (feature inactive, not an error).

- [ ] **Step 2: Write failing GWS shim ledger tests**

In `src/gws-shim.test.ts`, run `container/shim/gws` against a fake proxy and assert:

- A success response with `X-GWS-Api-Effect: true`, `X-GWS-Operation-Succeeded: true`, `X-GWS-Request-Class: api`, and an `X-GWS-Side-Effect-Signature`/`-Payload` appends one sanitized `gmail_draft_created` JSONL record (carrying the signature + payload) before stdout is emitted. The shim does NOT verify the signature.
- A help/schema/local-validation response with `X-GWS-Api-Effect: false` appends no side-effect record.
- A denied or failed command appends no record.
- The shim reads `inputId`/`routeKey` from `/workspace/.active-input.json` at invocation time; if absent/stale it stages an uncorrelated diagnostic record.
- The append is a true atomic append (`O_APPEND` or `flock`), NOT temp+rename — a test must prove that two concurrent appenders both land their lines (temp+rename would lose one). If the API mutation succeeds but the append fails, the shim emits a structured partial-success error (audit id, no raw body) instead of ordinary stdout success.
- The record contains command class, audit id, input id, route key, sanitized args, optional draft id parsed from stdout, the signature/payload, and no raw authorization header or full email body.

- [ ] **Step 3: Write failing summarize-dnd ledger tests**

In `tests/test_stage_status.py`, set `NANOCLAW_SIDE_EFFECT_LEDGER` to a temp path and assert (both the stage path AND the full-run path go through ONE shared write+ledger helper):

- `stage_generate_short()` writes a `summarize_dnd_summary_artifact` record after the short summary file exists and before the stage success payload returns.
- A full-run-path test (with stdin and the LLM call mocked) writes the same record through the shared helper after the full-run summary files exist.
- The record includes a stable id, stage/run id, recording/source path, short/long artifact paths when available, `inputId`/`routeKey` from `/workspace/.active-input.json` when present, and no transcript/summary body.
- Re-running the same stage/path with the same output paths produces the same idempotency key, so NanoClaw imports one row.
- If the stage fails before output files exist, no success record is written.
- If output files exist but the ledger append fails, the path returns a structured partial-success error with safe artifact paths.

- [ ] **Step 4: Write failing side-effects.ts import + discovery tests**

In `session-state.test.ts` / a focused `side-effects.ts` test:

- `gmail_draft_created` import is authoritative ONLY when the Ed25519 signature verifies against the staged canonical payload with a configured public key; a forged/tampered signature or a missing key leaves it an unvalidated hint.
- Idempotency key = `audit_id`; replaying a genuine signed entry imports one row, not two.
- `summarize_dnd_summary_artifact` import is authoritative only when the artifact exists under an allowed output root and matches the staged hash/size.
- Crash-window discovery: given a proxy audit-store fixture with a completed `drafts.create` for an input id but NO JSONL entry, recovery discovers it via the audit-store query and does NOT duplicate the draft; given an allowed-root artifact with no ledger reference, recovery discovers the summary by artifact scan.

- [ ] **Step 5: Run tests red**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
cd /home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger
timeout 120s .venv-wsl/bin/python -m pytest tests/test_stage_status.py
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/gws-shim.test.ts
```

Expected: FAIL.

- [ ] **Step 6: Implement GWS Ed25519 signing + audit store**

In `proxy.go`: add optional `input_id`/`route_key` fields to `ExecRequest` (the shim sends them; absent for non-NanoClaw callers). Load the Ed25519 private key from `GWS_SIDE_EFFECT_SIGN_KEY_FILE` (root-owned) at startup. On a successful API-effect mutation, build the canonical payload `{audit_id, service, method, request_class, api_effect, operation_succeeded, occurred_at, result_digest}`, sign it with `crypto/ed25519`, and set `X-GWS-Side-Effect-Signature`/`X-GWS-Side-Effect-Payload`.

Audit-store access contract (must be concrete enough to wire in production, not just fixtures): the proxy appends `{audit_id, input_id, route_key, service, method, occurred_at}` (no body) to an append-only JSONL store at the path in `GWS_AUDIT_STORE`, using `O_APPEND` (not temp+rename). That path is a root-owned file the NanoClaw host can read directly — proxy and host are co-located on the same machine (the host already reaches the proxy over the OneCLI-mediated boundary), so host recovery reads `GWS_AUDIT_STORE` directly with read-only access; no new network endpoint is required. Retention is best-effort/bounded (size- or age-capped rotation is acceptable since this only backstops the rare kill-in-the-window case). Gating: if `GWS_SIDE_EFFECT_SIGN_KEY_FILE` or `GWS_AUDIT_STORE` is unset, skip signing/audit-store, emit classification headers only, log one warning — and the no-duplication guarantee degrades to "no duplication when the tool process survives to append." Do not change admission/policy/rate-limit/execution.

- [ ] **Step 7: Implement NanoClaw GWS shim ledger writing**

In `container/shim/gws`, read `inputId`/`routeKey` from `/workspace/.active-input.json` and include them in the POST body alongside `args` (the proxy's `ExecRequest` gains optional `input_id`/`route_key` fields — Step 6), so the proxy's audit store is correlated by them for crash-window discovery even when the kill happens before the JSONL append. Then append JSONL only after HTTP 200 with `X-GWS-Api-Effect: true`, `X-GWS-Operation-Succeeded: true`: stage the `X-GWS-Side-Effect-Signature`/`-Payload` verbatim (do not verify in sh), sanitize args (preserve method/resource, redact long body fields), and append with a true atomic append (`O_APPEND` or `flock`), never temp+rename. On append failure after API success, emit a recoverable partial-success error with the audit id and no raw body.

- [ ] **Step 8: Implement summarize-dnd shared ledger helper**

In `summary_writer.py`, factor the summary-write + ledger-append into ONE helper called by both `stage_generate_short()` and the full-run `main()` path. The helper appends JSONL (ASCII-safe, stable idempotency key, no transcript/summary body, `inputId`/`routeKey` from `/workspace/.active-input.json`) only when `NANOCLAW_SIDE_EFFECT_LEDGER` is set, after output files are written. On append failure after files exist, return a structured partial-success error with safe artifact paths.

- [ ] **Step 9: Implement side-effects.ts import + discovery**

In `container/agent-runner/src/db/side-effects.ts`, add `verifyGwsSideEffectSignature(payload, signature, publicKey)` (Ed25519 verify via Bun/Node `crypto`) reused by the host import helper, import `gmail_draft_created` as authoritative only on valid signature (idempotency key `audit_id`), import `summarize_dnd_summary_artifact` only on artifact existence + hash/size under an allowed root, and add the crash-window discovery paths (read the proxy's `GWS_AUDIT_STORE` JSONL directly for an orphan draft-create matching the active `input_id`/`route_key`/time window; artifact-root scan for an orphan summary). With no public key, leave Gmail entries as unvalidated hints; with `GWS_AUDIT_STORE` unset, discovery is inactive and the guarantee degrades to "no duplication when the tool process survives to append."

- [ ] **Step 10: Run tests green**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
cd /home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger
timeout 120s .venv-wsl/bin/python -m pytest tests/test_stage_status.py
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/gws-shim.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit all three repos**

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
git add proxy.go proxy_test.go
git commit -m "feat: sign gws side-effect metadata for recovery"
cd /home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger
git add summary_writer.py tests/test_stage_status.py
git commit -m "fix: record nanoclaw summary side effects"
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/shim/gws container/agent-runner/src/db/side-effects.ts \
  container/agent-runner/src/db/session-state.test.ts \
  src/gws-shim.test.ts
git commit -m "fix: import signed tool side effect ledgers"
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
- A Granola bridge that stalls at startup waiting for auth until the bridge startup deadline is classified as optional `auth_required`/`auth_expired` only when the captured stderr/status matches known credential prompts; an unclassified stall remains a startup failure.
- Container config records `agentMcpUnavailable.granola.category` as `auth_required` or `auth_expired`.
- Agent-facing unavailable text is sanitized and contains no host paths, uid/gid values, or raw thrown errors.
- The sanitized Granola unavailable state appears in the actual runner file or OpenCode system-context payload loaded by the local OpenCode provider, not only in host-side config objects.
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

When Granola degrades due to auth, omit its MCP server and allowed tools from container runtime config, add sanitized unavailable state, and recompose `CLAUDE.md` or the OpenCode-loaded system-context file. Remove stale unavailable entries when Granola starts successfully later. Add an agent-runner/OpenCode prompt-context assertion that the unavailable state reaches the content Yente actually reads.

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

## Task 6: Exact Dvora, Fruma, And Failure-Mode Replays Through Local Yente Injection

**Files:**
- Create: `container/agent-runner/src/opencode-incident-replay.test.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts` only if a shared helper is needed
- Modify: `container/agent-runner/src/providers/opencode.ts` only if the runtime test seam needs a small adjustment

- [ ] **Step 1: Build the incident replay harness and encode acceptance contracts first**

Write the Dvora, Fruma, side-effect, and terminal-taxonomy replay assertions in `opencode-incident-replay.test.ts` before adding harness shortcuts for them.

The harness must use the real `OpenCodeProvider`, not a canned `ScriptedProvider` or success-text-only scripted provider. It must provide:

- Fake OpenCode SDK client and runtime controller whose emitted events are generated from the SDK-surface probe fixtures, not hand-invented provider-only shapes.
- Fake event pump (driven by the injected clock/scheduler — no wall-clock waits) controlled by the test, while production event parsing, input acceptance, interruption classification, relay handling, and side-effect import code remain real.
- Per the Replay Integrity Contract's fake-leaf boundary: literal final strings (the Dvora progress line, `5/19 summary complete`, `Draft created in Gmail.`) are injected as the assistant `result`/message-part SDK leaf event; the assertions verify the real poll loop routes/delivers that leaf to the correct `messages_out` route, NOT that an LLM authored it. Faking the leaf is allowed; faking the NanoClaw machinery that carries it is not.
- Known session ids.
- Recorded prompt parts, `inputId`, continuation, prompt acceptance, and result input resolution.
- Recorded permission denials.
- Local GWS shim/proxy boundary from Task 4 that records Fruma help probes and draft creation audit records.
- Local production `summarize-dnd` side-effect boundary from Task 4, writing `summarize_dnd_summary_artifact` JSONL ledger records and actual allowed-root artifact files. The harness may fake filesystem, network, model, and SDK leaves, but it must use the production writer/importer boundary.
- Validated side-effect ledger entries imported into outbound DB before final assistant text.
- Local `messages_in` injection plus `runPollLoop()` assertions for `messages_out`, `processing_ack`, `session_state`, `container_state`, provider prompt acceptance, relay attempts, route metadata, and side-effect ledger.
- Test failures when user-visible success appears without matching provider `input-accepted`, input resolution, recovery-state, ack-lifecycle, route-scoped progress, and side-effect evidence.
- A guard that rejects final assistant success if the evidence is missing: the corresponding Gmail draft (validated `gmail_draft_created` ledger entry), the recording-selection/download tool-call leaf events, or the `summarize_dnd_summary_artifact` ledger entry + artifact file.

- [ ] **Step 2: Recover the exact Dvora original trigger if available**

Search local session DBs, retained logs, and incident artifacts for the original Dvora prompt that preceded the observed progress line. If found, store it as a fixture with a source comment. If not found, document that evidence boundary in the fixture and use the transcript-provided observed progress and follow-up as the minimum exact replay.

- [ ] **Step 3: Replay Dvora failure turn 1 with session `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`**

Inject the recovered trigger or evidence-boundary substitute. The first OpenCode turn must:

- Start/resume `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- Model the Drive recording as a local fixture with `recording_date=2026-05-19` and size metadata matching the observed 2.56 GB recording. The recording selection/download is injected as faked SDK tool-call leaf events (no real multi-GB download, and NO `summarize_dnd_recording_cached` producer is implemented in this plan — see the Side-Effect contract). The test must fail if the workflow jumps straight to summary success without the recording-selection/download tool-call leaf evidence; it asserts that evidence via the faked tool-call events, not a durable ledger entry.
- Emit the exact observed progress line through user-visible output, not seeded history:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

- Emit no-SSE wait ticks/keepalives beyond the old 300s watchdog and beyond 16 observed minutes without host sweep killing the container.
- Trigger a Yente-authored inactivity relay through the separate relay runtime, or one sanitized direct fallback only if relay setup/deadline fails; no outbound text may contain `OpenCode event timeout`.
- Keep the original turn alive across the inactivity notice unless the test explicitly drives a terminal transport/native-question/session failure.
- If the harness drives a terminal no-reuse interruption, recovery must include the exact progress line harvested from `messages_out` or MCP `send_message` output plus the original task.

- [ ] **Step 4: Replay Dvora failure turn 2 with exact follow-up and session `ses_19757b6f7ffeYulTtPz3gteQ84`**

Inject the exact follow-up:

```text
Great. Now do the 5/19 summary.
```

Drive the second historical failure path by starting or attempting session `ses_19757b6f7ffeYulTtPz3gteQ84` according to the recovery policy under test. Assertions:

- The follow-up row is not completed until the provider resolves it successfully or recovery owns it.
- Recovery context includes the first turn's exact progress line and any unresolved accepted inputs.
- The second old timeout path is also converted into long-work liveness or recovery/relay, not a raw `Error: OpenCode event timeout`.
- The eventual successful resumed turn emits a generic `summarize-dnd` summary tool side effect for the Dvora 5/19 recording workflow before final assistant text.
- The `summarize-dnd` summary side effect is written through the `summarize-dnd` JSONL ledger, validated against the local artifact file, and imported into `side_effect_ledger` before final assistant text.
- The side effect is not repeated on retry.
- The final user-visible output contains `5/19 summary complete`.
- Both observed session ids appear in the harness assertions so the original sequence was actually replayed.

- [ ] **Step 5: Recover or fixture Fruma prior context**

Search local session DBs, retained logs, and incident artifacts for the conversation that made the exact prompt refer to Matt Van Horn. If found, store it as a fixture with a source comment. If not found, document that evidence boundary in the fixture and seed only the minimum prior route-scoped context needed for "Actually create a draft in my gmail" to mean "create the previously discussed Matt Van Horn draft." The replay must not rely on hidden global context.

- [ ] **Step 6: Replay Fruma Gmail draft with GWS help probe and native question**

Inject the exact prompt:

```text
Actually create a draft in my gmail
```

The first harness turn must:

- Start/resume `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Invoke the local GWS shim/proxy boundary for the actual observed help probe before the native question: `gws gmail users drafts create --help`.
- Assert the resulting GWS audit records are classified as non-API help with `api_effect:false`, not draft creation.
- If the probed Fruma execution performs schema/introspection or local-validation probes, assert those records are classified as non-API with `api_effect:false` before any draft creation side effect.
- Emit the probed SDK-native question surface asking for Matt Van Horn's email address. If the probe says this is `message.part.updated` plus `permission.updated`, carry `ToolPart.callID` or equivalent part id and matching `Permission.callID`/`Permission.id`; if the SDK exposes a `client.question` or `question.*` surface, use that real surface instead.
- Assert the provider correlates the tool/question and permission/cancel events by call id/permission id or the discovered equivalent and denies/cancels through the real exported API when a cancellable permission exists.
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
- Invoke the local GWS shim/proxy boundary for actual draft creation and assert a draft-create audit record with `api_effect:true` and a `gmail_draft_created` side-effect ledger entry before final assistant text.
- Assert the `gmail_draft_created` entry is validated by the proxy's Ed25519 signature (verified with the test public key) before recovery or final success can use it; an unsigned/forged entry stays an unvalidated hint. The harness uses an ephemeral test keypair, not the production key.
- Emit final assistant text `Draft created in Gmail.`
- Complete both user rows only after successful result.
- Resolve Fruma recovery only after the successful result, not after prompt acceptance.

- [ ] **Step 7: Replay non-cancellable native-question restart**

Use the same Fruma initial prompt but emit a native question with no permission id/cancellable handle and no reuse proof. Assertions:

- Provider emits `clear-continuation` for `ses_1a47da93effeJdpKh0oiDUOP2Q`.
- Recovery context includes the original Gmail draft request, blocked question text, and `continuationPolicy: "clear"`.
- The email-answer follow-up starts a new OpenCode session, creates the Gmail draft side effect, and delivers `Draft created in Gmail.`
- No message claims same-session continuation after continuation was cleared.

- [ ] **Step 8: Replay terminal after side effect before final assistant output**

Add two cases:

- Gmail draft side effect completes at the local GWS boundary, then the stream dies before final assistant text.
- `summarize-dnd` summary artifact completes at its production boundary for the Dvora workflow, then the stream dies before final assistant text.

Assertions:

- Recovery includes durable side-effect evidence imported from JSONL.
- Recovery ignores unvalidated staged JSONL and uses only imported `side_effect_ledger` rows or safe partial-success audit/artifact evidence.
- The resumed prompt tells Yente the side effect already happened.
- The harness fails if the draft or summary side effect is repeated.
- The final user-visible answer reports the existing draft/summary instead of duplicating work.

- [ ] **Step 9: Replay direct transport and terminal taxonomy**

Add table-driven cases for no-SSE transport timeout, stream read error, stream end, queue overflow, absolute timeout, `session.error`, retry exhaustion, startup timeout, and prompt-acceptance timeout.

Each case must assert:

- Recovery has original task text, accepted/unresolved input rows, side effects, and continuation policy.
- Transport timeout preserves continuation unless exact attempted-session missing proof or explicit provider clear-continuation was observed.
- Raw provider error text is not written to user output.
- Terminal recovery startup/acceptance failure produces one sanitized direct fallback so the user is not left with no visible path forward.
- OpenCode active tool state is cleared.
- A later `continue` or exact domain follow-up succeeds through the real OpenCode harness.

- [ ] **Step 10: Run replay tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/opencode-incident-replay.test.ts
```

Expected: FAIL until Tasks 1-4 are wired.

- [ ] **Step 11: Run replay tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 180s bun test src/opencode-incident-replay.test.ts src/providers/opencode.test.ts src/poll-loop.test.ts src/db/session-state.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/opencode-incident-replay.test.ts \
  container/agent-runner/src/poll-loop.test.ts \
  container/agent-runner/src/providers/opencode.ts
git commit -m "test: replay yente opencode incidents"
```

## Task 7: Documentation And Full Verification

**Files:**
- Modify: `docs/agent-runner-details.md`

- [ ] **Step 1: Update agent-runner docs**

Update `docs/agent-runner-details.md` to document:

- `inputId`, `input-accepted`, `notice`, `interruption`, `side-effect`, and `clear-continuation` provider events.
- Successful result input-resolution rules and the one-active-input fallback.
- Provider metadata ownership versus poll-loop recovery ownership.
- Recovery lifecycle: `pending`, `in_flight`, `resolved`, `superseded`.
- Recovery deletion only after successful result/explicit supersession, not prompt acceptance, relay notice, or fallback notice.
- Recovery-owned ack host sync semantics, `failed` ack notice-proof semantics, atomic recovery transactions, unresolved-entry pressure behavior, and non-destructive malformed recovery cleanup.
- Route normalization, host-stamped `messaging_group_id`/`is_group`, route-scoped recovery, accumulated context partitioning, same-route multi-trigger preservation, route-bearing `messages_out`, and null-thread DM alias handling.
- Follow-up row lifecycle and accepted-but-unresolved recovery ownership.
- Inactivity relay capability detection, separate relay runtime ownership, relay deadline, status-only relay tool policy, and direct fallback limits.
- Relay-mode native OpenCode tool denial and route-locked `send_message` behavior.
- OpenCode native question disable/deny behavior using the probed SDK 1.15.10 surface; continuation clearing via explicit `clear-continuation`, positive session-existence check, and the `OPENCODE_CONTINUATION_FAILURE_LIMIT` zombie path.
- Long-work heartbeat/wait tick behavior, no-SSE transport timeout, the absolute turn ceiling enforced by the pump independent of heartbeat (and its relationship to host-sweep's `max(ABSOLUTE_CEILING_MS, declaredToolTimeoutMs)`), and declared-tool timeout caps. The pump's injected clock/scheduler (no global timers) and the single-reader `stream.next` rule.
- OpenCode model-provider request timeout configuration under the active provider name (`provider[OPENCODE_PROVIDER].options.timeout`) and the full `OPENCODE_*` env-var list.
- The Side-Effect Trust Mechanism (Ed25519: proxy private key, container/host public key), the GWS audit-classification vs signed-ledger split (Task 4A/4B), the `/workspace/.active-input.json` per-input correlation file, host-path import, validation rules, the crash-window discovery fallback, and partial-success behavior when external mutation succeeds but staging/import fails.
- Optional Granola credential degradation limits and OpenCode prompt-context visibility.
- Deploy ordering, rollback, and cross-repo backward-compatibility (point to the "Deploy Ordering, Rollback, And Backward Compatibility" section).

- [ ] **Step 2: Run targeted verification**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 180s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/providers/mcp-to-opencode.test.ts src/db/session-state.test.ts src/poll-loop.test.ts src/integration.test.ts src/opencode-incident-replay.test.ts src/providers/push.test.ts src/providers/codex.factory.test.ts
timeout 120s bun run typecheck
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 180s pnpm exec vitest run src/db/session-db.test.ts src/host-sweep.test.ts src/gws-shim.test.ts src/agent-mcp-config.test.ts src/agent-mcp-bridge.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
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

- [ ] **Step 4: Run dependent-repo verification**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
cd /home/dan/code/summarize-dnd/.worktrees/nanoclaw-side-effect-ledger
timeout 120s .venv-wsl/bin/python -m pytest
```

Expected: PASS.

- [ ] **Step 5: Run static guards**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
# question.asked is a REAL v2 SDK 1.15.10 event; the SDK-surface/event layer is allowed to dispatch on it.
# This guard only forbids it leaking into general provider/poll-loop logic, so it shares the SDK-surface carve-out.
! rg -n "question\\.asked" container/agent-runner/src src --glob '!**/*.test.ts' --glob '!**/opencode-events.ts' --glob '!**/opencode-sdk-surface.ts'
! rg -n "client\\.question" container/agent-runner/src src --glob '!**/*.test.ts' --glob '!**/opencode-events.ts' --glob '!**/opencode-sdk-surface.ts'
! rg -n "OpenCode event timeout|event timeout" container/agent-runner/src/providers/opencode.ts container/agent-runner/src/poll-loop.ts --glob '!**/*.test.ts' --glob '!**/fixtures/**'
# Token-based content check, NOT an identifier ban: a narrow constant named STALE_SESSION_RE is fine (claude.ts:269
# contains none of these tokens); this fails opencode.ts's old broad regex and any classifier matching generic transport/timeout.
! rg -n "ECONNRESET|connection reset|\\b404\\b|NotFoundError|event timeout" container/agent-runner/src/providers/opencode.ts container/agent-runner/src/providers/codex.ts container/agent-runner/src/poll-loop.ts --glob '!**/*.test.ts' --glob '!**/fixtures/**'
# The pump owns all timers via the injected clock/scheduler — no global timers, no Date.now.
! rg -n "setTimeout\\(|setInterval\\(|Date\\.now\\(" container/agent-runner/src/providers/opencode-events.ts
# Single-reader pump: stream.next() lives only inside the pump.
! rg -n "stream\\.next\\(" container/agent-runner/src --glob '!**/opencode-events.ts' --glob '!**/*.test.ts'
rg -n "isSessionInvalid\\(" container/agent-runner/src --glob '!**/*.test.ts'
rg -n "clearContinuation\\(" container/agent-runner/src --glob '!**/*.test.ts'
```

Expected:

- No production code references fake `question.asked` outside the SDK-surface/event layer (where the real v2 surface, if the probe finds it, is handled and covered by probe fixtures). Any production `client.question` reference is likewise isolated to that layer.
- No production stale/missing-session classifier or poll-loop invalidation path in `opencode.ts`/`codex.ts`/`poll-loop.ts` mentions `ECONNRESET`, `connection reset`, bare `404`, `NotFoundError`, or `event timeout` (transport-error typing for those tokens lives in `opencode-errors.ts`, which is not a session-proof path). A narrow same-domain constant like `claude.ts`'s `STALE_SESSION_RE` is allowed because it contains none of these tokens.
- The pump uses only the injected clock/scheduler (no `setTimeout`/`setInterval`/`Date.now`), so the long-timeout tests stay deterministic.
- `stream.next(` appears only inside `opencode-events.ts`.
- Every production `isSessionInvalid(` call passes attempted-continuation metadata; production `clearContinuation(` appears only in typed continuation-clear, positive-existence, or zombie-limit paths.

- [ ] **Step 6: Run production smoke ship blocker**

Run the canonical production Yente smoke against the real runtime after the implementation is otherwise green. Use `/home/dan/code/shapiroserver2/docs/nanoclaw/smoke-test-instructions.md`, `docs/nanoclaw/e2e-smoke.py`, and `docs/nanoclaw/e2e-smoke.yaml` from the `shapiroserver2` repo. This is the ship blocker for all Yente timeout-hardening changes; local unit, integration, replay, and dependent-repo tests are not a substitute for it.

Expected: PASS. If the change has not been deployed or the production smoke has not run, mark the work as local-only/unshipped with production smoke pending.

- [ ] **Step 7: Commit docs**

If verification exposes implementation defects, return to the owning task, fix the defect with a focused test, rerun that task's verification, and commit the concrete changed files there. This step commits only the documentation update.

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add docs/agent-runner-details.md
git commit -m "docs: document recoverable provider interruptions"
```

## Deploy Ordering, Rollback, And Backward Compatibility

Deploy is out of scope for this plan (do not mutate the live host), but the cross-repo runtime contract must be backward-compatible by construction so a partial deploy fails safe to "feature inactive," never to a half-present contract. Record and honor:

- **Each cross-repo change is an additive no-op against the old peer.** GWS classification headers and `X-GWS-Side-Effect-*` are additive and ignored by an old shim; the shim's ledger write is gated on `X-GWS-Api-Effect: true`; `summarize-dnd`'s ledger write is gated on `NANOCLAW_SIDE_EFFECT_LEDGER` being set; the NanoClaw importer tolerates absent headers/signature/ledger (unsigned → unvalidated hint). So any single component on the old version leaves the others working with the feature simply dormant.
- **Safe deploy order:** GWS proxy (4A then 4B) and `summarize-dnd` first (they are no-ops until NanoClaw consumes them), then provision the Ed25519 keypair (Task 0 Step 4), then NanoClaw last. **Revert order is the reverse:** roll back NanoClaw first, then the dependent repos. The Gmail side-effect-recovery feature stays inactive until the keypair is present, so it can be enabled/disabled independently of code.
- **In-flight container at deploy:** an old-image container may still own `outbound.db` when new host code lands. The container self-migrates the outbound schema on next startup via the idempotent `getOutboundDb` `CREATE`/`ALTER` path (Task 1 Step 6); the host opens `outbound.db` writable only after verified container exit (existing single-writer invariant). Add a test that opening an outbound DB created by the old schema succeeds and self-migrates.
- **Provider regression gate / rollback for the `inputId` contract flip:** because Task 1 changes row-completion semantics for the working Claude and Codex providers (not just OpenCode), Task 7 Step 3's full `bun test`/`pnpm test` is the regression gate — the complete existing Claude and Codex provider/poll-loop suites must be green. The common single-top-level-input case is covered by the one-active-input fallback; the rollback is reverting to result-driven completion (the change is one squashed branch, not yet deployed). Do not hide the contract behind an OpenCode-only capability flag (that contradicts the intentional provider-fact unification).

## Final Completion Criteria

Implementation is complete only when all of these are true:

- Dvora replay uses the recovered exact original inbound request when available, otherwise documents the evidence boundary, injects the transcript-known progress and follow-up through local Yente, harvests the progress from user-visible output, includes both observed session ids `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT` and `ses_19757b6f7ffeYulTtPz3gteQ84`, models the 5/19 recording selection/download/cache evidence, emits no raw OpenCode timeout, preserves or clears continuation only according to proof, validates the generic `summarize-dnd` 5/19 summary side effect at the tool boundary, and ultimately delivers the summary result.
- Fruma replay recovers or minimally fixtures the prior Matt Van Horn context, injects `Actually create a draft in my gmail`, crosses a local GWS shim/proxy boundary for the observed `gws gmail users drafts create --help` probe before the native question, classifies any schema/local-validation probes as non-API, visibly asks for Matt Van Horn's email before the answer is injected, creates and validates a Gmail draft side effect and audit record before final output, emits no raw timeout, and ultimately delivers `Draft created in Gmail.`
- Non-cancellable native-question replay clears the unusable continuation, restarts from recovery, and succeeds without claiming same-session continuation.
- Direct no-SSE/heartbeat-only long work exceeds the observed 16-minute window in tests while remaining state-preserving and host-alive; terminal transport failure at the configured longer deadline recovers successfully and preserves continuation absent exact missing-session proof.
- Inactivity notices carry concrete liveness metadata and are relayed by Yente through the separate restricted relay runtime when available, or produce one sanitized direct fallback while the original long turn continues; they never clear continuation by stale-session heuristic.
- Terminal interruption paths either produce a Yente-authored recovery message or one sanitized direct fallback after bounded recovery startup/acceptance failure; no path silently strands the user.
- Recovery context is route-scoped, XML-escaped, retained through failed accepted recovery attempts, never pruned while unresolved, and deleted only after successful result or explicit supersession.
- Recovery ownership transitions and payload writes are atomic; host wake/sync excludes recovery-owned rows from due counts and preserves them across startup/sweep.
- Initial batches with multiple wake-triggering routes are split; same-route multi-trigger tasks are stored and resumed in order; accumulated `trigger=0` context is partitioned by route before prompt/recovery formatting.
- Host-stamped `messaging_group_id` and `is_group` are wired from ingress through `messages_in`, `session_routing`, `messages_out`, recovery scope, and relay routing.
- Follow-up rows are completed only after successful result or explicit supersession; unaccepted route-matched rows are returned to pending and do not get hidden or duplicated; accepted-unresolved rows remain recovery-owned until resolved.
- `processing_ack.status='failed'` is never used for recoverable interruptions and cannot be host-synced to completion without proof that a user-visible terminal fallback was written.
- Pre-query, provider startup, prompt acceptance, stream, queue, absolute-timeout, session.error, host-kill, and container-crash paths all produce resumable recovery or a user-visible fallback without raw provider errors.
- Side effects completed before a provider failure are staged through the concrete GWS shim/proxy and `summarize-dnd` JSONL data paths, validated into `side_effect_ledger` (GWS by Ed25519 signature verified with the public key; `summarize-dnd` by artifact existence + hash/size), carried into recovery, and not duplicated in Gmail draft and `summarize-dnd` summary tests for the Dvora workflow. Agent-writable staged JSONL alone is never authoritative; with no verify key the entry is an unvalidated hint and the feature is inactive. The kill-between-mutation-and-append window is covered by the proxy-audit-store / artifact-scan discovery fallback, or explicitly stated as "no duplication when the tool process survives to append."
- OpenCode native question handling uses the actual probed SDK 1.15.10 surface, not fake `question.asked` assumptions.
- OpenCode continuation clearing fires only on an explicit provider `clear-continuation`, a positive session-existence check, or the bounded `OPENCODE_CONTINUATION_FAILURE_LIMIT` zombie path; it never clears on generic transport/timeout/`404`/`NotFoundError` text, and a genuinely dead session is neither preserved forever nor retried indefinitely.
- OpenCode model-provider request timeout is raised/disabled under the ACTIVE provider name (`provider[OPENCODE_PROVIDER].options.timeout`) so long turns are governed by NanoClaw liveness instead of a hidden 5-minute abort; the test asserts the value under that provider key.
- Declared tool timeouts cannot exceed `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`, overlapping tool tracking cannot clear long-tool protection while a longer tool remains active, and the pump enforces the absolute turn ceiling independent of heartbeat refresh so a heartbeat-refreshing-but-stuck turn is still terminated/recovered at the ceiling.
- Optional Granola credential failure no longer prevents container spawn, while auth-directory security and required bridge failures still fail closed, and the sanitized unavailable state reaches OpenCode/Yente prompt context.
- Optional Granola auth-stall/startup-abort is covered by tests and degrades only for known credential failures.
- GWS probe logs (Task 4A) classify request and completion records before logging with `api_effect:false`, cover help/version/schema/local-validation probes that reach `/exec`, and do not broaden allowed behavior — with admission proven unchanged by a test that a help probe of a rate-limited method still consumes/denies under the existing limiter.
- Task 0 preconditions are satisfied before any red/green cycle: `bun install` in `container/agent-runner`, the dependent-repo worktrees, the `summarize-dnd` `.venv-wsl` with pytest and an importable `summary_writer`, and the Ed25519 keypair note. The per-input correlation is the poll-loop-written `/workspace/.active-input.json` file (verified by a follow-up-stamping test), not stale process env.
- The relay runs in a separate OpenCode runtime with its OWN route-locked-`send_message`-only MCP-server subprocess; relay outbound writes coordinate with the original turn through SQLite `busy_timeout` + row-level ownership (no cross-process transaction-queue fiction), and a relay can never resolve another input's rows.
- The cross-repo contract is backward-compatible and deploy-ordered per "Deploy Ordering, Rollback, And Backward Compatibility"; Task 4A (audit-only) is shippable independently of Task 4B (signed ledger).
- NanoClaw, GWS, and `summarize-dnd` changes are committed in their respective repos, every verification command in Task 7 passes, and the production Yente smoke ship blocker has passed for the real runtime before any ship/deploy claim.
