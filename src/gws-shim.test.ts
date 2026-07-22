import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalSideEffectPayload, classifyAndSanitize } from './db/side-effects-verify.js';

type RequestRecord = {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body: string;
};

const shimPath = path.join(process.cwd(), 'container', 'shim', 'gws');
let runtimeShimPath: string | null = null;
const servers: http.Server[] = [];
const correlationFixtureDirs: string[] = [];
const DEFAULT_TEST_INPUT = 'test-host-input';
const DEFAULT_TEST_ROUTE = 'test-host-route';

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
    req.on('end', () => {
      handler(req, res, body);
    });
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

async function withBinaryProxy(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
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

function echoResolvedAccount(res: http.ServerResponse, body: string): 'personal' | 'glowforge' {
  const parsed = JSON.parse(body) as { account?: unknown };
  if (parsed.account !== 'personal' && parsed.account !== 'glowforge') {
    throw new Error('test response cannot echo an unresolved GWS account');
  }
  res.setHeader('X-GWS-Account', parsed.account);
  return parsed.account;
}

async function runShim(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
  shim = shimPath,
  addDefaultAccount = true,
) {
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
  const effectiveArgs =
    addDefaultAccount && !['--version', '--help', '-h', '--account'].includes(args[0] ?? '')
      ? ['--account', 'personal', ...args]
      : args;
  const effectiveEnv = { ...env };
  const localOnly =
    effectiveArgs[0] === '--version' ||
    effectiveArgs[0] === '--help' ||
    effectiveArgs[0] === '-h' ||
    (effectiveArgs[0] === '--account' && effectiveArgs[2] === 'auth' && effectiveArgs[3] === 'status');
  const explicitCorrelation = Object.prototype.hasOwnProperty.call(env, 'NANOCLAW_HOST_CORRELATION_FILE');
  const requestedCorrelation = effectiveEnv.NANOCLAW_HOST_CORRELATION_FILE;
  if (!localOnly && (!explicitCorrelation || (requestedCorrelation && fs.existsSync(requestedCorrelation)))) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-correlation-'));
    correlationFixtureDirs.push(fixtureDir);
    const correlationPath = requestedCorrelation || path.join(fixtureDir, 'current.json');
    const existing = fs.existsSync(correlationPath)
      ? (JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as Record<string, unknown>)
      : {
          schemaVersion: 1,
          inputId: DEFAULT_TEST_INPUT,
          routeKey: DEFAULT_TEST_ROUTE,
          acceptedAt: new Date().toISOString(),
        };
    const leaseId = typeof existing.leaseId === 'string' ? existing.leaseId : 'test-active-lease';
    fs.writeFileSync(correlationPath, JSON.stringify({ ...existing, leaseId }));
    const markerPath = path.join(fixtureDir, 'active-lease.json');
    fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, leaseId }));
    effectiveEnv.NANOCLAW_HOST_CORRELATION_FILE = correlationPath;
    effectiveEnv.NANOCLAW_HOST_LEASE_FILE = markerPath;
  }
  if (shim === shimPath) {
    if (!runtimeShimPath) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-runtime-test-'));
      runtimeShimPath = path.join(dir, 'gws');
      let source = fs.readFileSync(shimPath, 'utf8');
      source = source.replace(
        'readonly_write_operations_file="/usr/local/share/nanoclaw/gws-v0.18.1-write-operations.json"',
        `readonly_write_operations_file=${JSON.stringify(path.join(process.cwd(), 'src/db/gws-v0.18.1-write-operations.json'))}`,
      );
      source = source.replace(
        'readonly_request_helper="/usr/local/lib/nanoclaw/gws-request.mjs"',
        `readonly_request_helper=${JSON.stringify(path.join(process.cwd(), 'container/shim/gws-request.mjs'))}`,
      );
      fs.writeFileSync(runtimeShimPath, source, { mode: 0o755 });
    }
    shim = runtimeShimPath;
  }
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('sh', [shim, ...effectiveArgs], {
      cwd,
      env: {
        ...process.env,
        ...cleanProxyEnv,
        ...effectiveEnv,
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

async function runShimRaw(args: string[], env: NodeJS.ProcessEnv = {}, cwd = process.cwd(), shim = shimPath) {
  return runShim(args, env, cwd, shim, false);
}

function shimWithOutputRootsForTest(roots: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-root-test-'));
  const shim = path.join(dir, 'gws');
  let source = fs.readFileSync(shimPath, 'utf8');
  source = source.replace(
    'readonly_output_roots="/workspace/agent:/workspace/outbox"',
    `readonly_output_roots=${JSON.stringify(roots.join(':'))}`,
  );
  source = source.replace(
    'readonly_write_operations_file="/usr/local/share/nanoclaw/gws-v0.18.1-write-operations.json"',
    `readonly_write_operations_file=${JSON.stringify(path.join(process.cwd(), 'src/db/gws-v0.18.1-write-operations.json'))}`,
  );
  source = source.replace(
    'readonly_request_helper="/usr/local/lib/nanoclaw/gws-request.mjs"',
    `readonly_request_helper=${JSON.stringify(path.join(process.cwd(), 'container/shim/gws-request.mjs'))}`,
  );
  if (!source.includes(roots.join(':'))) throw new Error('test shim root replacement failed');
  fs.writeFileSync(shim, source, { mode: 0o755 });
  return shim;
}

function shimWithInputRootsForTest(roots: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-input-root-test-'));
  const shim = path.join(dir, 'gws');
  let source = fs.readFileSync(shimPath, 'utf8');
  source = source.replace(
    'readonly_input_roots="/workspace/agent:/workspace/outbox"',
    `readonly_input_roots=${JSON.stringify(roots.join(':'))}`,
  );
  source = source.replace(
    'readonly_request_helper="/usr/local/lib/nanoclaw/gws-request.mjs"',
    `readonly_request_helper=${JSON.stringify(path.join(process.cwd(), 'container/shim/gws-request.mjs'))}`,
  );
  source = source.replace(
    'readonly_write_operations_file="/usr/local/share/nanoclaw/gws-v0.18.1-write-operations.json"',
    `readonly_write_operations_file=${JSON.stringify(path.join(process.cwd(), 'src/db/gws-v0.18.1-write-operations.json'))}`,
  );
  if (!source.includes(roots.join(':'))) throw new Error('test shim input-root replacement failed');
  fs.writeFileSync(shim, source, { mode: 0o755 });
  return shim;
}

function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): Map<string, { filename?: string; body: Buffer }> {
  const boundary = /boundary=([^;]+)/i.exec(contentType ?? '')?.[1]?.replace(/^"|"$/g, '');
  if (!boundary) throw new Error(`missing multipart boundary: ${contentType}`);
  const marker = Buffer.from(`--${boundary}`);
  const parts = new Map<string, { filename?: string; body: Buffer }>();
  let cursor = marker.length + 2;
  while (cursor < body.length) {
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const headers = body.subarray(cursor, headerEnd).toString('utf8');
    const next = body.indexOf(marker, headerEnd + 4);
    if (next < 0) break;
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const filename = /filename="([^"]+)"/.exec(headers)?.[1];
    if (name) parts.set(name, { filename, body: body.subarray(headerEnd + 4, next - 2) });
    cursor = next + marker.length + 2;
  }
  return parts;
}

