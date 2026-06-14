import { describe, expect, it } from 'bun:test';

import { buildInactivityNotice } from './codex-parity.js';

describe('buildInactivityNotice', () => {
  it('emits runtime-only liveness without relay prompt metadata', () => {
    const event = buildInactivityNotice('in-1', {
      configuredTimeoutMs: 300000,
      elapsedMs: 301000,
      lastEventType: 'keepalive',
      lastMeaningfulEventAt: new Date(Date.now() - 301000).toISOString(),
    });

    expect(event).toMatchObject({
      type: 'notice',
      inputId: 'in-1',
      classification: 'inactivity',
      severity: 'info',
      fallbackUserMessage: "I'm still working on your request.",
    });
    expect(event).not.toHaveProperty('agentMessage');
    expect(event).not.toHaveProperty('relayRecommended');
  });
});
