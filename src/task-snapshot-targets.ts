import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { RegisteredGroup } from './types.js';

export interface TaskSnapshotTarget {
  folder: string;
  isMain: boolean;
}

export function listTaskSnapshotTargets(
  registeredGroups: Record<string, RegisteredGroup>,
  ipcFolders: string[] = readExistingIpcFolders(),
): TaskSnapshotTarget[] {
  const targets = new Map<string, TaskSnapshotTarget>();

  for (const group of Object.values(registeredGroups)) {
    targets.set(group.folder, {
      folder: group.folder,
      isMain: group.isMain === true,
    });
  }

  for (const folder of ipcFolders) {
    if (!isValidGroupFolder(folder) || targets.has(folder)) {
      continue;
    }

    targets.set(folder, {
      folder,
      isMain: folder === 'main',
    });
  }

  return Array.from(targets.values()).sort((a, b) =>
    a.folder.localeCompare(b.folder),
  );
}

function readExistingIpcFolders(): string[] {
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');

  try {
    return fs
      .readdirSync(ipcBaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
