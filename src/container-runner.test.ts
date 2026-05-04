import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
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

describe('portable skills mount', () => {
  const baseGroup: AgentGroup = {
    id: 'ag-main',
    name: 'Yente',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-04-25T00:00:00.000Z',
  };

  it('mounts the writable portable skills root only for the main group', () => {
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

  it('does not mount portable authoring for non-main groups', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };

    expect(
      buildPortableSkillsMount(researchGroup, {
        NANOCLAW_WRITABLE_SKILLS_DIR: '/srv/nanoclaw/shared/repos/portable-skills',
      }),
    ).toBeNull();
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

  it('mounts the managed repos root for main at the stable path and Claude additional-dir path', () => {
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

  it('does not mount managed repos for non-main groups', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };

    const mounts = buildManagedReposMounts(researchGroup, {
      NANOCLAW_MANAGED_REPOS_DIR: '/srv/nanoclaw/shared/repos/projects',
    });

    expect(mounts).toEqual([]);
    expect(mounts.map((mount) => mount.containerPath)).not.toContain('/workspace/repos');
  });

  it('fails closed when the configured managed repos root is missing', () => {
    expect(() =>
      buildManagedReposMounts(baseGroup, {
        NANOCLAW_MANAGED_REPOS_DIR: '/definitely/missing/nanoclaw-managed-repos',
      }),
    ).toThrow('NANOCLAW_MANAGED_REPOS_DIR must exist');
  });

  it('mounts the main managed-repos IPC namespace for legacy reconcile requests', () => {
    expect(buildManagedReposIpcMount(baseGroup)).toMatchObject({
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  });

  it('does not mount managed-repos IPC for non-main groups', () => {
    const researchGroup: AgentGroup = { ...baseGroup, id: 'ag-research', folder: 'research', name: 'Research' };
    expect(buildManagedReposIpcMount(researchGroup)).toBeNull();
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
