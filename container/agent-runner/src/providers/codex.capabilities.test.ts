import { describe, expect, it } from 'bun:test';

import { CodexProvider } from './codex.js';
import { codexCapabilities, codexThreadSandbox } from './codex-parity.js';

describe('Codex provider capabilities', () => {
  it('uses a separate status-only relay runtime', () => {
    expect(codexCapabilities()).toEqual({
      supportsSeparateRelayRuntime: true,
      relayToolPolicy: 'status_only',
    });
    expect(new CodexProvider().capabilities).toEqual(codexCapabilities());
  });

  it('uses read-only sandboxing for relay turns only', () => {
    expect(codexThreadSandbox(true)).toBe('read-only');
    expect(codexThreadSandbox(false)).toBe('danger-full-access');
  });
});
