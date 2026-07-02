import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type Record = {
  method?: string;
  url?: string;
};

const shimPath = path.join(process.cwd(), 'container', 'shim', 'curl');
const servers: http.Server[] = [];

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runShim(args: string[], env: NodeJS.ProcessEnv = {}) {
  const cleanProxyEnv: NodeJS.ProcessEnv = {
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    ALL_PROXY: undefined,
    all_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
  };
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('sh', [shimPath, ...args], {
      env: {
        ...process.env,
        ...cleanProxyEnv,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('curl local service proxy shim', () => {
  it('routes Yente local service URLs through the saved generic OneCLI gateway', async () => {
    const records: Record[] = [];
    const proxy = await withServer((req, res) => {
      records.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    const result = await runShim(['-fsS', 'http://yente-msgvault-proxy.local:8084/health'], {
      YENTE_ONECLI_GATEWAY_PROXY_URL: proxy.url,
      HTTP_PROXY: 'http://codex-auth-gate.local:18055',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(records).toEqual([
      {
        method: 'GET',
        url: 'http://yente-msgvault-proxy.local:8084/health',
      },
    ]);
  });

  it('does not route non-local-service requests through the saved gateway', async () => {
    const proxyRecords: Record[] = [];
    const targetRecords: Record[] = [];
    const proxy = await withServer((req, res) => {
      proxyRecords.push({ method: req.method, url: req.url });
      res.writeHead(502);
      res.end('unexpected proxy');
    });
    const target = await withServer((req, res) => {
      targetRecords.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('direct');
    });

    const result = await runShim(['-fsS', `${target.url}/health`], {
      YENTE_ONECLI_GATEWAY_PROXY_URL: proxy.url,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('direct');
    expect(proxyRecords).toEqual([]);
    expect(targetRecords).toEqual([{ method: 'GET', url: '/health' }]);
  });

  it('respects explicit curl proxy flags', async () => {
    const savedGatewayRecords: Record[] = [];
    const explicitProxyRecords: Record[] = [];
    const savedGateway = await withServer((req, res) => {
      savedGatewayRecords.push({ method: req.method, url: req.url });
      res.writeHead(502);
      res.end('unexpected saved gateway');
    });
    const explicitProxy = await withServer((req, res) => {
      explicitProxyRecords.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('explicit');
    });

    const result = await runShim(['-fsS', '--proxy', explicitProxy.url, 'http://yente-nyne-proxy.local:8085/health'], {
      YENTE_ONECLI_GATEWAY_PROXY_URL: savedGateway.url,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('explicit');
    expect(savedGatewayRecords).toEqual([]);
    expect(explicitProxyRecords).toEqual([
      {
        method: 'GET',
        url: 'http://yente-nyne-proxy.local:8085/health',
      },
    ]);
  });
});
