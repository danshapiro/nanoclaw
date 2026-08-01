import { describe, expect, it } from 'bun:test';

import { type AppServer } from './codex-app-server.js';
import { CodexProvider } from './codex.js';
import { ProviderQuiescenceError } from './types.js';

function queryServer(): AppServer {
  return {
    process: {},
    readline: { close() {} },
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

function makeProvider(): CodexProvider {
  return new CodexProvider(
    {},
    {
      syncManagedSkillLinks: () => [],
      writeMcpConfig: () => {},
      createConfigOverrides: () => [],
      spawnServer: () => queryServer(),
      attachAutoApproval: () => {},
      initializeServer: async () => {},
      startThread: async () => 'thread-abc',
      terminateServer: async () => {
        // Mirrors the production reality: terminateCodexAppServer ALWAYS
        // throws post-spawn ('transport shutdown' branch is the common case).
        throw new ProviderQuiescenceError(
          'Codex app-server exited after transport shutdown, but whole process tree quiescence is unproven until host container stop: code=0 signal=null',
        );
      },
    },
  );
}

describe('codex gen() finally must not mask the in-flight body error', () => {
  it('rethrows the acceptance-gate rejection type-preserved with the quiescence failure attached', async () => {
    class FakeAcceptanceError extends Error {
      constructor() {
        super('trusted host input bind failed for in-both-faults');
        this.name = 'TrustedInputAcceptanceError';
      }
    }
    const bodyError = new FakeAcceptanceError();
    const provider = makeProvider();
    const query = provider.query({
      inputId: 'in-both-faults',
      acceptInput: async () => {
        throw bodyError;
      },
      prompt: 'do work',
      cwd: '/workspace/agent',
    });
    let rejection: unknown;
    try {
      for await (const _event of query.events) {
        // drain until the generator rejects
      }
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBe(bodyError); // the ORIGINAL error object — instanceof routing works
    const attached =
      (rejection as { cause?: unknown }).cause ?? (rejection as { quiescenceFailure?: unknown }).quiescenceFailure;
    expect(attached).toBeInstanceOf(ProviderQuiescenceError);
    // The abort waiter still sees the typed quiescence failure.
    const abortRejection = await query.abort().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(abortRejection).toBeInstanceOf(ProviderQuiescenceError);
  });
});
