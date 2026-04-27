import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentMcpConfigForGroup } from './agent-mcp-config.js';

const oldEnv = { ...process.env };

afterEach(() => {
  process.env.AGENT_MCP_CONFIG_PATH = oldEnv.AGENT_MCP_CONFIG_PATH;
  process.env.NANOCLAW_AGENT_MCP_CONFIG = oldEnv.NANOCLAW_AGENT_MCP_CONFIG;
});

function writeConfig(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-agent-mcp-config-'));
  const file = path.join(root, 'agent-mcp-servers.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  process.env.AGENT_MCP_CONFIG_PATH = file;
  delete process.env.NANOCLAW_AGENT_MCP_CONFIG;
  return root;
}

describe('loadAgentMcpConfigForGroup', () => {
  it('loads a v2 group-scoped Granola bridge config', () => {
    const root = writeConfig({
      groups: {
        main: {
          allowedTools: ['mcp__granola__*'],
          bridges: {
            granola: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://mcp.granola.ai/mcp',
              callbackPort: 37947,
              socketNamePrefix: 'granola',
            },
          },
        },
      },
    });
    try {
      expect(loadAgentMcpConfigForGroup('main')).toEqual({
        allowedTools: ['mcp__granola__*'],
        bridges: {
          granola: {
            type: 'mcp-remote-unix-socket',
            remoteUrl: 'https://mcp.granola.ai/mcp',
            callbackPort: 37947,
            socketNamePrefix: 'granola',
          },
        },
      });
      expect(loadAgentMcpConfigForGroup('other')).toEqual({ allowedTools: [], bridges: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects allowedTools that do not match configured bridge servers', () => {
    const root = writeConfig({
      groups: {
        main: {
          allowedTools: [],
          bridges: {
            granola: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://mcp.granola.ai/mcp',
              callbackPort: 37947,
              socketNamePrefix: 'granola',
            },
          },
        },
      },
    });
    try {
      expect(() => loadAgentMcpConfigForGroup('main')).toThrow(/allowedTools must match/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
