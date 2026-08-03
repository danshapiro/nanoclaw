# Channel Adapter Startup Resilience Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** A channel adapter is never permanently dead while the nanoclaw process lives — adapter startup failures retry with backoff+jitter forever, the Discord command sync stops being load-bearing, the AgentMail OneCLI env setup becomes retryable, and per-channel status is greppable from journalctl.

**Architecture:** Three layers. (1) A generic startup-retry policy module (`startup-retry.ts`) feeds an outer retry loop in `channel-registry.ts` that re-runs the FULL channel start (factory + setup) on unref'd timers until it succeeds — this alone closes the 2026-08-02 outage class because catch-up is armed inside `setup()`, so a late start recovers the gap through the existing durable-cursor machinery. Boot blocking is bounded (`CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS`; validated hang shapes exist: `ws` with no `handshakeTimeout` hangs ~133 s, a broken CONNECT proxy under `NODE_USE_ENV_PROXY=1` hangs fetch indefinitely, a pre-open WhatsApp close reconnects forever), and errors marked `permanentStartupError` (WhatsApp logged-out — Baileys documents blind re-login as the ban-risk anti-pattern) stop retrying with status `failed`. (2) Channel-specific fragility fixes: Discord's application-command sync moves to a single-flight fire-and-forget background loop that treats partial guild resolution as a failed cycle (only the single config-discovery GET stays load-bearing, and only when env lacks `DISCORD_APPLICATION_ID`/`DISCORD_PUBLIC_KEY`); WhatsApp teardown no longer triggers a Baileys reconnect (Task 2b); AgentMail's factory re-runs the ops-repo OneCLI env script on each retry and — because `NODE_EXTRA_CA_CERTS`/`NODE_USE_ENV_PROXY` are startup-only Node options (validated by experiment; a working in-process undici/ws re-injection alternative exists but is deliberately rejected for blast-radius reasons, see Task 4) — exits for a systemd restart when acquisition succeeds late (`Restart=on-failure` verified active on the live host). (3) A canonical `Channel adapter status` INFO log line at every state transition for host-side detectors (INFO verified visible in the live journal).

**Tech Stack:** TypeScript 5.9 (ESM, NodeNext, `.js` import suffixes), Node 22, vitest 4 (host tests), bun test (container tests only — untouched here), better-sqlite3, hand-rolled `src/log.ts` logger. **No new dependencies.**

## Global Constraints

- Worktree root (all paths relative to it): `/home/dan/code/nanoclaw-reboot-resilience/.worktrees/channel-adapter-startup-resilience`
- SACRED: message durability and catch-up semantics unchanged — do not modify `src/channels/discord-catchup.ts`, `src/channels/discord-state.ts`, `src/channels/agentmail-state.ts`, or any claim/lease logic. A late-starting adapter must still run its startup catch-up.
- SACRED: no double-processing — claim semantics hold; validation (2026-08-02) confirmed claims/leases are what actually carry this guarantee. The registry adds best-effort `teardown()` of a partially-set-up adapter before a retry, but do NOT claim leak-freedom: teardown is known-leaky today (validated) — the bridge's local webhook HTTP server is never closed (`chat-sdk-bridge.ts:786-819`; no `server.close()` exists) and the Discord catch-up engine's `catchup.stop()` has zero call sites. Both are pre-existing and out of scope; mitigating fact: a FAILED Discord `setup()` cannot leave an armed catch-up engine (the ready hook is try/caught and nothing after it throws, `chat-sdk-bridge.ts:553-557`). The one teardown hazard IN scope: WhatsApp `teardown()` currently triggers a Baileys reconnect (`sock.end(undefined)` ⇒ close handler computes `shouldReconnect=true`, `whatsapp.ts:447-463`) — Task 2b guards it.
- SACRED: AgentMail preflight/secret handling unchanged in shape — `createAgentMailAdapter` and `requireAgentMailOneCliProxyEnv` keep their exact signatures, synchronous throws, and error strings. The existing pins at `src/channels/agentmail.test.ts:117-137` must keep passing unmodified.
- All new behavior env-configurable with safe defaults (exact names/defaults in the env table below).
- Do NOT deploy. Do NOT touch the live host. The systemd change is documented only (Task 6); `nanoclaw.service` lives in the shapiroserver2 repo, not here.
- Baselines must stay green: 1131 vitest tests (`pnpm test`) + 428 bun tests (`cd container/agent-runner && bun test`) — both MEASURED green at HEAD on 2026-08-02; the bun suite requires `container/agent-runner` deps installed (Task 1, Step 0).
- Conventions: Conventional Commits with scope (`feat(channels): ...`); prettier (singleQuote, 120 cols); eslint rule `preserve-caught-error` is an error — when wrapping a caught error in a new Error, attach `{ cause: err }`; log errors by passing the raw error under the key `err` (the logger special-cases it).
- Tests: never mutate `process.env` — pass env objects; inject `sleep`/`random`/`fetchImpl`; use `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(ms)` for timer-driven code; spy on `log` levels as behavioral contracts.
- `node_modules` may be absent in the worktree: run `pnpm install` once before anything else, AND `bun install --frozen-lockfile` in `container/agent-runner` (Task 1, Step 0) — the bun suite and the agent-runner typecheck both need it.

### New env tunables (all optional; defaults are the shipped behavior)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHANNEL_STARTUP_RETRY_DISABLED` | unset (`0`) | `1` restores legacy single-attempt behavior |
| `CHANNEL_STARTUP_RETRY_DELAYS_MS` | `5000,15000,45000,120000,300000` | backoff ladder for channel start retries |
| `CHANNEL_STARTUP_RETRY_CAP_MS` | `300000` | repeat delay after the ladder is exhausted (forever) |
| `CHANNEL_STARTUP_RETRY_JITTER` | `0.2` | additive jitter ratio 0..1 (`delay = base + base*jitter*random()`) |
| `CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS` | `30000` | max time boot blocks per channel's FIRST start attempt; a capped attempt keeps running in the background (never aborted). `0` = wait indefinitely (legacy) |
| `DISCORD_COMMAND_SYNC_RETRY_DISABLED` / `_DELAYS_MS` / `_CAP_MS` / `_JITTER` | same defaults | same knobs for the background command sync |
| `AGENTMAIL_ONECLI_ENV_SCRIPT` | `${NANOCLAW_ROOT}/agentmail-onecli-env.mjs` | OneCLI env script the runtime re-runs when proxy env is missing |
| `AGENTMAIL_ONECLI_ENV_TIMEOUT_MS` | `30000` | timeout for that script |
| `AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE` | unset (`1` = on) | `0` disables the deliberate exit-for-restart on late acquisition |

### Health-signal log contract (spec item 3)

One canonical INFO line per state transition, key=value structured (single line, greppable after ANSI strip):

```
Channel adapter status channel="discord" status="retrying" attempt=1 lastError="fetch failed" retryInMs=5000
Channel adapter status channel="discord" status="started" attempt=2
Channel adapter status channel="whatsapp" status="starting" attempt=1    (first attempt exceeded the boot-wait cap; still in flight)
Channel adapter status channel="whatsapp" status="failed" attempt=1 lastError="..."   (retries disabled, teardown, or permanentStartupError)
```

Host-side detectors distinguish "adapter retrying" from "adapter up" via `journalctl -u nanoclaw | grep 'Channel adapter status'`. Semantics (validated): `started` means `setup()` RESOLVED — for discord it does NOT imply the gateway is connected or the token valid (login is fire-and-forget; `isConnected()` is hard-coded true), and for agentmail it does NOT imply the socket opened. It is a startup-progress signal, not a connectivity probe.

### Spec coverage map

