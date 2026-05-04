import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type RequestRecord = {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body: string;
};

const shimPath = path.join(process.cwd(), 'container', 'shim', 'gws');
const servers: http.Server[] = [];

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

async function withProxy(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test proxy did not bind a TCP port');
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
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...cleanProxyEnv,
        ...env,
        GWS_PROXY_KEY: undefined,
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

describe('gws proxy shim', () => {
  it('prints version/help without requiring proxy credentials', async () => {
    const version = await runShim(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout).toContain('gws-proxy-shim');
    expect(version.stderr).toBe('');

    const help = await runShim(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Google Workspace CLI (proxied)');
    expect(help.stdout).toContain('GWS_PROXY_URL');
    expect(help.stdout).not.toContain('GWS_PROXY_KEY');
  });

  it('fails closed when GWS_PROXY_URL is missing', async () => {
    const result = await runShim(['gmail', '+triage'], { GWS_PROXY_URL: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GWS_PROXY_URL is not set');
    expect(result.stderr).not.toContain('GWS_PROXY_KEY');
  });

  it('reports proxy auth status through the unauthenticated health endpoint', async () => {
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    const result = await runShim(['auth', 'status'], { GWS_PROXY_URL: proxy.url });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      auth_method: 'proxy',
      status: 'connected',
      proxy_url: proxy.url,
    });
    expect(records).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: '/health',
        authorization: undefined,
      }),
    ]);
  });

  it('posts argv to /exec without an Authorization header from the shim', async () => {
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end('{"ok":true}');
    });

    const result = await runShim(['gmail', '+triage', '--max', '5'], { GWS_PROXY_URL: proxy.url });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ok":true}');
    expect(records).toEqual([
      {
        method: 'POST',
        url: '/exec',
        authorization: undefined,
        contentType: 'application/json',
        body: JSON.stringify({ args: ['gmail', '+triage', '--max', '5'] }),
      },
    ]);
  });

  it('honors uppercase HTTP_PROXY for the OneCLI-mediated local proxy route', async () => {
    const records: RequestRecord[] = [];
    const onecliGateway = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Exit-Code': '0' });
      res.end('proxied-ok');
    });

    const result = await runShim(['gmail', '+triage'], {
      GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
      HTTP_PROXY: onecliGateway.url,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('proxied-ok');
    expect(records).toEqual([
      {
        method: 'POST',
        url: 'http://yente-gws-proxy.local:8083/exec',
        authorization: undefined,
        contentType: 'application/json',
        body: JSON.stringify({ args: ['gmail', '+triage'] }),
      },
    ]);
  });

  it('forces the configured proxy even when NO_PROXY would otherwise match the mediated host', async () => {
    const records: RequestRecord[] = [];
    const onecliGateway = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Exit-Code': '0' });
      res.end('proxied-despite-no-proxy');
    });

    const result = await runShim(['gmail', '+triage'], {
      GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
      HTTP_PROXY: onecliGateway.url,
      NO_PROXY: 'yente-gws-proxy.local,.local,*',
      no_proxy: 'yente-gws-proxy.local,.local,*',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('proxied-despite-no-proxy');
    expect(records).toEqual([
      {
        method: 'POST',
        url: 'http://yente-gws-proxy.local:8083/exec',
        authorization: undefined,
        contentType: 'application/json',
        body: JSON.stringify({ args: ['gmail', '+triage'] }),
      },
    ]);
  });

  it('surfaces proxy policy denials as clear command failures', async () => {
    const proxy = await withProxy((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('The admin has permitted gmail.send only to configured recipients');
    });

    const result = await runShim(['gmail', '+send', '--to', 'dan@example.com'], { GWS_PROXY_URL: proxy.url });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('The admin has permitted');
  });

  it('turns proxy authentication failures into OneCLI-oriented errors', async () => {
    const proxy = await withProxy((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Authentication failed');
    });

    const result = await runShim(['gmail', '+triage'], { GWS_PROXY_URL: proxy.url });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GWS proxy authentication failed');
    expect(result.stderr).toContain('OneCLI');
  });
});
