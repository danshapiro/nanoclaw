import { afterEach, beforeEach, expect, it, mock } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { normalizeRoute } from './formatter.js';
import { runPollLoop } from './poll-loop.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for activity');
    await Bun.sleep(10);
  }
}

beforeEach(() => initTestSessionDb());
afterEach(() => {
  closeSessionDb();
  mock.restore();
});

it('publishes a Claude follow-up selected by the SDK while its output remains silent', async () => {
  const selected = deferred();
  const finish = deferred();
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      (async function* () {
        const reader = (async () => {
          let count = 0;
          for await (const _message of prompt) {
            if (++count === 2) {
              selected.resolve();
              break;
            }
          }
        })();
        await finish.promise;
        await reader;
        yield { type: 'result', result: 'done' };
      })(),
  }));
  const { ClaudeProvider } = await import('./providers/claude.js');
  const route = {
    channelType: 'discord',
    platformId: 'channel',
    threadId: 'one',
    messagingGroupId: 'dm',
    isGroup: 0 as const,
  };
  const routeKey = normalizeRoute('claude', route).routeKey;
  const insert = (id: string, thread: string) =>
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id,
      messaging_group_id, is_group, host_input_id, host_route_key, host_received_at, content)
     VALUES (?, 'chat-sdk', datetime('now'), 'pending', 1, 'channel', 'discord', ?, 'dm', 0, ?, ?, datetime('now'), ?)`,
      )
      .run(id, thread, `host-${id}`, routeKey, JSON.stringify({ text: id }));
  insert('first', 'one');
  const snapshots: Array<Array<{ platformId: string; threadId: string | null }>> = [];
  const controller = new AbortController();
  const loop = runPollLoop({
    provider: new ClaudeProvider(),
    providerName: 'claude',
    cwd: '/tmp',
    signal: controller.signal,
    bindGwsCorrelation: async () => {},
    releaseGwsCorrelation: async () => {},
    publishTypingActivity: (targets) => snapshots.push(targets),
  });
  try {
    await waitFor(() => snapshots.some((targets) => targets.some((target) => target.threadId === 'one')));
    insert('second', 'two');
    await selected.promise;
    await waitFor(() => snapshots.some((targets) => targets.some((target) => target.threadId === 'two')));
  } finally {
    finish.resolve();
    controller.abort();
    await loop.catch(() => {});
  }
}, 10000);

it('closes the SDK iterator when the provider event consumer stops', async () => {
  let closed = false;
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      (async function* () {
        try {
          for await (const _message of prompt) {
            yield { type: 'system', subtype: 'init', session_id: 'test' };
            break;
          }
        } finally {
          closed = true;
        }
      })(),
  }));
  const { ClaudeProvider } = await import('./providers/claude.js');
  const query = new ClaudeProvider().query({
    inputId: 'test',
    acceptInput: async () => {},
    prompt: 'test',
    cwd: '/tmp',
  });
  const events = query.events[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ type: 'input-accepted' });
  await events.return?.();
  await waitFor(() => closed);
});
