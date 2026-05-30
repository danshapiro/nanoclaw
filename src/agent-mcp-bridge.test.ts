import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  AgentMcpCredentialUnavailableError,
  classifyBridgeCredentialFailure,
  startAgentMcpBridge,
} from './agent-mcp-bridge.js';

function makeReleaseRoot(proxySource = 'process.stdin.resume();'): string {
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-release-'));
  const proxyDir = path.join(releaseRoot, 'node_modules', 'mcp-remote', 'dist');
  fs.mkdirSync(proxyDir, { recursive: true });
  fs.writeFileSync(path.join(proxyDir, 'proxy.js'), proxySource);
  return releaseRoot;
}

function makeReadyProxyReleaseRoot(): string {
  return makeReleaseRoot(`
process.stdout.write('ready');
process.stdin.resume();
`);
}

// A proxy that emits a known credential prompt on stderr and then hangs
// forever without ever writing the readiness byte to stdout — the real
// "auth stall at startup" shape.
function makeAuthStallProxyReleaseRoot(stderrPrompt: string): string {
  return makeReleaseRoot(`
process.stderr.write(${JSON.stringify(stderrPrompt)});
process.stdin.resume();
`);
}

// A proxy that hangs at startup but emits NO recognizable credential prompt —
// an unclassified stall that must remain fail-closed.
function makeUnclassifiedStallProxyReleaseRoot(): string {
  return makeReleaseRoot(`
process.stderr.write('some unrelated internal error');
process.stdin.resume();
`);
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
  required: false,
};

