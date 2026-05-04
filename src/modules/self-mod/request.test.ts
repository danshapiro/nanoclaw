import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';
import { handleInstallPackages } from './request.js';

const { getAgentGroup, notifyAgent, requestApproval, warn } = vi.hoisted(() => ({
  getAgentGroup: vi.fn(),
  notifyAgent: vi.fn(),
  requestApproval: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup,
}));

vi.mock('../../log.js', () => ({
  log: {
    warn,
  },
}));

vi.mock('../approvals/index.js', () => ({
  notifyAgent,
  requestApproval,
}));

const testSession: Session = {
  id: 'session-1',
  agent_group_id: 'ag-main',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'idle',
  last_active: null,
  created_at: '2026-05-03T00:00:00.000Z',
};

describe('handleInstallPackages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentGroup.mockReturnValue({
      id: 'ag-main',
      name: 'Yente',
      folder: 'main',
      agent_provider: null,
      created_at: '2026-05-03T00:00:00.000Z',
    });
  });

  it('rejects direct Google Workspace CLI package requests', async () => {
    await handleInstallPackages({ npm: ['@googleworkspace/cli'], reason: 'bypass test' }, testSession);

    expect(notifyAgent).toHaveBeenCalledWith(testSession, expect.stringContaining('install_packages failed'));
    expect(notifyAgent).toHaveBeenCalledWith(testSession, expect.stringContaining('GWS proxy shim'));
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
