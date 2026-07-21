import { describe, it, expect } from 'bun:test';
import { type AppServer, type JsonRpcNotification } from './codex-app-server.js';
import { buildCompactResultText, COMPACT_RESULT_TEXT, compactCodexThread, isCompactCommand } from './codex.js';
import type { MessageInRow } from '../db/messages-in.js';

function makeMessageRow(text: string): MessageInRow {
  return {
    id: 'msg-1',
    seq: 1,
    kind: 'chat',
    timestamp: '2026-06-16T01:20:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'plat-1',
    platform_message_id: null,
    channel_type: 'discord',
    thread_id: null,
    messaging_group_id: null,
    is_group: 0,
    content: JSON.stringify({ text, senderId: '123', sender: 'DanS' }),
  } as MessageInRow;
}

type CapturedRequest = { id: number; method: string; params: Record<string, unknown> };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeFakeAppServer(): {
  server: AppServer;
  requests: CapturedRequest[];
  dispatchNotification: (method: string, params: Record<string, unknown>) => void;
  resolveAll: () => void;
} {
  const requests: CapturedRequest[] = [];
  const server = {
    process: {
      stdin: {
        write(line: string) {
          const req = JSON.parse(line) as CapturedRequest;
          requests.push(req);
          return true;
        },
      },
    },
    readline: { close() {} },
    pending: new Map(),
    notificationHandlers: [] as ((n: JsonRpcNotification) => void)[],
    serverRequestHandlers: [],
  } as unknown as AppServer;

  function resolveAll() {
    for (const req of requests) {
      const pending = server.pending as Map<
        number,
        { resolve: (r: { id: number; result?: unknown }) => void; reject: (e: Error) => void }
      >;
      const handler = pending.get(req.id);
      if (handler) {
        handler.resolve({ id: req.id, result: {} });
      }
    }
  }

  function dispatchNotification(method: string, params: Record<string, unknown>): void {
    for (const h of server.notificationHandlers) {
      h({ jsonrpc: '2.0', method, params } as JsonRpcNotification);
    }
  }

  return { server, requests, dispatchNotification, resolveAll };
}

describe('isCompactCommand', () => {
  it('recognizes a single /compact chat message', () => {
    const rows = [makeMessageRow('/compact')];
    expect(isCompactCommand(rows)).toBe(true);
  });

  it('recognizes a single /compact message with odd casing', () => {
    const rows = [makeMessageRow('/Compact')];
    expect(isCompactCommand(rows)).toBe(true);
  });

  it('rejects /compact with extra text', () => {
    const rows = [makeMessageRow('/compact something')];
    expect(isCompactCommand(rows)).toBe(false);
  });

  it('requires exactly one chat message', () => {
    expect(isCompactCommand(undefined)).toBe(false);
    expect(isCompactCommand([])).toBe(false);
    expect(isCompactCommand([makeMessageRow('/compact'), makeMessageRow('hi')])).toBe(false);
  });

  it('rejects non-chat messages', () => {
    const row: MessageInRow = { ...makeMessageRow('/compact'), kind: 'system' };
    expect(isCompactCommand([row])).toBe(false);
  });
});

describe('buildCompactResultText', () => {
  it('wraps the reply in a destination block when a name is given', () => {
    expect(buildCompactResultText('discord-current')).toBe(
      '<message to="discord-current">Context compacted.</message>',
    );
  });

  it('returns plain text when no destination is known', () => {
    expect(buildCompactResultText(undefined)).toBe('Context compacted.');
  });
});

async function drainCompactGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

function contextCompactionItem(id = 'ctx-compact-1'): { type: 'contextCompaction'; id: string } {
  return { type: 'contextCompaction', id };
}

