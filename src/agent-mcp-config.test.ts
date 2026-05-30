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
            required: false,
          },
        },
      });
      expect(loadAgentMcpConfigForGroup('other')).toEqual({ allowedTools: [], bridges: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies default user MCP bridges to groups without explicit entries', () => {
    const root = writeConfig({
      defaults: {
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
      groups: {},
    });
    try {
      expect(loadAgentMcpConfigForGroup('discord_yente-dvora')).toEqual({
        allowedTools: ['mcp__granola__*'],
        bridges: {
          granola: {
            type: 'mcp-remote-unix-socket',
            remoteUrl: 'https://mcp.granola.ai/mcp',
            callbackPort: 37947,
            socketNamePrefix: 'granola',
            required: false,
          },
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges group-specific bridges with defaults and validates allowed tools', () => {
    const root = writeConfig({
      defaults: {
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
      groups: {
        main: {
          allowedTools: ['mcp__granola__*', 'mcp__other__*'],
          bridges: {
            other: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://example.com/mcp',
              callbackPort: 37948,
              socketNamePrefix: 'other',
            },
          },
        },
      },
    });
    try {
      expect(Object.keys(loadAgentMcpConfigForGroup('main').bridges).sort()).toEqual(['granola', 'other']);
      expect(loadAgentMcpConfigForGroup('main').allowedTools.sort()).toEqual(['mcp__granola__*', 'mcp__other__*']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults granola bridges to optional and non-granola bridges to required', () => {
    const root = writeConfig({
      groups: {
        main: {
          allowedTools: ['mcp__granola__*', 'mcp__other__*'],
          bridges: {
            granola: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://mcp.granola.ai/mcp',
              callbackPort: 37947,
              socketNamePrefix: 'granola',
            },
            other: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://example.com/mcp',
              callbackPort: 37948,
              socketNamePrefix: 'other',
            },
          },
        },
      },
    });
    try {
      const config = loadAgentMcpConfigForGroup('main');
      expect(config.bridges.granola.required).toBe(false);
      expect(config.bridges.other.required).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves an explicit required/optional setting that overrides the default', () => {
    const root = writeConfig({
      groups: {
        main: {
          allowedTools: ['mcp__granola__*', 'mcp__other__*'],
          bridges: {
            granola: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://mcp.granola.ai/mcp',
              callbackPort: 37947,
              socketNamePrefix: 'granola',
              required: true,
            },
            other: {
              type: 'mcp-remote-unix-socket',
              remoteUrl: 'https://example.com/mcp',
              callbackPort: 37948,
              socketNamePrefix: 'other',
              required: false,
            },
          },
        },
      },
    });
    try {
      const config = loadAgentMcpConfigForGroup('main');
      expect(config.bridges.granola.required).toBe(true);
      expect(config.bridges.other.required).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-boolean required field as malformed config (fail-closed)', () => {
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
              required: 'yes',
            },
          },
        },
      },
    });
    try {
      expect(() => loadAgentMcpConfigForGroup('main')).toThrow(/required must be a boolean/);
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