function writeOutputProxyResponse(res: http.ServerResponse, bytes: Buffer | string): void {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'X-Exit-Code': '0',
    'X-GWS-Proxy-Output': 'file',
    'X-GWS-Proxy-Output-Bytes': String(body.length),
    'X-GWS-Proxy-Output-SHA256': hash,
  });
  res.end(body);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of correlationFixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

  it('requires an exact fixed-position account selector before every remote operation', async () => {
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end('{"ok":true}');
    });

    const personal = await runShimRaw(['--account', 'personal', 'gmail', 'users', 'getProfile'], {
      GWS_PROXY_URL: proxy.url,
    });
    const glowforge = await runShimRaw(['--account', 'glowforge', 'admin-reports:directory_v1', 'users', 'list'], {
      GWS_PROXY_URL: proxy.url,
    });

    expect(personal.status).toBe(0);
    expect(glowforge.status).toBe(0);
    expect(records.map((record) => JSON.parse(record.body))).toEqual([
      {
        account: 'personal',
        args: ['gmail', 'users', 'getProfile'],
        input_id: DEFAULT_TEST_INPUT,
        route_key: DEFAULT_TEST_ROUTE,
      },
      {
        account: 'glowforge',
        args: ['admin-reports:directory_v1', 'users', 'list'],
        input_id: DEFAULT_TEST_INPUT,
        route_key: DEFAULT_TEST_ROUTE,
      },
    ]);
  });

  it.each([
    ['missing selector', ['gmail', 'users', 'getProfile']],
    ['missing label', ['--account']],
    ['empty label', ['--account', '', 'gmail', 'users', 'getProfile']],
    ['primary alias', ['--account', 'primary', 'gmail', 'users', 'getProfile']],
    ['both selector', ['--account', 'both', 'gmail', 'users', 'getProfile']],
    ['case variant', ['--account', 'Personal', 'gmail', 'users', 'getProfile']],
    ['whitespace variant', ['--account', ' personal', 'gmail', 'users', 'getProfile']],
    ['equals syntax', ['--account=personal', 'gmail', 'users', 'getProfile']],
    ['misplaced selector', ['gmail', '--account', 'personal', 'users', 'getProfile']],
    ['unsupported auth operation', ['--account', 'personal', 'auth', 'login']],
    ['extra auth status argument', ['--account', 'personal', 'auth', 'status', 'extra']],
    ['duplicate selector', ['--account', 'personal', 'gmail', 'users', 'getProfile', '--account', 'glowforge']],
    ['duplicate equals selector', ['--account', 'personal', 'gmail', '--account=glowforge', 'users', 'getProfile']],
  ])('rejects %s with exit 2 before making a network request', async (_name, args) => {
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('must not be reached');
    });

    const result = await runShimRaw(args, { GWS_PROXY_URL: proxy.url });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(records).toHaveLength(0);
  });

  it('keeps the authoritative selector outside upstream args even when an argument body names another account', async () => {
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end('{"ok":true}');
    });

    const result = await runShimRaw(
      ['--account', 'personal', 'drive', 'files', 'create', '--json', '{"account":"glowforge","name":"x"}'],
      { GWS_PROXY_URL: proxy.url },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(records[0].body)).toEqual({
      account: 'personal',
      args: ['drive', 'files', 'create', '--json', '{"account":"glowforge","name":"x"}'],
      input_id: DEFAULT_TEST_INPUT,
      route_key: DEFAULT_TEST_ROUTE,
    });
  });

  it('reports account-aware auth status through authenticated POST /whoami without sending a bearer itself', async () => {
    const gatewayRecords: RequestRecord[] = [];
    const serviceRecords: Array<{ account: string; authorization?: string }> = [];
    const service = await withProxy((req, res, body) => {
      const account = echoResolvedAccount(res, body);
      serviceRecords.push({ account, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ account, email: account === 'personal' ? 'dan@danshapiro.com' : 'dan@glowforge.com' }));
    });
    const gateway = await withProxy((req, res, body) => {
      gatewayRecords.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      const forwarded = http.request(
        `${service.url}/whoami`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer fake-yente-gws-proxy',
          },
        },
        (serviceResponse) => {
          const chunks: Buffer[] = [];
          serviceResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          serviceResponse.on('end', () => {
            res.writeHead(serviceResponse.statusCode ?? 500, serviceResponse.headers);
            res.end(Buffer.concat(chunks));
          });
        },
      );
      forwarded.on('error', (error) => {
        res.writeHead(502);
        res.end(error.message);
      });
      forwarded.end(body);
    });

    const env = {
      GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
      YENTE_ONECLI_GATEWAY_PROXY_URL: gateway.url,
    };
    const personal = await runShimRaw(['--account', 'personal', 'auth', 'status'], env);
    const glowforge = await runShimRaw(['--account', 'glowforge', 'auth', 'status'], env);
    expect(personal).toMatchObject({
      status: 0,
      stdout: '{"account":"personal","email":"dan@danshapiro.com"}',
      stderr: '',
    });
    expect(glowforge).toMatchObject({
      status: 0,
      stdout: '{"account":"glowforge","email":"dan@glowforge.com"}',
      stderr: '',
    });
    expect(gatewayRecords).toEqual([
      {
        method: 'POST',
        url: 'http://yente-gws-proxy.local:8083/whoami',
        authorization: undefined,
        contentType: 'application/json',
        body: '{"account":"personal"}',
      },
      {
        method: 'POST',
        url: 'http://yente-gws-proxy.local:8083/whoami',
        authorization: undefined,
        contentType: 'application/json',
        body: '{"account":"glowforge"}',
      },
    ]);
    expect(serviceRecords).toEqual([
      { account: 'personal', authorization: 'Bearer fake-yente-gws-proxy' },
      { account: 'glowforge', authorization: 'Bearer fake-yente-gws-proxy' },
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
      echoResolvedAccount(res, body);
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
        body: JSON.stringify({
          account: 'personal',
          args: ['gmail', '+triage', '--max', '5'],
          input_id: DEFAULT_TEST_INPUT,
          route_key: DEFAULT_TEST_ROUTE,
        }),
      },
    ]);
  });

  it('encodes fixed-position proxy confirmation and native-create target parent outside upstream argv', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const proxy = await withProxy((_req, res, body) => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end('{}');
    });
    const confirmed = await runShimRaw(
      [
        '--account',
        'personal',
        '--confirmed',
        'calendar',
        '+insert',
        '--summary',
        'Board',
        '--start',
        '2026-07-22T10:00:00Z',
        '--end',
        '2026-07-22T10:30:00Z',
      ],
      { GWS_PROXY_URL: proxy.url },
    );
    const contained = await runShimRaw(
      [
        '--account',
        'glowforge',
        '--target-parent',
        'shared-root',
        'docs',
        'documents',
        'create',
        '--json',
        '{"title":"Plan"}',
      ],
      { GWS_PROXY_URL: proxy.url },
    );
    expect(confirmed.status).toBe(0);
    expect(contained.status).toBe(0);
    expect(requests[0]).toMatchObject({ account: 'personal', confirmed: true });
    expect(requests[0].args).toEqual([
      'calendar',
      '+insert',
      '--summary',
      'Board',
      '--start',
      '2026-07-22T10:00:00Z',
      '--end',
      '2026-07-22T10:30:00Z',
    ]);
    expect(requests[1]).toMatchObject({ account: 'glowforge', target_parent: 'shared-root' });
    expect(requests[1].args).toEqual(['docs', 'documents', 'create', '--json', '{"title":"Plan"}']);
  });

  it('rejects malformed or misplaced proxy-only flags before network access', async () => {
    const requests: string[] = [];
    const proxy = await withProxy((_req, res, body) => {
      requests.push(body);
      res.writeHead(500);
      res.end();
    });
    for (const args of [
      ['--account', 'personal', '--target-parent', '', 'docs', 'documents', 'create'],
      ['--account', 'personal', 'calendar', '+insert', '--confirmed'],
      ['--account', 'personal', '--confirmed', '--confirmed', 'calendar', '+insert'],
    ]) {
      const result = await runShimRaw(args, { GWS_PROXY_URL: proxy.url });
      expect(result.status).toBe(2);
    }
    expect(requests).toEqual([]);
  });

  it.each([
    [
      'drive helper',
      ['drive', '+upload', '__FILE__', '--parent', 'folder-1'],
      Buffer.from([0, 1, 2, 255, 10]),
      'application/octet-stream',
    ],
    [
      'gmail attachment',
      ['gmail', '+send', '--to', 'a@example.com', '--subject', 'x', '--body', 'y', '--attach', '__FILE__'],
      Buffer.from('attachment bytes\n'),
      'application/octet-stream',
    ],
    [
      'raw gmail upload',
      ['gmail', 'users', 'messages', 'send', '--upload', '__FILE__', '--upload-content-type', 'message/rfc822'],
      Buffer.from('To: a@example.com\r\n\r\nbody\0tail'),
      'message/rfc822',
    ],
  ])(
    'sends %s as account-bound multipart without changing file bytes',
    async (_label, template, bytes, contentType) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-upload-'));
      const file = path.join(root, 'payload.bin');
      fs.writeFileSync(file, bytes);
      const shim = shimWithInputRootsForTest([root]);
      const received: Array<{ metadata: any; file: Buffer }> = [];
      const proxy = await withBinaryProxy((req, res, body) => {
        const parts = parseMultipart(body, headerValue(req.headers['content-type']));
        const metadata = JSON.parse(parts.get('request')!.body.toString('utf8'));
        const input = metadata.inputs[0];
        received.push({ metadata, file: Buffer.from(parts.get(`file-${input.arg_index}`)!.body) });
        res.setHeader('X-GWS-Account', metadata.account);
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
        res.end('{}');
      });
      const args = ['--account', 'glowforge', ...template.map((arg) => (arg === '__FILE__' ? file : arg))];
      const result = await runShimRaw(args, { GWS_PROXY_URL: proxy.url }, root, shim);
      expect(result.status).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].metadata.account).toBe('glowforge');
      expect(received[0].metadata.inputs[0]).toMatchObject({
        content_type: contentType,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      expect(received[0].file.equals(bytes)).toBe(true);
    },
  );

  it('rejects upload files outside fixed roots and symlinks without network access', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-safe-upload-'));
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-outside-')), 'secret');
    fs.writeFileSync(outside, 'secret');
    const link = path.join(root, 'link');
    fs.symlinkSync(outside, link);
    const shim = shimWithInputRootsForTest([root]);
    const requests: Buffer[] = [];
    const proxy = await withBinaryProxy((_req, res, body) => {
      requests.push(body);
      res.writeHead(500);
      res.end();
    });
    for (const file of [outside, link]) {
      const result = await runShimRaw(
        ['--account', 'personal', 'drive', '+upload', file, '--parent', 'folder-1'],
        { GWS_PROXY_URL: proxy.url },
        root,
        shim,
      );
      expect(result.status).toBe(2);
    }
    expect(requests).toEqual([]);
  });

  it('treats transfer loss for an exact write as manual-only exit 75 while reads remain ordinary failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-write-loss-'));
    const shim = shimWithInputRootsForTest([root]);
    const proxy = await withBinaryProxy((_req, res) => {
      res.socket?.destroy();
    });
    const write = await runShimRaw(
      [
        '--account',
        'personal',
        'tasks',
        'tasklists',
        'insert',
        '--params',
        '{"tasklist":"work-list","accessToken":"must-not-print-token"}',
        '--json',
        '{"title":"Work","notes":"must-not-print-body"}',
      ],
      { GWS_PROXY_URL: proxy.url },
      root,
      shim,
    );
    const read = await runShimRaw(
      ['--account', 'personal', 'gmail', 'users', 'getProfile'],
      { GWS_PROXY_URL: proxy.url },
      root,
      shim,
    );
    expect(write.status).toBe(75);
    expect(write.stderr).toContain('response was lost');
    expect(write.stderr).toContain('Do not retry automatically');
    const contextLine = write.stderr.split('\n').find((line) => line.startsWith('GWS_MANUAL_RECONCILIATION '));
    expect(contextLine).toBeDefined();
    const context = JSON.parse(contextLine!.slice('GWS_MANUAL_RECONCILIATION '.length));
    expect(context).toMatchObject({
      schema_version: 1,
      event: 'gws_write_response_lost',
      account: 'personal',
      input_id: DEFAULT_TEST_INPUT,
      route_key: DEFAULT_TEST_ROUTE,
      operation: 'tasks tasklists insert',
      resource_context: { tasklist: 'work-list', title: 'Work' },
    });
    expect(context.args_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(context.argument_shape).toEqual([
      'tasks',
      'tasklists',
      'insert',
      '--params',
      '<value>',
      '--json',
      '<value>',
    ]);
    expect(write.stderr).not.toContain('must-not-print-token');
    expect(write.stderr).not.toContain('must-not-print-body');
    expect(read.status).toBe(1);
    expect(read.stderr).not.toContain('Do not retry automatically');
    expect(read.stderr).not.toContain('GWS_MANUAL_RECONCILIATION');
  });

  it('preserves successful upstream stdout bytes including trailing newlines', async () => {
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Exit-Code': '0' });
      res.end('line one\nline two\n\n');
    });

    const result = await runShim(['gmail', 'users', 'getProfile'], { GWS_PROXY_URL: proxy.url });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('line one\nline two\n\n');
  });

  it('preserves the proxy manual-reconciliation sentinel as exit 75 without printing its response body', async () => {
    const proxy = await withProxy((_req, res, requestBody) => {
      const request = JSON.parse(requestBody) as { account: string; input_id: string; route_key: string };
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'X-Exit-Code': '75',
        'X-GWS-Account': request.account,
        'X-GWS-Audit-Id': 'ambiguous-audit-1',
        'X-GWS-Input-Id': request.input_id,
        'X-GWS-Route-Key': request.route_key,
        'X-GWS-Service': 'drive',
        'X-GWS-Method': 'files.update',
        'X-GWS-Outcome': 'outcome_unknown',
        'X-GWS-Upstream-Outcome': 'outcome_unknown',
        'X-GWS-Reconciliation-Recorded': 'true',
      });
      res.end(
        JSON.stringify({
          outcome: 'outcome_unknown',
          audit_id: 'ambiguous-audit-1',
          operator_reconciliation: true,
          reconciliation_recorded: true,
          retry: 'manual_only',
          private_upstream_detail: 'must-not-print',
        }),
      );
    });

    const result = await runShimRaw(['--account', 'personal', 'drive', 'files', 'update'], {
      GWS_PROXY_URL: proxy.url,
    });

    expect(result.status).toBe(75);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outcome is unknown');
    expect(result.stderr).toContain('ambiguous-audit-1');
    expect(result.stderr).toContain('Do not retry automatically');
    expect(result.stderr).not.toContain('must-not-print');
  });

  it.each([
    ['ordinary 502', {}],
    ['spoofed exit 75', { 'X-Exit-Code': '75' }],
    [
      'incomplete reconciliation sentinel',
      {
        'X-Exit-Code': '75',
        'X-GWS-Outcome': 'outcome_unknown',
        'X-GWS-Upstream-Outcome': 'outcome_unknown',
      },
    ],
  ])('keeps an %s on the generic failure path', async (_label, extraHeaders) => {
    const proxy = await withProxy((_req, res, requestBody) => {
      const request = JSON.parse(requestBody) as { account: string };
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'X-GWS-Account': request.account,
        ...extraHeaders,
      });
      res.end('{"error":"ordinary upstream failure"}');
    });

    const result = await runShimRaw(['--account', 'personal', 'drive', 'files', 'get'], {
      GWS_PROXY_URL: proxy.url,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GWS proxy returned HTTP 502');
    expect(result.stderr).not.toContain('Do not retry automatically');
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'glowforge'],
  ])('rejects a %s response account before printing any body', async (_name, responseAccount) => {
    const proxy = await withProxy((_req, res) => {
      if (responseAccount) res.setHeader('X-GWS-Account', responseAccount);
      else res.removeHeader('X-GWS-Account');
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end('{"secret":"must-not-print"}');
    });

    const result = await runShimRaw(['--account', 'personal', 'gmail', 'users', 'getProfile'], {
      GWS_PROXY_URL: proxy.url,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('response account');
    expect(result.stderr).not.toContain('must-not-print');
  });

  it.each([
    ['401', 401],
    ['403', 403],
    ['default error', 502],
  ])('rejects a wrong-account %s /exec response without leaking its body', async (_name, status) => {
    const proxy = await withProxy((_req, res) => {
      res.setHeader('X-GWS-Account', 'glowforge');
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('private upstream error must-not-print');
    });

    const result = await runShimRaw(['--account', 'personal', 'gmail', 'users', 'getProfile'], {
      GWS_PROXY_URL: proxy.url,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('response account');
    expect(result.stderr).not.toContain('private upstream error');
    expect(result.stderr).not.toContain('must-not-print');
  });

  it.each([
    ['401', 401],
    ['403', 403],
    ['default error', 502],
  ])('rejects a wrong-account %s /whoami response without leaking its body', async (_name, status) => {
    const proxy = await withProxy((_req, res) => {
      res.setHeader('X-GWS-Account', 'glowforge');
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('private identity error must-not-print');
    });

    const result = await runShimRaw(['--account', 'personal', 'auth', 'status'], { GWS_PROXY_URL: proxy.url });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('response account');
    expect(result.stderr).not.toContain('private identity error');
    expect(result.stderr).not.toContain('must-not-print');
  });

  it.each([
    ['exec', '/exec', ['--account', 'personal', 'gmail', 'users', 'getProfile']],
    ['whoami', '/whoami', ['--account', 'personal', 'auth', 'status']],
  ])(
    'reports a headerless authentication failure from /%s as a OneCLI configuration problem',
    async (_name, path, args) => {
      const seenPaths: Array<string | undefined> = [];
      const proxy = await withProxy((req, res) => {
        seenPaths.push(req.url);
        // Authentication happens before account resolution, so a real proxy 401
        // has no authoritative account label to echo.
        res.removeHeader('X-GWS-Account');
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('private gateway diagnostic must-not-print');
      });

      const result = await runShimRaw(args, { GWS_PROXY_URL: proxy.url });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(seenPaths).toEqual([path]);
      expect(result.stderr).toContain('GWS proxy authentication failed');
      expect(result.stderr).toContain('OneCLI');
      expect(result.stderr).not.toContain('response account');
      expect(result.stderr).not.toContain('private gateway diagnostic');
      expect(result.stderr).not.toContain('must-not-print');
    },
  );

  it.each([
    ['403', 403],
    ['default error', 502],
  ])('rejects a missing-account %s /whoami response without leaking its body', async (_name, status) => {
    const proxy = await withProxy((_req, res) => {
      res.removeHeader('X-GWS-Account');
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('private identity error must-not-print');
    });

    const result = await runShimRaw(['--account', 'personal', 'auth', 'status'], { GWS_PROXY_URL: proxy.url });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('response account');
    expect(result.stderr).not.toContain('private identity error');
    expect(result.stderr).not.toContain('must-not-print');
  });

  it('does not publish downloaded bytes when the response account mismatches', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-account-output-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const output = path.join(workspace, 'private.bin');
    const proxy = await withProxy((_req, res) => {
      res.setHeader('X-GWS-Account', 'glowforge');
      writeOutputProxyResponse(res, Buffer.from('private-output'));
    });

    const result = await runShimRaw(
      ['--account', 'personal', 'drive', 'files', 'download', '--params', '{"fileId":"x"}', '-o', output],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('handles a request for both accounts as exactly two separately labeled calls through one generic gateway', async () => {
    const gatewayRecords: Array<{ account: string; shimAuthorization?: string }> = [];
    const serviceRecords: Array<{ account: string; authorization?: string }> = [];
    const service = await withProxy((req, res, body) => {
      const account = echoResolvedAccount(res, body);
      serviceRecords.push({ account, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end(JSON.stringify({ account, items: [] }));
    });
    const gateway = await withProxy((req, res, body) => {
      const account = (JSON.parse(body) as { account: string }).account;
      gatewayRecords.push({ account, shimAuthorization: req.headers.authorization });
      const forwarded = http.request(
        `${service.url}/exec`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer fake-yente-gws-proxy',
          },
        },
        (serviceResponse) => {
          const chunks: Buffer[] = [];
          serviceResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          serviceResponse.on('end', () => {
            res.writeHead(serviceResponse.statusCode ?? 500, serviceResponse.headers);
            res.end(Buffer.concat(chunks));
          });
        },
      );
      forwarded.on('error', (error) => {
        res.writeHead(502);
        res.end(error.message);
      });
      forwarded.end(body);
    });

    const results = await Promise.all(
      ['personal', 'glowforge'].map((account) =>
        runShimRaw(['--account', account, 'calendar', 'events', 'list'], {
          GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
          YENTE_ONECLI_GATEWAY_PROXY_URL: gateway.url,
        }),
      ),
    );

    expect(results.map((result) => JSON.parse(result.stdout).account).sort()).toEqual(['glowforge', 'personal']);
    expect(gatewayRecords).toHaveLength(2);
    expect(gatewayRecords.map((record) => record.account).sort()).toEqual(['glowforge', 'personal']);
    expect(gatewayRecords.every((record) => record.shimAuthorization === undefined)).toBe(true);
    expect(serviceRecords).toHaveLength(2);
    expect(serviceRecords.map((record) => record.account).sort()).toEqual(['glowforge', 'personal']);
    expect(new Set(serviceRecords.map((record) => record.authorization))).toEqual(
      new Set(['Bearer fake-yente-gws-proxy']),
    );
  });

  it('does not treat -o-prefixed values for known flags as output syntax', async () => {
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Exit-Code': '0' });
      res.end('{"ok":true}');
    });

    const result = await runShim(['gmail', 'messages', 'list', '--query', '-older_than:7d'], {
      GWS_PROXY_URL: proxy.url,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toEqual([
      expect.objectContaining({
        body: JSON.stringify({
          account: 'personal',
          args: ['gmail', 'messages', 'list', '--query', '-older_than:7d'],
          input_id: DEFAULT_TEST_INPUT,
          route_key: DEFAULT_TEST_ROUTE,
        }),
      }),
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
      echoResolvedAccount(res, body);
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
        body: JSON.stringify({
          account: 'personal',
          args: ['gmail', '+triage'],
          input_id: DEFAULT_TEST_INPUT,
          route_key: DEFAULT_TEST_ROUTE,
        }),
      },
    ]);
  });

  it('prefers the captured OneCLI gateway proxy over the Codex auth-gate proxy', async () => {
    const records: RequestRecord[] = [];
    const onecliGateway = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Exit-Code': '0' });
      res.end('generic-onecli-proxy-ok');
    });

    const result = await runShim(['gmail', '+triage'], {
      GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
      HTTP_PROXY: 'http://codex-agent@yente-onecli-auth-gate.local:18055',
      http_proxy: 'http://codex-agent@yente-onecli-auth-gate.local:18055',
      YENTE_ONECLI_GATEWAY_PROXY_URL: onecliGateway.url,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('generic-onecli-proxy-ok');
    expect(records).toEqual([
      {
        method: 'POST',
        url: 'http://yente-gws-proxy.local:8083/exec',
        authorization: undefined,
        contentType: 'application/json',
        body: JSON.stringify({
          account: 'personal',
          args: ['gmail', '+triage'],
          input_id: DEFAULT_TEST_INPUT,
          route_key: DEFAULT_TEST_ROUTE,
        }),
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
      echoResolvedAccount(res, body);
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
        body: JSON.stringify({
          account: 'personal',
          args: ['gmail', '+triage'],
          input_id: DEFAULT_TEST_INPUT,
          route_key: DEFAULT_TEST_ROUTE,
        }),
      },
    ]);
  });

  it('surfaces proxy policy denials as clear command failures', async () => {
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
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

  it('writes relative -o output in the caller cwd and strips the path before proxy execution', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    fs.mkdirSync(path.join(workspace, 'enrichment_runs', 'run-1', 'drive', 'contents'), { recursive: true });
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: headerValue(req.headers['content-type']),
        body,
      });
      echoResolvedAccount(res, body);
      writeOutputProxyResponse(res, 'drive file text\n');
    });

    const result = await runShim(
      [
        'drive',
        'files',
        'export',
        '--params',
        '{"fileId":"doc-1","mimeType":"text/plain"}',
        '-o',
        'enrichment_runs/run-1/drive/contents/doc.txt',
        '--format',
        'json',
      ],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    const outputPath = path.join(workspace, 'enrichment_runs', 'run-1', 'drive', 'contents', 'doc.txt');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('drive file text\n');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'success',
      saved_file: outputPath,
      bytes: 16,
      sha256: crypto.createHash('sha256').update('drive file text\n').digest('hex'),
    });
    expect(records).toHaveLength(1);
    const posted = JSON.parse(records[0].body) as { account: string; args: string[]; output?: { mode: string } };
    expect(posted.account).toBe('personal');
    expect(posted.output).toEqual({ mode: 'return_file' });
    expect(posted.args).toEqual([
      'drive',
      'files',
      'export',
      '--params',
      '{"fileId":"doc-1","mimeType":"text/plain"}',
      '--format',
      'json',
    ]);
  });

  it('writes absolute --output paths inside the shim-owned workspace root', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outDir = path.join(workspace, 'tmp', 'gws_drive_probe');
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, 'current_probe.txt');
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      writeOutputProxyResponse(res, 'absolute text\n');
    });

    const result = await runShim(
      [
        'drive',
        'files',
        'export',
        '--params',
        '{"fileId":"doc-1","mimeType":"text/plain"}',
        '--output',
        outputPath,
        '--format',
        'json',
      ],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('absolute text\n');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'success',
      saved_file: outputPath,
      bytes: 14,
    });
  });

  it('preserves binary output bytes using the proxy canonical integrity headers', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outputPath = path.join(workspace, 'binary.bin');
    const bytes = Buffer.from([0x67, 0x77, 0x73, 0x0a, 0x00, 0xff, 0x41]);
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      writeOutputProxyResponse(res, bytes);
    });

    const result = await runShim(
      ['drive', 'files', 'download', '--params', '{"fileId":"bin-1"}', '-o', outputPath],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(outputPath)).toEqual(bytes);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'success',
      saved_file: outputPath,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('rejects output paths outside allowed roots before contacting the proxy', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('proxy should not be called');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', '/tmp/outside.txt'],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outside allowed output roots');
    expect(records).toHaveLength(0);
  });

  it('rejects output paths whose parent directory does not exist before contacting the proxy', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('proxy should not be called');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', 'missing/doc.txt'],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('output parent directory does not exist');
    expect(records).toHaveLength(0);
  });

  it('rejects a symlink output target before contacting the proxy', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-outside-'));
    const outputPath = path.join(workspace, 'linked-out.txt');
    fs.symlinkSync(path.join(outside, 'real.txt'), outputPath);
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('proxy should not be called');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', outputPath],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('output target is a symlink');
    expect(records).toHaveLength(0);
  });

  it('rejects a symlink parent that resolves outside allowed roots before contacting the proxy', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-outside-'));
    fs.symlinkSync(outside, path.join(workspace, 'outside-link'));
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('proxy should not be called');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', 'outside-link/out.txt'],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('outside allowed output roots');
    expect(records).toHaveLength(0);
  });

  it('fails when output was requested but the proxy does not stream output bytes', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outputPath = path.join(workspace, 'out.txt');
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Exit-Code': '0' });
      res.end('{"status":"success","saved_file":"/app/out.txt"}');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', outputPath],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not return output bytes');
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('preserves output-mode proxy CLI failure bodies', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outputPath = path.join(workspace, 'out.txt');
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Exit-Code': '3' });
      res.end('Request had insufficient authentication scopes.\n');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', outputPath],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('insufficient authentication scopes');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('rejects an existing output target before contacting the proxy', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outputPath = path.join(workspace, 'out.txt');
    fs.writeFileSync(outputPath, 'do not replace\n');
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('proxy should not be called');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', outputPath],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('output target already exists');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('do not replace\n');
    expect(records).toHaveLength(0);
  });

  it('rejects multiple output paths and attached -oPATH syntax before contacting the proxy', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const records: RequestRecord[] = [];
    const proxy = await withProxy((req, res, body) => {
      records.push({ method: req.method, url: req.url, body });
      res.writeHead(500);
      res.end('proxy should not be called');
    });

    const multiple = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', 'a.txt', '--output=b.txt'],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );
    expect(multiple.status).not.toBe(0);
    expect(multiple.stderr).toContain('multiple output paths were provided');

    const attached = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', `-o${path.join(workspace, 'attached.txt')}`],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );
    expect(attached.status).not.toBe(0);
    expect(attached.stderr).toContain('attached -oPATH output syntax is not supported');
    expect(records).toHaveLength(0);
  });

  it('rejects a streamed body whose byte count or SHA-256 does not match proxy metadata', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-workspace-'));
    const shim = shimWithOutputRootsForTest([workspace]);
    const outputPath = path.join(workspace, 'out.txt');
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Exit-Code': '0',
        'X-GWS-Proxy-Output': 'file',
        'X-GWS-Proxy-Output-Bytes': '100',
        'X-GWS-Proxy-Output-SHA256': crypto.createHash('sha256').update('different').digest('hex'),
      });
      res.end('short');
    });

    const result = await runShim(
      ['drive', 'files', 'export', '--params', '{"fileId":"doc-1"}', '-o', outputPath],
      { GWS_PROXY_URL: proxy.url },
      workspace,
      shim,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('output integrity check failed');
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task 4B: GWS shim side-effect ledger writing
// ──────────────────────────────────────────────────────────────────────────

function readLedger(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// A host acceptance timestamp. Receipt time may be arbitrarily old; the
// host-owned current pointer exists only while this exact input is accepted.
function freshUpdatedAt(): string {
  return new Date().toISOString();
}

function apiEffectSuccessProxy(body: string, sig: string, payload: string, auditId = 'aud-1') {
  return (_req: http.IncomingMessage, res: http.ServerResponse, requestBody: string): void => {
    let signed: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed.schema_version === 2) signed = parsed;
    } catch {
      // Legacy payload.
    }
    if (!signed) echoResolvedAccount(res, requestBody);
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-Exit-Code': '0',
      'X-GWS-Audit-Id': auditId,
      'X-GWS-Request-Class': 'api',
      'X-GWS-Api-Effect': 'true',
      'X-GWS-Operation-Succeeded': 'true',
      'X-GWS-Side-Effect-Signature': sig,
      'X-GWS-Side-Effect-Payload': payload,
      ...(signed
        ? {
            'X-GWS-Side-Effect-Schema': '2',
            'X-GWS-Profile': String(signed.profile ?? ''),
            'X-GWS-Account': String(signed.account_label ?? ''),
            'X-GWS-Account-Email': String(signed.account_email ?? ''),
            'X-GWS-Input-Id': String(signed.input_id ?? ''),
            'X-GWS-Route-Key': String(signed.route_key ?? ''),
            'X-GWS-Service': String(signed.service ?? ''),
            'X-GWS-Method': String(signed.method ?? ''),
            'X-GWS-Occurred-At': String(signed.occurred_at ?? ''),
          }
        : {}),
    });
    res.end(body);
  };
}

