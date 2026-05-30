import { describe, it, expect } from 'bun:test';

import {
  buildRelayPolicyFromEnv,
  filterToolsForRelay,
  routeLockSendMessageArgs,
  type RelayPolicy,
} from './server.js';
import type { McpToolDefinition } from './types.js';

function fakeTool(name: string): McpToolDefinition {
  return {
    tool: { name, description: name, inputSchema: { type: 'object' as const, properties: {} } },
    async handler() {
      return { content: [{ type: 'text' as const, text: `${name} ran` }] };
    },
  };
}

const FULL_TOOLSET: McpToolDefinition[] = [
  fakeTool('send_message'),
  fakeTool('send_file'),
  fakeTool('edit_message'),
  fakeTool('add_reaction'),
  fakeTool('create_agent'),
  fakeTool('schedule_task'),
  fakeTool('cancel_task'),
  fakeTool('install_packages'),
  fakeTool('add_mcp_server'),
  fakeTool('list_tasks'),
];

describe('relay-mode MCP server admission', () => {
  it('builds no relay policy when NANOCLAW_RELAY_MODE is unset', () => {
    expect(buildRelayPolicyFromEnv({})).toBeNull();
    expect(buildRelayPolicyFromEnv({ NANOCLAW_RELAY_MODE: '0' })).toBeNull();
  });

  it('builds a route-locked status-only relay policy from env', () => {
    const policy = buildRelayPolicyFromEnv({
      NANOCLAW_RELAY_MODE: '1',
      NANOCLAW_RELAY_ROUTE_KEY: 'discord:dm:123',
      NANOCLAW_RELAY_STATUS_TOOLS: 'list_tasks',
    });
    expect(policy).not.toBeNull();
    expect(policy!.routeKey).toBe('discord:dm:123');
    expect(policy!.allowedTools).toContain('send_message');
    expect(policy!.allowedStatusTools).toEqual(['list_tasks']);
  });

  it('relay server exposes ONLY route-locked send_message plus listed read-only status tools', () => {
    const policy: RelayPolicy = {
      routeKey: 'discord:dm:123',
      allowedTools: ['send_message'],
      allowedStatusTools: ['list_tasks'],
    };
    const filtered = filterToolsForRelay(FULL_TOOLSET, policy);
    const names = filtered.map((t) => t.tool.name).sort();
    // POSITIVE assertion: the reachable set EQUALS the allowlist, not merely
    // "some deny keys exist".
    expect(names).toEqual(['list_tasks', 'send_message']);
  });

  it('relay server rejects every mutation/side-effect tool', () => {
    const policy: RelayPolicy = {
      routeKey: 'discord:dm:123',
      allowedTools: ['send_message'],
      allowedStatusTools: ['list_tasks'],
    };
    const filtered = filterToolsForRelay(FULL_TOOLSET, policy);
    const names = new Set(filtered.map((t) => t.tool.name));
    for (const denied of [
      'send_file',
      'edit_message',
      'add_reaction',
      'create_agent',
      'schedule_task',
      'cancel_task',
      'install_packages',
      'add_mcp_server',
    ]) {
      expect(names.has(denied)).toBe(false);
    }
  });

  it('route-locks send_message: an off-route `to` is rejected, omitted/on-route `to` allowed', () => {
    const policy: RelayPolicy = {
      routeKey: 'discord:dm:123',
      allowedTools: ['send_message'],
      allowedStatusTools: [],
      isOnRoute: (to?: string) => to === undefined || to === 'current',
    };
    // Off-route `to` rejected.
    expect(routeLockSendMessageArgs({ to: 'family', text: 'hi' }, policy)).toMatchObject({
      rejected: true,
    });
    // Omitted `to` (reply-in-place to the locked route) allowed.
    expect(routeLockSendMessageArgs({ text: 'hi' }, policy)).toMatchObject({ rejected: false });
    // On-route `to` allowed.
    expect(routeLockSendMessageArgs({ to: 'current', text: 'hi' }, policy)).toMatchObject({
      rejected: false,
    });
  });

  it('non-relay (null policy) keeps the full tool map', () => {
    const filtered = filterToolsForRelay(FULL_TOOLSET, null);
    expect(filtered.length).toBe(FULL_TOOLSET.length);
    expect(filtered.map((t) => t.tool.name)).toContain('install_packages');
  });
});
