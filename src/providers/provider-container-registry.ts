/**
 * Host-side provider container-config registry.
 *
 * Providers that need per-spawn host-side setup (extra volume mounts, env var
 * passthrough, per-session directories) register a function here. The
 * container-runner resolves the session's effective provider name, looks up
 * the registered config fn, and merges the returned mounts/env into the spawn
 * args.
 *
 * Providers without host-side needs (e.g. `claude`, `mock`) don't appear in
 * this registry at all — the lookup returns `undefined` and the spawn path
 * proceeds with only the default mounts and env.
 *
 * Skills add a new provider's host config by creating `src/providers/<name>.ts`
 * with a top-level `registerProviderContainerConfig(...)` call, then appending
 * `import './<name>.js';` to `src/providers/index.ts` (the barrel).
 */
import type { ContainerConfig } from '../container-config.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ProviderContainerContext {
  /** Per-session host directory: `<DATA_DIR>/v2-sessions/<session_id>`. */
  sessionDir: string;
  /** Agent group ID, for any per-group logic. */
  agentGroupId: string;
  /** Agent group folder name, for per-group filesystem layout. */
  agentGroupFolder?: string;
  /** Agent group display name, for host-side identity provisioning. */
  agentGroupName?: string;
  /** Parsed group container.json read once by the container runner. */
  containerConfig?: ContainerConfig;
  /** `process.env` at spawn time — pull passthrough values from here. */
  hostEnv: NodeJS.ProcessEnv;
  /** Per-group model override from container.json. When set, takes precedence over hostEnv.OPENCODE_MODEL. */
  groupModel?: string;
  /** Per-group OpenCode reasoning effort override from container.json. */
  groupReasoningEffort?: string;
}

export interface ProviderPrepareContext extends ProviderContainerContext {
  /**
   * Idempotently create the group's base OneCLI identity and required grants.
   * Provider preparation must call this before asking a privileged host helper
   * to derive a provider-specific identity from those grants.
   */
  ensureOneCliIdentityAndGrants: () => Promise<void>;
}

export interface ProviderContainerContribution {
  /** Extra volume mounts (merged with the default session/group/agent-runner mounts). */
  mounts?: VolumeMount[];
  /** Extra env vars to pass to the container (`-e KEY=VALUE`). */
  env?: Record<string, string>;
  /** Extra `--add-host` Docker args for DNS resolution of local proxy services. */
  extraHosts?: string[];
}

export type ProviderContainerConfigFn = (ctx: ProviderContainerContext) => ProviderContainerContribution;
export type ProviderPrepareFn = (ctx: ProviderPrepareContext) => Promise<void>;

const registry = new Map<string, ProviderContainerConfigFn>();
const prepareRegistry = new Map<string, ProviderPrepareFn>();

export function registerProviderContainerConfig(name: string, fn: ProviderContainerConfigFn): void {
  if (registry.has(name)) {
    throw new Error(`Provider container config already registered: ${name}`);
  }
  registry.set(name, fn);
}

export function getProviderContainerConfig(name: string): ProviderContainerConfigFn | undefined {
  return registry.get(name);
}

export function registerProviderPrepare(name: string, fn: ProviderPrepareFn): void {
  if (prepareRegistry.has(name)) {
    throw new Error(`Provider prepare hook already registered: ${name}`);
  }
  prepareRegistry.set(name, fn);
}

export function getProviderPrepare(name: string): ProviderPrepareFn | undefined {
  return prepareRegistry.get(name);
}

export function listProviderContainerConfigNames(): string[] {
  return [...registry.keys()];
}
