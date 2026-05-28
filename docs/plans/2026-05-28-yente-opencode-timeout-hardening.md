# Yente OpenCode Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yente must survive long OpenCode silence, native OpenCode question stalls, optional MCP bridge outages, and misleading GWS help/probe logs without losing continuation state or showing raw timeout errors to the user.

**Architecture:** Replace the OpenCode provider's `Promise.race(stream.next(), timeout)` loop with a single-reader event pump so soft inactivity warnings do not strand pending SSE reads. Extend the provider/poll-loop contract with user-visible, recoverable notices and persisted recovery context, while keeping stale-session clearing only for genuinely invalid continuations. Treat OpenCode native `question` tool activity as a recoverable interruption because NanoClaw cannot answer OpenCode's TUI-native question path; preserve the OpenCode session, notify the user, and inject that context into the next turn.

**Tech Stack:** TypeScript, Bun tests for `container/agent-runner`, Vitest for host-side NanoClaw, Go tests for `gws-skill`, SQLite session state, OpenCode SDK 1.15.10 event stream.

---

## Scope And Decisions

The requested fix spans two repositories:

- `/home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening` owns Yente/OpenCode runtime hardening, poll-loop behavior, optional host-managed MCP bridge behavior, local incident replay tests, and docs.
- `/home/dan/code/gws-skill` owns the GWS proxy audit-log correction. Do that work in a new sibling worktree under `/home/dan/code/gws-skill/.worktrees/` and commit it separately.

Do not mutate the live `shapiroserver2` host or deploy production from this implementation pass. The required "inject requests into Yente" coverage is satisfied by deterministic local NanoClaw/Yente session injection tests that write the same inbound messages through the session DB and poll-loop path. If later production deployment is explicitly requested, repeat the same prompts through the deployed smoke runner after deployment.

Important semantics to preserve:

- A five-minute OpenCode "meaningful event" gap is not a stale session and must not clear `continuation:opencode`.
- Heartbeats prove the OpenCode SSE transport is alive but are not meaningful model progress. They should keep the runner alive and allow long work to continue.
- A soft inactivity notice is user-visible and structured, not `Error: OpenCode event timeout (...)`.
- The OpenCode session and runtime stay alive across soft inactivity. The current turn continues waiting for eventual `session.idle` unless a true hard transport failure occurs.
- A native OpenCode `question` tool is not a long-running job. It is a stuck, unsupported interaction path. Stop waiting, keep the continuation, notify the user with the question text if available, persist recovery context, and let the next user reply resume the same OpenCode session.
- Optional MCP bridge failures, especially Granola auth failures, must not block container startup. Required bridges may still fail closed if explicitly configured.
- GWS `--help`, `-h`, and local probe invocations must never be logged as successful Google API operations.

## File Structure

### NanoClaw

- Modify `container/agent-runner/src/providers/types.ts`
  - Add provider-visible notice/interruption event types.
  - Document that `error` is not used for expected recoverable inactivity.

- Create `container/agent-runner/src/providers/opencode-events.ts`
  - Own the OpenCode SSE event pump.
  - Keep exactly one active `stream.next()` reader.
  - Classify `event`, `soft-timeout`, `transport-timeout`, and `ended`.
  - Track `lastEventType`, `lastEventAt`, `lastMeaningfulEventType`, and `lastMeaningfulEventAt`.

- Create `container/agent-runner/src/providers/opencode-errors.ts`
  - Define `OpenCodeTransportTimeoutError` and helpers for stable classification.
  - Keep `event timeout` out of stale-session matching.

- Modify `container/agent-runner/src/providers/opencode.ts`
  - Use `OpenCodeEventPump`.
  - Remove timeout-driven `activeSessionId` clearing and `destroySharedRuntime()`.
  - Yield visible notices on soft inactivity and keep consuming events.
  - Detect native OpenCode `question` tool parts and yield a recoverable interruption.
  - Keep existing stale-session recovery for `promptAsync` missing-session errors.
  - Improve structured JSONL logs for provider events.

- Modify `container/agent-runner/src/db/session-state.ts`
  - Add a small provider recovery-notice queue keyed per provider.
  - Export `appendProviderRecoveryNotice(providerName, notice)`, `consumeProviderRecoveryNotices(providerName)`, and test helpers through normal APIs.

