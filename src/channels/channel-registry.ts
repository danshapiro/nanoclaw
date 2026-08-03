/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { startupRetryConfigFromEnv, startupRetryDelayMs, type StartupRetryConfig } from './startup-retry.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

export type ChannelStartStatus = 'starting' | 'started' | 'retrying' | 'failed';

export interface ChannelStartState {
  status: ChannelStartStatus;
  attempt: number; // 1-based: attempts made so far
  lastError?: string;
}

export interface InitChannelAdaptersOptions {
  /** Env source for retry tunables (default: .env file merged under process.env). */
  env?: NodeJS.ProcessEnv;
  retryConfig?: StartupRetryConfig;
  random?: () => number;
  /** Max ms boot blocks per channel's first attempt (0 = wait forever). */
  firstAttemptWaitMs?: number;
}

const CHANNEL_STARTUP_RETRY_ENV_KEYS = [
  'CHANNEL_STARTUP_RETRY_DISABLED',
  'CHANNEL_STARTUP_RETRY_DELAYS_MS',
  'CHANNEL_STARTUP_RETRY_CAP_MS',
  'CHANNEL_STARTUP_RETRY_JITTER',
  'CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS',
];

const DEFAULT_FIRST_ATTEMPT_WAIT_MS = 30_000;

const startStates = new Map<string, ChannelStartState>();
const retryTimers = new Map<string, NodeJS.Timeout>();
let retriesHalted = false;

/** Snapshot of per-channel startup state (tests + future health probes). */
export function getChannelStartStates(): Map<string, ChannelStartState> {
  return new Map(startStates);
}

/**
 * Adapters mark startup errors that must NOT be retried by attaching
 * `permanentStartupError: true` (e.g. WhatsApp logged-out: Baileys documents
 * blind re-login on stale creds as the ban-risk anti-pattern — see Task 2b).
 * Permanent failures report status "failed" and stop the retry loop.
 */
export function isPermanentStartupError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { permanentStartupError?: unknown }).permanentStartupError === true
  );
}

function firstAttemptWaitMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS?.trim();
  if (!raw) return DEFAULT_FIRST_ATTEMPT_WAIT_MS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  log.warn('Ignoring malformed CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS', { value: raw });
  return DEFAULT_FIRST_ATTEMPT_WAIT_MS;
}

function bootWaitSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 *
 * The first attempt per channel runs inline but blocks boot for at most
 * firstAttemptWaitMs (validated hang shapes: `ws` with no handshakeTimeout
 * hangs ~133 s; a broken CONNECT proxy under NODE_USE_ENV_PROXY=1 hangs
 * fetch indefinitely; a pre-open WhatsApp close reconnects forever). A
 * capped attempt keeps running in the background — it is never aborted, so
 * there is no double-attempt risk. Failures schedule background re-attempts
 * with backoff + jitter that repeat indefinitely — a channel is never
 * permanently dead while the process lives (2026-08-02 outage class).
 *
 * Liveness invariant (validated): every timer here is unref'd; the process
 * is kept alive by the delivery/host-sweep poll chains armed in
 * src/index.ts:189-194 AFTER this function resolves. Do not unref those
 * polls, and do not let this function block indefinitely — either would
 * reintroduce silent clean-exit death when all channels are down.
 */
export async function initChannelAdapters(
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
  options: InitChannelAdaptersOptions = {},
): Promise<void> {
  retriesHalted = false;
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  startStates.clear();
  const env = options.env ?? { ...readEnvFile(CHANNEL_STARTUP_RETRY_ENV_KEYS), ...process.env };
  const retryConfig = options.retryConfig ?? startupRetryConfigFromEnv(env, 'CHANNEL_STARTUP_RETRY');
  const random = options.random ?? Math.random;
  const firstAttemptWaitMs = options.firstAttemptWaitMs ?? firstAttemptWaitMsFromEnv(env);
  for (const [name, registration] of registry) {
    const attempt = attemptChannelStart(name, registration, setupFn, retryConfig, random, 1);
    if (firstAttemptWaitMs <= 0) {
      await attempt;
      continue;
    }
    const timedOut = await Promise.race([
      attempt.then(() => false),
      bootWaitSleep(firstAttemptWaitMs).then(() => true),
    ]);
    if (timedOut && !startStates.has(name)) {
      // has(name) guards the same-tick race where the attempt settled right
      // after the cap fired — never clobber a real started/retrying state.
      startStates.set(name, { status: 'starting', attempt: 1 });
      log.warn('Channel adapter start attempt still pending, continuing boot', {
        channel: name,
        waitedMs: firstAttemptWaitMs,
      });
      log.info('Channel adapter status', { channel: name, status: 'starting', attempt: 1 });
    }
  }
}