| Spec requirement | Task(s) |
| --- | --- |
| 1. Startup retry w/ backoff+jitter, indefinite, env-config; late adapter fully functional | 1, 2, 5 |
| 2a. Discord command sync not load-bearing; background retry | 3 |
| 2b. AgentMail OneCLI env setup retryable | 4 (+2 for the retry loop) |
| 3. Structured per-channel health signal | 2 |
| Permanent startup failures stop retrying (WhatsApp logged-out — Baileys ban-risk anti-pattern) | 2, 2b |
| Bounded boot blocking (hang-proof first attempts) | 2 |
| 4. systemd `network-online.target` documented for shapiroserver2 | 6 |
| Test: adapter-start failure then success on retry (both channels) | 2 (discord-shape + agentmail-shape), 4 |
| Test: command-sync failure not killing the gateway | 3 |
| Test: late-start catch-up firing | 5 |
| Test: health-signal log lines | 2 |
| All existing suites green | 7 |

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/channels/startup-retry.ts` | new | retry policy: config-from-env parsing + delay computation (ladder, cap, jitter). No timers, no state — pure + loggable warnings |
| `src/channels/startup-retry.test.ts` | new | unit tests for parsing + delay math |
| `src/channels/channel-registry.ts` | modify | outer per-channel start retry loop, per-channel state map, status log lines, teardown cancellation |
| `src/channels/channel-registry-retry.test.ts` | new | behavior tests for the retry loop (fake timers, module-reset per test) |
| `src/channels/discord-commands.ts` | modify | add `syncYenteDiscordApplicationCommandsWithRetry` + `resolveDiscordStartupConfig`; existing exports extended backward-compatibly (optional failed-channel collector on the guild-resolution helper) — partial resolution fails the sync cycle (Task 3) |
| `src/channels/discord-commands.test.ts` | modify | tests for the two new functions |
| `src/channels/discord.ts` | modify | factory calls `resolveDiscordStartupConfig` instead of awaiting the full command sync |
| `src/channels/whatsapp.ts` | modify | Task 2b: logged-out startup rejection marked `permanentStartupError`; teardown guarded so `sock.end()` cannot trigger a reconnect |
| `src/channels/agentmail-onecli.ts` | new | runtime acquisition of the OneCLI proxy env (never throws) |
| `src/channels/agentmail-onecli.test.ts` | new | unit tests for acquisition |
| `src/channels/agentmail.ts` | modify | new exported `agentMailChannelFactory` composing acquisition + unchanged `createAgentMailAdapter`; registration uses it |
| `src/channels/agentmail.test.ts` | modify | add factory tests (existing tests unmodified) |
| `src/channels/discord-catchup.test.ts` | modify | add late-start `'startup'`-reason gap-recovery test (production catch-up code untouched) |
| `docs/plans/2026-08-02-channel-adapter-startup-resilience-deploy-notes.md` | new | systemd + env-tunable notes for the shapiroserver2 deploy step |

Not modified: `src/index.ts` (the `initChannelAdapters(setupFn)` call at `src/index.ts:96` keeps working — the new options parameter is optional), `src/channels/discord-catchup.ts`, `src/channels/discord-state.ts`, `src/channels/chat-sdk-bridge.ts`, all AgentMail state/config modules, everything under `container/`.

---

### Task 1: Startup retry policy module

**Files:**
- Create: `src/channels/startup-retry.ts`
- Test: `src/channels/startup-retry.test.ts`

**Interfaces:**
- Consumes: `log` from `src/log.ts` (`log.warn(msg, data?)`).
- Produces (used verbatim by Tasks 2 and 3):
  - `interface StartupRetryConfig { disabled: boolean; delaysMs: readonly number[]; capMs: number; jitterRatio: number }`
  - `startupRetryConfigFromEnv(env: NodeJS.ProcessEnv, prefix: string): StartupRetryConfig`
  - `startupRetryDelayMs(config: StartupRetryConfig, failedAttempt: number, random?: () => number): number` (`failedAttempt` is 1-based)
  - `DEFAULT_STARTUP_RETRY_DELAYS_MS`, `DEFAULT_STARTUP_RETRY_CAP_MS`, `DEFAULT_STARTUP_RETRY_JITTER_RATIO`

- [ ] **Step 0: Install dependencies (one-time worktree setup)**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/channel-adapter-startup-resilience
pnpm install
cd container/agent-runner && bun install --frozen-lockfile && cd ../..
```

Expected: install completes (lockfile already present; supply-chain `minimumReleaseAge` applies automatically). Do not commit any lockfile change; if `pnpm install` dirties `pnpm-lock.yaml`, run `git checkout -- pnpm-lock.yaml` after install and use `pnpm install --frozen-lockfile` instead. The bun install is required for Task 7's bun suite and the agent-runner typecheck (validated 2026-08-02: 106 packages; `bun test` then measures 428 pass / 0 fail).

- [ ] **Step 1: Write the failing test**

Create `src/channels/startup-retry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import {
  DEFAULT_STARTUP_RETRY_CAP_MS,
  DEFAULT_STARTUP_RETRY_DELAYS_MS,
  DEFAULT_STARTUP_RETRY_JITTER_RATIO,
  startupRetryConfigFromEnv,
  startupRetryDelayMs,
} from './startup-retry.js';

describe('startupRetryConfigFromEnv', () => {
  it('returns safe defaults for an empty env', () => {
    expect(startupRetryConfigFromEnv({}, 'CHANNEL_STARTUP_RETRY')).toEqual({
      disabled: false,
      delaysMs: DEFAULT_STARTUP_RETRY_DELAYS_MS,
      capMs: DEFAULT_STARTUP_RETRY_CAP_MS,
      jitterRatio: DEFAULT_STARTUP_RETRY_JITTER_RATIO,
    });
  });

  it('parses overrides under the given prefix', () => {
    const config = startupRetryConfigFromEnv(
      {
        DISCORD_COMMAND_SYNC_RETRY_DISABLED: '1',
        DISCORD_COMMAND_SYNC_RETRY_DELAYS_MS: '1000, 2000',
        DISCORD_COMMAND_SYNC_RETRY_CAP_MS: '9000',
        DISCORD_COMMAND_SYNC_RETRY_JITTER: '0',
      },
      'DISCORD_COMMAND_SYNC_RETRY',
    );
    expect(config).toEqual({ disabled: true, delaysMs: [1000, 2000], capMs: 9000, jitterRatio: 0 });
  });

  it('warns and falls back to defaults on malformed values', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const config = startupRetryConfigFromEnv(
      {
        CHANNEL_STARTUP_RETRY_DELAYS_MS: '5000,banana',
        CHANNEL_STARTUP_RETRY_CAP_MS: '-3',
        CHANNEL_STARTUP_RETRY_JITTER: '7',
      },
      'CHANNEL_STARTUP_RETRY',
    );
    expect(config.delaysMs).toEqual(DEFAULT_STARTUP_RETRY_DELAYS_MS);
    expect(config.capMs).toBe(DEFAULT_STARTUP_RETRY_CAP_MS);
    expect(config.jitterRatio).toBe(DEFAULT_STARTUP_RETRY_JITTER_RATIO);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });
});

describe('startupRetryDelayMs', () => {
  const config = { disabled: false, delaysMs: [5000, 15000, 45000], capMs: 300000, jitterRatio: 0.2 };

  it('walks the ladder then repeats at the cap forever', () => {
    const noJitter = () => 0;
    expect(startupRetryDelayMs(config, 1, noJitter)).toBe(5000);
    expect(startupRetryDelayMs(config, 2, noJitter)).toBe(15000);
    expect(startupRetryDelayMs(config, 3, noJitter)).toBe(45000);
    expect(startupRetryDelayMs(config, 4, noJitter)).toBe(300000);
    expect(startupRetryDelayMs(config, 50, noJitter)).toBe(300000);
  });

  it('adds bounded jitter on top of the base delay', () => {
    expect(startupRetryDelayMs(config, 1, () => 1)).toBe(6000); // 5000 + 5000*0.2*1
    expect(startupRetryDelayMs(config, 4, () => 0.5)).toBe(330000); // 300000 + 300000*0.2*0.5
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/channels/startup-retry.test.ts
```

Expected: FAIL — `Cannot find module './startup-retry.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/channels/startup-retry.ts`:

```ts
/**
 * Startup retry policy — backoff ladder + additive jitter, env-tunable.
 *
 * Shared by channel adapter startup (channel-registry.ts) and the Discord
 * application-command background sync (discord-commands.ts). Delays follow
 * the configured ladder, then repeat at capMs indefinitely; jitter is
 * additive (delay = base + base * jitterRatio * random()), so the base
 * delay is the minimum.
 */
import { log } from '../log.js';

export interface StartupRetryConfig {
  disabled: boolean;
  delaysMs: readonly number[];
  capMs: number;
  jitterRatio: number;
}

export const DEFAULT_STARTUP_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000, 300_000];
export const DEFAULT_STARTUP_RETRY_CAP_MS = 300_000;
export const DEFAULT_STARTUP_RETRY_JITTER_RATIO = 0.2;

/**
 * Parse `${prefix}_DISABLED` / `${prefix}_DELAYS_MS` / `${prefix}_CAP_MS` /
 * `${prefix}_JITTER` from env. Malformed values log a WARN and fall back to
 * defaults — a bad tunable must never take the retry machinery down.
 */
export function startupRetryConfigFromEnv(env: NodeJS.ProcessEnv, prefix: string): StartupRetryConfig {
  let delaysMs: readonly number[] = DEFAULT_STARTUP_RETRY_DELAYS_MS;
  const delaysRaw = env[`${prefix}_DELAYS_MS`]?.trim();
  if (delaysRaw) {
    const parsed = delaysRaw.split(',').map((part) => Number(part.trim()));
    if (parsed.length > 0 && parsed.every((n) => Number.isInteger(n) && n > 0)) {
      delaysMs = parsed;
    } else {
      log.warn('Ignoring malformed startup retry delays', { key: `${prefix}_DELAYS_MS`, value: delaysRaw });
    }
  }

  let capMs = DEFAULT_STARTUP_RETRY_CAP_MS;
  const capRaw = env[`${prefix}_CAP_MS`]?.trim();
  if (capRaw) {
    const parsed = Number(capRaw);
    if (Number.isInteger(parsed) && parsed > 0) capMs = parsed;
    else log.warn('Ignoring malformed startup retry cap', { key: `${prefix}_CAP_MS`, value: capRaw });
  }

  let jitterRatio = DEFAULT_STARTUP_RETRY_JITTER_RATIO;
  const jitterRaw = env[`${prefix}_JITTER`]?.trim();
  if (jitterRaw) {
    const parsed = Number(jitterRaw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) jitterRatio = parsed;
    else log.warn('Ignoring malformed startup retry jitter', { key: `${prefix}_JITTER`, value: jitterRaw });
  }

  return { disabled: env[`${prefix}_DISABLED`]?.trim() === '1', delaysMs, capMs, jitterRatio };
}

/**
 * Delay before the next attempt, given the 1-based attempt number that just
 * failed. Ladder first, then capMs forever.
 */
export function startupRetryDelayMs(
  config: StartupRetryConfig,
  failedAttempt: number,
  random: () => number = Math.random,
): number {
  const base = config.delaysMs[failedAttempt - 1] ?? config.capMs;
  return base + Math.floor(base * config.jitterRatio * random());
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/channels/startup-retry.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/startup-retry.ts src/channels/startup-retry.test.ts
git commit -m "feat(channels): add startup retry policy module (backoff ladder + jitter, env-tunable)"
```

