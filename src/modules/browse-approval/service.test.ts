import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';
import {
  BrowseApprovalService,
  resolveBrowseRequester,
  type BrowseRecord,
  type BrowseDependencies,
} from './service.js';

const session: Session = {
  id: 'sess-a',
  agent_group_id: 'ag-a',
  messaging_group_id: 'mg-a',
  thread_id: 'discord:g:parent:thread',
  agent_provider: 'codex',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-11-21T00:00:00Z',
};
const request = {
  requestId: 'request-a',
  purpose: 'Summarize friends updates',
  url: 'https://www.facebook.com/',
  browser: 'chrome-dandesktop',
  hostInputId: 'input-a',
  routeKey: 'route-a',
};
function fixture() {
  const records: BrowseRecord[] = [];
  const broker = {
    reset: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    grant: vi.fn(async () => ({
      token: 'secret-permit',
      sessionId: session.id,
      requestId: request.requestId,
      browser: request.browser,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      maximumExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    })),
  };
  const deps: BrowseDependencies = {
    broker,
    getSession: () => session,
    writeRecord: (_s, r) => records.push(r),
    sendCard: vi.fn(async () => ({
      channelType: 'discord',
      platformId: 'discord:g:parent',
      threadId: session.thread_id,
      messageId: 'card-a',
    })),
    saveRender: vi.fn(),
    deleteRender: vi.fn(),
    notify: vi.fn(),
    now: () => Date.now(),
  };
  const service = new BrowseApprovalService(deps);
  const requester = {
    userId: 'dan',
    channelType: 'discord',
    platformId: 'discord:g:parent',
    threadId: session.thread_id,
    messagingGroupId: 'mg-origin',
    isGroup: 1 as const,
  };
  const response = (value = 'allow') => ({
    questionId: service.questionId(session.id)!,
    value,
    userId: 'dan',
    channelType: 'discord',
    platformId: 'discord:g:parent',
    threadId: session.thread_id,
    transportReceipt: { source: 'discord-component' as const, channelId: 'thread', messageId: 'card-a' },
  });
  return { service, deps, broker, records, requester, response };
}

afterEach(() => vi.useRealTimers());
describe('Browse host approval', () => {
  it('does not grant until an exact human platform click; generic response cannot approve', async () => {
    const f = fixture();
    await f.service.request(session, request, f.requester);
    expect(f.broker.grant).not.toHaveBeenCalled();
    expect(f.records.at(-1)).toMatchObject({ status: 'pending', requestId: 'request-a' });
    const { transportReceipt: _receipt, ...forged } = f.response();
    expect(await f.service.respond(forged)).toBe('rejected');
    expect(f.broker.grant).not.toHaveBeenCalled();
    expect(await f.service.respond(f.response())).toBe(true);
    expect(f.broker.grant).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'sess-a',
      requestId: 'request-a',
      browser: 'chrome-dandesktop',
    });
    expect(f.records.at(-1)).toMatchObject({ status: 'approved', token: 'secret-permit' });
    expect(f.deps.notify).toHaveBeenCalledExactlyOnceWith(
      session,
      expect.stringContaining('approved by the requesting human'),
      f.requester,
    );
    await f.service.shutdown();
  });
  it.each(['user', 'channel', 'card'])('rejects a different %s without consuming the pending request', async (kind) => {
    const f = fixture();
    await f.service.request(session, request, f.requester);
    const p = f.response();
    if (kind === 'user') p.userId = 'other';
    if (kind === 'channel') p.transportReceipt.channelId = 'elsewhere';
    if (kind === 'card') p.transportReceipt.messageId = 'other-card';
    expect(await f.service.respond(p)).toBe('rejected');
    expect(f.broker.grant).not.toHaveBeenCalled();
    expect(await f.service.respond(f.response())).toBe(true);
    expect(f.broker.grant).toHaveBeenCalledTimes(1);
    await f.service.shutdown();
  });
  it('cancels without a grant and ignores duplicate and late clicks', async () => {
    const f = fixture();
    await f.service.request(session, request, f.requester);
    const click = f.response('cancel');
    expect(await f.service.respond(click)).toBe(true);
    expect(f.records.at(-1)?.status).toBe('cancelled');
    expect(await f.service.respond({ ...click, value: 'allow' })).toBe('rejected');
    expect(f.broker.grant).not.toHaveBeenCalled();
    await f.service.shutdown();
  });
  it('allows one concurrent approval and Stop revokes the granted session', async () => {
    const f = fixture();
    await f.service.request(session, request, f.requester);
    const click = f.response();
    await Promise.all([f.service.respond(click), f.service.respond(click)]);
    expect(f.broker.grant).toHaveBeenCalledTimes(1);
    await f.service.respond(f.response('stop'));
    expect(f.records.at(-1)?.status).toBe('ended');
    expect(f.broker.revoke).toHaveBeenCalledWith('sess-a');
    await f.service.shutdown();
  });
  it.each(['archived', 'closed', 'resetting', 'missing'])(
    'revokes an approved permit when the native session becomes %s',
    async (status) => {
      const f = fixture();
      await f.service.request(session, request, f.requester);
      await f.service.respond(f.response());
      f.broker.revoke.mockClear();
      f.deps.getSession = () =>
        status === 'missing' ? undefined : { ...session, status: status as Session['status'] };
      await f.service.sweepInactiveSessions();
      expect(f.broker.revoke).toHaveBeenCalledExactlyOnceWith(session.id);
      expect(f.records.at(-1)).toMatchObject({ status: 'ended' });
      expect(f.records.at(-1)).not.toHaveProperty('token');
      await f.service.shutdown();
    },
  );
  it('keeps an approved permit while its active conversation container sleeps', async () => {
    const f = fixture();
    await f.service.request(session, request, f.requester);
    await f.service.respond(f.response());
    f.broker.revoke.mockClear();
    f.deps.getSession = () => ({ ...session, container_status: 'stopped' });
    await f.service.sweepInactiveSessions();
    expect(f.broker.revoke).not.toHaveBeenCalled();
    expect(f.records.at(-1)).toMatchObject({ status: 'approved' });
    await f.service.shutdown();
  });
  it('does not expire an active grant at its initial sliding idle deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.request(session, request, f.requester);
    await f.service.respond(f.response());
    await vi.advanceTimersByTimeAsync(600001);
    expect(f.records.at(-1)).toMatchObject({ status: 'approved' });
    await vi.advanceTimersByTimeAsync(3000000);
    expect(f.records.at(-1)).toMatchObject({ status: 'expired' });
    await f.service.shutdown();
  });
  it('expires an unanswered request and startup resets previously issued permits', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.initialize();
    expect(f.broker.reset).toHaveBeenCalledTimes(1);
    await f.service.request(session, request, f.requester);
    const click = f.response();
    await vi.advanceTimersByTimeAsync(600001);
    expect(f.records.at(-1)?.status).toBe('expired');
    expect(await f.service.respond(click)).toBe('rejected');
    expect(f.broker.grant).not.toHaveBeenCalled();
    await f.service.shutdown();
  });
  it('rejects approval after the native session closes and does not let old end requests close a replacement', async () => {
    const f = fixture();
    await f.service.request(session, request, f.requester);
    await f.service.request(session, { ...request, requestId: 'request-b' }, f.requester);
    await f.service.end(session, 'request-a');
    expect(f.records.at(-1)).toMatchObject({ requestId: 'request-b', status: 'pending' });
    f.deps.getSession = () => ({ ...session, status: 'closed' });
    expect(await f.service.respond(f.response())).toBe('rejected');
    expect(f.broker.grant).not.toHaveBeenCalled();
    await f.service.shutdown();
  });
});

