/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  MANAGED_REPOS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { loadAgentMcpConfigForGroup } from './agent-mcp-config.js';
import { AgentMcpCredentialUnavailableError, type AgentMcpBridge, startAgentMcpBridge } from './agent-mcp-bridge.js';
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from './container-config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  isContainerRunningAsync,
  isContainerWithLabelRunningAsync,
  stopContainer,
  stopContainerAsync,
} from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable, isDbInitialized } from './db/connection.js';
import { getSession } from './db/sessions.js';
import { initGroupFilesystem } from './group-init.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import {
  cleanupStaleTempRoots,
  createManagedSkillTempRoot,
  resolveManagedSkillRoot,
  syncManagedSkillSymlinks,
} from './yente/managed-skills.js';
import {
  assertOneCliApplied,
  ensureOneCliAgentSecretAccess,
  requireYenteHostEnv,
  YENTE_LOCAL_PROXY_HOSTNAMES,
} from './yente/service-env.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  ensureSessionWorkspaceDirs,
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
  writeSpawnSkillGeneration,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
const YENTE_ONECLI_GATEWAY_PROXY_URL_ENV = 'YENTE_ONECLI_GATEWAY_PROXY_URL';
const ONECLI_GATEWAY_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/** Active containers tracked by session ID. */
type ActiveContainer = { process: ChildProcess; containerName: string };
const activeContainers = new Map<string, ActiveContainer>();
const activeMcpBridges = new Map<string, AgentMcpBridge[]>();
const containerExitWaiters = new Map<string, Set<() => void>>();
const CONTAINER_SKILLS_BIN = '/app/skills/.bin';
const AGENT_CONTAINER_PATH = `${CONTAINER_SKILLS_BIN}:/pnpm/bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`;
const SESSION_CONTAINER_LABEL_KEY = 'nanoclaw-session';
const CLEANUP_PROCESS_EXIT_TIMEOUT_MS = 30_000;

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<void>>();

interface OneCliGatewayClient {
  ensureAgent(args: { name: string; identifier: string }): Promise<unknown>;
  applyContainerConfig(args: string[], options: { addHostMapping: false; agent: string | undefined }): Promise<boolean>;
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

function sessionIsActiveForWake(sessionId: string): boolean {
  return getSession(sessionId)?.status === 'active';
}

export function waitForContainerExit(sessionId: string, timeoutMs = 30000): Promise<boolean> {
  if (!activeContainers.has(sessionId)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const state: { timer?: NodeJS.Timeout } = {};
    const waiter = () => {
      if (state.timer) clearTimeout(state.timer);
      waiters.delete(waiter);
      if (waiters.size === 0) containerExitWaiters.delete(sessionId);
      resolve(true);
    };
    const waiters = containerExitWaiters.get(sessionId) ?? new Set<() => void>();
    waiters.add(waiter);
    containerExitWaiters.set(sessionId, waiters);

    state.timer = setTimeout(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) containerExitWaiters.delete(sessionId);
      resolve(false);
    }, timeoutMs);
    state.timer.unref();
  });
}

/**
 * Drain every tracked container on shutdown: `docker stop` with a real grace
 * period so agent work can finish, then wait for the host-side `docker run`
 * client process to exit so nothing is left in the service cgroup. Failures
 * are logged, never thrown — shutdown must proceed regardless. Bookkeeping
 * (activeContainers cleanup, session markers) happens in
 * finalizeContainerProcess via the process 'close' event.
 */
