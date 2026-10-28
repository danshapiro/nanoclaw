import { describe, expect, it } from 'bun:test';

import type { AppServer, JsonRpcNotification, JsonRpcResponse } from './codex-app-server.js';
import { CodexProvider } from './codex.js';
import type { ProviderEvent, QueryTurnInput } from './types.js';

type Request = { id: number; method: string; params: Record<string, unknown> };

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('Timed out waiting for provider request');
    await Bun.sleep(1);
  }
}

function harness() {
  const requests: Request[] = [];
  const events: ProviderEvent[] = [];
  let nextTurn = 0;
  let steerResponse: Omit<JsonRpcResponse, 'id'> | undefined;
  let holdStartResponse = false;
  const server = {
    process: {
      stdin: {
        write(line: string) {
          const req = JSON.parse(line) as Request;
          requests.push(req);
          queueMicrotask(() => {
            if (req.method === 'turn/start') {
              const id = `turn-${++nextTurn}`;
              notify('turn/started', { threadId: 'thread-main', turn: { id } });
              if (!holdStartResponse) respond(req, { result: { turn: { id } } });
            } else if (req.method === 'turn/steer') {
              respond(req, steerResponse ?? { result: { turnId: `turn-${nextTurn}` } });
            } else if (req.method === 'turn/interrupt') {
              respond(req, { result: {} });
              notify('turn/completed', {
                threadId: 'thread-main',
                turn: { id: `turn-${nextTurn}`, status: 'interrupted' },
              });
            }
          });
          return true;
        },
      },
    },
    pending: new Map(),
    notificationHandlers: [] as Array<(notification: JsonRpcNotification) => void>,
    serverRequestHandlers: [],
    readline: { close() {} },
  } as unknown as AppServer;
  function notify(method: string, params: Record<string, unknown>) {
    for (const handler of [...server.notificationHandlers]) handler({ method, params });
  }
  function respond(req: Request, response: Omit<JsonRpcResponse, 'id'>) {
    const pending = server.pending.get(req.id);
    if (!pending) return;
    server.pending.delete(req.id);
    pending.resolve({ id: req.id, ...response });
  }
  const provider = new CodexProvider(
    { env: { CODEX_MODEL: 'test-model' } },
    {
      syncManagedSkillLinks: () => [],
      writeMcpConfig: () => {},
      createConfigOverrides: () => [],
      spawnServer: () => server,
      attachAutoApproval: () => {},
      initializeServer: async () => {},
      startThread: async () => 'thread-main',
      terminateServer: async () => {},
    },
  );
  const query = provider.query({ inputId: 'initial', acceptInput: async () => {}, prompt: 'long task', cwd: '/tmp' });
  const done = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  void done.catch(() => {});
  function complete(text = 'done') {
    notify('item/completed', { threadId: 'thread-main', item: { type: 'agentMessage', text } });
    notify('turn/completed', { threadId: 'thread-main', turn: { id: `turn-${nextTurn}`, status: 'completed' } });
  }
  function push(inputId: string, prompt: string, mode: 'steer' | 'queue' = 'steer', acceptInput = async () => {}) {
    query.push({ inputId, prompt, acceptInput, deliveryMode: mode } as QueryTurnInput);
  }
  return {
    requests,
    events,
    query,
    done,
    complete,
    push,
    notify,
    setSteerResponse: (r: typeof steerResponse) => {
      steerResponse = r;
    },
    holdStart: () => {
      holdStartResponse = true;
    },
    releaseStart: (response?: Omit<JsonRpcResponse, 'id'>) => {
      holdStartResponse = false;
      const request = requests.find((r) => r.method === 'turn/start');
      if (request) respond(request, response ?? { result: { turn: { id: 'turn-1' } } });
    },
  };
}

