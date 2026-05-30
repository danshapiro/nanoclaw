import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, afterEach } from 'bun:test';

import {
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  isStaleSessionError,
  promptSession,
  splitOpenCodeModel,
  stageOpenCodeAttachments,
} from './opencode.js';
import {
  classifyContinuation,
  isMissingOpenCodeSessionError,
  zombieDecision,
} from './opencode-errors.js';

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
  it('denies OpenCode native questions while leaving other tools allowed', () => {
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

    expect(config.permission).toEqual({
      '*': 'allow',
      question: 'deny',
    });
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
    expect(config).not.toHaveProperty('provider');
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
