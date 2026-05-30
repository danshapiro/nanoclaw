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
  type ProviderEvent,
  type ProviderOptions,
  type QueryAttachment,
  type QueryInput,
  type QueryTurnInput,
} from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { OpenCodeEventPump, type OpenCodePumpClock } from './opencode-events.js';
import { isMissingOpenCodeSessionError, isMissingSessionResultError, OpenCodeInterruptionError } from './opencode-errors.js';
import { sniffImageMime } from '../attachments.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

// Liveness/timeout knobs. The pump enforces the absolute ceiling itself,
// independent of heartbeat; transport timeout is the no-SSE death window.
const OPENCODE_TRANSPORT_TIMEOUT_MS = Number(process.env.OPENCODE_TRANSPORT_TIMEOUT_MS) || 30 * 60 * 1000;
const OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS = Number(process.env.OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS) || 6 * 60 * 60 * 1000;
const OPENCODE_INACTIVITY_NOTICE_MS = Number(process.env.OPENCODE_INACTIVITY_NOTICE_MS) || 5 * 60 * 1000;
const OPENCODE_WAIT_TICK_MS = Number(process.env.OPENCODE_WAIT_TICK_MS) || 60 * 1000;

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

const BUILTIN_AUTH_PROVIDERS = new Set(['anthropic', 'opencode', 'opencode-go', 'opencode-zen']);

export function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  if (!BUILTIN_AUTH_PROVIDERS.has(provider)) {
    throw new Error('Custom OpenCode providers are not supported without a OneCLI-managed credential path');
  }

  const providerOptions: Record<string, unknown> = {};

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: {
      '*': 'allow',
      question: 'deny',
    },
    autoupdate: false,
    snapshot: false,
    ...(Object.keys(providerOptions).length > 0 ? { provider: providerOptions } : {}),
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
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

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
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

  /**
   * Positive existence-check seam for the AUTHORITATIVE continuation classifier
   * (`classifyContinuation`). Backed by the SDK existence check
   * `client.session.get({ path: { id } })` — a missing-session SDK error means
   * the session is gone. Any other error is inconclusive and treated as "exists"
   * (preserve continuation; never clear on a transport error). Task 3's runtime
   * controller consumes this seam; Task 2 only needs a minimal injectable check.
   */
  async sessionExists(id: string): Promise<boolean> {
    try {
      const rt = await ensureSharedRuntime(this.options);
      const res = await rt.client.session.get({ path: { id } });
      if (res.error) {
        if (isMissingSessionResultError(res.error)) return false;
        // Inconclusive (transport/other) — do not treat as proof of absence.
        return true;
      }
      return Boolean(res.data);
    } catch {
      // Transport failure of the existence check itself is NOT proof the
      // session is gone — preserve continuation.
      return true;
    }
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
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

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      let turnIndex = 0;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

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
          self.activeSessionId,
          buildOpenCodePromptParts(turn.prompt, staged),
          modelForAttachments(staged),
        );
        const sessionId = prompted.sessionId;
        self.activeSessionId = sessionId;

        if (!initYielded || prompted.recoveredFromStale) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        // The prompt was accepted by the OpenCode session — emit input-accepted
        // for the matching id. (The full liveness/notice/interruption event
        // surface for OpenCode lands in Task 3; the input-accepted + result
        // resolution contract is wired here.)
        const turnScope = turnIndex === 0 ? 'initial' : 'followup';
        turnIndex += 1;
        if (turn.inputId) {
          yield { type: 'input-accepted', inputId: turn.inputId, scope: turnScope };
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();

        // Single-reader pump: the ONLY consumer of the shared OpenCode event
        // stream for this turn. It enforces the transport timeout AND, INDEPENDENT
        // of heartbeat, the absolute turn ceiling, and emits non-terminal
        // wait-tick/keepalive/inactivity results so long no-SSE work stays
        // state-preserving. Typed terminal results PRESERVE continuation — they
        // tear down the broken transport but never clear self.activeSessionId
        // (the authoritative continuation clear lives in the poll loop).
        const pump = new OpenCodeEventPump<{ type: string; properties: Record<string, unknown> }>({
          ...realTimerClock(),
          stream,
          sessionId,
          transportTimeoutMs: OPENCODE_TRANSPORT_TIMEOUT_MS,
          absoluteTurnTimeoutMs: OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS,
          inactivityNoticeMs: OPENCODE_INACTIVITY_NOTICE_MS,
          inactivityThrottleMs: OPENCODE_INACTIVITY_NOTICE_MS,
          waitTickMs: OPENCODE_WAIT_TICK_MS,
          keepaliveTypes: KEEPALIVE_EVENT_TYPES,
          isSessionEvent: (event) => {
            const sid = (event.properties as { sessionID?: string }).sessionID;
            return sid === undefined || sid === sessionId;
          },
          isProtectedEvent: (event) =>
            event.type === 'session.error' ||
            event.type === 'session.status' ||
            event.type === 'session.idle' ||
            event.type === 'permission.updated' ||
            event.type === 'message.part.updated' ||
            event.type === 'message.updated',
        });

        const onTerminalTransport = (err: OpenCodeInterruptionError): never => {
          // Preserve continuation: do NOT clear self.activeSessionId. Tear down
          // the broken transport so the next turn spawns a fresh stream against
          // the same session id.
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
          destroySharedRuntime();
          throw err;
        };

        try {
          turn: while (true) {
            if (aborted) {
              pump.stop();
              return;
            }

            const res = await pump.next();

            // Non-terminal liveness results keep the heartbeat fresh and the
            // long turn alive — they never end the turn or clear continuation.
            if (res.kind === 'wait-tick') {
              yield { type: 'activity', source: 'provider_wait_tick' };
              continue;
            }
            if (res.kind === 'inactivity-notice') {
              // Task 2 surfaces inactivity as liveness/activity only; the
              // Yente-authored relay + provider `notice` emission is Task 3.
              log(
                JSON.stringify({
                  severity: 'info',
                  event: 'opencode_inactivity_notice',
                  session_id: sessionId,
                  configured_timeout_ms: res.metadata.configuredTimeoutMs,
                  elapsed_ms: res.metadata.elapsedMs,
                  last_meaningful_event_at: res.metadata.lastMeaningfulEventAt,
                }),
              );
              yield { type: 'activity', source: 'provider_internal' };
              continue;
            }
            if (res.kind === 'keepalive') {
              yield { type: 'activity', source: 'sdk_keepalive' };
              continue;
            }

            // Typed terminal interruptions: preserve continuation, tear down
            // transport, propagate the sanitized typed error.
            if (res.kind !== 'event') {
              pump.stop();
              throw onTerminalTransport(res.error);
            }

            // res.kind === 'event' — a meaningful, session-scoped event.
            const ev = res.event;
            yield { type: 'activity', source: 'sdk_event' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
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
                  self.activeSessionId = undefined;
                  pump.stop();
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  pump.stop();
                  throw new Error(sessionErrorMessage(props));
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

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield {
          type: 'result',
          text: resultText || null,
          inputId: turn.inputId,
          resolvedInputIds: turn.inputId ? [turn.inputId] : [],
        };
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
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