---

### Task 2: Factory-level indefinite retry + health status in the channel registry

This is the core outage-class fix. Today `src/channels/channel-registry.ts:53-94` awaits `registration.factory()` OUTSIDE the setup retry loop; any factory throw (undici `TypeError: fetch failed`, AgentMail preflight `Error`) lands in the outer catch at line 90, logs one ERROR, and the channel is dead until restart. Non-`NetworkError` setup throws die the same way.

**Files:**
- Modify: `src/channels/channel-registry.ts` (whole `initChannelAdapters` + `teardownChannelAdapters` region, currently lines 10-107)
- Test: `src/channels/channel-registry-retry.test.ts` (new file — the existing `channel-registry.test.ts` is left untouched)

**Interfaces:**
- Consumes (Task 1): `startupRetryConfigFromEnv`, `startupRetryDelayMs`, `StartupRetryConfig` from `./startup-retry.js`; `readEnvFile(keys: string[]): Record<string, string>` from `../env.js`.
- Produces:
  - `initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup, options?: InitChannelAdaptersOptions): Promise<void>` — signature extended with an OPTIONAL second parameter; all 7 existing call sites (`src/index.ts:96`, 5 tests, 1 script) compile unchanged.
  - `interface InitChannelAdaptersOptions { env?: NodeJS.ProcessEnv; retryConfig?: StartupRetryConfig; random?: () => number; firstAttemptWaitMs?: number }` — `firstAttemptWaitMs` bounds how long boot blocks per channel's first attempt (default 30000, env `CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS`; 0 = wait forever). A capped attempt keeps running in the background — it is never aborted, so there is no double-attempt risk.
  - `type ChannelStartStatus = 'starting' | 'started' | 'retrying' | 'failed'` — `starting` = first attempt exceeded the boot-wait cap and is still in flight.
  - `interface ChannelStartState { status: ChannelStartStatus; attempt: number; lastError?: string }`
  - `getChannelStartStates(): Map<string, ChannelStartState>` (snapshot copy)
  - `isPermanentStartupError(err: unknown): boolean` — true when an error carries `permanentStartupError: true` (adapter-side marker contract; wired for WhatsApp in Task 2b). Permanent failures report `status: 'failed'` and are NOT retried (validated: Baileys documents halting on logged-out; blind re-login is the ban-risk anti-pattern).
  - Log contract: see "Health-signal log contract" in Global Constraints. On failure with retry pending: WARN `'Failed to start channel adapter, will retry'` + INFO `'Channel adapter status'` (`status: 'retrying'`). ERROR `'Failed to start channel adapter'` fires ONLY when retries are disabled, teardown has begun, or the error is marked permanent (`isPermanentStartupError`). A first attempt that outlives the boot-wait cap logs WARN `'Channel adapter start attempt still pending, continuing boot'` + INFO status (`status: 'starting'`).

- [ ] **Step 1: Write the failing tests**

Create `src/channels/channel-registry-retry.test.ts`:

```ts
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
    expect(infoSpy).toHaveBeenCalledWith('Channel adapter status', { channel: 'health', status: 'started', attempt: 2 });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/channels/channel-registry-retry.test.ts
```

Expected: FAIL — `getChannelStartStates`/`isPermanentStartupError` are not exported / retries never happen (`attempts` stays 1); the boot-wait test fails by TEST TIMEOUT (the current `initChannelAdapters` awaits the hanging factory with no cap).

- [ ] **Step 3: Implement the registry changes**

In `src/channels/channel-registry.ts`:

3a. Add imports (after the existing `import { log } from '../log.js';` and type imports — keep prettier import order):

```ts
import { readEnvFile } from '../env.js';
import { startupRetryConfigFromEnv, startupRetryDelayMs, type StartupRetryConfig } from './startup-retry.js';
```

(Also extend the existing type import to include `ChannelRegistration` if it is not already imported by name — `attemptChannelStart` below needs it.)

3b. Add state + types near the existing `registry`/`activeAdapters` maps (after line 22):

```ts
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
```

3c. Replace the ENTIRE existing `initChannelAdapters` function (currently `src/channels/channel-registry.ts:49-94`, including its doc comment) with:

```ts
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
```

3d. In `teardownChannelAdapters` (currently `:96-107`), add retry cancellation as the FIRST statements of the function body (the rest is unchanged):

```ts
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
```

- [ ] **Step 4: Run the new tests, then the neighboring suites**

```bash
pnpm exec vitest run src/channels/channel-registry-retry.test.ts
pnpm exec vitest run src/channels/channel-registry.test.ts src/modules/approvals/picks.test.ts src/modules/permissions/permissions.test.ts src/modules/scheduling/sync.test.ts
```

