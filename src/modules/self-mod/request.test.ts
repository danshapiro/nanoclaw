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

  it('rejects package installs for deployed skill dependencies before approval', async () => {
    await handleInstallPackages(
      { apt: ['golang-go'], reason: 'Install Go to use flight-goat CLI for Wisconsin flights' },
      testSession,
    );

    expect(notifyAgent).toHaveBeenCalledWith(testSession, expect.stringContaining('installed skill dependencies'));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects variant deployed skill dependency wording', async () => {
    await handleInstallPackages({ apt: ['golang-go'], reason: 'install Go so pp-flight-goat can run' }, testSession);

    expect(notifyAgent).toHaveBeenCalledWith(testSession, expect.stringContaining('installed skill dependencies'));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects explicit deployed skill dependency purpose even with terse reason', async () => {
    await handleInstallPackages(
      { apt: ['golang-go'], reason: 'needed', purpose: 'deployed_skill_dependency' },
      testSession,
    );

    expect(notifyAgent).toHaveBeenCalledWith(testSession, expect.stringContaining('installed skill dependencies'));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('allows explicit user-requested general capability installs', async () => {
    await handleInstallPackages(
      {
        apt: ['golang-go'],
        reason: 'User asked me to add Go for compiling a personal project CLI',
        purpose: 'general_capability',
      },
      testSession,
    );

    expect(notifyAgent).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'install_packages',
        payload: expect.objectContaining({
          apt: ['golang-go'],
          purpose: 'general_capability',
        }),
      }),
    );
  });
});
