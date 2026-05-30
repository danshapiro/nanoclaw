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

/** Narrow, expected Granola credential failure classes that may degrade. */
export type AgentMcpCredentialCategory = 'auth_required' | 'auth_expired';

/**
 * Thrown ONLY for expected missing/expired credential conditions. The caller
 * (`container-runner.ts`) degrades an OPTIONAL bridge to unavailable on this
 * error and fails closed on every other error. The `message` is already
 * sanitized for agent-facing context: it never contains host paths, uid/gid
 * values, or raw underlying errors.
 */
export class AgentMcpCredentialUnavailableError extends Error {
  readonly category: AgentMcpCredentialCategory;

  constructor(category: AgentMcpCredentialCategory, message: string) {
    super(message);
    this.name = 'AgentMcpCredentialUnavailableError';
    this.category = category;
  }
}

const SANITIZED_AUTH_REQUIRED_MESSAGE =
  'Granola is temporarily unavailable: it needs to be re-authorized from the workstation before it can be used.';
const SANITIZED_AUTH_EXPIRED_MESSAGE =
  'Granola is temporarily unavailable: its saved credentials have expired and must be refreshed from the workstation.';

function sanitizedCredentialMessage(category: AgentMcpCredentialCategory): string {
  return category === 'auth_expired' ? SANITIZED_AUTH_EXPIRED_MESSAGE : SANITIZED_AUTH_REQUIRED_MESSAGE;
}

// Known mcp-remote credential prompts (grounded in mcp-remote@0.1.38 stderr
// strings). Matching is case-insensitive. Anything not on these lists is
// treated as an UNCLASSIFIED failure and must stay fail-closed.
//
// Removed/replaced entries (do not re-add without grounding in mcp-remote source):
//   'auth-timeout'    — matches only the CLI flag name --auth-timeout, not any failure string.
//   'auth timeout'    — matches only the benign config-parse warning
//                       "Warning: Ignoring invalid auth timeout value: …"; not a failure.
//   'auth needed'     — not a real mcp-remote stderr string; the reconnect reason tag is
//                       'authentication-needed' (REASON_AUTH_NEEDED). Replaced below.
//   'auth_needed'     — same; underscore form is not emitted by mcp-remote.
//   'auth failed'     — matches "Auth failed during long poll, responding with 500", which is a
//                       TRANSIENT callback-server 500 (network/timeout blip), not a token
//                       rejection. Removed to stay fail-closed on transients; the related HTTP
//                       response body "Authentication failed" is kept in AUTH_EXPIRED_PROMPTS.
const AUTH_REQUIRED_PROMPTS = [
  'please authorize', // "Please authorize this client by visiting:" (redirectToAuthorization)
  'authentication required', // "Authentication required. Initializing auth..." / "Waiting for authorization..."
  'authorization required',
  'auth required',
  'authentication-needed', // REASON_AUTH_NEEDED reconnect reason tag emitted in log lines
];
// "authentication failed" matches the HTTP response body "Authentication failed" sent by
// setupOAuthCallbackServerWithLongPoll when the auth promise rejects (a real credential
// failure path, distinct from the transient "Auth failed during long poll" log line which
// was removed from AUTH_REQUIRED_PROMPTS above).
const AUTH_EXPIRED_PROMPTS = ['authentication failed', 'authorization failed', 'token expired'];

/**
 * Classify a captured stderr blob / exit status against the narrow set of
 * known Granola credential prompts. Returns the credential category for an
 * expected missing/expired credential failure, or `null` for anything else
 * (which the caller must treat as a fail-closed startup error). Exported for
 * unit testing the matcher in isolation.
 */