it('checks the pending deadline even when the event-loop timer has not run', async () => {
  const f = fixture();
  let now = Date.now();
  f.deps.now = () => now;
  await f.service.request(session, request, f.requester);
  const click = f.response();
  now += 600001;
  expect(f.service.canRespond(click)).toBe(false);
  expect(await f.service.respond(click)).toBe('rejected');
  expect(f.broker.grant).not.toHaveBeenCalled();
  await f.service.shutdown();
});

describe('host input provenance', () => {
  it('uses the exact live host-accepted Discord human rather than supplied user fields', () => {
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE messages_in (id TEXT, seq INTEGER, kind TEXT, channel_type TEXT, platform_id TEXT, thread_id TEXT, content TEXT, trigger INTEGER, host_accepted_input_id TEXT, host_accepted_route_key TEXT, host_acceptance_ended_at TEXT, host_accepted_at TEXT, messaging_group_id TEXT DEFAULT 'mg-origin', is_group INTEGER DEFAULT 1)`,
    );
    const put = db.prepare(
      'INSERT INTO messages_in (id, seq, kind, channel_type, platform_id, thread_id, content, trigger, host_accepted_input_id, host_accepted_route_key, host_acceptance_ended_at, host_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    );
    put.run(
      'm-a',
      2,
      'chat-sdk',
      'discord',
      'discord:g:parent',
      session.thread_id,
      JSON.stringify({ senderId: 'dan', author: { isMe: false } }),
      'input-a',
      'route-a',
      null,
      new Date().toISOString(),
    );
    put.run(
      'm-b',
      4,
      'chat-sdk',
      'discord',
      'discord:g:parent',
      session.thread_id,
      JSON.stringify({ senderId: 'other' }),
      'other-input',
      'route-a',
      null,
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(
      resolveBrowseRequester(db, session, request, { inputId: 'input-a', routeKey: 'route-a', sessionId: 'sess-a' }),
    ).toMatchObject({ userId: 'dan', messagingGroupId: 'mg-origin', isGroup: 1 });
    expect(() =>
      resolveBrowseRequester(db, session, request, {
        inputId: 'other-input',
        routeKey: 'route-a',
        sessionId: 'sess-a',
      }),
    ).toThrow(/current/);
    db.prepare("UPDATE messages_in SET host_acceptance_ended_at='ended' WHERE id='m-a'").run();
    expect(resolveBrowseRequester(db, session, request, null)).toMatchObject({ userId: 'dan' });
    db.prepare("UPDATE messages_in SET host_accepted_at=? WHERE id='m-a'").run(
      new Date(Date.now() - 700000).toISOString(),
    );
    expect(() =>
      resolveBrowseRequester(db, session, request, { inputId: 'input-a', routeKey: 'route-a', sessionId: 'sess-a' }),
    ).toThrow(/human/);
    db.close();
  });
});
