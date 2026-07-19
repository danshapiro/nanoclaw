import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  groupsDir: '/tmp/nanoclaw-container-config-test',
}));

vi.mock('./config.js', () => ({
  GROUPS_DIR: mocks.groupsDir,
}));

import { initContainerConfig, readContainerConfig, writeContainerConfig } from './container-config.js';

beforeEach(() => {
  fs.rmSync(mocks.groupsDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(mocks.groupsDir, { recursive: true, force: true });
});

describe('initContainerConfig provider selection', () => {
  it('stamps the caller-selected creation default into a newly created group', () => {
    expect(initContainerConfig('fresh', 'codex')).toBe(true);
    expect(readContainerConfig('fresh').provider).toBe('codex');
  });

  it('stamps a caller-selected provider instead of the instance default', () => {
    expect(initContainerConfig('child', 'opencode')).toBe(true);
    expect(readContainerConfig('child').provider).toBe('opencode');
  });

  it('never changes an existing group config', () => {
    writeContainerConfig('existing', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      provider: 'claude',
    });
    const original = fs.readFileSync(path.join(mocks.groupsDir, 'existing', 'container.json'), 'utf8');

    expect(initContainerConfig('existing', 'codex')).toBe(false);
    expect(fs.readFileSync(path.join(mocks.groupsDir, 'existing', 'container.json'), 'utf8')).toBe(original);
  });
});
