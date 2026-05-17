import { describe, it, expect } from 'bun:test';

import { isStaleSessionError, nextMeaningfulOpenCodeEvent, nextOpenCodeEvent, promptSession } from './opencode.js';

describe('OpenCodeProvider stale session handling', () => {
  it('classifies missing OpenCode sessions as stale continuations', () => {
    expect(isStaleSessionError(new Error('NotFoundError: session not found'))).toBe(true);
    expect(isStaleSessionError(new Error('OpenCode event timeout (300000ms)'))).toBe(true);
    expect(isStaleSessionError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('retries prompt_async once with a fresh session when the persisted session is stale', async () => {
    const promptedIds: string[] = [];
    const client = {
      create: async () => ({
        data: { id: 'fresh-session' },
        error: undefined,
        request: {} as Request,
        response: {} as Response,
      }),
      promptAsync: async ({ path }: { path: { id: string } }) => {
        promptedIds.push(path.id);
        if (path.id === 'stale-session') {
          return {
            data: undefined,
            error: { name: 'NotFoundError', message: 'session not found' },
            request: {} as Request,
            response: {} as Response,
          };
        }
        return {
          data: true,
          error: undefined,
          request: {} as Request,
          response: {} as Response,
        };
      },
    };

    await expect(promptSession(client, 'stale-session', 'hello')).resolves.toEqual({
      sessionId: 'fresh-session',
      recoveredFromStale: true,
    });
    expect(promptedIds).toEqual(['stale-session', 'fresh-session']);
  });
});

describe('nextOpenCodeEvent', () => {
  it('resolves when the event stream produces an event before the timeout', async () => {
    async function* stream() {
      yield { type: 'session.idle', properties: { sessionID: 's1' } };
    }

    const result = await nextOpenCodeEvent(stream(), 's1', 50, () => {
      throw new Error('unexpected timeout');
    });

    expect(result.done).toBe(false);
    expect(result.value?.type).toBe('session.idle');
  });

  it('rejects and runs timeout cleanup when the event stream stalls', async () => {
    async function* stream() {
      await new Promise(() => {});
    }

    let timedOut = false;
    await expect(
      nextOpenCodeEvent(stream(), 's1', 5, () => {
        timedOut = true;
      }),
    ).rejects.toThrow(/OpenCode event timeout/);
    expect(timedOut).toBe(true);
  });
});

describe('nextMeaningfulOpenCodeEvent', () => {
  it('skips keepalive events while waiting for meaningful provider progress', async () => {
    async function* stream() {
      yield { type: 'server.connected', properties: {} };
      yield { type: 'server.heartbeat', properties: {} };
      yield { type: 'session.idle', properties: { sessionID: 's1' } };
    }

    const result = await nextMeaningfulOpenCodeEvent(stream(), 's1', 50, () => {
      throw new Error('unexpected timeout');
    });

    expect(result.done).toBe(false);
    expect(result.value?.type).toBe('session.idle');
  });

  it('does not let heartbeat-only streams reset the idle timeout', async () => {
    async function* stream() {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield { type: 'server.heartbeat', properties: {} };
      }
    }

    let timedOut = false;
    await expect(
      nextMeaningfulOpenCodeEvent(stream(), 's1', 8, () => {
        timedOut = true;
      }),
    ).rejects.toThrow(/OpenCode event timeout/);
    expect(timedOut).toBe(true);
  });
});