export function classifyBridgeCredentialFailure(
  stderr: string,
  _exitCode: number | null,
): AgentMcpCredentialCategory | null {
  const haystack = (stderr || '').toLowerCase();
  if (!haystack) return null;
  // Expired/rejected credentials take precedence over the generic "auth
  // required" so a "Authentication failed" prompt isn't mislabeled.
  if (AUTH_EXPIRED_PROMPTS.some((prompt) => haystack.includes(prompt))) {
    return 'auth_expired';
  }
  if (AUTH_REQUIRED_PROMPTS.some((prompt) => haystack.includes(prompt))) {
    return 'auth_required';
  }
  return null;
}

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
  /**
   * When true, probe the proxy at startup by spawning it and waiting up to the
   * startup watchdog for the readiness byte. If the proxy stalls or exits and
   * the captured stderr/status matches a known credential prompt, this throws
   * `AgentMcpCredentialUnavailableError`; an unclassified stall throws a plain
   * fail-closed startup error. Off by default so the normal lazy-spawn path
   * (proxy started on first client connection) is unchanged.
   */
  verifyReadyOnStartup?: boolean;
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

/**
 * The auth marker is written empty by the workstation login helper (existence
 * == authorized). A login helper MAY instead write JSON carrying an `expiresAt`
 * ISO timestamp; when that timestamp is in the past the credentials are treated
 * as expired. An empty or non-JSON marker is treated as non-expiring so the
 * existing existence-only contract keeps working. Marker read/parse failures
 * are NOT swallowed into "expired" — a missing marker is handled separately,
 * and any other read error must propagate as a fail-closed startup error.
 */
function isMarkerExpired(markerPath: string): boolean {
  const raw = fs.readFileSync(markerPath, 'utf8').trim();
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const expiresAt = (parsed as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== 'string') return false;
  const expiryMs = Date.parse(expiresAt);
  if (Number.isNaN(expiryMs)) return false;
  return expiryMs <= Date.now();
}

function resolveProxyEntrypoint(releaseRoot: string): string {
  const entrypoint = path.join(releaseRoot, 'node_modules', 'mcp-remote', 'dist', 'proxy.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`mcp-remote proxy entrypoint is missing: ${entrypoint}`);
  }
  return entrypoint;
}

const LEGACY_LOCK_STALE_MS = 60_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function shouldReclaimBridgeLock(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(lockPath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  if (!raw) {
    return Date.now() - stat.mtimeMs > LEGACY_LOCK_STALE_MS;
  }

  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === 'number' && !processExists(parsed.pid);
  } catch {
    return Date.now() - stat.mtimeMs > LEGACY_LOCK_STALE_MS;
  }
}

