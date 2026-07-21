/**
 * Codex app-server JSON-RPC transport primitives.
 *
 * Communicates with `codex app-server` over stdio. This module is just the
 * plumbing — spawn the process, send requests, dispatch responses and
 * notifications. Higher-level semantics (threads, turns, event translation)
 * live in codex.ts.
 *
 * Kept separate so the transport can be unit-tested without pulling in the
 * full provider and so any future Codex tooling (e.g. a CLI for manual
 * debugging) can reuse the same primitives.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

import { ProviderQuiescenceError } from './types.js';

function log(msg: string): void {
  console.error(`[codex-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

/**
 * Errors from `thread/resume` that indicate the thread ID is unusable —
 * typically because the app-server has no memory of it (thread transcript
 * was deleted, server was wiped, ID is from a different codex version).
 * Only errors matching this pattern trigger silent fallback to a fresh
 * thread; everything else bubbles up so the caller can decide what to do.
 *
 * Shared with `codex.ts`'s `isSessionInvalid` to keep the two detection
 * paths in sync.
 */
export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

/**
 * Escape a string for emission inside a TOML basic string (double-quoted).
 * Handles `"` and `\`. Rejects newlines: basic strings can't contain raw
 * newlines, and silently converting them to `\n` would mask misconfiguration
 * (e.g. a secret pasted with a trailing newline). Multiline strings are
 * unsupported for `config.toml` use here.
 */
export function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── JSON-RPC types ──────────────────────────────────────────────────────────

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ── App-server handle ───────────────────────────────────────────────────────

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export interface CodexRequestCancellation {
  isAborted(): boolean;
  onAbort(handler: () => void): () => void;
}

export class CodexRequestAbortedError extends Error {
  constructor(method: string) {
    super(`Codex request aborted while waiting for ${method}`);
    this.name = 'CodexRequestAbortedError';
  }
}

export function spawnCodexAppServer(configOverrides: string[] = []): AppServer {
  // --strict-config makes a typo'd `-c` override fail-fast at spawn instead of
  // being silently ignored (which would downgrade reasoning with no warning).
  // Verified by the image build smoke: both overrides we send pass strict-config; a
  // misspelled key exits 1 with "unknown configuration field".
  const args = ['app-server', '--strict-config', '--listen', 'stdio://'];
  for (const override of configOverrides) args.push('-c', override);

  log(`Spawning: codex ${args.join(' ')}`);
  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendCodexRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
  cancellation?: CodexRequestCancellation,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    if (cancellation?.isAborted()) {
      reject(new CodexRequestAbortedError(method));
      return;
    }
    let settled = false;
    let unsubscribeAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.pending.delete(req.id);
      unsubscribeAbort?.();
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeAbort?.();
        resolve(r);
      },
      reject: (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeAbort?.();
        reject(e);
      },
    });
    unsubscribeAbort = cancellation?.onAbort(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.pending.delete(req.id);
      unsubscribeAbort?.();
      reject(new CodexRequestAbortedError(method));
    });
    // onAbort implementations are allowed to invoke synchronously when an
    // abort races subscription. In that case the request is already settled
    // and must never be written after cancellation.
    if (settled) {
      unsubscribeAbort?.();
      return;
    }

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.pending.delete(req.id);
      unsubscribeAbort?.();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCodexResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const codexTerminationPromises = new WeakMap<AppServer, Promise<void>>();

export interface CodexTerminationOptions {
  gracefulShutdownMs?: number;
  termExitMs?: number;
  killExitMs?: number;
}

interface CodexProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function currentCodexProcessExit(server: AppServer): CodexProcessExit | undefined {
  if (server.process.exitCode === null && server.process.signalCode === null) return undefined;
  return { code: server.process.exitCode, signal: server.process.signalCode };
}