describe('startAgentMcpBridge', () => {
  it('requires a completed Granola auth marker before opening the socket', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReleaseRoot();
    try {
      // A missing marker now surfaces as the typed, sanitized auth_required
      // credential error so an optional bridge can degrade upstream.
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
      ).rejects.toThrow(AgentMcpCredentialUnavailableError);
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

  it('uses the canonical data path for host Unix socket paths', async () => {
    const realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-'));
    const symlinkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-symlink-parent-'));
    const releaseRoot = makeReleaseRoot();
    const longReleaseRoot = path.join(symlinkParent, `release-${'x'.repeat(72)}`);
    const symlinkedDataDir = path.join(longReleaseRoot, 'data');
    fs.mkdirSync(longReleaseRoot, { recursive: true });
    fs.symlinkSync(realDataDir, symlinkedDataDir);
    const authDir = path.join(realDataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
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
        dataDir: symlinkedDataDir,
        releaseRoot,
      });
      try {
        expect(bridge.hostSocketPath.startsWith(realDataDir)).toBe(true);
        expect(Buffer.byteLength(bridge.hostSocketPath)).toBeLessThanOrEqual(99);
      } finally {
        await bridge.stop();
      }
    } finally {
      fs.rmSync(realDataDir, { recursive: true, force: true });
      fs.rmSync(symlinkParent, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('does not crash when proxy startup fails after the client disconnects', async () => {
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
        startupWatchdogMs: 10,
      });
      try {
        const client = net.createConnection(bridge.hostSocketPath);
        await new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('error', reject);
        });
        client.destroy();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        await bridge.stop();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('reclaims stale legacy lock files before connecting the proxy', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReadyProxyReleaseRoot();
    const authDir = path.join(dataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
    const socketRoot = path.join(dataDir, 'v2-sessions', 'ag-main', 'mcp-runs');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, '.nanoclaw-granola-auth-ok'), '');
    const lockPath = path.join(socketRoot, 'granola.lock');
    fs.writeFileSync(lockPath, '');
    const staleTime = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
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
        const client = net.createConnection(bridge.hostSocketPath);
        const firstChunk = await new Promise<Buffer>((resolve, reject) => {
          client.once('data', resolve);
          client.once('error', reject);
        });
        expect(firstChunk.toString()).toBe('ready');
        client.destroy();
      } finally {
        await bridge.stop();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('releases the group lock after proxy startup so another session can connect', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReadyProxyReleaseRoot();
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
        const firstClient = net.createConnection(bridge.hostSocketPath);
        await new Promise<Buffer>((resolve, reject) => {
          firstClient.once('data', resolve);
          firstClient.once('error', reject);
        });

        const lockPath = path.join(dataDir, 'v2-sessions', 'ag-main', 'mcp-runs', 'granola.lock');
        expect(fs.existsSync(lockPath)).toBe(false);

        const secondClient = net.createConnection(bridge.hostSocketPath);
        const secondChunk = await new Promise<Buffer>((resolve, reject) => {
          secondClient.once('data', resolve);
          secondClient.once('error', reject);
        });
        expect(secondChunk.toString()).toBe('ready');
        firstClient.destroy();
        secondClient.destroy();
      } finally {
        await bridge.stop();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('classifies a missing auth marker as the auth_required credential class', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReleaseRoot();
    try {
      const err = await startAgentMcpBridge({
        groupFolder: 'main',
        agentGroupId: 'ag-main',
        bridge: granolaBridge,
        containerUid: serviceIdentity().uid,
        containerGid: serviceIdentity().gid,
        dataDir,
        releaseRoot,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentMcpCredentialUnavailableError);
      expect((err as AgentMcpCredentialUnavailableError).category).toBe('auth_required');
      // Sanitized: no host paths, uid/gid values, or raw thrown internals.
      const text = (err as AgentMcpCredentialUnavailableError).message;
      expect(text).not.toContain(dataDir);
      expect(text).not.toContain(String(serviceIdentity().uid));
      expect(text).not.toMatch(/\d+:\d+/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('classifies an expired auth marker as the auth_expired credential class', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeReleaseRoot();
    const authDir = path.join(dataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(authDir, '.nanoclaw-granola-auth-ok'),
      JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    try {
      const err = await startAgentMcpBridge({
        groupFolder: 'main',
        agentGroupId: 'ag-main',
        bridge: granolaBridge,
        containerUid: serviceIdentity().uid,
        containerGid: serviceIdentity().gid,
        dataDir,
        releaseRoot,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentMcpCredentialUnavailableError);
      expect((err as AgentMcpCredentialUnavailableError).category).toBe('auth_expired');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('degrades an auth-required startup stall when verifying readiness on startup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeAuthStallProxyReleaseRoot('Please authorize this client by visiting https://example');
    const authDir = path.join(dataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, '.nanoclaw-granola-auth-ok'), '');
    try {
      const err = await startAgentMcpBridge({
        groupFolder: 'main',
        agentGroupId: 'ag-main',
        bridge: granolaBridge,
        containerUid: serviceIdentity().uid,
        containerGid: serviceIdentity().gid,
        dataDir,
        releaseRoot,
        verifyReadyOnStartup: true,
        startupWatchdogMs: 80,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentMcpCredentialUnavailableError);
      expect((err as AgentMcpCredentialUnavailableError).category).toBe('auth_required');
      // Sanitized: the agent-facing message must not leak the raw stderr URL.
      expect((err as AgentMcpCredentialUnavailableError).message).not.toContain('https://example');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('keeps an unclassified startup stall as a fail-closed startup error (not degradation)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-data-'));
    const releaseRoot = makeUnclassifiedStallProxyReleaseRoot();
    const authDir = path.join(dataDir, 'v2-sessions', 'ag-main', '.mcp-auth', 'granola');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, '.nanoclaw-granola-auth-ok'), '');
    try {
      const err = await startAgentMcpBridge({
        groupFolder: 'main',
        agentGroupId: 'ag-main',
        bridge: granolaBridge,
        containerUid: serviceIdentity().uid,
        containerGid: serviceIdentity().gid,
        dataDir,
        releaseRoot,
        verifyReadyOnStartup: true,
        startupWatchdogMs: 80,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AgentMcpCredentialUnavailableError);
      expect((err as Error).message).toMatch(/startup timed out|proxy startup/i);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });
});

describe('classifyBridgeCredentialFailure', () => {
  it('classifies known auth-required prompts', () => {
    expect(classifyBridgeCredentialFailure('Please authorize this client by visiting ...', null)).toBe('auth_required');
    expect(classifyBridgeCredentialFailure('Authentication required', null)).toBe('auth_required');
    // authentication-needed is the REASON_AUTH_NEEDED reconnect reason tag logged by mcp-remote.
    expect(classifyBridgeCredentialFailure('Recursively reconnecting for reason: authentication-needed', null)).toBe(
      'auth_required',
    );
  });

  it('classifies known auth-expired prompts', () => {
    expect(classifyBridgeCredentialFailure('Authentication failed', 1)).toBe('auth_expired');
    expect(classifyBridgeCredentialFailure('token expired, please re-authenticate', 1)).toBe('auth_expired');
  });

  it('does NOT classify the transient long-poll 500 log as auth_expired (fail-closed on transients)', () => {
    // "Auth failed during long poll, responding with 500" is a transient callback-server
    // network/timeout blip, not a token rejection — must stay unclassified (fail-closed).
    expect(classifyBridgeCredentialFailure('Auth failed during long poll, responding with 500', 1)).toBeNull();
  });

  it('returns null for unrelated failures (fail-closed)', () => {
    expect(classifyBridgeCredentialFailure('ECONNREFUSED 127.0.0.1:443', 1)).toBeNull();
    expect(classifyBridgeCredentialFailure('', null)).toBeNull();
    expect(classifyBridgeCredentialFailure('some unrelated internal error', null)).toBeNull();
  });
});
