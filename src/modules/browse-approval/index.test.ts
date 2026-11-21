import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  request: vi.fn(async () => {
    throw new Error('Browse broker unavailable');
  }),
  resolve: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: vi.fn(),
  registerDeliveryAction: (name: string, handler: (...args: unknown[]) => Promise<void>) =>
    mocks.handlers.set(name, handler),
}));
vi.mock('../../response-registry.js', () => ({
  onShutdown: vi.fn(),
  onStartup: vi.fn(),
  registerPlatformActionPreflight: vi.fn(),
  registerResponseHandler: vi.fn(),
  RejectedPlatformAction: Error,
}));
vi.mock('../../session-manager.js', () => ({ hostCorrelationPath: () => '/does-not-exist/browse-pointer.json' }));
vi.mock('../approvals/primitive.js', () => ({ notifyAgent: mocks.notify }));
vi.mock('./service.js', () => ({
  BrowseApprovalService: class {
    request = mocks.request;
  },
  resolveBrowseRequester: mocks.resolve,
  validateBrowseRequest: (value: unknown) => value,
}));
import './index.js';

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.notify.mockClear();
});

it('routes a request failure to its verified human origin so a warm query receives it', async () => {
  const session = { id: 'session', agent_group_id: 'agent' } as Session;
  const requester = {
    userId: 'dan',
    channelType: 'discord',
    platformId: 'qa',
    threadId: 'thread',
    messagingGroupId: 'mg-qa',
    isGroup: 1,
  };
  mocks.resolve.mockReturnValue(requester);
  await mocks.handlers.get('request_browse_session')!({}, session, {});
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
    session,
    expect.stringContaining('Browse broker unavailable'),
    requester,
  );
});

it('does not use supplied route fields when human provenance fails', async () => {
  const session = { id: 'session', agent_group_id: 'agent' } as Session;
  mocks.resolve.mockImplementation(() => {
    throw new Error('No host-accepted human request');
  });
  await mocks.handlers.get('request_browse_session')!({ platformId: 'agent-supplied' }, session, {});
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
    session,
    expect.stringContaining('No host-accepted human request'),
    undefined,
  );
});
