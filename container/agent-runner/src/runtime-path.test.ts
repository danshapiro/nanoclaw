import { describe, expect, it } from 'bun:test';

import { ensureAgentRunnerPath } from './runtime-path.js';

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

