import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, afterEach } from 'bun:test';

import {
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  isStaleSessionError,
  OpenCodeProvider,
  promptSession,
  splitOpenCodeModel,
  stageOpenCodeAttachments,
  type OpenCodeRuntimeController,
  type OpenCodeRuntimeFactory,
  type OpenCodeRelayRuntimeFactory,
} from './opencode.js';
import {
  classifyContinuation,
  isMissingOpenCodeSessionError,
  zombieDecision,
} from './opencode-errors.js';
import type { OpenCodePumpClock } from './opencode-events.js';
import type { ProviderEvent } from './types.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-provider-test-'));
  tmpRoots.push(dir);
  return dir;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('OpenCode config', () => {
  it('disables the native question tool through tool availability (tools map), not permission.question', () => {
    const config = buildOpenCodeConfig({
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: ['/app/src/mcp-tools/index.js'],
          env: {
            SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
            SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
          },
        },
      },
    });

    // Native question is disabled via the typed tools map (the REAL surface),
    // NOT via permission.question (which is not a valid SDK 1.15.10 permission
    // key — keys are exactly edit|bash|webfetch|doom_loop|external_directory).
    expect((config.tools as Record<string, boolean>).question).toBe(false);
    // The permission map must NOT contain a bogus `question` key.
    expect(config.permission).not.toHaveProperty('question');
    // Other tools still allowed by default (permission '*': 'allow').
    expect((config.permission as Record<string, string>)['*']).toBe('allow');

    expect(config.mcp).toEqual({
      nanoclaw: {
        type: 'local',
        command: ['node', '/app/src/mcp-tools/index.js'],
        environment: {
          SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
          SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
        },
        enabled: true,
      },
    });
  });

  it('raises the model-provider request timeout under the ACTIVE provider name (never a provider named "options", never 0)', () => {
    const config = withEnv({ OPENCODE_PROVIDER: undefined, OPENCODE_MODEL_PROVIDER_TIMEOUT_MS: undefined }, () =>
      buildOpenCodeConfig({ mcpServers: undefined }),
    );
    const provider = config.provider as Record<string, { options?: { timeout?: number | false } }>;
    // Active provider defaults to 'anthropic'; timeout resolves UNDER that key.
    expect(provider.anthropic).toBeDefined();
    const timeout = provider.anthropic.options?.timeout;
    expect(timeout === false || (typeof timeout === 'number' && timeout > 0)).toBe(true);
    expect(timeout).not.toBe(0);
    // A provider literally named "options" is a bug and must NOT exist.
    expect(provider).not.toHaveProperty('options');
  });

  it('applies the model-provider timeout under a non-default active provider name', () => {
    const config = withEnv(
      { OPENCODE_PROVIDER: 'opencode-go', OPENCODE_MODEL_PROVIDER_TIMEOUT_MS: '12345' },
      () => buildOpenCodeConfig({ mcpServers: undefined }),
    );
    const provider = config.provider as Record<string, { options?: { timeout?: number | false } }>;
    expect(provider['opencode-go']?.options?.timeout).toBe(12345);
    expect(provider).not.toHaveProperty('options');
  });

  it('relay-mode config denies mutation/shell/file/web/question via REAL ids; reachable set = allowlist', () => {
    const config = buildOpenCodeConfig({ mcpServers: undefined }, { relayMode: true, relayRouteKey: 'discord:dm:1' });
    const permission = config.permission as Record<string, string>;
    expect(permission.bash).toBe('deny');
    expect(permission.webfetch).toBe('deny');
    expect(permission.edit).toBe('deny');
    expect(permission.external_directory).toBe('deny');
    const tools = config.tools as Record<string, boolean>;
    for (const id of ['bash', 'edit', 'write', 'apply_patch', 'webfetch', 'websearch', 'task', 'question']) {
      expect(tools[id]).toBe(false);
    }
    // Read-only status tools NOT disabled.
    expect(tools.read).not.toBe(false);
    expect(tools.grep).not.toBe(false);
  });
});

