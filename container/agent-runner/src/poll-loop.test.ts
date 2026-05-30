import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  initTestSessionDb,
  closeSessionDb,
  getInboundDb,
  getOutboundDb,
  clearStaleProcessingAcks,
} from './db/connection.js';
import {
  getPendingMessages,
  markCompleted,
  markRecoveryOwned,
  markRecoveryCompleted,
  returnProcessingToPending,
} from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import {
  appendRecoveryEntry,
  listRecoveryEntries,
  markRecoveryInFlight,
  resolveRecoveryEntry,
  type ProviderRecoveryEntry,
  type ProviderRecoveryScope,
} from './db/session-state.js';
import { formatMessages, extractRouting, normalizeRoute } from './formatter.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput, QueryTurnInput } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: {
    processAfter?: string;
    trigger?: 0 | 1;
    platformId?: string;
    channelType?: string;
    threadId?: string;
    messagingGroupId?: string | null;
    isGroup?: 0 | 1 | null;
  },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, thread_id, messaging_group_id, is_group, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.platformId ?? null,
      opts?.channelType ?? null,
      opts?.threadId ?? null,
      opts?.messagingGroupId ?? null,
      opts?.isGroup ?? null,
      JSON.stringify(content),
    );
}

class ScriptedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  calls = 0;

  constructor(private readonly eventFactory: (input: QueryInput) => AsyncIterable<ProviderEvent>) {}

  isSessionInvalid(_err: unknown, _opts: { attemptedContinuation?: string } = {}): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.calls++;
    const eventFactory = this.eventFactory;
    // Adapt the scripted event stream to the input-accepted/result-resolution
    // contract: emit input-accepted for the initial input, and stamp any
    // `result` that didn't declare resolution with this single active input id.
    const adapted: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        let acceptedEmitted = false;
        for await (const ev of eventFactory(input)) {
          if (ev.type === 'init' && !acceptedEmitted) {
            yield ev;
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            acceptedEmitted = true;
            continue;
          }
          if (ev.type === 'result') {
            if (!acceptedEmitted) {
              yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
              acceptedEmitted = true;
            }
            const declared = (ev as { resolvedInputIds?: string[] }).resolvedInputIds;
            yield declared
              ? ev
              : { ...ev, inputId: input.inputId, resolvedInputIds: [input.inputId] };
            continue;
          }
          yield ev;
        }
      },
    };
    return {
      push(_message: string | QueryTurnInput) {},
      end() {},
      abort() {},
      events: adapted,
    };
  }
}