function waitForCodexProcessExit(server: AppServer, timeoutMs: number): Promise<CodexProcessExit | undefined> {
  const existing = currentCodexProcessExit(server);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(undefined);
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal });
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProviderQuiescenceError('Codex app-server process failed during shutdown', { cause: err }));
    };
    function cleanup(): void {
      clearTimeout(timer);
      server.process.off('exit', onExit);
      server.process.off('error', onError);
    }
    server.process.once('exit', onExit);
    server.process.once('error', onError);

    // Close the race between the initial state check and listener attachment.
    const racedExit = currentCodexProcessExit(server);
    if (racedExit && !settled) {
      settled = true;
      cleanup();
      resolve(racedExit);
    }
  });
}

function closeCodexStdioTransport(server: AppServer): { error?: Error } {
  const state: { error?: Error } = {};
  try {
    server.readline.close();
  } catch (err) {
    state.error = err instanceof Error ? err : new Error(String(err));
  }

  const stdin = server.process.stdin;
  if (!stdin) {
    state.error ??= new Error('Codex app-server stdin is unavailable');
    return state;
  }
  // Retain this listener through process exit so a late EPIPE cannot become an
  // unhandled stream error. Any such error also disqualifies graceful proof.
  stdin.on('error', (err) => {
    state.error ??= err;
  });
  try {
    if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
  } catch (err) {
    state.error ??= err instanceof Error ? err : new Error(String(err));
  }
  return state;
}

export function terminateCodexAppServer(server: AppServer, options: CodexTerminationOptions = {}): Promise<void> {
  const existing = codexTerminationPromises.get(server);
  if (existing) return existing;

  const termination = (async () => {
    const exitedBeforeTransportClose = currentCodexProcessExit(server);
    const transportState = closeCodexStdioTransport(server);
    if (exitedBeforeTransportClose) {
      throw new ProviderQuiescenceError(
        'Codex app-server exited before verified transport shutdown; descendant quiescence is unproven',
      );
    }

    const gracefulExit = await waitForCodexProcessExit(server, options.gracefulShutdownMs ?? 3_000);
    if (gracefulExit) {
      // A clean stdin-EOF/direct-process exit is still only proof about the
      // app-server PID. MCP servers and tool subprocesses can outlive it, and
      // this runner has no independent cgroup/process-namespace emptiness
      // proof. Every post-spawn teardown therefore remains fatal so the host
      // can verify the whole container stopped before releasing correlation.
      throw new ProviderQuiescenceError(
        `Codex app-server exited after transport shutdown, but whole process tree quiescence is unproven until host container stop: code=${gracefulExit.code} signal=${gracefulExit.signal}`,
        transportState.error ? { cause: transportState.error } : undefined,
      );
    }

    let escalation: 'SIGTERM' | 'SIGKILL' = 'SIGTERM';
    let signalError: Error | undefined;
    try {
      server.process.kill('SIGTERM');
    } catch (err) {
      signalError = err instanceof Error ? err : new Error(String(err));
    }
    let directExit = await waitForCodexProcessExit(server, options.termExitMs ?? 1_000);
    if (!directExit) {
      escalation = 'SIGKILL';
      try {
        server.process.kill('SIGKILL');
      } catch (err) {
        signalError ??= err instanceof Error ? err : new Error(String(err));
      }
      directExit = await waitForCodexProcessExit(server, options.killExitMs ?? 5_000);
    }
    if (!directExit) {
      throw new ProviderQuiescenceError(
        'Codex app-server did not exit after direct termination signals',
        signalError ? { cause: signalError } : undefined,
      );
    }
    // Rust Drop and the normal stdio transport drain are bypassed once a direct
    // signal is required. The PID exit is bounded, but it is not proof that MCP
    // or tool descendants stopped; only the host's whole-container stop can
    // establish that boundary.
    throw new ProviderQuiescenceError(
      `Codex app-server required direct ${escalation}; descendant quiescence is unproven until host container stop`,
      signalError ? { cause: signalError } : undefined,
    );
  })().catch((err) => {
    if (err instanceof ProviderQuiescenceError) throw err;
    throw new ProviderQuiescenceError('Codex app-server termination failed', {
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  });
  codexTerminationPromises.set(server, termination);
  return termination;
}

/**
 * Wait for a specific JSON-RPC notification from the app-server.
 * Returns the notification if it arrives within `timeoutMs`, otherwise `undefined`.
 */
export function waitForCodexNotification(
  server: AppServer,
  method: string,
  timeoutMs = 30_000,
): Promise<JsonRpcNotification | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      remove();
      resolve(undefined);
    }, timeoutMs);

    function handler(n: JsonRpcNotification): void {
      if (n.method !== method) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      remove();
      resolve(n);
    }

    function remove(): void {
      const idx = server.notificationHandlers.indexOf(handler);
      if (idx >= 0) server.notificationHandlers.splice(idx, 1);
    }

    server.notificationHandlers.push(handler);
  });
}

