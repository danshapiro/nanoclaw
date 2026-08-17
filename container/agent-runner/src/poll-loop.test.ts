import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

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
  readProviderRetrySchedule,
  resolveRecoveryEntry,
  scheduleProviderRetry,
  setContinuation,
  type ProviderRecoveryEntry,
  type ProviderRecoveryScope,
} from './db/session-state.js';
import { formatMessages, extractRouting, normalizeRoute } from './formatter.js';
import { GwsCorrelationLifecycleFault } from './gws-correlation.js';
import { decideProviderStatusAction, runPollLoop as runProductionPollLoop, type PollLoopConfig } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import { terminateCodexAppServer } from './providers/codex-app-server.js';
import { isProcessAlive, spawnCodexTestProcessTree } from './providers/codex-process-tree.test-support.js';
import {
  ProviderContainerStopRequired,
  ProviderQuiescenceError,
  type AgentProvider,
  type AgentQuery,
  type ProviderEvent,
  type QueryInput,
  type QueryTurnInput,
} from './providers/types.js';

function runPollLoop(config: PollLoopConfig): Promise<void> {
  const provider = config.provider;
  const gatedProvider: AgentProvider = {
    ...provider,
    supportsNativeSlashCommands: provider.supportsNativeSlashCommands,
    continuationScope: provider.continuationScope,
    isSessionInvalid: provider.isSessionInvalid.bind(provider),
    query(input) {
      const query = provider.query(input);
      const queuedTurns: Array<{ turn: QueryTurnInput; gated: boolean }> = [{ turn: input, gated: false }];
      return {
        push(turn) {
          const normalized =
            typeof turn === 'string'
              ? { inputId: `legacy-${Date.now()}`, acceptInput: async () => {}, prompt: turn }
              : turn;
          queuedTurns.push({ turn: normalized, gated: false });
          query.push(turn);
        },
        end: () => query.end(),
        abort: () => query.abort(),
        events: {
          async *[Symbol.asyncIterator]() {
            await input.acceptInput();
            queuedTurns[0].gated = true;
            for await (const event of query.events) {
              if (event.type === 'input-accepted') {
                const exact = queuedTurns.find(
                  (candidate) => !candidate.gated && candidate.turn.inputId === event.inputId,
                );
                if (exact) {
                  await exact.turn.acceptInput();
                  exact.gated = true;
                }
              }
              yield event;
            }
          },
        },
      };
    },
  };
  return runProductionPollLoop({
    ...config,
    provider: gatedProvider,
    bindGwsCorrelation: config.bindGwsCorrelation ?? (async () => {}),
    releaseGwsCorrelation: config.releaseGwsCorrelation ?? (async () => {}),
  });
}

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
    hostProviderName?: string;
  },
) {
  const hostRoute = normalizeRoute(opts?.hostProviderName ?? 'test', {
    platformId: opts?.platformId ?? null,
    channelType: opts?.channelType ?? null,
    threadId: opts?.threadId ?? null,
    messagingGroupId: opts?.messagingGroupId ?? null,
    isGroup: opts?.isGroup ?? null,
  }).routeKey;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
         (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, thread_id,
          messaging_group_id, is_group, host_input_id, host_route_key, host_received_at, content)
       VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
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
      `in-host-${id}`,
      hostRoute,
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

function stampHostInput(id: string, inputId: string, routeKey: string, receivedAt = new Date().toISOString()): void {
  getInboundDb()
    .prepare(
      `UPDATE messages_in
          SET host_input_id = ?, host_route_key = ?, host_received_at = ?
        WHERE id = ?`,
    )
    .run(inputId, routeKey, receivedAt, id);
}

/** Simulate a pre-stamp inbound row: insertMessage stamps by default, so strip the receipt fields. */
function clearHostStamps(id: string): void {
  getInboundDb()
    .prepare('UPDATE messages_in SET host_input_id = NULL, host_route_key = NULL, host_received_at = NULL WHERE id = ?')
    .run(id);
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
        await input.acceptInput();
        for await (const ev of eventFactory(input)) {
          if (ev.type === 'input-accepted') {
            acceptedEmitted = true;
            yield ev;
            continue;
          }
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
      inputId: 'mock-push-initial',
      acceptInput: async () => {},
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push({ inputId: 'mock-push-followup', acceptInput: async () => {}, prompt: 'Second' }), 30);
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
      inputId: 'mock-e2e',
      acceptInput: async () => {},
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
    const pushAttempted = deferred();
    let releaseQuery!: () => void;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        queryStarted.resolve();
        return {
          push() {
            pushAttempted.resolve();
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
    await pushAttempted.promise;
    await waitFor(() => getAckStatus('image-follow-up') === null, 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(getAckStatus('image-follow-up')).toBeNull();
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

  it('suppresses the missing-visible-reply error for a2a/system-triggered turns and logs instead', async () => {
    const errSpy = spyOn(console, 'error');
    // Host-written a2a/system rows carry channel_type='agent' (see
    // src/modules/agent-to-agent/agent-route.ts, src/modules/managed-repos/actions.ts).
    insertMessage(
      'silent-a2a',
      'chat',
      { sender: 'system', text: 'managed repos push completed' },
      { platformId: 'ag-child-1', channelType: 'agent' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'silent-a2a-session' };
      yield { type: 'result', text: null };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('silent-a2a') === 'completed', 1500);
    controller.abort();

    // No user-visible fallback error row is enqueued (previously this wrote
    // "Error: agent completed without sending a user-visible response...").
    expect(getUndeliveredMessages()).toHaveLength(0);
    const suppressedLog = errSpy.mock.calls.some((call) =>
      String(call[0]).includes('missing_visible_reply_suppressed'),
    );
    expect(suppressedLog).toBe(true);
    errSpy.mockRestore();

    await loopPromise.catch(() => {});
  });

  it('still writes the missing-visible-reply error for user-triggered turns on user channels', async () => {
    insertMessage(
      'silent-user-chat',
      'chat',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-9', channelType: 'discord', threadId: 'thread-9' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'silent-user-session' };
      yield { type: 'result', text: null };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('silent-user-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('discord');
    expect(JSON.parse(out[0].content).text).toContain('completed without sending a user-visible response');

    await loopPromise.catch(() => {});
  });

  it('suppresses the terminal interruption notice for non-user-triggered turns', async () => {
    const errSpy = spyOn(console, 'error');
    insertMessage(
      'interrupted-a2a',
      'chat',
      { sender: 'system', text: 'system notification' },
      { platformId: 'ag-child-1', channelType: 'agent' },
    );

    const provider = new ScriptedProvider(async function* (input) {
      yield { type: 'init', continuation: 'interrupted-a2a-session' };
      yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
      yield {
        type: 'interruption',
        inputId: input.inputId,
        classification: 'codex_turn_interrupted',
        severity: 'info',
        terminal: true,
        agentMessage: 'The Codex turn was interrupted before completing.',
        fallbackUserMessage: 'The active Codex turn was interrupted before completing.',
        continuationPolicy: 'preserve',
      };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('interrupted-a2a') === 'recovery', 1500);
    controller.abort();

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text as string);
    expect(texts).not.toContain('The active Codex turn was interrupted before completing.');
    const suppressedLog = errSpy.mock.calls.some((call) =>
      String(call[0]).includes('interruption_notice_suppressed_non_user_turn'),
    );
    expect(suppressedLog).toBe(true);
    errSpy.mockRestore();

    await loopPromise.catch(() => {});
  });

  it('surfaces provider error text verbatim when a turn ends with no user-visible reply', async () => {
    insertMessage(
      'limited-chat-sdk',
      'chat-sdk',
      { sender: 'User', text: 'please respond' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const limitText =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:35 PM.";
    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'limited-session' };
      yield { type: 'result', text: null, errorText: limitText };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('limited-chat-sdk') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('limited-chat-sdk');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // The provider's verbatim reason is delivered instead of the generic fallback.
    expect(JSON.parse(out[0].content).text).toBe(limitText);
    expect(JSON.parse(out[0].content).text).not.toContain('user-visible response');

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
    insertChannelDestination('discord-unrelated', 'chan-4');
    insertMessage(
      'throwing-chat',
      'chat',
      { sender: 'User', text: 'this will fail' },
      { platformId: 'chan-3', channelType: 'discord', threadId: 'thread-3' },
    );

    const scope: ProviderRecoveryScope = {
      providerName: 'test',
      routeKey: normalizeRoute('test', {
        platformId: 'chan-3',
        channelType: 'discord',
        threadId: 'thread-3',
        messagingGroupId: null,
        isGroup: null,
      }).routeKey,
    };
    const seenPrompts: string[] = [];
    let providerTurn = 0;
    const provider = new ScriptedProvider(async function* (input) {
      seenPrompts.push(input.prompt);
      providerTurn++;
      if (providerTurn === 1) {
        yield { type: 'init', continuation: 'throwing-session' };
        throw new Error('provider exploded');
      }
      yield { type: 'result', text: '<message to="discord-unrelated">unrelated ok</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getUndeliveredMessages().length === 1, 1500);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
    expect(JSON.parse(out[0].content).text).toBe('Error: provider exploded');
    expect(getAckStatus('throwing-chat')).toBe('recovery');
    expect(getPendingMessages().map((message) => message.id)).not.toContain('throwing-chat');
    const recovery = listRecoveryEntries(scope);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({
      status: 'pending',
      classification: 'terminal_interruption_accepted_unresolved',
      acceptedUnresolvedInputs: [{ messageIds: ['throwing-chat'] }],
    });

    // A later message on a different route must not absorb the failed turn's
    // recovery payload. Recovery remains route-owned and the new row receives
    // its own independent terminal outcome.
    insertMessage(
      'unrelated-chat',
      'chat',
      { sender: 'User', text: 'a separate task' },
      { platformId: 'chan-4', channelType: 'discord', threadId: 'thread-4' },
    );
    await waitFor(() => getAckStatus('unrelated-chat') === 'completed', 1500);
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[1]).toContain('a separate task');
    expect(seenPrompts[1]).not.toContain('this will fail');
    expect(getAckStatus('throwing-chat')).toBe('recovery');
    expect(listRecoveryEntries(scope)).toHaveLength(1);

    controller.abort();
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

  it('completes the active row when /stop lands before provider input acceptance', async () => {
    dmMsg('stop-preaccept-init', 'long startup task');

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
            yield { type: 'init', continuation: 'stop-preaccept-session' };
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
    dmMsg('stop-preaccept-control', '/stop');

    await waitFor(() => abortCalls === 1 && getAckStatus('stop-preaccept-init') === 'completed', 3000);
    expect(getAckStatus('stop-preaccept-control')).toBe('completed');
    expect(listRecoveryEntries(stopScope())).toHaveLength(0);
    expect(getPendingMessages().map((m) => m.id)).not.toContain('stop-preaccept-init');
    expect(outboundTexts()).not.toContain('provider fallback should be suppressed');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('completes same-route pending follow-ups that arrive beside active /stop', async () => {
    dmMsg('stop-active-mixed-init', 'long task');

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
            yield { type: 'init', continuation: 'stop-active-mixed-session' };
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
    dmMsg('stop-active-mixed-followup', 'please also do this');
    dmMsg('stop-active-mixed-control', '/stop');

    await waitFor(() => abortCalls === 1 && getAckStatus('stop-active-mixed-followup') === 'completed', 3000);
    expect(getAckStatus('stop-active-mixed-control')).toBe('completed');
    expect(getAckStatus('stop-active-mixed-init')).toBe('completed');
    expect(pushes).toHaveLength(0);
    expect(listRecoveryEntries(stopScope())).toHaveLength(0);

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('resolves resumed recovery ownership when /stop cancels the resumed turn', async () => {
    dmMsg('stop-recovery-trigger', 'resume the old work');
    const scope = stopScope();
    const now = new Date().toISOString();
    appendRecoveryEntry(scope, {
      id: 'stop-rec-1',
      status: 'pending',
      classification: 'terminal_interruption_accepted_unresolved',
      agentMessage: 'I was interrupted mid-turn and will resume this work.',
      fallbackUserMessage: 'I still have your earlier request.',
      originalTasks: [{ messageId: 'stop-recovery-prior', text: 'older interrupted work', timestamp: now }],
      acceptedUnresolvedInputs: [
        { inputId: 'stop-recovery-input', messageIds: ['stop-recovery-prior'], prompt: 'older interrupted work' },
      ],
      pendingFollowups: [],
      priorProgress: [],
      observations: [],
      sideEffects: [],
      continuationPolicy: 'preserve',
      createdAt: now,
      updatedAt: now,
    });
    markRecoveryOwned(['stop-recovery-prior'], 'stop-rec-1');

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
            yield { type: 'init', continuation: 'stop-recovery-session' };
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
    await waitFor(() => listRecoveryEntries(scope)[0]?.status === 'in_flight', 3000);
    dmMsg('stop-recovery-control', '/stop');

    await waitFor(() => abortCalls === 1 && getAckStatus('stop-recovery-prior') === 'completed', 3000);
    expect(getAckStatus('stop-recovery-trigger')).toBe('completed');
    expect(getAckStatus('stop-recovery-control')).toBe('completed');
    expect(listRecoveryEntries(scope).map((e) => e.status)).toEqual(['resolved']);

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

describe('poll-loop final host-backed input selection', () => {
  it('does not submit an accumulate-only remainder after pre-task filtering removes the only trigger', async () => {
    const route = normalizeRoute('test', {
      platformId: 'chan-final',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-final',
      isGroup: 0,
    }).routeKey;
    insertMessage(
      'context-only',
      'chat',
      { sender: 'Observer', text: 'context only' },
      {
        trigger: 0,
        platformId: 'chan-final',
        channelType: 'discord',
        messagingGroupId: 'mg-final',
        isGroup: 0,
      },
    );
    insertMessage(
      'script-trigger',
      'task',
      { prompt: 'skip me' },
      {
        trigger: 1,
        platformId: 'chan-final',
        channelType: 'discord',
        messagingGroupId: 'mg-final',
        isGroup: 0,
      },
    );
    stampHostInput('context-only', 'in-context-receipt', route);
    stampHostInput('script-trigger', 'in-script-trigger', route);

    let queryCalls = 0;
    const provider = new ScriptedProvider(async function* () {
      queryCalls++;
      throw new Error('provider must not receive an input without a surviving host-backed trigger');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      runPreTaskScripts: async (messages) => ({
        keep: messages.filter((message) => message.id === 'context-only'),
        skipped: ['script-trigger'],
      }),
    });

    try {
      await waitFor(() => getAckStatus('script-trigger') === 'completed', 1500);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(queryCalls).toBe(0);
      expect(getAckStatus('context-only')).toBeNull();
      expect(getUndeliveredMessages().some((message) => JSON.parse(message.content).text?.startsWith('Error:'))).toBe(
        false,
      );
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  it('releases a host bind and returns the claim to pending when cancellation wins before provider submission', async () => {
    const route = normalizeRoute('test', {
      platformId: 'chan-cancel',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-cancel',
      isGroup: 0,
    }).routeKey;
    insertMessage(
      'cancel-during-bind',
      'chat',
      { sender: 'User', text: 'do not submit after cancellation' },
      {
        platformId: 'chan-cancel',
        channelType: 'discord',
        messagingGroupId: 'mg-cancel',
        isGroup: 0,
      },
    );
    stampHostInput('cancel-during-bind', 'in-cancel-during-bind', route);

    const bindStarted = deferred();
    const finishBind = deferred();
    let providerAborted = false;
    let providerSubmissionCalls = 0;
    const releases: string[] = [];
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {
            providerAborted = true;
          },
          events: (async function* () {
            await input.acceptInput();
            if (providerAborted) return;
            providerSubmissionCalls++;
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
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
      bindGwsCorrelation: async () => {
        bindStarted.resolve();
        await finishBind.promise;
      },
      releaseGwsCorrelation: async (inputId) => {
        releases.push(inputId);
      },
    });

    await bindStarted.promise;
    controller.abort();
    finishBind.resolve();
    await loopPromise;

    expect(providerSubmissionCalls).toBe(0);
    expect(releases).toEqual(['in-cancel-during-bind']);
    expect(getAckStatus('cancel-during-bind')).toBeNull();
    expect(getPendingMessages().map((message) => message.id)).toContain('cancel-during-bind');
    expect(listRecoveryEntries({ providerName: 'test', routeKey: route })).toHaveLength(0);
  });

  it('keeps an accumulate-only active-turn follow-up under the existing accepted host input', async () => {
    const route = normalizeRoute('test', {
      platformId: 'chan-active',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-active',
      isGroup: 0,
    }).routeKey;
    insertMessage(
      'active-trigger',
      'task',
      { prompt: 'start' },
      {
        platformId: 'chan-active',
        channelType: 'discord',
        messagingGroupId: 'mg-active',
        isGroup: 0,
      },
    );
    stampHostInput('active-trigger', 'in-host-active', route);

    const initialAccepted = deferred();
    const followupPushed = deferred();
    const binds: Array<{ inputId: string; messageIds: string[]; claimToken: string }> = [];
    let pushedInputId: string | undefined;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push(value) {
            if (typeof value !== 'string') pushedInputId = value.inputId;
            followupPushed.resolve();
          },
          end() {},
          abort() {},
          events: (async function* () {
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            initialAccepted.resolve();
            await followupPushed.promise;
            yield { type: 'input-accepted', inputId: pushedInputId!, scope: 'followup' };
            yield { type: 'result', text: null, inputId: input.inputId, resolvedInputIds: [input.inputId] };
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
      bindGwsCorrelation: async (inputId, _routeKey, messageIds, claimToken) => {
        binds.push({ inputId, messageIds: [...messageIds], claimToken });
      },
    });

    try {
      await initialAccepted.promise;
      insertMessage(
        'accumulated-followup',
        'chat',
        { sender: 'Observer', text: 'background context' },
        {
          trigger: 0,
          platformId: 'chan-active',
          channelType: 'discord',
          messagingGroupId: 'mg-active',
          isGroup: 0,
        },
      );
      stampHostInput('accumulated-followup', 'in-receipt-only', route);
      await followupPushed.promise;
      expect(pushedInputId).toBe('in-host-active');
      await waitFor(() => getAckStatus('accumulated-followup') === 'completed', 1500);
      expect(binds).toHaveLength(2);
      expect(binds.map((bind) => bind.inputId)).toEqual(['in-host-active', 'in-host-active']);
      expect(binds.map((bind) => bind.messageIds)).toEqual([['active-trigger'], ['accumulated-followup']]);
      expect(new Set(binds.map((bind) => bind.claimToken)).size).toBe(2);
      expect(getUndeliveredMessages().some((message) => JSON.parse(message.content).text?.startsWith('Error:'))).toBe(
        false,
      );
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });
});

describe('poll-loop unbacked pending row parking (R1c)', () => {
  // Long explicit timeout: the silence assertions span multiple 1s poll
  // intervals, which would otherwise blow bun's 5s per-test default (a timeout
  // abandons the body mid-flight and leaks the still-running poll loop into
  // the next test's fresh DB).
  it(
    'parks unbacked rows before pre-task: one error log per park-set change, then silence; host-backed rows still process',
    async () => {
      insertChannelDestination('discord-park', 'chan-park');
      insertMessage(
        'unbacked-1',
        'chat',
        { sender: 'Ghost', text: 'pre-stamp row' },
        { platformId: 'chan-park', channelType: 'discord', messagingGroupId: 'mg-park', isGroup: 0 },
      );
      clearHostStamps('unbacked-1');

      const parkedEvents: Array<{ message_ids?: string[] }> = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        const line = typeof args[0] === 'string' ? args[0] : '';
        if (line.includes('unroutable_pending_rows_parked')) {
          const m = /(\{.*\})/.exec(line);
          if (m) {
            try {
              parkedEvents.push(JSON.parse(m[1]));
            } catch {
              /* ignore unparsable */
            }
          }
        }
        origError(...(args as []));
      };

      let preTaskCalls = 0;
      const provider = new ScriptedProvider(async function* () {
        yield { type: 'result', text: '<message to="discord-park">park test reply</message>' };
      });
      const controller = new AbortController();
      const loopPromise = runPollLoop({
        provider,
        providerName: 'test',
        cwd: '/tmp',
        signal: controller.signal,
        runPreTaskScripts: async (messages) => {
          preTaskCalls++;
          return { keep: messages, skipped: [] };
        },
      });

      try {
        // Set change 1: the initial unbacked row is parked — exactly one log.
        await waitFor(() => parkedEvents.length === 1, 4000);
        expect(parkedEvents[0].message_ids).toEqual(['unbacked-1']);

        // Silence across later polls with an unchanged park set, and the parked
        // row never reaches pre-task scripts (no 1/sec heartbeat burn).
        await sleep(2100);
        expect(parkedEvents).toHaveLength(1);
        expect(preTaskCalls).toBe(0);
        expect(provider.calls).toBe(0);

        // Set change 2: a second unbacked id appears → one more log line, then
        // silence again.
        insertMessage(
          'unbacked-2',
          'chat',
          { sender: 'Ghost', text: 'another pre-stamp row' },
          { platformId: 'chan-park', channelType: 'discord', messagingGroupId: 'mg-park', isGroup: 0 },
        );
        clearHostStamps('unbacked-2');
        await waitFor(() => parkedEvents.length === 2, 4000);
        await sleep(1300);
        expect(parkedEvents).toHaveLength(2);
        expect(preTaskCalls).toBe(0);
        expect(provider.calls).toBe(0);

        // Regression: a normal host-backed row on the same route still processes
        // while the parked rows stay pending.
        insertMessage(
          'backed-1',
          'chat',
          { sender: 'User', text: 'real message' },
          { platformId: 'chan-park', channelType: 'discord', messagingGroupId: 'mg-park', isGroup: 0 },
        );
        await waitFor(() => getAckStatus('backed-1') === 'completed', 4000);
        expect(provider.calls).toBe(1);
        expect(preTaskCalls).toBeGreaterThan(0);
        expect(getPendingMessages().map((m) => m.id).sort()).toEqual(['unbacked-1', 'unbacked-2']);
        expect(parkedEvents).toHaveLength(2);
      } finally {
        console.error = origError;
        controller.abort();
        await loopPromise.catch(() => {});
      }
    },
    30_000,
  );
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

  // Task 3 (R2 release path, V5 N2): the released row can be its OWN wake
  // trigger — after the host deletes an expired recovery ack, the row is plain
  // pending work again and may be the only due message on its route. The turn
  // it wakes must still get the pending recovery entry's context injected
  // (same scope keying as the different-trigger sibling above).
  it('injects pending recovery context when the released row itself is the wake trigger', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-1',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: 'mg-self',
      isGroup: 0,
    }).routeKey;
    const scope = recoveryScope(routeKey, 'mg-self', 0);

    // Seed a pending recovery entry that owns m-1 itself. Post-release state:
    // the host deleted m-1's recovery ack, so m-1 is pending and UN-acked, and
    // nothing else is due on the route.
    const now = new Date().toISOString();
    const seed: ProviderRecoveryEntry = {
      id: 'rec-self-1',
      status: 'pending',
      classification: 'terminal_interruption_accepted_unresolved',
      agentMessage: 'I was interrupted mid-turn and will resume this work.',
      fallbackUserMessage: 'I still have your earlier request.',
      originalTasks: [{ messageId: 'm-1', text: 'finish the interrupted request', timestamp: now }],
      acceptedUnresolvedInputs: [
        { inputId: 'in-self', messageIds: ['m-1'], prompt: 'finish the interrupted request' },
      ],
      pendingFollowups: [],
      priorProgress: [
        {
          messageOutId: 'mo-self',
          text: 'I had already sent the first draft.',
          source: 'provider_progress',
          timestamp: now,
        },
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

    // The released row: pending, un-acked, the ONLY due work on the route.
    insertMessage(
      'm-1',
      'chat',
      { sender: 'User', text: 'finish the interrupted request' },
      {
        platformId: 'chan-1',
        channelType: 'discord',
        messagingGroupId: 'mg-self',
        isGroup: 0,
      },
    );

    let seenPrompt = '';
    const provider = new ScriptedProvider(async function* (input) {
      seenPrompt = input.prompt;
      yield { type: 'init', continuation: 'sess-self-resume' };
      yield { type: 'result', text: '<message to="discord-current">Resumed and finished it.</message>' };
    });

    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getAckStatus('m-1') === 'completed', 3000);

    // The recovery context for the entry owning m-1 was injected into the very
    // turn that m-1 itself woke.
    expect(seenPrompt).toContain('<recovery>');
    expect(seenPrompt).toContain('finish the interrupted request');
    expect(seenPrompt).toContain('I had already sent the first draft.');

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

  // Pre-task handling runs before the exact final batch is claimed. A handler
  // crash therefore leaves the row naturally pending without provider input.
  it('pre-task script handling failure leaves rows unclaimed without a raw error', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(getAckStatus('pretask-fail')).toBeNull();
      expect(returnedToPending.has('pretask-fail')).toBe(false);
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
    stampHostInput(
      'scoped-cont-init',
      'in-host-scoped-cont-init',
      normalizeRoute('opencode', {
        platformId: 'chan-1',
        channelType: 'discord',
        threadId: null,
        messagingGroupId: 'mg-relay',
        isGroup: 0,
      }).routeKey,
    );
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
    stampHostInput(
      'scoped-cont-resume',
      'in-host-scoped-cont-resume',
      normalizeRoute('opencode', {
        platformId: 'chan-1',
        channelType: 'discord',
        threadId: null,
        messagingGroupId: 'mg-relay',
        isGroup: 0,
      }).routeKey,
    );
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

describe('provider finalization barriers', () => {
  it('keeps a completed Claude reply but retains correlation for clean whole-container recycle', async () => {
    insertMessage(
      'claude-normal-result-before-recycle',
      'chat',
      { sender: 'User', text: 'finish normally, then recycle safely' },
      { platformId: 'chan-claude-recycle', channelType: 'discord', hostProviderName: 'claude' },
    );
    insertChannelDestination('discord-current', 'chan-claude-recycle');
    let releaseCalls = 0;
    let abortCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: true,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {
            abortCalls++;
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'claude-session-after-recycle' };
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            yield {
              type: 'result',
              text: '<message to="discord-current">Finished safely.</message>',
              resolvedInputIds: [input.inputId],
            };
            throw new ProviderContainerStopRequired(
              'Claude clean completion requires host-confirmed whole-container stop',
            );
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'claude',
      cwd: '/tmp',
      signal: controller.signal,
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });
    void loopPromise.catch(() => {});

    await waitFor(
      () =>
        getAckStatus('claude-normal-result-before-recycle') === 'completed' &&
        getContinuation('claude') === 'claude-session-after-recycle',
      1500,
    );
    await expect(loopPromise).rejects.toBeInstanceOf(ProviderContainerStopRequired);
    expect(abortCalls).toBe(0);
    expect(releaseCalls).toBe(0);
    expect(getAckStatus('claude-normal-result-before-recycle')).toBe('completed');
    expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toContain('Finished safely.');
    expect(
      listRecoveryEntries({
        providerName: 'claude',
        routeKey: normalizeRoute('claude', {
          platformId: 'chan-claude-recycle',
          channelType: 'discord',
          threadId: null,
          messagingGroupId: null,
          isGroup: null,
        }).routeKey,
      }),
    ).toHaveLength(0);
  });

  it('keeps a bound input live until the provider abort promise proves quiescence', async () => {
    insertMessage(
      'quiescence-init',
      'chat',
      { sender: 'User', text: 'run a paused GWS tool' },
      { platformId: 'chan-quiescence', channelType: 'discord' },
    );
    const streamEnded = deferred();
    const providerQuiescent = deferred();
    const abortCalled = deferred();
    let releaseCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {
            abortCalled.resolve();
            streamEnded.resolve();
            return providerQuiescent.promise;
          },
          events: (async function* () {
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            await streamEnded.promise;
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
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });

    await waitFor(() => getAckStatus('quiescence-init') === 'processing', 1500);
    controller.abort();
    await abortCalled.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(releaseCalls).toBe(0);

    providerQuiescent.resolve();
    await loopPromise;
    expect(releaseCalls).toBe(1);
    expect(getAckStatus('quiescence-init')).toBe('recovery');
  });

  it('exits fatally and retains correlation when provider quiescence cannot be proved', async () => {
    insertMessage(
      'quiescence-failed-init',
      'chat',
      { sender: 'User', text: 'run a tool that cannot prove it stopped' },
      { platformId: 'chan-quiescence-failed', channelType: 'discord' },
    );
    const streamEnded = deferred();
    let releaseCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {
            streamEnded.resolve();
            return Promise.reject(new ProviderQuiescenceError('tool callback remained active'));
          },
          events: (async function* () {
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            await streamEnded.promise;
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
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });

    await waitFor(() => getAckStatus('quiescence-failed-init') === 'processing', 1500);
    controller.abort();
    await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    expect(releaseCalls).toBe(0);
    expect(getAckStatus('quiescence-failed-init')).toBe('recovery');
  });

  it('retains correlation when clean-EOF Codex teardown leaves a real descendant alive', async () => {
    insertMessage(
      'codex-descendant-quiescence-failed',
      'chat',
      { sender: 'User', text: 'run a tool in a descendant process' },
      { platformId: 'chan-codex-descendant', channelType: 'discord' },
    );
    const tree = await spawnCodexTestProcessTree('graceful-unreaped');
    const streamEnded = deferred();
    let releaseCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort() {
            streamEnded.resolve();
            return terminateCodexAppServer(tree.server, {
              gracefulShutdownMs: 250,
              termExitMs: 150,
              killExitMs: 250,
            });
          },
          events: (async function* () {
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            await streamEnded.promise;
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
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });
    try {
      await waitFor(() => getAckStatus('codex-descendant-quiescence-failed') === 'processing', 1500);
      controller.abort();
      await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
      expect(isProcessAlive(tree.descendantPid)).toBe(true);
      expect(releaseCalls).toBe(0);
      expect(getAckStatus('codex-descendant-quiescence-failed')).toBe('recovery');
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
      await tree.cleanup();
    }
  });

  it('persists a resolved Codex continuation but exits for host recycle when clean teardown lacks tree proof', async () => {
    insertMessage(
      'codex-normal-result-before-recycle',
      'chat',
      { sender: 'User', text: 'finish normally, then recycle safely' },
      { platformId: 'chan-codex-recycle', channelType: 'discord', hostProviderName: 'codex' },
    );
    insertChannelDestination('discord-current', 'chan-codex-recycle');
    const tree = await spawnCodexTestProcessTree('graceful-unreaped');
    let releaseCalls = 0;
    let termination: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      termination ??= terminateCodexAppServer(tree.server, {
        gracefulShutdownMs: 250,
        termExitMs: 100,
        killExitMs: 250,
      });
      return termination;
    };
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(input) {
        return {
          push() {},
          end() {},
          abort: terminate,
          events: (async function* () {
            yield { type: 'init', continuation: 'codex-thread-after-recycle' };
            yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
            yield {
              type: 'result',
              text: '<message to="discord-current">Finished.</message>',
              resolvedInputIds: [input.inputId!],
            };
            await terminate();
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'codex',
      cwd: '/tmp',
      signal: controller.signal,
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });
    // The normal result and fatal teardown can complete in the same microtask
    // turn; observe rejection immediately while the assertions wait on the DB.
    void loopPromise.catch(() => {});

    try {
      await waitFor(
        () =>
          getAckStatus('codex-normal-result-before-recycle') === 'completed' &&
          getContinuation('codex') === 'codex-thread-after-recycle',
        1500,
      );
      controller.abort();
      await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
      expect(isProcessAlive(tree.descendantPid)).toBe(true);
      expect(releaseCalls).toBe(0);
      expect(getAckStatus('codex-normal-result-before-recycle')).toBe('completed');
      expect(getContinuation('codex')).toBe('codex-thread-after-recycle');
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
      await tree.cleanup();
    }
  });

  it('makes response loss after host acceptance a fatal recovery-owned lifecycle fault', async () => {
    insertMessage(
      'ambiguous-bind-init',
      'chat',
      { sender: 'User', text: 'draft once' },
      { platformId: 'chan-ambiguous-bind', channelType: 'discord' },
    );
    let bindCalls = 0;
    let releaseCalls = 0;
    const provider = new ScriptedProvider(async function* () {
      throw new Error('provider must never run after ambiguous bind');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      bindGwsCorrelation: async () => {
        bindCalls++;
        throw new GwsCorrelationLifecycleFault('authenticated response dropped after host commit');
      },
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });

    const settled = await Promise.race([
      loopPromise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 350)),
    ]);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(settled).toBe('rejected');
    expect(bindCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(getAckStatus('ambiguous-bind-init')).toBe('recovery');
    expect(getPendingMessages().map((message) => message.id)).not.toContain('ambiguous-bind-init');
    const route = normalizeRoute('test', {
      platformId: 'chan-ambiguous-bind',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: null,
      isGroup: null,
    }).routeKey;
    expect(
      listRecoveryEntries({
        providerName: 'test',
        routeKey: route,
        messagingGroupId: null,
        isGroup: null,
        platformId: 'chan-ambiguous-bind',
        channelType: 'discord',
        threadKey: null,
      })[0]?.classification,
    ).toBe('trusted_acceptance_ambiguous');
  });

  it('always awaits provider abort after a raw stream failure with a host-committed bind and never releases on failed quiescence', async () => {
    // Pins the POST-COMMIT branch: through the gated wrapper the DEFAULT no-op
    // bind SUCCEEDS before the stream failure, so boundGwsInputs is nonempty
    // (host-committed) and the failed quiescence proof stays fatal and
    // recovery-owned. The raw-stream-failure shape with NOTHING committed now
    // continues gracefully instead — see the pre-accept test below.
    insertMessage(
      'stream-failure-quiescence-init',
      'chat',
      { sender: 'User', text: 'run once' },
      { platformId: 'chan-stream-failure-quiescence', channelType: 'discord' },
    );
    let abortCalls = 0;
    let releaseCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        return {
          push() {},
          end() {},
          abort: async () => {
            abortCalls++;
            throw new ProviderQuiescenceError('OpenCode teardown remained uncertain');
          },
          events: (async function* () {
            throw new Error('OpenCode SSE stream failed');
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
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });

    const settled = await Promise.race([
      loopPromise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 350)),
    ]);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(settled).toBe('rejected');
    expect(abortCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(getAckStatus('stream-failure-quiescence-init')).toBe('recovery');
  });

  it('continues gracefully when a pre-accept bind failure coincides with a rejecting abort (nothing host-committed)', async () => {
    insertMessage(
      'preaccept-unmask-init',
      'chat',
      { sender: 'User', text: 'run once' },
      { platformId: 'chan-preaccept-unmask', channelType: 'discord' },
    );
    let abortCalls = 0;
    let bindCalls = 0;
    let releaseCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        return {
          push() {},
          end() {},
          abort: async () => {
            abortCalls++;
            throw new ProviderQuiescenceError('post-spawn teardown quiescence unproven');
          },
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            // Never reached: the gated wrapper's acceptInput() rejects first.
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
      bindGwsCorrelation: async () => {
        bindCalls++;
        throw new Error('host bind unavailable');
      },
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });
    // Observe rejection immediately: bun:test attributes an unhandled loop
    // rejection to the running test (the pattern the ~4352 test uses).
    void loopPromise.catch(() => {});
    const settled = await Promise.race([
      loopPromise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 350)),
    ]);
    expect(settled).toBe('timeout'); // graceful continuation — the loop did NOT die on the abort rejection
    expect(bindCalls).toBeGreaterThanOrEqual(1);
    expect(abortCalls).toBe(1);
    expect(releaseCalls).toBe(0); // never release on failed quiescence — invariant unchanged
    expect(getAckStatus('preaccept-unmask-init')).not.toBe('recovery'); // returned to pending, NOT recovery-owned
    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('still exits fatally when a body error follows a host-committed bind (echo missing) and abort rejects', async () => {
    insertMessage(
      'postcommit-quiescence-init',
      'chat',
      { sender: 'User', text: 'run once' },
      { platformId: 'chan-postcommit-quiescence', channelType: 'discord' },
    );
    let bindCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        return {
          push() {},
          end() {},
          abort: async () => {
            throw new ProviderQuiescenceError('abort quiescence unproven');
          },
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            // The gated wrapper already awaited acceptInput() (bind committed).
            // Fail BEFORE any input-accepted echo: acceptanceObserved stays
            // false while boundGwsInputs is nonempty (falsified A11).
            throw new Error('stream died after the host commit');
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
      bindGwsCorrelation: async () => {
        bindCalls++;
      },
      releaseGwsCorrelation: async () => {},
    });
    void loopPromise.catch(() => {});
    await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    expect(bindCalls).toBe(1);
    expect(getAckStatus('postcommit-quiescence-init')).toBe('recovery'); // accepted work stays recovery-owned (A7)
    controller.abort();
  });

  it('persists a bounded pre-accept retry schedule before a fatal quiescence exit', async () => {
    insertMessage(
      'preaccept-quiescence-schedule-init',
      'chat',
      { sender: 'User', text: 'fail teardown before any acceptance' },
      { platformId: 'chan-preaccept-quiescence-schedule', channelType: 'discord' },
    );
    // The gated runPollLoop wrapper host-commits via its default succeeding
    // bind (its events iterator awaits acceptInput() first), which the guard
    // must treat as no-schedule -- so run the loop via runProductionPollLoop
    // DIRECTLY with explicit no-op bindGwsCorrelation/releaseGwsCorrelation
    // and this RAW provider, whose event stream rejects with
    // ProviderQuiescenceError BEFORE acceptInput is ever called -- so nothing
    // is observed AND nothing is host-committed (boundGwsInputs stays empty).
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(_input) {
        return {
          push() {},
          end() {},
          abort: async () => {},
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            throw new ProviderQuiescenceError('teardown failed before any acceptance');
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runProductionPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      bindGwsCorrelation: async () => {},
      releaseGwsCorrelation: async () => {},
    });
    void loopPromise.catch(() => {});
    await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    // NEW: the durable schedule exists for the next runner incarnation.
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-preaccept-quiescence-schedule',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: null,
      isGroup: null,
    }).routeKey;
    const schedule = readProviderRetrySchedule('test', routeKey);
    expect(schedule?.attempts).toBe(1);
    expect(schedule?.status).toBe('scheduled');
    controller.abort();
  });

  it('does NOT persist a retry schedule when the bind host-committed (echo missing) before the quiescence exit', async () => {
    insertMessage(
      'postcommit-quiescence-no-schedule-init',
      'chat',
      { sender: 'User', text: 'run once' },
      { platformId: 'chan-postcommit-quiescence-no-schedule', channelType: 'discord' },
    );
    // The falsified-A11 shape: gated runPollLoop wrapper, default succeeding
    // bind, events throw a plain Error before any input-accepted echo, abort
    // rejects ProviderQuiescenceError. The loop still exits fatally
    // (host-committed work stays fatal) and the rows are recovery-owned --
    // the guard must not add a duplicate-work schedule.
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        return {
          push() {},
          end() {},
          abort: async () => {
            throw new ProviderQuiescenceError('abort quiescence unproven');
          },
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            // The gated wrapper already awaited acceptInput() (bind committed).
            // Fail BEFORE any input-accepted echo: acceptanceObserved stays
            // false while boundGwsInputs is nonempty.
            throw new Error('stream died after the host commit');
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });
    void loopPromise.catch(() => {});
    await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-postcommit-quiescence-no-schedule',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: null,
      isGroup: null,
    }).routeKey;
    expect(readProviderRetrySchedule('test', routeKey)).toBeUndefined();
    controller.abort();
  });

  it('durably backs off a provider failure before input-accepted and emits one bounded user error', async () => {
    insertMessage(
      'preaccept-backoff-init',
      'chat',
      { sender: 'User', text: 'retry safely' },
      { platformId: 'chan-preaccept-backoff', channelType: 'discord' },
    );
    let attempts = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        attempts++;
        return {
          push() {},
          end() {},
          abort() {},
          events: (async function* () {
            throw new Error('pre-accept transport failed');
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => attempts >= 1, 1500);
    // The durable retry fires once after 1s, then backs off to 2s. Neither the
    // retry nor a process restart may repeat the user-facing error for this
    // retry series.
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const surfaced = getUndeliveredMessages().filter((message) =>
      message.content.includes('pre-accept transport failed'),
    );
    const retryRows = getOutboundDb()
      .prepare("SELECT value FROM session_state WHERE key LIKE 'provider_retry:%'")
      .all() as Array<{ value: string }>;

    expect(attempts).toBe(2);
    expect(surfaced).toHaveLength(1);
    expect(getAckStatus('preaccept-backoff-init')).toBeNull();
    expect(getPendingMessages().map((message) => message.id)).toContain('preaccept-backoff-init');
    expect(retryRows).toHaveLength(1);
    expect(Date.parse((JSON.parse(retryRows[0].value) as { nextAttemptAt: string }).nextAttemptAt)).toBeGreaterThan(
      Date.now(),
    );

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('exhausts the tenth pre-accept attempt into recovery and never makes an eleventh automatic call', async () => {
    insertMessage(
      'preaccept-cap-init',
      'chat',
      { sender: 'User', text: 'retry at most ten times' },
      { platformId: 'chan-preaccept-cap', channelType: 'discord' },
    );
    const routeKey = normalizeRoute('test', {
      platformId: 'chan-preaccept-cap',
      channelType: 'discord',
      threadId: null,
      messagingGroupId: null,
      isGroup: null,
    }).routeKey;
    const oldNow = Date.now() - 120_000;
    for (let attempt = 0; attempt < 9; attempt++) {
      scheduleProviderRetry('test', routeKey, oldNow);
    }

    let now = Date.now();
    const dateNow = spyOn(Date, 'now').mockImplementation(() => now);
    let attempts = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        attempts++;
        return {
          push() {},
          end() {},
          abort: async () => {},
          events: (async function* () {
            throw new Error('pre-accept retry cap failure');
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    try {
      await waitFor(() => {
        const row = getOutboundDb()
          .prepare("SELECT value FROM session_state WHERE key LIKE 'provider_retry:%'")
          .get() as { value?: string } | undefined;
        return Boolean(row?.value && (JSON.parse(row.value) as { attempts?: number }).attempts === 10);
      }, 1500);
      now += 120_000;
      await new Promise((resolve) => setTimeout(resolve, 750));

      const retryRow = getOutboundDb()
        .prepare("SELECT value FROM session_state WHERE key LIKE 'provider_retry:%'")
        .get() as { value: string };
      const retry = JSON.parse(retryRow.value) as {
        attempts: number;
        status?: string;
        nextAttemptAt?: string;
      };
      const surfaced = getUndeliveredMessages().filter((message) =>
        message.content.includes('pre-accept retry cap failure'),
      );

      expect(attempts).toBe(1);
      expect(retry).toMatchObject({ attempts: 10, status: 'exhausted' });
      expect(retry.nextAttemptAt).toBeUndefined();
      expect(surfaced).toHaveLength(1);
      expect(getAckStatus('preaccept-cap-init')).toBe('recovery');
      expect(getPendingMessages().map((message) => message.id)).not.toContain('preaccept-cap-init');
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
      dateNow.mockRestore();
    }
  });
});

describe('poll-loop post-accept provider error surfacing', () => {
  it('sanitizes secret-shaped tokens in the post-accept error surfaced to the user', async () => {
    insertMessage(
      'postaccept-sanitize-init',
      'chat',
      { sender: 'User', text: 'do work' },
      { platformId: 'chan-postaccept-sanitize', channelType: 'discord' },
    );
    // Throws AFTER init (the ScriptedProvider adapter emits input-accepted
    // right after init), so this exercises the post-accept catch path.
    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'postaccept-sanitize-session' };
      throw new Error('provider auth failed for key sk-abc123def456ghi789');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getUndeliveredMessages().some((message) => message.content.includes('Error:')), 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const errorRows = getUndeliveredMessages().filter((message) => message.content.includes('Error:'));
    expect(errorRows).toHaveLength(1);
    const text = (JSON.parse(errorRows[0].content) as { text: string }).text;
    expect(text).toContain('[redacted-key]');
    expect(text).not.toContain('sk-abc123def456ghi789');
    // Post-accept failure: the accepted row is recovery-owned, never completed.
    expect(getAckStatus('postaccept-sanitize-init')).toBe('recovery');
  });

  it('emits exactly one user-facing error row for consecutive identical failures in one turn', async () => {
    insertMessage(
      'postaccept-dedup-init',
      'chat',
      { sender: 'User', text: 'retry then fail again' },
      { platformId: 'chan-postaccept-dedup', channelType: 'discord' },
    );
    // Attempt 1 fails pre-accept (throws before any event), which schedules a
    // durable retry and emits the one allowed user-facing error. The retry
    // (attempt 2) is accepted, then fails post-accept with the IDENTICAL
    // error. The user must not receive a second error row for the same turn.
    let attempts = 0;
    const provider = new ScriptedProvider(async function* () {
      attempts++;
      if (attempts === 1) throw new Error('identical provider failure');
      yield { type: 'init', continuation: 'postaccept-dedup-session' };
      throw new Error('identical provider failure');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => attempts >= 2, 3000);
    await waitFor(() => getAckStatus('postaccept-dedup-init') === 'recovery', 2000);
    // Let the post-accept catch finish its (potential) duplicate write.
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    await loopPromise.catch(() => {});

    const surfaced = getUndeliveredMessages().filter((message) =>
      message.content.includes('identical provider failure'),
    );
    expect(surfaced).toHaveLength(1);
  });

  it('keeps the raw error message in the runner log while sanitizing the user-facing text', async () => {
    const errSpy = spyOn(console, 'error');
    insertMessage(
      'postaccept-log-init',
      'chat',
      { sender: 'User', text: 'log the raw error' },
      { platformId: 'chan-postaccept-log', channelType: 'discord' },
    );
    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'postaccept-log-session' };
      throw new Error('provider auth failed for key sk-abc123def456ghi789');
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getAckStatus('postaccept-log-init') === 'recovery', 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const rawLogged = errSpy.mock.calls.some((call) =>
      String(call[0]).includes('Query error: provider auth failed for key sk-abc123def456ghi789'),
    );
    expect(rawLogged).toBe(true);
    errSpy.mockRestore();
  });
});

describe('routeless-trigger reply routing', () => {
  // Host-owned table (src/db/session-db.ts INBOUND_SCHEMA); replicate the shape
  // the runner reads via getSessionRouting().
  function writeSessionRoutingRow(routing: {
    channelType: string | null;
    platformId: string | null;
    threadId: string | null;
    messagingGroupId?: string | null;
    isGroup?: 0 | 1 | null;
  }): void {
    const db = getInboundDb();
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT,
         messaging_group_id TEXT,
         is_group INTEGER
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id, messaging_group_id, is_group)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      routing.channelType,
      routing.platformId,
      routing.threadId,
      routing.messagingGroupId ?? null,
      routing.isGroup ?? null,
    );
  }

  function chatRowsOut(): Array<{
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    messaging_group_id: string | null;
    is_group: number | null;
    text: string;
  }> {
    return (
      getOutboundDb()
        .prepare(
          `SELECT platform_id, channel_type, thread_id, messaging_group_id, is_group, content
           FROM messages_out WHERE kind = 'chat' ORDER BY seq`,
        )
        .all() as Array<{
        platform_id: string | null;
        channel_type: string | null;
        thread_id: string | null;
        messaging_group_id: string | null;
        is_group: number | null;
        content: string;
      }>
    ).map((r) => ({ ...r, text: (JSON.parse(r.content) as { text?: string }).text ?? '' }));
  }

  it('inherits the session default thread when an a2a-triggered reply targets the session channel', async () => {
    // Regression: 2026-07-10 invoice-thread misroute. An injected a2a error row
    // (channel_type 'agent', no thread) triggered a turn; the agent's reply to
    // its own Discord destination was written thread-less and delivered to the
    // PARENT channel instead of the session's thread.
    insertChannelDestination('discord-current', 'chan-1');
    writeSessionRoutingRow({
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: 'discord:guild:chan-1:thread-42',
      messagingGroupId: 'mg-1',
      isGroup: 0,
    });
    insertMessage(
      'a2a-err-1',
      'chat',
      {
        sender: 'subagent',
        text: 'Error: agent completed without sending a user-visible response in this conversation.',
      },
      { channelType: 'agent', platformId: 'ag-test' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'result', text: '<message to="discord-current">resent answer</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getAckStatus('a2a-err-1') === 'completed', 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    const rows = chatRowsOut().filter((r) => r.text === 'resent answer');
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_id).toBe('chan-1');
    expect(rows[0].channel_type).toBe('discord');
    expect(rows[0].thread_id).toBe('discord:guild:chan-1:thread-42');
    expect(rows[0].messaging_group_id).toBe('mg-1');
    expect(rows[0].is_group).toBe(0);
  });

  it('keeps cross-destination sends thread-less for user-triggered turns', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    insertChannelDestination('discord-other', 'chan-2');
    writeSessionRoutingRow({
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: 'discord:guild:chan-1:thread-42',
      messagingGroupId: 'mg-1',
      isGroup: 0,
    });
    insertMessage(
      'user-msg-1',
      'chat-sdk',
      { sender: 'User', text: 'announce this elsewhere' },
      { channelType: 'discord', platformId: 'chan-1', threadId: 'discord:guild:chan-1:thread-42' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'result', text: '<message to="discord-other">announcement</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getAckStatus('user-msg-1') === 'completed', 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    const rows = chatRowsOut().filter((r) => r.text === 'announcement');
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_id).toBe('chan-2');
    expect(rows[0].thread_id).toBeNull();
    expect(rows[0].messaging_group_id).toBeNull();
  });

  it('leaves the reply thread-less when session routing does not match the destination', async () => {
    insertChannelDestination('discord-current', 'chan-1');
    writeSessionRoutingRow({
      channelType: 'discord',
      platformId: 'chan-9',
      threadId: 'discord:guild:chan-9:thread-7',
      messagingGroupId: 'mg-9',
      isGroup: 0,
    });
    insertMessage(
      'a2a-err-2',
      'chat',
      {
        sender: 'subagent',
        text: 'Error: agent completed without sending a user-visible response in this conversation.',
      },
      { channelType: 'agent', platformId: 'ag-test' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'result', text: '<message to="discord-current">mismatched</message>' };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoop({ provider, providerName: 'test', cwd: '/tmp', signal: controller.signal });

    await waitFor(() => getAckStatus('a2a-err-2') === 'completed', 1500);
    controller.abort();
    await loopPromise.catch(() => {});

    const rows = chatRowsOut().filter((r) => r.text === 'mismatched');
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBeNull();
  });
});