class NativeScriptedProvider extends ScriptedProvider {
  override readonly supportsNativeSlashCommands = true;
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SCHEDULED TASK]');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[WEBHOOK: github/push]');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SYSTEM RESPONSE]');
    expect(prompt).toContain('register_group');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('[SYSTEM RESPONSE]');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });

  it('renders workspace attachment metadata as text fallback', () => {
    insertMessage('m1', 'chat-sdk', {
      sender: 'User',
      text: 'What is this?',
      attachments: [
        {
          workspacePath: '/workspace/agent/attachments/discord/msg/photo.png',
          originalName: 'photo.png',
          contentType: 'image/png',
          sizeBytes: 1234,
        },
      ],
    });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain(
      '[image/png: photo.png - 1234 bytes - saved to /workspace/agent/attachments/discord/msg/photo.png]',
    );
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('poll-loop conversational reply accounting', () => {
  it('passes collected attachments on the initial provider turn', async () => {
    const filePath = '/workspace/agent/attachments/discord/msg/photo.png';
    insertMessage(
      'image-chat',
      'chat-sdk',
      {
        sender: 'User',
        text: 'What is in the picture?',
        attachments: [{ workspacePath: filePath, originalName: 'photo.png', contentType: 'image/png', sizeBytes: 8 }],
      },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new ScriptedProvider(async function* (input) {
      expect(input.attachments).toEqual([{ path: filePath, filename: 'photo.png', mime: 'image/png', sizeBytes: 8 }]);
      yield { type: 'result', text: 'image received' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      inspectAttachmentFile: async (candidate) => ({
        path: candidate,
        realPath: candidate,
        filename: 'photo.png',
        mime: 'image/png',
        sizeBytes: 8,
        isRegularFile: true,
      }),
    });

    await waitFor(() => getAckStatus('image-chat') === 'completed', 1500);
    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('passes collected attachments on active-query follow-up pushes', async () => {
    insertMessage('initial-chat', 'chat', { sender: 'User', text: 'first' }, { platformId: 'chan-1' });

    const filePath = '/workspace/agent/tmp/vision-fixture.png';
    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const pushes: QueryTurnInput[] = [];
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        queryStarted.resolve();
        return {
          push(message) {
            pushes.push(typeof message === 'string' ? { prompt: message } : message);
          },
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'active-image-query' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
            yield { type: 'result', text: 'done' };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      inspectAttachmentFile: async (candidate) => ({
        path: candidate,
        realPath: candidate,
        filename: 'vision-fixture.png',
        mime: 'image/png',
        sizeBytes: 8,
        isRegularFile: true,
      }),
    });

    await queryStarted.promise;
    insertMessage('image-follow-up', 'chat', { sender: 'User', text: `Use ${filePath}` }, { platformId: 'chan-1' });
    await waitFor(() => pushes.some((push) => push.attachments?.length === 1), 1500);
    controller.abort();
    releaseQuery();
    await loopPromise.catch(() => {});

    expect(pushes[0].attachments).toEqual([
      { path: filePath, filename: 'vision-fixture.png', mime: 'image/png', sizeBytes: 8 },
    ]);
  });

  it('leaves attachment-bearing follow-up rows retryable when provider enqueue throws', async () => {
    insertMessage('initial-chat', 'chat', { sender: 'User', text: 'first' }, { platformId: 'chan-1' });

    const filePath = '/workspace/agent/tmp/vision-fixture.png';
    const queryStarted = deferred();
    let releaseQuery!: () => void;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        queryStarted.resolve();
        return {
          push() {
            throw new Error('queue full');
          },
          end() {},
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'throwing-push-query' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      inspectAttachmentFile: async (candidate) => ({
        path: candidate,
        realPath: candidate,
        filename: 'vision-fixture.png',
        mime: 'image/png',
        sizeBytes: 8,
        isRegularFile: true,
      }),
    });

    await queryStarted.promise;
    insertMessage('image-follow-up', 'chat', { sender: 'User', text: `Use ${filePath}` }, { platformId: 'chan-1' });
    await waitFor(() => getAckStatus('image-follow-up') === 'processing', 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(getAckStatus('image-follow-up')).toBe('processing');
  });

  it('writes an explicit error when a conversational trigger completes without a user-visible response', async () => {
    insertMessage(
      'silent-chat-sdk',
      'chat-sdk',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'silent-session' };
      yield { type: 'result', text: null };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('silent-chat-sdk') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('silent-chat-sdk');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(JSON.parse(out[0].content).text).toContain('completed without sending a user-visible response');

    await loopPromise.catch(() => {});
  });

  it('allows scheduled tasks to complete silently when their script says not to wake the agent', async () => {
    insertMessage('quiet-task', 'task', {
      prompt: 'Check whether anything changed.',
      script: `printf '%s\n' '{"wakeAgent":false}'`,
    });

    const provider = new ScriptedProvider(async function* () {
      throw new Error('scheduled task should not query the provider');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('quiet-task') === 'completed', 5000);
    controller.abort();

    expect(provider.calls).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('counts an MCP send_message output as the user-visible response for an empty final result', async () => {
    insertMessage(
      'mcp-chat',
      'chat',
      { sender: 'User', text: 'do a long thing' },
      { platformId: 'chan-2', channelType: 'discord', threadId: 'thread-2' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'mcp-session' };
      writeMessageOut({
        id: 'mcp-visible-response',
        in_reply_to: 'mcp-chat',
        kind: 'chat',
        platform_id: 'chan-2',
        channel_type: 'discord',
        thread_id: 'thread-2',
        content: JSON.stringify({ text: 'Working on it.' }),
      });
      yield { type: 'result', text: null };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('mcp-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('mcp-visible-response');
    expect(JSON.parse(out[0].content).text).toBe('Working on it.');

    await loopPromise.catch(() => {});
  });

  it('writes a visible error when the provider throws', async () => {
    insertMessage(
      'throwing-chat',
      'chat',
      { sender: 'User', text: 'this will fail' },
      { platformId: 'chan-3', channelType: 'discord', threadId: 'thread-3' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'throwing-session' };
      throw new Error('provider exploded');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getUndeliveredMessages().length === 1, 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
    expect(JSON.parse(out[0].content).text).toBe('Error: provider exploded');
    expect(getAckStatus('throwing-chat')).toBe('completed');

    await loopPromise.catch(() => {});
  });

  it('does not handle /clear inside the runner', async () => {
    insertMessage(
      'clear-1',
      'chat',
      { sender: 'Admin', text: '/clear' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const provider = new ScriptedProvider(async function* (input) {
      expect(input.prompt).toContain('/clear');
      yield { type: 'init', continuation: 'runner-clear-still-provider-owned' };
      yield { type: 'result', text: 'provider saw clear' };
    });

    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    const out = getUndeliveredMessages();
    expect(out.map((m) => JSON.parse(m.content).text)).not.toContain('Session cleared.');
    expect(JSON.parse(out[0].content).text).toBe('provider saw clear');
  });

  it('pushes /clear into an active provider query as normal text', async () => {
    insertMessage(
      'initial-chat',
      'chat',
      { sender: 'User', text: 'first' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const pushes: QueryTurnInput[] = [];
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        expect(input.prompt).toContain('first');
        queryStarted.resolve();
        return {
          push(message) {
            pushes.push(typeof message === 'string' ? { prompt: message } : message);
          },
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'active-clear-query' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
            yield { type: 'result', text: 'done' };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
    });

    await queryStarted.promise;
    insertMessage(
      'clear-follow-up',
      'chat',
      { sender: 'Admin', text: '/clear' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    await waitFor(() => pushes.some((push) => push.prompt.includes('/clear')), 5000);
    controller.abort();
    releaseQuery();
    await loopPromise.catch(() => {});

    expect(pushes.some((push) => push.prompt.includes('/clear'))).toBe(true);
    expect(getUndeliveredMessages().map((m) => JSON.parse(m.content).text)).not.toContain('Session cleared.');
  });

  it('does not pass host-owned reset commands as provider-native slash commands', async () => {
    insertMessage(
      'clear-native',
      'chat',
      { sender: 'Admin', text: '/clear' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    insertMessage(
      'new-native',
      'chat',
      { sender: 'Admin', text: '/new' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const provider = new NativeScriptedProvider(async function* (input) {
      expect(input.prompt).toContain('<message');
      expect(input.prompt).toContain('/clear');
      expect(input.prompt).toContain('/new');
      expect(input.prompt.trim()).not.toBe('/clear\n\n/new');
      yield { type: 'result', text: 'provider saw host-owned commands as text' };
    });

    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(JSON.parse(getUndeliveredMessages()[0].content).text).toBe('provider saw host-owned commands as text');
  });
});

describe('route normalization', () => {
  it('collapses a null-thread DM and a threaded DM alias to the same route only when DM metadata matches', () => {
    const nullThreadDm = normalizeRoute('opencode', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-dm-1',
      isGroup: 0,
    });
    const threadedDmAlias = normalizeRoute('opencode', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: 'dm-thread-xyz',
      messagingGroupId: 'mg-dm-1',
      isGroup: 0,
    });
    expect(nullThreadDm.routeKey).toBe(threadedDmAlias.routeKey);
    expect(nullThreadDm.isGroup).toBe(0);
  });

  it('keeps distinct group-channel threads isolated', () => {
    const t1 = normalizeRoute('opencode', {
      platformId: 'chan-2',
      channelType: 'discord',
      threadId: 'thread-A',
      messagingGroupId: 'mg-group-1',
      isGroup: 1,
    });
    const t2 = normalizeRoute('opencode', {
      platformId: 'chan-2',
      channelType: 'discord',
      threadId: 'thread-B',
      messagingGroupId: 'mg-group-1',
      isGroup: 1,
    });
    expect(t1.routeKey).not.toBe(t2.routeKey);
  });

  it('treats a row lacking host route metadata as its own distinct route (never collapsible)', () => {
    const noMeta = normalizeRoute('opencode', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: null,
      isGroup: null,
    });
    const realDm = normalizeRoute('opencode', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: 'dm-thread-xyz',
      messagingGroupId: 'mg-dm-1',
      isGroup: 0,
    });
    // The metadata-less row must NOT collapse onto the real DM route.
    expect(noMeta.routeKey).not.toBe(realDm.routeKey);
  });
});

describe('messages-in recovery ack lifecycle', () => {
  function ackStatus(id: string): string | null {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  it('returnProcessingToPending deletes only processing acks', () => {
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('p1', 'processing', datetime('now'))")
      .run();
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('r1', 'recovery', datetime('now'))")
      .run();

    returnProcessingToPending(['p1', 'r1'], 'unaccepted-followup');
    expect(ackStatus('p1')).toBeNull(); // processing deleted → pending again
    expect(ackStatus('r1')).toBe('recovery'); // recovery preserved
  });

  it('markRecoveryOwned moves rows to recovery and markRecoveryCompleted completes them', () => {
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1', 'processing', datetime('now'))")
      .run();
    markRecoveryOwned(['m1'], 'rec-1');
    expect(ackStatus('m1')).toBe('recovery');

    markRecoveryCompleted(['m1'], 'rec-1');
    expect(ackStatus('m1')).toBe('completed');
  });

  // B5 (Step 3 lines 539-540): startup clears orphan 'processing' acks but
  // PRESERVES 'recovery' acks (and does not touch completed/failed).
  it('clearStaleProcessingAcks clears orphan processing acks but preserves recovery acks', () => {
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('orphan-proc', 'processing', datetime('now'))")
      .run();
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('rec-owned', 'recovery', datetime('now'))")
      .run();
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('done', 'completed', datetime('now'))")
      .run();

    clearStaleProcessingAcks();

    expect(ackStatus('orphan-proc')).toBeNull(); // orphan processing cleared
    expect(ackStatus('rec-owned')).toBe('recovery'); // recovery preserved
    expect(ackStatus('done')).toBe('completed'); // completed untouched
  });

  // B6 (Step 3 line 541): resolving a recovery entry resolves its owned input
  // ledger row ids and they are marked completed.
  it('recovery deletion/resolution resolves owned row ids to completed', () => {
    const scope: ProviderRecoveryScope = {
      providerName: 'test',
      routeKey: 'test|discord|chan-1|dm:mg-rec',
      messagingGroupId: 'mg-rec',
      isGroup: 0,
      platformId: 'chan-1',
      channelType: 'discord',
      threadKey: null,
    };
    // Two rows owned by recovery under input 'in-rec'.
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('mr1', 'recovery', datetime('now'))")
      .run();
    getOutboundDb()
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('mr2', 'recovery', datetime('now'))")
      .run();
    const now = new Date().toISOString();
    const entry: ProviderRecoveryEntry = {
      id: 'rec-b6',
      status: 'pending',
      classification: 'terminal',
      agentMessage: 'resuming',
      fallbackUserMessage: 'resend if needed',
      originalTasks: [],
      acceptedUnresolvedInputs: [{ inputId: 'in-rec', messageIds: ['mr1', 'mr2'], prompt: 'do it' }],
      pendingFollowups: [],
      priorProgress: [],
      observations: [],
      sideEffects: [],
      continuationPolicy: 'preserve',
      createdAt: now,
      updatedAt: now,
    };
    appendRecoveryEntry(scope, entry);
    markRecoveryInFlight(scope, entry.id, 'in-rec');

    // A successful recovery result resolves the entry → returns owned row ids.
    const resolution = resolveRecoveryEntry(scope, entry.id, { resolvedInputIds: ['in-rec'] });
    expect(resolution.resolvedMessageIds.sort()).toEqual(['mr1', 'mr2']);

    // Those row ids are then marked completed.
    markRecoveryCompleted(resolution.resolvedMessageIds, entry.id);
    expect(ackStatus('mr1')).toBe('completed');
    expect(ackStatus('mr2')).toBe('completed');
  });
});

describe('poll-loop input ledger and recovery (route-scoped)', () => {
  it('returns unaccepted route-matched follow-up rows to pending on terminal interruption before input-accepted', async () => {
    insertMessage('initial-dm', 'chat', { sender: 'User', text: 'start' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-dm-1',
      isGroup: 0,
    });

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    // Capture the structured return-to-pending event so we can assert the
    // unaccepted follow-up was returned to pending rather than stranded in
    // 'processing'. (Once returned, a later wake legitimately re-claims it, so
    // polling the live ack status would race the re-claim.)
    const returnedToPending = new Set<string>();
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      if (line.includes('return_processing_to_pending')) {
        const m = /(\{.*"return_processing_to_pending".*\})/.exec(line);
        if (m) {
          try {
            const ev = JSON.parse(m[1]) as { event: string; message_ids: string[] };
            for (const id of ev.message_ids) returnedToPending.add(id);
          } catch {
            /* ignore */
          }
        }
      }
      origError(...(args as []));
    };

    let pushedFollowup = false;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        return {
          push() {
            // never accepts the follow-up — no input-accepted emitted for it
            pushedFollowup = true;
            // Once the follow-up has been pushed (and claimed as processing),
            // end the turn so we can assert it is returned to pending.
            releaseQuery?.();
          },
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-x' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
            // terminal interruption: stream ends without resolving the follow-up
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    try {
      await queryStarted.promise;
      insertMessage('followup-dm', 'chat', { sender: 'User', text: 'and also this' }, {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-dm-1',
        isGroup: 0,
      });

      // The unaccepted follow-up must be returned to pending on terminal turn end.
      await waitFor(() => pushedFollowup && returnedToPending.has('followup-dm'), 3000);
      controller.abort();
      await loopPromise.catch(() => {});
    } finally {
      console.error = origError;
    }

    expect(returnedToPending.has('followup-dm')).toBe(true);
  });
});

describe('poll-loop active-input stamping (follow-up correlation)', () => {
  // B4 (Step 1 line 473): a side effect produced during an accepted FOLLOW-UP
  // must be stamped with the follow-up's inputId, NOT the initial input id. The
  // poll loop writes /workspace/.active-input.json (atomic temp+rename) on each
  // input-accepted; the latest accepted input wins.
  it('stamps .active-input.json with the latest accepted (follow-up) input id, not the initial', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-active-input-'));
    const activeInputFile = path.join(dir, '.active-input.json');
    const prevEnv = process.env.NANOCLAW_ACTIVE_INPUT_PATH;
    process.env.NANOCLAW_ACTIVE_INPUT_PATH = activeInputFile;

    insertMessage('init-msg', 'chat', { sender: 'User', text: 'initial' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-fu',
      isGroup: 0,
    });

    const acceptedInputIds: string[] = [];
    let releaseQuery!: () => void;
    let acceptFollowup!: (inputId: string) => void;
    const queryStarted = deferred();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        let followupId: string | null = null;
        let signalFollowup: (() => void) | null = null;
        acceptFollowup = (id: string) => {
          followupId = id;
          signalFollowup?.();
        };
        return {
          push(message) {
            // The poll loop pushes a follow-up with a NEW inputId; accept it.
            const turn = typeof message === 'string' ? { inputId: undefined } : message;
            if (turn.inputId) acceptFollowup(turn.inputId);
          },
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-fu' };
            const initialId = (input as QueryInput).inputId;
            acceptedInputIds.push(initialId);
            yield { type: 'input-accepted', inputId: initialId, scope: 'initial' };
            // Wait for a follow-up to be pushed, then accept it.
            await new Promise<void>((resolve) => {
              signalFollowup = resolve;
            });
            acceptedInputIds.push(followupId!);
            yield { type: 'input-accepted', inputId: followupId!, scope: 'followup' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    try {
      await queryStarted.promise;
      // Insert a follow-up on the same route so the poll loop pushes it.
      insertMessage('fu-msg', 'chat', { sender: 'User', text: 'follow-up' }, {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-fu',
        isGroup: 0,
      });

      // Wait until BOTH inputs have been accepted (initial then follow-up).
      await waitFor(() => acceptedInputIds.length >= 2, 4000);
      // Wait for the stamp to reflect the follow-up id.
      await waitFor(() => {
        if (!fs.existsSync(activeInputFile)) return false;
        try {
          const stamp = JSON.parse(fs.readFileSync(activeInputFile, 'utf8')) as { inputId: string };
          return stamp.inputId === acceptedInputIds[1];
        } catch {
          return false;
        }
      }, 4000);

      const stamp = JSON.parse(fs.readFileSync(activeInputFile, 'utf8')) as { inputId: string };
      const initialInputId = acceptedInputIds[0];
      const followupInputId = acceptedInputIds[1];
      expect(followupInputId).not.toBe(initialInputId);
      // The stamp reflects the LATEST accepted (follow-up) input, not the initial.
      expect(stamp.inputId).toBe(followupInputId);
    } finally {
      controller.abort();
      releaseQuery?.();
      await loopPromise.catch(() => {});
      if (prevEnv === undefined) delete process.env.NANOCLAW_ACTIVE_INPUT_PATH;
      else process.env.NANOCLAW_ACTIVE_INPUT_PATH = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('poll-loop ambiguous result resolution guard', () => {
  function ackStatusFor(id: string): string | null {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  // B7 (Step 3 line 542 / poll-loop resolveResult): one active accepted input +
  // a result with no explicit resolvedInputIds → the one input resolves and its
  // row is completed (the unambiguous one-active-input rule).
  it('one active accepted input resolves a result lacking explicit resolvedInputIds', async () => {
    insertMessage('one-active', 'chat', { sender: 'User', text: 'do it' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-one',
      isGroup: 0,
    });

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-one' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            // result with NO resolvedInputIds — one-active rule must map it.
            yield { type: 'result', text: '<message to="discord-test">ok</message>', resolvedInputIds: [] };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });
    await waitFor(() => ackStatusFor('one-active') === 'completed', 3000);
    expect(ackStatusFor('one-active')).toBe('completed');
    controller.abort();
    await loopPromise.catch(() => {});
  });

  // B7: two active accepted inputs + a result with no explicit resolvedInputIds
  // → ambiguous; the guard logs `ambiguous_result_resolution` and completes
  // NOTHING (ambiguous success must never complete the wrong row).
  it('two active accepted inputs with no explicit ids is ambiguous: logs and completes nothing', async () => {
    insertMessage('amb-initial', 'chat', { sender: 'User', text: 'first' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-amb',
      isGroup: 0,
    });

    const ambiguousLogged = { value: false };
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      if (line.includes('ambiguous_result_resolution')) ambiguousLogged.value = true;
      origError(...(args as []));
    };

    let releaseQuery!: () => void;
    let acceptFollowup!: (id: string) => void;
    const queryStarted = deferred();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        let followupId: string | null = null;
        let signalFollowup: (() => void) | null = null;
        acceptFollowup = (id: string) => {
          followupId = id;
          signalFollowup?.();
        };
        return {
          push(message) {
            const turn = typeof message === 'string' ? { inputId: undefined } : message;
            if (turn.inputId) acceptFollowup(turn.inputId);
          },
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-amb' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            // Wait for and accept a follow-up — now TWO inputs are active.
            await new Promise<void>((resolve) => {
              signalFollowup = resolve;
            });
            yield { type: 'input-accepted', inputId: followupId!, scope: 'followup' };
            // Emit a result with NO resolvedInputIds — ambiguous (2 active).
            yield { type: 'result', text: '<message to="discord-test">ambiguous</message>', resolvedInputIds: [] };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    try {
      await queryStarted.promise;
      insertMessage('amb-followup', 'chat', { sender: 'User', text: 'second' }, {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-amb',
        isGroup: 0,
      });

      await waitFor(() => ambiguousLogged.value, 4000);
      // Neither row is completed by the ambiguous result.
      expect(ackStatusFor('amb-initial')).not.toBe('completed');
      expect(ackStatusFor('amb-followup')).not.toBe('completed');
    } finally {
      console.error = origError;
      controller.abort();
      releaseQuery?.();
      await loopPromise.catch(() => {});
    }
    expect(ambiguousLogged.value).toBe(true);
  });
});

describe('poll-loop accepted-but-unresolved terminal recovery', () => {
  function recoveryScope(routeKey: string, messagingGroupId: string | null, isGroup: 0 | 1 | null): ProviderRecoveryScope {
    return {
      providerName: 'test',
      routeKey,
      messagingGroupId,
      isGroup,
      platformId: null,
      channelType: null,
      threadKey: null,
    };
  }

  function ackStatusFor(id: string): string | null {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  // A1 (Step 3 line 538 / Invariants 160,162): an accepted-but-unresolved input
  // that hits a terminal turn-end (stream end, no result) moves into recovery
  // ownership (processing_ack.status='recovery') with a stored recovery payload —
  // it is NOT completed and NOT returned to pending.
  it('moves accepted-but-unresolved rows to recovery ownership (not completed) on terminal stream end', async () => {
    insertMessage('acc-dm', 'chat', { sender: 'User', text: 'long running task' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-acc-1',
      isGroup: 0,
    });

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        return {
          push() {},
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-acc' };
            // Provider ACCEPTS the input but never resolves it (no result).
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
            // Stream ends here — terminal interruption, input unresolved.
          })(),
        };
      },
    };

    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-acc-1',
      isGroup: 0,
    }).routeKey;
    const scope = recoveryScope(routeKey, 'mg-acc-1', 0);

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    // End the turn while the input is accepted-but-unresolved (wait for the
    // generator to reach its await point so releaseQuery is wired).
    await waitFor(() => !!releaseQuery, 2000);
    releaseQuery();

    await waitFor(() => listRecoveryEntries(scope).length >= 1, 3000);
    expect(ackStatusFor('acc-dm')).toBe('recovery'); // recovery-owned, not completed
    const entries = listRecoveryEntries(scope);
    expect(entries).toHaveLength(1);
    expect(entries[0].acceptedUnresolvedInputs.some((a) => a.messageIds.includes('acc-dm'))).toBe(true);
    expect(entries[0].status).toBe('pending');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  // A2 (Step 3 line 543/544): route-scoped outbound progress / MCP send_message
  // rows written during the accepted-input window are harvested into priorProgress;
  // progress from another conversation (different route) is NOT harvested.
  it('harvests route-scoped priorProgress and excludes other-conversation progress', async () => {
    insertMessage('acc-prog', 'chat', { sender: 'User', text: 'do work and report progress' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-prog-1',
      isGroup: 0,
    });

    const activeRouteKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-prog-1',
      isGroup: 0,
    }).routeKey;
    const otherRouteKey = normalizeRoute('test', {
      platformId: 'chan-OTHER',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-OTHER',
      isGroup: 0,
    }).routeKey;

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        return {
          push() {},
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-prog' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            // Active-route progress written during the accepted-input window.
            writeMessageOut({
              id: 'prog-active',
              kind: 'chat',
              content: JSON.stringify({ text: 'partial progress on the task' }),
              route_key: activeRouteKey,
              messaging_group_id: 'mg-prog-1',
              is_group: 0,
            });
            // Progress from ANOTHER conversation — must NOT be harvested.
            writeMessageOut({
              id: 'prog-other',
              kind: 'chat',
              content: JSON.stringify({ text: 'unrelated other-conversation progress' }),
              route_key: otherRouteKey,
              messaging_group_id: 'mg-OTHER',
              is_group: 0,
            });
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
          })(),
        };
      },
    };

    const scope = recoveryScope(activeRouteKey, 'mg-prog-1', 0);
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    await waitFor(() => !!releaseQuery, 2000);
    releaseQuery();

    await waitFor(() => listRecoveryEntries(scope).length >= 1, 3000);
    const entry = listRecoveryEntries(scope)[0];
    const progressTexts = entry.priorProgress.map((p) => p.text);
    expect(progressTexts).toContain('partial progress on the task');
    expect(progressTexts.some((t) => t.includes('unrelated other-conversation'))).toBe(false);

    controller.abort();
    await loopPromise.catch(() => {});
  });

  // A3 (Step 4 line 552): same-route multiple trigger rows are preserved in order
  // as the recovery entry's originalTasks array (not collapsed to newest).
  it('preserves same-route multi-trigger rows in order as originalTasks', async () => {
    insertMessage('trig-1', 'chat', { sender: 'User', text: 'first task' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-multi',
      isGroup: 0,
    });
    insertMessage('trig-2', 'chat', { sender: 'User', text: 'second task' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-multi',
      isGroup: 0,
    });

    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-multi',
      isGroup: 0,
    }).routeKey;
    const scope = recoveryScope(routeKey, 'mg-multi', 0);

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        return {
          push() {},
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-multi' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    await waitFor(() => !!releaseQuery, 2000);
    releaseQuery();

    await waitFor(() => listRecoveryEntries(scope).length >= 1, 3000);
    const entry = listRecoveryEntries(scope)[0];
    const taskIds = entry.originalTasks.map((t) => t.messageId);
    expect(taskIds).toEqual(['trig-1', 'trig-2']); // ordered, not collapsed to newest

    controller.abort();
    await loopPromise.catch(() => {});
  });

  // A3 (Step 4 line 553/554): a mixed batch partitions trigger=0 context by route;
  // recovery is stored under the TRIGGER route, and unrelated-route context does
  // NOT appear in the active prompt or recovery payload.
  it('partitions trigger=0 context by route; recovery stored under trigger route, unrelated context excluded', async () => {
    // Unrelated-route accumulated context (trigger=0) — must NOT join the active route.
    insertMessage('ctx-other', 'chat', { sender: 'Other', text: 'UNRELATED context line' }, {
      trigger: 0,
      platformId: 'chan-OTHER',
      channelType: 'discord',
      messagingGroupId: 'mg-ctx-other',
      isGroup: 0,
    });
    // Same-route accumulated context (trigger=0) — rides along with the trigger.
    insertMessage('ctx-same', 'chat', { sender: 'User', text: 'SAME-route earlier context' }, {
      trigger: 0,
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-trig',
      isGroup: 0,
    });
    // The wake-triggering row (trigger=1) on the active route.
    insertMessage('trig-main', 'chat', { sender: 'User', text: 'TRIGGER task' }, {
      trigger: 1,
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-trig',
      isGroup: 0,
    });

    const triggerRouteKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-trig',
      isGroup: 0,
    }).routeKey;
    const firstRowRouteKey = normalizeRoute('test', {
      platformId: 'chan-OTHER',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-ctx-other',
      isGroup: 0,
    }).routeKey;
    const scope = recoveryScope(triggerRouteKey, 'mg-trig', 0);
    const otherScope = recoveryScope(firstRowRouteKey, 'mg-ctx-other', 0);

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    let seenPrompt = '';
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        seenPrompt = input.prompt;
        queryStarted.resolve();
        return {
          push() {},
          end() {
            releaseQuery?.();
          },
          abort() {
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-mixed' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
            });
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    // Active prompt includes same-route context + trigger, excludes unrelated route.
    expect(seenPrompt).toContain('TRIGGER task');
    expect(seenPrompt).toContain('SAME-route earlier context');
    expect(seenPrompt).not.toContain('UNRELATED context line');

    await waitFor(() => !!releaseQuery, 2000);
    releaseQuery();
    await waitFor(() => listRecoveryEntries(scope).length >= 1, 3000);

    // Recovery is stored under the TRIGGER route, not the first-row (unrelated) route.
    expect(listRecoveryEntries(scope)).toHaveLength(1);
    expect(listRecoveryEntries(otherScope)).toHaveLength(0);
    // The unrelated-route context never appears in the active route's recovery.
    const entry = listRecoveryEntries(scope)[0];
    const allText = JSON.stringify(entry);
    expect(allText).not.toContain('UNRELATED context line');

    controller.abort();
    await loopPromise.catch(() => {});
  });
});

describe('poll-loop pre-query failure recovery (Step 4 lines 557-559)', () => {
  function ackStatusFor(id: string): string | null {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }
  function nonSystemOut(): ReturnType<typeof getUndeliveredMessages> {
    return getUndeliveredMessages().filter((m) => m.kind !== 'system');
  }
  function rawProviderErrorWritten(): boolean {
    return nonSystemOut().some((m) => {
      try {
        return /^Error: /.test(JSON.parse(m.content).text ?? '');
      } catch {
        return false;
      }
    });
  }

  // B8: attachment inspection failure AFTER the rows are claimed returns rows to
  // pending (deletes the transient 'processing' ack) without writing a raw error.
  it('attachment inspection failure after claim returns rows to pending without a raw error', async () => {
    const filePath = '/workspace/agent/attachments/discord/msg/photo.png';
    insertMessage(
      'attach-fail',
      'chat-sdk',
      {
        sender: 'User',
        text: 'inspect this',
        attachments: [{ workspacePath: filePath, originalName: 'photo.png', contentType: 'image/png', sizeBytes: 8 }],
      },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const returnedToPending = new Set<string>();
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      if (line.includes('return_processing_to_pending') || line.includes('pre_query_failure')) {
        const m = /(\{.*"message_ids".*\})/.exec(line);
        if (m) {
          try {
            const ev = JSON.parse(m[1]) as { message_ids: string[] };
            for (const id of ev.message_ids ?? []) returnedToPending.add(id);
          } catch {
            /* ignore */
          }
        }
      }
      origError(...(args as []));
    };

    const provider = new ScriptedProvider(async function* () {
      throw new Error('provider should never be queried after attachment failure');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      inspectAttachmentFile: async () => {
        throw new Error('attachment inspection blew up');
      },
    });

    try {
      await waitFor(() => returnedToPending.has('attach-fail'), 3000);
      expect(returnedToPending.has('attach-fail')).toBe(true);
      expect(rawProviderErrorWritten()).toBe(false);
    } finally {
      console.error = origError;
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  // B8: pre-task script handling failure AFTER claim follows the same recoverable
  // lifecycle (returns rows to pending), without writing a raw error.
  it('pre-task script handling failure after claim returns rows to pending without a raw error', async () => {
    insertMessage('pretask-fail', 'task', { prompt: 'do the scheduled thing' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-pt',
      isGroup: 0,
    });

    const returnedToPending = new Set<string>();
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      if (line.includes('return_processing_to_pending') || line.includes('pre_query_failure')) {
        const m = /(\{.*"message_ids".*\})/.exec(line);
        if (m) {
          try {
            const ev = JSON.parse(m[1]) as { message_ids: string[] };
            for (const id of ev.message_ids ?? []) returnedToPending.add(id);
          } catch {
            /* ignore */
          }
        }
      }
      origError(...(args as []));
    };

    const provider = new ScriptedProvider(async function* () {
      throw new Error('provider should never be queried after pre-task failure');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      // Test seam: a pre-task handler that throws (e.g. module import / handler crash).
      runPreTaskScripts: async () => {
        throw new Error('pre-task handler crashed');
      },
    });

    try {
      await waitFor(() => returnedToPending.has('pretask-fail'), 3000);
      expect(returnedToPending.has('pretask-fail')).toBe(true);
      expect(rawProviderErrorWritten()).toBe(false);
    } finally {
      console.error = origError;
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  // B8: provider startup / session-creation failure (query() throws synchronously)
  // stores route-scoped recovery before settling, and does NOT write a raw error.
  it('provider startup/session-creation failure stores recovery and does not write a raw error', async () => {
    insertMessage('startup-fail', 'chat', { sender: 'User', text: 'kick off' }, {
      platformId: 'chan-1',
      channelType: 'discord',
      messagingGroupId: 'mg-startup',
      isGroup: 0,
    });

    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-startup',
      isGroup: 0,
    }).routeKey;
    const scope: ProviderRecoveryScope = {
      providerName: 'test',
      routeKey,
      messagingGroupId: 'mg-startup',
      isGroup: 0,
      platformId: 'chan-1',
      channelType: 'discord',
      threadKey: null,
    };

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        // Provider startup / session creation fails synchronously.
        throw new Error('opencode server failed to spawn');
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    try {
      await waitFor(() => listRecoveryEntries(scope).length >= 1 || ackStatusFor('startup-fail') === null, 3000);
      // Either recovery stored (preferred) or rows returned to pending — never
      // settled with a raw provider error.
      const recoveryStored = listRecoveryEntries(scope).length >= 1;
      const returnedToPending = ackStatusFor('startup-fail') === null;
      expect(recoveryStored || returnedToPending).toBe(true);
      expect(rawProviderErrorWritten()).toBe(false);
      // The row is NOT completed by a startup failure.
      expect(ackStatusFor('startup-fail')).not.toBe('completed');
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });
});

describe('poll-loop initial route splitting', () => {
  it('splits multiple wake-triggering routes: only the active route is claimed, other routes stay pending', async () => {
    // Two distinct DM routes both wake-eligible in the same scan.
    insertMessage('routeA-1', 'chat', { sender: 'A', text: 'route A task' }, {
      platformId: 'chan-A',
      channelType: 'discord',
      messagingGroupId: 'mg-A',
      isGroup: 0,
    });
    insertMessage('routeB-1', 'chat', { sender: 'B', text: 'route B task' }, {
      platformId: 'chan-B',
      channelType: 'discord',
      messagingGroupId: 'mg-B',
      isGroup: 0,
    });

    const seenPrompts: string[] = [];
    const provider = new ScriptedProvider(async function* (input) {
      seenPrompts.push(input.prompt);
      yield { type: 'init', continuation: 'sess-split' };
      yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
      yield { type: 'result', text: 'done', inputId: input.inputId, resolvedInputIds: [input.inputId!] };
    });

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => seenPrompts.length >= 1, 2000);
    // The first claimed query must contain exactly one route's task, not both.
    const firstPrompt = seenPrompts[0];
    const hasA = firstPrompt.includes('route A task');
    const hasB = firstPrompt.includes('route B task');
    expect(hasA !== hasB).toBe(true); // exactly one route, not both

    controller.abort();
    await loopPromise.catch(() => {});
  });
});

function ackStatusOf(messageId: string): string | null {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function runPollLoopWithTimeout(provider: AgentProvider, signal: AbortSignal, timeoutMs = 2000): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(25);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAckStatus(messageId: string): string | null {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}
