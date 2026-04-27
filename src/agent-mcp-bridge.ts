import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from './config.js';
import { AgentMcpBridgeConfig } from './agent-mcp-config.js';
import { log } from './log.js';

const AUTH_MARKER = '.nanoclaw-granola-auth-ok';
const DEFAULT_SOCKET_ROOT = '/workspace/mcp';
const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_STARTUP_WATCHDOG_MS = 15_000;
const MAX_SOCKET_PATH_BYTES = 99;

type SpawnLike = typeof spawn;

export type AgentMcpBridgeRuntimeConfig = AgentMcpBridgeConfig & {
  serverName: string;
};

export type AgentMcpBridge = {
  serverName: string;
  hostSocketDir: string;
  hostSocketPath: string;
  containerSocketDir: string;
  containerSocketPath: string;
  authDir: string;
  stop: () => Promise<void>;
};

export type AgentMcpBridgeOptions = {
  groupFolder: string;
  agentGroupId: string;
  bridge: AgentMcpBridgeRuntimeConfig;
  containerUid: number;
  containerGid: number;
  dataDir?: string;
  releaseRoot?: string;
  spawnImpl?: SpawnLike;
  lockWaitMs?: number;
  startupWatchdogMs?: number;
};

type HeldLock = {
  key: string;
  lockPath: string;
};

const inProcessLocks = new Set<string>();

function makeRunId(): string {
  return `mcp-${crypto.randomBytes(6).toString('hex')}`;
}

function resolveInside(parent: string, child: string, label: string): string {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedChild;
  }
  throw new Error(`Agent MCP ${label} escapes ${resolvedParent}: ${resolvedChild}`);
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function verifyOwnedByServiceUser(authDir: string): void {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid == null || gid == null) return;
  const stat = fs.statSync(authDir);
  if (stat.uid !== uid || stat.gid !== gid) {
    throw new Error(`Granola MCP auth directory must be owned by service uid/gid ${uid}:${gid}: ${authDir}`);
  }
}