export interface CodexCompactCompletionNotification {
  method: 'item/completed' | 'turn/completed' | 'thread/compacted';
  turnId?: string;
}

/**
 * Wait for Codex to report that a `thread/compact/start` operation finished.
 *
 * Codex emits the legacy `thread/compacted` notification to some clients, but
 * the pinned 0.139.0 app-server sends the canonical v2 signal instead:
 * either an `item/completed` whose item has `type: 'contextCompaction'`, or a
 * `turn/completed` whose turn contains such an item. We accept any of these
 * signals so the code remains correct across protocol versions.
 *
 * Rejects if an explicit `error` notification arrives for the thread, or if
 * the timeout expires without a completion signal.
 */
export function waitForCodexCompactionComplete(
  server: AppServer,
  threadId: string,
  timeoutMs = 30_000,
  cancellation?: CodexRequestCancellation,
): Promise<CodexCompactCompletionNotification> {
  return new Promise((resolve, reject) => {
    if (cancellation?.isAborted()) {
      reject(new CodexRequestAbortedError('thread/compact completion'));
      return;
    }
    let settled = false;
    let unsubscribeAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      remove();
      reject(new Error(`Timeout waiting for Codex compaction completion on thread ${threadId}`));
    }, timeoutMs);
    unsubscribeAbort = cancellation?.onAbort(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      remove();
      reject(new CodexRequestAbortedError('thread/compact completion'));
    });
    if (settled) {
      unsubscribeAbort?.();
      return;
    }

    function hasContextCompactionItem(items: unknown): boolean {
      if (!Array.isArray(items)) return false;
      return items.some(
        (item) => item && typeof item === 'object' && (item as { type?: string }).type === 'contextCompaction',
      );
    }

    function handler(n: JsonRpcNotification): void {
      if (settled) return;

      const params = n.params || {};
      const eventThreadId =
        (params.threadId as string | undefined) ??
        ((params.thread as { id?: string } | undefined)?.id as string | undefined);
      if (eventThreadId && eventThreadId !== threadId) return;

      switch (n.method) {
        case 'error': {
          const error = (params.error as { message?: string } | undefined)?.message;
          const msg = error || `Codex reported an error while compacting thread ${threadId}`;
          settled = true;
          clearTimeout(timer);
          remove();
          reject(new Error(msg));
          return;
        }
        case 'item/completed': {
          const item = params.item as { type?: string; threadId?: string } | undefined;
          if (item?.type === 'contextCompaction') {
            settled = true;
            clearTimeout(timer);
            remove();
            resolve({ method: 'item/completed', turnId: params.turnId as string | undefined });
          }
          return;
        }
        case 'turn/completed': {
          const turn = params.turn as { items?: unknown } | undefined;
          if (hasContextCompactionItem(turn?.items)) {
            settled = true;
            clearTimeout(timer);
            remove();
            const items = (turn?.items as { type?: string; id?: string }[] | undefined) ?? [];
            const compactionItem = items.find((item) => item?.type === 'contextCompaction');
            resolve({ method: 'turn/completed', turnId: compactionItem?.id });
          }
          return;
        }
        case 'thread/compacted': {
          // Legacy fallback; retained for compatibility with protocol versions
          // that still fan this notification out to v2 clients.
          settled = true;
          clearTimeout(timer);
          remove();
          resolve({ method: 'thread/compacted', turnId: params.turnId as string | undefined });
          return;
        }
        default:
          return;
      }
    }

    function remove(): void {
      const idx = server.notificationHandlers.indexOf(handler);
      if (idx >= 0) server.notificationHandlers.splice(idx, 1);
      unsubscribeAbort?.();
    }

    server.notificationHandlers.push(handler);
  });
}

