import { describe, it, expect } from 'bun:test';

import {
  mcpServersToOpenCodeConfig,
  buildRelayOpenCodeToolConfig,
  reachableRelayTools,
} from './mcp-to-opencode.js';

describe('mcpServersToOpenCodeConfig', () => {
  it('maps nanoclaw + extra server like v2 index.ts merge', () => {
    const servers = {
      nanoclaw: {
        command: 'node',
        args: ['/app/src/mcp-tools/index.js'],
        env: {
          SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
          SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
          SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
        },
      },
      extra: {
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { FOO: 'bar' },
      },
    };

    const mcp = mcpServersToOpenCodeConfig(servers);

    expect(mcp.nanoclaw).toEqual({
      type: 'local',
      command: ['node', '/app/src/mcp-tools/index.js'],
      environment: {
        SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
      },
      enabled: true,
    });

    expect(mcp.extra).toEqual({
      type: 'local',
      command: ['npx', '-y', 'some-mcp'],
      environment: { FOO: 'bar' },
      enabled: true,
    });
  });

  it('omits environment when env is empty', () => {
    const mcp = mcpServersToOpenCodeConfig({
      x: { command: 'true', args: [], env: {} },
    });
    expect(mcp.x).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
    });
  });

  it('returns empty record for undefined', () => {
    expect(mcpServersToOpenCodeConfig(undefined)).toEqual({});
  });
});

describe('relay-mode OpenCode tool config (boundary)', () => {
  it('disables native mutation/shell/file/web/question tools via REAL SDK ids and keeps read-only status tools', () => {
    const { tools, permission } = buildRelayOpenCodeToolConfig();
    // REAL SDK permission keys denied (not invented category names).
    expect(permission.bash).toBe('deny');
    expect(permission.webfetch).toBe('deny');
    expect(permission.edit).toBe('deny');
    expect(permission.external_directory).toBe('deny');
    // Each real mutation/shell/file/web tool id + the native question id is false.
    for (const id of ['bash', 'edit', 'write', 'apply_patch', 'webfetch', 'websearch', 'task', 'question']) {
      expect(tools[id]).toBe(false);
    }
    // Read-only status tools remain enabled (not set to false).
    for (const id of ['read', 'glob', 'grep']) {
      expect(tools[id]).not.toBe(false);
    }
  });

  it('relay reachable tool set EQUALS the allowlist (positive assertion), not merely "deny keys exist"', () => {
    const relayConfig = buildRelayOpenCodeToolConfig();
    const reachable = reachableRelayTools(relayConfig, {
      mcpTools: ['send_message'],
      readOnlyStatusTools: ['read', 'glob', 'grep', 'todowrite', 'skill'],
    }).sort();
    // The only WRITE surface is route-locked send_message; everything else is
    // a read-only status tool. bash / any file tool / webfetch must NOT appear.
    expect(reachable).toEqual(['glob', 'grep', 'read', 'send_message', 'skill', 'todowrite'].sort());
    expect(reachable).not.toContain('bash');
    expect(reachable).not.toContain('write');
    expect(reachable).not.toContain('edit');
    expect(reachable).not.toContain('webfetch');
    expect(reachable).not.toContain('question');
  });
});
