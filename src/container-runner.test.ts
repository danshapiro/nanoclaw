import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const { spawnMock, applyContainerConfigMock, syncAgentSkillsMock } = vi.hoisted(
  () => ({
    spawnMock: vi.fn(),
    applyContainerConfigMock: vi.fn().mockResolvedValue(true),
    syncAgentSkillsMock: vi.fn(),
  }),
);

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_API_KEY: '',
  MANAGED_GWS_SKILLS_DIR: '/tmp/managed-gws-skills',
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = applyContainerConfigMock;
  },
}));

vi.mock('./skill-sync.js', () => ({
  syncAgentSkills: syncAgentSkillsMock,
}));
// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock,
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockImplementation(() => fakeProc);
    spawnMock.mockClear();
    applyContainerConfigMock.mockClear();
    applyContainerConfigMock.mockResolvedValue(true);
    syncAgentSkillsMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('applies OneCLI config and does not inject Anthropic secrets into stdin', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-onecli',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnCall = spawnMock.mock.calls[0];
    expect(spawnCall).toBeTruthy();
    const containerArgs = (spawnCall?.[1] ?? []) as unknown as string[];
    expect(containerArgs).not.toContain('ANTHROPIC_API_KEY=placeholder');
    expect(
      containerArgs.some((arg) => arg.startsWith('ANTHROPIC_BASE_URL=')),
    ).toBe(false);
    expect(applyContainerConfigMock).toHaveBeenCalledWith(expect.any(Array), {
      addHostMapping: false,
      agent: 'test-group',
    });

    const stdinPayload = JSON.parse(fakeProc.stdin.read()!.toString());
    expect(stdinPayload.secrets).toBeUndefined();
    expect(stdinPayload.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(stdinPayload.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('uses the default OneCLI agent for main-group containers', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, isMain: true },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-main',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(applyContainerConfigMock).toHaveBeenCalledWith(expect.any(Array), {
      addHostMapping: false,
      agent: undefined,
    });
  });

  it('rewrites NODE_EXTRA_CA_CERTS to the combined OneCLI bundle when available', async () => {
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem');
      args.push('-e', 'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem');
      return true;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-ca',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnCall = spawnMock.mock.calls[0];
    expect(spawnCall).toBeTruthy();
    const containerArgs = (spawnCall?.[1] ?? []) as unknown as string[];
    expect(containerArgs).toContain(
      'NODE_EXTRA_CA_CERTS=/tmp/onecli-combined-ca.pem',
    );
    expect(containerArgs).not.toContain(
      'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem',
    );
  });
});

describe('container-runner GWS proxy env vars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockImplementation(() => fakeProc);
    spawnMock.mockClear();
    applyContainerConfigMock.mockClear();
    applyContainerConfigMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GWS_PROXY_URL;
    delete process.env.GWS_PROXY_KEY;
  });

  it('injects GWS_PROXY_URL and GWS_PROXY_KEY when set', async () => {
    process.env.GWS_PROXY_URL = 'http://host.docker.internal:8083';
    process.env.GWS_PROXY_KEY = 'test_key';

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];

    expect(spawnArgs).toContain(
      'GWS_PROXY_URL=http://host.docker.internal:8083',
    );
    expect(spawnArgs).toContain('GWS_PROXY_KEY=test_key');
  });

  it('loads managed GWS skills from the configured shared dir', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    expect(syncAgentSkillsMock).toHaveBeenCalledWith({
      bundledSkillsDir: expect.stringContaining('/container/skills'),
      managedGwsSkillsDir: '/tmp/managed-gws-skills',
      destinationDir:
        '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills',
    });
  });

  it('does NOT inject old gws env vars or mounts', async () => {
    process.env.GWS_PROXY_URL = 'http://host.docker.internal:8083';
    process.env.GWS_PROXY_KEY = 'test_key';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];

    // No old gws env vars
    const oldGwsArgs = spawnArgs.filter(
      (arg) =>
        typeof arg === 'string' &&
        (arg.includes('GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND') ||
          arg.includes('GOOGLE_WORKSPACE_CLI_CONFIG_DIR')),
    );
    expect(oldGwsArgs).toHaveLength(0);

    // No gws-config volume mount
    const gwsMountArg = spawnArgs.find(
      (arg) =>
        typeof arg === 'string' &&
        arg.includes('gws-config:') &&
        arg.includes('/home/node/.config/gws'),
    );
    expect(gwsMountArg).toBeUndefined();
  });
});

describe('container-runner proxy env handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockImplementation(() => fakeProc);
    spawnMock.mockClear();
    applyContainerConfigMock.mockClear();
    applyContainerConfigMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds local service exemptions to NO_PROXY when OneCLI proxy env is present', async () => {
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'HTTP_PROXY=http://host.docker.internal:10255');
      args.push('-e', 'HTTPS_PROXY=http://host.docker.internal:10255');
      return true;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain(
      'NO_PROXY=host.docker.internal,localhost,127.0.0.1,::1,172.17.0.1',
    );
    expect(spawnArgs).toContain(
      'no_proxy=host.docker.internal,localhost,127.0.0.1,::1,172.17.0.1',
    );
  });

  it('merges existing NO_PROXY entries with local service exemptions', async () => {
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'HTTP_PROXY=http://host.docker.internal:10255');
      args.push('-e', 'NO_PROXY=example.com,localhost');
      args.push('-e', 'no_proxy=internal.example');
      return true;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain(
      'NO_PROXY=example.com,localhost,internal.example,host.docker.internal,127.0.0.1,::1,172.17.0.1',
    );
    expect(spawnArgs).toContain(
      'no_proxy=example.com,localhost,internal.example,host.docker.internal,127.0.0.1,::1,172.17.0.1',
    );
  });
});

describe('container-runner settings defaults', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockImplementation(() => fakeProc);
    spawnMock.mockClear();
    applyContainerConfigMock.mockClear();
    applyContainerConfigMock.mockResolvedValue(true);
    syncAgentSkillsMock.mockClear();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
    vi.mocked(fs.writeFileSync).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates missing settings.json with the Opus default and env defaults', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const settingsWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(
        (args) =>
          typeof args[0] === 'string' && args[0].endsWith('settings.json'),
      );
    expect(settingsWrite).toBeTruthy();

    const written = JSON.parse(String(settingsWrite?.[1]));
    expect(written.model).toBe('opus');
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(written.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(written.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });

  it('merges the Opus default into existing settings.json without overwriting env values', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.endsWith('settings.json'),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('settings.json')) {
        return JSON.stringify({
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
            FAMILIAR_API_URL: 'http://host.docker.internal:8081',
          },
        });
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const settingsWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(
        (args) =>
          typeof args[0] === 'string' && args[0].endsWith('settings.json'),
      );
    expect(settingsWrite).toBeTruthy();

    const written = JSON.parse(String(settingsWrite?.[1]));
    expect(written.model).toBe('opus');
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('0');
    expect(written.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(written.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
    expect(written.env.FAMILIAR_API_URL).toBe('http://host.docker.internal:8081');
  });

  it('recovers from malformed settings.json and rewrites the defaults', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.endsWith('settings.json'),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('settings.json')) {
        return '{not json';
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const settingsWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(
        (args) =>
          typeof args[0] === 'string' && args[0].endsWith('settings.json'),
      );
    expect(settingsWrite).toBeTruthy();

    const written = JSON.parse(String(settingsWrite?.[1]));
    expect(written.model).toBe('opus');
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(written.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(written.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });
});