- Modify `container/agent-runner/src/poll-loop.ts`
  - Dispatch provider notices to `messages_out`.
  - Persist recovery context from recoverable interruptions.
  - Consume pending recovery notices at the next provider query and prepend them to the prompt as a `<system>` block.
  - Do not clear continuation for OpenCode inactivity.
  - Keep raw unexpected provider throws as visible errors.

- Modify `container/agent-runner/src/providers/opencode.test.ts`
  - Update stale-session tests.
  - Add event-pump timeout and question-tool tests.

- Add `container/agent-runner/src/providers/opencode-events.test.ts`
  - Unit-test the single-reader pump directly.

- Modify `container/agent-runner/src/db/session-state.test.ts`
  - Cover recovery notice append/consume and provider isolation.

- Modify `container/agent-runner/src/poll-loop.test.ts`
  - Cover visible notices, persisted recovery context, continuation retention, and no raw timeout leakage.

- Add `container/agent-runner/src/incident-replay.test.ts`
  - Replay the Dvora and Fruma incidents with exact user-facing prompts through `runPollLoop()` and injected session DB rows.

- Modify `src/agent-mcp-config.ts`
  - Add optional `required?: boolean` to bridge config, defaulting to `false`.

- Modify `src/container-config.ts`
  - Add `agentMcpUnavailable?: Record<string, { reason: string; updatedAt: string }>` for spawn-time bridge availability notes.

- Modify `src/container-runner.ts`
  - Treat non-required bridge startup failures as degraded availability.
  - Filter allowed tools to successfully started bridges.
  - Persist unavailable-bridge notes and re-compose `CLAUDE.md` after bridge resolution.
  - Keep required bridge failures fail-closed.

- Modify `src/claude-md-compose.ts`
  - Emit inline fragments for `agentMcpUnavailable` so agents know a bridge is unavailable for this run.

- Modify `src/agent-mcp-config.test.ts` and `src/container-runner.test.ts`.

- Create `src/claude-md-compose.test.ts`
  - Cover generated unavailable-MCP fragments because no existing test file currently owns that composer behavior.

- Modify `docs/agent-runner-details.md`
  - Update the provider event contract and OpenCode timeout semantics.

### GWS Proxy

- Create worktree: `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening`
- Modify `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy.go`
  - Add invocation classification for `api`, `help`, and `local_probe`.
  - Add audit fields `request_class` and `api_effect`.
  - Log help/probe execution as non-API activity, not as successful Gmail/Calendar mutation.

- Modify `/home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening/proxy_test.go`
  - Add JSON log assertions for `gws gmail users drafts create --help`.
  - Assert no `executed` API-success log is emitted for help/probe requests.

## Task 1: OpenCode Event Pump And Timeout Classification

**Files:**
- Create: `container/agent-runner/src/providers/opencode-events.ts`
- Create: `container/agent-runner/src/providers/opencode-events.test.ts`
- Create: `container/agent-runner/src/providers/opencode-errors.ts`
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`

- [ ] **Step 1: Identify the failing tests**

Add failing tests first.

In `container/agent-runner/src/providers/opencode.test.ts`, change the stale classification test:

```typescript
expect(isStaleSessionError(new Error('OpenCode event timeout (300000ms)'))).toBe(false);
```

In `container/agent-runner/src/providers/opencode-events.test.ts`, add:

```typescript
import { describe, expect, it } from 'bun:test';
import { OpenCodeEventPump } from './opencode-events.js';

