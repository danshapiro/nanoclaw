import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  applyOneCliGatewayForContainerArgs,
  assertNoReservedAgentCommandCollisionsShell,
  extractDockerEnvArgsToFile,
  remapCaEnvToCombinedBundle,
  buildManagedReposIpcMount,
  buildManagedReposMounts,
  buildLocalSkillsMount,
  resolveAgentImageForRun,
  resolveProviderContribution,
  resolveProviderName,
} from './container-runner.js';
import { AgentMcpCredentialUnavailableError, type AgentMcpBridgeOptions } from './agent-mcp-bridge.js';
import { log } from './log.js';
import type { AgentMcpConfigForGroup } from './agent-mcp-config.js';
import type { ContainerConfig } from './container-config.js';
import { resolveGwsSideEffectVerifyKey } from './gws-side-effect-key.js';
import { registerProviderContainerConfig, registerProviderPrepare } from './providers/provider-container-registry.js';
import type { AgentGroup } from './types.js';

/**
 * Parse the docker --env-file referenced by the spawn args. The file survives
 * until the fake child emits output/close, so tests can read it after wake.
 */
function readSpawnEnvFile(args: string[]): { path: string; raw: string; env: Map<string, string> } {
  const index = args.indexOf('--env-file');
  if (index === -1 || !args[index + 1]) throw new Error('spawn args contain no --env-file');
  const envFilePath = args[index + 1];
  const raw = fs.readFileSync(envFilePath, 'utf-8');
  const env = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { path: envFilePath, raw, env };
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeChildProcess(pid = 12345): NodeJS.EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  stdin: { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdin: { end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.pid = pid;
  proc.kill = vi.fn();
  proc.stdin = { end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

type StartBridgeResult = {
  serverName: string;
  hostSocketDir: string;
  hostSocketPath: string;
  containerSocketDir: string;
  containerSocketPath: string;
  authDir: string;
  stop: ReturnType<typeof vi.fn>;
};

async function loadContainerRunnerHarness(
  options: {
    mcpConfigForGroup?: (folder: string) => AgentMcpConfigForGroup;
    startBridge?: (
      opts: AgentMcpBridgeOptions,
      defaultResult: StartBridgeResult,
      credentialError: typeof AgentMcpCredentialUnavailableError,
    ) => Promise<StartBridgeResult>;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-container-runner-'));
  const dataDir = path.join(root, 'data');
  const groupsDir = path.join(root, 'groups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });

  const oneCliStarted = deferred();
  const oneCliRelease = deferred();
  const spawnedProcesses: Array<ReturnType<typeof fakeChildProcess>> = [];
  // Snapshot the --env-file at spawn time: it must exist (with content and
  // 0600 mode) BEFORE docker is spawned, and may be deleted right after.
  const envFileSnapshots: Array<{ path: string; content: string; mode: number }> = [];
  const spawnMock = vi.fn((_command: string, args: string[], _options?: unknown) => {
    const envFileIndex = args.indexOf('--env-file');
    if (envFileIndex !== -1) {
      const envFilePath = args[envFileIndex + 1];
      envFileSnapshots.push({
        path: envFilePath,
        content: fs.readFileSync(envFilePath, 'utf-8'),
        mode: fs.statSync(envFilePath).mode & 0o777,
      });
    }
    const proc = fakeChildProcess(12345 + spawnedProcesses.length);
    spawnedProcesses.push(proc);
    return proc;
  });
  const execFileMock = vi.fn((_file, _args, _options, cb) => {
    cb(null, '', '');
  });
  const execSyncMock = vi.fn();
  const applyContainerConfigMock = vi.fn(async (_args: string[]) => {
    oneCliStarted.resolve();
    await oneCliRelease.promise;
    return true;
  });
  const loadAgentMcpConfigForGroupMock = vi.fn(
    (folder: string) => options.mcpConfigForGroup?.(folder) ?? { bridges: {}, allowedTools: [] },
  );
  // Populated after the post-reset bridge import so callbacks throw the same
  // class identity container-runner.ts resolves (instanceof works).
  const credentialErrorRef: { ctor?: typeof AgentMcpCredentialUnavailableError } = {};
  const startAgentMcpBridgeMock = vi.fn(async (opts: AgentMcpBridgeOptions) => {
    const defaultResult: StartBridgeResult = {
      serverName: opts.bridge.serverName,
      hostSocketDir: path.join(root, 'mcp-runs', opts.bridge.serverName),
      hostSocketPath: path.join(root, 'mcp-runs', opts.bridge.serverName, `${opts.bridge.socketNamePrefix}.sock`),
      containerSocketDir: `/workspace/mcp/${opts.bridge.serverName}`,
      containerSocketPath: `/workspace/mcp/${opts.bridge.serverName}/${opts.bridge.socketNamePrefix}.sock`,
      authDir: path.join(root, 'auth', opts.bridge.serverName),
      stop: vi.fn(),
    };
    if (options.startBridge) {
      return options.startBridge(opts, defaultResult, credentialErrorRef.ctor!);
    }
    return defaultResult;
  });

  vi.resetModules();
  vi.doMock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
      ...actual,
      execFile: execFileMock,
      execSync: execSyncMock,
      spawn: spawnMock,
    };
  });
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: class {
      ensureAgent = vi.fn().mockResolvedValue(undefined);
      applyContainerConfig = applyContainerConfigMock;
    },
  }));
  vi.doMock('./config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./config.js')>();
    return {
      ...actual,
      DATA_DIR: dataDir,
      GROUPS_DIR: groupsDir,
      MANAGED_REPOS_DIR: '',
      ONECLI_API_KEY: 'test-key',
      ONECLI_URL: 'http://onecli.test',
    };
  });
  vi.doMock('./agent-mcp-config.js', () => ({
    loadAgentMcpConfigForGroup: loadAgentMcpConfigForGroupMock,
  }));
  vi.doMock('./agent-mcp-bridge.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./agent-mcp-bridge.js')>();
    return {
      ...actual,
      startAgentMcpBridge: startAgentMcpBridgeMock,
    };
  });
  vi.doMock('./providers/index.js', () => ({}));
  vi.doMock('./yente/service-env.js', () => ({
    YENTE_LOCAL_PROXY_HOSTNAMES: [
      'yente-gws-proxy.local',
      'yente-msgvault-proxy.local',
      'yente-familiar-proxy.local',
      'yente-nyne-proxy.local',
      'yente-browser-handoff.local',
    ],
    assertOneCliApplied(applied: boolean): void {
      if (!applied) throw new Error('OneCLI gateway did not apply container credentials');
    },
    ensureOneCliAgentSecretAccess: vi.fn().mockResolvedValue(undefined),
    requireYenteHostEnv: vi.fn().mockReturnValue({
      containerEnv: {
        GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
        MSGVAULT_PROXY_URL: 'http://yente-msgvault-proxy.local:8084',
        MSGVAULT_API_URL: 'http://yente-msgvault-proxy.local:8084',
        FAMILIAR_PROXY_URL: 'http://yente-familiar-proxy.local:8081',
        FAMILIAR_API_URL: 'http://yente-familiar-proxy.local:8081',
        NYNE_PROXY_URL: 'http://yente-nyne-proxy.local:8082',
        NYNE_API_URL: 'http://yente-nyne-proxy.local:8082',
        YENTE_BROWSER_HANDOFF_URL: 'http://yente-browser-handoff.local:6081',
        NO_PROXY: 'localhost,127.0.0.1,registry.npmjs.org,host.docker.internal',
        no_proxy: 'localhost,127.0.0.1,registry.npmjs.org,host.docker.internal',
      },
    }),
  }));

  const db = await import('./db/index.js');
  const sessions = await import('./db/sessions.js');
  const sessionManager = await import('./session-manager.js');
  // Import the bridge module AFTER vi.resetModules() so its
  // AgentMcpCredentialUnavailableError class identity matches the one
  // container-runner.ts resolves — `instanceof` would otherwise fail across
  // the module-registry reset.
  const bridgeModule = await import('./agent-mcp-bridge.js');
  credentialErrorRef.ctor = bridgeModule.AgentMcpCredentialUnavailableError;
  const containerRunner = await import('./container-runner.js');

  const mainDb = db.initTestDb();
  db.runMigrations(mainDb);
  db.createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  db.createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  const { session } = sessionManager.resolveSession('ag-1', 'mg-1', null, 'shared');

  return {
    applyContainerConfigMock,
    close() {
      db.closeDb();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('child_process');
      vi.doUnmock('@onecli-sh/sdk');
      vi.doUnmock('./config.js');
      vi.doUnmock('./agent-mcp-config.js');
      vi.doUnmock('./agent-mcp-bridge.js');
      vi.doUnmock('./providers/index.js');
      vi.doUnmock('./yente/service-env.js');
      vi.resetModules();
    },
    bridgeModule,
    containerRunner,
    oneCliRelease,
    oneCliStarted,
    session,
    sessions,
    execFileMock,
    execSyncMock,
    dataDir,
    envFileSnapshots,
    groupsDir,
    loadAgentMcpConfigForGroupMock,
    root,
    spawnedProcesses,
    spawnMock,
    startAgentMcpBridgeMock,
  };
}

