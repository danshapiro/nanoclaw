/**
 * Tests for the graceful shutdown path in src/index.ts (runShutdown).
 *
 * All heavy dependencies of index.ts are mocked so importing the module
 * (which runs main() for side effects) is inert; the shared `h.calls` array
 * records shutdown-relevant invocations to assert ordering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  drainImpl: undefined as undefined | (() => Promise<void>),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./config.js', () => ({ DATA_DIR: '/tmp/nanoclaw-shutdown-test' }));
vi.mock('./claude-md-compose.js', () => ({ migrateGroupsToClaudeLocal: vi.fn() }));
vi.mock('./db/connection.js', () => ({ initDb: vi.fn() }));
vi.mock('./db/migrations/index.js', () => ({ runMigrations: vi.fn() }));
vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
  cleanupOrphansVerified: vi.fn(),
}));
vi.mock('./gws-correlation-ipc.js', () => ({
  expireAllStaleGwsCorrelations: vi.fn(),
  startGwsCorrelationIpcWatcher: vi.fn(),
  stopGwsCorrelationIpcWatcher: vi.fn(),
}));
vi.mock('./delivery.js', () => ({
  startActiveDeliveryPoll: vi.fn(),
  startSweepDeliveryPoll: vi.fn(),
  setDeliveryAdapter: vi.fn(),
  stopDeliveryPolls: vi.fn(() => {
    h.calls.push('stopDeliveryPolls');
  }),
}));
vi.mock('./host-sweep.js', () => ({
  startHostSweep: vi.fn(),
  stopHostSweep: vi.fn(() => {
    h.calls.push('stopHostSweep');
  }),
}));
vi.mock('./router.js', () => ({ routeInbound: vi.fn() }));
vi.mock('./container-runner.js', () => ({
  cleanupStaleContainerEnvFiles: vi.fn(),
  drainAllContainers: vi.fn((graceSeconds: number) => {
    h.calls.push(`drainAllContainers(${graceSeconds})`);
    return h.drainImpl ? h.drainImpl() : Promise.resolve();
  }),
}));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./modules/index.js', () => ({}));
vi.mock('./channels/channel-registry.js', () => ({
  initChannelAdapters: vi.fn(async () => {}),
  teardownChannelAdapters: vi.fn(async () => {
    h.calls.push('teardownChannelAdapters');
  }),
  getChannelAdapter: vi.fn(),
}));

async function freshIndex(): Promise<typeof import('./index.js')> {
  vi.resetModules();
  h.calls.length = 0;
  h.drainImpl = undefined;
  return import('./index.js');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runShutdown', () => {
  it('stops pollers before draining containers, then tears down adapters and exits 0 once', async () => {
    const mod = await freshIndex();
    mod.onShutdown(() => {
      h.calls.push('shutdownCallback');
    });
    const exit = vi.fn();

    await mod.runShutdown('SIGTERM', exit);

    expect(h.calls).toEqual([
      'stopDeliveryPolls',
      'stopHostSweep',
      'shutdownCallback',
      'drainAllContainers(30)',
      'teardownChannelAdapters',
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('continues shutdown when a shutdown callback throws', async () => {
    const mod = await freshIndex();
    mod.onShutdown(() => {
      throw new Error('callback boom');
    });
    const exit = vi.fn();

    await mod.runShutdown('SIGTERM', exit);

    expect(h.calls).toContain('drainAllContainers(30)');
    expect(h.calls).toContain('teardownChannelAdapters');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('fires the 60s watchdog exit when the container drain hangs', async () => {
    vi.useFakeTimers();
    const mod = await freshIndex();
    const exit = vi.fn();
    h.drainImpl = () => new Promise(() => {}); // never resolves

    void mod.runShutdown('SIGTERM', exit);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits immediately on a second signal while shutdown is in progress', async () => {
    const mod = await freshIndex();
    const firstExit = vi.fn();
    h.drainImpl = () => new Promise(() => {}); // first shutdown hangs in drain

    void mod.runShutdown('SIGTERM', firstExit);

    const secondExit = vi.fn();
    await mod.runShutdown('SIGINT', secondExit);

    expect(secondExit).toHaveBeenCalledTimes(1);
    expect(secondExit).toHaveBeenCalledWith(0);
    expect(firstExit).not.toHaveBeenCalled();
  });
});
