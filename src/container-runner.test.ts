import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyOneCliGatewayForContainerArgs,
  buildGwsConfigMount,
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

    expect(
      buildManagedReposMounts(researchGroup, {
        NANOCLAW_MANAGED_REPOS_DIR: '/srv/nanoclaw/shared/repos/projects',
      }),
    ).toEqual([]);
  });

  it('fails closed when the configured managed repos root is missing', () => {
    expect(() =>
      buildManagedReposMounts(baseGroup, {
        NANOCLAW_MANAGED_REPOS_DIR: '/definitely/missing/nanoclaw-managed-repos',
      }),
    ).toThrow('NANOCLAW_MANAGED_REPOS_DIR must exist');
  });
});

describe('gws config mount', () => {
  it('mounts the shared gws config into the agent home when credentials are provisioned', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gws-mount-'));
    try {
      const sharedData = path.join(root, 'shared', 'data');
      const gwsConfig = path.join(root, 'shared', 'gws-config');
      fs.mkdirSync(sharedData, { recursive: true });
      fs.mkdirSync(gwsConfig, { recursive: true });
      fs.writeFileSync(path.join(gwsConfig, 'credentials.enc'), 'encrypted');

      expect(buildGwsConfigMount(sharedData)).toEqual({
        hostPath: gwsConfig,
        containerPath: '/home/node/.config/gws',
        readonly: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mount gws config until credentials are provisioned', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gws-mount-'));
    try {
      const sharedData = path.join(root, 'shared', 'data');
      fs.mkdirSync(sharedData, { recursive: true });

      expect(buildGwsConfigMount(sharedData)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