describe('resolveProviderName', () => {
  it('uses container.json as the authoritative provider source', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
    expect(resolveProviderName('OpenCode', 'opencode', 'OpenCode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('OPENCODE', null, 'OpenCode')).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty strings as unset and still validates legacy DB conflicts', () => {
    expect(resolveProviderName('', '', 'opencode')).toBe('opencode');
    expect(() => resolveProviderName('', 'codex', null)).toThrow(/agent_groups\.agent_provider is 'codex'/);
  });

  it('fails clearly when a stale session provider conflicts with container.json', () => {
    expect(() => resolveProviderName('codex', null, 'opencode')).toThrow(
      /container\.json resolves to 'opencode'.*sessions\.agent_provider is 'codex'/,
    );
  });

  it('fails clearly when a stale agent group provider would otherwise override container.json', () => {
    expect(() => resolveProviderName(null, 'opencode', 'claude')).toThrow(
      /container\.json resolves to 'claude'.*agent_groups\.agent_provider is 'opencode'/,
    );
  });

  it('fails clearly on DB-only provider configuration instead of silently overriding the default', () => {
    expect(() => resolveProviderName(null, 'opencode', undefined)).toThrow(
      /container\.json resolves to 'claude'.*agent_groups\.agent_provider is 'opencode'/,
    );
  });
});

describe('provider preparation', () => {
  it('awaits provider preparation before building the synchronous contribution', async () => {
    const provider = 'test-prepare-order';
    const order: string[] = [];
    registerProviderPrepare(provider, async () => {
      order.push('prepare');
    });
    registerProviderContainerConfig(provider, () => {
      order.push('contribution');
      return {};
    });
    const group: AgentGroup = {
      id: 'ag-prepare',
      name: 'Prepare',
      folder: 'prepare',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      provider,
    };

    await resolveProviderContribution(
      { id: 'sess-prepare', agent_group_id: group.id, agent_provider: null } as never,
      group,
      config,
    );

    expect(order).toEqual(['prepare', 'contribution']);
  });
});

describe('resolveAgentImageForRun', () => {
  it('does not reuse a per-agent image from an older release base', async () => {
    const config = {
      mcpServers: {},
      packages: { apt: ['jq'], npm: [] },
      imageTag: 'nanoclaw-agent-v2-oldbase:ag-discord-yente-dvora',
      additionalMounts: [],
      skills: 'all',
    } satisfies ContainerConfig;

    const result = await resolveAgentImageForRun({
      agentGroupId: 'ag-discord-yente-dvora',
      groupFolder: 'discord_yente-dvora',
      containerConfig: config,
      currentImageBase: 'nanoclaw-agent-v2-newbase',
      currentImage: 'nanoclaw-agent-v2-newbase:newsha',
      rebuildAgentGroupImage: async () => 'nanoclaw-agent-v2-newbase:ag-discord-yente-dvora',
    });

    expect(result.imageTag).toBe('nanoclaw-agent-v2-newbase:ag-discord-yente-dvora');
    expect(result.rebuilt).toBe(true);
  });

  it('rebuilds when packages are configured but no per-agent image tag is present', async () => {
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: ['playwright'] },
      additionalMounts: [],
      skills: 'all',
    } satisfies ContainerConfig;

    const result = await resolveAgentImageForRun({
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      containerConfig: config,
      currentImageBase: 'nanoclaw-agent-v2-newbase',
      currentImage: 'nanoclaw-agent-v2-newbase:newsha',
      rebuildAgentGroupImage: async () => 'nanoclaw-agent-v2-newbase:ag-main',
    });

    expect(result.imageTag).toBe('nanoclaw-agent-v2-newbase:ag-main');
    expect(result.rebuilt).toBe(true);
  });

  it('clears leftover per-agent image tags when no packages are configured', async () => {
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      imageTag: 'nanoclaw-agent-v2-newbase:ag-main',
      additionalMounts: [],
      skills: 'all',
    } satisfies ContainerConfig;
    const writeContainerConfigForGroup = vi.fn();

    const result = await resolveAgentImageForRun({
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      containerConfig: config,
      currentImageBase: 'nanoclaw-agent-v2-newbase',
      currentImage: 'nanoclaw-agent-v2-newbase:newsha',
      rebuildAgentGroupImage: async () => {
        throw new Error('unexpected rebuild');
      },
      writeContainerConfigForGroup,
    });

    expect(result.imageTag).toBe('nanoclaw-agent-v2-newbase:newsha');
    expect(result.rebuilt).toBe(false);
    expect(config.imageTag).toBeUndefined();
    expect(writeContainerConfigForGroup).toHaveBeenCalledWith('main', config);
  });

  it('does not accept the base release image when packages are configured', async () => {
    const config = {
      mcpServers: {},
      packages: { apt: ['jq'], npm: [] },
      imageTag: 'nanoclaw-agent-v2-newbase:newsha',
      additionalMounts: [],
      skills: 'all',
    } satisfies ContainerConfig;

    const result = await resolveAgentImageForRun({
      agentGroupId: 'ag-discord-yente-dvora',
      groupFolder: 'discord_yente-dvora',
      containerConfig: config,
      currentImageBase: 'nanoclaw-agent-v2-newbase',
      currentImage: 'nanoclaw-agent-v2-newbase:newsha',
      rebuildAgentGroupImage: async () => 'nanoclaw-agent-v2-newbase:ag-discord-yente-dvora',
    });

    expect(result.imageTag).toBe('nanoclaw-agent-v2-newbase:ag-discord-yente-dvora');
    expect(result.rebuilt).toBe(true);
  });

  it('fails clearly when rebuild does not produce the current-base per-agent image', async () => {
    const config = {
      mcpServers: {},
      packages: { apt: ['jq'], npm: [] },
      imageTag: 'nanoclaw-agent-v2-oldbase:ag-main',
      additionalMounts: [],
      skills: 'all',
    } satisfies ContainerConfig;

    await expect(
      resolveAgentImageForRun({
        agentGroupId: 'ag-main',
        groupFolder: 'main',
        containerConfig: config,
        currentImageBase: 'nanoclaw-agent-v2-newbase',
        currentImage: 'nanoclaw-agent-v2-newbase:newsha',
        rebuildAgentGroupImage: async () => 'nanoclaw-agent-v2-oldbase:ag-main',
      }),
    ).rejects.toThrow(
      "Per-agent image for main was rebuilt as 'nanoclaw-agent-v2-oldbase:ag-main', expected 'nanoclaw-agent-v2-newbase:ag-main'",
    );
  });
});

