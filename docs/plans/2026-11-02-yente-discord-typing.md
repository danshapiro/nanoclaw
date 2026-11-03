# Discord Request Typing Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Make Yente reliably show the Discord typing indicator while a user request is active, including quiet thinking and tool work, and stop when the request ends.

### Explicit constraints
- Keep the solution simple and use the existing periodic Discord typing refresh.
- Use the-usual workflow, stopping after load-bearing validation.
- Do not deploy or mutate production without explicit authorization.

### Accepted tradeoffs and residuals
- None stated.

# Scope rule

The User Request defines need. Deliver its Requested result and Explicit constraints by the simplest complete means, and build only what they require. Preserve pre-existing code and behavior unless satisfying the User Request requires changing them.

A reviewer's suggested remedy is advisory; the finding itself is what must be resolved.

Every substantiated finding is binding: the run may not report success until it reaches a final disposition. Binding never requires a fix.

- `CLEARED` — fixed, with evidence: corrected, or simplified away by removing machinery this run introduced or materially expanded so the finding no longer applies.
- `UNSUBSTANTIATED` — the assessment finds the finding wrong, with the reason recorded.
- `OUT-OF-SCOPE` — available to Major, Minor, and Nit findings. The finding does not block the Requested result or an Explicit constraint. Record a one-line reason; the recap lists it as a suggestion.
- `OPTIONAL` — available only to Minor and Nit findings. Probably a real improvement, but nothing requires it. Record a two-sentence reason: one sentence says why it would improve the work, one says why it is not required. The recap lists it; it never blocks anything and may be acted on at any time or never.

Apply this scope as given — never rewrite the User Request to fit the work. If no compliant clearing exists, mark the result `FAILED/non-converged` and report the conflict.

# Turn economy

Batching changes scheduling only: preserve every call, instruction, output, acceptance criterion, evidence item, required order, and gate. This policy is a fixed safety boundary; orchestrators that load it apply it as written.

- INDEPENDENCE: Put ready independent calls in the same tool-call response only after confirming all inputs are known, no call needs another's result, and no call can change state another reads or writes. Treat uncertain independence as a dependency.
- SAFE REPORT FAN-OUT: Calls that only read shared state may batch. Each may also write only to its own predeclared, disjoint report path — one per topic under the run's reports directory — after shared directory setup. A shared ledger, anchor, receipt, index, Git state, or other shared artifact is not a disjoint report.
- MUTATION BOUNDARY: Run mutations of one worktree one at a time: one mutating delegate per worktree at any moment. Parallel mutators require isolated worktrees with independent Git state and disjoint external targets. Calls are dependent when either can change state the other reads or writes. A mutating delegate without a bounded write scope owns its whole worktree.
- CALL BOUNDARY: A batch combines scheduling only. Each call keeps its own instruction, scope, output, acceptance criteria, and evidence; do not widen or merge calls merely to reduce turns. Attribute every result to the call that produced it.
- JOIN: After a batch finishes, account for every result before any downstream action that depends on those results, including synthesis, repair, review, commit, or another gate.
- DURABILITY: Record each result in the run's durable record — [usual-run-contract](usual-run-contract.md) owns its schema — in the first response after the result lands and before reading any full report; then read only the sections needed. Put ready independent bookkeeping in the same tool-call response; never defer it to a phase-end sweep.
- REVIEW: Preserve each review's specified exact instruction, context isolation, and provider/model settings; wait for its verdict before dependent repair. When a batching assumption proves wrong or a boundary is violated, tighten: isolate the affected calls and run them one at a time.

**Goal:** Keep the indicator visible throughout an active Discord request and cease refreshing when its work ends.

**Architecture:** Preserve the existing immediate and four-second typing calls, and derive their lifetime from the request's existing persisted lifecycle rather than heartbeat timestamps or message delivery. Associate activity with the actual Discord target and message IDs; restore active targets when interrupted work resumes. Preserve other channel behavior.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest, existing Discord adapter.

## Global Constraints

- Work only in `/home/dan/code/nanoclaw-yente-typing/.worktrees/yente-discord-typing`; run tests there, reuse dependencies, and observe its `AGENTS.md` and `docs/build-and-runtime.md`.
- Do not deploy, change the live host, or invoke a live Discord smoke. Stop the workflow after load-bearing validation as the user requested.
- Keep the existing `setTyping` adapter and four-second refresh; do not use a second independently maintained source of request state.
- Read SQLite using the existing session openers and close each connection. Never write the container-owned DB while its container may be live. Log lifecycle read failures with structured severity and enough identifying context to diagnose them.
- Maintain separate targets for shared-session routes; allow overlapping requests at the same target without duplicate timers. Accumulate-only messages and unrelated scheduled work must not start Discord typing.

## UNRESOLVED COVERAGE GAP — resolve at the load-bearing validation gate before treating this draft as executable

