import type { McpServerConfig } from './types.js';
import {
  NATIVE_QUESTION_TOOL_ID,
  READ_ONLY_STATUS_TOOL_IDS,
  relayDeniedNativeToolIds,
} from './opencode-sdk-surface.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/**
 * Map NanoClaw v2 MCP definitions (same shape as Claude Agent SDK) into
 * OpenCode config `mcp` field. Stdio-only until `McpServerConfig` gains remote.
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = {
      type: 'local',
      command: [cfg.command, ...cfg.args],
      ...(Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
      enabled: true,
    };
  }
  return out;
}

/** Relay-mode native-tool config built from REAL SDK ids (Invariant 149). */
export interface RelayOpenCodeToolConfig {
  /** `Config.tools` overrides: each denied native tool id set to `false`. */
  tools: Record<string, boolean>;
  /** `Config.permission` denies using the REAL SDK permission keys. */
  permission: { bash: 'deny'; webfetch: 'deny'; edit: 'deny'; external_directory: 'deny' };
}

/**
 * Build the relay-mode OpenCode tool/permission config. Mutation/shell/file/web
 * + native question tools are disabled via the REAL SDK ids (a guessed category
 * name like `shell`/`filesystem`/`web` would silently no-op and leave the real
 * tool enabled), AND via the real `Config.permission` keys. Read-only status
 * tools are left enabled; the only write surface is the route-locked NanoClaw
 * `send_message` MCP tool, enforced at the MCP server admission point.
 */
export function buildRelayOpenCodeToolConfig(): RelayOpenCodeToolConfig {
  const tools: Record<string, boolean> = {};
  for (const id of relayDeniedNativeToolIds()) {
    tools[id] = false;
  }
  return {
    tools,
    permission: { bash: 'deny', webfetch: 'deny', edit: 'deny', external_directory: 'deny' },
  };
}

/**
 * POSITIVELY compute the actually-reachable tool set under a relay config: a
 * native OpenCode tool is reachable only if it is NOT set to `false` in
 * `tools`, and we additionally enumerate the relay's MCP write/status tools.
 * A test asserts this equals the allowlist (route-locked send_message + listed
 * read-only status tools), not merely that deny keys exist.
 */
export function reachableRelayTools(
  config: RelayOpenCodeToolConfig,
  allow: { mcpTools: string[]; readOnlyStatusTools: string[] },
): string[] {
  const reachable = new Set<string>();
  // MCP write tools the relay exposes (route-locked send_message only).
  for (const t of allow.mcpTools) reachable.add(t);
  // Native read-only status tools that are NOT disabled by the relay config.
  for (const id of allow.readOnlyStatusTools) {
    if (config.tools[id] !== false) reachable.add(id);
  }
  // Defensive: a denied native tool can NEVER be reachable.
  for (const id of Object.keys(config.tools)) {
    if (config.tools[id] === false) reachable.delete(id);
  }
  return [...reachable];
}

export { NATIVE_QUESTION_TOOL_ID, READ_ONLY_STATUS_TOOL_IDS };
