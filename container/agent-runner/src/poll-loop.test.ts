import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

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
  },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.platformId ?? null,
      opts?.channelType ?? null,
      opts?.threadId ?? null,
      JSON.stringify(content),
    );
}

class ScriptedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  calls = 0;

  constructor(private readonly eventFactory: (input: QueryInput) => AsyncIterable<ProviderEvent>) {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.calls++;
    return {
      push(_message: string) {},
      end() {},
      abort() {},
      events: this.eventFactory(input),
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

    await waitFor(() => getAckStatus('quiet-task') === 'completed', 1500);
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
    const pushes: string[] = [];
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        expect(input.prompt).toContain('first');
        queryStarted.resolve();
        return {
          push(message) {
            pushes.push(message);
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
    await waitFor(() => pushes.some((prompt) => prompt.includes('/clear')), 1500);
    controller.abort();
    releaseQuery();
    await loopPromise.catch(() => {});

    expect(pushes.some((prompt) => prompt.includes('/clear'))).toBe(true);
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
