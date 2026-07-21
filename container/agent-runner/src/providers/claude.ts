import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import { normalizeQueryTurnInput, ProviderQuiescenceError } from './types.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderInputScope,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];
const CLAUDE_QUIESCENCE_TIMEOUT_MS = 30_000;

// Base tool allowlist for NanoClaw agent containers.
const BASE_TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

export function buildClaudeToolAllowlist(extraTools: string[] = []): string[] {
  return [...new Set([...BASE_TOOL_ALLOWLIST, ...extraTools])];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

interface QueuedSDKUserMessage {
  message: SDKUserMessage;
  inputId?: string;
  scope: ProviderInputScope;
  acceptInput: () => Promise<void>;
}

/**
 * Serializes accepted-input transitions against Claude tool execution. A new
 * batch cannot replace the host pointer until every tool admitted under the
 * prior acceptance has finished. PreToolUse obtains a shared tool lease only
 * after the current exact acceptance promise succeeds.
 */
class ClaudeExecutionBarrier {
  private currentAcceptance: Promise<void> | null = null;
  private activeTools = new Set<string>();
  private toolsDrainedWaiters: Array<() => void> = [];
  private transitionTail: Promise<void> = Promise.resolve();
  private transitionPending: Promise<void> | null = null;
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    // Do not wake drain waiters on cancellation. Only the matching PostToolUse
    // hook proves an admitted tool stopped executing.
  }

  transition(acceptInput: () => Promise<void>): Promise<void> {
    let publishTransitionComplete!: () => void;
    const transitionIntent = new Promise<void>((resolve) => {
      publishTransitionComplete = resolve;
    });
    // Publish intent synchronously so no PreToolUse can acquire the old
    // generation between prompt consumption and the serialized transition.
    this.transitionPending = transitionIntent;
    const transition = this.transitionTail.then(async () => {
      if (this.cancelled) throw new Error('Claude execution cancelled before trusted input acceptance');
      if (this.activeTools.size > 0) {
        await new Promise<void>((resolve) => this.toolsDrainedWaiters.push(resolve));
      }
      if (this.cancelled) throw new Error('Claude execution cancelled before trusted input acceptance');
      const acceptance = acceptInput();
      this.currentAcceptance = acceptance;
      await acceptance;
      if (this.cancelled) throw new Error('Claude execution cancelled after trusted input acceptance');
    });
    this.transitionTail = transition.catch(() => {});
    return transition.finally(() => {
      if (this.transitionPending === transitionIntent) this.transitionPending = null;
      publishTransitionComplete();
    });
  }

  async acquireTool(toolUseId: string): Promise<void> {
    for (;;) {
      if (this.cancelled) throw new Error('Claude execution cancelled before tool admission');
      const pending = this.transitionPending;
      if (pending) {
        await pending;
        continue;
      }
      const acceptance = this.currentAcceptance;
      if (!acceptance) throw new Error('Claude attempted a tool before any trusted input acceptance');
      await acceptance;
      if (this.cancelled) throw new Error('Claude execution cancelled before tool admission');
      if (acceptance !== this.currentAcceptance || this.transitionPending) continue;
      if (this.activeTools.has(toolUseId)) throw new Error(`duplicate Claude tool lease ${toolUseId}`);
      this.activeTools.add(toolUseId);
      return;
    }
  }

  releaseTool(toolUseId: string): void {
    if (!this.activeTools.delete(toolUseId)) return;
    if (this.activeTools.size === 0) {
      for (const resolve of this.toolsDrainedWaiters.splice(0)) resolve();
    }
  }

  async waitForQuiescence(): Promise<void> {
    await this.transitionTail;
    if (this.activeTools.size === 0) return;
    await new Promise<void>((resolve) => this.toolsDrainedWaiters.push(resolve));
  }
}

