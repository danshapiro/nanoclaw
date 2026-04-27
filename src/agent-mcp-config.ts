import fs from 'fs';
import path from 'path';

import { AGENT_MCP_CONFIG_PATH } from './config.js';

export type AgentMcpBridgeConfig = {
  type: 'mcp-remote-unix-socket';
  remoteUrl: string;
  callbackPort: number;
  socketNamePrefix: string;
};

export type AgentMcpConfigForGroup = {
  allowedTools: string[];
  bridges: Record<string, AgentMcpBridgeConfig>;
};

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SOCKET_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,15}$/;

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent MCP config ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isUnsafePathName(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('.') ||
    value.includes('/') ||
    value.includes('\\') ||
    path.basename(value) !== value
  );
}

function validateServerName(serverName: string): void {
  if (serverName === 'nanoclaw' || isUnsafePathName(serverName) || !SERVER_NAME_RE.test(serverName)) {
    throw new Error(`Invalid Agent MCP bridge server name: ${serverName}`);
  }
}

function validateSocketNamePrefix(serverName: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Agent MCP bridge ${serverName} socketNamePrefix must be a string`);
  }
  if (isUnsafePathName(value) || !SOCKET_PREFIX_RE.test(value)) {
    throw new Error(`Agent MCP bridge ${serverName} socketNamePrefix is invalid: ${value}`);
  }
  return value;
}

function validateRemoteUrl(serverName: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Agent MCP bridge ${serverName} remoteUrl must be a string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(`Agent MCP bridge ${serverName} remoteUrl is invalid`, { cause: err });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Agent MCP bridge ${serverName} remoteUrl must use HTTPS`);
  }
  return value;
}

function validateCallbackPort(serverName: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`Agent MCP bridge ${serverName} callbackPort must be an integer in 1024..65535`);
  }
  return value;
}

function configuredPath(): string | undefined {
  return process.env.AGENT_MCP_CONFIG_PATH || process.env.NANOCLAW_AGENT_MCP_CONFIG || AGENT_MCP_CONFIG_PATH;
}

export function loadAgentMcpConfigForGroup(groupFolder: string): AgentMcpConfigForGroup {
  const configPath = configuredPath();
  if (!configPath) {
    return { allowedTools: [], bridges: {} };
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent MCP config path is configured but does not exist: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Agent MCP config is invalid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  const root = asRecord(parsed, 'root');
  const groups = asRecord(root.groups, 'groups');
  const groupConfig = groups[groupFolder];
  if (groupConfig == null) {
    return { allowedTools: [], bridges: {} };
  }

  const group = asRecord(groupConfig, `groups.${groupFolder}`);
  const allowedToolsRaw = group.allowedTools;
  if (!Array.isArray(allowedToolsRaw) || !allowedToolsRaw.every((entry) => typeof entry === 'string')) {
    throw new Error(`Agent MCP config groups.${groupFolder}.allowedTools must be a string array`);
  }

  const bridgesRaw = asRecord(group.bridges, `groups.${groupFolder}.bridges`);
  const bridges: Record<string, AgentMcpBridgeConfig> = {};
  for (const [serverName, rawBridge] of Object.entries(bridgesRaw)) {
    validateServerName(serverName);
    const bridge = asRecord(rawBridge, `groups.${groupFolder}.bridges.${serverName}`);
    if (bridge.type !== 'mcp-remote-unix-socket') {
      throw new Error(`Agent MCP bridge ${serverName} type must be mcp-remote-unix-socket`);
    }
    bridges[serverName] = {
      type: 'mcp-remote-unix-socket',
      remoteUrl: validateRemoteUrl(serverName, bridge.remoteUrl),
      callbackPort: validateCallbackPort(serverName, bridge.callbackPort),
      socketNamePrefix: validateSocketNamePrefix(serverName, bridge.socketNamePrefix),
    };
  }

  const allowedTools = allowedToolsRaw as string[];
  const expectedTools = new Set(Object.keys(bridges).map((serverName) => `mcp__${serverName}__*`));
  const actualTools = new Set(allowedTools);
  if (expectedTools.size !== actualTools.size || [...expectedTools].some((tool) => !actualTools.has(tool))) {
    throw new Error(`Agent MCP config groups.${groupFolder}.allowedTools must match configured bridge servers`);
  }

  return { allowedTools, bridges };
}
