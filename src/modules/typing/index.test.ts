import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyDiscordTypingActivity,
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} from './index.js';

afterEach(() => {
  stopTypingRefresh('typing-test');
  vi.useRealTimers();
});

describe('Discord request typing', () => {
  it('refreshes during quiet active work and intermediate delivery, then stops at completion', async () => {
    vi.useFakeTimers();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });
    startTypingRefresh('typing-test', 'agent', 'discord', 'channel', 'thread');
    applyDiscordTypingActivity('typing-test', 'agent', [{ platformId: 'channel', threadId: 'thread' }]);
    await vi.advanceTimersByTimeAsync(20_000);
    pauseTypingRefreshAfterDelivery('typing-test');
    await vi.advanceTimersByTimeAsync(24_000);
    expect(setTyping.mock.calls.length).toBeGreaterThanOrEqual(11);
    applyDiscordTypingActivity('typing-test', 'agent', []);
    const callsAtCompletion = setTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(setTyping).toHaveBeenCalledTimes(callsAtCompletion);
  });
});
