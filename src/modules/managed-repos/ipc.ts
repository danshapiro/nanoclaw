import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { resolveGroupIpcPath } from '../../group-folder.js';
import { runManagedRepoCommand, type ManagedRepoCommandResult } from './actions.js';

const IPC_POLL_INTERVAL_MS = 1000;

type ManagedReposIpcTask =
  | {
      type: 'apply_managed_repos';
      requestId?: string;
    }
  | {
      type: 'push_managed_repo';
      requestId?: string;
      repoId?: string;
    };

interface ManagedReposIpcResponse {
  ok: boolean;
  requestId: string;
  type: ManagedReposIpcTask['type'];
  repoId?: string;
  stdout: string;
  stderr: string;
}

let watcherRunning = false;
let timer: NodeJS.Timeout | null = null;

function responsePath(sourceGroup: string, requestId: string): string {
  return path.join(resolveGroupIpcPath(sourceGroup), 'responses', `${requestId}.json`);
}

function writeResponse(sourceGroup: string, response: ManagedReposIpcResponse): void {
  const target = responsePath(sourceGroup, response.requestId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(response, null, 2) + '\n');
}

function commandError(error: unknown): ManagedRepoCommandResult {
  if (error && typeof error === 'object') {
    const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
    const stderr =
      'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : error instanceof Error
          ? error.message
          : String(error);
    return { stdout, stderr };
  }
  return { stdout: '', stderr: String(error) };
}

async function processManagedReposIpcTask(data: ManagedReposIpcTask, sourceGroup: string): Promise<boolean> {
  if (data.type !== 'apply_managed_repos' && data.type !== 'push_managed_repo') return false;
  if (!data.requestId) {
    throw new Error(`${data.type} IPC tasks require requestId`);
  }
  const repoId = 'repoId' in data ? data.repoId : undefined;

  if (sourceGroup !== 'main') {
    writeResponse(sourceGroup, {
      ok: false,
      requestId: data.requestId,
      type: data.type,
      repoId,
      stdout: '',
      stderr: `${data.type} is only available to the main group`,
    });
    return true;
  }

  if (data.type === 'push_managed_repo' && !data.repoId) {
    writeResponse(sourceGroup, {
      ok: false,
      requestId: data.requestId,
      type: data.type,
      stdout: '',
      stderr: 'push_managed_repo requires repoId',
    });
    return true;
  }

  try {
    const result =
      data.type === 'apply_managed_repos'
        ? await runManagedRepoCommand('apply-managed-repos.sh')
        : await runManagedRepoCommand('push-managed-repo.sh', [data.repoId!]);
    writeResponse(sourceGroup, {
      ok: true,
      requestId: data.requestId,
      type: data.type,
      repoId,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (error) {
    const result = commandError(error);
    writeResponse(sourceGroup, {
      ok: false,
      requestId: data.requestId,
      type: data.type,
      repoId,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  return true;
}

async function scanIpc(): Promise<void> {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const groupFolders = fs
    .readdirSync(ipcBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
    .map((entry) => entry.name);

  for (const sourceGroup of groupFolders) {
    const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;

    const taskFiles = fs.readdirSync(tasksDir).filter((file) => file.endsWith('.json'));
    for (const file of taskFiles) {
      const filePath = path.join(tasksDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ManagedReposIpcTask;
        await processManagedReposIpcTask(data, sourceGroup);
        fs.unlinkSync(filePath);
      } catch (error) {
        log.error('Error processing managed repos IPC task', { file, sourceGroup, err: error });
        const errorDir = path.join(ipcBaseDir, 'errors');
        fs.mkdirSync(errorDir, { recursive: true });
        fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
      }
    }
  }
}

function scheduleNext(): void {
  if (!watcherRunning) return;
  timer = setTimeout(() => {
    void tick();
  }, IPC_POLL_INTERVAL_MS);
  timer.unref();
}

async function tick(): Promise<void> {
  try {
    await scanIpc();
  } catch (error) {
    log.error('Managed repos IPC watcher error', { err: error });
  } finally {
    scheduleNext();
  }
}

export function startManagedReposIpcWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;
  void tick();
  log.info('Managed repos IPC watcher started');
}

export function stopManagedReposIpcWatcher(): void {
  watcherRunning = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
