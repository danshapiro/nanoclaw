import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  applyOneCliGatewayForContainerArgs,
  assertNoReservedAgentCommandCollisionsShell,
  buildManagedReposIpcMount,
  buildManagedReposMounts,
  buildLocalSkillsMount,
  resolveAgentImageForRun,
  resolveProviderName,
} from './container-runner.js';
import { AgentMcpCredentialUnavailableError, type AgentMcpBridgeOptions } from './agent-mcp-bridge.js';
import type { AgentMcpConfigForGroup } from './agent-mcp-config.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup } from './types.js';

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

function fakeChildProcess(pid = 12345): NodeJS.EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.pid = pid;
  proc.kill = vi.fn();
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
  const spawnMock = vi.fn((_command: string, _args: string[], _options?: unknown) => {
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
        NO_PROXY: 'localhost,127.0.0.1,registry.npmjs.org',
        no_proxy: 'localhost,127.0.0.1,registry.npmjs.org',
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
  it('throws before spawn args are complete when OneCLI returns false', async () => {
    const args = ['run'];
    const client = {
      ensureAgent: vi.fn().mockResolvedValue(undefined),
      applyContainerConfig: vi.fn().mockResolvedValue(false),
    };

    await expect(
      applyOneCliGatewayForContainerArgs(args, {
        client,
        containerName: 'container-1',
        agentGroupName: 'Yente',
        agentIdentifier: 'ag-main',
        ensureSecretAccess: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('OneCLI gateway did not apply container credentials');

    expect(client.ensureAgent).toHaveBeenCalledWith({ name: 'Yente', identifier: 'ag-main' });
    expect(client.applyContainerConfig).toHaveBeenCalledWith(args, { addHostMapping: false, agent: 'ag-main' });
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
      expect(args).toContain(
        'PATH=/app/skills/.bin:/pnpm/bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
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
      expect(args).toContain('YENTE_BROWSER_HANDOFF_URL=http://yente-browser-handoff.local:6081');
      expect(args).toContain('GWS_PROXY_URL=http://yente-gws-proxy.local:8083');
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
      const effectiveEnv = new Map<string, string>();
      for (let index = 0; index < args.length - 1; index++) {
        if (args[index] !== '-e') continue;
        const entry = args[index + 1];
        const eq = entry.indexOf('=');
        if (eq > 0) effectiveEnv.set(entry.slice(0, eq), entry.slice(eq + 1));
      }
      expect(effectiveEnv.get('HTTP_PROXY')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('HTTPS_PROXY')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('http_proxy')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
      expect(effectiveEnv.get('https_proxy')).toBe('http://agent-token@yente-onecli-auth-gate.local:18055');
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
        { timeout: 5000 },
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
      // The flat docker-run arg list is ['-e', 'KEY=VALUE', ...].
      // Verify the exact static value is present as a discrete arg.
      expect(args).toContain('NANOCLAW_SIDE_EFFECT_LEDGER=/workspace/side-effects.jsonl');
    } finally {
      harness.close();
    }
  });

  it('passes the owning agent group identity for local skills', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const args = await buildArgs(harness);
      expect(args).toContain('NANOCLAW_AGENT_GROUP_ID=ag-1');
      expect(args).toContain('NANOCLAW_AGENT_GROUP_FOLDER=agent');
    } finally {
      harness.close();
    }
  });

  it('injects the Ed25519 public verify key when the host env var is set', async () => {
    const harness = await loadContainerRunnerHarness();
    const saved = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    try {
      process.env.GWS_SIDE_EFFECT_VERIFY_KEY = 'test-pub-key-base64';
      const args = await buildArgs(harness);
      expect(args).toContain('GWS_SIDE_EFFECT_VERIFY_KEY=test-pub-key-base64');
    } finally {
      if (saved === undefined) {
        delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      } else {
        process.env.GWS_SIDE_EFFECT_VERIFY_KEY = saved;
      }
      harness.close();
    }
  });

  it('omits the Ed25519 public verify key when the host env var is absent', async () => {
    const harness = await loadContainerRunnerHarness();
    const saved = process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
    try {
      delete process.env.GWS_SIDE_EFFECT_VERIFY_KEY;
      const args = await buildArgs(harness);
      // The key must be absent so the in-container default applies.
      expect(args.some((a) => a.startsWith('GWS_SIDE_EFFECT_VERIFY_KEY='))).toBe(false);
    } finally {
      if (saved !== undefined) {
        process.env.GWS_SIDE_EFFECT_VERIFY_KEY = saved;
      }
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
    } finally {
      delete process.env.GWS_SIDE_EFFECT_SIGN_KEY_FILE;
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
    } finally {
      harness.close();
    }
  });
});