describe('buildAgentGroupImage', () => {
  it('uses a unique temporary Dockerfile path for each build', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const { writeContainerConfig } = await import('./container-config.js');
      writeContainerConfig('agent', {
        mcpServers: {},
        packages: { apt: ['jq'], npm: [] },
        additionalMounts: [],
        skills: 'all',
      });

      harness.execSyncMock.mockImplementation((command: string) => {
        const match = command.match(/ -f '([^']+)' /);
        expect(match?.[1]).toBeTruthy();
        expect(fs.existsSync(match![1])).toBe(true);
      });

      await harness.containerRunner.buildAgentGroupImage('ag-1');
      await harness.containerRunner.buildAgentGroupImage('ag-1');

      const dockerfilePaths = harness.execSyncMock.mock.calls.map((call) => {
        const command = String(call[0]);
        const match = command.match(/ -f '([^']+)' /);
        expect(match?.[1]).toBeTruthy();
        return match![1];
      });

      expect(dockerfilePaths).toHaveLength(2);
      expect(new Set(dockerfilePaths).size).toBe(2);
      for (const dockerfilePath of dockerfilePaths) {
        expect(dockerfilePath.startsWith(path.join(harness.dataDir, '.nanoclaw-image-build-ag-1-'))).toBe(true);
        expect(fs.existsSync(path.dirname(dockerfilePath))).toBe(false);
      }
    } finally {
      harness.close();
    }
  });
});