/**
 * One full start attempt (factory + setup). On failure, schedules the next
 * attempt on an unref'd timer. Retries stop only at teardown, when
 * CHANNEL_STARTUP_RETRY_DISABLED=1 (legacy single-attempt behavior), or when
 * the error is marked permanent (isPermanentStartupError — e.g. WhatsApp
 * logged-out, Task 2b).
 */
async function attemptChannelStart(
  name: string,
  registration: ChannelRegistration,
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
  retryConfig: StartupRetryConfig,
  random: () => number,
  attempt: number,
): Promise<void> {
  retryTimers.delete(name);
  let adapter: ChannelAdapter | null = null;
  try {
    adapter = await registration.factory();
    if (!adapter) {
      log.warn('Channel credentials missing, skipping', { channel: name });
      startStates.delete(name);
      return;
    }

    const setup = setupFn(adapter);
    // Transient network failures during adapter init (e.g. Telegram deleteWebhook
    // hitting a DNS hiccup at boot) get a fast inner retry on NetworkError
    // before the outer backoff ladder takes over.
    let setupAttempt = 0;
    while (true) {
      try {
        await adapter.setup(setup);
        break;
      } catch (err) {
        if (isNetworkError(err) && setupAttempt < SETUP_RETRY_DELAYS_MS.length) {
          const delay = SETUP_RETRY_DELAYS_MS[setupAttempt]!;
          log.warn('Channel adapter setup failed with network error, retrying', {
            channel: name,
            attempt: setupAttempt + 1,
            delayMs: delay,
            err: err.message,
          });
          await sleep(delay);
          setupAttempt += 1;
          continue;
        }
        throw err;
      }
    }

    if (retriesHalted) {
      // Teardown began while this attempt was in flight — don't register.
      await adapter.teardown().catch((err) => {
        log.warn('Teardown of late-started adapter failed', { channel: name, err });
      });
      return;
    }

    activeAdapters.set(adapter.channelType, adapter);
    startStates.set(name, { status: 'started', attempt });
    log.info('Channel adapter started', { channel: name, type: adapter.channelType });
    log.info('Channel adapter status', { channel: name, status: 'started', attempt });
  } catch (err) {
    if (adapter) {
      // Best-effort cleanup of a partially set-up adapter before the retry.
      // NOTE (validated): teardown is NOT leak-free today — the bridge's
      // webhook server and catch-up engine are never reclaimed (pre-existing,
      // out of scope; see plan SACRED #2). Claims/leases are what prevent
      // double-processing.
      await adapter.teardown().catch((teardownErr) => {
        log.warn('Cleanup of failed adapter start attempt failed', { channel: name, err: teardownErr });
      });
    }
    const lastError = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentStartupError(err);
    if (retriesHalted || retryConfig.disabled || permanent) {
      startStates.set(name, { status: 'failed', attempt, lastError });
      log.error('Failed to start channel adapter', { channel: name, permanent, err });
      log.info('Channel adapter status', { channel: name, status: 'failed', attempt, lastError });
      return;
    }
    const retryInMs = startupRetryDelayMs(retryConfig, attempt, random);
    startStates.set(name, { status: 'retrying', attempt, lastError });
    log.warn('Failed to start channel adapter, will retry', { channel: name, attempt, retryInMs, err });
    log.info('Channel adapter status', { channel: name, status: 'retrying', attempt, lastError, retryInMs });
    const timer = setTimeout(() => {
      void attemptChannelStart(name, registration, setupFn, retryConfig, random, attempt + 1);
    }, retryInMs);
    timer.unref?.();
    retryTimers.set(name, timer);
  }
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  retriesHalted = true;
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
