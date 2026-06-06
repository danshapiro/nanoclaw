import { describe, it, expect } from 'bun:test';
import { classifyActionableError, buildAgentMessage } from './actionable-error-messages.js';

describe('classifyActionableError', () => {
  it('classifies "Insufficient balance" with billing URL', () => {
    const error = {
      data: {
        message:
          'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_01K7GPZSP6NGNSHF5ZHKBTVHVF/billing',
      },
    };
    const result = classifyActionableError(error);
    expect(result.kind).toBe('insufficient-balance');
    expect(result.label).toBe('session-error-insufficient-balance');
    expect(result.retryable).toBe(true);
    expect(result.operatorActionRequired).toBe(true);
    expect(result.userMessage).toContain('run out of balance');
    expect(result.userMessage).toContain('all Yente agents');
    expect(result.userMessage).not.toContain('opencode.ai');
    expect(result.userMessage).not.toContain('wrk_');
  });

  it('classifies case-insensitive "insufficient balance"', () => {
    const result = classifyActionableError({ data: { message: 'INSUFFICIENT BALANCE' } });
    expect(result.kind).toBe('insufficient-balance');
  });

  it('classifies bare string "insufficient balance"', () => {
    const result = classifyActionableError('Insufficient balance');
    expect(result.kind).toBe('insufficient-balance');
  });

  it('classifies rate limit errors', () => {
    const result = classifyActionableError({ data: { message: 'Rate limit exceeded. Try again later.' } });
    expect(result.kind).toBe('rate-limit');
    expect(result.retryable).toBe(true);
    expect(result.operatorActionRequired).toBe(false);
    expect(result.userMessage).toContain('rate-limiting');
  });

  it('classifies auth failure errors', () => {
    const result = classifyActionableError({ data: { message: 'Invalid API key provided.' } });
    expect(result.kind).toBe('auth-failure');
    expect(result.retryable).toBe(false);
    expect(result.operatorActionRequired).toBe(true);
    expect(result.userMessage).toContain('credentials');
  });

  it('classifies provider unavailable errors', () => {
    const result = classifyActionableError({ data: { message: 'Service temporarily unavailable (503)' } });
    expect(result.kind).toBe('provider-unavailable');
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain('temporarily unavailable');
  });

  it('classifies model overloaded errors', () => {
    const result = classifyActionableError({ data: { message: 'Model is overloaded. Please retry.' } });
    expect(result.kind).toBe('model-overloaded');
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain('overloaded');
  });

  it('falls back to unknown for unrecognized errors', () => {
    const result = classifyActionableError({ data: { message: 'Some cryptic internal failure' } });
    expect(result.kind).toBe('unknown');
    expect(result.label).toBe('session-error-unknown');
    expect(result.retryable).toBe(true);
    expect(result.operatorActionRequired).toBe(false);
    expect(result.userMessage).toContain('Something went wrong');
  });

  it('falls back to unknown for non-object, non-string errors', () => {
    const result = classifyActionableError(42);
    expect(result.kind).toBe('unknown');
  });

  it('falls back to unknown for null', () => {
    const result = classifyActionableError(null);
    expect(result.kind).toBe('unknown');
  });
});

describe('buildAgentMessage', () => {
  it('returns base message for generic unknown error', () => {
    const err = classifyActionableError({ data: { message: '???' } });
    expect(buildAgentMessage(err)).toBe(
      'The model reported an error on this turn and I stopped before finishing. Your request is preserved.',
    );
  });

  it('appends operator-action hint when required', () => {
    const err = classifyActionableError({ data: { message: 'insufficient balance' } });
    expect(buildAgentMessage(err)).toContain('operator action required');
  });

  it('appends not-retryable hint when retryable is false and operator action is not required', () => {
    // Create a synthetic error that is not retryable and does not need operator action.
    const err: import('./actionable-error-messages.js').ActionableError = {
      kind: 'unknown',
      label: 'session-error-custom',
      userMessage: 'Custom.',
      retryable: false,
      operatorActionRequired: false,
    };
    expect(buildAgentMessage(err)).toContain('not retryable');
  });
});
