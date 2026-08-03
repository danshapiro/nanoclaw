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
