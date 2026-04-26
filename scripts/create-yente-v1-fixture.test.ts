import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createYenteV1Fixture } from './create-yente-v1-fixture.js';
import { buildYenteInventory, hashSourceState } from './yente-inventory.js';
import { createMigrationDryRun } from './yente-migrate-v1-to-v2.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yente-v1-fixture-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createYenteV1Fixture', () => {
  it('creates the full deterministic v1 surface for inventory and migration checks', () => {
    const stateRoot = path.join(tempDir, 'fixture-a', 'shared');
    const configRoot = path.join(tempDir, 'fixture-a', 'config');

    createYenteV1Fixture({ stateRoot, configRoot, profile: 'full' });

    const inventory = buildYenteInventory({ stateRoot, configRoot, checkedAt: '2026-04-26T00:00:00.000Z' });
    expect(inventory.source.chats.map((chat) => chat.jid).sort()).toEqual([
      '12015550100@s.whatsapp.net',
      'cli:smoke',
      'dc:dm:admin-user',
      'dc:guild-1:chan-prod',
    ]);
    expect(inventory.source.groups.map((group) => group.folder).sort()).toEqual(['chava', 'cli-smoke', 'main']);
    expect(inventory.source.targetSessions.map((session) => session.sessionId).sort()).toEqual([
      'old-chava-session',
      'old-main-session',
    ]);
    expect(fs.existsSync(path.join(configRoot, 'staging-channel-map.json'))).toBe(true);

    const dryRun = createMigrationDryRun({
      stateRoot,
      configRoot,
      assistantName: 'Yente',
      target: 'prod',
      checkedAt: '2026-04-26T00:00:00.000Z',
    });
    expect(dryRun.providerPolicyEvidence).toHaveLength(1);
    expect(dryRun.continuations.map((entry) => entry.oldSessionId).sort()).toEqual([
      'old-chava-session',
      'old-main-session',
    ]);
    expect(JSON.stringify(dryRun)).not.toContain('super-secret-token');
    expect(JSON.stringify(dryRun)).not.toContain('provider-secret-token');
  });

  it('produces stable source hashes across fixture roots', () => {
    const stateRootA = path.join(tempDir, 'fixture-a', 'shared');
    const configRootA = path.join(tempDir, 'fixture-a', 'config');
    const stateRootB = path.join(tempDir, 'fixture-b', 'shared');
    const configRootB = path.join(tempDir, 'fixture-b', 'config');

    createYenteV1Fixture({ stateRoot: stateRootA, configRoot: configRootA, profile: 'full' });
    createYenteV1Fixture({ stateRoot: stateRootB, configRoot: configRootB, profile: 'full' });

    expect(hashSourceState(stateRootA)).toBe(hashSourceState(stateRootB));
  });

  it('refuses live NanoClaw roots', () => {
    expect(() =>
      createYenteV1Fixture({
        stateRoot: '/srv/nanoclaw/shared',
        configRoot: path.join(tempDir, 'config'),
        profile: 'full',
      }),
    ).toThrow(/live NanoClaw path/);
    expect(() =>
      createYenteV1Fixture({
        stateRoot: path.join(tempDir, 'shared'),
        configRoot: '/var/lib/nanoclaw/.config/nanoclaw',
        profile: 'full',
      }),
    ).toThrow(/live NanoClaw path/);
  });
});