describe('OneCLI container gateway', () => {
  it('throws before spawn args are complete when OneCLI returns false on every attempt', async () => {
    vi.useFakeTimers();
    try {
      const args = ['run'];
      const client = {
        ensureAgent: vi.fn().mockResolvedValue(undefined),
        applyContainerConfig: vi.fn().mockResolvedValue(false),
      };

      const promise = applyOneCliGatewayForContainerArgs(args, {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      });
      const expectation = expect(promise).rejects.toThrow('OneCLI gateway did not apply container credentials');
      await vi.advanceTimersByTimeAsync(12_000);
      await expectation;

      expect(client.ensureAgent).toHaveBeenCalledWith({ name: 'Yente', identifier: 'ag-main' });
      expect(client.applyContainerConfig).toHaveBeenCalledWith(args, { addHostMapping: false, agent: 'ag-main' });
      expect(client.applyContainerConfig).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries transient network failures and succeeds, logging a WARN per failed attempt', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const args = ['run'];
      const networkError = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      });
      const client = {
        ensureAgent: vi
          .fn()
          .mockRejectedValueOnce(networkError)
          .mockRejectedValueOnce(networkError)
          .mockResolvedValue(undefined),
        applyContainerConfig: vi.fn().mockResolvedValue(true),
      };

      const promise = applyOneCliGatewayForContainerArgs(args, {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      });
      await vi.advanceTimersByTimeAsync(4_000); // 1s + 3s retry delays
      await promise;

      expect(client.ensureAgent).toHaveBeenCalledTimes(3);
      expect(client.applyContainerConfig).toHaveBeenCalledTimes(1);
      const retryWarns = warnSpy.mock.calls.filter(([msg]) => msg === 'OneCLI gateway attempt failed; retrying');
      expect(retryWarns).toHaveLength(2);
      expect(retryWarns[0][1]).toMatchObject({
        containerName: 'container-1',
        attempt: 1,
        maxAttempts: 4,
        delayMs: 1000,
      });
      expect(retryWarns[1][1]).toMatchObject({ attempt: 2, delayMs: 3000 });
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries when applyContainerConfig reports not-applied and eventually succeeds', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const args = ['run'];
      const client = {
        ensureAgent: vi.fn().mockResolvedValue(undefined),
        applyContainerConfig: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
      };

      const promise = applyOneCliGatewayForContainerArgs(args, {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await promise;

      expect(client.applyContainerConfig).toHaveBeenCalledTimes(3);
      expect(warnSpy.mock.calls.filter(([msg]) => msg === 'OneCLI gateway attempt failed; retrying')).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails immediately on 4xx responses without retrying', async () => {
    const args = ['run'];
    const unauthorized = Object.assign(new Error('OneCLI returned 401 Unauthorized'), {
      name: 'OneCLIRequestError',
      statusCode: 401,
    });
    const client = {
      ensureAgent: vi.fn().mockRejectedValue(unauthorized),
      applyContainerConfig: vi.fn(),
    };

    await expect(
      applyOneCliGatewayForContainerArgs(args, {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('OneCLI gateway failed; refusing to start Yente container without credential isolation');

    expect(client.ensureAgent).toHaveBeenCalledTimes(1);
    expect(client.applyContainerConfig).not.toHaveBeenCalled();
  });

  it('gives up after four retryable attempts and surfaces the underlying cause', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const networkError = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
      });
      const client = {
        ensureAgent: vi.fn().mockRejectedValue(networkError),
        applyContainerConfig: vi.fn(),
      };

      const promise = applyOneCliGatewayForContainerArgs([], {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      });
      const expectation = promise.then(
        () => {
          throw new Error('expected rejection');
        },
        (err: Error) => err,
      );
      await vi.advanceTimersByTimeAsync(12_000);
      const err = await expectation;

      expect(err.message).toContain(
        'OneCLI gateway failed; refusing to start Yente container without credential isolation',
      );
      expect(err.message).toContain('fetch failed');
      expect(err.message).toContain('ECONNRESET');
      expect(client.ensureAgent).toHaveBeenCalledTimes(4);
      expect(warnSpy.mock.calls.filter(([msg]) => msg === 'OneCLI gateway attempt failed; retrying')).toHaveLength(3);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails immediately on semantic secret-access errors without retrying', async () => {
    const client = {
      ensureAgent: vi.fn().mockResolvedValue(undefined),
      applyContainerConfig: vi.fn(),
    };
    const ensureSecretAccess = vi
      .fn()
      .mockRejectedValue(
        new Error('Missing OneCLI secret(s): Yente GWS Proxy; configure Yente local proxy credentials'),
      );

    await expect(
      applyOneCliGatewayForContainerArgs([], {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess,
      }),
    ).rejects.toThrow('OneCLI gateway failed; refusing to start Yente container without credential isolation');

    expect(ensureSecretAccess).toHaveBeenCalledTimes(1);
  });

  it('rethrows OneCLI exceptions with Yente credential-isolation guidance', async () => {
    const client = {
      ensureAgent: vi.fn().mockResolvedValue(undefined),
      applyContainerConfig: vi.fn().mockRejectedValue(new Error('network down')),
    };

    await expect(
      applyOneCliGatewayForContainerArgs([], {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('OneCLI gateway failed; refusing to start Yente container without credential isolation');
  });

  it('ensures OneCLI local proxy secrets are granted before applying container config', async () => {
    const args = ['run'];
    const client = {
      ensureAgent: vi.fn().mockResolvedValue(undefined),
      applyContainerConfig: vi.fn().mockResolvedValue(true),
    };
    const ensureSecretAccess = vi.fn().mockResolvedValue(undefined);

    await applyOneCliGatewayForContainerArgs(args, {
      client,
      containerName: 'container-1',
      agentGroupName: 'Yente',
      agentIdentifier: 'ag-main',
      ensureSecretAccess,
    });

    expect(ensureSecretAccess).toHaveBeenCalledWith('ag-main');
    expect(client.applyContainerConfig).toHaveBeenCalledWith(args, { addHostMapping: false, agent: 'ag-main' });
  });
});

describe('session wake lifecycle', () => {
  it('does not wake an archived session', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      harness.sessions.archiveSession(harness.session.id);

      const wake = harness.containerRunner.wakeContainer(harness.session);
      harness.oneCliRelease.resolve();
      await wake;

      expect(harness.spawnMock).not.toHaveBeenCalled();
      expect(harness.sessions.getSession(harness.session.id)?.container_status).toBe('stopped');
    } finally {
      harness.close();
    }
  });

  it('aborts an in-flight wake when the session is archived before spawn', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;

      harness.sessions.archiveSession(harness.session.id);
      harness.oneCliRelease.resolve();
      await wake;

      expect(harness.applyContainerConfigMock).toHaveBeenCalled();
      expect(harness.spawnMock).not.toHaveBeenCalled();
      expect(harness.sessions.getSession(harness.session.id)?.container_status).toBe('stopped');
    } finally {
      harness.close();
    }
  });

  it('starts configured agent MCP bridges for non-main groups before spawn', async () => {
    const harness = await loadContainerRunnerHarness({
      mcpConfigForGroup: (folder) => {
        expect(folder).toBe('agent');
        return {
          allowedTools: ['mcp__granola__*'],
          bridges: {
            granola: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://mcp.granola.ai/mcp',
              callbackPort: 37947,
              socketNamePrefix: 'granola',
              required: true,
            },
          },
        };
      },
    });
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      expect(harness.loadAgentMcpConfigForGroupMock).toHaveBeenCalledWith('agent');
      expect(harness.startAgentMcpBridgeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'agent',
          agentGroupId: 'ag-1',
          bridge: expect.objectContaining({
            serverName: 'granola',
            remoteUrl: 'https://mcp.granola.ai/mcp',
          }),
        }),
      );
      expect(JSON.stringify(harness.spawnMock.mock.calls[0])).toContain('/workspace/mcp/granola');
      const containerJson = JSON.parse(
        fs.readFileSync(path.join(harness.groupsDir, 'agent', 'container.json'), 'utf8'),
      );
      expect(containerJson.mcpServers.granola.args).toContain('/workspace/mcp/granola/granola.sock');
      expect(containerJson.agentMcpAllowedTools).toEqual(['mcp__granola__*']);
    } finally {
      harness.close();
    }
  });

  function granolaOnlyConfig(): (folder: string) => AgentMcpConfigForGroup {
    return () => ({
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
    });
  }

  for (const category of ['auth_required', 'auth_expired'] as const) {
    it(`spawns the container with Granola omitted when it degrades with ${category}`, async () => {
      const harness = await loadContainerRunnerHarness({
        mcpConfigForGroup: granolaOnlyConfig(),
        startBridge: async (_opts, _defaultResult, CredentialError) => {
          throw new CredentialError(category, 'Granola is temporarily unavailable.');
        },
      });
      try {
        const wake = harness.containerRunner.wakeContainer(harness.session);
        await harness.oneCliStarted.promise;
        harness.oneCliRelease.resolve();
        await wake;

        // Container still spawned (degraded, not fail-closed).
        expect(harness.spawnMock).toHaveBeenCalled();

        const containerJson = JSON.parse(
          fs.readFileSync(path.join(harness.groupsDir, 'agent', 'container.json'), 'utf8'),
        );
        // Granola MCP server + allowed tools omitted from the runtime config.
        expect(containerJson.mcpServers.granola).toBeUndefined();
        expect(containerJson.agentMcpServerNames).not.toContain('granola');
        expect(containerJson.agentMcpAllowedTools ?? []).not.toContain('mcp__granola__*');
        // Sanitized unavailable state recorded with the credential category.
        expect(containerJson.agentMcpUnavailable.granola.category).toBe(category);
        const text = JSON.stringify(containerJson.agentMcpUnavailable.granola);
        expect(text).not.toContain(harness.root);
        expect(text).not.toMatch(/\b\d{3,5}:\d{3,5}\b/);
        expect(text).not.toMatch(/\/home\//);
      } finally {
        harness.close();
      }
    });
  }

  it('clears a stale unavailable entry when Granola starts successfully later', async () => {
    const harness = await loadContainerRunnerHarness({ mcpConfigForGroup: granolaOnlyConfig() });
    try {
      // Pre-seed container.json with a stale unavailable entry from a prior spawn.
      const containerJsonPath = path.join(harness.groupsDir, 'agent', 'container.json');
      fs.mkdirSync(path.dirname(containerJsonPath), { recursive: true });
      fs.writeFileSync(
        containerJsonPath,
        JSON.stringify({
          mcpServers: {},
          agentMcpUnavailable: { granola: { category: 'auth_required', message: 'stale' } },
        }),
      );

      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      const containerJson = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8'));
      // Granola started successfully — stale unavailable entry removed.
      expect(containerJson.agentMcpUnavailable?.granola).toBeUndefined();
      expect(containerJson.mcpServers.granola).toBeDefined();
      expect(containerJson.agentMcpAllowedTools).toContain('mcp__granola__*');
    } finally {
      harness.close();
    }
  });

  it('fails closed (does not spawn) when a non-credential Granola failure occurs', async () => {
    const harness = await loadContainerRunnerHarness({
      mcpConfigForGroup: granolaOnlyConfig(),
      startBridge: async () => {
        // Integrity-style failure: NOT a credential class, so it must fail closed
        // even for the optional Granola bridge.
        throw new Error('Granola MCP auth path must not contain symlinks');
      },
    });
    try {
      // attachAgentMcpBridges throws before OneCLI is invoked, so don't wait
      // on oneCliStarted — just resolve the release latch and await rejection.
      harness.oneCliRelease.resolve();
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await expect(wake).rejects.toThrow(/must not contain symlinks/);
      expect(harness.spawnMock).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it('fails closed when a required bridge fails, and stops already-started bridges', async () => {
    const stopSpies: ReturnType<typeof vi.fn>[] = [];
    const harness = await loadContainerRunnerHarness({
      mcpConfigForGroup: () => ({
        allowedTools: ['mcp__granola__*', 'mcp__other__*'],
        bridges: {
          granola: {
            type: 'mcp-remote-unix-socket',
            remoteUrl: 'https://mcp.granola.ai/mcp',
            callbackPort: 37947,
            socketNamePrefix: 'granola',
            required: false,
          },
          other: {
            type: 'mcp-remote-unix-socket',
            remoteUrl: 'https://example.com/mcp',
            callbackPort: 37948,
            socketNamePrefix: 'other',
            required: true,
          },
        },
      }),
      startBridge: async (opts, defaultResult, CredentialError) => {
        if (opts.bridge.serverName === 'other') {
          // Even a credential-shaped failure on a REQUIRED bridge must fail closed.
          throw new CredentialError('auth_required', 'Other is unavailable.');
        }
        stopSpies.push(defaultResult.stop);
        return defaultResult;
      },
    });
    try {
      // The required-bridge failure throws before OneCLI is invoked.
      harness.oneCliRelease.resolve();
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await expect(wake).rejects.toBeInstanceOf(Error);
      expect(harness.spawnMock).not.toHaveBeenCalled();
      // The already-started granola bridge must be stopped on the required failure.
      expect(stopSpies.length).toBeGreaterThan(0);
      for (const stop of stopSpies) expect(stop).toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it('exposes skill-local helper bins on the base container PATH', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      const args = harness.spawnMock.mock.calls[0][1];
      expect(readSpawnEnvFile(args).env.get('PATH')).toBe(
        '/app/skills/.bin:/pnpm/bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
      );
    } finally {
      harness.close();
    }
  });

  it('exposes Yente local service env and host aliases for configured provider sessions', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      fs.mkdirSync(path.join(harness.groupsDir, 'agent'), { recursive: true });
      fs.writeFileSync(
        path.join(harness.groupsDir, 'agent', 'container.json'),
        JSON.stringify({
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: 'all',
          provider: 'opencode',
        }),
      );

      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      const args = harness.spawnMock.mock.calls[0][1];
      const { env } = readSpawnEnvFile(args);
      expect(env.get('YENTE_BROWSER_HANDOFF_URL')).toBe('http://yente-browser-handoff.local:6081');
      expect(env.get('GWS_PROXY_URL')).toBe('http://yente-gws-proxy.local:8083');
      expect(args).toContain('--add-host=yente-browser-handoff.local:host-gateway');
      expect(args).toContain('--add-host=yente-gws-proxy.local:host-gateway');
    } finally {
      harness.close();
    }
  });

  it('keeps provider proxy env after generic OneCLI gateway env', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const { registerProviderContainerConfig } = await import('./providers/provider-container-registry.js');
      registerProviderContainerConfig('codex', () => ({
        env: {
          HTTP_PROXY: 'http://agent-token@yente-onecli-auth-gate.local:18055',
          HTTPS_PROXY: 'http://agent-token@yente-onecli-auth-gate.local:18055',
          http_proxy: 'http://agent-token@yente-onecli-auth-gate.local:18055',
          https_proxy: 'http://agent-token@yente-onecli-auth-gate.local:18055',
        },
        extraHosts: ['yente-onecli-auth-gate.local'],
      }));
      harness.applyContainerConfigMock.mockImplementation(async (args: string[]) => {
        harness.oneCliStarted.resolve();
        args.push('-e', 'HTTP_PROXY=http://agent@host.docker.internal:10255');
        args.push('-e', 'HTTPS_PROXY=http://agent@host.docker.internal:10255');
        args.push('-e', 'http_proxy=http://agent@host.docker.internal:10255');
        args.push('-e', 'https_proxy=http://agent@host.docker.internal:10255');
        await harness.oneCliRelease.promise;
        return true;
      });
      fs.mkdirSync(path.join(harness.groupsDir, 'agent'), { recursive: true });
      fs.writeFileSync(
        path.join(harness.groupsDir, 'agent', 'container.json'),
        JSON.stringify({
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: 'all',
          provider: 'codex',
        }),
      );

      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      const args = harness.spawnMock.mock.calls[0][1];
      const effectiveEnv = readSpawnEnvFile(args).env;
      expect(effectiveEnv.get('HTTP_PROXY')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('HTTPS_PROXY')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('http_proxy')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('https_proxy')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('YENTE_ONECLI_GATEWAY_PROXY_URL')).toBe('http://agent@host.docker.internal:10255');
      expect(args).toContain('--add-host=yente-onecli-auth-gate.local:host-gateway');
    } finally {
      harness.close();
    }
  });

  it('labels spawned containers with the owning session id', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      const args = harness.spawnMock.mock.calls[0][1];
      expect(args).toContain('--label');
      expect(args).toContain(`nanoclaw-session=${harness.session.id}`);
    } finally {
      harness.close();
    }
  });

  it('stops the active container for a superseded session asynchronously', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      await expect(
        harness.containerRunner.cleanupContainerForSession(harness.session.id, 'yente-session-reset'),
      ).resolves.toBe(true);

      const containerName = harness.spawnMock.mock.calls[0][1][3];
      expect(harness.execFileMock).toHaveBeenCalledWith(
        'docker',
        ['stop', '-t', '1', containerName],
        { timeout: 11000 },
        expect.any(Function),
      );
    } finally {
      harness.close();
    }
  });

  it('finalizes cleanup when Docker reports the stopped container is gone before child close', async () => {
    const harness = await loadContainerRunnerHarness();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      await expect(
        harness.containerRunner.cleanupContainerForSession(harness.session.id, 'yente-session-reset'),
      ).resolves.toBe(true);

      await expect(harness.containerRunner.isSessionOutboundWriterRunning(harness.session)).resolves.toBe(false);
    } finally {
      processKill.mockRestore();
      harness.close();
    }
  });

  it('throws when stop fails and the container still appears to be running', async () => {
    const harness = await loadContainerRunnerHarness();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;
      const containerName = harness.spawnMock.mock.calls[0][1][3];
      harness.execFileMock.mockImplementation((_file, args: string[], _options, cb) => {
        if (args[0] === 'stop') {
          cb(new Error('stop failed'));
          return;
        }
        cb(null, `${containerName}\n`, '');
      });

      await expect(
        harness.containerRunner.cleanupContainerForSession(harness.session.id, 'yente-session-reset'),
      ).rejects.toThrow('Failed to clean up container for session');
    } finally {
      processKill.mockRestore();
      harness.close();
    }
  });

  it('returns true when stop fails but verification shows the container is gone', async () => {
    const harness = await loadContainerRunnerHarness();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;
      harness.execFileMock.mockImplementation((_file, args: string[], _options, cb) => {
        if (args[0] === 'stop') {
          cb(new Error('stop failed'));
          return;
        }
        cb(null, '', '');
      });

      await expect(
        harness.containerRunner.cleanupContainerForSession(harness.session.id, 'yente-session-reset'),
      ).resolves.toBe(true);
      expect(harness.spawnedProcesses[0].kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      processKill.mockRestore();
      harness.close();
    }
  });

  it('does not treat stale host process liveness as an outbound writer after Docker verifies stop', async () => {
    const harness = await loadContainerRunnerHarness();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      await expect(harness.containerRunner.isSessionOutboundWriterRunning(harness.session)).resolves.toBe(false);
    } finally {
      processKill.mockRestore();
      harness.close();
    }
  });

  it('detects session outbound writers by runtime label when the process map is empty', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      harness.execFileMock.mockImplementation((_file, args: string[], _options, cb) => {
        if (args[0] === 'ps' && args.includes(`label=nanoclaw-session=${harness.session.id}`)) {
          cb(null, 'nanoclaw-v2-agent-123\n', '');
          return;
        }
        cb(null, '', '');
      });

      await expect(harness.containerRunner.isSessionOutboundWriterRunning(harness.session)).resolves.toBe(true);
    } finally {
      harness.close();
    }
  });

  it('returns false when no active container exists for the session', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      await expect(
        harness.containerRunner.cleanupContainerForSession('missing-session', 'yente-session-reset'),
      ).resolves.toBe(false);
    } finally {
      harness.close();
    }
  });

  it('reset stop verification fails when the runtime label still reports a writer', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      harness.execFileMock.mockImplementation((_file, args: string[], _options, cb) => {
        if (args[0] === 'ps' && args.includes(`label=nanoclaw-session=${harness.session.id}`)) {
          cb(null, 'nanoclaw-v2-agent-stray\n', '');
          return;
        }
        cb(null, '', '');
      });

      await expect(
        harness.containerRunner.stopContainerAndVerify(harness.session.id, 'yente-session-reset'),
      ).rejects.toThrow('runtime label still reports a writer');
    } finally {
      harness.close();
    }
  });

  it('reset stop verification checks the runtime label after tracked cleanup succeeds', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      let labelInspectCount = 0;
      harness.execFileMock.mockImplementation((_file, args: string[], _options, cb) => {
        if (args[0] === 'stop') {
          cb(null, '', '');
          return;
        }
        if (args[0] === 'ps' && args.includes(`label=nanoclaw-session=${harness.session.id}`)) {
          labelInspectCount++;
          cb(null, labelInspectCount === 1 ? '' : 'nanoclaw-v2-agent-stray\n', '');
          return;
        }
        cb(null, '', '');
      });

      await expect(
        harness.containerRunner.stopContainerAndVerify(harness.session.id, 'yente-session-reset'),
      ).rejects.toThrow('runtime label still reports a writer');
      expect(labelInspectCount).toBeGreaterThanOrEqual(2);
    } finally {
      harness.close();
    }
  });
});