describe('compactCodexThread', () => {
  it('does not send a compact RPC when cancellation lands during the trusted bind', async () => {
    const { server, requests } = makeFakeAppServer();
    const gate = deferred<void>();
    let aborted = false;
    const gen = compactCodexThread(
      server,
      'thread-cancelled-bind',
      'input-cancelled-bind',
      undefined,
      { now: () => Date.now() },
      'initial',
      () => gate.promise,
      { isAborted: () => aborted, onAbort: () => () => {} },
    );
    const collected = drainCompactGenerator(gen);

    await Promise.resolve();
    aborted = true;
    gate.resolve();

    await expect(collected).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('rechecks cancellation after the compact acceptance callback and before the RPC', async () => {
    const { server, requests } = makeFakeAppServer();
    let aborted = false;
    const gen = compactCodexThread(
      server,
      'thread-cancelled-callback',
      'input-cancelled-callback',
      undefined,
      { now: () => Date.now() },
      'initial',
      async () => {
        aborted = true;
      },
      { isAborted: () => aborted, onAbort: () => () => {} },
    );

    await expect(drainCompactGenerator(gen)).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('cancels promptly after compact submission without falling back to a normal turn', async () => {
    const { server, requests } = makeFakeAppServer();
    let aborted = false;
    const handlers = new Set<() => void>();
    const gen = compactCodexThread(
      server,
      'thread-cancelled-after-submit',
      'input-cancelled-after-submit',
      undefined,
      { now: () => Date.now() },
      'initial',
      async () => {},
      {
        isAborted: () => aborted,
        onAbort: (handler) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      },
    );

    await expect(gen.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'input-accepted', inputId: 'input-cancelled-after-submit' },
    });
    const rest = drainCompactGenerator(gen);
    aborted = true;
    for (const handler of handlers) handler();

    const settled = await Promise.race([
      rest.then((events) => ({ kind: 'done' as const, events })),
      new Promise<{ kind: 'timeout'; events: [] }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout', events: [] }), 100),
      ),
    ]);
    expect(settled.kind).toBe('done');
    expect(settled.events.some((event) => event.type === 'result')).toBe(false);
    expect(requests.map((request) => request.method)).toEqual(['thread/compact/start']);
  });

  it('emits progress + result after item/completed with a contextCompaction item', async () => {
    const { server, requests, dispatchNotification, resolveAll } = makeFakeAppServer();
    const clock = { now: () => Date.now() };
    const gen = compactCodexThread(
      server,
      'thread-abc',
      'input-xyz',
      'discord-current',
      clock,
      'initial',
      async () => {},
    );
    const collectPromise = drainCompactGenerator(gen);

    await new Promise((r) => setTimeout(r, 10));
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe('thread/compact/start');
    expect(requests[0].params).toEqual({ threadId: 'thread-abc' });

    resolveAll();
    await new Promise((r) => setTimeout(r, 10));
    dispatchNotification('item/completed', {
      threadId: 'thread-abc',
      turnId: 'turn-1',
      item: contextCompactionItem(),
    });

    const events = await collectPromise;
    expect(events).toEqual([
      { type: 'input-accepted', inputId: 'input-xyz', scope: 'initial' },
      { type: 'activity' },
      { type: 'progress', inputId: 'input-xyz', message: COMPACT_RESULT_TEXT },
      {
        type: 'result',
        text: buildCompactResultText('discord-current'),
        inputId: 'input-xyz',
        resolvedInputIds: ['input-xyz'],
      },
    ]);
  });

  it('emits progress + result after turn/completed containing a contextCompaction item', async () => {
    const { server, requests, dispatchNotification, resolveAll } = makeFakeAppServer();
    const clock = { now: () => Date.now() };
    const gen = compactCodexThread(
      server,
      'thread-abc',
      'input-xyz',
      'discord-current',
      clock,
      'initial',
      async () => {},
    );
    const collectPromise = drainCompactGenerator(gen);

    await new Promise((r) => setTimeout(r, 10));
    resolveAll();
    await new Promise((r) => setTimeout(r, 10));
    dispatchNotification('turn/completed', {
      threadId: 'thread-abc',
      turn: {
        id: 'turn-1',
        items: [contextCompactionItem()],
      },
    });

    const events = await collectPromise;
    expect(events).toEqual([
      { type: 'input-accepted', inputId: 'input-xyz', scope: 'initial' },
      { type: 'activity' },
      { type: 'progress', inputId: 'input-xyz', message: COMPACT_RESULT_TEXT },
      {
        type: 'result',
        text: buildCompactResultText('discord-current'),
        inputId: 'input-xyz',
        resolvedInputIds: ['input-xyz'],
      },
    ]);
  });

  it('still accepts the legacy thread/compacted notification', async () => {
    const { server, requests, dispatchNotification, resolveAll } = makeFakeAppServer();
    const clock = { now: () => Date.now() };
    const gen = compactCodexThread(server, 'thread-legacy', 'input-uvw', undefined, clock, 'initial', async () => {});
    const collectPromise = drainCompactGenerator(gen);

    await new Promise((r) => setTimeout(r, 10));
    resolveAll();
    await new Promise((r) => setTimeout(r, 10));
    dispatchNotification('thread/compacted', { threadId: 'thread-legacy', turnId: 'turn-1' });

    const events = await collectPromise;
    expect(events).toEqual([
      { type: 'input-accepted', inputId: 'input-uvw', scope: 'initial' },
      { type: 'activity' },
      { type: 'progress', inputId: 'input-uvw', message: COMPACT_RESULT_TEXT },
      {
        type: 'result',
        text: buildCompactResultText(undefined),
        inputId: 'input-uvw',
        resolvedInputIds: ['input-uvw'],
      },
    ]);
  });

  it('throws when no compaction completion signal arrives in time', async () => {
    const { server, requests, resolveAll } = makeFakeAppServer();
    const start = Date.now();
    let clockCalls = 0;
    // Advance elapsed time past the 60,000ms notification budget, so the helper
    // sees a zero-ms timeout and throws before we have to wait on real timers.
    const fastClock = {
      now: () => {
        clockCalls += 1;
        return clockCalls === 1 ? start + 100 : start + 70_000;
      },
    };
    const gen = compactCodexThread(server, 'thread-def', 'input-uvw', undefined, fastClock, 'initial', async () => {});
    const collectPromise = drainCompactGenerator(gen);

    await new Promise((r) => setTimeout(r, 10));
    expect(requests[0].method).toBe('thread/compact/start');
    resolveAll();

    await expect(collectPromise).rejects.toThrow('Timeout waiting for Codex compaction completion');
  });

  it('throws when Codex reports an explicit error notification', async () => {
    const { server, requests, dispatchNotification, resolveAll } = makeFakeAppServer();
    const clock = { now: () => Date.now() };
    const gen = compactCodexThread(
      server,
      'thread-err',
      'input-err',
      'discord-current',
      clock,
      'initial',
      async () => {},
    );
    const collectPromise = drainCompactGenerator(gen);

    await new Promise((r) => setTimeout(r, 10));
    resolveAll();
    await new Promise((r) => setTimeout(r, 10));
    dispatchNotification('error', {
      threadId: 'thread-err',
      turnId: 'turn-1',
      error: { message: 'compaction failed internally' },
      willRetry: false,
    });

    await expect(collectPromise).rejects.toThrow('compaction failed internally');
  });
});
