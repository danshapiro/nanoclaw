import { describe, it, expect } from 'bun:test';

import { type AppServer, type JsonRpcNotification } from './codex-app-server.js';
import { type CodexAbortSignal, runOneTurn } from './codex.js';
import type { ProviderEvent } from './types.js';

type CapturedRequest = { id: number; method: string; params: Record<string, unknown> };
type ResultEvent = Extract<ProviderEvent, { type: 'result' }>;

const MAIN_THREAD = 'thread-abc';
const SUB_THREAD = 'sub-1';

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mirrors codex-error-surfacing.test.ts: a fake app-server whose
// notificationHandlers the turn subscribes to, plus a helper to push
// notifications synchronously.
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
  interruptedTurnIds?: string[],
): { started: Promise<void>; events: Promise<ProviderEvent[]>; isDone: () => boolean } {
  const started = makeDeferred<void>();
  let done = false;
  const gen = runOneTurn(
    server,
    MAIN_THREAD,
    'do work',
    'gpt-5.5',
    '/workspace/agent',
    'input-123',
    () => true,
    () => {},
    {
      abortSignal,
      startTurn: async () => {
        started.resolve();
      },
      interruptTurn: async (_server, { turnId }) => {
        interruptedTurnIds?.push(turnId);
      },
    },
  );
  const events = collectEvents(gen).then((evs) => {
    done = true;
    return evs;
  });
  return { started: started.promise, events, isDone: () => done };
}

function findResult(events: ProviderEvent[]): ResultEvent | undefined {
  return events.find((e): e is ResultEvent => e.type === 'result');
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('runOneTurn subagent thread isolation', () => {
  it('ignores a foreign thread agentMessage + turn/completed; main turn stays open and unpolluted', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events, isDone } = startFakeTurn(server);
    await started;

    // Subagent thread produces its own answer and completes ITS turn.
    dispatchNotification('item/agentMessage/delta', { threadId: SUB_THREAD, delta: 'STOLEN-' });
    dispatchNotification('item/completed', {
      threadId: SUB_THREAD,
      item: { type: 'agentMessage', text: 'TOKEN' },
    });
    dispatchNotification('turn/completed', { threadId: SUB_THREAD, turn: { status: 'completed' } });

    // The MAIN turn must still be open — no result emission from subagent events.
    await settle();
    expect(isDone()).toBe(false);

    // Main thread then completes normally.
    dispatchNotification('item/completed', {
      threadId: MAIN_THREAD,
      item: { type: 'agentMessage', text: 'main answer' },
    });
    dispatchNotification('turn/completed', { threadId: MAIN_THREAD, turn: { status: 'completed' } });

    const collected = await withTimeout(events, 'main turn completion');
    const result = findResult(collected);
    expect(result).toBeDefined();
    // resultText unpolluted by the subagent's delta or agentMessage.
    expect(result?.text).toBe('main answer');
    expect(result?.errorText).toBeUndefined();
  });

  it('does not clobber activeTurnId with a foreign thread turn/started (interrupt targets the main turn)', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const control = makeAbortControl();
    const interruptedTurnIds: string[] = [];
    const { started, events } = startFakeTurn(server, control.signal, interruptedTurnIds);
    await started;

    dispatchNotification('turn/started', { threadId: MAIN_THREAD, turn: { id: 'turn-main' } });
    // Subagent thread starts its own turn — must NOT replace activeTurnId.
    dispatchNotification('turn/started', { threadId: SUB_THREAD, turn: { id: 'turn-sub' } });

    control.abort();
    await settle();
    expect(interruptedTurnIds).toEqual(['turn-main']);

    dispatchNotification('turn/completed', { threadId: MAIN_THREAD, turn: { status: 'interrupted' } });
    await withTimeout(events, 'interrupted main turn');
  });

  it('ignores turn/failed from a foreign thread; main turn completes without error', async () => {
    const { server, dispatchNotification } = makeFakeAppServer();
    const { started, events, isDone } = startFakeTurn(server);
    await started;

    dispatchNotification('turn/failed', { threadId: SUB_THREAD, error: { message: 'subagent boom' } });

    await settle();
    expect(isDone()).toBe(false);

    dispatchNotification('item/completed', {
      threadId: MAIN_THREAD,
      item: { type: 'agentMessage', text: 'still fine' },
    });
    dispatchNotification('turn/completed', { threadId: MAIN_THREAD, turn: { status: 'completed' } });

    const collected = await withTimeout(events, 'main turn after foreign failure');
    const result = findResult(collected);
    expect(result?.text).toBe('still fine');
    expect(result?.errorText).toBeUndefined();
  });
});