async function waitForClaudeQuiescence(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderQuiescenceError('Claude did not quiesce after interrupt before the deadline')),
          CLAUDE_QUIESCENCE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: QueuedSDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  constructor(private readonly executionBarrier: ClaudeExecutionBarrier) {}

  /**
   * Fired only when the SDK consumes a queued prompt from the async iterator.
   */
  onAccept: ((inputId: string, scope: ProviderInputScope) => void) | null = null;

  push(text: string, inputId: string | undefined, scope: ProviderInputScope, acceptInput: () => Promise<void>): void {
    this.queue.push({
      message: {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      },
      inputId,
      scope,
      acceptInput,
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  cancel(): void {
    this.done = true;
    this.queue.length = 0;
    this.executionBarrier.cancel();
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const queued = this.queue.shift()!;
        if (queued.inputId) {
          try {
            await this.executionBarrier.transition(queued.acceptInput);
          } catch (err) {
            if (this.done) return;
            throw err;
          }
          // There is intentionally no await/yield between this cancellation
          // check and yielding the prompt to the SDK consumer.
          if (this.done) return;
          this.onAccept?.(queued.inputId, queued.scope);
        }
        yield queued.message;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
function createPreToolUseHook(executionBarrier: ClaudeExecutionBarrier): HookCallback {
  return async (input, toolUseId) => {
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string };
    const toolName = i.tool_name ?? '';
    if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
      return {
        decision: 'block',
        stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
      } as unknown as ReturnType<HookCallback>;
    }
    const leaseId = toolUseId ?? i.tool_use_id;
    if (!leaseId) {
      return {
        decision: 'block',
        stopReason: 'Claude tool call omitted its tool-use identity.',
      } as unknown as ReturnType<HookCallback>;
    }
    try {
      await executionBarrier.acquireTool(leaseId);
    } catch (err) {
      return {
        decision: 'block',
        stopReason: `Trusted input acceptance failed: ${err instanceof Error ? err.message : String(err)}`,
      } as unknown as ReturnType<HookCallback>;
    }
    // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
    // tool: no declared timeout.
    const declaredTimeoutMs =
      toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
    try {
      setContainerToolInFlight(toolName, declaredTimeoutMs);
    } catch (err) {
      log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { continue: true };
  };
}

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

function createPostToolUseHook(executionBarrier: ClaudeExecutionBarrier): HookCallback {
  return async (input, toolUseId, options) => {
    const i = input as { tool_use_id?: string };
    const leaseId = toolUseId ?? i.tool_use_id;
    if (leaseId) executionBarrier.releaseTool(leaseId);
    return postToolUseHook(input, toolUseId, options);
  };
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find(
            (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
          )?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(
        path.join(conversationsDir, filename),
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

// ── Claude Code executable resolution ──

/**
 * Where the base image's `pnpm install -g @anthropic-ai/claude-code` places the
 * global bin shim (PNPM_HOME=/pnpm; container/Dockerfile). Per-agent-group
 * images (buildAgentGroupImage in src/container-runner.ts) run a further
 * `pnpm install -g <pkgs>` layer, which re-links pnpm's global bin dir and can
 * drop this shim — so dynamically-created groups may boot without it.
 */
export const DEFAULT_CLAUDE_EXECUTABLE_PATH = '/pnpm/claude';

export interface ClaudeExecutableResolution {
  /** Resolved executable path, or undefined to let the SDK use its bundled default. */
  path: string | undefined;
  source: 'configured-path' | 'path-lookup' | 'sdk-default';
  tried: string[];
}

/**
 * Resolve the Claude Code executable robustly: the known image path first,
 * then a PATH lookup (`which claude` equivalent), then fall back to the SDK's
 * own bundled binary by omitting `pathToClaudeCodeExecutable` entirely.
 */
export function resolveClaudeCodeExecutable(
  deps: {
    existsSync?: (p: string) => boolean;
    env?: { PATH?: string };
    configuredPath?: string;
  } = {},
): ClaudeExecutableResolution {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const configured = deps.configuredPath ?? DEFAULT_CLAUDE_EXECUTABLE_PATH;
  const envPath = (deps.env ?? process.env).PATH ?? '';
  const tried: string[] = [configured];
  const exists = (p: string): boolean => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  };
  if (exists(configured)) return { path: configured, source: 'configured-path', tried };
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'claude');
    tried.push(candidate);
    if (exists(candidate)) return { path: candidate, source: 'path-lookup', tried };
  }
  return { path: undefined, source: 'sdk-default', tried };
}

let claudeExecutableFailureLogged = false;

/** @internal test hook */
export function resetClaudeExecutableResolutionLogForTests(): void {
  claudeExecutableFailureLogged = false;
}

/**
 * Resolve once at provider init and log the outcome. When NO executable is
 * found, emit one loud structured error (not a per-turn retry loop) and fall
 * back to the SDK's bundled binary resolution.
 */
export function resolveClaudeExecutableWithLogging(
  deps: Parameters<typeof resolveClaudeCodeExecutable>[0] = {},
): string | undefined {
  const resolution = resolveClaudeCodeExecutable(deps);
  if (resolution.source === 'path-lookup') {
    console.error(
      JSON.stringify({
        severity: 'warn',
        event: 'claude_executable_resolved_from_path',
        path: resolution.path,
        configured_path: resolution.tried[0],
      }),
    );
  } else if (!resolution.path && !claudeExecutableFailureLogged) {
    claudeExecutableFailureLogged = true;
    console.error(
      JSON.stringify({
        severity: 'error',
        event: 'claude_executable_not_found',
        configured_path: resolution.tried[0],
        tried_count: resolution.tried.length,
        fallback: 'sdk_bundled_default',
        hint: 'per-agent-group image may have re-linked /pnpm during pnpm install -g (buildAgentGroupImage)',
      }),
    );
  }
  return resolution.path;
}

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private allowedTools: string[];
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  /** Resolved once at provider init; undefined lets the SDK resolve its bundled binary. */
  private readonly claudeExecutablePath: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.claudeExecutablePath = resolveClaudeExecutableWithLogging();
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.allowedTools = buildClaudeToolAllowlist(options.allowedTools);
    this.additionalDirectories = options.additionalDirectories;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown, opts: { attemptedContinuation?: string } = {}): boolean {
    // Diagnostic/trigger predicate only — never authoritative on its own (the
    // poll loop owns continuation clears). A transport error with no attempted
    // continuation can never be stale-session proof.
    if (!opts.attemptedContinuation) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const executionBarrier = new ClaudeExecutionBarrier();
    const stream = new MessageStream(executionBarrier);

    // input-accepted events are produced on the same async channel as SDK
    // events. The translate loop interleaves them so the poll loop sees an
    // input-accepted before the matching result.
    const acceptedBuffer: ProviderEvent[] = [];
    let acceptWaker: (() => void) | null = null;
    stream.onAccept = (inputId, scope) => {
      acceptedBuffer.push({ type: 'input-accepted', inputId, scope });
      acceptWaker?.();
      acceptWaker = null;
    };

    const initialInputId = input.inputId;
    stream.push(input.prompt, initialInputId, 'initial', input.acceptInput);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        ...(this.claudeExecutablePath ? { pathToClaudeCodeExecutable: this.claudeExecutablePath } : {}),
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: this.allowedTools,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [createPreToolUseHook(executionBarrier)] }],
          PostToolUse: [{ hooks: [createPostToolUseHook(executionBarrier)] }],
          PostToolUseFailure: [{ hooks: [createPostToolUseHook(executionBarrier)] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;
    let cancellation: Promise<void> | null = null;

    const cancelExecution = (): Promise<void> => {
      if (cancellation) return cancellation;
      aborted = true;
      stream.cancel();
      cancellation = (async () => {
        const interrupt = (sdkResult as { interrupt?: () => Promise<void> }).interrupt;
        if (interrupt) {
          try {
            await interrupt.call(sdkResult);
          } catch (err) {
            throw new ProviderQuiescenceError('Claude SDK interrupt failed', { cause: err });
          }
        }
        await waitForClaudeQuiescence(executionBarrier.waitForQuiescence());
      })();
      return cancellation;
    };

    // Track accepted-but-unresolved input ids in arrival order. A Claude
    // `result` ends the current turn; it resolves whichever accepted inputs
    // have not yet been resolved (typically one — the active prompt).
    const acceptedUnresolved: string[] = [];

    function drainAccepted(): ProviderEvent[] {
      const out: ProviderEvent[] = [];
      while (acceptedBuffer.length > 0) {
        const ev = acceptedBuffer.shift()!;
        if (ev.type === 'input-accepted') acceptedUnresolved.push(ev.inputId);
        out.push(ev);
      }
      return out;
    }

    function takeResolvedIds(): string[] {
      const ids = acceptedUnresolved.splice(0, acceptedUnresolved.length);
      return ids;
    }

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          messageCount++;

          // Emit any input-accepted events queued since the last SDK event,
          // before translating this one, so the poll loop sees acceptance first.
          for (const ev of drainAccepted()) yield ev;

          // Yield activity for every SDK event so the poll loop knows the agent is working
          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'init', continuation: message.session_id };
          } else if (message.type === 'result') {
            const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
            const resolvedInputIds = takeResolvedIds();
            yield {
              type: 'result',
              text,
              inputId: resolvedInputIds[resolvedInputIds.length - 1],
              resolvedInputIds,
            };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
            // API retry is a mid-turn, non-terminal signal: the turn continues.
            // Reclassify as a non-terminal notice (warn, no relay) correlated to
            // the active input — not a terminal interruption, not a throw.
            yield {
              type: 'notice',
              inputId: acceptedUnresolved[acceptedUnresolved.length - 1] ?? initialInputId ?? '',
              classification: 'api_retry',
              severity: 'warn',
              agentMessage: 'Retrying after a transient API error.',
              fallbackUserMessage: 'A transient error happened; retrying automatically.',
              relayRecommended: false,
            };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
            // The current code does NOT return on rate_limit_event — the turn
            // provably continues — so classify as a continue-the-turn notice
            // (warn, quota classification), not a terminal interruption.
            yield {
              type: 'notice',
              inputId: acceptedUnresolved[acceptedUnresolved.length - 1] ?? initialInputId ?? '',
              classification: 'quota',
              severity: 'warn',
              agentMessage: 'Rate limited; waiting before continuing.',
              fallbackUserMessage: 'Rate limited; the turn will continue shortly.',
              relayRecommended: false,
            };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
            const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
            yield {
              type: 'progress',
              inputId: acceptedUnresolved[acceptedUnresolved.length - 1] ?? initialInputId,
              message: `Context compacted${detail}.`,
            };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
            const tn = message as { summary?: string };
            yield { type: 'progress', message: tn.summary || 'Task notification' };
          }
        }
        // Flush any trailing acceptance events the SDK never interleaved.
        if (!aborted) {
          for (const ev of drainAccepted()) yield ev;
        }
      } finally {
        // Prompt consumption is the provider-submission boundary. If abort
        // races after the SDK has consumed a prompt but before it emits its
        // next event, preserve that acceptance signal so the poll loop keeps
        // recovery ownership of the submitted work. Cancellation before
        // prompt consumption never queues an event here.
        for (const ev of drainAccepted()) yield ev;
        if (cancellation) {
          await cancellation;
        } else {
          await waitForClaudeQuiescence(executionBarrier.waitForQuiescence());
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => {
        const turn = normalizeQueryTurnInput(msg);
        if (turn.attachments?.length) {
          log(
            JSON.stringify({
              severity: 'info',
              event: 'provider_attachments_ignored',
              provider: 'claude',
              attachment_count: turn.attachments.length,
            }),
          );
        }
        stream.push(turn.prompt, turn.inputId, 'followup', turn.acceptInput);
      },
      end: () => stream.end(),
      events: translateEvents(),
      abort: cancelExecution,
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