function enforcePrivatePermissions(dir: string): void {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Granola MCP auth path must not contain symlinks: ${fullPath}`);
    }
    if (stat.isDirectory()) {
      enforcePrivatePermissions(fullPath);
    } else {
      fs.chmodSync(fullPath, 0o600);
    }
  }
}

function resolveProxyEntrypoint(releaseRoot: string): string {
  const entrypoint = path.join(releaseRoot, 'node_modules', 'mcp-remote', 'dist', 'proxy.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`mcp-remote proxy entrypoint is missing: ${entrypoint}`);
  }
  return entrypoint;
}

async function acquireBridgeLock(lockPath: string, key: string, waitMs: number): Promise<HeldLock> {
  const start = Date.now();
  while (true) {
    if (!inProcessLocks.has(key)) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.closeSync(fd);
        inProcessLocks.add(key);
        return { key, lockPath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    }
    if (Date.now() - start >= waitMs) {
      throw new Error('Granola MCP is busy for this group; retry after the active request finishes');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function releaseBridgeLock(lock: HeldLock): void {
  inProcessLocks.delete(lock.key);
  try {
    fs.unlinkSync(lock.lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

function removeEmptyDirIfExists(dirPath: string): void {
  try {
    fs.rmdirSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw err;
    }
  }
}

function spawnProxy(
  spawnImpl: SpawnLike,
  releaseRoot: string,
  proxyEntrypoint: string,
  bridge: AgentMcpBridgeRuntimeConfig,
  authDir: string,
): ChildProcessWithoutNullStreams {
  return spawnImpl(
    'node',
    [
      path.relative(releaseRoot, proxyEntrypoint),
      bridge.remoteUrl,
      String(bridge.callbackPort),
      '--host',
      '127.0.0.1',
      '--auth-timeout',
      '5',
    ],
    {
      cwd: releaseRoot,
      env: {
        ...process.env,
        MCP_REMOTE_CONFIG_DIR: authDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    },
  ) as ChildProcessWithoutNullStreams;
}

export async function startAgentMcpBridge(options: AgentMcpBridgeOptions): Promise<AgentMcpBridge> {
  if (!Number.isInteger(options.containerUid) || !Number.isInteger(options.containerGid)) {
    throw new Error('Agent MCP bridge requires a known container UID/GID before startup');
  }

  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const releaseRoot = path.resolve(options.releaseRoot || process.cwd());
  const spawnImpl = options.spawnImpl || spawn;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const startupWatchdogMs = options.startupWatchdogMs ?? DEFAULT_STARTUP_WATCHDOG_MS;

  const sessionsDir = resolveInside(dataDir, path.join(dataDir, 'v2-sessions'), 'v2 sessions path');
  const groupSessionDir = resolveInside(
    sessionsDir,
    path.join(sessionsDir, options.agentGroupId),
    'agent group session path',
  );
  const authDir = resolveInside(
    groupSessionDir,
    path.join(groupSessionDir, '.mcp-auth', options.bridge.serverName),
    'auth path',
  );
  mkdirPrivate(authDir);
  verifyOwnedByServiceUser(authDir);
  enforcePrivatePermissions(authDir);

  const marker = path.join(authDir, AUTH_MARKER);
  if (!fs.existsSync(marker)) {
    throw new Error('Granola MCP auth required; run the workstation login helper before using this bridge');
  }

  const proxyEntrypoint = resolveProxyEntrypoint(releaseRoot);
  const socketRoot = resolveInside(groupSessionDir, path.join(groupSessionDir, 'mcp-runs'), 'socket root');
  mkdirPrivate(socketRoot);

  const runId = makeRunId();
  if (runId.length > 16) {
    throw new Error(`Agent MCP run id is too long: ${runId}`);
  }
  const hostSocketDir = resolveInside(socketRoot, path.join(socketRoot, runId), 'run socket path');
  fs.mkdirSync(hostSocketDir, { recursive: false, mode: 0o700 });
  fs.chownSync(hostSocketDir, options.containerUid, options.containerGid);
  fs.chmodSync(hostSocketDir, 0o700);

  const socketFileName = `${options.bridge.socketNamePrefix}.sock`;
  const hostSocketPath = resolveInside(hostSocketDir, path.join(hostSocketDir, socketFileName), 'socket file');
  if (Buffer.byteLength(hostSocketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Agent MCP socket path is too long for Unix sockets: ${hostSocketPath}`);
  }

  const containerSocketDir = path.posix.join(DEFAULT_SOCKET_ROOT, options.bridge.serverName);
  const containerSocketPath = path.posix.join(containerSocketDir, socketFileName);
  const lockPath = resolveInside(socketRoot, path.join(socketRoot, `${options.bridge.serverName}.lock`), 'lock path');
  const lockKey = `${options.agentGroupId}:${options.bridge.serverName}`;

  const children = new Set<ChildProcessWithoutNullStreams>();
  const server = net.createServer((socket) => {
    let lock: HeldLock | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      socket.write(`${message}\n`);
      socket.end();
      if (child && !child.killed) child.kill();
      if (lock) releaseBridgeLock(lock);
    };

    void (async () => {
      const acquiredLock = await acquireBridgeLock(lockPath, lockKey, lockWaitMs).then(
        (heldLock) => ({ ok: true as const, heldLock }),
        (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
      );
      if (!acquiredLock.ok) {
        fail(acquiredLock.message);
        return;
      }
      lock = acquiredLock.heldLock;

      const previousUmask = process.umask(0o077);
      try {
        child = spawnProxy(spawnImpl, releaseRoot, proxyEntrypoint, options.bridge, authDir);
      } finally {
        process.umask(previousUmask);
      }
      children.add(child);
      const watchdog = setTimeout(() => {
        fail('Granola MCP bridge unavailable; proxy startup timed out');
      }, startupWatchdogMs);

      child.stderr.on('data', (chunk) => {
        log.warn('mcp-remote proxy stderr', {
          group: options.groupFolder,
          serverName: options.bridge.serverName,
          stderr: String(chunk).slice(0, 1000),
        });
      });
      child.on('error', (err) => {
        clearTimeout(watchdog);
        fail(`Granola MCP bridge unavailable: ${err.message}`);
      });
      child.on('close', () => {
        clearTimeout(watchdog);
        children.delete(child as ChildProcessWithoutNullStreams);
        if (lock) {
          releaseBridgeLock(lock);
          lock = undefined;
        }
        enforcePrivatePermissions(authDir);
        if (!socket.destroyed) socket.end();
      });
      child.stdout.once('data', () => {
        settled = true;
        clearTimeout(watchdog);
      });
      child.stdout.pipe(socket, { end: false });
      socket.pipe(child.stdin);
      socket.on('close', () => {
        if (child && !child.killed) child.kill();
      });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(hostSocketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    serverName: options.bridge.serverName,
    hostSocketDir,
    hostSocketPath,
    containerSocketDir,
    containerSocketPath,
    authDir,
    stop: async () => {
      for (const child of children) {
        if (!child.killed) child.kill();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      removeFileIfExists(hostSocketPath);
      removeEmptyDirIfExists(hostSocketDir);
    },
  };
}
