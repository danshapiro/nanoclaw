import { describe, it, expect } from 'bun:test';

import { type AppServer, type JsonRpcNotification } from './codex-app-server.js';
import { runOneTurn } from './codex.js';
import type { ProviderEvent } from './types.js';

type CapturedRequest = { id: number; method: string; params: Record<string, unknown> };
type ResultEvent = Extract<ProviderEvent, { type: 'result' }>;

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mirrors codex-interrupt.test.ts: a fake app-server whose notificationHandlers
// the turn subscribes to, plus a helper to push notifications synchronously.
function makeFakeAppServer(): {
  server: AppServer;
  requests: CapturedRequest[];
  dispatchNotification: (method: string, params: Record<string, unknown>) => void;
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

  function dispatchNotification(method: string, params: Record<string, unknown>): void {
    for (const h of [...server.notificationHandlers]) {
      h({ method, params } as JsonRpcNotification);
    }
  }

  return { server, requests, dispatchNotification };
}

async function collectEvents(gen: AsyncGenerator<ProviderEvent, boolean>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startFakeTurn(server: AppServer): { started: Promise<void>; events: Promise<ProviderEvent[]> } {
  const started = makeDeferred<void>();
  const gen = runOneTurn(
    server,
    'thread-abc',
    'do work',
    'gpt-5.5',
    '/workspace/agent',
    'input-123',
    () => true,
    () => {},
    {
      acceptInput: async () => {},
      startTurn: async () => {
        started.resolve();
      },
    },
  );
  return { started: started.promise, events: collectEvents(gen) };
}

function findResult(events: ProviderEvent[]): ResultEvent | undefined {
  return events.find((e): e is ResultEvent => e.type === 'result');
}

describe('runOneTurn provider-error surfacing', () => {
  it('binds before turn/start and preserves the accepted event when turn/start rejects', async () => {
    const { server } = makeFakeAppServer();
    const seen: ProviderEvent[] = [];
    const gen = runOneTurn(
      server,
      'thread-abc',
      'do work',
      'gpt-5.5',
      '/workspace/agent',
      'input-rejected',
      () => true,
      () => {},
      {
        acceptInput: async () => {},
        startTurn: async () => {
          throw new Error('turn/start rejected');
        },
      },
    );
    await expect(
      (async () => {
        for await (const event of gen) seen.push(event);
      })(),
    ).rejects.toThrow('turn/start rejected');
    expect(seen.some((event) => event.type === 'input-accepted')).toBe(true);
  });

  it('does not call turn/start before the exact acceptance gate resolves', async () => {
    const { server } = makeFakeAppServer();
    const gate = makeDeferred<void>();
    let startCalls = 0;
    const gen = runOneTurn(
      server,
      'thread-abc',
      'do work',
      'gpt-5.5',
      '/workspace/agent',
      'input-gated',
      () => true,
      () => {},
      {
        acceptInput: () => gate.promise,
        startTurn: async () => {
          startCalls++;
          throw new Error('stop after proof');
        },
      },
    );
    const first = gen.next();
    await Promise.resolve();
    expect(startCalls).toBe(0);
    gate.resolve();
    await expect(first).resolves.toMatchObject({ value: { type: 'input-accepted', inputId: 'input-gated' } });
    const second = gen.next();
    await expect(second).rejects.toThrow('stop after proof');
    expect(startCalls).toBe(1);
  });

  it('cancels the Codex turn when the trusted acceptance gate rejects', async () => {
    const { server } = makeFakeAppServer();
    let startCalls = 0;
    const gen = runOneTurn(
      server,
      'thread-abc',
      'do work',
      'gpt-5.5',
      '/workspace/agent',
      'input-rejected-gate',
      () => true,
      () => {},
      {
        acceptInput: async () => {
          throw new Error('host bind rejected');
        },
        startTurn: async () => {
          startCalls++;
        },
      },
    );
    await expect(gen.next()).rejects.toThrow('host bind rejected');
    expect(startCalls).toBe(0);
  });

  it('carries a top-level error notification verbatim on an empty turn', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events } = startFakeTurn(server);

    await started;
    dispatchNotification('error', {
      error: {
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:35 PM.",
      },
      willRetry: false,
      threadId: 'thread-abc',
      turnId: 't1',
    });
    dispatchNotification('turn/completed', { threadId: 'thread-abc', turn: { status: 'completed' } });

    const collected = await withTimeout(events, 'empty turn with top-level error');
    const result = findResult(collected);
    expect(result).toBeDefined();
    expect(result?.text).toBeNull();
    expect(result?.errorText).toContain('usage limit');
  });

  it('ignores a transient (willRetry) error and does not surface it', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events } = startFakeTurn(server);
    await started;
    dispatchNotification('error', {
      error: { message: 'temporary upstream blip' },
      willRetry: true,
      threadId: 'thread-abc',
      turnId: 't1',
    });
    dispatchNotification('turn/completed', { threadId: 'thread-abc', turn: { status: 'completed' } });
    const result = findResult(await withTimeout(events, 'transient error turn'));
    expect(result?.text).toBeNull();
    expect(result?.errorText).toBeUndefined();
  });

  it('carries a turn/completed failure reason verbatim on an empty turn', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events } = startFakeTurn(server);

    await started;
    dispatchNotification('turn/completed', {
      threadId: 'thread-abc',
      turn: { status: 'failed', error: { message: 'boom quota' } },
    });

    const collected = await withTimeout(events, 'empty turn with failure reason');
    const result = findResult(collected);
    expect(result).toBeDefined();
    expect(result?.text).toBeNull();
    expect(result?.errorText).toBe('boom quota');
  });

  it('leaves errorText undefined for a normal turn with agent text', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events } = startFakeTurn(server);

    await started;
    dispatchNotification('item/completed', {
      threadId: 'thread-abc',
      item: { type: 'agentMessage', text: 'hello' },
    });
    dispatchNotification('turn/completed', { threadId: 'thread-abc', turn: { status: 'completed' } });

    const collected = await withTimeout(events, 'normal turn events');
    const result = findResult(collected);
    expect(result).toBeDefined();
    expect(result?.text).toBe('hello');
    expect(result?.errorText).toBeUndefined();
  });

  it('drops errorText when the turn also produced agent text', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events } = startFakeTurn(server);
    await started;
    dispatchNotification('error', { error: { message: 'transient quota blip' } });
    dispatchNotification('item/completed', {
      threadId: 'thread-abc',
      item: { type: 'agentMessage', text: 'recovered answer' },
    });
    dispatchNotification('turn/completed', { threadId: 'thread-abc', turn: { status: 'completed' } });
    const result = findResult(await withTimeout(events, 'error-then-text turn'));
    expect(result?.text).toBe('recovered answer');
    expect(result?.errorText).toBeUndefined();
  });
});