export async function drainAllContainers(graceSeconds = 30): Promise<void> {
  if (activeContainers.size === 0) return;

  const entries = [...activeContainers.entries()];
  log.info('Draining active containers for shutdown', {
    count: entries.length,
    graceSeconds,
    names: entries.map(([, entry]) => entry.containerName),
  });

  await Promise.all(
    entries.map(async ([sessionId, entry]) => {
      try {
        await stopContainerAsync(entry.containerName, graceSeconds);
      } catch (err) {
        log.warn('Failed to stop container during drain', {
          sessionId,
          containerName: entry.containerName,
          err,
        });
      }
      try {
        const exited = await waitForContainerExit(sessionId, (graceSeconds + 10) * 1000);
        if (!exited) {
          log.warn('Container process did not exit within drain window', {
            sessionId,
            containerName: entry.containerName,
          });
        }
      } catch (err) {
        log.warn('Failed waiting for container exit during drain', {
          sessionId,
          containerName: entry.containerName,
          err,
        });
      }
    }),
  );
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 */
export function wakeContainer(session: Session): Promise<void> {
  if (!sessionIsActiveForWake(session.id)) {
    log.info('Skipping container wake for inactive session', { sessionId: session.id });
    return Promise.resolve();
  }
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve();
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session).finally(() => {
    wakePromises.delete(session.id);
  });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Read container config once — threaded through provider resolution,
  // buildMounts, and buildContainerArgs so we don't re-read the file.
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Ensure container.json has the agent group identity fields the runner needs.
  // Written at spawn time so the runner can read them from the RO mount.
  ensureRuntimeFields(containerConfig, agentGroup);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  let bridges: AgentMcpBridge[] = [];
  let args: string[];
  let envFilePath = '';
  let managedSkillsRoot = '';
  let skillGeneration = '';
  try {
    const buildResult = buildMounts(agentGroup, session, containerConfig, contribution);
    const mounts = buildResult.mounts;
    managedSkillsRoot = buildResult.managedSkillsRoot;
    skillGeneration = buildResult.skillGeneration;
    bridges = await attachAgentMcpBridges(agentGroup, containerConfig, mounts);
    const built = await buildContainerArgs(
      mounts,
      containerName,
      session.id,
      agentGroup,
      containerConfig,
      provider,
      contribution,
      agentIdentifier,
    );
    args = built.args;
    envFilePath = built.envFilePath;
  } catch (err) {
    cleanupTempSkillRoot(managedSkillsRoot);
    await stopAgentMcpBridges(bridges);
    throw err;
  }

  if (!sessionIsActiveForWake(session.id)) {
    log.info('Aborting container spawn for inactive session', { sessionId: session.id, containerName });
    removeContainerEnvFile(envFilePath);
    cleanupTempSkillRoot(managedSkillsRoot);
    await stopAgentMcpBridges(bridges);
    return;
  }

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // `docker run` reads --env-file client-side at create time. Delete the file
  // at the earliest signal that create has completed: any container output,
  // process exit, or spawn error. Crash leftovers are swept at startup by
  // cleanupStaleContainerEnvFiles().
  const removeEnvFile = () => removeContainerEnvFile(envFilePath);
  container.stdout?.once('data', removeEnvFile);
  container.stderr?.once('data', removeEnvFile);
  container.once('close', removeEnvFile);
  container.once('error', removeEnvFile);

  activeContainers.set(session.id, { process: container, containerName });
  if (bridges.length > 0) {
    activeMcpBridges.set(session.id, bridges);
  }
  markContainerRunning(session.id);
  // Record the deployed skill generation this container mounted, so host-sweep
  // can recycle it after a later skill deploy. Best-effort inside the helper.
  writeSpawnSkillGeneration(sessionDir(agentGroup.id, session.id), skillGeneration);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    finalizeContainerProcess(session.id, containerName, code);
    cleanupTempSkillRoot(managedSkillsRoot);
  });

  container.on('error', (err) => {
    finalizeContainerProcess(session.id, containerName, null);
    cleanupTempSkillRoot(managedSkillsRoot);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

function cleanupTempSkillRoot(root: string): void {
  if (!root || !root.includes('.nanoclaw-skills-')) return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Non-fatal — stale temp roots are swept on next startup.
  }
}

function finalizeContainerProcess(sessionId: string, containerName: string, code: number | null): void {
  const wasActive = activeContainers.delete(sessionId);
  void stopAgentMcpBridges(activeMcpBridges.get(sessionId) ?? []);
  activeMcpBridges.delete(sessionId);
  if (!wasActive) {
    notifyContainerExit(sessionId);
    return;
  }
  if (isDbInitialized()) {
    markContainerStopped(sessionId);
  } else {
    log.warn('Container exited after DB shutdown; skipped session stopped marker', { sessionId, containerName });
  }
  stopTypingRefresh(sessionId);
  notifyContainerExit(sessionId);
  log.info('Container exited', { sessionId, code, containerName });
}

function notifyContainerExit(sessionId: string): void {
  const waiters = containerExitWaiters.get(sessionId);
  if (!waiters) return;
  containerExitWaiters.delete(sessionId);
  for (const waiter of waiters) {
    waiter();
  }
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

function processAppearsAlive(proc: ChildProcess): boolean {
  if (!proc.pid) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupContainerForSession(sessionId: string, reason: string): Promise<boolean> {
  const entry = activeContainers.get(sessionId);
  if (!entry) return false;

  log.info('Cleaning up container for superseded session', {
    sessionId,
    reason,
    containerName: entry.containerName,
  });

  try {
    await stopContainerAsync(entry.containerName);
    await verifyContainerProcessExited(sessionId, entry, reason);
    return true;
  } catch (stopErr) {
    let killErr: unknown;
    if (processAppearsAlive(entry.process)) {
      try {
        entry.process.kill('SIGKILL');
      } catch (err) {
        killErr = err;
      }
    }

    let stillRunning: boolean;
    try {
      stillRunning = await isContainerRunningAsync(entry.containerName);
    } catch (inspectErr) {
      throw new AggregateError(
        [stopErr, killErr, inspectErr].filter((err) => err !== undefined),
        `Failed to verify cleanup for session ${sessionId}`,
        { cause: inspectErr },
      );
    }

    if (!stillRunning) {
      await verifyContainerProcessExited(sessionId, entry, reason);
      log.info('Superseded session container already exited during cleanup', {
        sessionId,
        reason,
        containerName: entry.containerName,
      });
      return true;
    }

    throw new AggregateError(
      [stopErr, killErr].filter((err) => err !== undefined),
      `Failed to clean up container for session ${sessionId}`,
      { cause: stopErr },
    );
  }
}

export async function stopContainerAndVerify(sessionId: string, reason: string): Promise<void> {
  const cleanedTrackedContainer = await cleanupContainerForSession(sessionId, reason);
  await assertNoSessionContainerWriterByLabel(sessionId);

  if (!cleanedTrackedContainer) {
    log.info('No active container process found while verifying stopped session', { sessionId, reason });
  }
}

async function assertNoSessionContainerWriterByLabel(sessionId: string): Promise<void> {
  try {
    const runningByLabel = await isContainerWithLabelRunningAsync(`${SESSION_CONTAINER_LABEL_KEY}=${sessionId}`);
    if (runningByLabel) {
      throw new Error(`Failed to stop container for session ${sessionId}: runtime label still reports a writer`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('runtime label still reports a writer')) throw err;
    throw new Error(`Failed to verify stopped container for session ${sessionId}`, { cause: err });
  }
}

async function verifyContainerProcessExited(sessionId: string, entry: ActiveContainer, reason: string): Promise<void> {
  if (!activeContainers.has(sessionId)) return;
  if (await runtimeReportsSessionStopped(sessionId, entry, reason)) {
    log.info('Container runtime reports stopped before process exit; finalizing process record', {
      sessionId,
      reason,
      containerName: entry.containerName,
    });
    finalizeContainerProcess(sessionId, entry.containerName, null);
    return;
  }

  if (await waitForContainerExit(sessionId, CLEANUP_PROCESS_EXIT_TIMEOUT_MS)) return;

  if (await runtimeReportsSessionStopped(sessionId, entry, reason)) {
    log.warn('Container process exit event missing after cleanup; finalizing stale process record', {
      sessionId,
      reason,
      containerName: entry.containerName,
    });
    finalizeContainerProcess(sessionId, entry.containerName, null);
    return;
  }

  throw new Error(`Failed to verify container process exit for session ${sessionId}`);
}

async function runtimeReportsSessionStopped(
  sessionId: string,
  entry: Pick<ActiveContainer, 'containerName'>,
  reason: string,
): Promise<boolean> {
  const runningByName = await isContainerRunningAsync(entry.containerName).catch((err) => {
    log.warn('Failed to inspect stopped container by name', {
      sessionId,
      reason,
      containerName: entry.containerName,
      err,
    });
    return true;
  });
  if (runningByName) return false;

  const runningByLabel = await isContainerWithLabelRunningAsync(`${SESSION_CONTAINER_LABEL_KEY}=${sessionId}`).catch(
    (err) => {
      log.warn('Failed to inspect stopped container by label', {
        sessionId,
        reason,
        containerName: entry.containerName,
        err,
      });
      return true;
    },
  );
  return !runningByLabel;
}

export async function isSessionOutboundWriterRunning(session: Session): Promise<boolean> {
  const entry = activeContainers.get(session.id);
  if (entry) {
    const runningByName = await isContainerRunningAsync(entry.containerName).catch((err) => {
      log.warn('Failed to inspect active session container by name', {
        sessionId: session.id,
        containerName: entry.containerName,
        err,
      });
      return true;
    });
    if (runningByName) return true;

    const runningByLabel = await isContainerWithLabelRunningAsync(`${SESSION_CONTAINER_LABEL_KEY}=${session.id}`).catch(
      (err) => {
        log.warn('Failed to inspect active session container by label', {
          sessionId: session.id,
          containerName: entry.containerName,
          err,
        });
        return true;
      },
    );
    if (runningByLabel) return true;

    return false;
  }

  return await isContainerWithLabelRunningAsync(`${SESSION_CONTAINER_LABEL_KEY}=${session.id}`).catch((err) => {
    log.warn('Failed to inspect session container by label', {
      sessionId: session.id,
      err,
    });
    return true;
  });
}

/**
 * Resolve the provider name for a session. The single authoritative source is
 * groups/<folder>/container.json; legacy DB provider columns are accepted only
 * when unset or matching that file, so stale DB rows cannot silently override a
 * reviewed per-group config change.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  const provider = normalizeProviderName(containerConfigProvider) ?? 'claude';
  const conflicts = [
    legacyProviderConflict('sessions.agent_provider', sessionProvider, provider),
    legacyProviderConflict('agent_groups.agent_provider', agentGroupProvider, provider),
  ].filter((conflict): conflict is string => conflict !== null);

  if (conflicts.length > 0) {
    throw new Error(
      `Provider config conflict: container.json resolves to '${provider}', but ${conflicts.join(
        ' and ',
      )}. Set provider/model in groups/<folder>/container.json and clear or align the legacy DB provider column.`,
    );
  }

  return provider;
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  let provider: string;
  try {
    provider = resolveProviderName(session.agent_provider, agentGroup.agent_provider, containerConfig.provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent group ${agentGroup.id} (${agentGroup.folder}) has invalid provider config: ${message}`, {
      cause: err,
    });
  }
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        agentGroupFolder: agentGroup.folder,
        containerConfig,
        hostEnv: process.env,
        groupModel: containerConfig.model,
        groupReasoningEffort: containerConfig.reasoningEffort,
      })
    : {};
  return { provider, contribution };
}

function normalizeProviderName(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function legacyProviderConflict(
  source: string,
  value: string | null | undefined,
  authoritativeProvider: string,
): string | null {
  const normalized = normalizeProviderName(value);
  if (!normalized || normalized === authoritativeProvider) return null;
  return `${source} is '${normalized}'`;
}

export function resolveContainerIdentity(): { uid: number; gid: number } {
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostGid != null && hostUid !== 0 && hostUid !== 1000) {
    return { uid: hostUid, gid: hostGid };
  }
  return { uid: 1000, gid: 1000 };
}

function realpathIfExists(inputPath: string): string {
  if (fs.existsSync(inputPath)) {
    try {
      return fs.realpathSync.native(inputPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
  return path.resolve(inputPath);
}

function pathOverlaps(first: string, second: string): boolean {
  const firstToSecond = path.relative(first, second);
  const secondToFirst = path.relative(second, first);
  return (
    firstToSecond === '' ||
    (!firstToSecond.startsWith('..') && !path.isAbsolute(firstToSecond)) ||
    secondToFirst === '' ||
    (!secondToFirst.startsWith('..') && !path.isAbsolute(secondToFirst))
  );
}

function rejectAuthOverlappingMounts(mounts: VolumeMount[], authDirs: string[]): void {
  const canonicalAuthDirs = authDirs.map(realpathIfExists);
  for (const mount of mounts) {
    const canonicalMount = realpathIfExists(mount.hostPath);
    for (const authDir of canonicalAuthDirs) {
      if (pathOverlaps(canonicalMount, authDir)) {
        throw new Error(`Refusing to mount Granola MCP auth path or parent into agent container: ${mount.hostPath}`);
      }
    }
  }
}

type AgentMcpUnavailableMap = NonNullable<import('./container-config.js').ContainerConfig['agentMcpUnavailable']>;

function syncAgentMcpRuntimeConfig(
  groupFolder: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  bridges: AgentMcpBridge[],
  allowedTools: string[],
  unavailable: AgentMcpUnavailableMap,
): void {
  const before = JSON.stringify({
    mcpServers: containerConfig.mcpServers,
    agentMcpServerNames: containerConfig.agentMcpServerNames,
    agentMcpAllowedTools: containerConfig.agentMcpAllowedTools,
    agentMcpUnavailable: containerConfig.agentMcpUnavailable,
  });

  const previousManagedServers = new Set(containerConfig.agentMcpServerNames ?? []);
  for (const [serverName, serverConfig] of Object.entries(containerConfig.mcpServers)) {
    const isSocketBridge =
      serverConfig.command === 'bun' &&
      Array.isArray(serverConfig.args) &&
      serverConfig.args.includes('/app/src/mcp-unix-socket-stdio.ts');
    if (previousManagedServers.has(serverName) || isSocketBridge) {
      delete containerConfig.mcpServers[serverName];
    }
  }

  // A degraded server's MCP entry and its allowed tools are omitted from the
  // runtime config so the agent neither sees a dead bridge nor a tool it
  // cannot use.
  const degradedNames = new Set(Object.keys(unavailable));
  for (const bridge of bridges) {
    containerConfig.mcpServers[bridge.serverName] = {
      command: 'bun',
      args: ['run', '/app/src/mcp-unix-socket-stdio.ts', bridge.containerSocketPath],
      env: {},
    };
  }
  containerConfig.agentMcpServerNames = bridges.map((bridge) => bridge.serverName);
  containerConfig.agentMcpAllowedTools = allowedTools.filter(
    (tool) => ![...degradedNames].some((name) => tool.startsWith(`mcp__${name}__`)),
  );

  if (degradedNames.size > 0) {
    containerConfig.agentMcpUnavailable = unavailable;
  } else {
    // Clear stale unavailable entries once every optional bridge is healthy.
    delete containerConfig.agentMcpUnavailable;
  }

  if (
    JSON.stringify({
      mcpServers: containerConfig.mcpServers,
      agentMcpServerNames: containerConfig.agentMcpServerNames,
      agentMcpAllowedTools: containerConfig.agentMcpAllowedTools,
      agentMcpUnavailable: containerConfig.agentMcpUnavailable,
    }) !== before
  ) {
    writeContainerConfig(groupFolder, containerConfig);
  }
}

async function attachAgentMcpBridges(
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  mounts: VolumeMount[],
): Promise<AgentMcpBridge[]> {
  const mcpConfig = loadAgentMcpConfigForGroup(agentGroup.folder);
  const containerIdentity = resolveContainerIdentity();
  const bridges: AgentMcpBridge[] = [];
  const unavailable: AgentMcpUnavailableMap = {};

  try {
    for (const [serverName, bridgeConfig] of Object.entries(mcpConfig.bridges)) {
      try {
        const bridge = await startAgentMcpBridge({
          groupFolder: agentGroup.folder,
          agentGroupId: agentGroup.id,
          bridge: { serverName, ...bridgeConfig },
          containerUid: containerIdentity.uid,
          containerGid: containerIdentity.gid,
        });
        bridges.push(bridge);
        mounts.push({
          hostPath: bridge.hostSocketDir,
          containerPath: bridge.containerSocketDir,
          readonly: false,
        });
      } catch (err) {
        // Narrow degradation: ONLY an expected missing/expired credential class
        // on an OPTIONAL bridge degrades to unavailable. A required bridge, or
        // ANY non-credential failure (integrity/ownership/symlink/mount-overlap/
        // malformed), rethrows and fails closed (stopping started bridges).
        if (err instanceof AgentMcpCredentialUnavailableError && bridgeConfig.required === false) {
          log.warn('Optional agent MCP bridge degraded to unavailable', {
            group: agentGroup.folder,
            serverName,
            category: err.category,
          });
          unavailable[serverName] = { category: err.category, message: err.message };
          continue;
        }
        throw err;
      }
    }
    if (bridges.length > 0) {
      rejectAuthOverlappingMounts(
        mounts,
        bridges.map((bridge) => bridge.authDir),
      );
    }
    syncAgentMcpRuntimeConfig(agentGroup.folder, containerConfig, bridges, mcpConfig.allowedTools, unavailable);
    // Recompose CLAUDE.md so the sanitized unavailable state (or its removal)
    // reaches the OpenCode-loaded .claude-fragments/*.md system context.
    composeGroupClaudeMd(agentGroup);
    return bridges;
  } catch (err) {
    await stopAgentMcpBridges(bridges);
    throw err;
  }
}

async function stopAgentMcpBridges(bridges: AgentMcpBridge[]): Promise<void> {
  await Promise.allSettled(bridges.map((bridge) => bridge.stop()));
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): { mounts: VolumeMount[]; managedSkillsRoot: string; skillGeneration: string } {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sweep stale temp roots from a previous process before creating ours.
  cleanupStaleTempRoots(DATA_DIR);

  // Create temp root here so we own its lifecycle. If any step below throws,
  // the catch block ensures the temp dir is cleaned up.
  const tempRoot = createManagedSkillTempRoot(DATA_DIR);
  try {
    const managedSkills = resolveManagedSkillRoot({ projectRoot, dataDir: DATA_DIR, env: process.env, root: tempRoot });

    // Sync skill symlinks based on container.json selection before mounting.
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
    syncManagedSkillSymlinks({ claudeDir, skillRoot: managedSkills.root, selection: containerConfig.skills });

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);

    const mounts: VolumeMount[] = [];
    const sessDir = sessionDir(agentGroup.id, session.id);
    ensureSessionWorkspaceDirs(agentGroup.id, session.id);
    const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

    // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
    mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

    // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

    // container.json — nested RO mount on top of RW group dir so the agent
    // can read its config but cannot modify it.
    const containerJsonPath = path.join(groupDir, 'container.json');
    if (fs.existsSync(containerJsonPath)) {
      mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
    }

    // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
    // regenerated from the shared base + fragments on every spawn; any
    // agent-side writes would be clobbered, so enforce read-only. Only
    // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
    // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
    // already RO-mounted, so writes through it fail regardless — no need for
    // a nested mount there.
    const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(composedClaudeMd)) {
      mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
    }
    const fragmentsDir = path.join(groupDir, '.claude-fragments');
    if (fs.existsSync(fragmentsDir)) {
      mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
    }

    // Global memory directory — always read-only.
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
    }

    // Shared CLAUDE.md — read-only, imported by the composed entry point via
    // the `.claude-shared.md` symlink inside the group dir.
    const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
    if (fs.existsSync(sharedClaudeMd)) {
      mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
    }

    // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
    // skill symlinks)
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

    // Shared agent-runner source — read-only, same code for all groups.
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

    // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
    mounts.push({ hostPath: managedSkills.root, containerPath: '/app/skills', readonly: true });

    const localSkillsMount = buildLocalSkillsMount(agentGroup);
    if (localSkillsMount) {
      mounts.push(localSkillsMount);
    }

    mounts.push(...buildManagedReposMounts(agentGroup));

    const managedReposIpcMount = buildManagedReposIpcMount(agentGroup);
    if (managedReposIpcMount) {
      mounts.push(managedReposIpcMount);
    }

    // Additional mounts from container config
    if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
      const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
      mounts.push(...validated);
    }

    // Provider-contributed mounts (e.g. opencode-xdg)
    if (providerContribution.mounts) {
      mounts.push(...providerContribution.mounts);
    }

    return { mounts, managedSkillsRoot: managedSkills.root, skillGeneration: managedSkills.generation };
  } catch (_err) {
    cleanupTempSkillRoot(tempRoot);
    throw _err;
  }
}

export function buildLocalSkillsMount(
  _agentGroup: Pick<AgentGroup, 'folder'>,
  env: NodeJS.ProcessEnv = process.env,
): VolumeMount | null {
  const writableDir = env.NANOCLAW_WRITABLE_SKILLS_DIR?.trim();
  if (!writableDir) return null;
  return {
    hostPath: writableDir,
    containerPath: '/workspace/local-skills',
    readonly: false,
  };
}

export function buildManagedReposMounts(
  _agentGroup: Pick<AgentGroup, 'folder'>,
  env: NodeJS.ProcessEnv = process.env,
): VolumeMount[] {
  const managedReposDir = env.NANOCLAW_MANAGED_REPOS_DIR?.trim() || MANAGED_REPOS_DIR;
  if (!managedReposDir) return [];
  if (!fs.existsSync(managedReposDir)) {
    throw new Error(`NANOCLAW_MANAGED_REPOS_DIR must exist: ${managedReposDir}`);
  }
  return [
    {
      hostPath: managedReposDir,
      containerPath: '/workspace/repos',
      readonly: false,
    },
    {
      hostPath: managedReposDir,
      containerPath: '/workspace/extra/repos',
      readonly: false,
    },
  ];
}

export function buildManagedReposIpcMount(agentGroup: Pick<AgentGroup, 'folder'>): VolumeMount | null {
  const hostPath = resolveGroupIpcPath(agentGroup.folder);
  fs.mkdirSync(path.join(hostPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(hostPath, 'responses'), { recursive: true });
  return {
    hostPath,
    containerPath: '/workspace/ipc',
    readonly: false,
  };
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(containerConfig: ContainerConfig, agentGroup: AgentGroup): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  if (dirty) {
    writeContainerConfig(agentGroup.folder, containerConfig);
  }
}

type ResolveAgentImageForRunOptions = {
  agentGroupId: string;
  groupFolder: string;
  containerConfig: ContainerConfig;
  currentImageBase?: string;
  currentImage?: string;
  rebuildAgentGroupImage?: (agentGroupId: string) => Promise<string | void>;
  readContainerConfigForGroup?: (groupFolder: string) => ContainerConfig;
  writeContainerConfigForGroup?: (groupFolder: string, containerConfig: ContainerConfig) => void;
};

export async function resolveAgentImageForRun(
  options: ResolveAgentImageForRunOptions,
): Promise<{ imageTag: string; rebuilt: boolean }> {
  const currentImageBase = options.currentImageBase ?? CONTAINER_IMAGE_BASE;
  const currentImage = options.currentImage ?? CONTAINER_IMAGE;
  const packages = options.containerConfig.packages;
  const hasPackages = (packages?.apt?.length ?? 0) > 0 || (packages?.npm?.length ?? 0) > 0;
  const expectedPackageImage = `${currentImageBase}:${options.agentGroupId}`;

  if (!hasPackages) {
    if (options.containerConfig.imageTag !== undefined) {
      delete options.containerConfig.imageTag;
      const writeConfig = options.writeContainerConfigForGroup ?? writeContainerConfig;
      writeConfig(options.groupFolder, options.containerConfig);
    }
    return { imageTag: currentImage, rebuilt: false };
  }

  if (options.containerConfig.imageTag === expectedPackageImage) {
    return { imageTag: options.containerConfig.imageTag, rebuilt: false };
  }

  const rebuild = options.rebuildAgentGroupImage ?? buildAgentGroupImage;
  const rebuiltTag = await rebuild(options.agentGroupId);
  const readConfig = options.readContainerConfigForGroup ?? readContainerConfig;
  const freshTag = typeof rebuiltTag === 'string' ? rebuiltTag : readConfig(options.groupFolder).imageTag;

  if (freshTag !== expectedPackageImage) {
    throw new Error(
      `Per-agent image for ${options.groupFolder} was rebuilt as '${freshTag || 'missing'}', expected '${expectedPackageImage}'`,
    );
  }

  return { imageTag: freshTag, rebuilt: true };
}

/**
 * Directory holding per-container docker `--env-file` files. Lives under the
 * service-owned data root (never world-readable /tmp): env values include
 * auth-bearing proxy URLs that must not appear on the docker command line
 * (visible in /proc/<pid>/cmdline and `systemctl status` output).
 */
function containerEnvDir(): string {
  return path.join(DATA_DIR, 'container-env');
}

/**
 * Rewrite docker-run args, moving every `-e KEY=value` pair into an env file
 * at `envFilePath` (mode 0600) and inserting `--env-file <path>` in its place,
 * so secret values never appear on the docker command line.
 *
 * Docker's env-file format has no quoting/escaping and no multiline values,
 * so a value containing a newline could inject extra env entries — such
 * values are rejected outright. Duplicate keys are deduped last-wins to
 * mirror docker's `-e` semantics. Bare `-e KEY` passthrough entries (no `=`)
 * carry no value on the command line and are left as-is.
 */
export function extractDockerEnvArgsToFile(args: readonly string[], envFilePath: string): string[] {
  const entries: Array<[key: string, value: string]> = [];
  const out: string[] = [];
  let inserted = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-e' && index + 1 < args.length) {
      const entry = args[index + 1];
      const eq = entry.indexOf('=');
      if (eq > 0) {
        entries.push([entry.slice(0, eq), entry.slice(eq + 1)]);
        if (!inserted) {
          out.push('--env-file', envFilePath);
          inserted = true;
        }
        index++;
        continue;
      }
    }
    out.push(args[index]);
  }
  if (entries.length === 0) return out;
  const merged = new Map<string, string>();
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(
        `Container env var '${key.split(/[\r\n]/)[0]}' contains a newline; refusing to write docker env file`,
      );
    }
    merged.set(key, value);
  }
  const lines = [...merged.entries()].map(([key, value]) => `${key}=${value}`);
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFilePath, `${lines.join('\n')}\n`, { mode: 0o600 });
  return out;
}