Expected: all PASS. (The existing call sites pass no options; defaults come from `.env`/process.env and behavior for succeeding adapters is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add src/channels/channel-registry.ts src/channels/channel-registry-retry.test.ts
git commit -m "feat(channels): retry adapter startup with backoff until it succeeds; emit per-channel status lines"
```

---

### Task 2b: WhatsApp startup-failure safety (no ban-risk retry, no teardown reconnect)

Validated findings this task closes: (1) Baileys documents halting on `DisconnectReason.loggedOut` — blind re-login on stale creds is the community-documented ban-risk anti-pattern (WhiskeySockets/Baileys issues #2075/#1869/#225/#2707) — so the registry must NOT retry a logged-out WhatsApp startup. (2) The current `teardown()` triggers a reconnect: `sock?.end(undefined)` makes Baileys emit a `connection.update` close with `lastDisconnect.error = undefined` BEFORE listeners are removed, so the adapter's close handler computes `shouldReconnect = true` and dials a NEW socket (verified against the vendored Baileys `lib/Socket/socket.js:243-269`; re-verify on any Baileys upgrade). Without this task, the registry's cleanup-before-retry would itself spawn reconnect loops.

**Files:**
- Modify: `src/channels/whatsapp.ts` — the `connection.update` close handler (around `:447-463`), the logged-out `setup()` rejection (around `:465-469` — the `rejectFirstOpen(new Error(...))` call for `DisconnectReason.loggedOut`), and `teardown()` (around `:736-738`). Line anchors verified against the repo on 2026-08-02; re-locate by content if drifted.
- Test: `src/channels/channel-registry-retry.test.ts` already covers the registry side (Task 2's permanent-marker test). `src/channels/whatsapp.test.ts` EXISTS but covers attachment contracts only (no Baileys socket harness) — do NOT build one for this task; direct coverage is Step 3's verification greps plus the full suite staying green.

**Interfaces:**
- Consumes (Task 2): the `permanentStartupError: true` marker contract read by `isPermanentStartupError` in `channel-registry.ts`.
- Produces: behavior only — no signature changes.

- [ ] **Step 1: Guard teardown against reconnect**

Add an adapter-scoped flag (e.g. `let tearingDown = false;` alongside the socket state). In `teardown()`, set `tearingDown = true` BEFORE `sock?.end(...)`. In the `connection.update` close handler, include the flag in the reconnect decision — `const shouldReconnect = !tearingDown && reason !== DisconnectReason.loggedOut;` (adapt to the file's actual variable names) — so teardown can never dial a new socket. Reset `tearingDown = false` at the start of the connect path so a later registry retry can still connect.

- [ ] **Step 2: Mark logged-out startup failures permanent**

At the logged-out `setup()` rejection (≈`:465-469`, where the close handler calls `rejectFirstOpen(new Error(...))` for `DisconnectReason.loggedOut`), attach the marker to the error it already constructs (keep the message and type; adapt to the file's actual variable names — the marker is the contract, not the exact expression):

```ts
rejectFirstOpen(Object.assign(new Error(/* existing message unchanged */), { permanentStartupError: true }));
```

The registry (Task 2) then reports `status="failed"` and never retries — re-pairing is a human operation; blind re-login is the documented ban-risk anti-pattern.

- [ ] **Step 3: Verify**

```bash
grep -n "permanentStartupError" src/channels/whatsapp.ts
grep -n "tearingDown" src/channels/whatsapp.ts
pnpm exec vitest run src/channels
pnpm exec tsc --noEmit
```

Expected: the first grep hits the logged-out rejection; the second hits both the teardown set-site and the close-handler guard; all channel suites PASS (including Task 2's permanent-marker test and every pre-existing whatsapp test); typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add src/channels/whatsapp.ts
git commit -m "fix(whatsapp): no teardown-triggered reconnect; logged-out startup failures are permanent (no ban-risk retry)"
```

(no new test files are expected for this task.)

---

### Task 3: Discord — application-command sync is no longer load-bearing

Incident mechanism (a): the factory `await`s `syncYenteDiscordApplicationCommands` (`src/channels/discord.ts:70`) before the adapter is even constructed; its first REST call (`fetchDiscordApplicationConfig`, GET `/oauth2/applications/@me`) died with `fetch failed` on cold network and killed the whole channel. After this task, only that single config-discovery GET remains load-bearing (and only when env does not supply `DISCORD_APPLICATION_ID` + `DISCORD_PUBLIC_KEY` — Task 2's registry retry covers it); the guild resolution + command clear/register calls move to a background retry loop that can never fail the factory.

**Files:**
- Modify: `src/channels/discord-commands.ts` (append two functions + add the file's first imports)
- Modify: `src/channels/discord.ts` (imports at `:12`; the factory block at `:59-84` — env-read list, command-sync call, `catchupEnv` construction order)
- Test: `src/channels/discord-commands.test.ts` (append two describes)

**Interfaces:**
- Consumes (Task 1): `startupRetryConfigFromEnv`, `startupRetryDelayMs`, `StartupRetryConfig` from `./startup-retry.js`; existing module-local `FetchLike`, `DiscordApplicationConfig`, `fetchDiscordApplicationConfig`, `syncYenteDiscordApplicationCommands`.
- Produces:
  - `syncYenteDiscordApplicationCommandsWithRetry(args: { botToken: string; channelIds: readonly string[]; applicationId: string; publicKey: string; fetchImpl?: FetchLike; retryConfig?: StartupRetryConfig; sleep?: (ms: number) => Promise<void>; random?: () => number; maxAttempts?: number }): Promise<boolean>`
  - `resolveDiscordStartupConfig(args: { botToken: string; channelIds: readonly string[]; applicationId?: string | null; publicKey?: string | null; fetchImpl?: FetchLike; retryConfig?: StartupRetryConfig; sleep?: (ms: number) => Promise<void>; random?: () => number; scheduleCommandSync?: (run: () => Promise<void>) => void }): Promise<DiscordApplicationConfig>` — returns `{ applicationId, publicKey }`; command sync failures NEVER propagate; discovery failures DO throw (registry retries the factory).
  - Behavior change (validated falsifier): `syncYenteDiscordApplicationCommands` now fails a cycle instead of silently under-registering — when any configured channel's guild lookup fails (the non-OK branch that is currently a bare `continue`, `discord-commands.ts:233`), it throws `Discord command sync incomplete: ...` AFTER applying what it could; empty `channelIds` (or zero failures) is still success. The retry wrapper therefore keeps retrying through brownouts instead of declaring victory on partial registration (Step 3b'').
  - Single-flight (validated falsifier): `syncYenteDiscordApplicationCommandsWithRetry` refuses to run concurrently — a module-level in-flight flag makes a duplicate call log a WARN and return `false` — so factory retry attempts / re-inits cannot each spawn an immortal loop.

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/discord-commands.test.ts` (also extend the existing import from `'./discord-commands.js'` with `resolveDiscordStartupConfig, syncYenteDiscordApplicationCommandsWithRetry`, and add `import { log } from '../log.js';` after the vitest import):

```ts
describe('resolveDiscordStartupConfig', () => {
  it('resolves env-provided config immediately without any REST call', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 500 }));
    const scheduled: Array<() => Promise<void>> = [];
    const config = await resolveDiscordStartupConfig({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      scheduleCommandSync: (run) => scheduled.push(run),
    });
    expect(config).toEqual({ applicationId: 'app-123', publicKey: 'k'.repeat(64) });
    expect(fetchImpl).not.toHaveBeenCalled(); // no discovery needed, sync not yet run
    expect(scheduled).toHaveLength(1);
  });

  it('command-sync failures retry in the background and never kill startup (incident shape)', async () => {
    let clearAttempts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/channel-1')) {
        return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), { status: 200 });
      }
      if (url.endsWith('/applications/app-123/commands') && init?.method === 'PUT') {
        clearAttempts += 1;
        if (clearAttempts < 3) throw new TypeError('fetch failed'); // cold network at boot
        return new Response('[]', { status: 200 });
      }
      if (url.endsWith('/applications/app-123/guilds/guild-1/commands') && init?.method === 'PUT') {
        return new Response('[]', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    let syncDone: Promise<void> = Promise.resolve();
    const config = await resolveDiscordStartupConfig({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [5000, 15000], capMs: 30000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      scheduleCommandSync: (run) => {
        syncDone = run(); // deterministic: awaiting the loop also releases the single-flight flag
      },
    });
    expect(config.applicationId).toBe('app-123'); // startup config resolved despite sync failures
    await syncDone;
    expect(clearAttempts).toBe(3);
    expect(sleeps).toEqual([5000, 15000]); // backoff ladder honored
  });

  it('still throws when config discovery itself fails (registry retries the factory)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(resolveDiscordStartupConfig({ botToken: 'bot-token', channelIds: [], fetchImpl })).rejects.toThrow(
      'fetch failed',
    );
  });
});

describe('syncYenteDiscordApplicationCommandsWithRetry', () => {
  it('gives up with an ERROR only when retries are disabled', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: true, delaysMs: [1], capMs: 1, jitterRatio: 0 },
    });
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Discord command sync failed permanently',
      expect.objectContaining({ attempt: 1 }),
    );
    errorSpy.mockRestore();
  });

  it('stops after maxAttempts when set', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [100], capMs: 100, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });
    expect(ok).toBe(false);
    expect(sleeps).toEqual([100, 100]); // slept between attempts 1->2 and 2->3
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('keeps retrying while guild resolution is incomplete (brownout partial-registration shape)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let channelLookups = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/channels/channel-1')) {
        channelLookups += 1;
        if (channelLookups === 1) return new Response('upstream unavailable', { status: 502 }); // brownout
        return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1' }), { status: 200 });
      }
      if (init?.method === 'PUT') return new Response('[]', { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    const sleeps: number[] = [];
    const ok = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: ['channel-1'],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [5000], capMs: 5000, jitterRatio: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(ok).toBe(true);
    expect(channelLookups).toBe(2); // partial resolution = failed cycle, retried until complete
    expect(sleeps).toEqual([5000]);
    warnSpy.mockRestore();
  });

  it('single-flights the loop: a duplicate call while one is in flight returns false without syncing', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    let sleepCalls = 0;
    let releaseSleep: () => void = () => {};
    const first = syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: false, delaysMs: [100], capMs: 100, jitterRatio: 0 },
      sleep: () =>
        new Promise((resolve) => {
          sleepCalls += 1;
          releaseSleep = resolve; // parks the loop between attempts
        }),
      maxAttempts: 2,
    });
    const second = await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: 'bot-token',
      channelIds: [],
      applicationId: 'app-123',
      publicKey: 'k'.repeat(64),
      fetchImpl,
      retryConfig: { disabled: true, delaysMs: [1], capMs: 1, jitterRatio: 0 },
    });
    expect(second).toBe(false); // refused immediately: a loop is already active
    expect(warnSpy).toHaveBeenCalledWith('Discord command sync already in flight, skipping duplicate');
    await vi.waitFor(() => expect(sleepCalls).toBe(1));
    releaseSleep();
    await expect(first).resolves.toBe(false); // original loop exhausts maxAttempts as usual
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/channels/discord-commands.test.ts
```

Expected: FAIL — `resolveDiscordStartupConfig` / `syncYenteDiscordApplicationCommandsWithRetry` are not exported.

- [ ] **Step 3: Implement in `src/channels/discord-commands.ts`**

3a. The file currently has ZERO imports (it begins with `const DISCORD_API_BASE = ...` at line 1). Add at the very top:

```ts
import { log } from '../log.js';
import { startupRetryConfigFromEnv, startupRetryDelayMs, type StartupRetryConfig } from './startup-retry.js';
```

(No import cycle: `startup-retry.ts` imports only `../log.js`.)

3b. Append at the end of the file:

```ts
let commandSyncLoopActive = false;