// ── Auto-approval ───────────────────────────────────────────────────────────
// The container sandbox is already the security boundary; inside it, Codex's
// own approval prompts would just block every tool call on a user that isn't
// watching. For a NORMAL turn we accept everything and let sandbox limits do
// the enforcement.
//
// RELAY turns are different. A relay/recovery turn narrates status only and
// runs under a `read-only` sandbox (codexThreadSandbox(true)); auto-approving
// writes/exec/network for a relay would let it bypass the read-only boundary
// the moment the model attempts a side effect, so in relay mode we REFUSE every
// side-effecting approval. The Codex app-server's `ReviewDecision` enum (verified
// against the bundled codex-cli 0.139.0 native binary's embedded protocol types
// — `ReviewDecision.ts`: `approved`, `approved_for_session`, `denied`, `abort`)
// accepts `denied` as the explicit refusal, and the `item/*/requestApproval`
// family accepts `reject`. We use those real values — never an invented one.

// Shapes verified with `codex app-server generate-ts` from codex-cli 0.139.0:
// ToolRequestUserInputResponse and McpServerElicitationRequestResponse.
function codexRequestUserInputDecline(params: unknown): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const questions = Array.isArray(record.questions) ? record.questions : [];
  for (const question of questions) {
    if (!question || typeof question !== 'object') continue;
    const id = (question as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) {
      answers[id] = { answers: [] };
    }
  }
  return { answers };
}

function codexElicitationDecline(): { action: 'decline'; content: null; _meta: null } {
  return { action: 'decline', content: null, _meta: null };
}

export function attachCodexAutoApproval(server: AppServer, { relay }: { relay: boolean } = { relay: false }): void {
  server.serverRequestHandlers.push((req) => {
    const method = req.method;
    log(`[approval] ${method}${relay ? ' (relay)' : ''}`);

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        // Relay: refuse the side effect (read-only narration only).
        sendCodexResponse(server, req.id, { decision: relay ? 'reject' : 'accept' });
        break;
      case 'item/permissions/requestApproval':
        // Relay: grant READ-ONLY filesystem and NO network — never write.
        sendCodexResponse(server, req.id, {
          permissions: relay
            ? { fileSystem: { read: ['/'], write: [] }, network: { enabled: false } }
            : { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        // Relay: deny the patch/command outright (read-only boundary).
        sendCodexResponse(server, req.id, { decision: relay ? 'denied' : 'approved' });
        break;
      case 'item/tool/call': {
        const toolName = (req.params as { tool?: string }).tool || 'unknown';
        log(`[approval] Unexpected dynamic tool call: ${toolName}`);
        sendCodexResponse(server, req.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
        });
        break;
      }
      case 'item/tool/requestUserInput':
        sendCodexResponse(server, req.id, codexRequestUserInputDecline(req.params));
        break;
      case 'mcpServer/elicitation/request':
        sendCodexResponse(server, req.id, codexElicitationDecline());
        break;
      default:
        log(`[approval] Unknown method ${method}, generic accept`);
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });
}

// ── High-level helpers ──────────────────────────────────────────────────────

export async function initializeCodexAppServer(
  server: AppServer,
  cancellation?: CodexRequestCancellation,
): Promise<void> {
  log('Sending initialize…');
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    },
    INIT_TIMEOUT_MS,
    cancellation,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
}

export interface ThreadParams {
  model: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

/**
 * Start or resume a Codex thread. If `threadId` is provided, attempts
 * `thread/resume` first and falls back to a fresh `thread/start` on failure
 * (stale thread IDs commonly outlive containers). Returns the active thread
 * ID either way.
 */
export async function startOrResumeCodexThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
  cancellation?: CodexRequestCancellation,
): Promise<string> {
  if (threadId) {
    log(`Resuming thread: ${threadId}`);
    const resp = await sendCodexRequest(
      server,
      'thread/resume',
      {
        threadId,
        ...(params as unknown as Record<string, unknown>),
      },
      60_000,
      cancellation,
    );
    if (!resp.error) {
      log(`Thread resumed: ${threadId}`);
      return threadId;
    }
    // Only fall through to fresh-thread on recognized stale-thread errors.
    // Auth, version, or transient failures would otherwise silently discard
    // session state — fail loud instead so the caller can retry or surface.
    if (!STALE_THREAD_RE.test(resp.error.message)) {
      throw new Error(`thread/resume failed: ${resp.error.message}`);
    }
    log(`Stale thread ${threadId}; starting fresh thread.`);
  }

  log('Starting new thread…');
  const resp = await sendCodexRequest(
    server,
    'thread/start',
    {
      ...(params as unknown as Record<string, unknown>),
    },
    60_000,
    cancellation,
  );
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  log(`New thread: ${newThreadId}`);
  return newThreadId;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  model?: string;
  cwd?: string;
}

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<void> {
  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText }],
    model: params.model,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export async function interruptCodexTurn(
  server: AppServer,
  params: TurnInterruptParams,
  timeoutMs = 30_000,
): Promise<void> {
  const resp = await sendCodexRequest(
    server,
    'turn/interrupt',
    { threadId: params.threadId, turnId: params.turnId },
    timeoutMs,
  );
  if (resp.error) throw new Error(`turn/interrupt failed: ${resp.error.message}`);
}

