import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '/tmp/nanoclaw-group-init-test',
  dataDir: '/tmp/nanoclaw-group-init-test/data',
  groupsDir: '/tmp/nanoclaw-group-init-test/groups',
}));

vi.mock('./config.js', () => ({
  DATA_DIR: mocks.dataDir,
  GROUPS_DIR: mocks.groupsDir,
}));
vi.mock('./log.js', () => ({ log: { info: vi.fn() } }));

import { readContainerConfig } from './container-config.js';
import { initGroupFilesystem } from './group-init.js';

const group = {
  id: 'ag-existing',
  name: 'Existing',
  folder: 'existing',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  fs.rmSync(mocks.root, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(mocks.root, { recursive: true, force: true });
});

describe('initGroupFilesystem provider compatibility', () => {
  it('keeps a reused configless group on the legacy Claude provider', () => {
    fs.mkdirSync(path.join(mocks.root, 'groups', group.folder), { recursive: true });

    initGroupFilesystem(group);

    expect(readContainerConfig(group.folder).provider).toBe('claude');
  });

  it('stamps an explicitly selected provider for a newly created group', () => {
    initGroupFilesystem({ ...group, id: 'ag-new', folder: 'new' }, { provider: 'codex' });

    expect(readContainerConfig('new').provider).toBe('codex');
  });
});
