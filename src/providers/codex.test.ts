import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { codexHostContainerFactory } from './codex.js';

const tempRoots: string[] = [];

async function startFakeBroker(store: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yente-codex-broker-'));
  tempRoots.push(dir);
  const sock = path.join(dir, 'broker.sock');
  const requests: unknown[] = [];
  const serverCode = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    'const [sock, requestLog] = process.argv.slice(1);',
    'const store = JSON.parse(process.env.FAKE_CODEX_STORE);',
    'try { fs.unlinkSync(sock); } catch {}',
    'const server = net.createServer((socket) => {',
    "  socket.on('data', (data) => {",
    '    const req = JSON.parse(data.toString("utf8").trim());',
    '    fs.appendFileSync(requestLog, JSON.stringify(req) + "\\n");',
    '    socket.write(JSON.stringify({ ok: true, store }) + "\\n");',
    '  });',
    '});',
    "server.listen(sock, () => process.stdout.write('READY\\n'));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n');
  const requestLog = path.join(dir, 'requests.jsonl');
  const child = spawn(process.execPath, ['-e', serverCode, sock, requestLog], {
    env: { ...process.env, FAKE_CODEX_STORE: JSON.stringify(store) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake broker did not start')), 5000);
    child.stdout.on('data', (data) => {
      if (data.toString('utf8').includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake broker exited before ready: ${code}`));
    });
  });
  return {
    sock,
    get requests() {
      requests.splice(0, requests.length);
      if (fs.existsSync(requestLog)) {
        for (const line of fs.readFileSync(requestLog, 'utf8').split('\n')) {
          if (line.trim()) requests.push(JSON.parse(line));
        }
      }
      return requests;
    },
    close: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}

function writeNativeConfig(root: string, agentGroupId = 'ag-main') {
  const tokenFile = path.join(root, 'codex-onecli-agent-token');
  const token = 'aoc_test_agent_token';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  fs.writeFileSync(tokenFile, token);
  const configPath = path.join(root, 'onecli-codex-container-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agentGroupId,
      onecliAgentIdentifier: 'codex-yente-main',
      onecliAgentId: 'agent-main',
      onecliAgentTokenFile: tokenFile,
      onecliAgentAccessTokenSha256: tokenHash,
      onecliAuthGateHost: 'yente-onecli-auth-gate.local',
      onecliAuthGatePort: 18055,
      env: {
        ANTHROPIC_API_KEY: 'placeholder',
        CODEX_CA_CERTIFICATE: '/tmp/onecli-gateway-ca.pem',
        SSL_CERT_FILE: '/tmp/onecli-gateway-ca.pem',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
      },
      proxyEnv: {
        HTTPS_PROXY: 'http://codex-yente-main@yente-onecli-auth-gate.local:18055',
        HTTP_PROXY: 'http://codex-yente-main@yente-onecli-auth-gate.local:18055',
      },
      mounts: [],
    }),
  );
  return { configPath, tokenFile };
}

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('codex host provider container config', () => {
  it('writes brokered access-token-only auth and native OneCLI egress config', async () => {
    const root = tempDir('yente-codex-provider-');
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const { configPath } = writeNativeConfig(root);
    const broker = await startFakeBroker({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access-token',
        id_token: 'identity-token',
        refresh_token: '',
        account_id: 'acct_1',
      },
      last_refresh: 123,
    });
    try {
      const contribution = codexHostContainerFactory({
        sessionDir,
        agentGroupId: 'ag-main',
        agentGroupFolder: 'main',
        hostEnv: {
          OPENAI_API_KEY: 'sk-should-not-cross',
          CODEX_MODEL: 'ignored-by-container-config',
          CODEX_REASONING_EFFORT: 'low',
          OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/',
          NO_PROXY: 'internal.example',
        },
        groupModel: 'gpt-5.4',
        groupReasoningEffort: 'medium',
        containerConfig: {
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: 'all',
          model: 'gpt-5.5',
          reasoningEffort: 'xhigh',
          codex: {
            onecliConfigPath: configPath,
            brokerSocket: broker.sock,
            brokerTarget: 'ag-main',
            authGateHost: 'yente-onecli-auth-gate.local',
            authGatePort: 18055,
          },
        },
      });

      expect(broker.requests).toEqual([{ op: 'get-codex-credential', target: 'ag-main' }]);
      const authPath = path.join(sessionDir, 'codex', 'auth.json');
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      expect(auth).toEqual({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'access-token',
          id_token: 'identity-token',
          refresh_token: '',
          account_id: 'acct_1',
        },
        last_refresh: 123,
      });
      expect(contribution.mounts).toContainEqual({
        hostPath: path.join(sessionDir, 'codex'),
        containerPath: '/home/node/.codex',
        readonly: false,
      });
      expect(contribution.mounts?.some((mount) => mount.containerPath === '/tmp/onecli-gateway-ca.pem')).toBe(false);
      expect(contribution.env?.OPENAI_API_KEY).toBeUndefined();
      expect(contribution.env?.CODEX_MODEL).toBe('gpt-5.5');
      expect(contribution.env?.CODEX_REASONING_EFFORT).toBe('xhigh');
      expect(contribution.env?.OPENAI_BASE_URL).toBe('https://chatgpt.com/backend-api/');
      expect(contribution.env?.YENTE_CODEX_ONECLI_NATIVE).toBe('1');
      expect(contribution.env?.HTTPS_PROXY).toContain('aoc_test_agent_token');
      expect(contribution.env?.NO_PROXY?.split(',')).toEqual(
        expect.arrayContaining(['127.0.0.1', 'localhost', 'registry.npmjs.org', 'internal.example']),
      );
      expect(contribution.env?.no_proxy?.split(',')).toEqual(
        expect.arrayContaining(['127.0.0.1', 'localhost', 'registry.npmjs.org']),
      );
      expect(contribution.env?.NO_PROXY?.split(',')).not.toEqual(
        expect.arrayContaining([
          'yente-gws-proxy.local',
          'yente-msgvault-proxy.local',
          'yente-familiar-proxy.local',
          'yente-nyne-proxy.local',
          'yente-browser-handoff.local',
        ]),
      );
      expect(contribution.extraHosts).toContain('yente-onecli-auth-gate.local');
    } finally {
      await broker.close();
    }
  });

  it('throws before writing auth.json when native OneCLI config is missing', async () => {
    const root = tempDir('yente-codex-missing-config-');
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    await expect(async () =>
      codexHostContainerFactory({
        sessionDir,
        agentGroupId: 'ag-main',
        agentGroupFolder: 'main',
        hostEnv: {},
        containerConfig: {
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: 'all',
          codex: { onecliConfigPath: path.join(root, 'missing.json') },
        },
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(sessionDir, 'codex', 'auth.json'))).toBe(false);
  });

  it('throws before writing auth.json when broker returns a refresh token', async () => {
    const root = tempDir('yente-codex-refresh-token-');
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const { configPath } = writeNativeConfig(root);
    const broker = await startFakeBroker({
      tokens: {
        access_token: 'access-token',
        id_token: 'identity-token',
        refresh_token: 'refresh-token-must-not-cross',
      },
    });
    try {
      expect(() =>
        codexHostContainerFactory({
          sessionDir,
          agentGroupId: 'ag-main',
          agentGroupFolder: 'main',
          hostEnv: {},
          containerConfig: {
            mcpServers: {},
            packages: { apt: [], npm: [] },
            additionalMounts: [],
            skills: 'all',
            codex: { onecliConfigPath: configPath, brokerSocket: broker.sock },
          },
        }),
      ).toThrow(/forbidden secret/);
      expect(fs.existsSync(path.join(sessionDir, 'codex', 'auth.json'))).toBe(false);
    } finally {
      await broker.close();
    }
  });
});
