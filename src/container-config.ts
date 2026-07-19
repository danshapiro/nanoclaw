/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it. Config changes go through the self-mod approval flow.
 *
 * All fields are optional — a missing file or a partial file both resolve
 * to sensible defaults. Writes are atomic-enough (write-then-rename is not
 * worth the ceremony here since there's only one writer in practice: the
 * host, from the delivery thread that processes approved system actions).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export type SkillSelection = string[] | 'all';

export interface CodexContainerConfig {
  onecliConfigPath?: string;
  brokerTarget?: string;
  brokerSocket?: string;
  authGateHost?: string;
  authGatePort?: number;
}

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  /** Host-managed MCP bridge server names. Removed/replaced at spawn time. */
  agentMcpServerNames?: string[];
  /** Host-managed provider tool allowlist entries for agent MCP bridges. */
  agentMcpAllowedTools?: string[];
  /**
   * Host-managed map of agent MCP bridges that degraded to unavailable due to
   * an expected missing/expired credential. Written at spawn time when an
   * OPTIONAL bridge (e.g. Granola) hits a known credential class; the offending
   * MCP server + its allowed tools are omitted from the runtime config. The
   * sanitized `message` is surfaced to the agent via a CLAUDE.md fragment.
   * Cleared at spawn time when the bridge later starts successfully.
   */
  agentMcpUnavailable?: Record<string, { category: string; message: string }>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: SkillSelection;
  /** Agent provider name (e.g. "claude", "codex", "opencode"). */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /** Per-group model override. When set, overrides the global OPENCODE_MODEL for this group only. */
  model?: string;
  /** Per-group OpenCode reasoning effort override, passed through to the build agent when set. */
  reasoningEffort?: string;
  /** Per-group Codex credential and egress paths, managed by host tooling. */
  codex?: CodexContainerConfig;
}

function emptyConfig(provider?: string): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    ...(provider ? { provider } : {}),
  };
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
    return {
      mcpServers: raw.mcpServers ?? {},
      agentMcpServerNames: raw.agentMcpServerNames ?? [],
      agentMcpAllowedTools: raw.agentMcpAllowedTools ?? [],
      agentMcpUnavailable: raw.agentMcpUnavailable,
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      model: raw.model,
      reasoningEffort: raw.reasoningEffort,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      codex: raw.codex,
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize a baseline container.json for a group if one doesn't already
 * exist, stamping its creation-time provider. Idempotent — used from
 * `group-init.ts`; an existing file is never changed.
 */
export function initContainerConfig(folder: string, provider: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  const normalizedProvider = provider.trim().toLowerCase() || 'claude';
  writeContainerConfig(folder, emptyConfig(normalizedProvider));
  return true;
}
