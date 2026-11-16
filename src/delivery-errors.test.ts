import { describe, expect, it } from 'vitest';
import { extractRateLimitDelayMs } from './delivery-errors.js';

describe('provider rate-limit delay', () => {
  it.each([
    [0, 0],
    [0.3, 300],
    [10, 10000],
    [1.0001, 1001],
  ])('keeps %s seconds as minimum %s milliseconds', (seconds, milliseconds) => {
    expect(
      extractRateLimitDelayMs(new Error(`Discord API error: 429 ${JSON.stringify({ retry_after: seconds })}`)),
    ).toBe(milliseconds);
  });
  it.each([' ', '\n', '\r\n', ' \n '])('accepts JSON trailing whitespace %j', (suffix) => {
    expect(extractRateLimitDelayMs(new Error('Discord API error: 429 {"retry_after":10}' + suffix))).toBe(10000);
  });
  it('accepts a structured numeric provider delay only for explicit429', () => {
    expect(extractRateLimitDelayMs({ status: 429, retry_after: 12 })).toBe(12000);
    expect(extractRateLimitDelayMs({ status: 502, retry_after: 12 })).toBeNull();
  });
  it.each([null, undefined, '10', -1, Infinity, NaN, Number.MAX_VALUE, 8.7e12])(
    'rejects malformed or unsafe delay %s',
    (value) => {
      expect(extractRateLimitDelayMs({ status: 429, retry_after: value })).toBeNull();
    },
  );
  it('never extracts arbitrary body digits from transport or server failures', () => {
    for (const message of [
      'network closed retry_after 10',
      'Discord API error: 502 {"retry_after":10}',
      'Discord API error: 429 {broken',
    ]) {
      expect(extractRateLimitDelayMs(new Error(message))).toBeNull();
    }
  });
});
