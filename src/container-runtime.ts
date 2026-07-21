/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(additionalHostnames: readonly string[] = []): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    const args = ['--add-host=host.docker.internal:host-gateway'];
    for (const hostname of additionalHostnames) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(hostname) || hostname.includes('..')) {
        throw new Error(`Invalid host gateway alias: ${hostname}`);
      }
      args.push(`--add-host=${hostname}:host-gateway`);
    }
    return args;
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

export function stopContainerAsync(name: string, graceSeconds = 1): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    return Promise.reject(new Error(`Invalid container name: ${name}`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', String(graceSeconds), name],
      { timeout: (graceSeconds + 10) * 1000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export function isContainerRunningAsync(name: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    return Promise.reject(new Error(`Invalid container name: ${name}`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim().split('\n').filter(Boolean).includes(name));
      },
    );
  });
}

export function isContainerWithLabelRunningAsync(label: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_.-]+=[a-zA-Z0-9_.:-]+$/.test(label)) {
    return Promise.reject(new Error(`Invalid container label filter: ${label}`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `label=${label}`, '--format', '{{.Names}}'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim().split('\n').filter(Boolean).length > 0);
      },
    );
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        // Best-effort compatibility path; startup uses the verified variant.
      }
    }
    if (orphans.length > 0) log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

/** Startup-safe orphan cleanup. It returns only after a second listing proves empty. */
export function cleanupOrphansVerified(): void {
  const list = (): string[] => {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    return output.trim().split('\n').filter(Boolean);
  };
  const orphans = list();
  for (const name of orphans) stopContainer(name);
  const survivors = list();
  if (survivors.length > 0) {
    throw new Error(`orphaned NanoClaw containers remain after cleanup: ${survivors.join(', ')}`);
  }
  if (orphans.length > 0) log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
}
