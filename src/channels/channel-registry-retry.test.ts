/**
 * Factory-level startup retry (2026-08-02 outage class): a channel whose
 * factory or setup throws must keep retrying with backoff until it starts —
 * never permanently dead while the process lives.
 *
 * Each test resets modules to get a fresh registry singleton (see
 * channel-registry.test.ts:81-88 for the precedent) and imports ONLY
 * ./channel-registry.js — never ./index.js — so the real channel factories
 * are not pulled in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from './adapter.js';
import type { StartupRetryConfig } from './startup-retry.js';

const TEST_RETRY: StartupRetryConfig = { disabled: false, delaysMs: [5000, 15000], capMs: 30000, jitterRatio: 0 };

function mockAdapter(channelType: string): ChannelAdapter {
  let up = false;
  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {
      up = true;
    },
    async teardown() {
      up = false;
    },
    isConnected: () => up,
    async deliver() {
      return undefined;
    },
  };
}

async function freshRegistry() {
  // vi.resetModules() gives a fresh registry singleton per test — which also
  // re-instantiates ../log.js. Spy on the POST-reset log instance returned
  // here, never a file-level log import (repo gotcha: import log AFTER
  // resetModules — see container-runner.test.ts:2647-2649).
  vi.resetModules();
  const registry = await import('./channel-registry.js');
  const { log } = await import('../log.js');
  return { ...registry, log };
}

describe('channel adapter startup retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a throwing factory with backoff until it succeeds (incident shape: fetch failed)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters, getChannelStartStates, log } =
      await freshRegistry();
    const infoSpy = vi.spyOn(log, 'info');
    const errorSpy = vi.spyOn(log, 'error');

    let attempts = 0;
    const adapter = mockAdapter('discord-like');
    registerChannelAdapter('discord-like', {
      factory: () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError('fetch failed');
        return adapter;
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );

    expect(attempts).toBe(1);
    expect(getActiveAdapters()).toHaveLength(0);
    expect(getChannelStartStates().get('discord-like')).toEqual({
      status: 'retrying',
      attempt: 1,
      lastError: 'fetch failed',
    });
    expect(errorSpy).not.toHaveBeenCalled(); // retrying is WARN + status INFO, never ERROR

    await vi.advanceTimersByTimeAsync(5000); // ladder[0]
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(15000); // ladder[1]
    expect(attempts).toBe(3);
    expect(getActiveAdapters().map((a) => a.channelType)).toContain('discord-like');
    expect(getChannelStartStates().get('discord-like')).toEqual({ status: 'started', attempt: 3 });
    expect(infoSpy).toHaveBeenCalledWith('Channel adapter status', {
      channel: 'discord-like',
      status: 'started',
      attempt: 3,
    });
  });

  it('never gives up: repeats at the cap after the ladder is exhausted', async () => {
    const { registerChannelAdapter, initChannelAdapters, getChannelStartStates } = await freshRegistry();
    let attempts = 0;
    registerChannelAdapter('always-down', {
      factory: () => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );

    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); // attempt 2 (ladder[0])
    await vi.advanceTimersByTimeAsync(15000); // attempt 3 (ladder[1])
    await vi.advanceTimersByTimeAsync(30000); // attempt 4 (cap)
    await vi.advanceTimersByTimeAsync(30000); // attempt 5 (cap — still going)
    expect(attempts).toBe(5);
    expect(getChannelStartStates().get('always-down')?.status).toBe('retrying');
    expect(getChannelStartStates().get('always-down')?.attempt).toBe(5);
  });

  it('retries when setup() throws a non-NetworkError, cleaning up the failed attempt (AgentMail preflight shape)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await freshRegistry();
    let setupCalls = 0;
    const adapter = mockAdapter('agentmail-like');
    const realSetup = adapter.setup.bind(adapter);
    adapter.setup = async (config) => {
      setupCalls += 1;
      if (setupCalls === 1) throw new Error('AgentMail requires OneCLI proxy env when AGENTMAIL_ENABLED=1');
      await realSetup(config);
    };
    const teardownSpy = vi.spyOn(adapter, 'teardown');
    registerChannelAdapter('agentmail-like', { factory: () => adapter });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );

    expect(setupCalls).toBe(1);
    expect(getActiveAdapters()).toHaveLength(0);
    expect(teardownSpy).toHaveBeenCalledTimes(1); // partial attempt cleaned up before retry

    await vi.advanceTimersByTimeAsync(5000);
    expect(setupCalls).toBe(2);
    expect(getActiveAdapters().map((a) => a.channelType)).toContain('agentmail-like');
  });

  it('emits a single greppable status line at each transition', async () => {
    const { registerChannelAdapter, initChannelAdapters, log } = await freshRegistry();
    const infoSpy = vi.spyOn(log, 'info');
    const warnSpy = vi.spyOn(log, 'warn');
    let attempts = 0;
    registerChannelAdapter('health', {
      factory: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return mockAdapter('health');
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );

    expect(infoSpy).toHaveBeenCalledWith('Channel adapter status', {
      channel: 'health',
      status: 'retrying',
      attempt: 1,
      lastError: 'fetch failed',
      retryInMs: 5000,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to start channel adapter, will retry',
      expect.objectContaining({ channel: 'health', attempt: 1, retryInMs: 5000 }),
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(infoSpy).toHaveBeenCalledWith('Channel adapter status', {
      channel: 'health',
      status: 'started',
      attempt: 2,
    });
  });

  it('teardownChannelAdapters cancels pending startup retries', async () => {
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } = await freshRegistry();
    let attempts = 0;
    registerChannelAdapter('doomed', {
      factory: () => {
        attempts += 1;
        throw new Error('down');
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );
    expect(attempts).toBe(1);

    await teardownChannelAdapters();
    await vi.advanceTimersByTimeAsync(120000);
    expect(attempts).toBe(1); // no further attempts after teardown
  });

  it('tears down an adapter whose start completes after teardown began', async () => {
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters, getActiveAdapters } =
      await freshRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = mockAdapter('slow');
    const teardownSpy = vi.spyOn(adapter, 'teardown');
    registerChannelAdapter('slow', {
      factory: async () => {
        await gate;
        return adapter;
      },
    });

    const initPromise = initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );
    const teardownPromise = teardownChannelAdapters(); // halts while the factory is in flight
    release();
    await initPromise;
    await teardownPromise;

    expect(getActiveAdapters()).toHaveLength(0);
    expect(teardownSpy).toHaveBeenCalled();
  });

  it('CHANNEL_STARTUP_RETRY_DISABLED restores the legacy single-attempt ERROR behavior', async () => {
    const { registerChannelAdapter, initChannelAdapters, getChannelStartStates, log } = await freshRegistry();
    const errorSpy = vi.spyOn(log, 'error');
    let attempts = 0;
    registerChannelAdapter('legacy', {
      factory: () => {
        attempts += 1;
        throw new Error('bad token');
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: { ...TEST_RETRY, disabled: true }, random: () => 0 },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to start channel adapter',
      expect.objectContaining({ channel: 'legacy' }),
    );
    await vi.advanceTimersByTimeAsync(600000);
    expect(attempts).toBe(1);
    expect(getChannelStartStates().get('legacy')?.status).toBe('failed');
  });

  it('reads retry tunables from env under the CHANNEL_STARTUP_RETRY prefix', async () => {
    const { registerChannelAdapter, initChannelAdapters } = await freshRegistry();
    let attempts = 0;
    registerChannelAdapter('env-tuned', {
      factory: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('down');
        return mockAdapter('env-tuned');
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      {
        env: {
          CHANNEL_STARTUP_RETRY_DELAYS_MS: '1000',
          CHANNEL_STARTUP_RETRY_CAP_MS: '2000',
          CHANNEL_STARTUP_RETRY_JITTER: '0',
        },
      },
    );

    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // ladder[0]
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); // cap after 1-entry ladder
    expect(attempts).toBe(3);
  });

  it('stops retrying and reports failed when the error is marked permanent (WhatsApp logged-out shape)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getChannelStartStates, log } = await freshRegistry();
    const errorSpy = vi.spyOn(log, 'error');
    let attempts = 0;
    registerChannelAdapter('logged-out', {
      factory: () => {
        attempts += 1;
        throw Object.assign(new Error('WhatsApp session logged out, re-pair required'), {
          permanentStartupError: true,
        });
      },
    });

    await initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0 },
    );

    expect(attempts).toBe(1);
    expect(getChannelStartStates().get('logged-out')?.status).toBe('failed');
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to start channel adapter',
      expect.objectContaining({ channel: 'logged-out', permanent: true }),
    );
    await vi.advanceTimersByTimeAsync(600000);
    expect(attempts).toBe(1); // permanent = never retried
  });

  it('bounds boot blocking when a first attempt hangs, then lets it finish in the background', async () => {
    const { registerChannelAdapter, initChannelAdapters, getChannelStartStates, getActiveAdapters, log } =
      await freshRegistry();
    const warnSpy = vi.spyOn(log, 'warn');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = mockAdapter('hangs');
    registerChannelAdapter('hangs', {
      factory: async () => {
        await gate; // validated hang shapes: ws with no handshakeTimeout; broken CONNECT proxy; pre-open WhatsApp close
        return adapter;
      },
    });

    const initPromise = initChannelAdapters(
      () => ({
        conversations: [],
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { retryConfig: TEST_RETRY, random: () => 0, firstAttemptWaitMs: 30000 },
    );
    await vi.advanceTimersByTimeAsync(30000); // boot-wait cap elapses
    await initPromise; // boot proceeds although the attempt is still in flight
    expect(getChannelStartStates().get('hangs')).toEqual({ status: 'starting', attempt: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      'Channel adapter start attempt still pending, continuing boot',
      expect.objectContaining({ channel: 'hangs', waitedMs: 30000 }),
    );

    release();
    await vi.advanceTimersByTimeAsync(0); // let the in-flight attempt settle
    expect(getActiveAdapters().map((a) => a.channelType)).toContain('hangs');
    expect(getChannelStartStates().get('hangs')).toEqual({ status: 'started', attempt: 1 });
  });
});