/**
 * Background application-command sync with backoff — command sync must never
 * be load-bearing for Discord adapter startup (2026-08-02: a pre-connect
 * REST call died on cold network and killed the whole channel). Retries
 * until it succeeds; returns false only when retries are disabled or
 * maxAttempts is exhausted. Never throws. SINGLE-FLIGHT: one loop per
 * process — a duplicate call while one is active logs a WARN and returns
 * false (validated: without this, every factory retry attempt / re-init
 * would spawn another immortal loop).
 */
export async function syncYenteDiscordApplicationCommandsWithRetry(args: {
  botToken: string;
  channelIds: readonly string[];
  applicationId: string;
  publicKey: string;
  fetchImpl?: FetchLike;
  retryConfig?: StartupRetryConfig;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
}): Promise<boolean> {
  if (commandSyncLoopActive) {
    log.warn('Discord command sync already in flight, skipping duplicate');
    return false;
  }
  commandSyncLoopActive = true;
  const retryConfig = args.retryConfig ?? startupRetryConfigFromEnv(process.env, 'DISCORD_COMMAND_SYNC_RETRY');
  const sleep =
    args.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const random = args.random ?? Math.random;
  const maxAttempts = args.maxAttempts ?? 0; // 0 = retry forever
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await syncYenteDiscordApplicationCommands({
          botToken: args.botToken,
          channelIds: args.channelIds,
          applicationId: args.applicationId,
          publicKey: args.publicKey,
          fetchImpl: args.fetchImpl,
        });
        log.info('Discord command sync complete', { attempt });
        return true;
      } catch (err) {
        if (retryConfig.disabled || (maxAttempts > 0 && attempt >= maxAttempts)) {
          log.error('Discord command sync failed permanently', { attempt, err });
          return false;
        }
        const retryInMs = startupRetryDelayMs(retryConfig, attempt, random);
        log.warn('Discord command sync failed, will retry', { attempt, retryInMs, err });
        await sleep(retryInMs);
      }
    }
  } finally {
    commandSyncLoopActive = false;
  }
}

/**
 * Resolve the application config needed to construct the Discord adapter,
 * then kick off command sync in the background. Only config discovery (one
 * REST GET, skipped entirely when applicationId+publicKey come from env)
 * can throw — command sync failures never propagate to the caller.
 */
export async function resolveDiscordStartupConfig(args: {
  botToken: string;
  channelIds: readonly string[];
  applicationId?: string | null;
  publicKey?: string | null;
  fetchImpl?: FetchLike;
  retryConfig?: StartupRetryConfig;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  scheduleCommandSync?: (run: () => Promise<void>) => void;
}): Promise<DiscordApplicationConfig> {
  const discovered =
    args.applicationId && args.publicKey
      ? { applicationId: args.applicationId, publicKey: args.publicKey }
      : await fetchDiscordApplicationConfig({ botToken: args.botToken, fetchImpl: args.fetchImpl });
  const runSync = async (): Promise<void> => {
    await syncYenteDiscordApplicationCommandsWithRetry({
      botToken: args.botToken,
      channelIds: args.channelIds,
      applicationId: discovered.applicationId,
      publicKey: discovered.publicKey,
      fetchImpl: args.fetchImpl,
      retryConfig: args.retryConfig,
      sleep: args.sleep,
      random: args.random,
    });
  };
  const schedule = args.scheduleCommandSync ?? ((run: () => Promise<void>) => void run());
  schedule(runSync);
  return discovered;
}
```

3b''. Harden guild resolution for the retry era (validated falsifier: a "resolved" sync could silently under-register). The per-channel non-OK branch in `resolveDiscordGuildIdsForChannels` is currently a bare `continue` (verified at `discord-commands.ts:233`). Extend the helper BACKWARD-COMPATIBLY with an optional collector parameter — its return type and existing pins (e.g. the `['guild-1']` assertion) stay intact:

```ts
// resolveDiscordGuildIdsForChannels(...existing params..., failedChannelIds?: string[])
// in the non-OK / thrown-fetch branch (currently a bare `continue`):
failedChannelIds?.push(channelId);
continue;
```

Then in `syncYenteDiscordApplicationCommands` (adapt names to the actual parameter list):

```ts
const failedChannelIds: string[] = [];
const guildIds = await resolveDiscordGuildIdsForChannels(/* existing args */, failedChannelIds);
// ... perform the clear/register PUTs it can, as today ...
if (failedChannelIds.length > 0) {
  throw new Error(`Discord command sync incomplete: guild resolution failed for ${failedChannelIds.join(', ')}`);
}
```

so the retry wrapper treats the cycle as failed and retries. Keep empty `channelIds` (and zero-resolved-with-zero-failures) as success. Rate-limit note (validated against Discord docs): the 200-creates/day/guild limit counts only NEW commands — an idempotent re-PUT of an unchanged set consumes nothing, so retry-until-complete is safe. Check existing `discord-commands.test.ts` pins: any test asserting the old silent-partial-success must be updated deliberately (that swallow is the falsified behavior this step removes).

3c. Wire the factory in `src/channels/discord.ts`:

- Change the import at line 12 from `import { syncYenteDiscordApplicationCommands } from './discord-commands.js';` to:

```ts
import { resolveDiscordStartupConfig } from './discord-commands.js';
import { startupRetryConfigFromEnv } from './startup-retry.js';
```

- Extend the factory's `readEnvFile([...])` list (`:46-58`) with four keys:

```ts
      'DISCORD_COMMAND_SYNC_RETRY_DISABLED',
      'DISCORD_COMMAND_SYNC_RETRY_DELAYS_MS',
      'DISCORD_COMMAND_SYNC_RETRY_CAP_MS',
      'DISCORD_COMMAND_SYNC_RETRY_JITTER',
```

- Replace ONLY the `const commandSync = await syncYenteDiscordApplicationCommands({ ... });` statement (currently `:70-75`; the `createDiscordAdapter({...})` call that follows it stays exactly where it is) with — note `catchupEnv`/`catchupConfig` move ABOVE the call so the retry tunables honor the house `.env`/process.env precedence:

```ts
    // Catch-up wiring. For env-file keys, process.env wins (house precedence);
    // note: spread order makes process.env values override file values, but
    // only for keys present in process.env — matching the `process.env.X || env.X`
    // pattern used above for the other Discord keys.
    const catchupEnv: NodeJS.ProcessEnv = { ...env, ...process.env };
    const catchupConfig = discordCatchupConfigFromEnv(catchupEnv);
    // Application-command sync is deliberately NOT load-bearing: only config
    // discovery (skipped when env provides app id + public key) can throw —
    // and the registry's startup retry covers that. The sync itself runs in
    // the background with its own backoff (2026-08-02 outage class).
    const commandSync = await resolveDiscordStartupConfig({
      botToken,
      applicationId: process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID,
      publicKey: process.env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY,
      channelIds: getRegisteredDiscordChannelIds(),
      retryConfig: startupRetryConfigFromEnv(catchupEnv, 'DISCORD_COMMAND_SYNC_RETRY'),
    });
```

- Then DELETE the now-duplicated original lines that still sit AFTER the `createDiscordAdapter({...})` call (currently `:81-86`): the four-line "Catch-up wiring." comment plus `const catchupEnv: NodeJS.ProcessEnv = { ...env, ...process.env };` and `const catchupConfig = discordCatchupConfigFromEnv(catchupEnv);`. Net effect: `catchupEnv`/`catchupConfig` are computed once, above `resolveDiscordStartupConfig`; the `createDiscordAdapter` call sits untouched between the two edit sites.

Everything downstream is unchanged — `createDiscordAdapter({ botToken, publicKey: ... || commandSync.publicKey, applicationId: ... || commandSync.applicationId })` still typechecks because `resolveDiscordStartupConfig` returns `DiscordApplicationConfig`, and later uses of `catchupConfig`/`catchupEnv` (e.g. `wrapYenteDiscordChannelIds` options, `createDiscordCatchup` env) resolve to the earlier, identical definitions.

- [ ] **Step 4: Run the tests**

```bash
pnpm exec vitest run src/channels/discord-commands.test.ts src/channels/discord.test.ts
pnpm exec tsc --noEmit
```

Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord-commands.ts src/channels/discord-commands.test.ts src/channels/discord.ts
git commit -m "feat(discord): decouple application-command sync from adapter startup with background retry"
```

---

### Task 4: AgentMail — OneCLI env setup becomes retryable

