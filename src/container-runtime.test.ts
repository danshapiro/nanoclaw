import fs from 'fs';
import path from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  hostGatewayArgs,
  stopContainer,
  stopContainerAsync,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('hostGatewayArgs', () => {
  it('maps distinct local proxy hostnames to the Docker host gateway', () => {
    expect(
      hostGatewayArgs(['yente-msgvault-proxy.local', 'yente-gws-proxy.local', 'yente-browser-handoff.local']),
    ).toEqual(
      expect.arrayContaining([
        '--add-host=host.docker.internal:host-gateway',
        '--add-host=yente-msgvault-proxy.local:host-gateway',
        '--add-host=yente-gws-proxy.local:host-gateway',
        '--add-host=yente-browser-handoff.local:host-gateway',
      ]),
    );
  });

  it('rejects unsafe additional hostnames', () => {
    expect(() => hostGatewayArgs(['bad host'])).toThrow('Invalid host gateway alias');
    expect(() => hostGatewayArgs(['bad:host'])).toThrow('Invalid host gateway alias');
  });
});

describe('agent container Dockerfile', () => {
  it('includes the Python runtime needed by managed Python project repos', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('python3');
    expect(dockerfile).toContain('python3-jsonschema');
  });

  it('installs a verified yt-dlp nightly with the Node JavaScript runtime enabled', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    const version = dockerfile.match(/^ARG YT_DLP_VERSION=(\S+)$/m)?.[1];
    const checksum = dockerfile.match(/^ARG YT_DLP_SHA256=(\S+)$/m)?.[1];

    expect(version).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{6}$/);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(dockerfile).toContain(
      'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/${YT_DLP_VERSION}/yt-dlp',
    );
    expect(dockerfile).toContain('sha256sum --check --strict');
    expect(dockerfile).toContain("printf '%s\\n' '--js-runtimes node' > /etc/yt-dlp.conf");
    expect(dockerfile).toContain('test "$(yt-dlp --version)" = "$YT_DLP_VERSION"');
    expect(dockerfile).toMatch(/^\s*ffmpeg\s*(\\)?$/m);
  });

  it('includes approved baseline Unix tools for agent workspace handling', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    for (const pkg of ['ripgrep', 'file', 'less', 'tree', 'zip']) {
      expect(dockerfile).toMatch(new RegExp(`^\\s*${pkg}\\s*(\\\\)?$`, 'm'));
    }
  });

  it('installs the GWS proxy shim instead of the real Google Workspace CLI', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('COPY shim/gws /usr/local/bin/gws');
    expect(dockerfile).toContain('COPY shim/curl /usr/local/bin/curl');
    expect(dockerfile).toContain('chmod +x /usr/local/bin/gws /usr/local/bin/curl');
    expect(dockerfile).not.toContain('GWS_CLI_VERSION');
    expect(dockerfile).not.toContain('@googleworkspace/cli');
  });

  it('allows postinstall scripts for globally installed CLIs that need runtime binaries', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    for (const pkg of ['agent-browser', 'esbuild', '@anthropic-ai/claude-code', 'opencode-ai']) {
      expect(dockerfile).toContain(`only-built-dependencies[]=${pkg}`);
    }
  });

  it('keeps skill-local helpers on PATH for login shells', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('ENV PATH="/app/skills/.bin:${PNPM_HOME}/bin:${PNPM_HOME}:$PATH"');
    expect(dockerfile).toContain('/etc/profile.d/pnpm-home.sh');
    expect(dockerfile).toContain('*) export PATH="/app/skills/.bin:$PATH" ;;');
  });

  it('runs and verifies the OpenCode postinstall artifact after the pnpm global install', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('find "$PNPM_HOME/global" -path \'*/node_modules/opencode-ai\'');
    expect(dockerfile).toContain('node postinstall.mjs');
    expect(dockerfile).toContain('opencode --version');
  });

  it('does not create a GWS OAuth config path in the agent image', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).not.toContain('/home/node/.config/gws');
  });

  it('lets docker run command arguments bypass the app runtime entrypoint', () => {
    const entrypoint = fs.readFileSync(path.join(process.cwd(), 'container', 'entrypoint.sh'), 'utf8');

    expect(entrypoint).toMatch(/if \[\[ "\$#" -gt 0 \]\]; then\n\s+exec "\$@"/);
    expect(entrypoint.indexOf('exec "$@"')).toBeLessThan(entrypoint.indexOf('cat > /tmp/input.json'));
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- stopContainerAsync ---

describe('stopContainerAsync', () => {
  it('defaults to a 1s grace period and 11s exec timeout', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => (cb as (err: null) => void)(null));

    await stopContainerAsync('nanoclaw-test-123');

    expect(mockExecFile).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-123'],
      { timeout: 11000 },
      expect.any(Function),
    );
  });

  it('passes -t 30 and widens the exec timeout when graceSeconds=30', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => (cb as (err: null) => void)(null));

    await stopContainerAsync('nanoclaw-test-123', 30);

    expect(mockExecFile).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '30', 'nanoclaw-test-123'],
      { timeout: 40000 },
      expect.any(Function),
    );
  });

  it('rejects invalid container names without invoking docker', async () => {
    await expect(stopContainerAsync('foo; rm -rf /', 30)).rejects.toThrow('Invalid container name');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects when docker stop fails', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) =>
      (cb as (err: Error) => void)(new Error('no such container')),
    );

    await expect(stopContainerAsync('nanoclaw-test-123', 30)).rejects.toThrow('no such container');
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});
