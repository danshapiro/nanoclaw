import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { startAgentMcpBridge } from './agent-mcp-bridge.js';

function makeReleaseRoot(): string {
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-release-'));
  const proxyDir = path.join(releaseRoot, 'node_modules', 'mcp-remote', 'dist');
  fs.mkdirSync(proxyDir, { recursive: true });
  fs.writeFileSync(path.join(proxyDir, 'proxy.js'), 'process.stdin.resume();');
  return releaseRoot;
}

function serviceIdentity(): { uid: number; gid: number } {
  return {
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
}

const granolaBridge = {
  serverName: 'granola',
  type: 'mcp-remote-unix-socket' as const,
  remoteUrl: 'https://mcp.granola.ai/mcp',
  callbackPort: 37947,
  socketNamePrefix: 'granola',
};

describe('startAgentMcpBridge', () => {
  it('requires a completed Granola auth marker before opening the socket', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReleaseRoot();
    try {
      await expect(
        startAgentMcpBridge({
          groupFolder: 'main',
          agentGroupId: 'ag-main',
          bridge: granolaBridge,
          containerUid: serviceIdentity().uid,
          containerGid: serviceIdentity().gid,
          dataDir,
          releaseRoot,
        }),
      ).rejects.toThrow(/Granola MCP auth required/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('rejects symlinks inside the auth cache before opening the socket', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReleaseRoot();
    const authDir = path.join(dataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, '.nanoclaw-granola-auth-ok'), '');
    fs.symlinkSync(path.join(authDir, '.nanoclaw-granola-auth-ok'), path.join(authDir, 'marker-link'));
    try {
      await expect(
        startAgentMcpBridge({
          groupFolder: 'main',
          agentGroupId: 'ag-main',
          bridge: granolaBridge,
          containerUid: serviceIdentity().uid,
          containerGid: serviceIdentity().gid,
          dataDir,
          releaseRoot,
        }),
      ).rejects.toThrow(/must not contain symlinks/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('creates a per-run v2 socket mount under /workspace/mcp', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReleaseRoot();
    const authDir = path.join(dataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, '.nanoclaw-granola-auth-ok'), '');
    const identity = serviceIdentity();
    try {
      const bridge = await startAgentMcpBridge({
        groupFolder: 'main',
        agentGroupId: 'ag-main',
        bridge: granolaBridge,
        containerUid: identity.uid,
        containerGid: identity.gid,
        dataDir,
        releaseRoot,
      });
      try {
        expect(bridge.containerSocketDir).toBe('/workspace/mcp/granola');
        expect(bridge.containerSocketPath).toBe('/workspace/mcp/granola/granola.sock');
        expect(bridge.hostSocketDir).toContain(path.join(dataDir, 'v2-sessions', 'ag-main', 'mcp-runs'));
        expect(fs.existsSync(bridge.hostSocketPath)).toBe(true);
      } finally {
        await bridge.stop();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });
});
