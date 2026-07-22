import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveGwsFinalizationConfig, sealAndDrainGwsCorrelation } from './gws-finalization.js';

const sockets: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(sockets.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function controlServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<{ socketPath: string; tokenPath: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-finalization-'));
  roots.push(root);
  fs.chmodSync(root, 0o710);
  const socketPath = path.join(root, 'control.sock');
  const tokenPath = path.join(root, 'gws-finalize-token');
  fs.writeFileSync(tokenPath, 'test-finalization-token-0123456789abcdef\n', { mode: 0o400 });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => handler(request, response, body));
  });
  sockets.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o660);
  return { socketPath, tokenPath };
}

describe('sealAndDrainGwsCorrelation', () => {
  it('resolves the explicit service paths and the systemd credential-directory fallback', () => {
    expect(
      resolveGwsFinalizationConfig({
        GWS_CONTROL_SOCKET: '/srv/gws-proxy/control/control.sock',
        GWS_FINALIZE_TOKEN_FILE: '/run/credentials/nanoclaw.service/custom-token',
      }),
    ).toEqual({
      socketPath: '/srv/gws-proxy/control/control.sock',
      tokenFile: '/run/credentials/nanoclaw.service/custom-token',
    });
    expect(
      resolveGwsFinalizationConfig({
        GWS_CONTROL_SOCKET: '/srv/gws-proxy/control/control.sock',
        CREDENTIALS_DIRECTORY: '/run/credentials/nanoclaw.service',
      }),
    ).toEqual({
      socketPath: '/srv/gws-proxy/control/control.sock',
      tokenFile: '/run/credentials/nanoclaw.service/gws-finalize-token',
      credentialDirectory: '/run/credentials/nanoclaw.service',
    });
  });

  it('authenticates and requires an exact sealed-and-drained receipt', async () => {
    const inputId = 'in-host-finalize';
    const routeKey = 'codex|discord|chan-1|dm:mg-1';
    const control = await controlServer((request, response, body) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/correlations/seal-and-drain');
      expect(request.headers.authorization).toBe('Bearer test-finalization-token-0123456789abcdef');
      expect(request.headers['content-type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual({ input_id: inputId, route_key: routeKey });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ input_id: inputId, route_key: routeKey, sealed: true, drained: true }));
    });

    await expect(
      sealAndDrainGwsCorrelation({
        inputId,
        routeKey,
        socketPath: control.socketPath,
        tokenFile: control.tokenPath,
      }),
    ).resolves.toEqual({ inputId, routeKey, sealed: true, drained: true });
  });

  it('accepts systemd credential mode 0440 only from its protected credential directory', async () => {
    const inputId = 'in-systemd-finalize';
    const routeKey = 'codex|discord|chan-systemd|dm:mg-systemd';
    const control = await controlServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ input_id: inputId, route_key: routeKey, sealed: true, drained: true }));
    });
    const credentialDirectory = path.join(path.dirname(control.tokenPath), 'credentials');
    fs.mkdirSync(credentialDirectory, { mode: 0o750 });
    const systemdTokenPath = path.join(credentialDirectory, 'gws-finalize-token');
    fs.renameSync(control.tokenPath, systemdTokenPath);
    fs.chmodSync(systemdTokenPath, 0o440);

    await expect(
      sealAndDrainGwsCorrelation({
        inputId,
        routeKey,
        socketPath: control.socketPath,
        tokenFile: systemdTokenPath,
        credentialDirectory,
      }),
    ).resolves.toEqual({ inputId, routeKey, sealed: true, drained: true });

    await expect(
      sealAndDrainGwsCorrelation({
        inputId,
        routeKey,
        socketPath: control.socketPath,
        tokenFile: systemdTokenPath,
      }),
    ).rejects.toThrow(/credential|permission|mode/i);
  });

  it.each([
    ['wrong tuple', 200, { input_id: 'other', route_key: 'other', sealed: true, drained: true }],
    ['not drained', 200, { input_id: 'in-host-finalize', route_key: 'route', sealed: true, drained: false }],
    ['server error', 503, { error: 'drain unavailable' }],
  ])('fails closed on a %s response', async (_label, status, receipt) => {
    const control = await controlServer((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(receipt));
    });
    await expect(
      sealAndDrainGwsCorrelation({
        inputId: 'in-host-finalize',
        routeKey: 'route',
        socketPath: control.socketPath,
        tokenFile: control.tokenPath,
      }),
    ).rejects.toThrow(/seal|drain|receipt|503/i);
  });

  it('enforces a total deadline even while a response is still trickling', async () => {
    const control = await controlServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const trickle = setInterval(() => response.write(' '), 5);
      response.once('close', () => clearInterval(trickle));
    });
    await expect(
      sealAndDrainGwsCorrelation({
        inputId: 'in-host-finalize',
        routeKey: 'route',
        socketPath: control.socketPath,
        tokenFile: control.tokenPath,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('rejects JSON-like but non-JSON receipt media types', async () => {
    const control = await controlServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json-sequence' });
      response.end(JSON.stringify({ input_id: 'in-host-finalize', route_key: 'route', sealed: true, drained: true }));
    });
    await expect(
      sealAndDrainGwsCorrelation({
        inputId: 'in-host-finalize',
        routeKey: 'route',
        socketPath: control.socketPath,
        tokenFile: control.tokenPath,
      }),
    ).rejects.toThrow(/non-JSON/i);
  });

  it('rejects a symlinked or broadly-readable credential before connecting', async () => {
    const control = await controlServer((_request, response) => {
      response.writeHead(500);
      response.end();
    });
    const symlink = path.join(path.dirname(control.tokenPath), 'token-link');
    fs.symlinkSync(control.tokenPath, symlink);
    await expect(
      sealAndDrainGwsCorrelation({
        inputId: 'in-host-finalize',
        routeKey: 'route',
        socketPath: control.socketPath,
        tokenFile: symlink,
      }),
    ).rejects.toThrow(/credential|symlink|regular/i);

    fs.chmodSync(control.tokenPath, 0o444);
    await expect(
      sealAndDrainGwsCorrelation({
        inputId: 'in-host-finalize',
        routeKey: 'route',
        socketPath: control.socketPath,
        tokenFile: control.tokenPath,
      }),
    ).rejects.toThrow(/credential|permission|mode/i);
  });

  it('rejects a control socket that does not have the exact host-service mode', async () => {
    const control = await controlServer((_request, response) => {
      response.writeHead(500);
      response.end();
    });
    fs.chmodSync(control.socketPath, 0o600);
    await expect(
      sealAndDrainGwsCorrelation({
        inputId: 'in-host-finalize',
        routeKey: 'route',
        socketPath: control.socketPath,
        tokenFile: control.tokenPath,
      }),
    ).rejects.toThrow(/socket|0660|host-service/i);
  });
});
