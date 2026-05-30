/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/**
 * Relay-mode admission policy. When the MCP server is launched in the relay's
 * own subprocess (env `NANOCLAW_RELAY_MODE=1`), it exposes ONLY a route-locked
 * `send_message` plus explicitly listed read-only status tools. Every mutation/
 * side-effect tool is denied, and an off-route `to` is rejected. The route lock
 * is row-level ownership + route filter, NOT a cross-process write queue (see
 * the Inactivity Visibility Contract).
 */
export interface RelayPolicy {
  routeKey: string;
  /** Write tools the relay may expose (only `send_message`). */
  allowedTools: string[];
  /** Read-only status tool names explicitly allowlisted for relay. */
  allowedStatusTools: string[];
  /**
   * True if a `to` destination stays on the locked route. Default: only an
   * omitted `to` (reply-in-place to the active conversation) is on-route. The
   * relay is launched per-route, so cross-destination sends are always rejected.
   */
  isOnRoute?: (to?: string) => boolean;
}

/** Parse the relay policy from process env. Returns null in non-relay mode. */
export function buildRelayPolicyFromEnv(env: Record<string, string | undefined>): RelayPolicy | null {
  const mode = env.NANOCLAW_RELAY_MODE;
  if (mode !== '1' && mode !== 'true') return null;
  const routeKey = env.NANOCLAW_RELAY_ROUTE_KEY ?? '';
  const statusTools = (env.NANOCLAW_RELAY_STATUS_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    routeKey,
    allowedTools: ['send_message'],
    allowedStatusTools: statusTools,
  };
}

/**
 * Filter the registered tool set for relay mode. A null policy = non-relay =
 * the full tool map. Relay mode returns ONLY the write allowlist (send_message)
 * + the explicitly listed read-only status tools; every other tool is denied.
 */
export function filterToolsForRelay(tools: McpToolDefinition[], policy: RelayPolicy | null): McpToolDefinition[] {
  if (!policy) return tools;
  const allowed = new Set([...policy.allowedTools, ...policy.allowedStatusTools]);
  return tools.filter((t) => allowed.has(t.tool.name));
}

export interface RouteLockResult {
  rejected: boolean;
  reason?: string;
}

/**
 * Enforce the relay route lock on `send_message` args. An off-route `to` is
 * rejected (the relay can never leave its launched route); an omitted or
 * on-route `to` is allowed (reply-in-place to the locked conversation).
 */
export function routeLockSendMessageArgs(args: Record<string, unknown>, policy: RelayPolicy): RouteLockResult {
  const to = args.to === undefined ? undefined : String(args.to);
  const onRoute = policy.isOnRoute ?? ((dest?: string) => dest === undefined);
  if (onRoute(to)) return { rejected: false };
  return {
    rejected: true,
    reason: `relay send_message is route-locked to ${policy.routeKey || '(current conversation)'}; off-route "to" rejected`,
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  const relayPolicy = buildRelayPolicyFromEnv(process.env);
  const exposedTools = filterToolsForRelay(allTools, relayPolicy);
  const exposedMap = new Map(exposedTools.map((t) => [t.tool.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = exposedMap.get(name);
    if (!tool) {
      // In relay mode a denied tool name is not reachable at all.
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    if (relayPolicy && name === 'send_message') {
      const lock = routeLockSendMessageArgs(args ?? {}, relayPolicy);
      if (lock.rejected) {
        return { content: [{ type: 'text', text: `Error: ${lock.reason}` }], isError: true };
      }
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (relayPolicy) {
    log(
      `MCP server started in RELAY mode (route ${relayPolicy.routeKey}) with ${exposedTools.length} tools: ${exposedTools
        .map((t) => t.tool.name)
        .join(', ')}`,
    );
  } else {
    log(`MCP server started with ${exposedTools.length} tools: ${exposedTools.map((t) => t.tool.name).join(', ')}`);
  }
}