Incident mechanism (b): `start.sh` produces the OneCLI proxy env exactly once at boot via `eval "$(node $NANOCLAW_ROOT/agentmail-onecli-env.mjs --shell)"`; when that fetch chain failed on cold network, nanoclaw booted proxy-less and `requireAgentMailOneCliProxyEnv` (`src/channels/agentmail.ts:514-525`) hard-failed the factory forever. Fix: the factory re-runs the SAME ops script (JSON mode) on each registry retry. `NODE_EXTRA_CA_CERTS` and `NODE_USE_ENV_PROXY` are startup-only Node options — VALIDATED by experiment (late-set CA is ignored; the env-proxy config is read once at first use; a late-set flag is a no-op) — so a successful LATE acquisition exits(1) deliberately and systemd relaunches nanoclaw through `start.sh`, whose eval now succeeds. `Restart=on-failure` / `RestartSec=5` is VERIFIED ACTIVE on the live host (2026-08-02 `systemctl show`; the only drop-in is an additive `OnFailure=` pager). Design note (validated): an in-process alternative DOES exist — runtime `setGlobalDispatcher(ProxyAgent{requestTls.ca})` plus `ws` `{agent, ca}` injection was proven to work — but it is deliberately REJECTED: it swaps the dispatcher under every fetch in the process, `EnvHttpProxyAgent` snapshots env at construction, npm↔bundled undici compatibility is fragile across upgrades, and the ws plumbing would modify `agentmail-api.ts`, which this plan keeps untouched. Exit-for-restart is the smaller-blast-radius choice, not a necessity. Preflight shape is untouched: `createAgentMailAdapter` keeps its synchronous throws and the pinned tests at `agentmail.test.ts:117-137` pass unmodified.

**Files:**
- Create: `src/channels/agentmail-onecli.ts`
- Modify: `src/channels/agentmail.ts` (imports at `:1-40`; the registration line at `:512`)
- Test: `src/channels/agentmail-onecli.test.ts` (new), `src/channels/agentmail.test.ts` (append one describe)

**Interfaces:**
- Consumes: `NANOCLAW_ROOT` from `../config.js` (`export const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || '/srv/nanoclaw';`, `src/config.ts:65`); `log`; node `child_process`/`fs`/`util`.
- Produces:
  - `type AgentMailOneCliEnvResult = 'disabled' | 'present' | 'acquired' | 'failed'`
  - `ensureAgentMailOneCliEnv(env: NodeJS.ProcessEnv, deps?: { runScript?: RunOneCliEnvScript; fileExists?: (path: string) => boolean }): Promise<AgentMailOneCliEnvResult>` — NEVER throws; on `'acquired'` it has `Object.assign`ed the script's JSON output into `env`.
  - `type RunOneCliEnvScript = (scriptPath: string, timeoutMs: number) => Promise<string>`
  - `hasAgentMailOneCliProxyEnv(env: NodeJS.ProcessEnv): boolean` — non-throwing mirror of `requireAgentMailOneCliProxyEnv`.
  - In `agentmail.ts`: `agentMailChannelFactory(deps?: { env?: NodeJS.ProcessEnv; ensureEnv?: typeof ensureAgentMailOneCliEnv; exit?: (code: number) => void; createAdapter?: typeof createAgentMailAdapter }): Promise<ChannelAdapter | null>` — the new registration factory.

- [ ] **Step 1: Write the failing unit tests**

Create `src/channels/agentmail-onecli.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import { ensureAgentMailOneCliEnv, hasAgentMailOneCliProxyEnv } from './agentmail-onecli.js';

const ACQUIRED_ENV = {
  HTTPS_PROXY: 'http://user:pass@127.0.0.1:8443',
  HTTP_PROXY: 'http://user:pass@127.0.0.1:8443',
  https_proxy: 'http://user:pass@127.0.0.1:8443',
  http_proxy: 'http://user:pass@127.0.0.1:8443',
  AGENTMAIL_ONECLI_ENV_READY: '1',
  NODE_EXTRA_CA_CERTS: '/srv/nanoclaw/shared/agentmail/onecli-gateway-ca.pem',
  NODE_USE_ENV_PROXY: '1',
};

describe('ensureAgentMailOneCliEnv', () => {
  it('is a no-op when AgentMail is disabled', async () => {
    const runScript = vi.fn();
    await expect(ensureAgentMailOneCliEnv({}, { runScript })).resolves.toBe('disabled');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('is a no-op when the proxy env is already present (start.sh eval worked)', async () => {
    const runScript = vi.fn();
    const env = { AGENTMAIL_ENABLED: '1', ...ACQUIRED_ENV };
    await expect(ensureAgentMailOneCliEnv(env, { runScript })).resolves.toBe('present');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('runs the script and applies the acquired env', async () => {
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1', AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs' };
    const runScript = vi.fn(async () => JSON.stringify(ACQUIRED_ENV));
    await expect(ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true })).resolves.toBe('acquired');
    expect(runScript).toHaveBeenCalledWith('/srv/x/env.mjs', 30000);
    expect(env.HTTPS_PROXY).toBe(ACQUIRED_ENV.HTTPS_PROXY);
    expect(hasAgentMailOneCliProxyEnv(env)).toBe(true);
  });

  it('honors AGENTMAIL_ONECLI_ENV_TIMEOUT_MS', async () => {
    const env: NodeJS.ProcessEnv = {
      AGENTMAIL_ENABLED: '1',
      AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs',
      AGENTMAIL_ONECLI_ENV_TIMEOUT_MS: '5000',
    };
    const runScript = vi.fn(async () => JSON.stringify(ACQUIRED_ENV));
    await ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true });
    expect(runScript).toHaveBeenCalledWith('/srv/x/env.mjs', 5000);
  });

  it('returns failed and leaves env untouched when the script fails (cold network)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1', AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs' };
    const runScript = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true })).resolves.toBe('failed');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'AgentMail OneCLI env acquisition failed, adapter start will be retried',
      expect.objectContaining({ scriptPath: '/srv/x/env.mjs' }),
    );
    warnSpy.mockRestore();
  });

  it('returns failed when the script path does not exist', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1' };
    await expect(ensureAgentMailOneCliEnv(env, { fileExists: () => false })).resolves.toBe('failed');
    warnSpy.mockRestore();
  });

  it('returns failed on non-JSON stdout', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1', AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs' };
    const runScript = vi.fn(async () => 'export FOO=bar');
    await expect(ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true })).resolves.toBe('failed');
    warnSpy.mockRestore();
  });
});
```

And append to `src/channels/agentmail.test.ts` (add `agentMailChannelFactory` to the existing import from `'./agentmail.js'`; do NOT modify any existing test):

```ts
describe('agentMailChannelFactory', () => {
  it('propagates the unchanged preflight error when env acquisition fails (registry retries)', async () => {
    await expect(
      agentMailChannelFactory({
        env: { ...BASE_AGENTMAIL_ENV },
        ensureEnv: async () => 'failed' as const,
      }),
    ).rejects.toThrow('AgentMail requires OneCLI proxy env');
  });

  it('exits for a systemd restart when the env is acquired late (startup-only Node options)', async () => {
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    });
    await expect(
      agentMailChannelFactory({
        env: { ...BASE_AGENTMAIL_ENV },
        ensureEnv: async () => 'acquired' as const,
        exit,
      }),
    ).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('continues in-process when exit-on-acquire is disabled', async () => {
    const createAdapter = vi.fn(() => null);
    const env = { ...BASE_AGENTMAIL_ENV, AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE: '0' };
    await expect(
      agentMailChannelFactory({ env, ensureEnv: async () => 'acquired' as const, createAdapter }),
    ).resolves.toBeNull();
    expect(createAdapter).toHaveBeenCalledWith({ env });
  });

  it('returns null untouched when AgentMail is disabled', async () => {
    await expect(agentMailChannelFactory({ env: {}, ensureEnv: async () => 'disabled' as const })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/channels/agentmail-onecli.test.ts src/channels/agentmail.test.ts
```

Expected: FAIL — module `./agentmail-onecli.js` not found; `agentMailChannelFactory` not exported.

- [ ] **Step 3: Implement**

3a. Create `src/channels/agentmail-onecli.ts`:

