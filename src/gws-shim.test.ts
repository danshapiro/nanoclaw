import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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

// A fresh active-input updatedAt: the poll loop refreshes this on every
// input-accepted, so a normal in-turn tool call always sees a recent value. The
// shim drops correlation when updatedAt is stale (older than
// NANOCLAW_ACTIVE_INPUT_MAX_AGE_MS, default 6h), so tests that assert the
// CORRELATED path must stamp a current timestamp.
function freshUpdatedAt(): string {
  return new Date().toISOString();
}

function apiEffectSuccessProxy(body: string, sig: string, payload: string, auditId = 'aud-1') {
  return (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-Exit-Code': '0',
      'X-GWS-Audit-Id': auditId,
      'X-GWS-Request-Class': 'api',
      'X-GWS-Api-Effect': 'true',
      'X-GWS-Operation-Succeeded': 'true',
      'X-GWS-Side-Effect-Signature': sig,
      'X-GWS-Side-Effect-Payload': payload,
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

  it('appends one sanitized gmail_draft_created record (sig+payload verbatim) before stdout on success+api-effect', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const active = path.join(tmp, 'active-input.json');
    fs.writeFileSync(active, JSON.stringify({ inputId: 'in-9', routeKey: 'discord:7', updatedAt: freshUpdatedAt() }));
    const sig = 'BASE64SIGNATURE==';
    const payload = '{"audit_id":"aud-1","service":"gmail","method":"users.drafts.create"}';
    const proxy = await withProxy(apiEffectSuccessProxy('Draft created: r-987654', sig, payload));

    const result = await runShim(
      ['gmail', 'users', 'drafts', 'create', '--to', 'dan@x.com', '--subject', 's', '--body', 'b'],
      {
        GWS_PROXY_URL: proxy.url,
        NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
        NANOCLAW_ACTIVE_INPUT_FILE: active,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Draft created: r-987654');

    const rows = readLedger(ledger);
    expect(rows.length).toBe(1);
    const rec = rows[0];
    expect(rec.kind).toBe('gmail_draft_created');
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

  it('also sends inputId/routeKey in the POST body', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const active = path.join(tmp, 'active-input.json');
    fs.writeFileSync(active, JSON.stringify({ inputId: 'in-9', routeKey: 'discord:7', updatedAt: freshUpdatedAt() }));
    let captured = '';
    const proxy = await withProxy((_req, res, body) => {
      captured = body;
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
      NANOCLAW_ACTIVE_INPUT_FILE: active,
    });

    const parsed = JSON.parse(captured) as { args: string[]; input_id?: string; route_key?: string };
    expect(parsed.input_id).toBe('in-9');
    expect(parsed.route_key).toBe('discord:7');
  });

  it('writes an uncorrelated diagnostic record when .active-input.json is absent', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const active = path.join(tmp, 'missing-active-input.json'); // does not exist
    const proxy = await withProxy(apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-1"}'));

    await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'dan@x.com', '--body', 'b'], {
      GWS_PROXY_URL: proxy.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: ledger,
      NANOCLAW_ACTIVE_INPUT_FILE: active,
    });

    const rows = readLedger(ledger);
    expect(rows.length).toBe(1);
    // Absent active-input ⇒ no input correlation (uncorrelated diagnostic record).
    expect(rows[0].input_id ?? null).toBeNull();
    expect(rows[0].kind).toBe('gmail_draft_created');
  });

  it('appends NO record for a non-api-effect (help/schema) response', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const proxy = await withProxy((_req, res) => {
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
    const proxy = await withProxy((_req, res) => {
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

  it('correlates with a FRESH active-input updatedAt but drops correlation when it is stale-by-timestamp', async () => {
    // Fresh updatedAt ⇒ correlated (input_id/route_key stamped).
    tmp = freshTmp();
    const freshLedger = path.join(tmp, 'fresh.jsonl');
    const freshActive = path.join(tmp, 'fresh-active.json');
    fs.writeFileSync(
      freshActive,
      JSON.stringify({ inputId: 'in-fresh', routeKey: 'discord:1', updatedAt: freshUpdatedAt() }),
    );
    const proxyFresh = await withProxy(apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-1"}'));
    await runShim(['gmail', 'users', 'drafts', 'create', '--to', 'a@x.com', '--body', 'b'], {
      GWS_PROXY_URL: proxyFresh.url,
      NANOCLAW_SIDE_EFFECT_LEDGER: freshLedger,
      NANOCLAW_ACTIVE_INPUT_FILE: freshActive,
    });
    const freshRows = readLedger(freshLedger);
    expect(freshRows.length).toBe(1);
    expect(freshRows[0].input_id).toBe('in-fresh');
    expect(freshRows[0].route_key).toBe('discord:1');

    // Very old updatedAt ⇒ stale ⇒ uncorrelated (null input_id/route_key),
    // even though the file is present and parseable. A stale-but-present hint
    // from a long-dead turn must never mis-stamp a fresh tool call.
    const staleLedger = path.join(tmp, 'stale.jsonl');
    const staleActive = path.join(tmp, 'stale-active.json');
    fs.writeFileSync(
      staleActive,
      JSON.stringify({ inputId: 'in-old', routeKey: 'discord:9', updatedAt: '2020-01-01T00:00:00.000Z' }),
    );
    let captured = '';
    const proxyStale = await withProxy((_req, res, body) => {
      captured = body;
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
      NANOCLAW_ACTIVE_INPUT_FILE: staleActive,
    });
    const staleRows = readLedger(staleLedger);
    expect(staleRows.length).toBe(1);
    // Stale ⇒ uncorrelated diagnostic record (no input/route correlation)…
    expect(staleRows[0].input_id ?? null).toBeNull();
    expect(staleRows[0].route_key ?? null).toBeNull();
    // …and the stale correlation is not forwarded to the proxy audit store either.
    const parsed = JSON.parse(captured) as { input_id?: string; route_key?: string };
    expect(parsed.input_id ?? null).toBeNull();
    expect(parsed.route_key ?? null).toBeNull();
  });

  it('routes a record-builder failure through the exit-75 partial-success path (audit id, no body)', async () => {
    tmp = freshTmp();
    const ledger = path.join(tmp, 'side-effects.jsonl');
    const proxy = await withProxy(
      apiEffectSuccessProxy('Draft created: r-1', 'SIG', '{"audit_id":"aud-77"}', 'aud-77'),
    );

    // Make ONLY the SECOND `node` invocation (the record-builder) fail, while the
    // first (the request-body builder, which runs BEFORE the API call) succeeds.
    // A counting fake `node` on PATH does this: invocation 1 delegates to the
    // real node, invocation 2 exits non-zero. The record-build failure lands
    // AFTER the API mutation succeeded, so the shim must take the recoverable
    // exit-75 partial-success path (audit id, no raw body) rather than aborting
    // with a bare generic failure under set -e.
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
        'if [ "$n" -ge 2 ]; then echo "record-builder boom" >&2; exit 1; fi',
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