The existing data does not yet establish a simple, fully correct restart/recovery rule. `processing_ack='recovery'` means ownership was transferred, not necessarily that work is actively running; it can be held for a bounded wait, released, escalated, or resumed as context for a different trigger. A blanket pending-or-recovery query can show typing indefinitely or misidentify when a request actually resumes. `recoverAfterKill` can also call `wakeContainer` directly (`src/host-sweep.ts:1719-1726`), so a restoration hook only at the ordinary due-count wake is incomplete. A restarted host's periodic sweep begins immediately but visits sessions sequentially; determine whether its timing satisfies the user's reliability requirement. Establish the existing actual transitions and exact restoration hook, including error and retry paths, with behavioral evidence before finalizing production code.

The stored inbound address is the **reply address**, whereas the existing immediate typing target is the **source address** (`src/router.ts:511-519`, `:753-760`, `:799-805`). Determine whether a Discord inbound with a differing `replyTo` exists in supported paths. If it does, restoring the original source address requires a durable representation or a behaviorally justified source of truth; do not silently substitute the reply address.

Because these facts remain load-bearing, the full restart implementation and complete test patches cannot honestly be specified yet. Stage 2 must judge both gaps against safe evidence, resolve them or select an acceptable path as the-usual prescribes, and update this plan accordingly. If no path delivers the request within its constraints, report `FAILED/non-converged`. This is an explicitly incomplete implementation plan; do not treat it as executable until the gaps are resolved.

## File responsibilities

1. `src/modules/typing/index.ts`: keep Discord refresh intervals and target grouping, determine each target's current request state by short-lived SQLite reads, and expose restoration entry point(s) established by validation. Preserve non-Discord behavior; explicit session cleanup must stop all its targets.
2. `src/router.ts`: register the exact routed message and Discord target after the message is durable and before wake. Do not start for the accumulate branch, gate rejections, or host-only commands. Maintain immediate typing.
3. `src/delivery.ts`: remove the post-delivery pause **for Discord only**; other platforms keep the current pause. Intermediate user-facing output cannot terminate an active Discord request.
4. `src/host-sweep.ts` and possibly `src/container-runner.ts`: reconnect a resumed Discord request to the typing module at the one validated lifecycle boundary that covers startup, retry and crash recovery. Do not create a new recovery mechanism.
5. `src/router.test.ts` or a focused adjacent host integration file: exercise actual routing, actual inbound/outbound DB rows, fake Discord adapter, and fake timers. `src/host-sweep.revival.test.ts` / `src/container-runner.test.ts`: extend the existing real recovery fixture only where necessary to prove restoration. `src/channels/chat-sdk-bridge.test.ts`: verify thread and null-thread selection if it is not already covered by the host integration.

## Stage 2: Validate load-bearing lifecycle and addressing assumptions

**Files:** Inspect `src/modules/typing/index.ts`, `src/router.ts`, `src/delivery.ts`, `src/host-sweep.ts`, `src/container-runner.ts`, `src/db/session-db.ts`, `src/session-manager.ts`, `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/db/messages-in.ts`, and corresponding recovery tests. Validators are read-only: they may write only their designated reports under the run's logs directory, never tests, configuration, production, or other state. The coordinator owns the ledger, receipt, and any resulting plan update and commit.

**Interfaces:** Consumes: `startTypingRefresh(sessionId, agentGroupId, channelType, platformId, threadId)` and the persisted `messages_in` / `processing_ack` rows. Produces: evidence and decisions for active, ended, and resumed state definitions, target identity, and the restoration boundary. Any state-changing check is recorded as blocked and followed by safe fallback evidence.

- [ ] **Step 1: Trace recovery with actual DB state.** Establish, for each of cold pending, pre-accept retry, accepted interruption, in-container `recovery` ownership, normal completion, cancellation, terminal failure, and reset: request row status and ack; whether a container is running; what wakes it; whether work is still actively being performed; and which target is correct. In particular trace `recoverAfterKill` through `recoverInterruptedTurnBounded` and `recoverGwsClaimPartitions`, and runner `markRecoveryInFlight` / `markRecoveryCompleted` through `session_state`. Inspect all `replyTo` producers, not only the router.
- [ ] **Step 2: Validate safely.** Use read-only code inspection and existing evidence or commands only when they do not write or alter state. Examine quiet processing beyond heartbeat expiry, start-before-claim, completion before the 60-second sweep, interrupted/recovered turns, and differing source/reply addresses if supported. Do not write tests or change production. Record any state-changing check as blocked and use the safe fallback chain; evidence that does not establish a claim remains inconclusive.
- [ ] **Step 3: Judge and resolve.** Record an explicit decision table for `pending`, `processing`, `completed`, `failed`, `recovery`, missing DB, transient read failure, inactive session, interrupted container and resumed work. Specify handling per target and per request ID, start/restore/stop hooks, and behavior tests for target fidelity and timer cleanup. For transient DB errors log and retry without equating an unreadable database with completed work; ensure one unreadable session cannot block others. The coordinator updates the plan only as supported by the stage's evidence and records any acceptable path or unresolved conflict in the ledger. If no viable path delivers the request, report `FAILED/non-converged`.
- [ ] **Step 4: Stop immediately after Stage 2.** Complete its ledger, plan update, commit and receipt as required. Do not start the subsequent plan review, implement Task 2, or deploy in this run.

