/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderInputScope,
  ProviderOptions,
  QueryInput,
  QueryTurnInput,
} from './types.js';
import { normalizeQueryTurnInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  interruptCodexTurn,
  killCodexAppServer,
  sendCodexRequest,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  waitForCodexCompactionComplete,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

import { CodexTurnTimers, codexTimingConfigFromEnv, type CodexTimingClock } from './codex-turn-timing.js';
import { buildInactivityNotice, dedupeCodexSideEffect, codexCapabilities, codexThreadSandbox } from './codex-parity.js';
import { categorizeMessage } from '../formatter.js';
import type { MessageInRow } from '../db/messages-in.js';

/** Real wall clock; tests inject a fake one via runOneTurn's deps. */
const REAL_CLOCK: CodexTimingClock = { now: () => Date.now() };
const NANOCLAW_SKILLS_ROOT = '/app/skills';
/** @internal exported for unit tests */
export const COMPACT_COMMAND_TEXT = '/compact';
const COMPACT_REQUEST_TIMEOUT_MS = 30_000;
const COMPACT_NOTIFICATION_TIMEOUT_MS = 60_000;
/** @internal exported for unit tests */
export const COMPACT_RESULT_TEXT = 'Context compacted.';

export interface CodexAbortSignal {
  isAborted(): boolean;
  onAbort(handler: () => void): () => void;
}

const CODEX_NANOCLAW_BRIDGE_INSTRUCTIONS = [
  '## NanoClaw Codex bridge',
  '',
  'NanoClaw-managed skills are deployed under `/app/skills` and linked into your Codex skill root before each turn. Treat those as first-class available skills. If asked to list available skills, include the NanoClaw skill names.',
  '',
  'Trailing run identifiers such as `Smoke run id: ...` are diagnostic metadata from test harnesses. Do not treat them as remembered conversation facts, passwords, or requested answer values unless the message explicitly says that exact run id is the value to use.',
].join('\n');

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't expand Claude Code's `@-import` syntax in
// CLAUDE.md, and doesn't auto-load CLAUDE.local.md from the working dir the
// way Claude Code does. Left alone, the agent sees only the raw import
// directives as literal text and none of the composed content — no shared
// CLAUDE.md, no module fragments, no per-group memory. We resolve both here
// so Codex (and any other non-Claude provider) gets the same effective
// system prompt the Claude provider gets natively.

/**
 * Inline `@<path>` import directives (line-anchored) with the contents of
 * the referenced file, resolved relative to `baseDir`. Recurses so imports
 * within imported files expand too. Cycles and missing files are silently
 * dropped (replaced with empty text) rather than left as raw `@path` lines,
 * which would confuse the model.
 */
export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentAndGlobalClaudeMd(): string | undefined {
  // Per-group CLAUDE.md is responsible for pulling in the global instructions
  // if the group wants them (the default scaffold starts with
  // `@./.claude-global.md` which resolveClaudeImports inlines). Appending
  // `/workspace/global/CLAUDE.md` explicitly here would double-inline the
  // global content for any non-main group, wasting context tokens and
  // risking contradictory instructions. Groups that don't import global
  // intentionally don't get it — same as Claude-backed agents.
  const groupDir = '/workspace/agent';
  const groupPath = `${groupDir}/CLAUDE.md`;
  const localPath = `${groupDir}/CLAUDE.local.md`;
  const parts: string[] = [];

  if (fs.existsSync(groupPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(groupPath, 'utf-8'), groupDir));
  }
  if (fs.existsSync(localPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(localPath, 'utf-8'), groupDir));
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function codexSkillsDir(): string {
  return path.join(process.env.HOME || '/home/node', '.codex', 'skills');
}

/** @internal exported for unit tests */
export function isCompactCommand(messages: MessageInRow[] | undefined): boolean {
  if (!messages || messages.length !== 1) return false;
  const [msg] = messages;
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const info = categorizeMessage(msg);
  return (
    info.command === COMPACT_COMMAND_TEXT &&
    info.text.trim().toLowerCase() === COMPACT_COMMAND_TEXT
  );
}

/** @internal exported for unit tests */
export function buildCompactResultText(destinationName: string | undefined): string {
  const reply = COMPACT_RESULT_TEXT;
  if (!destinationName) return reply;
  return `<message to="${destinationName}">${reply}</message>`;
}

function logStructured(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ severity: 'info', event, ...fields }));
}

