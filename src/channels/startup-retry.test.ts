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
