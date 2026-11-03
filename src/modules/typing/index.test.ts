import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyDiscordTypingActivity,
  applyStoredDiscordTypingActivity,
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  setTypingContainerOwner,
  startTypingRefresh,
  stopTypingGrace,
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

  it('starts activity after wake grace, retains other threads, and expires a missing final update', async () => {
    vi.useFakeTimers();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });
    setTypingContainerOwner('typing-test', 'owner');
    startTypingRefresh('typing-test', 'agent', 'discord', 'channel', 'one');
    await vi.advanceTimersByTimeAsync(20_000);
    const before = setTyping.mock.calls.length;
    const snapshot = (destinations: Array<{ platformId: string; threadId: string | null }>) =>
      JSON.stringify({
        leaseId: 'owner',
        updatedAt: Date.now(),
        destinations,
      });
    const one = { platformId: 'channel', threadId: 'one' };
    const two = { platformId: 'channel', threadId: 'two' };
    applyStoredDiscordTypingActivity('typing-test', 'agent', snapshot([one, two]));
    expect(setTyping.mock.calls.length).toBe(before + 2);
    applyStoredDiscordTypingActivity('typing-test', 'agent', snapshot([two]));
    await vi.advanceTimersByTimeAsync(4000);
    expect(setTyping.mock.calls.at(-1)).toEqual(['discord', 'channel', 'two']);
    const after = setTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(setTyping.mock.calls.length).toBe(after + 2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(setTyping.mock.calls.length).toBe(after + 2);
  });

  it('keeps the existing post-delivery pause on a non-Discord channel', async () => {
    vi.useFakeTimers();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });
    startTypingRefresh('typing-test', 'agent', 'telegram', 'channel', null);
    await vi.advanceTimersByTimeAsync(4000);
    pauseTypingRefreshAfterDelivery('typing-test');
    await vi.advanceTimersByTimeAsync(8000);
    expect(setTyping).toHaveBeenCalledTimes(2);
  });

  it('ends idle-stop and failed-wake grace without stopping another active thread', async () => {
    vi.useFakeTimers();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });
    startTypingRefresh('typing-test', 'agent', 'discord', 'channel', 'active');
    applyDiscordTypingActivity('typing-test', 'agent', [{ platformId: 'channel', threadId: 'active' }]);
    startTypingRefresh('typing-test', 'agent', 'discord', 'channel', 'failed');
    stopTypingGrace('typing-test', 'discord', 'channel', 'failed');
    startTypingRefresh('typing-test', 'agent', 'discord', 'channel', 'idle-stop');
    pauseTypingRefreshAfterDelivery('typing-test');
    const before = setTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(setTyping.mock.calls.slice(before)).toEqual([
      ['discord', 'channel', 'active'],
      ['discord', 'channel', 'active'],
    ]);
  });
});