describe('OpenCodeEventPump', () => {
  it('reports soft inactivity without abandoning the stream reader', async () => {
    let release!: () => void;
    async function* stream() {
      yield { type: 'server.connected', properties: {} };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: 'session.idle', properties: { sessionID: 's1' } };
    }

    const pump = new OpenCodeEventPump(stream(), {
      isKeepalive: (event) => event.type === 'server.connected' || event.type === 'server.heartbeat',
    });

    const first = await pump.nextMeaningful('s1', { softTimeoutMs: 5, transportTimeoutMs: 1000 });
    expect(first.kind).toBe('soft-timeout');
    release();
    const second = await pump.nextMeaningful('s1', { softTimeoutMs: 1000, transportTimeoutMs: 1000 });
    expect(second.kind).toBe('event');
    if (second.kind === 'event') expect(second.event.type).toBe('session.idle');
    await pump.close();
  });

  it('treats heartbeat-only streams as alive transport but not meaningful progress', async () => {
    async function* stream() {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield { type: 'server.heartbeat', properties: {} };
      }
    }

    const pump = new OpenCodeEventPump(stream(), {
      isKeepalive: (event) => event.type === 'server.heartbeat',
    });
    const result = await pump.nextMeaningful('s1', { softTimeoutMs: 8, transportTimeoutMs: 100 });
    expect(result.kind).toBe('soft-timeout');
    if (result.kind === 'soft-timeout') {
      expect(result.lastEventType).toBe('server.heartbeat');
      expect(result.lastMeaningfulEventType).toBeUndefined();
    }
    await pump.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
```

Expected: FAIL. `event timeout` is still stale, and `opencode-events.ts` does not exist.

- [ ] **Step 3: Implement the event pump and typed errors**

In `opencode-errors.ts`, define:

```typescript
export class OpenCodeTransportTimeoutError extends Error {
  readonly name = 'OpenCodeTransportTimeoutError';
  constructor(
    readonly sessionId: string,
    readonly transportTimeoutMs: number,
    readonly lastEventType: string | undefined,
    readonly lastEventAt: number | undefined,
  ) {
    super(`OpenCode transport timeout after ${transportTimeoutMs}ms for session ${sessionId}`);
  }
}

export function isOpenCodeTransportTimeout(err: unknown): err is OpenCodeTransportTimeoutError {
  return err instanceof OpenCodeTransportTimeoutError;
}
```

In `opencode-events.ts`, implement a queue-backed single-reader pump:

```typescript
export type OpenCodeSseEvent = { type?: string; properties: Record<string, unknown> };

export type OpenCodePumpResult<T extends OpenCodeSseEvent> =
  | { kind: 'event'; event: T }
  | {
      kind: 'soft-timeout';
      sessionId: string;
      elapsedMs: number;
      lastEventType?: string;
      lastEventAt?: number;
      lastMeaningfulEventType?: string;
      lastMeaningfulEventAt?: number;
    }
  | { kind: 'ended' };

export class OpenCodeEventPump<T extends OpenCodeSseEvent> {
  // One background reader calls stream.next(); waiters consume from queue.
}
```

Implementation details:

- The constructor starts one async `readLoop()`.
- `readLoop()` does `for await (const event of stream)` and pushes each event into `queue`.
- `nextMeaningful(sessionId, { softTimeoutMs, transportTimeoutMs })` loops over queued events until it finds non-keepalive, returns `soft-timeout` when no meaningful event appears before `softTimeoutMs`, and throws `OpenCodeTransportTimeoutError` only when no SSE event of any kind appears before `transportTimeoutMs`.
- Keepalive events update `lastEventType/lastEventAt` but not `lastMeaningfulEventType/lastMeaningfulEventAt`.
- No `Promise.race()` should wrap direct `stream.next()` outside the pump.
- `close()` calls `stream.return?.(undefined)` and resolves waiters.

In `opencode.ts`:

- Remove `event timeout` from `STALE_SESSION_RE`.
- Keep `nextOpenCodeEvent` and `nextMeaningfulOpenCodeEvent` only if needed for backward compatibility, but update tests to prefer `OpenCodeEventPump`. If they remain exported, make them throw `OpenCodeTransportTimeoutError` and do not classify them stale.
- Extend `SharedRuntime` with `pump: OpenCodeEventPump<...>` and close the pump in `destroySharedRuntime()`.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Remove dead timeout code paths that call `destroySharedRuntime()` for ordinary inactivity. Re-run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  container/agent-runner/src/providers/opencode-events.ts \
  container/agent-runner/src/providers/opencode-events.test.ts \
  container/agent-runner/src/providers/opencode-errors.ts
git commit -m "fix: make opencode inactivity non-stale"
```

## Task 2: Provider Notices, Native Question Interruptions, And Recovery Context

**Files:**
- Modify: `container/agent-runner/src/providers/types.ts`
- Modify: `container/agent-runner/src/providers/opencode.ts`
- Modify: `container/agent-runner/src/providers/opencode.test.ts`
- Modify: `container/agent-runner/src/db/session-state.ts`
- Modify: `container/agent-runner/src/db/session-state.test.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/poll-loop.test.ts`

- [ ] **Step 1: Write failing contract tests**

In `providers/types.ts`, plan for these event shapes:

```typescript
export type ProviderNoticeSeverity = 'info' | 'warn' | 'error';

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | {
      type: 'notice';
      severity: ProviderNoticeSeverity;
      message: string;
      classification: string;
      recoveryContext?: string;
      settleInitialBatch?: boolean;
    }
  | { type: 'activity' };
```

In `session-state.test.ts`, add tests:

```typescript
test('provider recovery notices append and consume in FIFO order', () => {
  appendProviderRecoveryNotice('opencode', {
    classification: 'opencode_native_question',
    message: 'OpenCode asked: What is Matt Van Horn email?',
    createdAt: '2026-05-24T21:46:00.000Z',
  });
  appendProviderRecoveryNotice('opencode', {
    classification: 'opencode_inactivity',
    message: 'No meaningful event for 300000ms',
    createdAt: '2026-05-24T21:51:00.000Z',
  });

  expect(consumeProviderRecoveryNotices('opencode').map((n) => n.classification)).toEqual([
    'opencode_native_question',
    'opencode_inactivity',
  ]);
  expect(consumeProviderRecoveryNotices('opencode')).toEqual([]);
});

test('provider recovery notices are isolated by provider', () => {
  appendProviderRecoveryNotice('opencode', {
    classification: 'opencode_inactivity',
    message: 'opencode note',
    createdAt: '2026-05-24T21:51:00.000Z',
  });
  expect(consumeProviderRecoveryNotices('claude')).toEqual([]);
  expect(consumeProviderRecoveryNotices('opencode')).toHaveLength(1);
});
```

In `poll-loop.test.ts`, add a test that a provider notice is sent to the user, stores context, and does not clear continuation:

```typescript
it('sends recoverable provider notices without clearing continuation', async () => {
  insertMessage(
    'fruma-draft',
    'chat',
    { sender: 'DanS', text: 'Actually create a draft in my gmail' },
    { platformId: 'chan-fruma', channelType: 'discord', threadId: 'thread-fruma' },
  );

  const provider = new ScriptedProvider(async function* () {
    yield { type: 'init', continuation: 'ses-fruma' };
    yield {
      type: 'notice',
      severity: 'warn',
      classification: 'opencode_native_question',
      message: 'I need Matt Van Horn email address before I can continue.',
      recoveryContext: 'OpenCode native question was blocked: What is Matt Van Horn email address?',
      settleInitialBatch: true,
    };
  });
  const controller = new AbortController();
  const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

  await waitFor(() => getAckStatus('fruma-draft') === 'completed', 1500);
  controller.abort();
  await loopPromise.catch(() => {});

  const out = getUndeliveredMessages();
  expect(out).toHaveLength(1);
  expect(JSON.parse(out[0].content).text).toContain('Matt Van Horn');
  expect(JSON.parse(out[0].content).text).not.toContain('OpenCode event timeout');
  expect(getContinuation('test')).toBe('ses-fruma');
  expect(consumeProviderRecoveryNotices('test')[0].message).toContain('OpenCode native question was blocked');
});
```

Also add a second poll-loop test where a stored recovery notice is consumed into the next provider prompt and then deleted.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/db/session-state.test.ts src/poll-loop.test.ts
```

Expected: FAIL because notice APIs and poll-loop behavior do not exist.

- [ ] **Step 3: Implement session recovery notices**

In `session-state.ts`:

```typescript
export interface ProviderRecoveryNotice {
  classification: string;
  message: string;
  createdAt: string;
}

function recoveryNoticeKey(providerName: string): string {
  return `recovery-notices:${providerName.toLowerCase()}`;
}
```

Implement:

- `appendProviderRecoveryNotice(providerName, notice)` reads existing JSON array, appends, truncates to the most recent 10 notices, writes through `setValue`.
- `consumeProviderRecoveryNotices(providerName)` reads, parses defensively, deletes the key, and returns `ProviderRecoveryNotice[]`.
- Malformed JSON returns `[]` and deletes the bad key.

- [ ] **Step 4: Implement poll-loop notice handling**

In `poll-loop.ts`:

- Import `appendProviderRecoveryNotice` and `consumeProviderRecoveryNotices`.
- Before formatting the initial prompt for a batch, consume notices for `config.providerName`.
- Add a helper:

```typescript
function prependRecoveryNotices(prompt: string, notices: ProviderRecoveryNotice[]): string {
  if (notices.length === 0) return prompt;
  const lines = notices.map((notice) => `- ${notice.createdAt} ${notice.classification}: ${notice.message}`);
  return `<system>\nPrevious recoverable provider events:\n${lines.join('\n')}\nUse this context to explain/resume without losing the thread.\n</system>\n\n${prompt}`;
}
```

- Pass the augmented prompt into `provider.query`.
- In `processQuery()`, extend `handleEvent` path:
  - `notice`: write a chat `messages_out` row to the current routing target, with `in_reply_to: routing.inReplyTo`.
  - If `event.recoveryContext`, call `appendProviderRecoveryNotice(providerName, { classification, message: recoveryContext, createdAt: new Date().toISOString() })`.
  - If `event.settleInitialBatch`, call `settleInitialBatch()`.
- Do not treat notice events as provider throws.

Use a user-facing message like:

```text
I stopped receiving useful progress from OpenCode, but I kept the Yente session state. Reply with any extra context or ask me to continue.
```

For native question:

```text
OpenCode tried to ask a question through its native prompt, which Yente cannot answer from Discord. I kept the session state. Reply with the answer and I will continue.
```

- [ ] **Step 5: Implement OpenCode provider notices**

In `opencode.ts`:

- Add env defaults:
  - `OPENCODE_INACTIVITY_NOTICE_MS`, default `300_000`
  - `OPENCODE_TRANSPORT_TIMEOUT_MS`, default `900_000`
  - `OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS`, default `21_600_000`
- On `OpenCodeEventPump.nextMeaningful(...).kind === 'soft-timeout'`:
  - Yield `{ type: 'activity' }`.
  - Yield one visible `notice` per inactivity interval with classification `opencode_inactivity`.
  - Continue the same turn; do not clear `activeSessionId`; do not destroy the runtime.
- On `OpenCodeTransportTimeoutError`:
  - Yield a `notice` with classification `opencode_transport_timeout`, `settleInitialBatch: true`, and recovery context.
  - Keep `activeSessionId` and continuation.
  - Destroy the shared runtime only for transport death, not for meaningful-event inactivity.
- On a native question tool:
  - Detect in `message.part.updated`; prefer `ev.properties.sessionID` when present, but do not require `part.sessionID` because OpenCode tool parts may only carry a message/part id:

```typescript
const part = ev.properties.part as
  | { type?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } }
  | undefined;
const eventSessionId = (ev.properties as { sessionID?: string }).sessionID;
if (eventSessionId && eventSessionId !== sessionId) break;
if (part?.type === 'tool' && part.tool === 'question') {
  const status = part.state?.status;
  if (status === 'pending' || status === 'running') {
    const questionText = extractNativeQuestionText(part.state.input);
    yield {
      type: 'notice',
      severity: 'warn',
      classification: 'opencode_native_question',
      message: questionText
        ? `OpenCode tried to ask: ${questionText}\n\nReply with the answer and I will continue.`
        : 'OpenCode tried to ask a native question. Reply with the answer and I will continue.',
      recoveryContext: questionText
        ? `OpenCode native question was blocked: ${questionText}`
        : 'OpenCode native question was blocked.',
      settleInitialBatch: true,
    };
    return;
  }
}
```

Do not wait five minutes for a native question to become an inactivity timeout.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/providers/opencode.test.ts src/db/session-state.test.ts src/poll-loop.test.ts
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/providers/types.ts \
  container/agent-runner/src/providers/opencode.ts \
  container/agent-runner/src/providers/opencode.test.ts \
  container/agent-runner/src/db/session-state.ts \
  container/agent-runner/src/db/session-state.test.ts \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: surface recoverable provider interruptions"
```

## Task 3: Exact Incident Replay Tests

**Files:**
- Create: `container/agent-runner/src/incident-replay.test.ts`
- Modify as needed: `container/agent-runner/src/poll-loop.test.ts` test helpers, if helpers should be shared.

- [ ] **Step 1: Write failing replay tests**

Add `incident-replay.test.ts` that uses the same in-memory session DB style as `poll-loop.test.ts`.

Test 1: Dvora 5/19 long work replay.

- Insert a prior outbound message exactly:

```text
Found the 5/19 recording on Drive (2.56 GB). Last summary is 5/12, so 5/19 is the next one. Downloading now.
```

- Insert the exact user follow-up:

```text
Great. Now do the 5/19 summary.
```

- Use a scripted provider that yields:
  - `init` with `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`
  - a soft inactivity `notice` with classification `opencode_inactivity`
  - `activity`
  - final `result`: `5/19 summary complete`

Assertions:

- The initial user row completes.
- No outbound message contains `Error: OpenCode event timeout`.
- `continuation:opencode` remains `ses_1a1e72ac7ffe3Ek8fJOiz1Y0lT`.
- The final user-visible output contains `5/19 summary complete`.
- The inactivity notice is visible if no other user-visible output has appeared since the inbound request.

Test 2: Fruma Gmail draft native question replay.

- Insert exact user prompt:

```text
Actually create a draft in my gmail
```

- First scripted provider call yields:
  - `init` with `ses_1a47da93effeJdpKh0oiDUOP2Q`
  - `notice` classification `opencode_native_question`, message containing `Matt Van Horn`, `settleInitialBatch: true`, and recovery context.
- Inject follow-up user answer:

```text
Matt Van Horn's email is matt@example.com.
```

- Second scripted provider call asserts:
  - `input.continuation` is still `ses_1a47da93effeJdpKh0oiDUOP2Q`.
  - `input.prompt` contains `OpenCode native question was blocked`.
  - `input.prompt` contains `Matt Van Horn's email is matt@example.com`.
  - It yields `result`: `Draft created in Gmail.`

Assertions:

- No raw OpenCode timeout error.
- Two user rows are completed.
- Final output contains `Draft created in Gmail.`

- [ ] **Step 2: Run the replay tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/incident-replay.test.ts
```

Expected: FAIL until Task 2 behavior is wired correctly.

- [ ] **Step 3: Implement any missing shared test helpers**

If `poll-loop.test.ts` helpers are duplicated, keep duplication small. Do not move broad test harness code unless it simplifies both files materially.

- [ ] **Step 4: Run replay tests green**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 120s bun test src/incident-replay.test.ts src/poll-loop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add container/agent-runner/src/incident-replay.test.ts container/agent-runner/src/poll-loop.test.ts
git commit -m "test: replay yente opencode timeout incidents"
```

## Task 4: Optional Agent MCP Bridge Degradation

**Files:**
- Modify: `src/agent-mcp-config.ts`
- Modify: `src/agent-mcp-config.test.ts`
- Modify: `src/container-config.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `src/claude-md-compose.ts`
- Create: `src/claude-md-compose.test.ts`

- [ ] **Step 1: Write failing tests**

In `agent-mcp-config.test.ts`, add:

```typescript
it('defaults host-managed MCP bridges to optional', () => {
  // Config omits required.
  // Expect loaded bridge.required toBe(false).
});

it('preserves required true for fail-closed bridges', () => {
  // Config sets required: true.
  // Expect loaded bridge.required toBe(true).
});
```

In `container-runner.test.ts`, add:

```typescript
it('starts the container when an optional agent MCP bridge is unavailable', async () => {
  const harness = await loadContainerRunnerHarness({
    mcpConfigForGroup: () => ({
      allowedTools: ['mcp__granola__*'],
      bridges: {
        granola: {
          type: 'mcp-remote-unix-socket',
          remoteUrl: 'https://mcp.granola.ai/mcp',
          callbackPort: 37947,
          socketNamePrefix: 'granola',
          required: false,
        },
      },
    }),
  });
  harness.startAgentMcpBridgeMock.mockRejectedValueOnce(
    new Error('Granola MCP auth required; run the workstation login helper before using this bridge'),
  );
  try {
    const wake = harness.containerRunner.wakeContainer(harness.session);
    await harness.oneCliStarted.promise;
    harness.oneCliRelease.resolve();
    await wake;

    expect(harness.spawnMock).toHaveBeenCalled();
    const containerJson = JSON.parse(fs.readFileSync(path.join(harness.groupsDir, 'agent', 'container.json'), 'utf8'));
    expect(containerJson.mcpServers.granola).toBeUndefined();
    expect(containerJson.agentMcpAllowedTools).toEqual([]);
    expect(containerJson.agentMcpUnavailable.granola.reason).toContain('Granola MCP auth required');
  } finally {
    harness.close();
  }
});

it('still fails closed when a required agent MCP bridge is unavailable', async () => {
  // Same setup but required: true.
  // Expect wakeContainer rejects or completes without spawn, matching existing error path.
});
```

In `claude-md-compose` tests, assert a `container.json` with `agentMcpUnavailable.granola` produces `.claude-fragments/mcp-unavailable-granola.md` containing `mcp__granola__` and `unavailable`.

- [ ] **Step 2: Run tests red**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
```

Expected: FAIL because `required`, `agentMcpUnavailable`, and degradation behavior do not exist.

- [ ] **Step 3: Implement bridge config and runtime degradation**

In `agent-mcp-config.ts`:

- Add `required?: boolean` to `AgentMcpBridgeConfig`.
- Parse as `required: bridge.required === true`.
- Keep `validateMergedConfig()` requiring `allowedTools` to match configured bridges. Runtime will filter active tools.

In `container-config.ts`:

```typescript
agentMcpUnavailable?: Record<string, { reason: string; updatedAt: string }>;
```

Default to `{}` in `readContainerConfig`.

In `container-runner.ts`:

- In `attachAgentMcpBridges`, catch each bridge startup independently.
- If `bridgeConfig.required === true`, stop already-started bridges and throw.
- If optional, log a structured warning:

```typescript
log.warn('Optional agent MCP bridge unavailable', {
  groupFolder: agentGroup.folder,
  serverName,
  err: err instanceof Error ? err.message : String(err),
});
```

- Continue startup with no mount for the failed bridge.
- Call `syncAgentMcpRuntimeConfig()` with started bridges and unavailable bridge map.
- Filter `agentMcpAllowedTools` to `mcp__${startedBridge.serverName}__*`.
- Remove stale unavailable entries for bridges that started successfully.
- After `attachAgentMcpBridges(...)`, call `composeGroupClaudeMd(agentGroup)` again so unavailable fragments and active MCP instructions are present before mount use.

In `claude-md-compose.ts`, for each `agentMcpUnavailable` entry, add inline fragment:

```markdown
## Unavailable MCP bridge: granola

The `granola` MCP bridge is unavailable for this container run: <reason>

Do not call `mcp__granola__*` tools. If the user asks for Granola-backed work, say Granola is currently unavailable and continue with any non-Granola work you can do.
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 120s pnpm exec vitest run src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
timeout 120s pnpm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add src/agent-mcp-config.ts src/agent-mcp-config.test.ts \
  src/container-config.ts src/container-runner.ts src/container-runner.test.ts \
  src/claude-md-compose.ts src/claude-md-compose.test.ts
git commit -m "fix: degrade optional agent mcp bridges"
```

## Task 5: GWS Proxy Help/Probe Audit Logging

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

- [ ] **Step 2: Write failing audit tests**

In `proxy_test.go`, add a helper that captures slog JSON:

```go
func testProxyHandlerWithLogBuffer(t *testing.T, buf io.Writer) (*ProxyHandler, string) {
	t.Helper()
	h, token := testProxyHandler(t)
	h.logger = slog.New(slog.NewJSONHandler(buf, nil))
	return h, token
}
```

Add test:

```go
func TestProxy_HelpInvocationAuditIsNonAPI(t *testing.T) {
	var logs bytes.Buffer
	h, token := testProxyHandlerWithLogBuffer(t, &logs)
	srv := httptest.NewServer(h)
	defer srv.Close()

	payload := ExecRequest{Args: []string{"gmail", "users", "drafts", "create", "--help"}}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", srv.URL+"/exec", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, string(respBody))
	}

	raw := logs.String()
	if !strings.Contains(raw, `"request_class":"help"`) {
		t.Fatalf("expected help request_class in logs, got: %s", raw)
	}
	if !strings.Contains(raw, `"api_effect":false`) {
		t.Fatalf("expected api_effect=false in logs, got: %s", raw)
	}
	if strings.Contains(raw, `"msg":"executed"`) && strings.Contains(raw, `"api_effect":true`) {
		t.Fatalf("help invocation was logged as API execution: %s", raw)
	}
}
```

- [ ] **Step 3: Run tests red**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: FAIL because help requests are still logged as normal `request`/`executed` API activity.

- [ ] **Step 4: Implement invocation classification**

In `proxy.go`, add:

```go
type InvocationClass string

const (
	InvocationAPI        InvocationClass = "api"
	InvocationHelp       InvocationClass = "help"
	InvocationLocalProbe InvocationClass = "local_probe"
)

func classifyInvocation(args []string) InvocationClass {
	for _, arg := range args {
		switch arg {
		case "--help", "-h", "help":
			return InvocationHelp
		case "--version", "version", "auth":
			return InvocationLocalProbe
		}
	}
	return InvocationAPI
}
```

Adjust if `auth status` should remain an allowed local probe only when the full args are `auth status`.

In `handleExec()`:

- Compute `requestClass := classifyInvocation(req.Args)` after parsing request and before audit logging.
- Add `request_class` and `api_effect` to both `request` and completion logs.
- For help/probe requests:
  - Keep authentication.
  - Keep command execution through `ExecGWS` so the CLI returns real help/status.
  - Skip policy mutation semantics that would frame it as a Gmail method if the command is help/probe-only.
  - Log completion as `local_cli_executed` instead of `executed`, or keep `executed` only with `api_effect=false`; tests should make the distinction explicit.
- Do not inject signatures for help/probe commands.
- Do not apply send/calendar rate limits to help/probe commands.

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
git commit -m "fix: classify gws help audit logs"
```

## Task 6: Documentation And Operator Semantics

**Files:**
- Modify: `docs/agent-runner-details.md`

- [ ] **Step 1: Update docs**

Update the provider event contract in `docs/agent-runner-details.md`:

- Add `notice` event semantics.
- State that OpenCode inactivity notices are recoverable and do not clear continuation.
- State that OpenCode native `question` is interrupted because NanoClaw uses messages/MCP for user interaction.
- State that `error` is reserved for unexpected failures.

- [ ] **Step 2: Verify docs references**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "OpenCode event timeout|event timeout|ProviderEvent|progress|notice|agentMcpUnavailable" docs container src
```

Expected:

- No docs claim `event timeout` is stale-session behavior.
- `ProviderEvent` docs include `notice`.

- [ ] **Step 3: Commit docs**

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add docs/agent-runner-details.md
git commit -m "docs: document recoverable provider notices"
```

## Task 7: Full Verification

**Files:**
- No new source files unless verification exposes a real defect.

- [ ] **Step 1: Run container runner unit and replay coverage**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening/container/agent-runner
timeout 180s bun test src/providers/opencode.test.ts src/providers/opencode-events.test.ts src/db/session-state.test.ts src/poll-loop.test.ts src/incident-replay.test.ts
timeout 180s bun test
timeout 120s bun run typecheck
```

Expected: all PASS.

- [ ] **Step 2: Run NanoClaw host tests**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
timeout 180s pnpm exec vitest run src/agent-mcp-config.test.ts src/container-runner.test.ts src/claude-md-compose.test.ts
timeout 300s pnpm test
timeout 120s pnpm run typecheck
```

Expected: all PASS.

- [ ] **Step 3: Run GWS proxy tests**

Run:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
timeout 120s go test ./...
```

Expected: PASS.

- [ ] **Step 4: Static guard against stale timeout behavior**

Run:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
rg -n "event timeout|OpenCode event timeout|destroySharedRuntime\\(|clearContinuation\\(|isSessionInvalid" container/agent-runner/src src docs
```

Expected:

- Any remaining `OpenCode event timeout` string is in tests for "not leaked" or historical wording only.
- No OpenCode inactivity path calls `clearContinuation`.
- `destroySharedRuntime()` is used for abort, stream end, startup/runtime death, or transport timeout only.

- [ ] **Step 5: Commit any verification fixes**

If verification required code changes:

```bash
cd /home/dan/code/nanoclaw/.worktrees/yente-opencode-timeout-hardening
git add <changed-files>
git commit -m "fix: address hardening verification findings"
```

If GWS verification required changes:

```bash
cd /home/dan/code/gws-skill/.worktrees/yente-timeout-audit-hardening
git add <changed-files>
git commit -m "fix: address gws audit verification findings"
```

## Final Completion Criteria

The implementation is complete only when all of these are true:

- Dvora replay with the 5/19 Drive recording wording produces no raw timeout error and ultimately delivers a summary result.
- Fruma replay with `Actually create a draft in my gmail` handles the native question path without waiting five minutes, preserves continuation, accepts the follow-up answer, and ultimately creates the draft in the replay test.
- `OpenCode event timeout (...)` is not classified stale and does not clear continuation.
- Soft OpenCode inactivity yields a structured visible notice and keeps waiting on the same session.
- Heartbeat-only OpenCode streams do not cause the host to kill an otherwise alive long-running turn.
- Native OpenCode `question` tool activity is detected directly and converted into a recoverable interruption.
- Optional Granola MCP auth failure does not block container spawn; required bridge failure still fails closed.
- GWS help/probe commands are logged with `api_effect=false` and cannot look like successful Gmail draft creation.
- NanoClaw and GWS changes are committed in their respective repos.
