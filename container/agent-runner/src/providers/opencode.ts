import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import {
  normalizeQueryTurnInput,
  type AgentProvider,
  type AgentQuery,
  type ProviderCapabilities,
  type ProviderContinuationPolicy,
  type ProviderEvent,
  type ProviderInputScope,
  type ProviderOptions,
  type ProviderSideEffect,
  type QueryAttachment,
  type QueryInput,
  type QueryTurnInput,
} from './types.js';
import { buildRelayOpenCodeToolConfig, mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { OpenCodeEventPump, type OpenCodePumpClock, type OpenCodeLivenessSnapshot } from './opencode-events.js';
import {
  classifyContinuation,
  isMissingOpenCodeSessionError,
  isMissingSessionResultError,
} from './opencode-errors.js';
import {
  detectNativeQuestionPart,
  detectNativeQuestionPermission,
  NATIVE_QUESTION_TOOL_ID,
  relayDeniedNativeToolIds,
} from './opencode-sdk-surface.js';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { getAuthoritativeSideEffects, importSideEffectLedger } from '../db/side-effects.js';
import { sniffImageMime } from '../attachments.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

// Liveness/timeout knobs, env-configurable (forwarded from the host through the
// container env map — see host src/providers/opencode.ts). The pump enforces the
// absolute ceiling itself, independent of heartbeat; transport timeout is the
// no-SSE death window. Each reads `process.env` lazily inside getters so a test
// that sets the env before calling buildOpenCodeConfig() is honored.
function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const OPENCODE_TRANSPORT_TIMEOUT_MS = (): number => envNum('OPENCODE_TRANSPORT_TIMEOUT_MS', 30 * 60 * 1000);
const OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS = (): number => envNum('OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS', 6 * 60 * 60 * 1000);
const OPENCODE_INACTIVITY_NOTICE_MS = (): number => envNum('OPENCODE_INACTIVITY_NOTICE_MS', 5 * 60 * 1000);
const OPENCODE_INACTIVITY_NOTICE_REPEAT_MS = (): number =>
  envNum('OPENCODE_INACTIVITY_NOTICE_REPEAT_MS', OPENCODE_INACTIVITY_NOTICE_MS());
const OPENCODE_WAIT_TICK_MS = (): number => envNum('OPENCODE_WAIT_TICK_MS', 15 * 1000);
const OPENCODE_RELAY_DEADLINE_MS = (): number => envNum('OPENCODE_RELAY_DEADLINE_MS', 30 * 1000);
const OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS = (): number => envNum('OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS', 6 * 60 * 60 * 1000);
// Model-provider request timeout: a large positive ms value (= absolute turn
// ceiling) under the ACTIVE provider name, NEVER 0 (which means immediate abort).
const OPENCODE_MODEL_PROVIDER_TIMEOUT_MS = (): number => envNum('OPENCODE_MODEL_PROVIDER_TIMEOUT_MS', 6 * 60 * 60 * 1000);
// Note: OPENCODE_CONTINUATION_FAILURE_LIMIT (bounded zombie backstop) is owned
// by the poll loop, which counts consecutive terminal interruptions across
// wakes; OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS is reserved for a future
// cancellable-native-question reuse path (today every native question is denied
// + cleared with restart-capable recovery). Both are still host-forwarded so an
// operator override reaches the in-container default consumer.

const KEEPALIVE_EVENT_TYPES = ['server.connected', 'server.heartbeat'];

/**
 * Real-timer clock+scheduler for the pump in production. Tests inject a
 * deterministic fake clock instead; the pump itself NEVER references global
 * timers — this provider-owned seam is the only place that does.
 */
function realTimerClock(): OpenCodePumpClock {
  return {
    now: () => Date.now(),
    schedule: (delayMs, cb) => {
      const id = setTimeout(cb, delayMs);
      if (typeof id === 'object' && id && 'unref' in id) {
        (id as unknown as { unref: () => void }).unref();
      }
      return () => clearTimeout(id);
    },
  };
}

/**
 * Stale / dead OpenCode session heuristics (complement Claude-centric host
 * patterns). NOTE: this is a trigger-only diagnostic, never an authoritative
 * continuation clear (see opencode-errors.ts). Deliberately does NOT include
 * generic transport "timeout" text — a stalled stream is not stale-session
 * proof.
 */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isStaleSessionError(err: unknown): boolean {
  return STALE_SESSION_RE.test(errorText(err));
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(
  config: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=0`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

const BUILTIN_AUTH_PROVIDERS = new Set(['anthropic', 'opencode', 'opencode-go', 'opencode-zen', 'openai']);

export interface BuildOpenCodeConfigOpts {
  /** Build the restricted relay config (mutation/shell/file/web/question denied). */
  relayMode?: boolean;
  /** Locked normalized route for relay output (informational; route-lock is enforced at the MCP server). */
  relayRouteKey?: string;
}

export function buildOpenCodeConfig(
  options: ProviderOptions,
  opts: BuildOpenCodeConfigOpts = {},
): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const reasoningEffort = process.env.OPENCODE_REASONING_EFFORT;
  if (!BUILTIN_AUTH_PROVIDERS.has(provider)) {
    throw new Error('Custom OpenCode providers are not supported without a OneCLI-managed credential path');
  }

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Model-provider request timeout under the ACTIVE provider name. In SDK
  // 1.15.10 there is NO top-level Config.options.timeout — the field is
  // provider[<activeProvider>].options.timeout (number | false). We set a large
  // positive ms value (default = absolute turn ceiling) so NanoClaw's liveness
  // pump is not undercut by the hidden 5-minute provider request abort. NEVER 0
  // (immediate abort) and NEVER a provider literally named "options".
  const selectedModel = splitOpenCodeModel(model);
  const providerConfig: Record<
    string,
    {
      options: { timeout: number | false };
      models?: Record<string, { options: Record<string, string> }>;
    }
  > = {
    [provider]: {
      options: { timeout: OPENCODE_MODEL_PROVIDER_TIMEOUT_MS() },
      ...(reasoningEffort && selectedModel?.providerID === provider
        ? {
            models: {
              [selectedModel.modelID]: {
                options: {
                  reasoningEffort,
                },
              },
            },
          }
        : {}),
    },
  };

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  // Native question is disabled through OpenCode TOOL AVAILABILITY (the typed
  // tools map), NOT through permission.question — SDK 1.15.10 Config.permission
  // keys are exactly edit|bash|webfetch|doom_loop|external_directory, so a
  // `question` permission key silently no-ops and leaves the native question
  // tool reachable. `tools.question = false` is the REAL surface.
  const tools: Record<string, boolean> = { [NATIVE_QUESTION_TOOL_ID]: false };
  const permission: Record<string, string> = { '*': 'allow' };

  if (opts.relayMode) {
    // Relay config: deny mutation/shell/file/web + question via the REAL SDK ids
    // (permission keys + tools map). Read-only status tools stay enabled; the
    // only write surface is the route-locked send_message MCP tool.
    const relay = buildRelayOpenCodeToolConfig();
    Object.assign(tools, relay.tools);
    Object.assign(permission, relay.permission);
  }

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission,
    tools,
    autoupdate: false,
    snapshot: false,
    provider: providerConfig,
    instructions,
    mcp,
  };
}

type OpenCodeSseEvent = { type: string; properties: Record<string, unknown> };

/**
 * Per-query runtime controller seam (Task 3 Step 4). Replaces the former module-
 * global singleton (`sharedRuntime`/`sharedConfigKey`/`sharedInit`/
 * `ensureSharedRuntime`/`destroySharedRuntime`). Each controller owns ONE
 * process/client/event stream, and `destroy(reason)` targets exactly that
 * runtime — so a timeout/abort during a concurrent relay window can no longer
 * kill BOTH turns. The relay path constructs a SEPARATE controller (its own
 * process/client/stream/MCP server) so it never lands on the original runtime.
 */
/**
 * Minimal client surface a runtime controller needs: a session sub-client
 * (create / promptAsync / get) and the permission-reply method. The production
 * `OpencodeClient` satisfies this; tests provide a fake.
 */
export interface OpenCodeControllerClient {
  session: SessionClient & {
    get: (args: { path: { id: string } }) => Promise<{ data?: unknown; error?: unknown }>;
  };
  postSessionIdPermissionsPermissionId: (args: {
    path: { id: string; permissionID: string };
    body: { response: 'once' | 'always' | 'reject' };
  }) => Promise<unknown>;
}

export interface OpenCodeRuntimeController {
  readonly proc?: ChildProcess;
  readonly client: OpenCodeControllerClient;
  /** Long-lived single-reader event stream for this runtime. */
  readonly stream: AsyncGenerator<OpenCodeSseEvent, void, void> | { next(): Promise<IteratorResult<OpenCodeSseEvent, void>> };
  /** Deny (reject) a permission for a native question or tool. */
  denyPermission(sessionId: string, permissionId: string, reason: string): Promise<void>;
  /** Positive existence check for the exact attempted session id. */
  sessionExists(id: string): Promise<boolean>;
  /** Tear down THIS runtime (and quiesce its stream) — never the relay's. */
  destroy(reason: string): void;
}

/** Factory seam so tests can inject a deterministic controller. */
export interface OpenCodeRuntimeFactory {
  createRuntime(options: ProviderOptions, opts: BuildOpenCodeConfigOpts): Promise<OpenCodeRuntimeController>;
}

/** Separate relay-runtime factory (Task 3 Step 4). */
export interface OpenCodeRelayRuntimeFactory {
  createRelayRuntime(
    options: ProviderOptions,
    policy: { allowedTools: string[]; deniedNativeTools: string[]; routeKey: string; deadlineMs: number },
  ): Promise<OpenCodeRuntimeController>;
}

export function runtimeConfigKey(options: ProviderOptions, opts: BuildOpenCodeConfigOpts = {}): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    reasoningEffort: process.env.OPENCODE_REASONING_EFFORT,
    op: process.env.OPENCODE_PROVIDER,
    // Relay differs only in denied tools, so it MUST get a distinct config key
    // or it would collide on the normal runtime and a destroy would kill both.
    relay: opts.relayMode ? `relay:${opts.relayRouteKey ?? ''}` : 'normal',
  });
}

/**
 * Real production controller: owns one opencode server proc + client + stream.
 * Exported for the quiesce-before-kill ordering test; not part of the public
 * provider API.
 */
export class RealOpenCodeRuntimeController implements OpenCodeRuntimeController {
  constructor(
    readonly proc: ChildProcess,
    readonly client: OpencodeClient,
    readonly stream: AsyncGenerator<OpenCodeSseEvent, void, void>,
  ) {}

  async denyPermission(sessionId: string, permissionId: string, _reason: string): Promise<void> {
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response: 'reject' },
    });
  }

  async sessionExists(id: string): Promise<boolean> {
    try {
      const res = await this.client.session.get({ path: { id } });
      if (res.error) {
        if (isMissingSessionResultError(res.error)) return false;
        return true;
      }
      return Boolean(res.data);
    } catch {
      return true;
    }
  }

  destroy(_reason: string): void {
    // Quiesce the in-flight read BEFORE killing the proc so a retiring runtime's
    // outstanding pump read cannot steal a new query's first event (cross-query
    // protected-event-loss race). stream.return() ends the generator cleanly.
    try {
      void this.stream.return?.(undefined);
    } catch {
      /* ignore */
    }
    killProcessTree(this.proc);
  }
}

/** Default factory: spawns a real opencode server + root client + event stream. */
export const realRuntimeFactory: OpenCodeRuntimeFactory & OpenCodeRelayRuntimeFactory = {
  async createRuntime(options, opts): Promise<OpenCodeRuntimeController> {
    const config = buildOpenCodeConfig(options, opts);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<OpenCodeSseEvent, void, void>;
    return new RealOpenCodeRuntimeController(proc, client, stream);
  },
  async createRelayRuntime(options, policy): Promise<OpenCodeRuntimeController> {
    // The relay launches its OWN NanoClaw MCP-server subprocess in relay mode
    // (route-locked send_message only). The relay env tells mcp-tools/server.ts
    // to expose only the status-only allowlist; native mutation tools are denied
    // via the relay config tools/permission map.
    const relayMcpServers = withRelayMcpEnv(options.mcpServers, policy.routeKey);
    return realRuntimeFactory.createRuntime(
      { ...options, mcpServers: relayMcpServers },
      { relayMode: true, relayRouteKey: policy.routeKey },
    );
  },
};

/**
 * Stamp `NANOCLAW_RELAY_MODE=1` + `NANOCLAW_RELAY_ROUTE_KEY=<route>` into the
 * nanoclaw MCP server's env so its own subprocess exposes only the route-locked
 * status tool map. The relay never shares the original turn's MCP server.
 */
function withRelayMcpEnv(
  servers: ProviderOptions['mcpServers'],
  routeKey: string,
): ProviderOptions['mcpServers'] {
  if (!servers) return servers;
  const out: NonNullable<ProviderOptions['mcpServers']> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] =
      name === 'nanoclaw'
        ? {
            ...cfg,
            env: {
              ...cfg.env,
              NANOCLAW_RELAY_MODE: '1',
              NANOCLAW_RELAY_ROUTE_KEY: routeKey,
              NANOCLAW_RELAY_STATUS_TOOLS: '',
            },
          }
        : cfg;
  }
  return out;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

type SessionClient = Pick<OpencodeClient['session'], 'create' | 'promptAsync'>;

type OpenCodePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };
type OpenCodeModelSelection = { providerID: string; modelID: string };

interface StagedAttachment {
  path: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

async function createSession(client: SessionClient): Promise<string> {
  const created = await client.create();
  if (created.error) {
    throw new Error(`OpenCode: failed to create session: ${errorText(created.error)}`);
  }
  const sessionId = created.data?.id;
  if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
  return sessionId;
}

export async function promptSession(
  client: SessionClient,
  preferredSessionId: string | undefined,
  input: string | OpenCodePromptPart[],
  model?: OpenCodeModelSelection,
): Promise<{ sessionId: string; recoveredFromStale: boolean }> {
  let sessionId = preferredSessionId;
  let recoveredFromStale = false;
  const parts = typeof input === 'string' ? buildOpenCodePromptParts(input) : input;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sessionId) {
      sessionId = await createSession(client);
    }

    try {
      const promptRes = await client.promptAsync({
        path: { id: sessionId },
        body: { parts, ...(model ? { model } : {}) },
      });
      if (!promptRes.error) {
        return { sessionId, recoveredFromStale };
      }

      const err = new Error(`OpenCode promptAsync: ${errorText(promptRes.error)}`);
      if (preferredSessionId && sessionId === preferredSessionId && isStaleSessionError(err)) {
        log(`Stale OpenCode session ${preferredSessionId}; starting a fresh session`);
        sessionId = undefined;
        recoveredFromStale = true;
        continue;
      }
      throw err;
    } catch (err) {
      if (preferredSessionId && sessionId === preferredSessionId && isStaleSessionError(err)) {
        log(`Stale OpenCode session ${preferredSessionId}; starting a fresh session`);
        sessionId = undefined;
        recoveredFromStale = true;
        continue;
      }
      throw err;
    }
  }

  throw new Error('OpenCode promptAsync: stale session recovery exhausted');
}

export async function stageOpenCodeAttachments(attachments: QueryAttachment[]): Promise<StagedAttachment[]> {
  if (attachments.length === 0) return [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-opencode-files-'));
  const staged: StagedAttachment[] = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      const filename = safeStageFilename(index, attachment.filename);
      const stagedPath = path.join(dir, filename);
      await fs.copyFile(attachment.path, stagedPath);
      const stat = await fs.stat(stagedPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size !== attachment.sizeBytes) {
        throw new Error(`Staged attachment validation failed for ${attachment.filename}`);
      }
      const header = await readHeader(stagedPath);
      const sniffed = sniffImageMime(header);
      if (sniffed && sniffed !== attachment.mime) {
        throw new Error(`Staged attachment MIME mismatch for ${attachment.filename}`);
      }
      staged.push({
        path: stagedPath,
        filename: attachment.filename,
        mime: attachment.mime,
        sizeBytes: stat.size,
      });
    }
    return staged;
  } catch (err) {
    await cleanupStagedAttachments(staged, dir);
    throw err;
  }
}

export function buildOpenCodePromptParts(text: string, attachments: StagedAttachment[] = []): OpenCodePromptPart[] {
  return [
    { type: 'text', text },
    ...attachments.map((staged) => ({
      type: 'file' as const,
      mime: staged.mime,
      url: pathToFileURL(staged.path).href,
      filename: staged.filename,
    })),
  ];
}

export function splitOpenCodeModel(model: string | undefined): OpenCodeModelSelection | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function modelForAttachments(staged: StagedAttachment[]): OpenCodeModelSelection | undefined {
  if (staged.length === 0) return undefined;
  return splitOpenCodeModel(process.env.OPENCODE_VISION_MODEL);
}

async function cleanupStagedAttachments(staged: StagedAttachment[], stagedDir?: string): Promise<void> {
  const dirs = new Set<string>();
  for (const item of staged) {
    dirs.add(path.dirname(item.path));
    try {
      await fs.rm(item.path, { force: true });
    } catch (err) {
      log(
        JSON.stringify({
          severity: 'warn',
          event: 'opencode_attachment_cleanup_failed',
          filename: item.filename,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  if (stagedDir) dirs.add(stagedDir);
  for (const dir of dirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      log(
        JSON.stringify({
          severity: 'warn',
          event: 'opencode_attachment_dir_cleanup_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

async function readHeader(filePath: string): Promise<Buffer> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const read = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, read.bytesRead);
  } finally {
    await fh.close();
  }
}

function safeStageFilename(index: number, filename: string): string {
  const base =
    path
      .basename(filename)
      .replace(/[/\\\0]/g, '-')
      .trim() || 'attachment';
  return `${index + 1}-${base}`;
}

function wrapTurnWithContext(turn: QueryTurnInput, systemInstructions?: string): QueryTurnInput {
  return {
    ...turn,
    prompt: wrapPromptWithContext(turn.prompt, systemInstructions),
  };
}

function summarizeMimes(attachments: QueryAttachment[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const attachment of attachments) {
    summary[attachment.mime] = (summary[attachment.mime] ?? 0) + 1;
  }
  return summary;
}

function extractRunId(text: string): string | undefined {
  return text.match(/\b(?:filepart-[a-z-]+-\d{10,}|smoke-\d{10,}-\d+)\b/)?.[0];
}

/** Active OpenCode tool tracked for declared-timeout host-sweep widening. */
interface ActiveOpenCodeTool {
  callID: string;
  tool: string;
  declaredTimeoutMs: number | null;
  startedAt: string;
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  // Per-instance runtime controller state (replaces the former module-global
  // singleton). A normal runtime and a separate relay runtime are tracked
  // independently so destroying one never kills the other.
  private controller: OpenCodeRuntimeController | null = null;
  private controllerKey: string | null = null;
  private controllerInit: Promise<OpenCodeRuntimeController> | null = null;

  private readonly runtimeFactory: OpenCodeRuntimeFactory & OpenCodeRelayRuntimeFactory;
  private readonly persistActiveTool: (tool: ActiveOpenCodeTool | null) => void;
  private readonly clockFactory: () => OpenCodePumpClock;
  private readonly importStagedSideEffects: (inputId: string) => ProviderSideEffect[];

  constructor(
    options: ProviderOptions = {},
    seams: {
      runtimeFactory?: OpenCodeRuntimeFactory & OpenCodeRelayRuntimeFactory;
      persistActiveTool?: (tool: ActiveOpenCodeTool | null) => void;
      clockFactory?: () => OpenCodePumpClock;
      importStagedSideEffects?: (inputId: string) => ProviderSideEffect[];
    } = {},
  ) {
    this.options = options;
    this.runtimeFactory = seams.runtimeFactory ?? realRuntimeFactory;
    this.persistActiveTool = seams.persistActiveTool ?? defaultPersistActiveTool;
    this.clockFactory = seams.clockFactory ?? realTimerClock;
    this.importStagedSideEffects = seams.importStagedSideEffects ?? defaultImportStagedSideEffects;
  }

  /** Capabilities: OpenCode supports a separate-runtime status relay. */
  get capabilities(): ProviderCapabilities {
    return {
      supportsSeparateRelayRuntime: true,
      defaultRelayDeadlineMs: OPENCODE_RELAY_DEADLINE_MS(),
      relayToolPolicy: 'status_only',
    };
  }

  isSessionInvalid(err: unknown, opts: { attemptedContinuation?: string } = {}): boolean {
    // Diagnostic/trigger predicate only — the poll loop owns authoritative
    // continuation clears (explicit clear-continuation, positive existence
    // check, or the bounded zombie path). A stale-session text match without
    // an attempted continuation can never be proof on its own. We require the
    // EXACT attempted id to appear verbatim alongside a missing-session phrase;
    // a generic transport/read/timeout/bare-not-found error is never a trigger.
    if (!opts.attemptedContinuation) return false;
    return isMissingOpenCodeSessionError(err, opts.attemptedContinuation);
  }

  /** Lazily create / reuse this instance's normal runtime controller. */
  private async ensureRuntime(opts: BuildOpenCodeConfigOpts = {}): Promise<OpenCodeRuntimeController> {
    const key = runtimeConfigKey(this.options, opts);
    if (this.controller && this.controllerKey === key) return this.controller;
    if (this.controllerInit) return this.controllerInit;
    this.controllerInit = (async () => {
      // A config change retires the prior runtime — dispose its stream first so
      // its in-flight read can't steal a new query's first event.
      if (this.controller) this.controller.destroy('runtime_config_changed');
      const rt = await this.runtimeFactory.createRuntime(this.options, opts);
      this.controller = rt;
      this.controllerKey = key;
      this.controllerInit = null;
      return rt;
    })();
    return this.controllerInit;
  }

  /** Destroy ONLY this instance's normal runtime (never a relay's). */
  private destroyRuntime(reason: string): void {
    if (this.controller) {
      this.controller.destroy(reason);
      this.controller = null;
      this.controllerKey = null;
    }
    this.controllerInit = null;
  }

  // The AUTHORITATIVE positive existence check is reached through the per-turn
  // controller (`rt.sessionExists(...)` in gen()'s terminal handler), so no
  // provider-level `sessionExists`/`createRelayRuntime` wrappers exist; the
  // relay path calls `self.runtimeFactory.createRelayRuntime(...)` directly.

  query(input: QueryInput): AgentQuery {
    const self = this;
    const relayMode = input.relayMode === true;
    const relayRouteKey = input.relayMode ? (input.continuation ?? 'relay') : 'relay';

    // Relay queries run a SEPARATE controller with their OWN local session id so
    // they NEVER touch the instance's normal-turn state (this.controller /
    // this.activeSessionId / container_state). This is the per-instance
    // separation that keeps a relay from killing the concurrent original turn.
    // A relay has no continuation and never seeds the instance session id.
    let relayController: OpenCodeRuntimeController | null = null;
    let relayActiveSessionId: string | undefined;
    if (!relayMode) {
      this.activeSessionId = input.continuation ? input.continuation : undefined;
    }

    const pending: QueryTurnInput[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapTurnWithContext(input, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };
    const getActiveSession = (): string | undefined => (relayMode ? relayActiveSessionId : self.activeSessionId);
    const setActiveSession = (id: string | undefined): void => {
      if (relayMode) relayActiveSessionId = id;
      else self.activeSessionId = id;
    };
    const teardownRuntime = (reason: string): void => {
      if (relayMode) {
        relayController?.destroy(reason);
        relayController = null;
      } else {
        self.destroyRuntime(reason);
      }
    };
    let persistedToolKey = 'none';
    const persistTool = (tool: ActiveOpenCodeTool | null): void => {
      // Relay mode has no mutation/long tools and must not clobber the original
      // turn's container_state.
      if (relayMode) return;
      const key = tool ? `${tool.tool}:${tool.declaredTimeoutMs ?? ''}` : 'none';
      if (key === persistedToolKey) return;
      persistedToolKey = key;
      self.persistActiveTool(tool);
    };

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      let turnIndex = 0;
      const rt = relayMode
        ? (relayController = await self.runtimeFactory.createRelayRuntime(self.options, {
            allowedTools: ['send_message'],
            deniedNativeTools: relayDeniedNativeToolIds(),
            routeKey: relayRouteKey,
            deadlineMs: input.relayDeadlineMs ?? OPENCODE_RELAY_DEADLINE_MS(),
          }))
        : await self.ensureRuntime({});
      const { client } = rt;
      const stream = rt.stream as AsyncGenerator<OpenCodeSseEvent, void, void>;

      // Active tool tracking (Step 8): the active tool with the LARGEST bounded
      // declared timeout is persisted to container_state so host-sweep can widen
      // its kill ceiling for a long OpenCode tool. Cleared when all tools finish
      // or on terminal interruption.
      const activeTools = new Map<string, ActiveOpenCodeTool>();
      const refreshActiveTool = (): void => {
        let longest: ActiveOpenCodeTool | null = null;
        for (const t of activeTools.values()) {
          if (t.declaredTimeoutMs == null) continue;
          if (!longest || (t.declaredTimeoutMs ?? 0) > (longest.declaredTimeoutMs ?? 0)) longest = t;
        }
        persistTool(longest);
      };
      const clearActiveTools = (): void => {
        activeTools.clear();
        persistTool(null);
      };

      // Native-question correlation: question tool parts seen this turn (by
      // callID) so a matching permission.updated is denied through the SDK.
      const questionCallIds = new Set<string>();
      const questionTextByCallId = new Map<string, string>();

      // Side-effect evidence collected during the accepted-input window, so a
      // terminal interruption after a side effect carries it into the recovery
      // seed and the agent reports existing work rather than duplicating it.
      const collectedSideEffects: ProviderSideEffect[] = [];
      const emittedSideEffectIds = new Set<string>();

      // Single-reader, long-lived pump over THIS controller's event stream.
      const pump = new OpenCodeEventPump<OpenCodeSseEvent>({
        ...self.clockFactory(),
        stream,
        transportTimeoutMs: OPENCODE_TRANSPORT_TIMEOUT_MS(),
        absoluteTurnTimeoutMs: OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS(),
        inactivityNoticeMs: OPENCODE_INACTIVITY_NOTICE_MS(),
        inactivityThrottleMs: OPENCODE_INACTIVITY_NOTICE_REPEAT_MS(),
        waitTickMs: OPENCODE_WAIT_TICK_MS(),
        keepaliveTypes: KEEPALIVE_EVENT_TYPES,
        isSessionEvent: (event) => {
          const sid = (event.properties as { sessionID?: string }).sessionID;
          return sid === undefined || sid === getActiveSession();
        },
        isProtectedEvent: (event) =>
          event.type === 'session.error' ||
          event.type === 'session.status' ||
          event.type === 'session.idle' ||
          event.type === 'permission.updated' ||
          event.type === 'message.part.updated' ||
          event.type === 'message.updated',
      });

      try {
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
          const turnInputId = turn.inputId;
          const staged = await stageOpenCodeAttachments(turn.attachments ?? []);
          log(
            JSON.stringify({
              severity: 'info',
              event: 'opencode_file_parts_prepared',
              file_part_count: staged.length,
              mime_summary: summarizeMimes(turn.attachments ?? []),
              run_id: extractRunId(turn.prompt),
            }),
          );
          const prompted = await promptSession(
            client.session,
            getActiveSession(),
            buildOpenCodePromptParts(turn.prompt, staged),
            modelForAttachments(staged),
          );
          const sessionId = prompted.sessionId;
          setActiveSession(sessionId);

          if (!initYielded || prompted.recoveredFromStale) {
            yield { type: 'init', continuation: sessionId };
            initYielded = true;
          }

          // The prompt() returned for this exact inputId — emit input-accepted.
          const turnScope: ProviderInputScope = relayMode ? 'relay' : turnIndex === 0 ? 'initial' : 'followup';
          turnIndex += 1;
          if (turnInputId) {
            yield { type: 'input-accepted', inputId: turnInputId, scope: turnScope };
          }

          const partTextByMessageId = new Map<string, string>();
          const roleByMessageId = new Map<string, string>();

          pump.beginTurn();

          /**
           * Build a typed terminal interruption ProviderEvent (Invariant 159:
           * provider error events are terminal recoverable interruptions, never
           * log-only). Preserves continuation by default; carries liveness,
           * input correlation, and any collected side-effect evidence as the
           * recovery seed.
           */
          const buildInterruption = (
            classification: string,
            agentMessage: string,
            fallbackUserMessage: string,
            liveness: OpenCodeLivenessSnapshot,
            continuationPolicy: ProviderContinuationPolicy,
          ): Extract<ProviderEvent, { type: 'interruption' }> => ({
            type: 'interruption',
            inputId: turnInputId,
            classification,
            severity: 'warn',
            terminal: true,
            agentMessage,
            fallbackUserMessage,
            continuationPolicy,
            attemptedContinuation: input.continuation,
            liveness: {
              configuredTimeoutMs: liveness.configuredTimeoutMs,
              elapsedMs: liveness.elapsedMs,
              lastEventType: liveness.lastEventType ?? undefined,
              lastMeaningfulEventAt: liveness.lastMeaningfulEventAt,
            },
            recoverySeed: collectedSideEffects.length > 0 ? { sideEffects: [...collectedSideEffects] } : undefined,
          });

          let terminalInterruption: Extract<ProviderEvent, { type: 'interruption' }> | null = null;

          try {
            turn: while (true) {
              if (aborted) {
                pump.dispose();
                return;
              }

              const res = await pump.next();

              if (res.kind === 'wait-tick') {
                yield { type: 'activity', source: 'provider_wait_tick', inputId: turnInputId };
                continue;
              }
              if (res.kind === 'inactivity-notice') {
                // Non-terminal liveness moment. Emit activity AND a provider
                // `notice` with agent-facing wording + liveness metadata. The
                // poll loop relays it through a separate restricted relay runtime
                // (or one sanitized direct fallback). NEVER pushed into the busy
                // turn; never clears continuation; never settles user rows.
                yield { type: 'activity', source: 'provider_internal', inputId: turnInputId };
                yield {
                  type: 'notice',
                  inputId: turnInputId,
                  classification: 'inactivity',
                  severity: 'info',
                  agentMessage:
                    "I'm still working on this — it's taking a while but the task is progressing. I'll keep going.",
                  fallbackUserMessage:
                    "I'm still working on your request — it's taking a while, but I'm on it.",
                  relayRecommended: true,
                  liveness: {
                    configuredTimeoutMs: res.metadata.configuredTimeoutMs,
                    elapsedMs: res.metadata.elapsedMs,
                    lastEventType: res.metadata.lastEventType ?? undefined,
                    lastMeaningfulEventAt: res.metadata.lastMeaningfulEventAt,
                  },
                };
                continue;
              }
              if (res.kind === 'keepalive') {
                yield { type: 'activity', source: 'sdk_keepalive', inputId: turnInputId };
                continue;
              }

              // Typed terminal pump result (transport/absolute/read/ended/
              // overflow). Emit one typed interruption, clear active tool state,
              // tear down THIS runtime, and end the turn (Invariant 159: never a
              // raw throw to the poll loop).
              if (res.kind !== 'event') {
                const err = res.error;
                log(
                  JSON.stringify({
                    severity: 'warn',
                    event: 'opencode_turn_interrupted',
                    classification: err.classification,
                    session_id: sessionId,
                    configured_timeout_ms: err.liveness.configuredTimeoutMs,
                    elapsed_ms: err.liveness.elapsedMs,
                    last_event_type: err.liveness.lastEventType,
                  }),
                );
                clearActiveTools();

                // Authoritative continuation clear, mechanism (b): a
                // transport/read/ended terminal interruption with an attempted
                // continuation TRIGGERS the positive existence check on the EXACT
                // attempted session id (Invariant 151/152). The check itself —
                // never any transport/timeout/not-found error TEXT — decides:
                //   - DEFINITIVE not-found (classifyContinuation ⇒ policy 'clear',
                //     reason session-missing) ⇒ emit clear-continuation now and
                //     clear the interruption's continuation policy.
                //   - inconclusive (existence check errors/transport-fails, or the
                //     session still exists) ⇒ keep 'preserve'; the bounded zombie
                //     limit remains the self-correcting backstop.
                // We consult the existence check on THIS controller BEFORE tearing
                // it down so the probe still has a usable client; a failed check
                // is correctly inconclusive ⇒ preserve.
                let continuationPolicy = err.continuationPolicy;
                const attempted = input.continuation;
                if (
                  !relayMode &&
                  attempted &&
                  (err.classification === 'transport-timeout' ||
                    err.classification === 'stream-read-error' ||
                    err.classification === 'stream-ended')
                ) {
                  // A throwing/transport-failing existence check is inconclusive,
                  // never a clear: swallow to 'preserve' (self-correcting via the
                  // bounded zombie backstop).
                  let classified: { policy: ProviderContinuationPolicy; reason?: string } = { policy: 'preserve' };
                  try {
                    classified = await classifyContinuation({
                      attemptedContinuation: attempted,
                      sessionExists: (id) => rt.sessionExists(id),
                    });
                  } catch {
                    classified = { policy: 'preserve' };
                  }
                  if (classified.policy === 'clear') {
                    log(
                      JSON.stringify({
                        severity: 'info',
                        event: 'opencode_continuation_cleared',
                        reason: classified.reason ?? 'session-missing',
                        session_id: attempted,
                        classification: err.classification,
                      }),
                    );
                    yield {
                      type: 'clear-continuation',
                      inputId: turnInputId,
                      reason: classified.reason ?? 'session_missing',
                      attemptedContinuation: attempted,
                    };
                    setActiveSession(undefined);
                    continuationPolicy = 'clear';
                  }
                }

                terminalInterruption = buildInterruption(
                  `opencode_${err.classification.replace(/-/g, '_')}`,
                  'I was interrupted mid-turn and stopped before finishing. Your request is preserved.',
                  err.fallbackUserMessage,
                  err.liveness,
                  continuationPolicy,
                );
                pump.dispose();
                teardownRuntime(err.classification);
                break turn;
              }

              const ev = res.event;
              yield { type: 'activity', source: 'sdk_event', inputId: turnInputId };

              switch (ev.type) {
                case 'message.updated': {
                  const info = ev.properties.info as { id?: string; role?: string } | undefined;
                  if (info?.id && info?.role) roleByMessageId.set(info.id, info.role);
                  break;
                }
                case 'message.part.updated': {
                  const part = ev.properties.part as
                    | { type?: string; messageID?: string; text?: string; tool?: string; callID?: string; state?: unknown }
                    | undefined;
                  if (part?.type === 'text' && part.messageID && part.text) {
                    partTextByMessageId.set(part.messageID, part.text);
                  }
                  // Native question detection (root-client surface).
                  const q = detectNativeQuestionPart(ev);
                  if (q) {
                    questionCallIds.add(q.callID);
                    questionTextByCallId.set(q.callID, q.questionText);
                  }
                  // Active tool tracking + side-effect enrichment for tool parts.
                  if (part?.type === 'tool' && part.callID && part.tool) {
                    const st = part.state as { status?: string; time?: { end?: number }; input?: Record<string, unknown> } | undefined;
                    const status = st?.status;
                    if (status === 'completed' || st?.time?.end) {
                      activeTools.delete(part.callID);
                      // Step 7: import already-staged JSONL evidence FIRST (the
                      // authoritative source), then enrich with the SDK tool
                      // completion. Only VALIDATED/authoritative entries are
                      // emitted as provider side-effect references — unsigned/
                      // unvalidated staged JSONL stays a hint and is never
                      // emitted (Task 1 keeps gmail entries unauthoritative).
                      for (const se of self.importStagedSideEffects(turnInputId)) {
                        if (emittedSideEffectIds.has(se.id)) continue;
                        emittedSideEffectIds.add(se.id);
                        collectedSideEffects.push(se);
                        yield { type: 'side-effect', sideEffect: se };
                      }
                      const sideEffect = self.captureToolSideEffect(part, turnInputId);
                      if (sideEffect && !emittedSideEffectIds.has(sideEffect.id)) {
                        emittedSideEffectIds.add(sideEffect.id);
                        collectedSideEffects.push(sideEffect);
                        yield { type: 'side-effect', sideEffect };
                      }
                      refreshActiveTool();
                      if (activeTools.size === 0) persistTool(null);
                    } else if (part.tool !== NATIVE_QUESTION_TOOL_ID) {
                      const declaredTimeoutMs = cappedDeclaredTimeoutMs(part, pump.liveness().elapsedMs);
                      activeTools.set(part.callID, {
                        callID: part.callID,
                        tool: part.tool,
                        declaredTimeoutMs,
                        startedAt: new Date().toISOString(),
                      });
                      refreshActiveTool();
                    }
                  }
                  break;
                }
                case 'permission.updated': {
                  const perm = ev.properties as { id?: string; sessionID?: string; callID?: string; type?: string; title?: string };
                  if (perm.sessionID !== sessionId || !perm.id) break;
                  // Native question permission: DENY via reject and emit a
                  // user-visible recovery interruption naming the blocked
                  // question, then clear continuation if not reusable.
                  const nq = detectNativeQuestionPermission(ev, questionCallIds);
                  if (nq) {
                    try {
                      await rt.denyPermission(sessionId, nq.permissionId, 'native_question_denied');
                    } catch (err) {
                      log(`Failed to deny native question permission: ${err instanceof Error ? err.message : String(err)}`);
                    }
                    const questionText =
                      (nq.callID && questionTextByCallId.get(nq.callID)) || nq.title || 'a question that requires your input';
                    log(
                      JSON.stringify({
                        severity: 'info',
                        event: 'opencode_native_question_denied',
                        session_id: sessionId,
                        permission_id: nq.permissionId,
                      }),
                    );
                    clearActiveTools();
                    // Non-cancellable native question / denial without reuse
                    // proof: clear continuation with a restart-capable recovery
                    // seed that VISIBLY contains the blocked question.
                    yield { type: 'clear-continuation', inputId: turnInputId, reason: 'native_question_denied', attemptedContinuation: input.continuation };
                    setActiveSession(undefined);
                    terminalInterruption = buildInterruption(
                      'opencode_native_question',
                      `I need your input to continue: ${questionText}`,
                      `I need more information before I can finish: ${questionText}`,
                      pump.liveness(),
                      'clear',
                    );
                    pump.dispose();
                    teardownRuntime('native_question_denied');
                    break turn;
                  }
                  // Non-question permission: auto-approve (existing behavior).
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  break;
                }
                case 'session.status': {
                  const props = ev.properties as {
                    sessionID?: string;
                    status?: { type?: string; attempt?: number; message?: string };
                  };
                  if (props.sessionID !== sessionId) break;
                  const st = props.status;
                  if (
                    st?.type === 'retry' &&
                    typeof st.attempt === 'number' &&
                    st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                    st.message
                  ) {
                    // Invariant 159: convert the retry-limit path into a typed,
                    // input-correlated terminal interruption (NOT a raw throw,
                    // NOT a direct activeSessionId clear). Continuation is
                    // preserved — a retry-limit is not stale-session proof.
                    clearActiveTools();
                    terminalInterruption = buildInterruption(
                      'opencode_session_retry_limit',
                      'The model hit its retry limit on this turn and I stopped before finishing. Your request is preserved.',
                      'The model had trouble finishing this turn. Your request is preserved — ask me to continue.',
                      pump.liveness(),
                      'preserve',
                    );
                    pump.dispose();
                    teardownRuntime('session_retry_limit');
                    break turn;
                  }
                  break;
                }
                case 'session.error': {
                  const props = ev.properties as { sessionID?: string; error?: unknown };
                  if (props.sessionID === sessionId || props.sessionID === undefined) {
                    // Invariant 159: typed terminal interruption, input-
                    // correlated, sanitized (no raw provider error text in the
                    // user-facing fallback). Continuation preserved.
                    log(
                      JSON.stringify({
                        severity: 'warn',
                        event: 'opencode_session_error',
                        session_id: sessionId,
                        message: sessionErrorMessage(props),
                      }),
                    );
                    clearActiveTools();
                    terminalInterruption = buildInterruption(
                      'opencode_session_error',
                      'The model reported an error on this turn and I stopped before finishing. Your request is preserved.',
                      'Something went wrong on this turn. Your request is preserved — ask me to continue.',
                      pump.liveness(),
                      'preserve',
                    );
                    pump.dispose();
                    teardownRuntime('session_error');
                    break turn;
                  }
                  break;
                }
                case 'session.idle': {
                  const sid = (ev.properties as { sessionID?: string }).sessionID;
                  if (sid === sessionId) {
                    pump.stop();
                    break turn;
                  }
                  break;
                }
                default:
                  break;
              }
            }
          } finally {
            await cleanupStagedAttachments(staged);
          }

          if (terminalInterruption) {
            yield terminalInterruption;
            return;
          }

          let resultText = '';
          for (const [msgId, role] of roleByMessageId) {
            if (role === 'assistant') {
              resultText = partTextByMessageId.get(msgId) ?? resultText;
            }
          }
          // A successful turn completes — clear any lingering active tool state.
          clearActiveTools();
          yield {
            type: 'result',
            text: resultText || null,
            inputId: turnInputId,
            resolvedInputIds: turnInputId ? [turnInputId] : [],
          };
        }
      } finally {
        pump.dispose();
      }
    }

    return {
      push: (message) => {
        pending.push(wrapTurnWithContext(normalizeQueryTurnInput(message), systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        // Relay aborts tear down only the relay's own controller and never
        // touch the instance's normal-turn session/runtime.
        setActiveSession(undefined);
        kick();
        teardownRuntime('abort');
      },
    };
  }

  /**
   * Best-effort side-effect evidence from a completed tool part. The
   * authoritative side-effect ledger is imported from the JSONL/tool boundary
   * (Step 7); a provider tool-completion event only REFERENCES/enriches it. We
   * surface a sanitized `tool_completed` reference here; GWS/summarize-dnd
   * durable kinds come from validated ledger import, never from this event.
   */
  private captureToolSideEffect(
    part: { tool?: string; callID?: string; state?: unknown },
    inputId: string,
  ): ProviderSideEffect | null {
    if (!part.callID || !part.tool) return null;
    // Only surface a reference for tools that performed real work; the native
    // question tool and read-only status tools are not side effects.
    if (part.tool === NATIVE_QUESTION_TOOL_ID) return null;
    const st = part.state as { status?: string; output?: unknown } | undefined;
    if (st?.status !== 'completed') return null;
    return {
      id: `tool-${part.callID}`,
      inputId,
      kind: 'tool_completed',
      label: part.tool,
      evidence: { tool: part.tool, call_id: part.callID },
      occurredAt: new Date().toISOString(),
    };
  }
}

/**
 * Cap a declared tool timeout by the absolute-ceiling budget so a tool cannot
 * widen host-sweep tolerance beyond the hard ceiling (Invariant 156):
 * min(OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS, ABSOLUTE - elapsed - safetyMargin).
 */
function cappedDeclaredTimeoutMs(
  part: { state?: unknown },
  elapsedTurnMs: number,
): number | null {
  const st = part.state as { input?: Record<string, unknown> } | undefined;
  const raw = st?.input?.timeout ?? st?.input?.timeoutMs ?? st?.input?.timeout_ms;
  const declared = typeof raw === 'number' && raw > 0 ? raw : null;
  if (declared == null) return null;
  const safetyMarginMs = 60_000;
  const budget = OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS() - elapsedTurnMs - safetyMarginMs;
  const capped = Math.min(OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS(), declared, budget);
  // A non-positive cap (the absolute-ceiling budget went negative) is NOT an
  // active long tool — never persist a 0-ms widening tool to container_state.
  // Treat it as null so refreshActiveTool/defaultPersistActiveTool skip it.
  return capped > 0 ? capped : null;
}

/** Default container_state writer for the active long tool (Step 8). */
function defaultPersistActiveTool(tool: ActiveOpenCodeTool | null): void {
  try {
    // A non-positive declared timeout (<= 0) is not a widening long tool — clear
    // rather than persist a 0-ms tool that would falsely claim a tool in flight.
    if (tool && tool.declaredTimeoutMs != null && tool.declaredTimeoutMs > 0) {
      setContainerToolInFlight(tool.tool, tool.declaredTimeoutMs);
    } else {
      clearContainerToolInFlight();
    }
  } catch {
    // container_state may be absent in some test setups — non-fatal.
  }
}

/**
 * Default Step 7 staged side-effect import: read the static workspace ledger,
 * import + validate it into `side_effect_ledger` (idempotent), and return the
 * AUTHORITATIVE entries only. Unsigned/unvalidated staged JSONL stays a hint and
 * is never returned (so it cannot become a provider side-effect reference until
 * Task 4B wires the real Ed25519 verify). Best-effort: returns [] if the ledger
 * is absent (no /workspace) or import fails.
 */
function defaultImportStagedSideEffects(inputId: string): ProviderSideEffect[] {
  try {
    const ledgerPath = process.env.NANOCLAW_SIDE_EFFECT_LEDGER || '/workspace/side-effects.jsonl';
    const allowedArtifactRoots = (process.env.NANOCLAW_SIDE_EFFECT_ARTIFACT_ROOTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    importSideEffectLedger({
      path: ledgerPath,
      allowedArtifactRoots: allowedArtifactRoots.length > 0 ? allowedArtifactRoots : undefined,
      gwsPublicKey: process.env.GWS_SIDE_EFFECT_VERIFY_KEY || undefined,
    });
    // Input-correlate the surfaced authoritative entries to the ACTIVE turn so a
    // follow-up turn's tool completion can never collect an unrelated earlier
    // authoritative entry into `collectedSideEffects` / a terminal recoverySeed.
    // A turn-less import (no inputId) returns the unfiltered authoritative set.
    return inputId ? getAuthoritativeSideEffects({ inputId }) : getAuthoritativeSideEffects();
  } catch {
    return [];
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
