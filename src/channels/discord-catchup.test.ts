import { describe, expect, it } from 'vitest';

import {
  compareSnowflakes,
  DEFAULT_DISCORD_CATCHUP_INTERVAL_MS,
  DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS,
  DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES,
  DEFAULT_DISCORD_CATCHUP_MAX_THREADS,
  DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS,
  DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
  discordCatchupConfigFromEnv,
  snowflakeToUnixMs,
  unixMsToSnowflake,
} from './discord-catchup.js';

describe('discordCatchupConfigFromEnv', () => {
  it('returns spec defaults on an empty env', () => {
    expect(discordCatchupConfigFromEnv({})).toEqual({
      disabled: false,
      intervalMs: DEFAULT_DISCORD_CATCHUP_INTERVAL_MS,
      readyDebounceMs: DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS,
      maxMessages: DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES,
      maxAgeMs: DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS,
      routeLeaseMs: DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
      maxThreads: DEFAULT_DISCORD_CATCHUP_MAX_THREADS,
    });
    expect(DEFAULT_DISCORD_CATCHUP_INTERVAL_MS).toBe(300000);
    expect(DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS).toBe(15000);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES).toBe(200);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS).toBe(259200000);
    expect(DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS).toBe(120000);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_THREADS).toBe(25);
  });

  it('reads the kill switch and interval=0 (periodic disable)', () => {
    const config = discordCatchupConfigFromEnv({
      DISCORD_CATCHUP_DISABLED: '1',
      DISCORD_CATCHUP_INTERVAL_MS: '0',
    });
    expect(config.disabled).toBe(true);
    expect(config.intervalMs).toBe(0);
  });

  it('throws loudly on malformed values, naming the variable', () => {
    expect(() => discordCatchupConfigFromEnv({ DISCORD_CATCHUP_MAX_MESSAGES: 'lots' })).toThrow(
      /DISCORD_CATCHUP_MAX_MESSAGES/,
    );
    expect(() => discordCatchupConfigFromEnv({ DISCORD_CATCHUP_MAX_MESSAGES: '0' })).toThrow(
      /DISCORD_CATCHUP_MAX_MESSAGES/,
    );
  });
});

describe('snowflake helpers', () => {
  it('round-trips a unix timestamp through a synthetic snowflake', () => {
    const ms = 1753900000000; // well past the Discord epoch
    expect(snowflakeToUnixMs(unixMsToSnowflake(ms))).toBe(ms);
  });

  it('compares snowflakes numerically, not lexicographically', () => {
    expect(compareSnowflakes('999', '1000')).toBe(-1);
    expect(compareSnowflakes('1000', '999')).toBe(1);
    expect(compareSnowflakes('42', '42')).toBe(0);
  });
});