describe('local skills mount', () => {
  const baseGroup: AgentGroup = {
    id: 'ag-main',
    name: 'Yente',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-04-25T00:00:00.000Z',
  };

  it('mounts the writable local skills root for any agent group', () => {
    expect(
      buildLocalSkillsMount(baseGroup, {
        NANOCLAW_WRITABLE_SKILLS_DIR: '/srv/nanoclaw/shared/repos/local-skills',
      }),
    ).toEqual({
      hostPath: '/srv/nanoclaw/shared/repos/local-skills',
      containerPath: '/workspace/local-skills',
      readonly: false,
    });
  });

  it('uses the same local skill authoring mount for non-main groups', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };

    expect(
      buildLocalSkillsMount(researchGroup, {
        NANOCLAW_WRITABLE_SKILLS_DIR: '/srv/nanoclaw/shared/repos/local-skills',
      }),
    ).toEqual({
      hostPath: '/srv/nanoclaw/shared/repos/local-skills',
      containerPath: '/workspace/local-skills',
      readonly: false,
    });
  });
});

describe('workspace mount contract', () => {
  it('mounts current workspace paths and does not mount retired paths', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'container-runner.ts'),
      'utf8',
    );

    expect(source).toContain("containerPath: '/workspace/agent'");
    expect(source).toContain("containerPath: '/workspace/repos'");
    expect(source).toContain("containerPath: '/workspace/extra/repos'");
    expect(source).not.toContain("containerPath: '/workspace/group'");
    expect(source).not.toContain("containerPath: '/workspace/project'");
  });

  it('keeps host MCP tool grants driven by container config, not a provider hardcode', () => {
    const providerSource = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'container',
        'agent-runner',
        'src',
        'providers',
        'claude.ts',
      ),
      'utf8',
    );
    const runnerSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'container', 'agent-runner', 'src', 'index.ts'),
      'utf8',
    );

    expect(providerSource).not.toContain("'mcp__granola__*'");
    expect(providerSource).toContain('buildClaudeToolAllowlist(options.allowedTools)');
    expect(runnerSource).toContain('allowedTools: config.agentMcpAllowedTools');
  });
});

