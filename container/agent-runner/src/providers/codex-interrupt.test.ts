import { describe, it, expect } from 'bun:test';

import {
  type AppServer,
  type JsonRpcNotification,
  type JsonRpcResponse,
  interruptCodexTurn,
} from './codex-app-server.js';
import { type CodexAbortSignal, runOneTurn } from './codex.js';
import type { ProviderEvent } from './types.js';

type CapturedRequest = { id: number; method: string; params: Record<string, unknown> };

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeAppServer(): {
  server: AppServer;
  requests: CapturedRequest[];
  dispatchNotification: (method: string, params: Record<string, unknown>) => void;
  resolveRequest: (request: CapturedRequest, response?: Omit<JsonRpcResponse, 'id'>) => void;
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

  function resolveRequest(request: CapturedRequest, response: Omit<JsonRpcResponse, 'id'> = { result: {} }): void {
    const pending = server.pending as Map<
      number,
      { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
    >;
    const handler = pending.get(request.id);
    expect(handler).toBeDefined();
    pending.delete(request.id);
    handler!.resolve({ id: request.id, ...response });
  }

  return { server, requests, dispatchNotification, resolveRequest };
}

function makeAbortControl(): { signal: CodexAbortSignal; abort: () => void } {
  let aborted = false;
  const handlers = new Set<() => void>();
  return {
    signal: {
      isAborted: () => aborted,
      onAbort: (handler) => {
        handlers.add(handler);
        if (aborted) handler();
        return () => {
          handlers.delete(handler);
        };
      },
    },
    abort: () => {
      if (aborted) return;
      aborted = true;
      for (const handler of [...handlers]) handler();
    },
  };
}

async function collectEvents(gen: AsyncGenerator<ProviderEvent, boolean>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

function startFakeTurn(
  server: AppServer,
  abortSignal?: CodexAbortSignal,
): { started: Promise<void>; events: Promise<ProviderEvent[]> } {
  const started = makeDeferred<void>();
  const gen = runOneTurn(
    server,
    'thread-abc',
    'do long work',
    'gpt-5.5',
    '/workspace/agent',
    'input-123',
    () => true,
    () => {},
    {
      acceptInput: async () => {},
      abortSignal,
      startTurn: async () => {
        started.resolve();
      },
    },
  );

  return { started: started.promise, events: collectEvents(gen) };
}

describe('interruptCodexTurn', () => {
  it('sends the exact turn/interrupt request shape', async () => {
    const { server, requests, resolveRequest } = makeFakeAppServer();
    const promise = interruptCodexTurn(server, { threadId: 'thread-abc', turnId: 'turn-123' }, 1000);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('turn/interrupt');
    expect(requests[0].params).toEqual({ threadId: 'thread-abc', turnId: 'turn-123' });

    resolveRequest(requests[0]);
    await promise;
  });

  it('throws on Codex JSON-RPC error responses', async () => {
    const { server, requests, resolveRequest } = makeFakeAppServer();
    const promise = interruptCodexTurn(server, { threadId: 'thread-abc', turnId: 'turn-123' }, 1000);

    resolveRequest(requests[0], { error: { code: -32000, message: 'no active turn' } });

    await expect(promise).rejects.toThrow('turn/interrupt failed: no active turn');
  });
});

describe('runOneTurn Codex interrupt handling', () => {
  it('interrupts immediately when abort fires after turn/started', async () => {
    const { server, requests, dispatchNotification, resolveRequest } = makeFakeAppServer();
    const abort = makeAbortControl();
    const { started, events } = startFakeTurn(server, abort.signal);

    await started;
    dispatchNotification('turn/started', { threadId: 'thread-abc', turn: { id: 'turn-123' } });
    abort.abort();

    await waitFor(() => requests.length === 1, 'turn/interrupt request');
    expect(requests[0].method).toBe('turn/interrupt');
    expect(requests[0].params).toEqual({ threadId: 'thread-abc', turnId: 'turn-123' });

    resolveRequest(requests[0]);
    dispatchNotification('turn/completed', {
      threadId: 'thread-abc',
      turn: { id: 'turn-123', status: 'interrupted' },
    });

    const collected = await withTimeout(events, 'interrupted turn events');
    expect(collected.some((event) => event.type === 'result')).toBe(false);
    expect(collected.find((event) => event.type === 'interruption')).toMatchObject({
      type: 'interruption',
      inputId: 'input-123',
      classification: 'codex_turn_interrupted',
      terminal: true,
    });
  });

  it('defers interrupt until turn/started when abort wins the turn-id race', async () => {
    const { server, requests, dispatchNotification, resolveRequest } = makeFakeAppServer();
    const abort = makeAbortControl();
    const { started, events } = startFakeTurn(server, abort.signal);

    await started;
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);

    dispatchNotification('turn/started', { threadId: 'thread-abc', turn: { id: 'turn-late' } });
    await waitFor(() => requests.length === 1, 'deferred turn/interrupt request');
    expect(requests[0].params).toEqual({ threadId: 'thread-abc', turnId: 'turn-late' });

    resolveRequest(requests[0]);
    dispatchNotification('turn/completed', {
      threadId: 'thread-abc',
      turn: { id: 'turn-late', status: 'interrupted' },
    });

    const collected = await withTimeout(events, 'deferred interrupted turn events');
    expect(collected.find((event) => event.type === 'interruption')).toMatchObject({
      type: 'interruption',
      classification: 'codex_turn_interrupted',
      terminal: true,
    });
  });

  it('treats turn/completed status=interrupted as terminal instead of a successful result', async () => {
    const { server, requests, dispatchNotification } = makeFakeAppServer();
    const { started, events } = startFakeTurn(server);

    await started;
    dispatchNotification('turn/started', { threadId: 'thread-abc', turn: { id: 'turn-plain' } });
    dispatchNotification('turn/completed', {
      threadId: 'thread-abc',
      turn: { id: 'turn-plain', status: 'interrupted' },
    });

    const collected = await withTimeout(events, 'plain interrupted turn events');
    expect(requests).toHaveLength(0);
    expect(collected.some((event) => event.type === 'result')).toBe(false);
    expect(collected.find((event) => event.type === 'interruption')).toMatchObject({
      type: 'interruption',
      inputId: 'input-123',
      classification: 'codex_turn_interrupted',
      terminal: true,
    });
  });

  it('treats abort-related turn/failed as an interruption shape', async () => {
    const { server, requests, dispatchNotification, resolveRequest } = makeFakeAppServer();
    const abort = makeAbortControl();
    const { started, events } = startFakeTurn(server, abort.signal);

    await started;
    dispatchNotification('turn/started', { threadId: 'thread-abc', turn: { id: 'turn-failed-after-stop' } });
    abort.abort();

    await waitFor(() => requests.length === 1, 'turn/interrupt request before failed notification');
    resolveRequest(requests[0]);
    dispatchNotification('turn/failed', {
      threadId: 'thread-abc',
      turnId: 'turn-failed-after-stop',
      error: { message: 'interrupted by user' },
    });

    const collected = await withTimeout(events, 'abort-related failed turn events');
    expect(collected.some((event) => event.type === 'result')).toBe(false);
    expect(collected.find((event) => event.type === 'interruption')).toMatchObject({
      type: 'interruption',
      inputId: 'input-123',
      classification: 'codex_turn_interrupted',
      terminal: true,
    });
  });

  it('terminates promptly after a successful interrupt with no terminal event and waits for process exit', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const abort = makeAbortControl();
    const started = makeDeferred<void>();
    const terminationStarted = makeDeferred<void>();
    const processExited = makeDeferred<void>();
    const gen = runOneTurn(
      server,
      'thread-abc',
      'do long work',
      'gpt-5.5',
      '/workspace/agent',
      'input-no-terminal',
      () => true,
      () => {},
      {
        acceptInput: async () => {},
        abortSignal: abort.signal,
        startTurn: async () => {
          started.resolve();
        },
        interruptTurn: async () => {},
        abortGraceMs: 20,
        terminateServer: async () => {
          terminationStarted.resolve();
          await processExited.promise;
        },
      },
    );
    let settled = false;
    const events = collectEvents(gen).then((value) => {
      settled = true;
      return value;
    });

    await started.promise;
    dispatchNotification('turn/started', { threadId: 'thread-abc', turn: { id: 'turn-no-terminal' } });
    abort.abort();
    await withTimeout(terminationStarted.promise, 'bounded forced termination');
    expect(settled).toBe(false);

    processExited.resolve();
    const collected = await withTimeout(events, 'forced-termination interrupted events');
    expect(collected.find((event) => event.type === 'interruption')).toMatchObject({
      type: 'interruption',
      inputId: 'input-no-terminal',
      classification: 'codex_turn_interrupted',
      terminal: true,
    });
  });
});