describe('OpenCodeProvider stale session handling', () => {
  it('classifies explicit missing-session text as stale, but NOT transport/event-timeout text', () => {
    expect(isStaleSessionError(new Error('NotFoundError: session not found'))).toBe(true);
    expect(isStaleSessionError(new Error('no conversation found'))).toBe(true);
    // Corrected behavior (Hard Invariant 151): a stalled transport / "event
    // timeout" is NOT stale-session proof — preserving long-running sessions.
    expect(isStaleSessionError(new Error('OpenCode transport timeout after 1800000ms'))).toBe(false);
    expect(isStaleSessionError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('Hard-Invariant-151 regression: transport-class errors are NOT stale-session proof', () => {
    // These previously matched STALE_SESSION_RE and caused the Dvora false-positive.
    expect(isStaleSessionError(new Error('ECONNRESET while reading'))).toBe(false);
    expect(isStaleSessionError(new Error('HTTP 404 from stream'))).toBe(false);
    expect(isStaleSessionError(new Error('connection reset by peer'))).toBe(false);
    expect(isStaleSessionError(new Error('NotFoundError: unrelated lookup failed'))).toBe(false);
    // Genuine missing-session signals must still match.
    expect(isStaleSessionError(new Error('session ses_x not found'))).toBe(true);
    expect(isStaleSessionError(new Error('no conversation found'))).toBe(true);
  });

  it('retries prompt_async once with a fresh session when the persisted session is stale', async () => {
    const promptedIds: string[] = [];
    const client = {
      create: async () => ({
        data: { id: 'fresh-session' },
        error: undefined,
        request: {} as Request,
        response: {} as Response,
      }),
      promptAsync: async ({ path }: { path: { id: string } }) => {
        promptedIds.push(path.id);
        if (path.id === 'stale-session') {
          return {
            data: undefined,
            error: { name: 'NotFoundError', message: 'session not found' },
            request: {} as Request,
            response: {} as Response,
          };
        }
        return {
          data: true,
          error: undefined,
          request: {} as Request,
          response: {} as Response,
        };
      },
    };

    await expect(promptSession(client, 'stale-session', 'hello')).resolves.toEqual({
      sessionId: 'fresh-session',
      recoveredFromStale: true,
    });
    expect(promptedIds).toEqual(['stale-session', 'fresh-session']);
  });
});

describe('OpenCode file parts', () => {
  it('does not override built-in OpenCode Go provider auth wiring', () => {
    const config = withEnv(
      {
        OPENCODE_PROVIDER: 'opencode-go',
        OPENCODE_MODEL: 'opencode-go/qwen3.6-plus',
        OPENCODE_SMALL_MODEL: 'opencode-go/deepseek-v4-flash',
        OPENCODE_API_KEY: 'secret-key',
      },
      () => buildOpenCodeConfig({ mcpServers: undefined }),
    );

    expect(config).toMatchObject({
      model: 'opencode-go/qwen3.6-plus',
      small_model: 'opencode-go/deepseek-v4-flash',
      enabled_providers: ['opencode-go'],
    });
    // The ONLY provider override is the long-turn request timeout under the
    // active provider name — it does NOT inject api/apiKey/auth wiring, so the
    // built-in OpenCode Go auth path is untouched.
    const provider = config.provider as Record<string, Record<string, unknown>>;
    expect(Object.keys(provider)).toEqual(['opencode-go']);
    expect(provider['opencode-go']).toEqual({ options: { timeout: 21600000 } });
    expect(provider['opencode-go']).not.toHaveProperty('api');
    expect(provider['opencode-go']).not.toHaveProperty('apiKey');
  });

  it('fails clearly for custom OpenCode providers after raw key removal', () => {
    expect(() =>
      withEnv(
        {
          OPENCODE_PROVIDER: 'custom-provider',
          OPENCODE_API_KEY: 'onecli-managed',
          OPENCODE_MODEL: undefined,
          OPENCODE_SMALL_MODEL: undefined,
        },
        () => buildOpenCodeConfig({ mcpServers: undefined }),
      ),
    ).toThrow('Custom OpenCode providers are not supported without a OneCLI-managed credential path');
  });

  it('builds text followed by escaped file parts', () => {
    const parts = buildOpenCodePromptParts('What is in the picture?', [
      {
        path: '/tmp/Screenshot 2026-05-24 (1)#final.png',
        filename: 'Screenshot 2026-05-24 (1)#final.png',
        mime: 'image/png',
        sizeBytes: 8,
      },
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'What is in the picture?' },
      {
        type: 'file',
        mime: 'image/png',
        url: 'file:///tmp/Screenshot%202026-05-24%20(1)%23final.png',
        filename: 'Screenshot 2026-05-24 (1)#final.png',
      },
    ]);
  });

  it('omits file parts when there are no attachments', () => {
    expect(buildOpenCodePromptParts('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('passes file parts to promptAsync', async () => {
    const bodies: unknown[] = [];
    const client = {
      create: async () => ({
        data: { id: 'session-1' },
        error: undefined,
        request: {} as Request,
        response: {} as Response,
      }),
      promptAsync: async ({ body }: { body: unknown }) => {
        bodies.push(body);
        return {
          data: true,
          error: undefined,
          request: {} as Request,
          response: {} as Response,
        };
      },
    };

    await promptSession(client, undefined, [
      { type: 'text', text: 'hello' },
      { type: 'file', mime: 'image/png', url: 'file:///tmp/image.png', filename: 'image.png' },
    ]);

    expect(bodies).toEqual([
      {
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', mime: 'image/png', url: 'file:///tmp/image.png', filename: 'image.png' },
        ],
      },
    ]);
  });

  it('can route file-part prompts to a per-prompt vision model', async () => {
    const bodies: unknown[] = [];
    const client = {
      create: async () => ({
        data: { id: 'session-1' },
        error: undefined,
        request: {} as Request,
        response: {} as Response,
      }),
      promptAsync: async ({ body }: { body: unknown }) => {
        bodies.push(body);
        return {
          data: true,
          error: undefined,
          request: {} as Request,
          response: {} as Response,
        };
      },
    };

    await promptSession(
      client,
      undefined,
      [
        { type: 'text', text: 'hello' },
        { type: 'file', mime: 'image/png', url: 'file:///tmp/image.png', filename: 'image.png' },
      ],
      splitOpenCodeModel('opencode-go/qwen3.6-plus'),
    );

    expect(bodies).toEqual([
      {
        model: {
          providerID: 'opencode-go',
          modelID: 'qwen3.6-plus',
        },
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', mime: 'image/png', url: 'file:///tmp/image.png', filename: 'image.png' },
        ],
      },
    ]);
  });

  it('parses provider-qualified OpenCode model ids', () => {
    expect(splitOpenCodeModel('opencode-go/qwen3.6-plus')).toEqual({
      providerID: 'opencode-go',
      modelID: 'qwen3.6-plus',
    });
    expect(splitOpenCodeModel('qwen3.6-plus')).toBeUndefined();
  });

  it('stages bytes to runner-private files and revalidates size and MIME', async () => {
    const dir = tmpDir();
    const source = path.join(dir, 'source image.png');
    fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const staged = await stageOpenCodeAttachments([
      { path: source, filename: 'source image.png', mime: 'image/png', sizeBytes: 8 },
    ]);

    expect(staged).toHaveLength(1);
    expect(staged[0].path).not.toBe(source);
    expect(staged[0].path).toContain('nanoclaw-opencode-files-');
    expect(fs.readFileSync(staged[0].path)).toEqual(fs.readFileSync(source));
    fs.rmSync(path.dirname(staged[0].path), { recursive: true, force: true });
  });

  it('rejects staged MIME mismatches', async () => {
    const dir = tmpDir();
    const source = path.join(dir, 'source.png');
    fs.writeFileSync(source, Buffer.from([0xff, 0xd8, 0xff, 0x00]));

    await expect(
      stageOpenCodeAttachments([{ path: source, filename: 'source.png', mime: 'image/png', sizeBytes: 4 }]),
    ).rejects.toThrow(/MIME mismatch/);
  });
});

describe('isMissingOpenCodeSessionError (trigger-only predicate)', () => {
  // Generic transport / read / timeout / bare-404 strings are NEVER a verbatim
  // attempted-session match, so they must not trigger.
  it('does not match generic transport/read/timeout/404/NotFound strings', () => {
    expect(isMissingOpenCodeSessionError(new Error('OpenCode event timeout (300000ms)'), 'ses_old')).toBe(false);
    expect(isMissingOpenCodeSessionError(new Error('ECONNRESET while reading OpenCode events'), 'ses_old')).toBe(false);
    expect(isMissingOpenCodeSessionError(new Error('HTTP 404 from OpenCode event stream'), 'ses_old')).toBe(false);
    expect(isMissingOpenCodeSessionError(new Error('NotFoundError'), 'ses_old')).toBe(false);
  });

  it('matches only when the attempted session id appears verbatim with a missing-session phrase', () => {
    expect(isMissingOpenCodeSessionError(new Error('OpenCode promptAsync: session ses_old not found'), 'ses_old')).toBe(
      true,
    );
    expect(
      isMissingOpenCodeSessionError(new Error('OpenCode promptAsync: session ses_other not found'), 'ses_old'),
    ).toBe(false);
  });

  it('requires attempted session context (never matches without it)', () => {
    expect(isMissingOpenCodeSessionError(new Error('session ses_old not found'), undefined)).toBe(false);
    expect(isMissingOpenCodeSessionError(new Error('session ses_old not found'), '')).toBe(false);
  });
});

describe('classifyContinuation (authoritative clear policy)', () => {
  it('clears only when the positive existence check proves the session is gone', async () => {
    expect(await classifyContinuation({ attemptedContinuation: 'ses_old', sessionExists: async () => false })).toMatchObject(
      { policy: 'clear', reason: 'session-missing' },
    );
  });

  it('preserves continuation on a bare 404 when the session still exists', async () => {
    expect(
      await classifyContinuation({
        attemptedContinuation: 'ses_old',
        sessionExists: async () => true,
        err: new Error('HTTP 404 from OpenCode event stream'),
      }),
    ).toMatchObject({ policy: 'preserve' });
  });

  it('preserves continuation when there is no existence check (no proof available)', async () => {
    expect(
      await classifyContinuation({
        attemptedContinuation: 'ses_old',
        err: new Error('ECONNRESET while reading OpenCode events'),
      }),
    ).toMatchObject({ policy: 'preserve' });
  });
});

describe('zombieDecision (bounded zombie backstop)', () => {
  it('clears with user-visible restart at the failure limit', () => {
    expect(zombieDecision({ continuation: 'ses_old', consecutiveTerminalFailures: 3, limit: 3 })).toMatchObject({
      clear: true,
      userVisibleRestart: true,
    });
  });

  it('does not clear below the failure limit', () => {
    expect(zombieDecision({ continuation: 'ses_old', consecutiveTerminalFailures: 2, limit: 3 })).toMatchObject({
      clear: false,
    });
  });
});

// ── Runtime-controller seam tests (Task 3 Steps 1/4/5/6/7/8) ────────────────
// Deterministic clock + a controllable fake event stream + a fake controller
// let us drive the provider's pump-based turn loop without spawning a server.

class FakeClock {
  private current = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; cb: () => void }>();
  now = (): number => this.current;
  schedule = (delayMs: number, cb: () => void): (() => void) => {
    const id = this.seq++;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), cb });
    return () => {
      this.timers.delete(id);
    };
  };
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const t = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.current = t.at;
      t.cb();
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }
}