describe('managed repos mounts', () => {
  const baseGroup: AgentGroup = {
    id: 'ag-main',
    name: 'Yente',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-04-25T00:00:00.000Z',
  };

  it('mounts the managed repos root at the stable path and provider additional-dir path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-managed-repos-'));
    try {
      expect(
        buildManagedReposMounts(baseGroup, {
          NANOCLAW_MANAGED_REPOS_DIR: root,
        }),
      ).toEqual([
        {
          hostPath: root,
          containerPath: '/workspace/repos',
          readonly: false,
        },
        {
          hostPath: root,
          containerPath: '/workspace/extra/repos',
          readonly: false,
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('mounts managed repos for non-main groups too', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-managed-repos-'));

    try {
      const mounts = buildManagedReposMounts(researchGroup, {
        NANOCLAW_MANAGED_REPOS_DIR: root,
      });

      expect(mounts.map((mount) => mount.containerPath)).toEqual(['/workspace/repos', '/workspace/extra/repos']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the configured managed repos root is missing', () => {
    expect(() =>
      buildManagedReposMounts(baseGroup, {
        NANOCLAW_MANAGED_REPOS_DIR: '/definitely/missing/nanoclaw-managed-repos',
      }),
    ).toThrow('NANOCLAW_MANAGED_REPOS_DIR must exist');
  });

  it('mounts the group managed-repos IPC namespace for reconcile requests', () => {
    expect(buildManagedReposIpcMount(baseGroup)).toMatchObject({
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  });

  it('mounts managed-repos IPC for non-main groups too', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };
    expect(buildManagedReposIpcMount(researchGroup)).toMatchObject({
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  });
});

describe('GWS proxy mediation boundary', () => {
  function writeExecutable(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '#!/bin/sh\nprintf gws\\n', 'utf8');
    fs.chmodSync(filePath, 0o755);
  }

  function runReservedCommandGuard(pathEntries: string[], expectedGwsPath: string) {
    return spawnSync('/bin/sh', ['-c', assertNoReservedAgentCommandCollisionsShell(expectedGwsPath)], {
      env: { ...process.env, PATH: pathEntries.join(':') },
      encoding: 'utf8',
    });
  }

  it('does not contain a helper that can mount GWS OAuth config into agents', () => {
    const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf8');

    expect(runnerSource).not.toContain('buildGwsConfigMount');
    expect(runnerSource).not.toContain('GWS_CONFIG_DIR');
    expect(runnerSource).not.toContain('credentials.enc');
    expect(runnerSource).not.toContain('/home/node/.config/gws');
  });

  it('keeps gws reserved during per-agent npm package rebuilds', () => {
    const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf8');

    expect(runnerSource).toContain('assertNoReservedAgentCommandCollisions');
    expect(runnerSource).toContain('gws');
    expect(runnerSource).toContain('command -v gws');
    expect(runnerSource).toContain('/usr/local/bin/gws');
    expect(runnerSource).toContain('/pnpm/gws');
  });

  it('fails the per-agent rebuild guard when another executable gws appears later on PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gws-path-'));
    try {
      const expectedDir = path.join(root, 'usr', 'local', 'bin');
      const secondaryDir = path.join(root, 'usr', 'bin');
      writeExecutable(path.join(expectedDir, 'gws'));
      writeExecutable(path.join(secondaryDir, 'gws'));

      const result = runReservedCommandGuard([expectedDir, secondaryDir], path.join(expectedDir, 'gws'));

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('reserved gws command collision');
      expect(result.stderr).toContain(path.join(secondaryDir, 'gws'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('side-effect ledger container env', () => {
  /**
   * Helper: run wakeContainer through the standard harness and return the
   * docker-run arg array passed to spawn.  Callers are responsible for
   * cleanup via harness.close().
   */
  async function buildArgs(harness: Awaited<ReturnType<typeof loadContainerRunnerHarness>>): Promise<string[]> {
    const wake = harness.containerRunner.wakeContainer(harness.session);
    await harness.oneCliStarted.promise;
    harness.oneCliRelease.resolve();
    await wake;
    return harness.spawnMock.mock.calls[0][1] as string[];
  }

  it('sets the static side-effect ledger path in the container env', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await buildArgs(harness);
      // Env now travels via --env-file (never on the command line).
      expect(readSpawnEnvFile(args).env.get('NANOCLAW_SIDE_EFFECT_LEDGER')).toBe('/workspace/side-effects.jsonl');
      expect(readSpawnEnvFile(args).env.get('NANOCLAW_HOST_CORRELATION_FILE')).toBe(
        '/workspace/.host-correlation/current.json',
      );
      expect(readSpawnEnvFile(args).env.get('NANOCLAW_SESSION_ID')).toBe(harness.session.id);
    } finally {
      harness.close();
    }
  });

  it('delivers the GWS acceptance capability only over consumed stdin, never argv, env, or a mount', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await buildArgs(harness);
      expect(args).toContain('-i');
      expect(args).toContain('--cap-drop=ALL');
      expect(args).toContain('--security-opt=no-new-privileges');
      expect(args).toContain('--ulimit=core=0');
      const spawnCall = harness.spawnMock.mock.calls[0];
      expect(spawnCall[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
      const child = harness.spawnedProcesses[0];
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      const frame = String(child.stdin.end.mock.calls[0][0]);
      const control = JSON.parse(frame) as { secret: string; leaseId: string; providerName: string };
      expect(control.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(control.leaseId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(control.providerName).toBe('claude');
      expect(JSON.stringify(args)).not.toContain(control.secret);
      expect(harness.envFileSnapshots.map((snapshot) => snapshot.content).join('\n')).not.toContain(control.secret);
      expect(args.filter((arg) => arg.includes(':/workspace/')).join('\n')).not.toContain(control.secret);
    } finally {
      harness.close();
    }
  });

  it('re-overlays inbound correlation inputs read-only inside the writable workspace', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await buildArgs(harness);
      const mounts = args.filter((arg) => arg.includes(':/workspace/'));
      expect(mounts.some((arg) => arg.endsWith(':/workspace/inbound.db:ro'))).toBe(true);
      expect(mounts.some((arg) => arg.endsWith(':/workspace/.host-correlation:ro'))).toBe(true);
      expect(mounts.some((arg) => arg.endsWith(':/workspace/.gws-correlation-ipc'))).toBe(false);
      expect(
        mounts.some((arg) =>
          arg.includes(
            `/v2-gws-correlation-ipc/ag-1/${harness.session.id}/requests:/workspace/.gws-correlation-ipc/requests`,
          ),
        ),
      ).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('passes the owning agent group identity for local skills', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await buildArgs(harness);
      const { env } = readSpawnEnvFile(args);
      expect(env.get('NANOCLAW_AGENT_GROUP_ID')).toBe('ag-1');
      expect(env.get('NANOCLAW_AGENT_GROUP_FOLDER')).toBe('agent');
    } finally {
      harness.close();
    }
  });

  it('injects the Ed25519 public verify key when the host env var is set', async () => {
    const harness = await loadContainerRunnerHarness();
    const saved = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    const savedFile = process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
    try {
      delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      process.env.GWS_SIDE_EFFECT_VERIFY_KEY = generateKeyPairSync('ed25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .subarray(12)
        .toString('base64');
      const args = await buildArgs(harness);
      expect(readSpawnEnvFile(args).env.get('GWS_SIDE_EFFECT_VERIFY_KEY')).toBe(process.env.GWS_SIDE_EFFECT_VERIFY_KEY);
    } finally {
      if (saved === undefined) {
        delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      } else {
        process.env.GWS_SIDE_EFFECT_VERIFY_KEY = saved;
      }
      if (savedFile === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = savedFile;
      harness.close();
    }
  });

  it('rejects a host-user-controlled public-key file before container assembly', async () => {
    const harness = await loadContainerRunnerHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-verify-key-'));
    const keyPath = path.join(dir, 'verify.pub');
    const publicValue = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64');
    const savedFile = process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
    const savedDirect = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    try {
      fs.writeFileSync(keyPath, `${publicValue}\n`, { mode: 0o644 });
      delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = keyPath;
      await expect(harness.containerRunner.wakeContainer(harness.session)).rejects.toThrow(
        /parent chain|owned by root/i,
      );
    } finally {
      if (savedFile === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = savedFile;
      if (savedDirect === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY = savedDirect;
      fs.rmSync(dir, { recursive: true, force: true });
      harness.close();
    }
  });

  it('rejects configuring both public-key value and public-key file', async () => {
    const harness = await loadContainerRunnerHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-verify-key-'));
    const keyPath = path.join(dir, 'verify.pub');
    const publicValue = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64');
    const savedDirect = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    const savedFile = process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
    try {
      fs.writeFileSync(keyPath, `${publicValue}\n`, { mode: 0o644 });
      process.env.GWS_SIDE_EFFECT_VERIFY_KEY = publicValue;
      process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = keyPath;
      await expect(harness.containerRunner.wakeContainer(harness.session)).rejects.toThrow(/only one/i);
    } finally {
      if (savedDirect === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY = savedDirect;
      if (savedFile === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = savedFile;
      fs.rmSync(dir, { recursive: true, force: true });
      harness.close();
    }
  });

  it('rejects symlinked and group-writable public-key files before container assembly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-verify-key-'));
    const keyPath = path.join(dir, 'verify.pub');
    const linkPath = path.join(dir, 'verify-link.pub');
    const publicValue = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64');
    try {
      fs.writeFileSync(keyPath, `${publicValue}\n`, { mode: 0o644 });
      fs.symlinkSync(keyPath, linkPath);
      expect(() => resolveGwsSideEffectVerifyKey({ GWS_SIDE_EFFECT_VERIFY_KEY_FILE: linkPath })).toThrow();
      fs.chmodSync(keyPath, 0o664);
      expect(() => resolveGwsSideEffectVerifyKey({ GWS_SIDE_EFFECT_VERIFY_KEY_FILE: keyPath })).toThrow(
        /parent chain|non-writable/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the Ed25519 public verify key when the host env var is absent', async () => {
    const harness = await loadContainerRunnerHarness();
    const saved = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    const savedFile = process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
    try {
      delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      const args = await buildArgs(harness);
      // The key must be absent so the in-container default applies.
      expect(args.some((a) => a.startsWith('GWS_SIDE_EFFECT_VERIFY_KEY='))).toBe(false);
      expect(readSpawnEnvFile(args).env.has('GWS_SIDE_EFFECT_VERIFY_KEY')).toBe(false);
    } finally {
      if (saved !== undefined) {
        process.env.GWS_SIDE_EFFECT_VERIFY_KEY = saved;
      }
      if (savedFile !== undefined) process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = savedFile;
      harness.close();
    }
  });

  it('never injects the private signing key into the container env under any condition', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      // Inject a dummy value so any accidental pass-through would show up.
      process.env.GWS_SIDE_EFFECT_SIGN_KEY_FILE = '/run/secrets/sign-key';
      const args = await buildArgs(harness);
      expect(args.some((a) => a.includes('GWS_SIDE_EFFECT_SIGN_KEY_FILE'))).toBe(false);
      expect(readSpawnEnvFile(args).raw).not.toContain('GWS_SIDE_EFFECT_SIGN_KEY_FILE');
    } finally {
      delete process.env.GWS_SIDE_EFFECT_SIGN_KEY_FILE;
      harness.close();
    }
  });

  it('rejects a private PKCS8 PEM supplied as the verify key before any secret crosses the container boundary', async () => {
    const harness = await loadContainerRunnerHarness();
    const savedDirect = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    const savedFile = process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
    const privatePem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    try {
      delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      process.env.GWS_SIDE_EFFECT_VERIFY_KEY = privatePem;
      await expect(harness.containerRunner.wakeContainer(harness.session)).rejects.toThrow(/public.*key/i);
      expect(harness.spawnMock).not.toHaveBeenCalled();
      expect(harness.envFileSnapshots.map((snapshot) => snapshot.content).join('\n')).not.toContain(privatePem);
    } finally {
      if (savedDirect === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY = savedDirect;
      if (savedFile === undefined) delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE;
      else process.env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE = savedFile;
      harness.close();
    }
  });

  it('does not pass AGENTMAIL_API_KEY into agent containers', async () => {
    const harness = await loadContainerRunnerHarness();
    const saved = process.env.AGENTMAIL_API_KEY;
    try {
      process.env.AGENTMAIL_API_KEY = 'test-agentmail-secret';
      const args = await buildArgs(harness);
      expect(args.join('\n')).not.toContain('AGENTMAIL_API_KEY');
      expect(args.join('\n')).not.toContain('test-agentmail-secret');
      const { raw } = readSpawnEnvFile(args);
      expect(raw).not.toContain('AGENTMAIL_API_KEY');
      expect(raw).not.toContain('test-agentmail-secret');
    } finally {
      if (saved === undefined) {
        delete process.env.AGENTMAIL_API_KEY;
      } else {
        process.env.AGENTMAIL_API_KEY = saved;
      }
      harness.close();
    }
  });

  it('does not pass per-input correlation as process env (it is the .active-input.json file)', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await buildArgs(harness);
      expect(args.some((a) => a.includes('NANOCLAW_ACTIVE_INPUT_ID'))).toBe(false);
      expect(args.some((a) => a.startsWith('NANOCLAW_ROUTE_KEY='))).toBe(false);
      const { raw } = readSpawnEnvFile(args);
      expect(raw).not.toContain('NANOCLAW_ACTIVE_INPUT_ID');
      expect(raw).not.toContain('NANOCLAW_ROUTE_KEY=');
    } finally {
      harness.close();
    }
  });
});

describe('container env file (secrets off the command line)', () => {
  async function wakeAndGetArgs(harness: Awaited<ReturnType<typeof loadContainerRunnerHarness>>): Promise<string[]> {
    const wake = harness.containerRunner.wakeContainer(harness.session);
    await harness.oneCliStarted.promise;
    harness.oneCliRelease.resolve();
    await wake;
    return harness.spawnMock.mock.calls[0][1] as string[];
  }

  it('passes all env via --env-file with no -e KEY=value pairs on the command line', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await wakeAndGetArgs(harness);
      expect(args).toContain('--env-file');
      // No -e flags at all — every KEY=value moved off the command line.
      expect(args).not.toContain('-e');
      // No secret-bearing values visible in the args (proxy URLs, etc.).
      expect(args.join('\n')).not.toContain('GWS_PROXY_URL=');
      expect(args.join('\n')).not.toContain('http://yente-gws-proxy.local:8083');
      // The same env still reaches the container via the file.
      const { env } = readSpawnEnvFile(args);
      expect(env.get('GWS_PROXY_URL')).toBe('http://yente-gws-proxy.local:8083');
      expect(env.get('NANOCLAW_AGENT_GROUP_ID')).toBe('ag-1');
    } finally {
      harness.close();
    }
  });

  it('writes the env file (0600, expected content) before spawn and removes it after container start', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await wakeAndGetArgs(harness);
      const envFilePath = args[args.indexOf('--env-file') + 1];

      // Snapshot taken inside the spawn mock proves the file existed with
      // full content and private mode BEFORE docker was spawned.
      expect(harness.envFileSnapshots).toHaveLength(1);
      const snapshot = harness.envFileSnapshots[0];
      expect(snapshot.path).toBe(envFilePath);
      expect(snapshot.mode).toBe(0o600);
      expect(snapshot.content).toContain('GWS_PROXY_URL=http://yente-gws-proxy.local:8083');
      expect(snapshot.content).toContain('NANOCLAW_AGENT_GROUP_ID=ag-1');
      // Lives under the private data root, not /tmp.
      expect(envFilePath.startsWith(path.join(harness.dataDir, 'container-env'))).toBe(true);

      // First container output signals docker's create completed — the file
      // is deleted immediately.
      expect(fs.existsSync(envFilePath)).toBe(true);
      harness.spawnedProcesses[0].stdout.emit('data', Buffer.from('started\n'));
      expect(fs.existsSync(envFilePath)).toBe(false);
    } finally {
      harness.close();
    }
  });

  it('removes the env file when the container exits without producing output', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await wakeAndGetArgs(harness);
      const envFilePath = args[args.indexOf('--env-file') + 1];
      expect(fs.existsSync(envFilePath)).toBe(true);
      harness.spawnedProcesses[0].emit('close', 1);
      expect(fs.existsSync(envFilePath)).toBe(false);
    } finally {
      harness.close();
    }
  });

  it('sweeps stale env files left behind by a crash', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const staleDir = path.join(harness.dataDir, 'container-env');
      fs.mkdirSync(staleDir, { recursive: true });
      const stale = path.join(staleDir, 'nanoclaw-v2-agent-123.env');
      fs.writeFileSync(stale, 'SECRET=leftover\n');
      harness.containerRunner.cleanupStaleContainerEnvFiles();
      expect(fs.existsSync(stale)).toBe(false);
    } finally {
      harness.close();
    }
  });

  it('rejects env values containing newlines (env-file injection)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-envfile-'));
    const envFilePath = path.join(dir, 'test.env');
    try {
      expect(() => extractDockerEnvArgsToFile(['run', '-e', 'FOO=bar\nEVIL=injected'], envFilePath)).toThrow(/newline/);
      expect(() => extractDockerEnvArgsToFile(['run', '-e', 'FOO=bar\rbaz'], envFilePath)).toThrow(/newline/);
      expect(fs.existsSync(envFilePath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remaps exclusive CA env vars to the DENO_CERT combined bundle in the env file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-envfile-'));
    const envFilePath = path.join(dir, 'test.env');
    try {
      const args = [
        'run',
        '-e',
        'DENO_CERT=/tmp/onecli-combined-ca.pem',
        '-e',
        'SSL_CERT_FILE=/tmp/onecli-gateway-ca.pem',
        '-e',
        'CODEX_CA_CERTIFICATE=/tmp/onecli-gateway-ca.pem',
        '-e',
        'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem',
        'image',
      ];
      const remap = remapCaEnvToCombinedBundle(args);
      expect(remap).toEqual({
        combinedBundle: '/tmp/onecli-combined-ca.pem',
        remappedKeys: ['CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE'],
      });
      extractDockerEnvArgsToFile(args, envFilePath);
      const { env } = readSpawnEnvFile(['--env-file', envFilePath]);
      // All three exclusive-store/deno keys point at the combined bundle.
      expect(env.get('DENO_CERT')).toBe('/tmp/onecli-combined-ca.pem');
      expect(env.get('SSL_CERT_FILE')).toBe('/tmp/onecli-combined-ca.pem');
      expect(env.get('CODEX_CA_CERTIFICATE')).toBe('/tmp/onecli-combined-ca.pem');
      // NODE_EXTRA_CA_CERTS is additive and must never be modified.
      expect(env.get('NODE_EXTRA_CA_CERTS')).toBe('/tmp/onecli-gateway-ca.pem');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves SSL_CERT_FILE untouched when DENO_CERT is absent', () => {
    const args = ['run', '-e', 'SSL_CERT_FILE=/tmp/onecli-gateway-ca.pem', '-e', 'FOO=bar', 'image'];
    const before = [...args];
    expect(remapCaEnvToCombinedBundle(args)).toBeNull();
    expect(args).toEqual(before);
  });

  it('does not rewrite (and reports no remap to log) when values already match DENO_CERT', () => {
    const args = [
      'run',
      '-e',
      'DENO_CERT=/tmp/onecli-combined-ca.pem',
      '-e',
      'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem',
      '-e',
      'CODEX_CA_CERTIFICATE=/tmp/onecli-combined-ca.pem',
      'image',
    ];
    const before = [...args];
    // Null return is what gates the once-per-spawn log line in
    // buildContainerArgs, so no rewrite means no log.
    expect(remapCaEnvToCombinedBundle(args)).toBeNull();
    expect(args).toEqual(before);
  });

  it('never modifies NODE_EXTRA_CA_CERTS even when a remap happens', () => {
    const args = [
      'run',
      '-e',
      'DENO_CERT=/tmp/onecli-combined-ca.pem',
      '-e',
      'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem',
      '-e',
      'SSL_CERT_FILE=/tmp/onecli-gateway-ca.pem',
      'image',
    ];
    const remap = remapCaEnvToCombinedBundle(args);
    expect(remap?.remappedKeys).toEqual(['SSL_CERT_FILE']);
    expect(args).toContain('NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem');
    expect(args).toContain('SSL_CERT_FILE=/tmp/onecli-combined-ca.pem');
  });

  it('dedupes duplicate keys last-wins, matching docker -e semantics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-envfile-'));
    const envFilePath = path.join(dir, 'test.env');
    try {
      const out = extractDockerEnvArgsToFile(
        ['run', '-e', 'HTTP_PROXY=http://first', '--name', 'x', '-e', 'HTTP_PROXY=http://last', 'image'],
        envFilePath,
      );
      expect(out).toEqual(['run', '--env-file', envFilePath, '--name', 'x', 'image']);
      expect(fs.readFileSync(envFilePath, 'utf-8')).toBe('HTTP_PROXY=http://last\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('drainAllContainers', () => {
  it('resolves immediately when no containers are tracked', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      harness.execFileMock.mockClear();

      await harness.containerRunner.drainAllContainers(30);

      const stopCalls = harness.execFileMock.mock.calls.filter((call) => (call[1] as string[])[0] === 'stop');
      expect(stopCalls).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it('stops all tracked containers in parallel with the drain grace period', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      // Second session for the same agent group via a second messaging group.
      const db = await import('./db/index.js');
      const sessionManager = await import('./session-manager.js');
      db.createMessagingGroup({
        id: 'mg-2',
        channel_type: 'telegram',
        platform_id: 'telegram:456',
        name: 'Test Chat 2',
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: new Date().toISOString(),
      });
      const { session: session2 } = sessionManager.resolveSession('ag-1', 'mg-2', null, 'shared');

      harness.oneCliRelease.resolve();
      await harness.containerRunner.wakeContainer(harness.session);
      await harness.containerRunner.wakeContainer(session2);
      expect(harness.containerRunner.getActiveContainerCount()).toBe(2);

      const stopArgs: string[][] = [];
      const stopCallbacks: Array<() => void> = [];
      harness.execFileMock.mockImplementation((_file, args, _opts, cb) => {
        if ((args as string[])[0] === 'stop') {
          stopArgs.push(args as string[]);
          stopCallbacks.push(() => (cb as (err: null) => void)(null));
          return;
        }
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      });

      const drain = harness.containerRunner.drainAllContainers(30);

      // Both docker stop invocations were issued before either completed:
      // the stops run in parallel, not sequentially.
      expect(stopArgs).toHaveLength(2);
      for (const args of stopArgs) {
        expect(args.slice(0, 3)).toEqual(['stop', '-t', '30']);
      }

      for (const complete of stopCallbacks) complete();
      for (const proc of harness.spawnedProcesses) proc.emit('close', 0);

      await drain;
      expect(harness.containerRunner.getActiveContainerCount()).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('resolves even when one docker stop rejects', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const db = await import('./db/index.js');
      const sessionManager = await import('./session-manager.js');
      db.createMessagingGroup({
        id: 'mg-2',
        channel_type: 'telegram',
        platform_id: 'telegram:456',
        name: 'Test Chat 2',
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: new Date().toISOString(),
      });
      const { session: session2 } = sessionManager.resolveSession('ag-1', 'mg-2', null, 'shared');

      harness.oneCliRelease.resolve();
      await harness.containerRunner.wakeContainer(harness.session);
      await harness.containerRunner.wakeContainer(session2);
      expect(harness.containerRunner.getActiveContainerCount()).toBe(2);

      let stopCount = 0;
      harness.execFileMock.mockImplementation((_file, args, _opts, cb) => {
        if ((args as string[])[0] === 'stop') {
          stopCount += 1;
          if (stopCount === 1) {
            (cb as (err: Error) => void)(new Error('docker stop failed'));
          } else {
            (cb as (err: null) => void)(null);
          }
          return;
        }
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      });

      const drain = harness.containerRunner.drainAllContainers(30);
      for (const proc of harness.spawnedProcesses) proc.emit('close', 0);

      await expect(drain).resolves.toBeUndefined();
      expect(stopCount).toBe(2);
      expect(harness.containerRunner.getActiveContainerCount()).toBe(0);
    } finally {
      harness.close();
    }
  });
});
