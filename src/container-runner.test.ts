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
import type { AgentMcpBridgeOptions } from './agent-mcp-bridge.js';
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

async function loadContainerRunnerHarness(
  options: {
    mcpConfigForGroup?: (folder: string) => AgentMcpConfigForGroup;
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
  const applyContainerConfigMock = vi.fn(async () => {
    oneCliStarted.resolve();
    await oneCliRelease.promise;
    return true;
  });
  const loadAgentMcpConfigForGroupMock = vi.fn(
    (folder: string) => options.mcpConfigForGroup?.(folder) ?? { bridges: {}, allowedTools: [] },
  );
  const startAgentMcpBridgeMock = vi.fn(async (opts: AgentMcpBridgeOptions) => ({
    serverName: opts.bridge.serverName,
    hostSocketDir: path.join(root, 'mcp-runs', opts.bridge.serverName),
    hostSocketPath: path.join(root, 'mcp-runs', opts.bridge.serverName, `${opts.bridge.socketNamePrefix}.sock`),
    containerSocketDir: `/workspace/mcp/${opts.bridge.serverName}`,
    containerSocketPath: `/workspace/mcp/${opts.bridge.serverName}/${opts.bridge.socketNamePrefix}.sock`,
    authDir: path.join(root, 'auth', opts.bridge.serverName),
    stop: vi.fn(),
  }));

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
  vi.doMock('./agent-mcp-bridge.js', () => ({
    startAgentMcpBridge: startAgentMcpBridgeMock,
  }));
  vi.doMock('./providers/index.js', () => ({}));
  vi.doMock('./yente/service-env.js', () => ({
    assertOneCliApplied(applied: boolean): void {
      if (!applied) throw new Error('OneCLI gateway did not apply container credentials');
    },
    ensureOneCliAgentSecretAccess: vi.fn().mockResolvedValue(undefined),
  }));

  const db = await import('./db/index.js');
  const sessions = await import('./db/sessions.js');
  const sessionManager = await import('./session-manager.js');
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
    containerRunner,
    oneCliRelease,
    oneCliStarted,
    session,
    sessions,
    execFileMock,
    groupsDir,
    loadAgentMcpConfigForGroupMock,
    root,
    spawnedProcesses,
    spawnMock,
    startAgentMcpBridgeMock,
  };
}

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
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

  it('exposes skill-local helper bins on the base container PATH', async () => {
    const harness = await loadContainerRunnerHarness();
    try {
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;

      const args = harness.spawnMock.mock.calls[0][1];
      expect(args).toContain(
        'PATH=/app/skills/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
      );
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