type Ev = { type: string; properties: Record<string, unknown> };

class FakeStream {
  private queue: Array<{ value?: Ev; done?: boolean; error?: unknown }> = [];
  private waiter: ((r: { value?: Ev; done?: boolean; error?: unknown }) => void) | null = null;
  push(value: Ev): void {
    this.deliver({ value });
  }
  end(): void {
    this.deliver({ done: true });
  }
  private deliver(r: { value?: Ev; done?: boolean; error?: unknown }): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(r);
    } else {
      this.queue.push(r);
    }
  }
  next(): Promise<IteratorResult<Ev, void>> {
    return new Promise((resolve, reject) => {
      const settle = (r: { value?: Ev; done?: boolean; error?: unknown }) => {
        if (r.error !== undefined) reject(r.error);
        else if (r.done) resolve({ done: true, value: undefined });
        else resolve({ done: false, value: r.value as Ev });
      };
      if (this.queue.length > 0) settle(this.queue.shift()!);
      else this.waiter = (r) => settle(r);
    });
  }
  return(): Promise<IteratorResult<Ev, void>> {
    return Promise.resolve({ done: true, value: undefined });
  }
}

const TEST_SESSION = 'ses_test_runtime';

class FakeController implements OpenCodeRuntimeController {
  destroyed: string[] = [];
  deniedPermissions: Array<{ sessionId: string; permissionId: string }> = [];
  permissionReplies: Array<{ permissionID: string; response: string }> = [];
  sessionExistsResult = true;

