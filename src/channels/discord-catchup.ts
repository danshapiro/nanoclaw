/**
 * Discord catch-up engine: recovers messages that arrived while the gateway
 * was disconnected (fresh IDENTIFY gets no replay) or the service was down.
 * Mirrors the AgentMail catch-up pattern (agentmail.ts) adapted to Discord's
 * snowflake-cursor REST pagination. See docs/plans/2026-07-30-discord-catchup.md.
 */

export const DEFAULT_DISCORD_CATCHUP_INTERVAL_MS = 300000; // 5 min periodic safety net
export const DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS = 15000; // coalesce READY bursts
export const DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES = 200; // per channel per run (2 REST pages)
export const DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS = 259200000; // 72 h backfill horizon
export const DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS = 120000; // choke-point claim lease
export const DEFAULT_DISCORD_CATCHUP_MAX_THREADS = 25; // active-thread backfill bound per run

const DISCORD_EPOCH_MS = 1420070400000;

export type DiscordCatchupConfig = {
  disabled: boolean;
  intervalMs: number;
  readyDebounceMs: number;
  maxMessages: number;
  maxAgeMs: number;
  routeLeaseMs: number;
  maxThreads: number;
};

function integerEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number, min: number): number {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
  }
  return parsed;
}

export function discordCatchupConfigFromEnv(env: NodeJS.ProcessEnv): DiscordCatchupConfig {
  return {
    disabled: env.DISCORD_CATCHUP_DISABLED?.trim() === '1',
    intervalMs: integerEnv(env, 'DISCORD_CATCHUP_INTERVAL_MS', DEFAULT_DISCORD_CATCHUP_INTERVAL_MS, 0),
    readyDebounceMs: integerEnv(env, 'DISCORD_CATCHUP_READY_DEBOUNCE_MS', DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS, 1),
    maxMessages: integerEnv(env, 'DISCORD_CATCHUP_MAX_MESSAGES', DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES, 1),
    maxAgeMs: integerEnv(env, 'DISCORD_CATCHUP_MAX_AGE_MS', DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS, 1),
    routeLeaseMs: integerEnv(env, 'DISCORD_CATCHUP_ROUTE_LEASE_MS', DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS, 1),
    maxThreads: integerEnv(env, 'DISCORD_CATCHUP_MAX_THREADS', DEFAULT_DISCORD_CATCHUP_MAX_THREADS, 0),
  };
}

export function snowflakeToUnixMs(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

export function unixMsToSnowflake(unixMs: number): string {
  const sinceEpoch = Math.max(0, unixMs - DISCORD_EPOCH_MS);
  return (BigInt(sinceEpoch) << 22n).toString();
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
