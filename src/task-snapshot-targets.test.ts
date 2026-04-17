import { describe, expect, it } from 'vitest';

import { listTaskSnapshotTargets } from './task-snapshot-targets.js';
import { RegisteredGroup } from './types.js';

describe('listTaskSnapshotTargets', () => {
  it('includes synthetic IPC folders that are not in registeredGroups', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'chat-1@g.us': {
        name: 'Team',
        folder: 'team',
        trigger: '@Yente',
        added_at: '2026-04-16T00:00:00.000Z',
      },
    };

    expect(
      listTaskSnapshotTargets(registeredGroups, [
        'team',
        'main',
        'yente',
        'global',
        '../bad',
      ]),
    ).toEqual([
      { folder: 'main', isMain: true },
      { folder: 'team', isMain: false },
      { folder: 'yente', isMain: false },
    ]);
  });

  it('preserves the registered main-group flag when the folder is already registered', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'main@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: '@Yente',
        added_at: '2026-04-16T00:00:00.000Z',
        isMain: true,
      },
    };

    expect(listTaskSnapshotTargets(registeredGroups, ['main'])).toEqual([
      { folder: 'main', isMain: true },
    ]);
  });
});