  readonly client: OpenCodeRuntimeController['client'];

  constructor(readonly stream: FakeStream) {
    const self = this;
    this.client = {
      session: {
        async create() {
          return { data: { id: TEST_SESSION }, error: undefined } as never;
        },
        async promptAsync() {
          return { data: true, error: undefined } as never;
        },
        async get() {
          return self.sessionExistsResult ? { data: { id: TEST_SESSION } } : { error: { name: 'NotFoundError' } };
        },
      },
      async postSessionIdPermissionsPermissionId(args) {
        self.permissionReplies.push({ permissionID: args.path.permissionID, response: args.body.response });
        return true;
      },
    };
  }
  async denyPermission(sessionId: string, permissionId: string): Promise<void> {
    this.deniedPermissions.push({ sessionId, permissionId });
  }
  async sessionExists(): Promise<boolean> {
    return this.sessionExistsResult;
  }
  destroy(reason: string): void {
    this.destroyed.push(reason);
  }
}

function makeProvider(opts: {
  clock?: FakeClock;
  stream: FakeStream;
  persistActiveTool?: (tool: { tool: string; declaredTimeoutMs: number | null } | null) => void;
}): { provider: OpenCodeProvider; controller: FakeController; state: { relayCalls: number } } {
  const controller = new FakeController(opts.stream);
  const state = { relayCalls: 0 };
  const factory: OpenCodeRuntimeFactory & OpenCodeRelayRuntimeFactory = {
    async createRuntime() {
      return controller;
    },
    async createRelayRuntime() {
      state.relayCalls++;
      return controller;
    },
  };
  const clock = opts.clock ?? new FakeClock();
  const provider = new OpenCodeProvider(
    { mcpServers: { nanoclaw: { command: 'bun', args: ['x'], env: {} } } },
    {
      runtimeFactory: factory,
      clockFactory: () => clock as unknown as OpenCodePumpClock,
      persistActiveTool: opts.persistActiveTool,
    },
  );
  return { provider, controller, state };
}