```ts
/**
 * Runtime acquisition of the AgentMail OneCLI proxy env.
 *
 * Production boots get this env from start.sh (ops repo):
 *   eval "$(node $NANOCLAW_ROOT/agentmail-onecli-env.mjs --shell)"
 * That eval is one-shot: when it fails (cold network at boot, 2026-08-02),
 * nanoclaw runs proxy-less and the AgentMail factory hard-fails forever.
 * This module lets the factory re-run the same script (JSON output mode) on
 * each startup retry, so AgentMail recovers as soon as OneCLI is reachable.
 *
 * It never throws: on failure the existing preflight
 * (requireAgentMailOneCliProxyEnv in agentmail.ts — shape unchanged) still
 * throws its usual error, which feeds the channel-registry startup retry.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import { NANOCLAW_ROOT } from '../config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

export type AgentMailOneCliEnvResult = 'disabled' | 'present' | 'acquired' | 'failed';

export type RunOneCliEnvScript = (scriptPath: string, timeoutMs: number) => Promise<string>;

const DEFAULT_ONECLI_ENV_TIMEOUT_MS = 30_000;

const defaultRunScript: RunOneCliEnvScript = async (scriptPath, timeoutMs) => {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { timeout: timeoutMs });
  return stdout;
};

/** Non-throwing mirror of requireAgentMailOneCliProxyEnv (agentmail.ts:514-525). */
export function hasAgentMailOneCliProxyEnv(env: NodeJS.ProcessEnv): boolean {
  const proxy = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim();
  return Boolean(proxy) && env.NODE_USE_ENV_PROXY === '1' && Boolean(env.NODE_EXTRA_CA_CERTS?.trim());
}

export async function ensureAgentMailOneCliEnv(
  env: NodeJS.ProcessEnv,
  deps: { runScript?: RunOneCliEnvScript; fileExists?: (path: string) => boolean } = {},
): Promise<AgentMailOneCliEnvResult> {
  if (env.AGENTMAIL_ENABLED !== '1') return 'disabled';
  if (hasAgentMailOneCliProxyEnv(env)) return 'present';

  const scriptPath =
    env.AGENTMAIL_ONECLI_ENV_SCRIPT?.trim() || `${env.NANOCLAW_ROOT || NANOCLAW_ROOT}/agentmail-onecli-env.mjs`;
  const fileExists = deps.fileExists ?? fs.existsSync;
  if (!fileExists(scriptPath)) {
    log.warn('AgentMail OneCLI env script not found, skipping acquisition', { scriptPath });
    return 'failed';
  }

  let timeoutMs = DEFAULT_ONECLI_ENV_TIMEOUT_MS;
  const timeoutRaw = env.AGENTMAIL_ONECLI_ENV_TIMEOUT_MS?.trim();
  if (timeoutRaw) {
    const parsed = Number(timeoutRaw);
    if (Number.isInteger(parsed) && parsed > 0) timeoutMs = parsed;
    else log.warn('Ignoring malformed AGENTMAIL_ONECLI_ENV_TIMEOUT_MS', { value: timeoutRaw });
  }

  const runScript = deps.runScript ?? defaultRunScript;
  try {
    const stdout = await runScript(scriptPath, timeoutMs);
    const acquired = JSON.parse(stdout) as Record<string, string>;
    Object.assign(env, acquired);
    log.info('AgentMail OneCLI env acquired', { scriptPath, keys: Object.keys(acquired).sort() });
    return 'acquired';
  } catch (err) {
    log.warn('AgentMail OneCLI env acquisition failed, adapter start will be retried', { scriptPath, err });
    return 'failed';
  }
}
```

3b. In `src/channels/agentmail.ts`, add the import (with the other `./` sibling imports around line 40):

```ts
import { ensureAgentMailOneCliEnv } from './agentmail-onecli.js';
```

3c. Replace the registration line `registerChannelAdapter('agentmail', { factory: () => createAgentMailAdapter() });` (currently `:512`) with:

```ts
/**
 * Registration factory: acquire the OneCLI proxy env if it's missing, then
 * build the adapter. NODE_EXTRA_CA_CERTS and NODE_USE_ENV_PROXY are
 * startup-only Node options — a process that booted without them cannot
 * apply them at runtime (validated; an in-process undici/ws re-injection
 * alternative was proven possible and deliberately rejected — see the
 * Task 4 rationale in the plan) — so a successful LATE acquisition exits(1)
 * deliberately: systemd (Restart=on-failure, RestartSec=5 — verified active
 * on the live host) relaunches
 * nanoclaw through start.sh, whose env eval now succeeds against the
 * healthy network. This is the missing self-termination path from the
 * 2026-08-02 incident. Preflight shape is unchanged: on acquisition
 * failure, createAgentMailAdapter throws its usual errors and the
 * channel-registry startup retry re-runs this whole factory.
 */
export async function agentMailChannelFactory(
  deps: {
    env?: NodeJS.ProcessEnv;
    ensureEnv?: typeof ensureAgentMailOneCliEnv;
    exit?: (code: number) => void;
    createAdapter?: typeof createAgentMailAdapter;
  } = {},
): Promise<ChannelAdapter | null> {
  const env = deps.env ?? process.env;
  const ensureEnv = deps.ensureEnv ?? ensureAgentMailOneCliEnv;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const createAdapter = deps.createAdapter ?? createAgentMailAdapter;

  const result = await ensureEnv(env);
  if (result === 'acquired' && env.AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE !== '0') {
    log.fatal(
      'AgentMail OneCLI env acquired after boot; exiting so systemd restarts nanoclaw with NODE_EXTRA_CA_CERTS/NODE_USE_ENV_PROXY applied',
    );
    exit(1);
  }
  return createAdapter(deps.env ? { env } : {});
}

registerChannelAdapter('agentmail', { factory: () => agentMailChannelFactory() });
```

- [ ] **Step 4: Run the tests**

```bash
pnpm exec vitest run src/channels/agentmail-onecli.test.ts src/channels/agentmail.test.ts
pnpm exec tsc --noEmit
```

Expected: all PASS (including the pre-existing preflight pins, unmodified); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/channels/agentmail-onecli.ts src/channels/agentmail-onecli.test.ts src/channels/agentmail.ts src/channels/agentmail.test.ts
git commit -m "feat(agentmail): acquire OneCLI proxy env at adapter start; exit for systemd restart on late acquisition"
```

---

### Task 5: Prove late-start catch-up fires (end-to-end story)

The chain to prove: registry retry re-runs the FULL factory + `setup()` → the bridge fires `onGatewayWebhookReady` inside `setup()` (`src/channels/discord.ts:101-110`, `chat-sdk-bridge.ts:552-558`) → `catchup.start()` → `runOnce('startup')` recovers the durable-cursor gap. Two tests close the two untested links: (a) the registry re-runs setup fully on a late attempt (arming hook fires exactly once, on the successful attempt); (b) a `'startup'`-reason run recovers messages past an existing cursor — today only `'periodic'` is proven to do that (`discord-catchup.test.ts:185-199`); the `'startup'` test at `:173-183` only covers cursor initialization.

**Files:**
- Modify: `src/channels/channel-registry-retry.test.ts` (append one test)
- Modify: `src/channels/discord-catchup.test.ts` (append one test inside `describe('createDiscordCatchup runOnce', ...)` — production code untouched)

**Interfaces:**
- Consumes: Task 2's registry behavior; existing in-file helpers of `discord-catchup.test.ts` (`fakeTransport` at `:99-149`, `makeEngine` at `:153-163`, `restMessage`/`json` at `:79-97`, `CHANNEL_INFO` at `:151`) and existing imports (`advanceDiscordChannelCursor`, `getDiscordChannelCursor` are already imported at `:14-26`).
- Produces: test coverage only — no production code changes in this task.

- [ ] **Step 1: Add the registry-level arming test**

Append inside the `describe('channel adapter startup retry', ...)` block of `src/channels/channel-registry-retry.test.ts` (reuses the file's `freshRegistry`, `mockAdapter`, `TEST_RETRY` helpers from Task 2):

```ts
  it('re-runs the full factory + setup on retry, so a late adapter arms catch-up exactly once', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await freshRegistry();
    const readyHookFiredOnAttempt: number[] = [];
    let factoryCalls = 0;
    registerChannelAdapter('late-discord', {
      factory: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) throw new TypeError('fetch failed'); // pre-connect REST death (incident shape)
        const adapter = mockAdapter('late-discord');
        const realSetup = adapter.setup.bind(adapter);
        adapter.setup = async (config) => {
          await realSetup(config);
          // Stands in for onGatewayWebhookReady -> catchup.start(): the bridge
          // fires it inside setup(), so a full re-run must re-arm catch-up.
          readyHookFiredOnAttempt.push(factoryCalls);
        };
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
    expect(readyHookFiredOnAttempt).toHaveLength(0); // first attempt died before setup

    await vi.advanceTimersByTimeAsync(5000);
    expect(readyHookFiredOnAttempt).toEqual([2]); // armed exactly once, on the successful late attempt
    expect(getActiveAdapters().some((a) => a.channelType === 'late-discord')).toBe(true);
  });
```

- [ ] **Step 2: Add the `'startup'`-reason gap-recovery test**

Append inside `describe('createDiscordCatchup runOnce', ...)` in `src/channels/discord-catchup.test.ts`, directly after the test at `:185-199` ("fetches after the cursor ascending..."). It mirrors that test's fixtures exactly, changing only the trigger reason — this is what a late-started adapter runs first:

```ts
  it("recovers the cursor gap on the 'startup' run (late adapter start, 2026-08-02 shape)", async () => {
    // The adapter finally starts hours after messages 501/502 arrived; the
    // durable cursor is behind the channel head. The immediate startup run
    // must recover the gap — same guarantee as 'periodic', proven for the
    // reason a late-starting adapter actually fires first.
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      'messages?after=': [json([restMessage('502'), restMessage('501')]), json([])],
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('startup');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['501', '502']); // gap recovered, ascending
    expect(summary?.routed).toBe(2);
    expect(getDiscordChannelCursor('chan-1')).toBe('502'); // durable cursor advanced
  });
