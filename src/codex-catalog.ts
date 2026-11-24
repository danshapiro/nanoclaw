import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { VolumeMount } from './providers/provider-container-registry.js';

const exec = promisify(execFile);
const versions = new Map<string, string>();
const component = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) || value.includes('..')) {
    throw new Error('Invalid catalog or session identity');
  }
  return value;
};

/** Probe the selected immutable image, rather than assuming the host source pin. */
export async function resolveCodexImage(
  image: string,
  run: (args: string[]) => Promise<string> = async (args) => (await exec('docker', args, { timeout: 30_000 })).stdout,
): Promise<{ imageId: string; version: string }> {
  const imageId = (await run(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
  if (!/^sha256:[a-f0-9]+$/.test(imageId)) throw new Error('Cannot establish immutable Codex image identity');
  let version = versions.get(imageId);
  if (!version) {
    const output = await run([
      'run',
      '--rm',
      '--network=none',
      '--memory=128m',
      '--memory-swap=128m',
      '--pids-limit=64',
      '--entrypoint',
      '/pnpm/bin/codex',
      imageId,
      '--version',
    ]);
    version = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)\s*$/.exec(output)?.[1];
    if (!version) throw new Error('Cannot establish Codex version from selected image');
    versions.set(imageId, version);
  }
  return { imageId, version };
}

export function catalogMount(dataDir: string, groupId: string, version: string): VolumeMount {
  const hostPath = path.join(dataDir, '.cache', 'codex-catalog', component(groupId), component(version));
  fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
  return { hostPath, containerPath: '/home/node/.codex/cache/remote_plugin_catalog', readonly: false };
}

/** The inherited open description retains flock after the utility exits. */
export async function acquireStoreLease(dataDir: string, kind: 'session' | 'catalog', groupId: string, id: string) {
  const dir = path.join(dataDir, '.cache', `${kind}-store-leases`, component(groupId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, `${component(id)}.lock`);
  const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      fs.closeSync(fd);
    }
  };
  try {
    const held = fs.fstatSync(fd);
    if (!held.isFile() || held.size !== 0 || held.nlink !== 1 || held.uid !== process.getuid?.()) {
      throw new Error('Unsafe session maintenance lease');
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--shared', '--timeout', '30', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd],
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('Session maintenance lease is busy or unavailable')),
      );
    });
    const named = fs.lstatSync(lockPath);
    if (named.dev !== held.dev || named.ino !== held.ino) throw new Error('Session maintenance lease identity changed');
    return { path: lockPath, release };
  } catch (err) {
    release();
    throw err;
  }
}