describe('Codex native follow-up steering', () => {
  it('retains corrections until the initial turn/start handshake is acknowledged', async () => {
    const h = harness();
    h.holdStart();
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('during-start', 'correction');
      await Bun.sleep(10);
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      h.releaseStart();
      await waitFor(() => h.requests.some((r) => r.method === 'turn/steer'));
      h.query.end();
      h.complete();
      await h.done;
      expect(h.events.find((e) => e.type === 'result')).toMatchObject({
        resolvedInputIds: ['initial', 'during-start'],
      });
    } finally {
      h.releaseStart();
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('never submits an unobserved correction if the initial start handshake fails', async () => {
    const h = harness();
    h.holdStart();
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('during-failed-start', 'correction');
      await Bun.sleep(10);
      h.releaseStart({ error: { code: -32603, message: 'initial start failed' } });
      await expect(h.done).rejects.toThrow('initial start failed');
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      expect(h.events.some((e) => e.type === 'input-accepted' && e.inputId === 'during-failed-start')).toBe(false);
    } finally {
      h.releaseStart();
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('steers an active native turn and resolves every accepted input together', async () => {
    const h = harness();
    try {
      await waitFor(() => h.requests.some((r) => r.method === 'turn/start'));
      h.push('correction', 'use the blue version');
      await waitFor(() => h.requests.some((r) => r.method === 'turn/steer'));
      expect(h.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
      expect(h.requests.find((r) => r.method === 'turn/steer')?.params).toEqual({
        threadId: 'thread-main',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'correction',
        input: [{ type: 'text', text: 'use the blue version' }],
      });
      await waitFor(() => h.events.some((e) => e.type === 'input-accepted' && e.inputId === 'correction'));
      h.query.end();
      h.complete();
      await h.done;
      expect(h.events.find((e) => e.type === 'result')).toMatchObject({ resolvedInputIds: ['initial', 'correction'] });
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('defers explicit queue input while letting a later correction steer past it', async () => {
    const h = harness();
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('queued', 'later task', 'queue');
      h.push('correction', 'fix current task');
      await waitFor(() => h.requests.some((r) => r.method === 'turn/steer'));
      expect(h.events.some((e) => e.type === 'input-accepted' && e.inputId === 'queued')).toBe(false);
      h.complete();
      await waitFor(() => h.requests.filter((r) => r.method === 'turn/start').length === 2);
      expect(h.requests.filter((r) => r.method === 'turn/start')[1].params.input).toEqual([
        { type: 'text', text: 'later task' },
      ]);
      h.query.end();
      h.complete();
      await h.done;
      expect(h.events.filter((e) => e.type === 'result').map((e) => e.resolvedInputIds)).toEqual([
        ['initial', 'correction'],
        ['queued'],
      ]);
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('waits for the exact trusted acceptance gate before sending a steer', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('blocked', 'correction', 'steer', () => gate);
      await Bun.sleep(10);
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      release();
      await waitFor(() => h.requests.some((r) => r.method === 'turn/steer'));
      h.query.end();
      h.complete();
      await h.done;
    } finally {
      release();
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('starts ordinary messages immediately when the native query is idle', async () => {
    const h = harness();
    try {
      await waitFor(() => h.requests.length === 1);
      h.complete();
      await waitFor(() => h.events.some((e) => e.type === 'result'));
      h.push('next', 'second task');
      await waitFor(() => h.requests.filter((r) => r.method === 'turn/start').length === 2);
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      h.query.end();
      h.complete();
      await h.done;
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('moves a correction to the next turn if completion wins its acceptance gate', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('raced', 'new task', 'steer', () => gate);
      h.complete();
      release();
      await waitFor(() => h.requests.filter((r) => r.method === 'turn/start').length === 2);
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      h.query.end();
      h.complete();
      await h.done;
      expect(h.events.filter((e) => e.type === 'result').map((e) => e.resolvedInputIds)).toEqual([
        ['initial'],
        ['raced'],
      ]);
    } finally {
      release();
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('requeues only a known native precondition rejection', async () => {
    const h = harness();
    h.setSteerResponse({ error: { code: -32600, message: 'no active turn to steer' } });
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('raced', 'new task');
      await waitFor(() => h.requests.some((r) => r.method === 'turn/steer'));
      await Bun.sleep(1);
      h.complete();
      await waitFor(() => h.requests.filter((r) => r.method === 'turn/start').length === 2);
      h.query.end();
      h.complete();
      await h.done;
      expect(h.events.filter((e) => e.type === 'result').map((e) => e.resolvedInputIds)).toEqual([
        ['initial'],
        ['raced'],
      ]);
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('keeps an ambiguously failed steer accepted for recovery and never blindly resubmits', async () => {
    const h = harness();
    h.setSteerResponse({ error: { code: -32603, message: 'connection lost after submitting' } });
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('uncertain', 'correction');
      await h.done;
      expect(h.events.some((e) => e.type === 'input-accepted' && e.inputId === 'uncertain')).toBe(true);
      expect(h.events.some((e) => e.type === 'interruption' && e.terminal)).toBe(true);
      expect(h.events.some((e) => e.type === 'result')).toBe(false);
      expect(h.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
      expect(h.requests.filter((r) => r.method === 'turn/steer')).toHaveLength(1);
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('does not send a steer whose trusted acceptance gate fails', async () => {
    const h = harness();
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('unaccepted', 'correction', 'steer', async () => {
        throw new Error('bind failed');
      });
      await h.done;
      expect(h.events.some((e) => e.type === 'input-accepted' && e.inputId === 'unaccepted')).toBe(false);
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      expect(h.events.some((e) => e.type === 'interruption')).toBe(true);
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('cancels a steer waiting on acceptance when stop aborts the native turn', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('canceled', 'correction', 'steer', () => gate);
      const aborted = h.query.abort();
      release();
      await aborted;
      await h.done;
      expect(h.requests.some((r) => r.method === 'turn/steer')).toBe(false);
      expect(h.requests.some((r) => r.method === 'turn/interrupt')).toBe(true);
      expect(h.events.some((e) => e.type === 'input-accepted' && e.inputId === 'canceled')).toBe(false);
    } finally {
      release();
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });

  it('steers successive inputs serially and resolves all of their correlations', async () => {
    const h = harness();
    try {
      await waitFor(() => h.requests.length === 1);
      h.push('first-correction', 'first');
      h.push('second-correction', 'second');
      await waitFor(() => h.requests.filter((r) => r.method === 'turn/steer').length === 2);
      h.query.end();
      h.complete();
      await h.done;
      expect(h.events.find((e) => e.type === 'result')).toMatchObject({
        resolvedInputIds: ['initial', 'first-correction', 'second-correction'],
      });
    } finally {
      await h.query.abort();
      await h.done.catch(() => {});
    }
  });
});