describe('OpenCodeProvider runtime controller (event-driven)', () => {
  it('emits input-accepted after prompt() returns, then result on session.idle', async () => {
    const stream = new FakeStream();
    const { provider } = makeProvider({ stream });
    const query = provider.query({ inputId: 'in-1', prompt: 'hello', cwd: '/workspace/agent' });

    const events: ProviderEvent[] = [];
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'result') break;
      }
    })();
    // Let prompt() resolve and input-accepted emit, then drive the stream.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    stream.push({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' }, sessionID: TEST_SESSION } });
    stream.push({ type: 'message.part.updated', properties: { sessionID: TEST_SESSION, part: { type: 'text', messageID: 'm1', text: 'Done.' } } });
    stream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await reader;

    const accepted = events.find((e) => e.type === 'input-accepted');
    expect(accepted).toMatchObject({ type: 'input-accepted', inputId: 'in-1', scope: 'initial' });
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ type: 'result', text: 'Done.', resolvedInputIds: ['in-1'] });
  });

  it('denies a native question via reject and emits clear-continuation + a recovery interruption naming the question', async () => {
    const stream = new FakeStream();
    const { provider, controller } = makeProvider({ stream });
    const query = provider.query({ inputId: 'in-q', prompt: 'draft an email', cwd: '/workspace/agent' });

    const events: ProviderEvent[] = [];
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'interruption') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    // A native question tool part, then the matching permission.
    stream.push({
      type: 'message.part.updated',
      properties: {
        sessionID: TEST_SESSION,
        part: { type: 'tool', tool: 'question', callID: 'call-1', messageID: 'm1', state: { input: { question: "What is Matt Van Horn's email?" } } },
      },
    });
    stream.push({
      type: 'permission.updated',
      properties: { id: 'perm-1', callID: 'call-1', type: 'question', sessionID: TEST_SESSION, title: 'question' },
    });
    await reader;

    expect(controller.deniedPermissions).toContainEqual({ sessionId: TEST_SESSION, permissionId: 'perm-1' });
    const clear = events.find((e) => e.type === 'clear-continuation');
    expect(clear).toMatchObject({ type: 'clear-continuation', reason: 'native_question_denied' });
    const interruption = events.find((e) => e.type === 'interruption');
    expect(interruption).toBeDefined();
    expect((interruption as { agentMessage: string }).agentMessage).toContain("Matt Van Horn's email");
    expect((interruption as { continuationPolicy: string }).continuationPolicy).toBe('clear');
  });

  it('auto-approves a non-question permission with always', async () => {
    const stream = new FakeStream();
    const { provider, controller } = makeProvider({ stream });
    const query = provider.query({ inputId: 'in-p', prompt: 'do a thing', cwd: '/workspace/agent' });
    const reader = (async () => {
      for await (const e of query.events) {
        if (e.type === 'result') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    stream.push({ type: 'permission.updated', properties: { id: 'perm-x', type: 'bash', sessionID: TEST_SESSION } });
    stream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await reader;
    expect(controller.permissionReplies).toContainEqual({ permissionID: 'perm-x', response: 'always' });
  });

  it('emits a typed terminal interruption (not a raw throw) on session.error, preserving continuation', async () => {
    const stream = new FakeStream();
    const { provider } = makeProvider({ stream });
    const query = provider.query({ inputId: 'in-e', prompt: 'work', cwd: '/workspace/agent', continuation: TEST_SESSION });
    const events: ProviderEvent[] = [];
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'interruption') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    stream.push({ type: 'session.error', properties: { sessionID: TEST_SESSION, error: { data: { message: 'boom' } } } });
    await reader;
    const interruption = events.find((e) => e.type === 'interruption') as { classification: string; continuationPolicy: string; fallbackUserMessage: string; terminal: boolean };
    expect(interruption.classification).toBe('opencode_session_error');
    expect(interruption.continuationPolicy).toBe('preserve');
    expect(interruption.terminal).toBe(true);
    // Sanitized: no raw provider text in the user-facing fallback.
    expect(interruption.fallbackUserMessage).not.toContain('boom');
  });

  it('captures a completed tool as a side-effect reference event before result', async () => {
    const stream = new FakeStream();
    const { provider } = makeProvider({ stream });
    const query = provider.query({ inputId: 'in-s', prompt: 'run tool', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'result') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    stream.push({
      type: 'message.part.updated',
      properties: { sessionID: TEST_SESSION, part: { type: 'tool', tool: 'bash', callID: 'c-1', messageID: 'm1', state: { status: 'completed' } } },
    });
    stream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await reader;
    const se = events.find((e) => e.type === 'side-effect') as { sideEffect: { kind: string; label: string; inputId: string } } | undefined;
    expect(se).toBeDefined();
    expect(se!.sideEffect).toMatchObject({ kind: 'tool_completed', label: 'bash', inputId: 'in-s' });
    // Side-effect emitted BEFORE the result.
    const seIdx = events.findIndex((e) => e.type === 'side-effect');
    const resIdx = events.findIndex((e) => e.type === 'result');
    expect(seIdx).toBeLessThan(resIdx);
  });

  it('persists the active long tool to container_state and clears it on completion', async () => {
    const stream = new FakeStream();
    const persisted: Array<{ tool: string; declaredTimeoutMs: number | null } | null> = [];
    const { provider } = makeProvider({ stream, persistActiveTool: (t) => persisted.push(t) });
    const query = provider.query({ inputId: 'in-t', prompt: 'long tool', cwd: '/workspace/agent' });
    const reader = (async () => {
      for await (const e of query.events) {
        if (e.type === 'result') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    // A long-running bash with a declared timeout starts (no completion yet).
    stream.push({
      type: 'message.part.updated',
      properties: { sessionID: TEST_SESSION, part: { type: 'tool', tool: 'bash', callID: 'c-long', messageID: 'm1', state: { status: 'running', input: { timeout: 600000 } } } },
    });
    // It completes.
    stream.push({
      type: 'message.part.updated',
      properties: { sessionID: TEST_SESSION, part: { type: 'tool', tool: 'bash', callID: 'c-long', messageID: 'm1', state: { status: 'completed' } } },
    });
    stream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await reader;
    // At least one persist with the declared timeout, and a final null clear.
    const persistedTool = persisted.find((p) => p && p.tool === 'bash');
    expect(persistedTool).toBeTruthy();
    expect(persistedTool!.declaredTimeoutMs).toBeGreaterThan(0);
    expect(persisted[persisted.length - 1]).toBeNull();
  });

  it('emits a notice (not pushed into the busy turn) on inactivity and keeps the turn alive', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream();
    process.env.OPENCODE_INACTIVITY_NOTICE_MS = '300000';
    process.env.OPENCODE_TRANSPORT_TIMEOUT_MS = '1800000';
    // Wait-tick larger than the inactivity point so the inactivity notice is the
    // first armed timer to fire — avoids wait-tick re-arm round-trip flakiness
    // under the virtual clock.
    process.env.OPENCODE_WAIT_TICK_MS = '1200000';
    const { provider } = makeProvider({ clock, stream });
    const query = provider.query({ inputId: 'in-n', prompt: 'long work', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    let stop = false;
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'notice') {
          stop = true;
          break;
        }
        if (e.type === 'result' || e.type === 'interruption') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    // No meaningful events; advance past the inactivity notice point.
    await clock.advance(300000);
    await new Promise((r) => setTimeout(r, 5));
    await reader;
    delete process.env.OPENCODE_INACTIVITY_NOTICE_MS;
    delete process.env.OPENCODE_TRANSPORT_TIMEOUT_MS;
    delete process.env.OPENCODE_WAIT_TICK_MS;
    expect(stop).toBe(true);
    const notice = events.find((e) => e.type === 'notice') as { classification: string; relayRecommended: boolean; inputId: string } | undefined;
    expect(notice).toBeDefined();
    expect(notice!.classification).toBe('inactivity');
    expect(notice!.relayRecommended).toBe(true);
    expect(notice!.inputId).toBe('in-n');
    query.abort();
  });

  it('declares separate-runtime relay capability', () => {
    const stream = new FakeStream();
    const { provider } = makeProvider({ stream });
    expect(provider.capabilities.supportsSeparateRelayRuntime).toBe(true);
    expect(provider.capabilities.relayToolPolicy).toBe('status_only');
  });

  it('yields a terminal opencode_transport_timeout interruption that preserves continuation and clears tool state', async () => {
    const clock = new FakeClock();
    const stream = new FakeStream();
    const persisted: Array<{ tool: string; declaredTimeoutMs: number | null } | null> = [];
    process.env.OPENCODE_TRANSPORT_TIMEOUT_MS = '1800000';
    process.env.OPENCODE_WAIT_TICK_MS = '3600000';
    process.env.OPENCODE_INACTIVITY_NOTICE_MS = '3600000';
    const { provider } = makeProvider({ clock, stream, persistActiveTool: (t) => persisted.push(t) });
    const query = provider.query({ inputId: 'in-tt', prompt: 'no sse work', cwd: '/workspace/agent', continuation: TEST_SESSION });
    const events: ProviderEvent[] = [];
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'interruption') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    // A long tool starts (so we can assert tool state is cleared on timeout).
    stream.push({
      type: 'message.part.updated',
      properties: { sessionID: TEST_SESSION, part: { type: 'tool', tool: 'bash', callID: 'c-tt', messageID: 'm1', state: { status: 'running', input: { timeout: 600000 } } } },
    });
    await new Promise((r) => setTimeout(r, 5));
    // No further SSE — advance past the transport-death window.
    await clock.advance(1800000);
    await new Promise((r) => setTimeout(r, 5));
    await reader;
    delete process.env.OPENCODE_TRANSPORT_TIMEOUT_MS;
    delete process.env.OPENCODE_WAIT_TICK_MS;
    delete process.env.OPENCODE_INACTIVITY_NOTICE_MS;
    const interruption = events.find((e) => e.type === 'interruption') as { classification: string; continuationPolicy: string; fallbackUserMessage: string } | undefined;
    expect(interruption).toBeDefined();
    expect(interruption!.classification).toBe('opencode_transport_timeout');
    expect(interruption!.continuationPolicy).toBe('preserve');
    // No 'OpenCode event timeout' raw text leaks to the user-facing fallback.
    expect(interruption!.fallbackUserMessage).not.toContain('event timeout');
    // Active tool state was cleared on the terminal interruption.
    expect(persisted[persisted.length - 1]).toBeNull();
  });

  it('a concurrent relay query uses a SEPARATE controller and never destroys the original turn', async () => {
    const mainStream = new FakeStream();
    const relayStream = new FakeStream();
    const mainController = new FakeController(mainStream);
    const relayController = new FakeController(relayStream);
    let relayRouteKey: string | undefined;
    const provider = new OpenCodeProvider(
      { mcpServers: { nanoclaw: { command: 'bun', args: ['x'], env: {} } } },
      {
        runtimeFactory: {
          async createRuntime() {
            return mainController;
          },
          async createRelayRuntime(_options, policy) {
            relayRouteKey = policy.routeKey;
            return relayController;
          },
        },
        clockFactory: () => new FakeClock() as unknown as OpenCodePumpClock,
      },
    );

    // Start the original (normal) turn but keep it open.
    const mainQuery = provider.query({ inputId: 'in-main', prompt: 'long', cwd: '/workspace/agent' });
    let mainResult = false;
    const mainReader = (async () => {
      for await (const e of mainQuery.events) {
        if (e.type === 'result') {
          mainResult = true;
          break;
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 5));

    // Concurrently run a relay query (relayMode) — it must NOT destroy the main
    // controller and must use its own relay controller.
    const relayQuery = provider.query({ inputId: 'in-relay', prompt: 'status', cwd: '/workspace/agent', relayMode: true, relayDeadlineMs: 30000, toolPolicy: 'status_only' });
    const relayReader = (async () => {
      for await (const e of relayQuery.events) {
        if (e.type === 'result') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    relayStream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await relayReader;

    // The relay used its own controller (createRelayRuntime), with a route key.
    expect(relayRouteKey).toBeDefined();
    // The original turn's controller was NOT destroyed by the relay.
    expect(mainController.destroyed).toHaveLength(0);

    // Now the main turn can complete normally.
    mainStream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await mainReader;
    expect(mainResult).toBe(true);
  });

  it('imports staged ledger evidence on tool completion and emits ONLY authoritative side-effect references', async () => {
    const stream = new FakeStream();
    const controller = new FakeController(stream);
    // Seam: staged ledger import returns one authoritative entry + one hint.
    const imported: ProviderEvent[] = [];
    const provider = new OpenCodeProvider(
      { mcpServers: { nanoclaw: { command: 'bun', args: ['x'], env: {} } } },
      {
        runtimeFactory: {
          async createRuntime() {
            return controller;
          },
          async createRelayRuntime() {
            return controller;
          },
        },
        clockFactory: () => new FakeClock() as unknown as OpenCodePumpClock,
        importStagedSideEffects: (inputId: string) => [
          // Authoritative validated entry (emitted).
          {
            id: 'audit-validated',
            inputId,
            kind: 'summarize_dnd_summary_artifact' as const,
            label: 'summarize_dnd',
            evidence: { artifact_path: '/allowed/out.md' },
            occurredAt: new Date().toISOString(),
          },
        ],
      },
    );
    const query = provider.query({ inputId: 'in-imp', prompt: 'summarize', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const reader = (async () => {
      for await (const e of query.events) {
        events.push(e);
        if (e.type === 'side-effect') imported.push(e);
        if (e.type === 'result') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    stream.push({
      type: 'message.part.updated',
      properties: { sessionID: TEST_SESSION, part: { type: 'tool', tool: 'bash', callID: 'gws-1', messageID: 'm1', state: { status: 'completed' } } },
    });
    stream.push({ type: 'session.idle', properties: { sessionID: TEST_SESSION } });
    await reader;
    const sideEffects = events.filter((e) => e.type === 'side-effect') as Array<{ sideEffect: { id: string; kind: string } }>;
    // The authoritative imported entry is emitted (kind summarize_dnd_summary_artifact).
    expect(sideEffects.some((e) => e.sideEffect.id === 'audit-validated')).toBe(true);
  });
});
