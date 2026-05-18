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
  buildPortableSkillsMount,
  resolveProviderName,
} from './container-runner.js';
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

async function loadContainerRunnerHarness() {
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
    loadAgentMcpConfigForGroup: vi.fn(() => ({ bridges: {}, allowedTools: [] })),
  }));
  vi.doMock('./agent-mcp-bridge.js', () => ({
    startAgentMcpBridge: vi.fn(),
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
    spawnedProcesses,
    spawnMock,
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

  it('throws when async stop and process kill both fail', async () => {
    const harness = await loadContainerRunnerHarness();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      harness.execFileMock.mockImplementationOnce((_file, _args, _options, cb) => {
        cb(new Error('stop failed'));
      });
      const wake = harness.containerRunner.wakeContainer(harness.session);
      await harness.oneCliStarted.promise;
      harness.oneCliRelease.resolve();
      await wake;
      harness.spawnedProcesses[0].kill.mockImplementationOnce(() => {
        throw new Error('kill failed');
      });

      await expect(
        harness.containerRunner.cleanupContainerForSession(harness.session.id, 'yente-session-reset'),
      ).rejects.toThrow('Failed to clean up container for session');
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

describe('portable skills mount', () => {
  const baseGroup: AgentGroup = {
    id: 'ag-main',
    name: 'Yente',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-04-25T00:00:00.000Z',
  };

  it('mounts the writable portable skills root for any agent group', () => {
    expect(
      buildPortableSkillsMount(baseGroup, {
        NANOCLAW_WRITABLE_SKILLS_DIR: '/srv/nanoclaw/shared/repos/portable-skills',
      }),
    ).toEqual({
      hostPath: '/srv/nanoclaw/shared/repos/portable-skills',
      containerPath: '/workspace/portable-skills',
      readonly: false,
    });
  });

  it('uses the same portable authoring mount for non-main groups', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };

    expect(
      buildPortableSkillsMount(researchGroup, {
        NANOCLAW_WRITABLE_SKILLS_DIR: '/srv/nanoclaw/shared/repos/portable-skills',
      }),
    ).toEqual({
      hostPath: '/srv/nanoclaw/shared/repos/portable-skills',
      containerPath: '/workspace/portable-skills',
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
