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
  clearStaleContainerToolState,
  clearContainerToolInFlight,
  setContainerToolInFlight,
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
  getContinuation,
  listRecoveryEntries,
  markRecoveryInFlight,
  resolveRecoveryEntry,
  setContinuation,
  type ProviderRecoveryEntry,
  type ProviderRecoveryScope,
} from './db/session-state.js';
import { formatMessages, extractRouting, normalizeRoute } from './formatter.js';
import { decideProviderStatusAction, runPollLoop } from './poll-loop.js';
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

function insertChannelDestination(name: string, platformId = 'chan-1', channelType = 'discord'): void {
  getInboundDb()
    .prepare(
      `INSERT OR REPLACE INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
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
            yield declared ? ev : { ...ev, inputId: input.inputId, resolvedInputIds: [input.inputId] };
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
    insertChannelDestination('discord-test');
    insertMessage('m1', 'task', { prompt: 'Review open PRs' }, { platformId: 'chan-1', channelType: 'discord' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SCHEDULED TASK from="discord-test"]');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertChannelDestination('discord-test');
    insertMessage(
      'm1',
      'webhook',
      { source: 'github', event: 'push', payload: { ref: 'main' } },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[WEBHOOK from="discord-test": github/push]');
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
    insertChannelDestination('discord-current', 'chan-1');
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
      yield { type: 'result', text: '<message to="discord-current">image received</message>' };
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

  it('nudges once when bare final result text would otherwise be dropped, then delivers the wrapped resend', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertMessage(
      'bare-final-chat',
      'chat',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('Your last answer was not delivered')) {
        return '<message to="discord-current">Done.</message>';
      }
      return 'Done.';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('bare-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done.');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Do not redo work. Do not call tools.');
    expect(prompts[1]).toContain('address the block to `discord-current`');
    expect(prompts[1]).toContain('Put this exact answer text inside the block');

    await loopPromise.catch(() => {});
  });

  it('delivers the original bare final text if the unwrapped-output nudge is ignored once', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertMessage(
      'ignored-nudge-chat',
      'chat',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return 'Done.';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('ignored-nudge-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done.');
    expect(prompts).toHaveLength(2);

    await loopPromise.catch(() => {});
  });

  it('delivers the original bare final text if the unwrapped-output nudge produces only reasoning', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertMessage(
      'reasoning-only-nudge-chat',
      'chat',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    let pushed = false;
    const provider = new ScriptedProvider(async function* (input) {
      yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
      yield { type: 'result', text: 'Done.', resolvedInputIds: [input.inputId] };
      while (!pushed) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'input-accepted', inputId: input.inputId, scope: 'followup' };
      yield { type: 'result', resolvedInputIds: [input.inputId] };
    });
    const originalQuery = provider.query.bind(provider);
    provider.query = (input) => {
      const query = originalQuery(input);
      const push = query.push.bind(query);
      query.push = (turn) => {
        pushed = true;
        push(turn);
      };
      return query;
    };
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('reasoning-only-nudge-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done.');

    await loopPromise.catch(() => {});
  });

  it('does not settle conversational reply accounting for provider progress before the final result', async () => {
    insertChannelDestination('discord-current', 'chan-2');
    insertMessage(
      'compact-chat',
      'chat',
      { sender: 'User', text: 'please keep working through compaction' },
      { platformId: 'chan-2', channelType: 'discord', threadId: 'thread-2' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'compact-session' };
      yield { type: 'progress', inputId: 'ignored-by-scripted-provider', message: 'Context compacted.' };
      yield { type: 'result', text: '<message to="discord-current">Done after compaction.</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('compact-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('compact-chat');
    expect(JSON.parse(out[0].content).text).toBe('Done after compaction.');

    await loopPromise.catch(() => {});
  });

  it('counts an MCP send_message output as the user-visible response and does not send a bare final result', async () => {
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-2',
      channelType: 'discord',
      threadId: 'thread-2',
      messagingGroupId: null,
      isGroup: null,
    }).routeKey;
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
        route_key: routeKey,
        content: JSON.stringify({ text: 'Working on it.' }),
      });
      yield { type: 'result', text: 'Done.' };
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

  it('does not count a reaction-only MCP output as the user-visible response for bare final recovery', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertMessage(
      'reaction-before-bare-final-chat',
      'chat',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const prompts: string[] = [];
    let calls = 0;
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) {
        writeMessageOut({
          id: 'reaction-only-progress',
          kind: 'chat',
          platform_id: 'chan-1',
          channel_type: 'discord',
          thread_id: 'thread-1',
          content: JSON.stringify({ operation: 'reaction', messageId: 'platform-msg-1', emoji: 'white_check_mark' }),
        });
        return 'Done.';
      }
      return '<message to="discord-current">Done.</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('reaction-before-bare-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).operation).toBe('reaction');
    expect(JSON.parse(out[1].content).text).toBe('Done.');
    expect(prompts).toHaveLength(2);

    await loopPromise.catch(() => {});
  });

  it('does not let an earlier visible response satisfy a later bare follow-up reply', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertMessage(
      'first-followup-accounting-chat',
      'chat',
      { sender: 'User', text: 'first message' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('Your last answer was not delivered')) {
        return '<message to="discord-current">SECOND</message>';
      }
      if (prompt.includes('second message')) {
        return 'SECOND';
      }
      return '<message to="discord-current">FIRST</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 4000);

    await waitFor(() => getAckStatus('first-followup-accounting-chat') === 'completed', 1500);
    insertMessage(
      'second-followup-accounting-chat',
      'chat',
      { sender: 'User', text: 'second message' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );
    await waitFor(() => getAckStatus('second-followup-accounting-chat') === 'completed', 3000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('FIRST');
    expect(JSON.parse(out[1].content).text).toBe('SECOND');
    expect(prompts.some((prompt) => prompt.includes('Your last answer was not delivered'))).toBe(true);

    await loopPromise.catch(() => {});
  });

  it('allows an MCP send_message update followed by an explicit final response', async () => {
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-2',
      channelType: 'discord',
      threadId: 'thread-2',
      messagingGroupId: null,
      isGroup: null,
    }).routeKey;
    insertChannelDestination('discord-current', 'chan-2');
    insertMessage(
      'mcp-explicit-final-chat',
      'chat',
      { sender: 'User', text: 'do a long thing' },
      { platformId: 'chan-2', channelType: 'discord', threadId: 'thread-2' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'mcp-explicit-final-session' };
      writeMessageOut({
        id: 'mcp-progress-response',
        in_reply_to: 'mcp-explicit-final-chat',
        kind: 'chat',
        platform_id: 'chan-2',
        channel_type: 'discord',
        thread_id: 'thread-2',
        route_key: routeKey,
        content: JSON.stringify({ text: 'Working on it.' }),
      });
      yield { type: 'result', text: '<message to="discord-current">Done.</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('mcp-explicit-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    const texts = out.map((m) => JSON.parse(m.content).text);
    expect(texts).toContain('Working on it.');
    expect(texts).toContain('Done.');
    expect(out).toHaveLength(2);

    await loopPromise.catch(() => {});
  });

  it('accepts single-quoted destination names in explicit final message tags', async () => {
    insertChannelDestination('discord-current', 'chan-2');
    insertMessage(
      'single-quote-final-chat',
      'chat',
      { sender: 'User', text: 'finish this' },
      { platformId: 'chan-2', channelType: 'discord', threadId: 'thread-2' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'single-quote-final-session' };
      yield { type: 'result', text: "<message to='discord-current'>Done.</message>" };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('single-quote-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done.');

    await loopPromise.catch(() => {});
  });

  it('does not route-stamp or thread cross-destination final message rows', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertChannelDestination('other-channel', 'chan-2');
    insertMessage(
      'cross-final-chat',
      'chat',
      { sender: 'User', text: 'send a note elsewhere' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        threadId: 'thread-1',
        messagingGroupId: 'mg-current',
        isGroup: 1,
      },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'cross-final-session' };
      yield { type: 'result', text: '<message to="other-channel">Heads up.</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('cross-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const rowsByText = new Map(out.map((m) => [JSON.parse(m.content).text as string, m]));
    const crossRow = rowsByText.get('Heads up.');
    expect(crossRow).toBeDefined();
    expect(crossRow!.platform_id).toBe('chan-2');
    expect(crossRow!.channel_type).toBe('discord');
    expect(crossRow!.in_reply_to).toBeNull();
    expect(crossRow!.thread_id).toBeNull();
    expect(crossRow!.route_key).toBeNull();
    expect(crossRow!.messaging_group_id).toBeNull();
    expect(crossRow!.is_group).toBeNull();

    const errorRow = out.find((m) =>
      JSON.parse(m.content).text.includes('completed without sending a user-visible response'),
    );
    expect(errorRow).toBeDefined();
    expect(errorRow!.platform_id).toBe('chan-1');
    expect(errorRow!.channel_type).toBe('discord');
    expect(errorRow!.route_key).toBe(
      normalizeRoute('test', {
        platformId: 'chan-1',
        channelType: 'discord',
        threadId: 'thread-1',
        messagingGroupId: 'mg-current',
        isGroup: 1,
      }).routeKey,
    );
    expect(errorRow!.messaging_group_id).toBe('mg-current');
    expect(errorRow!.is_group).toBe(1);

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
    insertChannelDestination('discord-test');
    insertMessage(
      'clear-1',
      'chat',
      { sender: 'Admin', text: '/clear' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const provider = new ScriptedProvider(async function* (input) {
      expect(input.prompt).toContain('/clear');
      yield { type: 'init', continuation: 'runner-clear-still-provider-owned' };
      yield { type: 'result', text: '<message to="discord-test">provider saw clear</message>' };
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
    insertChannelDestination('discord-test');
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
      yield { type: 'result', text: '<message to="discord-test">provider saw host-owned commands as text</message>' };
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

describe('poll-loop /stop control messages', () => {
  function dmMsg(id: string, text: string, messagingGroupId = 'mg-stop'): void {
    insertMessage(
      id,
      'chat-sdk',
      { sender: 'User', text },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId,
        isGroup: 0,
      },
    );
  }

  function stopScope(messagingGroupId = 'mg-stop'): ProviderRecoveryScope {
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId,
      isGroup: 0,
    }).routeKey;
    return {
      providerName: 'test',
      routeKey,
      messagingGroupId,
      isGroup: 0,
      platformId: 'chan-1',
      channelType: 'discord',
      threadKey: null,
    };
  }

  function outboundTexts(): string[] {
    return getUndeliveredMessages().map((m) => {
      try {
        return (JSON.parse(m.content) as { text?: string }).text ?? '';
      } catch {
        return '';
      }
    });
  }

  it('aborts an active query on exact /stop and completes accepted work without recovery', async () => {
    dmMsg('stop-active-init', 'long task');

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const releaseReady = deferred();
    const pushes: QueryTurnInput[] = [];
    let abortCalls = 0;

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        return {
          push(message) {
            pushes.push(typeof message === 'string' ? { inputId: 'legacy', prompt: message } : message);
          },
          end() {
            releaseQuery?.();
          },
          abort() {
            abortCalls++;
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'stop-active-session' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
              releaseReady.resolve();
            });
            yield {
              type: 'interruption',
              inputId: (input as QueryInput).inputId,
              classification: 'codex_turn_interrupted',
              severity: 'info',
              terminal: true,
              agentMessage: 'interrupted',
              fallbackUserMessage: 'provider fallback should be suppressed',
              continuationPolicy: 'preserve',
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    await releaseReady.promise;
    dmMsg('stop-active-control', '  /STOP  ');

    await waitFor(() => abortCalls === 1 && getAckStatus('stop-active-init') === 'completed', 3000);
    expect(abortCalls).toBe(1);
    expect(pushes).toHaveLength(0);
    expect(getAckStatus('stop-active-control')).toBe('completed');
    expect(getAckStatus('stop-active-init')).toBe('completed');
    expect(listRecoveryEntries(stopScope())).toHaveLength(0);
    expect(outboundTexts().filter((t) => t.includes('Stopped'))).toHaveLength(1);
    expect(outboundTexts()).not.toContain('provider fallback should be suppressed');
    const zombieRows = getOutboundDb()
      .prepare("SELECT key FROM session_state WHERE key LIKE 'zombie_failures:%'")
      .all() as Array<{ key: string }>;
    expect(zombieRows).toHaveLength(0);

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('acknowledges a lone /stop without starting the provider', async () => {
    dmMsg('stop-idle-control', '\n/Stop\t');

    const provider = new ScriptedProvider(async function* () {
      throw new Error('provider should not start for idle /stop');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('stop-idle-control') === 'completed', 3000);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.calls).toBe(0);
    expect(outboundTexts().filter((t) => t.includes('No active'))).toHaveLength(1);
  });

  it('splits /stop out of a cold-start batch without dropping other work', async () => {
    dmMsg('stop-mixed-control', '/stop');
    dmMsg('stop-mixed-work', 'please keep working');
    insertChannelDestination('discord-test', 'chan-1');

    const prompts: string[] = [];
    const provider = new ScriptedProvider(async function* (input) {
      prompts.push(input.prompt);
      expect(input.prompt).toContain('please keep working');
      expect(input.prompt).not.toContain('/stop');
      yield { type: 'result', text: '<message to="discord-test">continued work</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('stop-mixed-work') === 'completed', 3000);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(getAckStatus('stop-mixed-control')).toBe('completed');
    expect(provider.calls).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(outboundTexts().filter((t) => t.includes('No active'))).toHaveLength(1);
    expect(outboundTexts()).toContain('continued work');
  });

  it('does not treat /stop with arguments as a control message', async () => {
    dmMsg('stop-now-chat', '/stop now');

    const provider = new ScriptedProvider(async function* (input) {
      expect(input.prompt).toContain('/stop now');
      yield { type: 'result', text: '<message to="discord-test">not a control message</message>' };
    });
    insertChannelDestination('discord-test', 'chan-1');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('stop-now-chat') === 'completed', 3000);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.calls).toBe(1);
    expect(outboundTexts()).toContain('not a control message');
  });

  it('does not abort the active route for /stop on a different route', async () => {
    dmMsg('stop-route-init', 'long task', 'mg-active');

    let releaseQuery!: () => void;
    const queryStarted = deferred();
    const releaseReady = deferred();
    let abortCalls = 0;

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
            abortCalls++;
            releaseQuery?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'stop-route-session' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            await new Promise<void>((resolve) => {
              releaseQuery = resolve;
              releaseReady.resolve();
            });
            yield {
              type: 'result',
              text: '<message to="discord-test">active route done</message>',
              resolvedInputIds: [(input as QueryInput).inputId],
            };
          })(),
        };
      },
    };

    insertChannelDestination('discord-test', 'chan-1');
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    await releaseReady.promise;
    dmMsg('stop-other-route', '/stop', 'mg-other');
    await sleep(800);
    expect(abortCalls).toBe(0);
    expect(getAckStatus('stop-other-route')).toBeNull();

    releaseQuery();
    await waitFor(() => getAckStatus('stop-route-init') === 'completed', 3000);
    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('does not pass /stop-prefixed text through as a provider-native slash command', async () => {
    insertChannelDestination('discord-test');
    insertMessage(
      'stop-native',
      'chat',
      { sender: 'Admin', text: '/stop now' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new NativeScriptedProvider(async function* (input) {
      expect(input.prompt).toContain('<message');
      expect(input.prompt).toContain('/stop now');
      expect(input.prompt.trim()).not.toBe('/stop now');
      yield { type: 'result', text: '<message to="discord-test">provider saw wrapped stop text</message>' };
    });

    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getAckStatus('stop-native') === 'completed', 3000);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(outboundTexts()).toContain('provider saw wrapped stop text');
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
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('p1', 'processing', datetime('now'))",
      )
      .run();
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('r1', 'recovery', datetime('now'))",
      )
      .run();

    returnProcessingToPending(['p1', 'r1'], 'unaccepted-followup');
    expect(ackStatus('p1')).toBeNull(); // processing deleted → pending again
    expect(ackStatus('r1')).toBe('recovery'); // recovery preserved
  });

  it('markRecoveryOwned moves rows to recovery and markRecoveryCompleted completes them', () => {
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1', 'processing', datetime('now'))",
      )
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
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('orphan-proc', 'processing', datetime('now'))",
      )
      .run();
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('rec-owned', 'recovery', datetime('now'))",
      )
      .run();
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('done', 'completed', datetime('now'))",
      )
      .run();

    clearStaleProcessingAcks();

    expect(ackStatus('orphan-proc')).toBeNull(); // orphan processing cleared
    expect(ackStatus('rec-owned')).toBe('recovery'); // recovery preserved
    expect(ackStatus('done')).toBe('completed'); // completed untouched
  });

  // Step 8 (line 981): startup clears stale OpenCode-owned tool state. After a
  // crash, container_state may still claim a long tool is in flight (which would
  // make host-sweep honor a phantom long timeout); a fresh container resets it.
  it('clearStaleContainerToolState resets a stale in-flight tool row on startup', () => {
    // A prior crashed turn left a long tool claimed in container_state.
    setContainerToolInFlight('bash', 3_600_000);
    const before = getOutboundDb()
      .prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state WHERE id = 1')
      .get() as { current_tool: string | null; tool_declared_timeout_ms: number | null } | undefined;
    expect(before?.current_tool).toBe('bash');
    expect(before?.tool_declared_timeout_ms).toBe(3_600_000);

    clearStaleContainerToolState();

    const after = getOutboundDb()
      .prepare('SELECT current_tool, tool_declared_timeout_ms, tool_started_at FROM container_state WHERE id = 1')
      .get() as {
      current_tool: string | null;
      tool_declared_timeout_ms: number | null;
      tool_started_at: string | null;
    };
    // Row is reset to NULL (kept as the singleton id=1 row, not deleted), so the
    // host no longer honors a phantom long timeout.
    expect(after.current_tool).toBeNull();
    expect(after.tool_declared_timeout_ms).toBeNull();
    expect(after.tool_started_at).toBeNull();
  });

  it('clearContainerToolInFlight does not rewrite an already-clear tool row', () => {
    clearContainerToolInFlight();
    getOutboundDb().prepare("UPDATE container_state SET updated_at = 'fixed-clear-time' WHERE id = 1").run();

    clearContainerToolInFlight();

    const after = getOutboundDb().prepare('SELECT updated_at FROM container_state WHERE id = 1').get() as {
      updated_at: string;
    };
    expect(after.updated_at).toBe('fixed-clear-time');
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
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('mr1', 'recovery', datetime('now'))",
      )
      .run();
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('mr2', 'recovery', datetime('now'))",
      )
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
    insertMessage(
      'initial-dm',
      'chat',
      { sender: 'User', text: 'start' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-dm-1',
        isGroup: 0,
      },
    );

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
      insertMessage(
        'followup-dm',
        'chat',
        { sender: 'User', text: 'and also this' },
        {
          platformId: 'chan-1',
          channelType: 'discord',
          messagingGroupId: 'mg-dm-1',
          isGroup: 0,
        },
      );

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

    insertMessage(
      'init-msg',
      'chat',
      { sender: 'User', text: 'initial' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-fu',
        isGroup: 0,
      },
    );

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
      insertMessage(
        'fu-msg',
        'chat',
        { sender: 'User', text: 'follow-up' },
        {
          platformId: 'chan-1',
          channelType: 'discord',
          messagingGroupId: 'mg-fu',
          isGroup: 0,
        },
      );

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
    insertChannelDestination('discord-test');
    insertMessage(
      'one-active',
      'chat',
      { sender: 'User', text: 'do it' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-one',
        isGroup: 0,
      },
    );

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
    insertChannelDestination('discord-test');
    insertMessage(
      'amb-initial',
      'chat',
      { sender: 'User', text: 'first' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-amb',
        isGroup: 0,
      },
    );

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
      insertMessage(
        'amb-followup',
        'chat',
        { sender: 'User', text: 'second' },
        {
          platformId: 'chan-1',
          channelType: 'discord',
          messagingGroupId: 'mg-amb',
          isGroup: 0,
        },
      );

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
  function recoveryScope(
    routeKey: string,
    messagingGroupId: string | null,
    isGroup: 0 | 1 | null,
  ): ProviderRecoveryScope {
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
    insertMessage(
      'acc-dm',
      'chat',
      { sender: 'User', text: 'long running task' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-acc-1',
        isGroup: 0,
      },
    );

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
    insertMessage(
      'acc-prog',
      'chat',
      { sender: 'User', text: 'do work and report progress' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-prog-1',
        isGroup: 0,
      },
    );

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
    insertMessage(
      'trig-1',
      'chat',
      { sender: 'User', text: 'first task' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-multi',
        isGroup: 0,
      },
    );
    insertMessage(
      'trig-2',
      'chat',
      { sender: 'User', text: 'second task' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-multi',
        isGroup: 0,
      },
    );

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
    insertMessage(
      'ctx-other',
      'chat',
      { sender: 'Other', text: 'UNRELATED context line' },
      {
        trigger: 0,
        platformId: 'chan-OTHER',
        channelType: 'discord',
        messagingGroupId: 'mg-ctx-other',
        isGroup: 0,
      },
    );
    // Same-route accumulated context (trigger=0) — rides along with the trigger.
    insertMessage(
      'ctx-same',
      'chat',
      { sender: 'User', text: 'SAME-route earlier context' },
      {
        trigger: 0,
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-trig',
        isGroup: 0,
      },
    );
    // The wake-triggering row (trigger=1) on the active route.
    insertMessage(
      'trig-main',
      'chat',
      { sender: 'User', text: 'TRIGGER task' },
      {
        trigger: 1,
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-trig',
        isGroup: 0,
      },
    );

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

  // Regression (Task 6 exposed): the poll loop's OWN user-visible output — an
  // explicitly-addressed result reply (and relay/inactivity fallback) — must be
  // stamped with the active route_key/messaging_group_id/is_group. Previously
  // dispatchResultText / sendToDestination wrote it with route_key=NULL, so
  // harvestRouteScopedProgress (which filters on route_key) could never recover
  // the agent's own progress line on a terminal interruption. This drives the
  // REAL result path (not a hand-stamped writeMessageOut).
  it('stamps the active route metadata on a result-text reply so it is harvestable into recovery', async () => {
    insertChannelDestination('discord-routed');
    insertMessage(
      'routed-init',
      'chat',
      { sender: 'User', text: 'report a progress line then get interrupted' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-routed',
        isGroup: 0,
      },
    );
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-routed',
      isGroup: 0,
    }).routeKey;
    const scope = recoveryScope(routeKey, 'mg-routed', 0);

    let releaseFollowup!: () => void;
    const queryStarted = deferred();
    const followupAccepted = deferred();
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        queryStarted.resolve();
        let followupInputId: string | undefined;
        return {
          push(turn) {
            followupInputId = typeof turn === 'string' ? undefined : turn.inputId;
          },
          end() {
            releaseFollowup?.();
          },
          abort() {
            releaseFollowup?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'sess-routed' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            // A user-visible progress segment delivered through the REAL result
            // path (explicit <message> → dispatchResultText → routed reply). This
            // resolves the initial input and writes the routed progress row.
            yield {
              type: 'result',
              text: '<message to="discord-routed">Working on it — partial progress delivered.</message>',
              inputId: (input as QueryInput).inputId,
              resolvedInputIds: [(input as QueryInput).inputId],
            };
            // A route-matched follow-up arrives and is accepted (kept alive).
            await new Promise<void>((resolve) => {
              const iv = setInterval(() => {
                if (followupInputId) {
                  clearInterval(iv);
                  resolve();
                }
              }, 10);
            });
            yield { type: 'input-accepted', inputId: followupInputId!, scope: 'followup' };
            followupAccepted.resolve();
            // Then a terminal interruption with the follow-up accepted-unresolved,
            // so it moves into recovery, which harvests the earlier routed progress
            // row by route_key.
            await new Promise<void>((resolve) => {
              releaseFollowup = resolve;
            });
            yield {
              type: 'interruption',
              inputId: followupInputId!,
              classification: 'opencode_transport_timeout',
              severity: 'warn',
              terminal: true,
              agentMessage: 'interrupted',
              fallbackUserMessage: 'I was interrupted; your request is preserved.',
              continuationPolicy: 'preserve',
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await queryStarted.promise;
    // The routed progress row is written before the follow-up arrives.
    await waitFor(
      () =>
        !!getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE content LIKE '%partial progress delivered%'").get(),
      3000,
    );
    // A route-matched follow-up that the turn accepts and that gets interrupted.
    insertMessage(
      'routed-followup',
      'chat',
      { sender: 'User', text: 'keep going' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-routed',
        isGroup: 0,
      },
    );
    await followupAccepted.promise;
    releaseFollowup();
    await waitFor(() => listRecoveryEntries(scope).length >= 1, 3000);

    // The result-text reply row carries the active route_key (the fix).
    const routedRow = getOutboundDb()
      .prepare(
        "SELECT route_key, messaging_group_id, is_group FROM messages_out WHERE content LIKE '%partial progress delivered%'",
      )
      .get() as { route_key: string | null; messaging_group_id: string | null; is_group: number | null } | undefined;
    expect(routedRow?.route_key).toBe(routeKey);
    expect(routedRow?.messaging_group_id).toBe('mg-routed');
    expect(routedRow?.is_group).toBe(0);

    // And it is therefore harvested into the recovery entry's priorProgress.
    const entry = listRecoveryEntries(scope)[0];
    expect(entry.priorProgress.map((p) => p.text)).toContain('Working on it — partial progress delivered.');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  // Regression (Task 6 exposed): the poll loop STORED recovery entries but never
  // CONSUMED them — a stored pending entry's context was not injected into the
  // next top-level prompt, and a successful resuming turn neither resolved the
  // recovery entry nor completed its recovery-owned rows. So an interrupted turn's
  // rows stayed in processing_ack.status='recovery' forever and the agent lost the
  // interrupted context. This wires injection-on-wake + resolve-on-success.
  it('injects pending recovery into the next top-level prompt and resolves it (rows completed) only on success', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertMessage(
      'resume-trigger',
      'chat',
      { sender: 'User', text: 'answer that resumes the prior work' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-resume',
        isGroup: 0,
      },
    );
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-resume',
      isGroup: 0,
    }).routeKey;
    const scope = recoveryScope(routeKey, 'mg-resume', 0);

    // Seed a pending recovery entry owning a prior interrupted row, with that row
    // already in processing_ack.status='recovery' (the terminal-interruption state).
    const now = new Date().toISOString();
    const seed: ProviderRecoveryEntry = {
      id: 'rec-resume-1',
      status: 'pending',
      classification: 'terminal_interruption_accepted_unresolved',
      agentMessage: 'I was interrupted mid-turn and will resume this work.',
      fallbackUserMessage: 'I still have your earlier request.',
      originalTasks: [{ messageId: 'prior-row', text: 'do the earlier interrupted task', timestamp: now }],
      acceptedUnresolvedInputs: [
        { inputId: 'in-prior', messageIds: ['prior-row'], prompt: 'do the earlier interrupted task' },
      ],
      pendingFollowups: [],
      priorProgress: [
        { messageOutId: 'mo-1', text: 'I had started reading the file.', source: 'provider_progress', timestamp: now },
      ],
      observations: [],
      sideEffects: [],
      continuationPolicy: 'preserve',
      createdAt: now,
      updatedAt: now,
    };
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(`recovery:test:${routeKey}`, JSON.stringify([seed]), now);
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('prior-row', 'recovery', datetime('now'))",
      )
      .run();

    let seenPrompt = '';
    const provider = new ScriptedProvider(async function* (input) {
      seenPrompt = input.prompt;
      yield { type: 'init', continuation: 'sess-resume' };
      // Mark in_flight observed on acceptance happens in the loop; here, on the
      // FIRST observation, the entry must NOT yet be resolved (accept != consume).
      yield { type: 'result', text: '<message to="discord-current">Resumed and finished the earlier task.</message>' };
    });

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getAckStatus('resume-trigger') === 'completed', 3000);

    // The recovery context was injected into the top-level prompt (original task +
    // prior progress), XML-escaped.
    expect(seenPrompt).toContain('<recovery>');
    expect(seenPrompt).toContain('do the earlier interrupted task');
    expect(seenPrompt).toContain('I had started reading the file.');

    // On success, the recovery entry is resolved AND its owned row is completed.
    await waitFor(() => listRecoveryEntries(scope).every((e) => e.status === 'resolved'), 3000);
    expect(getAckStatus('prior-row')).toBe('completed');

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
    insertMessage(
      'pretask-fail',
      'task',
      { prompt: 'do the scheduled thing' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-pt',
        isGroup: 0,
      },
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
    insertMessage(
      'startup-fail',
      'chat',
      { sender: 'User', text: 'kick off' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-startup',
        isGroup: 0,
      },
    );

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
    insertMessage(
      'routeA-1',
      'chat',
      { sender: 'A', text: 'route A task' },
      {
        platformId: 'chan-A',
        channelType: 'discord',
        messagingGroupId: 'mg-A',
        isGroup: 0,
      },
    );
    insertMessage(
      'routeB-1',
      'chat',
      { sender: 'B', text: 'route B task' },
      {
        platformId: 'chan-B',
        channelType: 'discord',
        messagingGroupId: 'mg-B',
        isGroup: 0,
      },
    );

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

describe('provider status actions', () => {
  it('writes one inactivity status, suppresses later idle notices, and still writes terminal fallback', () => {
    const state = { inactivityStatusSent: false, terminalFallbackSent: false };

    expect(
      decideProviderStatusAction(state, {
        type: 'notice',
        inputId: 'in-1',
        classification: 'inactivity',
        severity: 'info',
        fallbackUserMessage: "I'm still working on your request.",
      }),
    ).toEqual({ kind: 'write', text: "I'm still working on your request." });

    expect(
      decideProviderStatusAction(state, {
        type: 'notice',
        inputId: 'in-1',
        classification: 'inactivity',
        severity: 'info',
        fallbackUserMessage: "I'm still working on your request.",
      }),
    ).toEqual({ kind: 'log', event: 'inactivity_notice_suppressed' });

    expect(
      decideProviderStatusAction(state, {
        type: 'interruption',
        inputId: 'in-1',
        classification: 'opencode_native_question',
        severity: 'warn',
        terminal: true,
        agentMessage: 'I need your answer before I can continue: Which account should I use?',
        fallbackUserMessage: 'I need your answer before I can continue: Which account should I use?',
        continuationPolicy: 'clear',
      }),
    ).toEqual({
      kind: 'write',
      text: 'I need your answer before I can continue: Which account should I use?',
    });

    expect(
      decideProviderStatusAction(state, {
        type: 'interruption',
        inputId: 'in-1',
        classification: 'opencode_native_question',
        severity: 'warn',
        terminal: true,
        agentMessage: 'duplicate terminal',
        fallbackUserMessage: 'duplicate terminal',
        continuationPolicy: 'clear',
      }),
    ).toEqual({ kind: 'none' });
  });
});

// ── Task 3 Step 2: inactivity status + terminal recovery ────────────────────

describe('poll-loop inactivity status and terminal recovery', () => {
  function dmMsg(id: string, text: string): void {
    insertChannelDestination('relay-current');
    insertMessage(
      id,
      'chat',
      { sender: 'User', text },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-relay',
        isGroup: 0,
      },
    );
  }

  function outboundTexts(): string[] {
    return getUndeliveredMessages().map((m) => {
      try {
        return (JSON.parse(m.content) as { text?: string }).text ?? '';
      } catch {
        return '';
      }
    });
  }

  it('writes one direct inactivity status while the original long turn keeps running', async () => {
    dmMsg('idle-init', 'do the long thing');

    let releaseMain!: () => void;
    const mainStarted = deferred();

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        mainStarted.resolve();
        return {
          push() {},
          end() {},
          abort() {
            releaseMain?.();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'main-sess' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            yield {
              type: 'notice',
              inputId: (input as QueryInput).inputId,
              classification: 'inactivity',
              severity: 'info',
              fallbackUserMessage: "I'm still working on your request.",
            };
            yield {
              type: 'notice',
              inputId: (input as QueryInput).inputId,
              classification: 'inactivity',
              severity: 'info',
              fallbackUserMessage: "I'm still working on your request.",
            };
            await new Promise<void>((resolve) => {
              releaseMain = resolve;
            });
            yield {
              type: 'result',
              text: '<message to="relay-current">done at last</message>',
              inputId: (input as QueryInput).inputId,
              resolvedInputIds: [(input as QueryInput).inputId],
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await mainStarted.promise;
    await waitFor(() => outboundTexts().some((t) => t === "I'm still working on your request."), 3000);
    expect(outboundTexts().filter((t) => t === "I'm still working on your request.").length).toBe(1);

    releaseMain();
    await waitFor(() => outboundTexts().includes('done at last'), 3000);

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('routes a terminal interruption with accepted-unresolved rows through recovery ownership (the existing seam)', async () => {
    dmMsg('term-init', 'long task that gets interrupted');

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'main-sess' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            // Typed terminal interruption (preserve continuation).
            yield {
              type: 'interruption',
              inputId: (input as QueryInput).inputId,
              classification: 'opencode_transport_timeout',
              severity: 'warn',
              terminal: true,
              agentMessage: 'interrupted mid-turn',
              fallbackUserMessage: 'I was interrupted; your request is preserved.',
              continuationPolicy: 'preserve',
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    // The accepted-but-unresolved row moves into recovery ownership (status
    // 'recovery'), NOT completed and NOT returned to pending.
    await waitFor(() => getAckStatus('term-init') === 'recovery', 3000);
    expect(getAckStatus('term-init')).toBe('recovery');

    // Every terminal path must leave the user a visible next step: exactly ONE
    // sanitized direct fallback (the interruption's fallbackUserMessage) is
    // written, and it never leaks raw provider error text. (Task 6 exposed: a
    // terminal interruption previously stranded the user with no visible row.)
    await waitFor(() => outboundTexts().some((t) => t.includes('your request is preserved')), 3000);
    expect(outboundTexts().filter((t) => t.includes('your request is preserved')).length).toBe(1);
    for (const t of outboundTexts()) expect(t).not.toContain('opencode_transport_timeout');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('does not resume an unscoped continuation when the provider supplies a runtime scope', async () => {
    setContinuation('opencode', 'ses_old_unscoped');
    dmMsg('scoped-cont-init', 'use the current model config');
    let attemptedContinuation: string | undefined = 'not-called';

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      continuationScope: 'openai-gpt-5.5-xhigh',
      isSessionInvalid: () => false,
      query(input) {
        attemptedContinuation = input.continuation;
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'ses_openai_scoped' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            yield {
              type: 'result',
              text: '<message to="relay-current">fresh scoped session</message>',
              inputId: (input as QueryInput).inputId,
              resolvedInputIds: [(input as QueryInput).inputId],
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'opencode', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getContinuation('opencode', 'openai-gpt-5.5-xhigh') === 'ses_openai_scoped', 3000);
    expect(attemptedContinuation).toBeUndefined();
    expect(getContinuation('opencode')).toBe('ses_old_unscoped');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('resumes a continuation stored under the same provider runtime scope', async () => {
    setContinuation('opencode', 'ses_matching_scope', 'openai-gpt-5.5-xhigh');
    dmMsg('scoped-cont-resume', 'continue the current model config');
    let attemptedContinuation: string | undefined;

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      continuationScope: 'openai-gpt-5.5-xhigh',
      isSessionInvalid: () => false,
      query(input) {
        attemptedContinuation = input.continuation;
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'ses_matching_scope' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            yield {
              type: 'result',
              text: '<message to="relay-current">resumed scoped session</message>',
              inputId: (input as QueryInput).inputId,
              resolvedInputIds: [(input as QueryInput).inputId],
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'opencode', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => outboundTexts().includes('resumed scoped session'), 3000);
    expect(attemptedContinuation).toBe('ses_matching_scope');
    expect(getContinuation('opencode', 'openai-gpt-5.5-xhigh')).toBe('ses_matching_scope');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('clears continuation via the bounded zombie path after the failure limit of preserve interruptions', async () => {
    // Default limit is 3. Seed the counter at 2 so the next preserve-continuation
    // terminal interruption (failures=3) trips the zombie clear.
    setContinuation('test', 'ses_zombie');
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('zombie_failures:test:ses_zombie', '2', new Date().toISOString());
    dmMsg('zombie-init', 'work on the zombie session');

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'ses_zombie' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            yield {
              type: 'interruption',
              inputId: (input as QueryInput).inputId,
              classification: 'opencode_transport_timeout',
              severity: 'warn',
              terminal: true,
              agentMessage: 'interrupted again',
              fallbackUserMessage: 'I was interrupted; your request is preserved.',
              continuationPolicy: 'preserve',
              attemptedContinuation: 'ses_zombie',
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    // The 3rd consecutive preserve-continuation interruption trips the zombie
    // clear — the continuation is cleared even though policy was 'preserve'.
    await waitFor(() => getContinuation('test') === undefined, 3000);
    expect(getContinuation('test')).toBeUndefined();

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('clears the stored continuation on a clear-continuation event', async () => {
    dmMsg('clear-init', 'something that ends in a native question');
    // Seed a stored continuation so we can observe it being cleared.
    setContinuation('test', 'ses_to_clear');

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'ses_to_clear' };
            yield { type: 'input-accepted', inputId: (input as QueryInput).inputId, scope: 'initial' };
            yield {
              type: 'clear-continuation',
              inputId: (input as QueryInput).inputId,
              reason: 'native_question_denied',
            };
            yield {
              type: 'interruption',
              inputId: (input as QueryInput).inputId,
              classification: 'opencode_native_question',
              severity: 'warn',
              terminal: true,
              agentMessage: 'I need your input: what is the email?',
              fallbackUserMessage: 'I need more info to finish.',
              continuationPolicy: 'clear',
            };
          })(),
        };
      },
    };

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getContinuation('test') === undefined, 3000);
    expect(getContinuation('test')).toBeUndefined();

    controller.abort();
    await loopPromise.catch(() => {});
  });
});
