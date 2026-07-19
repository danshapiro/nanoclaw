import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgentGroup: vi.fn(),
  createDestination: vi.fn(),
  initGroupFilesystem: vi.fn(),
  readContainerConfig: vi.fn(),
  resolveProviderName: vi.fn(),
  writeDestinations: vi.fn(),
  writeSessionMessage: vi.fn(),
}));

vi.mock('../../config.js', () => ({ GROUPS_DIR: '/tmp/nanoclaw-create-agent-test' }));
vi.mock('../../container-config.js', () => ({
  readContainerConfig: (...args: unknown[]) => mocks.readContainerConfig(...args),
}));
vi.mock('../../container-runner.js', () => ({
  resolveProviderName: (...args: unknown[]) => mocks.resolveProviderName(...args),
  wakeContainer: vi.fn(),
}));
vi.mock('../../db/agent-groups.js', () => ({
  createAgentGroup: (...args: unknown[]) => mocks.createAgentGroup(...args),
  getAgentGroup: () => ({
    id: 'ag-parent',
    name: 'Parent',
    folder: 'parent',
    agent_provider: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }),
  getAgentGroupByFolder: () => null,
}));
vi.mock('../../db/sessions.js', () => ({ getSession: () => null }));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...args: unknown[]) => mocks.initGroupFilesystem(...args),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mocks.writeSessionMessage(...args),
}));
vi.mock('./db/agent-destinations.js', () => ({
  createDestination: (...args: unknown[]) => mocks.createDestination(...args),
  getDestinationByName: () => null,
  normalizeName: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...args: unknown[]) => mocks.writeDestinations(...args),
}));

import { handleCreateAgent } from './create-agent.js';

const session = {
  id: 'sess-parent',
  agent_group_id: 'ag-parent',
  agent_provider: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleCreateAgent provider inheritance', () => {
  it('pins a Codex child to its parent effective provider', async () => {
    mocks.readContainerConfig.mockReturnValue({ provider: 'codex' });
    mocks.resolveProviderName.mockReturnValue('codex');

    await handleCreateAgent({ name: 'Researcher', instructions: 'Investigate' }, session);

    expect(mocks.resolveProviderName).toHaveBeenCalledWith(null, null, 'codex');
    expect(mocks.initGroupFilesystem).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Researcher' }),
      expect.objectContaining({ instructions: 'Investigate', provider: 'codex' }),
    );
  });

  it('pins an explicit Claude parent child to Claude instead of the instance default', async () => {
    mocks.readContainerConfig.mockReturnValue({ provider: 'claude' });
    mocks.resolveProviderName.mockReturnValue('claude');

    await handleCreateAgent({ name: 'Researcher', instructions: null }, session);

    expect(mocks.initGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'claude' }),
    );
  });

  it('keeps an OpenCode companion on its parent provider', async () => {
    mocks.readContainerConfig.mockReturnValue({ provider: 'opencode' });
    mocks.resolveProviderName.mockReturnValue('opencode');

    await handleCreateAgent({ name: 'Researcher', instructions: null }, session);

    expect(mocks.initGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'opencode' }),
    );
  });
});