function warnStructured(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ severity: 'warn', event, ...fields }));
}

function isManagedSkillTarget(target: string, skillsRoot: string): boolean {
  return target === skillsRoot || target.startsWith(`${skillsRoot}/`);
}

function listNanoclawSkillNames(skillsRoot = NANOCLAW_SKILLS_ROOT): string[] {
  try {
    if (!fs.existsSync(skillsRoot)) return [];
    return fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name.startsWith('.') || entry.name === '.bin' || entry.name === 'skill-runtime-manifest.json') {
          return false;
        }
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
        return fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md'));
      })
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    warnStructured('codex_nanoclaw_skill_list_failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export function syncCodexManagedSkillLinks(
  skillsRoot = NANOCLAW_SKILLS_ROOT,
  destinationDir = codexSkillsDir(),
): string[] {
  const names = listNanoclawSkillNames(skillsRoot);
  if (names.length === 0) return [];

  fs.mkdirSync(destinationDir, { recursive: true });
  const desired = new Map(names.map((name) => [name, path.join(skillsRoot, name)]));
  const linked: string[] = [];

  for (const entry of fs.readdirSync(destinationDir, { withFileTypes: true })) {
    const dest = path.join(destinationDir, entry.name);
    let linkTarget: string | undefined;
    try {
      if (entry.isSymbolicLink()) linkTarget = fs.readlinkSync(dest);
    } catch (err) {
      warnStructured('codex_nanoclaw_skill_link_read_failed', {
        skill: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (linkTarget && isManagedSkillTarget(linkTarget, skillsRoot) && desired.get(entry.name) !== linkTarget) {
      fs.unlinkSync(dest);
    }
  }

  for (const [name, target] of desired) {
    const dest = path.join(destinationDir, name);
    try {
      const existing = fs.lstatSync(dest);
      if (existing.isSymbolicLink()) {
        const current = fs.readlinkSync(dest);
        if (current === target) {
          linked.push(name);
          continue;
        }
        if (isManagedSkillTarget(current, skillsRoot)) {
          fs.unlinkSync(dest);
        } else {
          warnStructured('codex_nanoclaw_skill_link_conflict', { skill: name, existingTarget: current });
          continue;
        }
      } else {
        warnStructured('codex_nanoclaw_skill_link_conflict', { skill: name, existingType: 'non_symlink' });
        continue;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        warnStructured('codex_nanoclaw_skill_link_stat_failed', {
          skill: name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    try {
      fs.symlinkSync(target, dest, 'dir');
      linked.push(name);
    } catch (err) {
      warnStructured('codex_nanoclaw_skill_link_create_failed', {
        skill: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logStructured('codex_nanoclaw_skill_links_synced', { count: linked.length });
  return linked;
}

export function buildNanoclawSkillInventoryInstructions(skillsRoot = NANOCLAW_SKILLS_ROOT): string | undefined {
  const names = listNanoclawSkillNames(skillsRoot);
  if (names.length === 0) return undefined;
  return [
    '## NanoClaw deployed skill inventory',
    '',
    `Available NanoClaw skills: ${names.join(', ')}`,
  ].join('\n');
}

function composeBaseInstructions(promptAddendum: string | undefined): string | undefined {
  const claudeMd = readAgentAndGlobalClaudeMd();
  const pieces = [
    claudeMd,
    CODEX_NANOCLAW_BRIDGE_INSTRUCTIONS,
    buildNanoclawSkillInventoryInstructions(),
    promptAddendum,
  ].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  get capabilities() {
    return codexCapabilities();
  }

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    // Yente default. Per-group override via CODEX_MODEL in the runtime env
    // supplied by the host-side provider config.
    this.model = (options.env?.CODEX_MODEL as string | undefined) ?? 'gpt-5.5';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    // Mirrors OpenCode (opencode-container.ts): `pending` holds turn INPUTS, not
    // bare prompt strings, so each turn carries its `inputId` for the poll-loop's
    // input-correlation contract (input-accepted / result.resolvedInputIds). A
    // follow-up `push({ prompt, inputId })` therefore queues the object intact
    // instead of being coerced to `[object Object]`.
    const pending: QueryTurnInput[] = [];
    const abortHandlers = new Set<() => void>();
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const abortSignal: CodexAbortSignal = {
      isAborted: () => aborted,
      onAbort: (handler) => {
        abortHandlers.add(handler);
        if (aborted) handler();
        return () => {
          abortHandlers.delete(handler);
        };
      },
    };
    const kick = (): void => {
      waiting?.();
    };

    pending.push({
      prompt: input.prompt,
      inputId: input.inputId,
      messages: input.messages,
      visibleDestinationName: input.visibleDestinationName,
    });

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      syncCodexManagedSkillLinks();
      writeCodexMcpConfigToml(self.mcpServers);
      const server = spawnCodexAppServer(createCodexConfigOverrides());
      // Relay turns run read-only (codexThreadSandbox(relay)); auto-approval is
      // made relay-aware so a relay can't bypass that boundary by side-effecting
      // through an approval prompt.
      const relay = input.relayMode === true;
      attachCodexAutoApproval(server, { relay });

      let threadId: string | undefined = input.continuation;
      let initYielded = false;
      let turnIndex = 0;
      let visibleDestinationName: string | undefined = input.visibleDestinationName;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          model: self.model,
          cwd: input.cwd,
          // Relay turns narrate status only — pin the sandbox read-only so a
          // relay can never mutate the workspace even if the model tries.
          sandbox: codexThreadSandbox(relay),
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions),
        };

        threadId = await startOrResumeCodexThread(server, threadId, threadParams);

        // Emit the continuation as soon as we have a live thread. Compact turns
        // bypass runOneTurn, so we must yield init here to match the path that
        // normally yields it before turn/start.
        if (threadId && !initYielded) {
          initYielded = true;
          yield { type: 'init', continuation: threadId };
        }

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const turn = pending.shift()!;
          const text = turn.prompt;
          const turnInputId = turn.inputId;
          if (turn.visibleDestinationName) {
            visibleDestinationName = turn.visibleDestinationName;
          }

          // The turn is now committed — emit input-accepted once so the poll-loop
          // can correlate this input (mirrors opencode-container.ts:877-881). Scope
          // mirrors OpenCode: relay turns are 'relay'; the first normal turn is
          // 'initial'; subsequent normal turns are 'followup'.
          const scope: ProviderInputScope = relay ? 'relay' : turnIndex === 0 ? 'initial' : 'followup';
          turnIndex += 1;

          if (turnInputId) {
            yield { type: 'input-accepted', inputId: turnInputId, scope };
          }

          // Intercept the admin slash command `/compact` for non-Claude providers.
          // Codex exposes native context compaction via `thread/compact/start`, so we
          // call that instead of treating the command as a normal model prompt.
          // If the call fails we gracefully fall through to a normal turn so the
          // user still gets *some* response rather than a silent drop.
          if (scope !== 'relay' && isCompactCommand(turn.messages)) {
            let compactFulfilled = false;
            try {
              yield* compactCodexThread(server, threadId!, turnInputId, visibleDestinationName, REAL_CLOCK);
              compactFulfilled = true;
            } catch (err) {
              warnStructured('codex_compact_failed', {
                threadId,
                inputId: turnInputId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            if (compactFulfilled) continue;
          }

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          const terminal = yield* runOneTurn(
            server,
            threadId!,
            text,
            self.model,
            input.cwd,
            turnInputId,
            () => initYielded,
            () => {
              initYielded = true;
            },
            { abortSignal },
          );
          // A terminal interruption (timeout / turn failure) ENDS the whole
          // query stream — mirrors opencode-container.ts:1238-1240. Without this
          // the outer loop would block waiting for more input, `query.events`
          // would never close, and the poll-loop could never finalize recovery
          // (codex would hang after a timeout). A normal turn returns false and
          // the loop continues to drain the next pending input.
          if (terminal) return;
        }
      } finally {
        killCodexAppServer(server);
      }
    }

    return {
      push: (message: string | QueryTurnInput) => {
        // Mirror OpenCode (opencode-container.ts:1265): normalize so a
        // `{ prompt, inputId }` object is queued intact (preserving its
        // inputId) instead of being coerced to a string.
        pending.push(normalizeQueryTurnInput(message));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        if (aborted) return;
        aborted = true;
        for (const handler of [...abortHandlers]) handler();
        kick();
      },
      events: gen(),
    };
  }
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

export async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string,
  cwd: string,
  turnInputId: string | undefined,
  hasInit: () => boolean,
  markInit: () => void,
  deps: {
    clock?: CodexTimingClock;
    setTimer?: (ms: number, cb: () => void) => ReturnType<typeof setTimeout>;
    startTurn?: typeof startCodexTurn;
    interruptTurn?: typeof interruptCodexTurn;
    abortSignal?: CodexAbortSignal;
  } = {},
): AsyncGenerator<ProviderEvent, boolean> {
  const runDeps = {
    clock: deps.clock ?? REAL_CLOCK,
    setTimer: deps.setTimer ?? ((ms: number, cb: () => void) => setTimeout(cb, ms)),
    startTurn: deps.startTurn ?? startCodexTurn,
    interruptTurn: deps.interruptTurn ?? interruptCodexTurn,
    abortSignal: deps.abortSignal,
  };
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnErrorText: string | null = null;
  let turnDone = false;
  let turnInterrupted = false;
  let activeTurnId: string | undefined;
  let abortRequested = runDeps.abortSignal?.isAborted() ?? false;
  let interruptRequested = false;

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  const timers = new CodexTurnTimers(runDeps.clock, codexTimingConfigFromEnv());
  let terminalTimeout: 'transport' | 'absolute' | null = null;
  let liveness: import('./codex-turn-timing.js').CodexLiveness | null = null;
  let wakeHandle: ReturnType<typeof setTimeout> | null = null;
  // Side-effect collection lives here (B3) so the terminal interruption's
  // recoverySeed spread below typechecks standalone; Task B4 wires the emission
  // that fills it. Declared once — B4 must NOT re-declare.
  const collectedSideEffects: import('./types.js').ProviderSideEffect[] = [];
  const emittedSideEffectIds = new Set<string>();
  // The per-turn inputId from the poll-loop, used by buildInactivityNotice / the
  // terminal interruption / dedupeCodexSideEffect so those carry the REAL input
  // correlation id (F1). Undefined only when the caller has no inputId; ?? '' is
  // safe for the message builders.
  const inputId: string | undefined = turnInputId;
  const requestInterrupt = (): void => {
    if (!abortRequested || interruptRequested || !activeTurnId || turnDone) return;
    const turnId = activeTurnId;
    interruptRequested = true;
    void runDeps.interruptTurn(server, { threadId, turnId }).catch((err) => {
      warnStructured('codex_turn_interrupt_failed', {
        threadId,
        turnId,
        inputId,
        error: err instanceof Error ? err.message : String(err),
      });
      turnState.error = err instanceof Error ? err : new Error(String(err));
      turnDone = true;
      kick();
    });
  };
  const unsubscribeAbort = runDeps.abortSignal?.onAbort(() => {
    abortRequested = true;
    requestInterrupt();
  });
  const armWake = (): void => {
    // Never (re-)arm once the turn is terminal: a wedged app-server would keep
    // re-polling transport-timeout and re-arming forever (an infinite timeout
    // loop). After a terminal decision the turn is done and drains via kick().
    if (terminalTimeout || turnDone) return;
    if (wakeHandle) clearTimeout(wakeHandle);
    wakeHandle = runDeps.setTimer(timers.nextWakeMs(), onWake);
  };
  function onWake(): void {
    const d = timers.poll();
    if (d.kind === 'transport-timeout' || d.kind === 'absolute-timeout') {
      terminalTimeout = d.kind === 'transport-timeout' ? 'transport' : 'absolute';
      liveness = d.liveness;
      turnState.error = new Error(`Turn ${terminalTimeout}-timeout after ${d.liveness.elapsedMs}ms`);
      turnDone = true;
      kick();
      return;   // terminal: do NOT re-arm (armWake would no-op anyway, but be explicit)
    }
    if (d.kind === 'inactivity-notice') {
      buffer.push(buildInactivityNotice(inputId ?? '', d.liveness));   // Behavior 1 (Task B4 enables consumption)
    }
    armWake();
    kick();
  }
  armWake();

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });
    const meaningful = method === 'item/agentMessage/delta' || method === 'item/completed' || method === 'turn/completed';
    timers.onActivity(method ?? 'activity', meaningful);
    armWake();

    // Thread scoping: codex subagent threads (multi_agent_v1 spawn_agent) share
    // this app-server connection, and their notifications carry THEIR threadId.
    // Without this guard a subagent's agentMessage pollutes resultText, the
    // first subagent's turn/completed ends the MAIN turn mid-wait (poll-loop
    // then fires the unwrapped-output nudge with the stolen token), and
    // turn/started clobbers activeTurnId (corrupting interrupt targeting).
    // Precedent: waitForCodexCompactionComplete in codex-app-server.ts.
    // The generic activity push above is intentionally NOT gated — subagent
    // work must still keep the idle timers alive.
    const tid = params.threadId as string | undefined;
    const foreignThread = Boolean(tid && tid !== threadId);

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'turn/started': {
        if (foreignThread) break;
        const turn = params.turn as { id?: string } | undefined;
        const turnId = turn?.id ?? (params.turnId as string | undefined);
        if (turnId) {
          activeTurnId = turnId;
          requestInterrupt();
        }
        break;
      }
      case 'item/agentMessage/delta': {
        if (foreignThread) break;
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'item/completed': {
        if (foreignThread) break;
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        const se = dedupeCodexSideEffect(item as { id?: string; type?: string }, inputId ?? '', Date.now(), emittedSideEffectIds);
        if (se) {
          collectedSideEffects.push(se);
          buffer.push({ type: 'side-effect', sideEffect: se });   // emitted to the poll loop
        }
        break;
      }
      case 'turn/completed': {
        if (foreignThread) break;
        const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
        const status = turn?.status ?? (params.status as string | undefined);
        if (status === 'interrupted') turnInterrupted = true;
        if (!abortRequested && turn?.error?.message) turnErrorText = turn.error.message;
        turnDone = true;
        break;
      }
      // NOTE: `turn/failed` is NOT part of the codex app-server v2 protocol
      // (verified against openai/codex@rust-v0.142.1 — the deployed pin; the
      // ServerNotification enum has no `turn/failed`). A terminal failure arrives
      // as an `error` notification (willRetry:false) plus `turn/completed` with
      // status:"failed" and turn.error.message — both handled below. Retained as a
      // defensive no-op in case a legacy/future server still fans it out.
      case 'turn/failed': {
        if (foreignThread) break;
        const e = params.error as { message?: string } | undefined;
        if (abortRequested) {
          turnInterrupted = true;
        } else {
          turnState.error = new Error(e?.message || 'Turn failed');
        }
        turnDone = true;
        break;
      }
      case 'error': {
        // Top-level error notification (ErrorNotification: { error, willRetry,
        // threadId, turnId }). Capture the provider's verbatim message so the poll
        // loop can surface it instead of the generic empty-reply fallback — but
        // ONLY for terminal errors. willRetry:true is a transient error Codex
        // auto-retries; showing it would surface an already-recovered failure.
        // Does not set turnDone/turnState.error — turn/completed still drives termination.
        if (!abortRequested && params.willRetry !== true) {
          const msg = (params.error as { message?: string } | undefined)?.message;
          if (msg) turnErrorText = msg;
        }
        break;
      }
      case 'thread/status/changed': {
        const status = params.status as string | undefined;
        if (status) buffer.push({ type: 'progress', message: `status: ${status}` });
        break;
      }
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    await runDeps.startTurn(server, { threadId, inputText, model, cwd });

    while (true) {
      while (buffer.length > 0) {
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    if (turnInterrupted) {
      yield {
        type: 'interruption',
        inputId: inputId ?? '',
        classification: 'codex_turn_interrupted',
        severity: 'info',
        terminal: true,
        agentMessage: 'The Codex turn was interrupted before completing.',
        fallbackUserMessage: 'The active Codex turn was interrupted before completing.',
        continuationPolicy: 'preserve',
        ...(collectedSideEffects.length > 0 ? { recoverySeed: { sideEffects: [...collectedSideEffects] } } : {}),
      };
      return true;
    }

    if (turnState.error) {
      const classification = terminalTimeout === 'transport' ? 'codex_transport_timeout'
        : terminalTimeout === 'absolute' ? 'codex_absolute_timeout'
        : 'codex_turn_failed';
      yield {
        type: 'interruption',
        inputId: inputId ?? '',
        classification,
        severity: 'error',
        terminal: true,
        agentMessage: terminalTimeout
          ? "I ran out of time on this turn before finishing."
          : 'The Codex turn failed before completing.',
        fallbackUserMessage: terminalTimeout
          ? "That took longer than I'm allowed for one turn. Please ask me to continue."
          : `The previous request failed (${turnState.error.message}). Please try again.`,
        continuationPolicy: 'preserve',
        ...(liveness ? { liveness } : {}),
        ...(collectedSideEffects.length > 0 ? { recoverySeed: { sideEffects: [...collectedSideEffects] } } : {}),
      };
      // Terminal: signal the caller to END the whole query stream (F2,
      // mirrors opencode-container.ts:1238-1240).
      return true;
    }

    // A successful turn resolves its input — carry inputId/resolvedInputIds so
    // the recovery system (patch 044) can mark it resolved (F1, mirrors
    // opencode-container.ts:1251-1256).
    yield {
      type: 'result',
      text: resultText || null,
      inputId: turnInputId,
      resolvedInputIds: turnInputId ? [turnInputId] : [],
      // Empty turn + provider reason (e.g. usage limit): carry it verbatim so the
      // poll loop surfaces it instead of the generic empty-reply fallback.
      ...(resultText ? {} : turnErrorText ? { errorText: turnErrorText } : {}),
    };
    // Non-terminal: the outer loop continues to drain the next pending input.
    return false;
  } finally {
    if (wakeHandle) clearTimeout(wakeHandle);
    unsubscribeAbort?.();
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

/** @internal exported for unit tests */
export async function* compactCodexThread(
  server: AppServer,
  threadId: string,
  inputId: string | undefined,
  destinationName: string | undefined,
  clock: CodexTimingClock,
): AsyncGenerator<ProviderEvent> {
  yield { type: 'activity' };
  const startedAt = clock.now();
  const resp = await sendCodexRequest(
    server,
    'thread/compact/start',
    { threadId },
    COMPACT_REQUEST_TIMEOUT_MS,
  );
  if (resp.error) {
    throw new Error(`thread/compact/start failed: ${resp.error.message}`);
  }

  const remainingNotificationMs = Math.max(
    0,
    COMPACT_NOTIFICATION_TIMEOUT_MS - (clock.now() - startedAt),
  );
  // Wait for the canonical v2 compaction signal. If it never arrives we throw
  // so the outer loop can fall back to a normal model turn instead of falsely
  // claiming the context was compacted.
  await waitForCodexCompactionComplete(server, threadId, remainingNotificationMs);

  const resultText = buildCompactResultText(destinationName);
  yield { type: 'progress', inputId, message: COMPACT_RESULT_TEXT };
  yield {
    type: 'result',
    text: resultText,
    inputId,
    resolvedInputIds: inputId ? [inputId] : [],
  };
}

registerProvider('codex', (opts) => new CodexProvider(opts));