describe('gws proxy shim — side-effect ledger', () => {
  let tmp: string;
  const created: string[] = [];

  function freshTmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-shim-ledger-'));
    created.push(d);
    return d;
  }

  afterEach(() => {
    while (created.length) {
      const d = created.pop();
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('keeps schema-v1 evidence generic while preserving sig+payload verbatim before stdout', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const active = path.join(tmp, 'host-correlation.json');
    fs.writeFileSync(
      active,
      JSON.stringify({ schemaVersion: 1, inputId: 'in-9', routeKey: 'discord:7', acceptedAt: freshUpdatedAt() }),
    );
    const sig = 'BASE64SIGNATURE==';
    const payload = '{"audit_id":"aud-1","service":"gmail","method":"users.drafts.create"}';
    const proxy = await withProxy(apiEffectSuccessProxy('Draft created: r-987654', sig, payload));

    const result = await runShim(
      ['gmail', 'users', 'drafts', 'create', '--to', 'dan@x.com', '--subject', 's', '--body', 'b'],
      {
        GWS_PROXY_URL: proxy.url,
        NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
        NANOCLAW_HOST_CORRELATION_FILE: active,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Draft created: r-987654');

    const rows = readLedger(ledger);
    expect(rows.length).toBe(1);
    const rec = rows[0];
    expect(rec.kind).toBe('gws_mutation_completed');
    expect(rec.payload_schema_version).toBe(1);
    expect(rec.audit_id).toBe('aud-1');
    expect(rec.input_id).toBe('in-9');
    expect(rec.route_key).toBe('discord:7');
    // Signature + payload carried verbatim (the shim does NOT verify).
    expect(rec.signature).toBe(sig);
    expect(rec.payload).toBe(payload);
    // Method/resource preserved; no raw auth header / no full email body.
    const blob = JSON.stringify(rec);
    expect(blob).not.toContain('Authorization');
    expect(blob).not.toContain('Bearer');
  });

  it('derives the kind and exact account/operation/correlation exclusively from the signed schema-v2 payload', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const signed = {
      schema_version: 2,
      audit_id: 'aud-drive',
      profile: 'nanoclaw',
      account_label: 'glowforge',
      account_email: 'dan@glowforge.com',
      input_id: 'input-drive',
      route_key: 'opencode|discord|chan-2|dm:mg-2',
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-20T12:35:56.789Z',
      result_digest: 'abcdef',
    };
    const payload = JSON.stringify(signed);
    const proxy = await withProxy(apiEffectSuccessProxy('{"id":"file-1"}', 'SIG', payload, 'aud-drive'));
    const correlation = path.join(tmp, 'host-correlation.json');
    fs.writeFileSync(
      correlation,
      JSON.stringify({
        schemaVersion: 1,
        inputId: signed.input_id,
        routeKey: signed.route_key,
        acceptedAt: freshUpdatedAt(),
      }),
    );
    const result = await runShimRaw(['--account', 'glowforge', 'drive', 'files', 'create', '--json', '{"name":"x"}'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: correlation,
    });

    expect(result.status).toBe(0);
    const [row] = readLedger(ledger);
    expect(row.kind).toBe('gws_mutation_completed');
    expect(row.payload_schema_version).toBe(2);
    expect(row.account_label).toBe('glowforge');
    expect(row.account_email).toBe('dan@glowforge.com');
    expect(row.input_id).toBe('input-drive');
    expect(row.route_key).toBe('opencode|discord|chan-2|dm:mg-2');
    expect(row.operation).toBe('drive files.create');
    expect(row.occurred_at).toBe('2026-07-20T12:35:56.789Z');
    expect(row.payload).toBe(payload);
  });

  it('records the invoked operation independently and rejects a valid signature for a different operation', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = {
      schema_version: 2,
      audit_id: 'aud-wrong-op',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'input-1',
      route_key: 'opencode|discord|chan-1|dm:mg-1',
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: new Date().toISOString(),
      result_digest: 'abcdef',
    };
    const payload = canonicalSideEffectPayload(signed);
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    const correlation = path.join(tmp, 'host-correlation.json');
    fs.writeFileSync(
      correlation,
      JSON.stringify({
        schemaVersion: 1,
        inputId: signed.input_id,
        routeKey: signed.route_key,
        acceptedAt: freshUpdatedAt(),
      }),
    );
    const proxy = await withProxy(apiEffectSuccessProxy('{"id":"file-1"}', signature, payload, signed.audit_id));

    await runShim(['gmail', 'users', 'drafts', 'create'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: correlation,
    });
    const [row] = readLedger(ledger);
    expect(row.operation).toBe('gmail users.drafts.create');
    expect(row.response_service).toBe('drive');
    expect(
      classifyAndSanitize(row, {
        gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      })?.validation,
    ).toEqual({ authoritative: false, reason: 'gws_binding_invalid' });
  });

  it('durably stages signed evidence and exits 75 when the proxy says Google completed but global audit failed', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const signed = {
      schema_version: 2,
      audit_id: 'aud-audit-failed',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'input-1',
      route_key: 'opencode|discord|chan-1|dm:mg-1',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-20T12:35:56.789Z',
      result_digest: 'abcdef',
    };
    const payload = JSON.stringify(signed);
    const proxy = await withProxy((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Exit-Code': '75',
        'X-GWS-Outcome': 'completed_audit_failed',
        'X-GWS-Audit-Id': signed.audit_id,
        'X-GWS-Request-Class': 'api',
        'X-GWS-Api-Effect': 'true',
        'X-GWS-Operation-Succeeded': 'true',
        'X-GWS-Side-Effect-Signature': 'SIG',
        'X-GWS-Side-Effect-Payload': payload,
        'X-GWS-Side-Effect-Schema': '2',
        'X-GWS-Profile': signed.profile,
        'X-GWS-Account': signed.account_label,
        'X-GWS-Account-Email': signed.account_email,
        'X-GWS-Input-Id': signed.input_id,
        'X-GWS-Route-Key': signed.route_key,
        'X-GWS-Service': signed.service,
        'X-GWS-Method': signed.method,
        'X-GWS-Occurred-At': signed.occurred_at,
      });
      res.end('sensitive ordinary result must not be printed');
    });

    const correlation = path.join(tmp, 'host-correlation.json');
    fs.writeFileSync(
      correlation,
      JSON.stringify({
        schemaVersion: 1,
        inputId: signed.input_id,
        routeKey: signed.route_key,
        acceptedAt: freshUpdatedAt(),
      }),
    );
    const result = await runShim(['gmail', 'users', 'drafts', 'create'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: correlation,
    });
    expect(result.status).toBe(75);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('operation completed');
    expect(result.stderr).toContain('global audit failed');
    expect(result.stderr).not.toContain('sensitive ordinary result');
    const [row] = readLedger(ledger);
    expect(row.kind).toBe('gmail_draft_created');
    expect(row.account_label).toBe('personal');
    expect(row.account_email).toBe('dan@danshapiro.com');
  });

  it.each([
    { label: 'missing response account', responseAccount: undefined, outcome: undefined },
    {
      label: 'mismatched response account with failed global audit',
      responseAccount: 'glowforge',
      outcome: 'completed_audit_failed',
    },
  ])('stages signed completed-mutation evidence and exits 75 for $label', async ({ responseAccount, outcome }) => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const signed = {
      schema_version: 2,
      audit_id: `aud-account-${responseAccount ?? 'missing'}`,
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'operator-input-1',
      route_key: 'operator|ag-main|operator-session-1',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T15:00:00.000Z',
      result_digest: 'completed-result-digest',
    };
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const payload = canonicalSideEffectPayload(signed);
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    const proxy = await withProxy((_req, res) => {
      if (responseAccount) res.setHeader('X-GWS-Account', responseAccount);
      else res.removeHeader('X-GWS-Account');
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Exit-Code': outcome ? '75' : '0',
        ...(outcome ? { 'X-GWS-Outcome': outcome } : {}),
        'X-GWS-Audit-Id': signed.audit_id,
        'X-GWS-Request-Class': 'api',
        'X-GWS-Api-Effect': 'true',
        'X-GWS-Operation-Succeeded': 'true',
        'X-GWS-Side-Effect-Signature': signature,
        'X-GWS-Side-Effect-Payload': payload,
        'X-GWS-Side-Effect-Schema': '2',
        'X-GWS-Profile': signed.profile,
        'X-GWS-Account-Email': signed.account_email,
        'X-GWS-Input-Id': signed.input_id,
        'X-GWS-Route-Key': signed.route_key,
        'X-GWS-Service': signed.service,
        'X-GWS-Method': signed.method,
        'X-GWS-Occurred-At': signed.occurred_at,
      });
      res.end('sensitive completed mutation result must not be printed');
    });
    const correlation = path.join(tmp, 'operator-correlation.json');
    fs.writeFileSync(
      correlation,
      JSON.stringify({
        schemaVersion: 1,
        inputId: signed.input_id,
        routeKey: signed.route_key,
        acceptedAt: freshUpdatedAt(),
      }),
    );

    const result = await runShimRaw(['--account', 'personal', 'gmail', 'users', 'drafts', 'create'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: correlation,
    });

    expect(result.status).toBe(75);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('response account');
    expect(result.stderr).toContain('Do not retry automatically');
    expect(result.stderr).not.toContain('sensitive completed mutation result');
    if (outcome) expect(result.stderr).toContain('global audit failed');
    const rows = readLedger(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      audit_id: signed.audit_id,
      account_label: 'personal',
      input_id: signed.input_id,
      route_key: signed.route_key,
      response_account_label: responseAccount ?? null,
    });
    expect(
      classifyAndSanitize(rows[0], {
        gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      }),
    ).toMatchObject({
      validation: { authoritative: true },
      replayPolicy: 'no_duplicate_draft',
    });
  });

  it('keeps a valid stale cross-request response non-authoritative while suppressing output and retry', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const hostInputId = 'operator-current-input';
    const hostRouteKey = 'operator|ag-main|operator-current';
    const stale = {
      schema_version: 2,
      audit_id: 'aud-stale-cross-request',
      profile: 'nanoclaw',
      account_label: 'glowforge',
      account_email: 'dan@glowforge.com',
      input_id: 'different-input',
      route_key: 'operator|ag-other|different-session',
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T15:00:01.000Z',
      result_digest: 'stale-result-digest',
    };
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const payload = canonicalSideEffectPayload(stale);
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    const proxy = await withProxy((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Exit-Code': '0',
        'X-GWS-Account': stale.account_label,
        'X-GWS-Audit-Id': stale.audit_id,
        'X-GWS-Request-Class': stale.request_class,
        'X-GWS-Api-Effect': 'true',
        'X-GWS-Operation-Succeeded': 'true',
        'X-GWS-Side-Effect-Signature': signature,
        'X-GWS-Side-Effect-Payload': payload,
        'X-GWS-Side-Effect-Schema': '2',
        'X-GWS-Profile': stale.profile,
        'X-GWS-Account-Email': stale.account_email,
        'X-GWS-Input-Id': stale.input_id,
        'X-GWS-Route-Key': stale.route_key,
        'X-GWS-Service': stale.service,
        'X-GWS-Method': stale.method,
        'X-GWS-Occurred-At': stale.occurred_at,
      });
      res.end('stale completed response must not be printed');
    });
    const correlation = path.join(tmp, 'operator-correlation.json');
    fs.writeFileSync(
      correlation,
      JSON.stringify({
        schemaVersion: 1,
        inputId: hostInputId,
        routeKey: hostRouteKey,
        acceptedAt: freshUpdatedAt(),
      }),
    );

    const result = await runShimRaw(['--account', 'personal', 'gmail', 'users', 'drafts', 'create'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: correlation,
    });

    expect(result.status).toBe(75);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Do not retry automatically');
    expect(result.stderr).not.toContain('stale completed response');
    const [row] = readLedger(ledger);
    expect(row).toMatchObject({
      audit_id: stale.audit_id,
      account_label: 'personal',
      input_id: hostInputId,
      route_key: hostRouteKey,
      operation: 'gmail users.drafts.create',
      response_account_label: 'glowforge',
    });
    expect(
      classifyAndSanitize(row, {
        gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      }),
    ).toMatchObject({
      validation: { authoritative: false, reason: 'gws_binding_invalid' },
      replayPolicy: 'no_duplicate_operation',
    });
  });

  it('also sends inputId/routeKey in the POST body', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const active = path.join(tmp, 'host-correlation.json');
    fs.writeFileSync(
      active,
      JSON.stringify({ schemaVersion: 1, inputId: 'in-9', routeKey: 'discord:7', acceptedAt: freshUpdatedAt() }),
    );
    const attackerControlled = path.join(tmp, 'active-input.json');
    fs.writeFileSync(
      attackerControlled,
      JSON.stringify({ inputId: 'forged-input', routeKey: 'forged-route', updatedAt: freshUpdatedAt() }),
    );
    let captured = '';
    const proxy = await withProxy((_req, res, body) => {
      captured = body;
      echoResolvedAccount(res, body);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Exit-Code': '0',
        'X-GWS-Api-Effect': 'true',
        'X-GWS-Operation-Succeeded': 'true',
        'X-GWS-Audit-Id': 'aud-1',
      });
      res.end('ok');
    });

    await runShim(['gmail', '+triage'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: active,
      NANOCLAW_ACTIVE_INPUT_FILE: attackerControlled,
    });

    const parsed = JSON.parse(captured) as { args: string[]; input_id?: string; route_key?: string };
    expect(parsed.input_id).toBe('in-9');
    expect(parsed.route_key).toBe('discord:7');
  });

  it('fails before curl when host correlation is absent', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const active = path.join(tmp, 'missing-active-input.json'); // does not exist
    const proxy = await withProxy(apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-1"}'));

    const result = await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'dan@x.com', '--body', 'b'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_HOST_CORRELATION_FILE: active,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing GWS request without an exact active host correlation');
    expect(readLedger(ledger)).toEqual([]);
  });

  it('appends NO record for a non-api-effect (help/schema) response', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Exit-Code': '0',
        'X-GWS-Api-Effect': 'false',
        'X-GWS-Operation-Succeeded': 'true',
        'X-GWS-Request-Class': 'help',
      });
      res.end('help text');
    });

    const result = await runShim(['gmail', 'users', 'drafts', 'create', '--help'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
    });
    expect(result.status).toBe(0);
    expect(readLedger(ledger)).toEqual([]);
  });

  it('appends NO record for a denied (403) or failed command', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const proxy = await withProxy((_req, res, body) => {
      echoResolvedAccount(res, body);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('The admin has restricted this');
    });

    const result = await runShim(['gmail', '+send', '--to', 'x@y.com'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
    });
    expect(result.status).toBe(1);
    expect(readLedger(ledger)).toEqual([]);
  });

  it('proves a TRUE atomic append: two concurrent appenders BOTH land their lines', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const proxyA = await withProxy(apiEffectSuccessProxy('Draft A', 'SIGA', '{"audit_id":"aud-A"}', 'aud-A'));
    const proxyB = await withProxy(apiEffectSuccessProxy('Draft B', 'SIGB', '{"audit_id":"aud-B"}', 'aud-B'));

    // Two shim invocations racing to append to the SAME ledger file. With a
    // temp+rename strategy one would clobber the other; a true O_APPEND/>> keeps
    // both lines.
    await Promise.all([
      runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'b'], {
        GWS_PROXY_URL: proxyA.url,
        NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      }),
      runShim(['gmail', 'users', 'drafts', 'create', '--to', 'b@x.com', '--body', 'b'], {
        GWS_PROXY_URL: proxyB.url,
        NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      }),
    ]);

    const rows = readLedger(ledger);
    const ids = rows.map((r) => r.audit_id).sort();
    expect(ids).toEqual(['aud-A', 'aud-B']);
  });

  it('emits a partial-success error (audit id, no raw body) when the append fails after API success', async () => {
    tmp = freshTmp();
    // Point the ledger at a directory so the append fails AFTER the API success.
    const ledgerDir = path.join(tmp, 'ledger-as-dir');
    fs.mkdirSync(ledgerDir);
    const proxy = await withProxy(apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-1"}'));

    const result = await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'SECRETBODY'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledgerDir,
    });

    // Not ordinary success: a structured partial-success/recoverable error.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('aud-1');
    // No raw body leaks into the error.
    expect(result.stderr).not.toContain('SECRETBODY');
  });

  it('keeps exact host acceptance correlation even when message receipt was more than six hours earlier', async () => {
    tmp = freshTmp();
    const freshLedger = path.join(tmp, 'fresh.jsonl');
    const freshActive = path.join(tmp, 'fresh-active.json');
    fs.writeFileSync(
      freshActive,
      JSON.stringify({
        schemaVersion: 1,
        inputId: 'in-fresh',
        routeKey: 'discord:1',
        acceptedAt: freshUpdatedAt(),
      }),
    );
    const proxyFresh = await withProxy(apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-1"}'));
    await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'b'], {
      GWS_PROXY_URL: proxyFresh.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: freshLedger,
      NANOCLAW_HOST_CORRELATION_FILE: freshActive,
    });
    const freshRows = readLedger(freshLedger);
    expect(freshRows.length).toBe(1);
    expect(freshRows[0].input_id).toBe('in-fresh');
    expect(freshRows[0].route_key).toBe('discord:1');

    // Receipt age is irrelevant once the host has atomically accepted this
    // exact input. This catches the former six-hour fail-open/drop behavior.
    const staleLedger = path.join(tmp, 'stale.jsonl');
    const staleActive = path.join(tmp, 'stale-active.json');
    fs.writeFileSync(
      staleActive,
      JSON.stringify({
        schemaVersion: 1,
        inputId: 'in-old',
        routeKey: 'discord:9',
        receivedAt: '2020-01-01T00:00:00.000Z',
        acceptedAt: freshUpdatedAt(),
      }),
    );
    let captured = '';
    const proxyStale = await withProxy((_req, res, body) => {
      captured = body;
      echoResolvedAccount(res, body);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Exit-Code': '0',
        'X-GWS-Api-Effect': 'true',
        'X-GWS-Operation-Succeeded': 'true',
        'X-GWS-Audit-Id': 'aud-1',
        'X-GWS-Side-Effect-Signature': 'SIG',
        'X-GWS-Side-Effect-Payload': '{"audit_id":"aud-1"}',
      });
      res.end('Draft created: r-2');
    });
    await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'b'], {
      GWS_PROXY_URL: proxyStale.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: staleLedger,
      NANOCLAW_HOST_CORRELATION_FILE: staleActive,
    });
    const staleRows = readLedger(staleLedger);
    expect(staleRows.length).toBe(1);
    expect(staleRows[0].input_id).toBe('in-old');
    expect(staleRows[0].route_key).toBe('discord:9');
    const parsed = JSON.parse(captured) as { input_id?: string; route_key?: string };
    expect(parsed.input_id).toBe('in-old');
    expect(parsed.route_key).toBe('discord:9');
  });

  it('routes a record-builder failure through the exit-75 partial-success path (audit id, no body)', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const proxy = await withProxy(
      apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-77"}', 'aud-77'),
    );

    // Make ONLY the record-builder `node -e` invocation fail, while earlier
    // parse/request-body helpers succeed. The record-build failure lands AFTER
    // the API mutation succeeded, so the shim must take the recoverable exit-75
    // partial-success path (audit id, no raw body) rather than aborting with a
    // bare generic failure under set -e.
    const realNode = process.execPath;
    const fakeBin = path.join(tmp, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const counterFile = path.join(tmp, 'node-calls');
    const fakeNode = path.join(fakeBin, 'node');
    fs.writeFileSync(
      fakeNode,
      [
        '#!/bin/sh',
        `n=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
        'n=$((n + 1))',
        `printf '%s' "$n" > "${counterFile}"`,
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "-e" ] && printf "%s" "$arg" | grep -q "gmail_draft_created"; then',
        '    echo "record-builder boom" >&2',
        '    exit 1',
        '  fi',
        '  prev="$arg"',
        'done',
        `exec "${realNode}" "$@"`,
        '',
      ].join('\n'),
    );
    fs.chmodSync(fakeNode, 0o755);

    const result = await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'SECRETBODY'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('aud-77');
    expect(result.stderr).not.toContain('SECRETBODY');
    // No half-written record landed in the ledger.
    expect(readLedger(ledger)).toEqual([]);
  });

  it('fails closed without concatenating onto an incomplete pre-existing JSONL tail', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const partial = '{"audit_id":"prior-incomplete"';
    fs.writeFileSync(ledger, partial);
    const proxy = await withProxy(
      apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-after-partial"}', 'aud-after-partial'),
    );
    const result = await runShim(['gmail', 'users', 'drafts', 'create'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('durable side-effect ledger append failed');
    expect(fs.readFileSync(ledger, 'utf8')).toBe(partial);
  });

  it('does not write a record when NANOCLAW_SIDE_EFFECT_LEDGER is unset', async () => {
    tmp = freshTmp();
    const proxy = await withProxy(apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-1"}'));
    const result = await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'b'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: undefined,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Draft created: r-1');
  });
});
