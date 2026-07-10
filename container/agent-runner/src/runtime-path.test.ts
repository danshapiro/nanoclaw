import { describe, expect, it } from 'bun:test';

import { ensureAgentRunnerPath, suppressUndiciProxyWarning } from './runtime-path.js';

describe('ensureAgentRunnerPath', () => {
  it('restores image tool paths when container env overrides PATH', () => {
    const env = { PATH: '/app/skills/.bin:/usr/local/bin:/usr/bin:/bin' };

    ensureAgentRunnerPath(env);

    expect(env.PATH.split(':').slice(0, 3)).toEqual(['/pnpm/bin', '/pnpm', '/app/skills/.bin']);
    expect(env.PATH).toContain('/usr/local/bin');
  });

  it('does not duplicate existing entries', () => {
    const env = { PATH: '/pnpm/bin:/pnpm:/app/skills/.bin:/usr/bin' };

    ensureAgentRunnerPath(env);

    expect(env.PATH).toBe('/pnpm/bin:/pnpm:/app/skills/.bin:/usr/bin');
  });
});


describe('suppressUndiciProxyWarning', () => {
  it('sets NODE_OPTIONS with the targeted --disable-warning flag when unset', () => {
    const env: NodeJS.ProcessEnv = {};

    suppressUndiciProxyWarning(env);

    expect(env.NODE_OPTIONS).toBe('--disable-warning=UNDICI-EHPA');
  });

  it('appends to existing NODE_OPTIONS without clobbering other options', () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '--max-old-space-size=512' };

    suppressUndiciProxyWarning(env);

    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=512 --disable-warning=UNDICI-EHPA');
  });

  it('is idempotent — does not duplicate the flag', () => {
    const env: NodeJS.ProcessEnv = {};

    suppressUndiciProxyWarning(env);
    suppressUndiciProxyWarning(env);

    expect(env.NODE_OPTIONS).toBe('--disable-warning=UNDICI-EHPA');
  });
});