async function acquireBridgeLock(lockPath: string, key: string, waitMs: number): Promise<HeldLock> {
  const start = Date.now();
  while (true) {
    if (!inProcessLocks.has(key)) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, key, createdAt: new Date().toISOString() }));
        fs.closeSync(fd);
        inProcessLocks.add(key);
        return { key, lockPath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        if (shouldReclaimBridgeLock(lockPath)) {
          removeFileIfExists(lockPath);
          continue;
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

function canonicalizeDataDir(dataDir: string): string {
  const resolved = path.resolve(dataDir);
  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved;
    }
    throw err;
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

function isExpectedSocketClose(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'ECONNRESET';
}

function warnUnexpectedSocketError(action: string, err: unknown): void {
  if (isExpectedSocketClose(err)) return;
  log.warn('Agent MCP bridge socket error', {
    action,
    err: err instanceof Error ? err.message : String(err),
  });
}

function closeSocketQuietly(socket: net.Socket, message?: string): void {
  if (socket.destroyed) return;
  try {
    if (message && socket.writable) {
      socket.write(`${message}\n`, (err) => {
        if (err) warnUnexpectedSocketError('write failure response', err);
      });
    }
  } catch (err) {
    warnUnexpectedSocketError('write failure response', err);
  }

  try {
    socket.end();
  } catch (err) {
    warnUnexpectedSocketError('end socket', err);
    socket.destroy();
  }
}

export async function startAgentMcpBridge(options: AgentMcpBridgeOptions): Promise<AgentMcpBridge> {
  if (!Number.isInteger(options.containerUid) || !Number.isInteger(options.containerGid)) {
    throw new Error('Agent MCP bridge requires a known container UID/GID before startup');
  }

  const dataDir = canonicalizeDataDir(options.dataDir || DATA_DIR);
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
  // Integrity gates (ownership, symlink, private perms) run FIRST and throw
  // plain Errors — they must always fail closed, never degrade.
  mkdirPrivate(authDir);
  verifyOwnedByServiceUser(authDir);
  enforcePrivatePermissions(authDir);

  // Credential presence/expiry is the ONLY degradable condition here. A
  // missing marker is auth_required; a present-but-expired marker is
  // auth_expired. Both surface as the typed credential error so the caller
  // can degrade an optional bridge (or fail closed for a required one).
  const marker = path.join(authDir, AUTH_MARKER);
  if (!fs.existsSync(marker)) {
    throw new AgentMcpCredentialUnavailableError('auth_required', sanitizedCredentialMessage('auth_required'));
  }
  if (isMarkerExpired(marker)) {
    throw new AgentMcpCredentialUnavailableError('auth_expired', sanitizedCredentialMessage('auth_expired'));
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
      closeSocketQuietly(socket, message);
      if (child && !child.killed) child.kill();
      if (lock) releaseBridgeLock(lock);
    };

    socket.on('error', (err) => {
      warnUnexpectedSocketError('socket', err);
    });

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
        closeSocketQuietly(socket);
      });
      child.stdout.once('data', () => {
        settled = true;
        clearTimeout(watchdog);
        if (lock) {
          releaseBridgeLock(lock);
          lock = undefined;
        }
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

  const bridge: AgentMcpBridge = {
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

  if (options.verifyReadyOnStartup) {
    try {
      await verifyProxyReadyOnStartup(
        spawnImpl,
        releaseRoot,
        proxyEntrypoint,
        options.bridge,
        authDir,
        startupWatchdogMs,
      );
    } catch (err) {
      await bridge.stop();
      throw err;
    }
  }

  return bridge;
}

/**
 * Spawn the proxy once at startup and wait up to the watchdog for the
 * readiness byte. On a stall/exit, classify the captured stderr against the
 * known credential prompts: a match throws the typed credential error (so an
 * optional bridge can degrade), an unclassified stall throws a plain
 * fail-closed startup error. The probe child is always killed before return.
 */
async function verifyProxyReadyOnStartup(
  spawnImpl: SpawnLike,
  releaseRoot: string,
  proxyEntrypoint: string,
  bridge: AgentMcpBridgeRuntimeConfig,
  authDir: string,
  startupWatchdogMs: number,
): Promise<void> {
  const previousUmask = process.umask(0o077);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProxy(spawnImpl, releaseRoot, proxyEntrypoint, bridge, authDir);
  } finally {
    process.umask(previousUmask);
  }

  let stderr = '';
  const outcome = await new Promise<{ ready: boolean; exitCode: number | null }>((resolve) => {
    let done = false;
    const finish = (result: { ready: boolean; exitCode: number | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ready: false, exitCode: null }), startupWatchdogMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.stdout.once('data', () => finish({ ready: true, exitCode: null }));
    child.on('error', () => finish({ ready: false, exitCode: null }));
    child.on('close', (code) => finish({ ready: false, exitCode: code }));
  });

  if (!child.killed) child.kill();
  enforcePrivatePermissions(authDir);

  if (outcome.ready) return;

  const category = classifyBridgeCredentialFailure(stderr, outcome.exitCode);
  if (category) {
    throw new AgentMcpCredentialUnavailableError(category, sanitizedCredentialMessage(category));
  }
  // Unclassified stall/abort — fail closed. The raw stderr is logged (not
  // surfaced to the agent) so the cause is diagnosable without leaking it.
  log.warn('Agent MCP bridge startup probe failed without a recognized credential prompt', {
    serverName: bridge.serverName,
    exitCode: outcome.exitCode,
    stderr: stderr.slice(0, 1000),
  });
  throw new Error('Granola MCP bridge unavailable; proxy startup timed out');
}