## Task 2: Request-scoped Discord typing (for a separately authorized continuation)

**Files:** Modify `src/modules/typing/index.ts`, `src/router.ts`, `src/delivery.ts`, and the precise recovery/wake site established by Stage 2. Test with `src/router.test.ts`, the selected recovery fixture and `src/channels/chat-sdk-bridge.test.ts` as justified by the final plan.

**Interfaces:** The final plan must state exact names and signatures of the registration and restoration methods. Each registration identifies `sessionId`, `agentGroupId`, Discord target (`platformId`, `threadId`) and the persisted routed message ID. Completion is based on current matching message/ack state, never message delivery or heartbeat freshness. Any generic/non-Discord API must preserve its existing behavior.

- [ ] **Step 1: Add real failing behavioral tests.** Use the existing `src/router.test.ts` fixture (`event`, `setDeliveryAdapter`, `findSessionForAgent`, `outboundDbPath`) with fake timers and real SQLite, not a mocked status helper. For one request assert immediate typing, repeated calls every four seconds after 40 seconds without heartbeat, and continued calls across a real `deliverSessionMessages` intermediate chat. Change the matching `processing_ack` to `completed`, advance a bounded timer tick and assert no later refresh despite a warm container. Also test failed/cancelled work, reset, cold pending before first claim, repeated same-route messages (first completion must not stop the second), two routes in one shared session, two independent sessions, adapter rejection, and stop/restart without duplicate intervals. Test the exact validated recovery path: no restart for finished or held work, and immediate restart for an actually resumed request. Test real target selection including null thread. Cleanup test-owned timers and DB handles in `finally`.
- [ ] **Step 2: Confirm red for the intended reason.** Run `pnpm exec vitest run src/router.test.ts` and the exact recovery test chosen by Stage 2. Expected: new assertions fail because current refresh expires with stale heartbeat and pauses on intermediate delivery; unrelated existing tests pass. Fix fixture failures before proceeding.
- [ ] **Step 3: Implement the validated lifecycle boundary.** Replace Discord heartbeat/pause gating with the Stage 2 state table; retain the existing immediate send and four-second interval, and group distinct targets rather than replacing the session's prior target. Use the persisted message IDs to account for overlap and direct outbound ack reads for completion without waiting for host sweep. Do not turn a successful message delivery into completion. On transient failures keep existing timers and log; close SQLite handles per operation. Restore only real resumed work through the validated hook. Preserve non-Discord behavior.
- [ ] **Step 4: Run focused tests.** Run `pnpm exec vitest run src/router.test.ts` and the exact recovery test. Expected: all pass, with recorded Discord calls for the intended route while active and none on future ticks after terminal state.
- [ ] **Step 5: Refactor while green.** Remove duplicated or obsolete Discord-only grace, heartbeat and pause handling; keep shared handling needed for other platforms. Confirm every active timer has one owner and is removed on terminal state and explicit session cleanup.
- [ ] **Step 6: Run impacted tests.** Run `pnpm exec vitest run src/router.test.ts src/delivery.test.ts src/container-runner.test.ts src/host-sweep.test.ts src/host-sweep.revival.test.ts src/channels/chat-sdk-bridge.test.ts src/channels/discord.test.ts` and the new focused test if separate; then `pnpm run typecheck` and `pnpm run format:check`. Expected: all pass. This host-only design does not change runner code; if validation requires runner changes, add its relevant `bun test` suite following `docs/build-and-runtime.md` before implementation.
- [ ] **Step 7: Commit only the completed task.** Stage the exact changed files after `git status --short` and commit with `git commit -m 'fix: keep Discord typing active through requests'`. Do not deploy. Record tests and any visual verification limitation.

## Planning self-review

The user request and supplied scope and scheduling rules appear unchanged once. Stage 2 protects the read-only validation and no-production constraints; Task 2 maps quiet work, intermediate messages, completion, overlaps and restart to behavioral checks. The architecture, exact interfaces, executable tests and implementation patches remain incomplete because of the explicit coverage gaps above. Stage 2 will assess those gaps; a later plan review and implementation are outside this run. A recording adapter verifies host behavior, not Discord's live UI; do not represent it as a live production proof.