// ── MCP config.toml ─────────────────────────────────────────────────────────
// Codex discovers MCP servers by reading ~/.codex/config.toml at startup.
// We rewrite it on every spawn from whatever mcpServers the agent-runner
// passes in, so the container's config reflects the current host wiring.

export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  const codexConfigDir = path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  const lines: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    // NO `type = "stdio"` line: the pinned codex-cli rejects an unknown
    // `mcp_servers.<n>.type` field under `--strict-config` and
    // the app-server aborts with exit code=1 at startup. stdio is inferred from
    // the presence of `command`; the command-only form is accepted across codex
    // versions (the explicit `type` key was a later 0.139.x addition).
    lines.push(`command = ${tomlBasicString(config.command)}`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map(tomlBasicString).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${tomlBasicString(value)}`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  log(`Wrote MCP config.toml (${Object.keys(servers).length} server(s))`);
}

export function createCodexConfigOverrides(): string[] {
  // Disable the hosted "apps"/connectors MCP (codex_apps). It is stable and ON
  // by default in codex-cli; at startup the client opens a streamable-HTTP
  // connection to OpenAI's apps backend that needs a ChatGPT-account connector
  // OAuth bearer plus direct egress to that host. Yente's Codex auth is mediated
  // by the OneCLI broker (model API only, no connector OAuth, no direct apps
  // egress), so the connector's `initialize` reply comes back as a non-JSON-RPC
  // body and the rmcp client throws "did not match any variant of untagged enum
  // JsonRpcMessage". The connector is unwanted anyway — Yente uses its own local
  // MCP/skills, not OpenAI's hosted connectors. `features.apps` is a known feature
  // key, so it is accepted under --strict-config.
  const overrides = ['features.apps=false'];
  // Yente runs high reasoning by default; per-group override via
  // CODEX_REASONING_EFFORT forwarded by the host-side provider config.
  // `model_reasoning_effort` is the strict-config key codex app-server accepts.
  const effort = process.env.CODEX_REASONING_EFFORT?.trim() || 'high';
  overrides.push(`model_reasoning_effort=${effort}`);
  return overrides;
}