/** Best-effort removal of a per-container env file (idempotent). */
function removeContainerEnvFile(envFilePath: string): void {
  if (!envFilePath) return;
  try {
    fs.rmSync(envFilePath, { force: true });
  } catch {
    // Non-fatal — stale env files are swept on next startup.
  }
}

/**
 * Sweep stale per-container env files left behind by a crash. Called at
 * startup right after cleanupOrphans(), before any container spawns, so
 * removing the whole directory is safe.
 */
export function cleanupStaleContainerEnvFiles(): void {
  try {
    fs.rmSync(containerEnvDir(), { recursive: true, force: true });
  } catch (err) {
    log.warn('Failed to clean up stale container env files', { err });
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  sessionId: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<{ args: string[]; envFilePath: string }> {
  const args: string[] = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--label',
    CONTAINER_INSTALL_LABEL,
    '--label',
    `${SESSION_CONTAINER_LABEL_KEY}=${sessionId}`,
  ];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `PATH=${AGENT_CONTAINER_PATH}`);

  // Side-effect ledger: the static staging path the GWS shim and summarize-dnd
  // append validated-side-effect evidence to. Per-input correlation is NOT an
  // env var (a long-lived child can't see follow-up updates); it is the
  // /workspace/.active-input.json file the poll loop writes on each
  // input-accepted. We only need /workspace writable by the poll loop and
  // readable by tools, which the workspace mount already provides.
  args.push('-e', 'NANOCLAW_SIDE_EFFECT_LEDGER=/workspace/side-effects.jsonl');
  args.push('-e', `NANOCLAW_AGENT_GROUP_ID=${agentGroup.id}`);
  args.push('-e', `NANOCLAW_AGENT_GROUP_FOLDER=${agentGroup.folder}`);

  const yenteHostEnv = requireYenteHostEnv(process.env);
  for (const [key, value] of Object.entries(yenteHostEnv.containerEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  // Ed25519 PUBLIC verify key only — verification grants no forging power, so
  // it is safe in the agent container. The private signing key lives only in
  // the gws-proxy container and is NEVER injected here. When unset (dev /
  // pre-deploy) Gmail side-effect recovery is simply inactive (staged entries
  // stay unvalidated hints).
  const sideEffectVerifyKey = process.env.GWS_SIDE_EFFECT_VERIFY_KEY?.trim();
  if (sideEffectVerifyKey) {
    args.push('-e', `GWS_SIDE_EFFECT_VERIFY_KEY=${sideEffectVerifyKey}`);
  }

  await applyOneCliGatewayForContainerArgs(args, {
    client: onecli,
    containerName,
    agentGroupName: agentGroup.name,
    agentIdentifier,
  });

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  // Keep these after the generic OneCLI gateway contribution so providers with
  // stricter proxy boundaries, such as Codex's auth-gated OneCLI proxy, remain
  // the final Docker env values when keys overlap.
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Host gateway
  args.push(
    ...hostGatewayArgs([...new Set([...YENTE_LOCAL_PROXY_HOSTNAMES, ...(providerContribution.extraHosts ?? [])])]),
  );

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  const image = await resolveAgentImageForRun({
    agentGroupId: agentGroup.id,
    groupFolder: agentGroup.folder,
    containerConfig,
  });
  args.push(image.imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  // Move all `-e KEY=value` pairs (including OneCLI-gateway- and
  // provider-contributed secrets) into a private 0600 env file so token-
  // bearing values never appear in /proc/<pid>/cmdline. Written last so an
  // earlier throw in this function leaves no file behind.
  const envFilePath = path.join(containerEnvDir(), `${containerName}.env`);
  return { args: extractDockerEnvArgsToFile(args, envFilePath), envFilePath };
}

export async function applyOneCliGatewayForContainerArgs(
  args: string[],
  context: {
    client: OneCliGatewayClient;
    containerName: string;
    agentGroupName: string;
    agentIdentifier?: string;
    ensureSecretAccess?: (agentIdentifier: string) => Promise<void>;
  },
): Promise<void> {
  try {
    if (context.agentIdentifier) {
      await context.client.ensureAgent({ name: context.agentGroupName, identifier: context.agentIdentifier });
      await (
        context.ensureSecretAccess ??
        ((agentIdentifier) =>
          ensureOneCliAgentSecretAccess({
            onecliUrl: ONECLI_URL,
            onecliApiKey: ONECLI_API_KEY,
            agentIdentifier,
          }))
      )(context.agentIdentifier);
    }
    const applied = await context.client.applyContainerConfig(args, {
      addHostMapping: false,
      agent: context.agentIdentifier,
    });
    assertOneCliApplied(applied);
    const gatewayProxyUrl = latestDockerEnvValue(args, ONECLI_GATEWAY_PROXY_ENV_KEYS);
    if (gatewayProxyUrl) {
      args.push('-e', `${YENTE_ONECLI_GATEWAY_PROXY_URL_ENV}=${gatewayProxyUrl}`);
    }
    log.info('OneCLI gateway applied', { containerName: context.containerName });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('OneCLI gateway did not apply')) {
      throw err;
    }
    throw new Error(
      'OneCLI gateway failed; refusing to start Yente container without credential isolation. Check ONECLI_URL and ONECLI_API_KEY.',
      { cause: err },
    );
  }
}

function latestDockerEnvValue(args: readonly string[], keys: readonly string[]): string | undefined {
  const keySet = new Set(keys);
  for (let index = args.length - 2; index >= 0; index--) {
    if (args[index] !== '-e') continue;
    const entry = args[index + 1];
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    if (keySet.has(entry.slice(0, eq))) return entry.slice(eq + 1);
  }
  return undefined;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function assertNoReservedAgentCommandCollisionsShell(expectedGwsPath = '/usr/local/bin/gws'): string {
  const expected = shellSingleQuote(expectedGwsPath);
  return [
    `expected_gws=${expected}; test "$(command -v gws)" = "$expected_gws" || exit 1`,
    `old_ifs="$IFS"; IFS=:; for dir in $PATH; do test -n "$dir" || dir=.; candidate="$dir/gws"; if test -x "$candidate" && test "$candidate" != "$expected_gws"; then echo "reserved gws command collision: $candidate" >&2; exit 1; fi; done; IFS="$old_ifs"`,
    'test ! -e /pnpm/gws',
  ].join(' && ');
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += `RUN ${assertNoReservedAgentCommandCollisionsShell()}\n`;
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Use a per-build temp directory so concurrent rebuilds for the same agent
  // group do not share and delete the same Dockerfile path.
  const tmpBuildDir = fs.mkdtempSync(path.join(DATA_DIR, `.nanoclaw-image-build-${agentGroupId}-`));
  const tmpDockerfile = path.join(tmpBuildDir, 'Dockerfile');
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(
      `${CONTAINER_RUNTIME_BIN} build -t ${shellSingleQuote(imageTag)} -f ${shellSingleQuote(tmpDockerfile)} .`,
      {
        cwd: DATA_DIR,
        stdio: 'pipe',
        timeout: 300_000,
      },
    );
  } finally {
    fs.rmSync(tmpBuildDir, { recursive: true, force: true });
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
