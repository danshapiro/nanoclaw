import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResponsePayload } from '../../response-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createPendingApproval,
  createSession,
  getPendingApproval,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { handleApprovalsResponse } from './response-handler.js';

const mocks = vi.hoisted(() => ({
  wakeContainer: vi.fn(),
  writeSessionMessage: vi.fn(),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: mocks.wakeContainer,
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: mocks.writeSessionMessage,
}));

vi.mock('./onecli-approvals.js', () => ({
  ONECLI_ACTION: 'onecli_credential',
  resolveOneCLIApproval: vi.fn(() => false),
}));

function now(): string {
  return new Date().toISOString();
}

function responsePayload(overrides: Partial<ResponsePayload> = {}): ResponsePayload {
  return {
    questionId: 'appr-1',
    value: 'approve',
    userId: 'discord:admin',
    channelType: 'discord',
    platformId: 'chan-1',
    threadId: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.wakeContainer.mockReset();
  mocks.writeSessionMessage.mockReset();
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent 1',
    folder: 'agent-1',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-1',
    name: 'Yente',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('handleApprovalsResponse', () => {
  it('claims and drops approval responses for resetting sessions without writing or waking', async () => {
    createSession({
      id: 'sess-resetting',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: null,
      agent_provider: null,
      status: 'resetting',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-resetting',
      request_id: 'appr-1',
      action: 'install_packages',
      payload: JSON.stringify({ packages: ['ripgrep'] }),
      created_at: now(),
      title: 'Approve install',
      options_json: '[]',
    });

    await expect(handleApprovalsResponse(responsePayload())).resolves.toBe(true);

    expect(mocks.writeSessionMessage).not.toHaveBeenCalled();
    expect(mocks.wakeContainer).not.toHaveBeenCalled();
    expect(getPendingApproval('appr-1')).toBeUndefined();
  });

  it('claims and drops approval responses for terminal inactive sessions', async () => {
    createSession({
      id: 'sess-archived',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: null,
      agent_provider: null,
      status: 'archived',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-archived',
      request_id: 'appr-1',
      action: 'install_packages',
      payload: JSON.stringify({ packages: ['ripgrep'] }),
      created_at: now(),
      title: 'Approve install',
      options_json: '[]',
    });

    await expect(handleApprovalsResponse(responsePayload())).resolves.toBe(true);

    expect(mocks.writeSessionMessage).not.toHaveBeenCalled();
    expect(mocks.wakeContainer).not.toHaveBeenCalled();
    expect(getPendingApproval('appr-1')).toBeUndefined();
  });
});