```

- [ ] **Step 3: Run the tests**

```bash
pnpm exec vitest run src/channels/channel-registry-retry.test.ts src/channels/discord-catchup.test.ts
```

Expected: all PASS (the two new tests plus every pre-existing catch-up test — proving catch-up semantics are untouched).

- [ ] **Step 4: Commit**

```bash
git add src/channels/channel-registry-retry.test.ts src/channels/discord-catchup.test.ts
git commit -m "test(channels): prove late-start catch-up fires after startup retry"
```

---

### Task 6: Deploy notes — verified systemd reality + tunables (shapiroserver2 changes documented, NOT applied)

`nanoclaw.service` lives in the shapiroserver2 repo (`/home/dan/code/shapiroserver2/srv/nanoclaw/nanoclaw.service`), not in this repo. Validation (2026-08-02, read-only ssh to the live host) FALSIFIED the original premise of this task — the ordering directives are already present and vacuous on this host — so the notes now document the verified host-side state, the corrected residual-risk model, and the new tunables. No unit change ships. Do NOT touch that repo or the live host from this worktree.

**Files:**
- Create: `docs/plans/2026-08-02-channel-adapter-startup-resilience-deploy-notes.md`

**Interfaces:**
- Consumes: the env table from this plan's Global Constraints; the AgentMail exit-for-restart behavior from Task 4.
- Produces: a standalone artifact the deploy step reads.

- [ ] **Step 1: Write the deploy notes**

Create `docs/plans/2026-08-02-channel-adapter-startup-resilience-deploy-notes.md` with exactly this content:

````markdown
# Deploy notes — channel adapter startup resilience (2026-08-02 outage class)

Runtime changes ship in danshapiro/nanoclaw (branch overlay/shapiroserver2).
The notes below record the VERIFIED host-side state (2026-08-02, read-only
ssh) and what the deploy step must (and must not) do. The in-runtime startup
retry is the real fix; no systemd unit change is required.

## 1. systemd unit — verified state; NO ordering change required

File: `srv/nanoclaw/nanoclaw.service` (deployed at `/etc/systemd/system/nanoclaw.service`)

The original plan called for adding `After/Wants=network-online.target`.
Validation (2026-08-02, read-only ssh to the live host) falsified that
premise on both halves:

- the live unit (and the repo unit since commit `29c5472`, 2026-03-26)
  ALREADY carries both directives — they were present through the incident;
- they are VACUOUS on this host: `systemd-networkd-wait-online.service` is
  skipped ("start condition unmet" — observed at the 2026-08-02 09:55:25
  incident reboot itself), so `network-online.target` was reached at 2.019 s,
  4 ms after `network.target`.

So: no unit change. The runtime startup retry (Tasks 1–2) is the actual fix
for the cold-network window. OPTIONAL host-side hardening, only if desired
later: make a wait-online service actually run — that is generator/netplan
level work (satisfying the service's start condition), NOT a unit `Wants=`
edit; investigate on the host before relying on it.

Keep `Restart=on-failure` / `RestartSec=5` unchanged — VERIFIED ACTIVE live
(`systemctl show`: `Restart=on-failure`, `RestartUSec=5s`; sole drop-in
`10-discord-onfailure.conf` is an additive `OnFailure=` pager only). The
AgentMail late-acquisition path DEPENDS on it: when the runtime acquires the
OneCLI env after boot, it logs
`AgentMail OneCLI env acquired after boot; exiting so systemd restarts nanoclaw ...`
and exits(1) so start.sh's env eval re-runs against the healthy network. The
deploy step should re-assert unit parity (repo unit == `systemctl cat
nanoclaw`) whenever it ships this feature.

Residual risk — CORRECTED by validation (the previous "until systemd's
start-limit backoff engages" wording was FALSE): if start.sh's eval
persistently fails while the in-process script succeeds — which requires a
start.sh bug, since both run the same code path — the exit(1)/restart loop is
NOT bounded. With the live values (`StartLimitBurst=5`,
`StartLimitIntervalSec=10`, `RestartSec=5`, systemd 255) the start limit is
mathematically unreachable (≤3 starts fit in any 10 s window), so the unit
never enters `failed` state, NO backoff engages, the loop churns silently
forever — and the host's `OnFailure=discord-notify@%N` pager never fires for
this class. Detector: repeated `AgentMail OneCLI env acquired after boot`
fatal lines across restarts in `journalctl -u nanoclaw`. Break the loop with
`AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE=0`.

## 2. New runtime env tunables (all optional; defaults ship correct behavior)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHANNEL_STARTUP_RETRY_DISABLED` | `0` | `1` restores legacy single-attempt startup |
| `CHANNEL_STARTUP_RETRY_DELAYS_MS` | `5000,15000,45000,120000,300000` | backoff ladder |
| `CHANNEL_STARTUP_RETRY_CAP_MS` | `300000` | repeat delay after ladder, forever |
| `CHANNEL_STARTUP_RETRY_JITTER` | `0.2` | additive jitter ratio 0..1 |
| `CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS` | `30000` | max ms boot blocks per channel's first start attempt (`0` = wait forever); capped attempts keep running in the background |
| `DISCORD_COMMAND_SYNC_RETRY_{DISABLED,DELAYS_MS,CAP_MS,JITTER}` | same | background command-sync knobs |
| `AGENTMAIL_ONECLI_ENV_SCRIPT` | `${NANOCLAW_ROOT}/agentmail-onecli-env.mjs` | env script the runtime re-runs |
| `AGENTMAIL_ONECLI_ENV_TIMEOUT_MS` | `30000` | script timeout |
| `AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE` | `1` | `0` = never exit-for-restart on late acquisition |

## 3. Health signal for host-side detectors

Every channel state transition emits one INFO line (INFO verified visible in
the live journal — the running service already logs INFO-level lines):

```
Channel adapter status channel="discord" status="retrying" attempt=3 lastError="fetch failed" retryInMs=45000
Channel adapter status channel="discord" status="started" attempt=4
Channel adapter status channel="whatsapp" status="starting" attempt=1
Channel adapter status channel="whatsapp" status="failed" attempt=1 lastError="..."
```

Detector recipe: `journalctl -u nanoclaw | grep 'Channel adapter status'` —
`status="retrying"` means degraded-but-self-healing; `status="starting"`
means a first attempt exceeded the boot-wait cap and is still in flight;
`status="failed"` is permanent (retries disabled, shutdown, or an error
marked permanent — e.g. WhatsApp logged out, where human re-pairing is
required). IMPORTANT semantics (validated): `status="started"` means
`setup()` RESOLVED — for discord it does NOT prove the gateway connected or
the token is valid (login is fire-and-forget), and for agentmail it does NOT
prove the socket opened. It is a startup-progress signal, not a connectivity
probe. The legacy ERROR `Failed to start channel adapter` now indicates a
PERMANENT failure only (retries disabled, shutdown, or permanent-marked
error); during retries the same words appear as WARN
`Failed to start channel adapter, will retry`.

Known pre-existing limitation (out of scope, documented for operators):
outbound deliveries drained while a channel is down are dropped and marked
delivered (`src/index.ts:175-178` → `delivery.ts:349-350`); this plan
SHRINKS that window (channels come back on their own) but does not remove
the path.
````

- [ ] **Step 2: Commit**

```bash
git add docs/plans/2026-08-02-channel-adapter-startup-resilience-deploy-notes.md
git commit -m "docs: deploy notes for channel startup resilience (systemd ordering + env tunables)"
```

---

### Task 7: Full verification sweep

**Files:**
- Modify: only whatever the checks below flag (formatting fixes at most).

**Interfaces:** none — this is the CI-equivalent gate (CI runs format:check → host typecheck → container typecheck → vitest → bun test; no lint in CI, but run it anyway since `preserve-caught-error` is an error locally).

- [ ] **Step 1: Format, lint, typecheck**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/channel-adapter-startup-resilience
pnpm run format:check || pnpm run format
pnpm run lint
pnpm run typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Expected: prettier clean (re-run `format:check` after `format` if it rewrote files), eslint clean, both typechecks clean.

- [ ] **Step 2: Full test suites**

```bash
pnpm test
cd container/agent-runner && bun test; cd ../..
```

Expected: vitest ≥ 1131 baseline tests (measured green at HEAD 2026-08-02) + the new ones, 0 failures; bun 428 tests (measured; requires Task 1 Step 0's bun install), 0 failures. Lint baseline: 0 errors / 179 pre-existing `no-catch-all` warnings (non-blocking). If a pre-existing test fails, STOP and investigate whether Tasks 2–4 (incl. 2b) changed observable behavior it pinned (most likely candidates: anything asserting the old `Failed to start channel adapter` ERROR, the discord-commands guild-resolution swallow, or WhatsApp teardown/reconnect behavior) — fix the production code's compatibility, not the unrelated test, unless the pinned behavior is exactly what this plan intentionally changed (the ERROR→WARN-when-retrying transition, the partial-guild-resolution failure, and the teardown-reconnect guard are intentional).

- [ ] **Step 3: Commit any verification fixes**

```bash
git status --short
# only if there are changes:
git add -A && git commit -m "chore(channels): formatting/verification fixes for startup resilience"
```

Expected: clean tree at the end.
