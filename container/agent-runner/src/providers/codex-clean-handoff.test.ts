import { describe, expect, it } from 'bun:test';
import type { AppServer, CodexTerminationOptions, JsonRpcNotification } from './codex-app-server.js';
import { CodexProvider } from './codex.js';
import { ProviderContainerStopRequired, ProviderQuiescenceError } from './types.js';

function harness(mode: 'normal' | 'abort' | 'terminal' | 'setup' | 'cancel') {
  let observedOptions: CodexTerminationOptions | undefined;
  const server = {
    process: {
      stdin: {
        write(line: string) {
          const request = JSON.parse(line);
          queueMicrotask(() => {
            server.pending.get(request.id)?.resolve({ id: request.id, result: { turn: { id: 'turn-test' } } });
            if (request.method !== 'turn/start') return;
            for (const handler of server.notificationHandlers) {
              handler({
                method: 'item/completed',
                params: { threadId: 'thread-test', item: { type: 'agentMessage', text: 'Complete.' } },
              });
              handler({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-test',
                  turn: {
                    id: 'turn-test',
                    status: mode === 'terminal' ? 'failed' : 'completed',
                    error: mode === 'terminal' ? { message: 'Native failure' } : undefined,
                  },
                },
              });
            }
          });
          return true;
        },
      },
    },
    readline: { close() {} },
    pending: new Map(),
    notificationHandlers: [] as Array<(n: JsonRpcNotification) => void>,
    serverRequestHandlers: [],
  } as unknown as AppServer;
  const provider = new CodexProvider(
    { env: { CODEX_MODEL: 'gpt-6.1-sol' } },
    {
      syncManagedSkillLinks: () => [],
      writeMcpConfig: () => {},
      createConfigOverrides: () => [],
      spawnServer: () => server,
      attachAutoApproval: () => {},
      initializeServer: async () => {},
      startThread: async () => {
        if (mode === 'setup') throw new Error('Setup failed');
        return 'thread-test';
      },
      terminateServer: async (_server, options) => {
        observedOptions = options;
        if (options?.cleanCompletion) throw new ProviderContainerStopRequired('Whole-container stop still required');
        throw new ProviderQuiescenceError('Genuine failed or cancelled shutdown');
      },
    },
  );
  return {
    query: provider.query({ inputId: 'input-test', acceptInput: async () => {}, prompt: 'Work', cwd: '/tmp' }),
    options: () => observedOptions,
  };
}

describe('Codex clean completion is a host-stop lifecycle, not quiescence proof', () => {
  it.each(['normal', 'abort', 'terminal', 'setup', 'cancel'] as const)(
    'only requests clean handoff after full normal drain: %s',
    async (mode) => {
      const h = harness(mode);
      let failure: unknown;
      let abort: Promise<void> | undefined;
      try {
        if (mode === 'cancel') {
          const iterator = h.query.events[Symbol.asyncIterator]();
          await iterator.next();
          await iterator.return?.();
        } else {
          for await (const event of h.query.events) {
            if (event.type === 'result') {
              if (mode === 'abort') {
                abort = h.query.abort();
                void abort.catch(() => {});
              } else h.query.end();
            }
            if (event.type === 'interruption') h.query.end();
          }
        }
      } catch (error) {
        failure = error;
      }
      expect(h.options()?.cleanCompletion).toBe(mode === 'normal');
      if (mode === 'normal') expect(failure).toBeInstanceOf(ProviderContainerStopRequired);
      else expect(failure).not.toBeInstanceOf(ProviderContainerStopRequired);
      if (mode === 'setup') expect((failure as Error).message).toBe('Setup failed');
      if (abort) await abort.catch(() => {});
    },
  );
});
