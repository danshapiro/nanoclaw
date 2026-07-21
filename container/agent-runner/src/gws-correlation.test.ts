import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import {
  bindHostGwsCorrelation,
  canonicalGwsCorrelationAuthPayload,
  connectGwsCorrelationControlSocket,
  GwsCorrelationLifecycleFault,
  initializeGwsCorrelationLaunchControl,
} from './gws-correlation.js';

const tempRoots: string[] = [];

afterEach(() => {
  delete process.env.NANOCLAW_GWS_CORRELATION_IPC_ROOT;
  delete process.env.NANOCLAW_HOST_CORRELATION_FILE;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const framed = Buffer.alloc(4 + payload.length);
  framed.writeUInt32BE(payload.length, 0);
  payload.copy(framed, 4);
  return framed;
}

describe('GWS correlation lifecycle faults', () => {
  it('classifies a lost bind response as fatal when the exact host pointer proves commit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-correlation-response-loss-'));
    tempRoots.push(root);
    const socketName = 'lease.sock';
    const currentFile = path.join(root, 'current.json');
    process.env.NANOCLAW_GWS_CORRELATION_IPC_ROOT = root;
    process.env.NANOCLAW_HOST_CORRELATION_FILE = currentFile;

    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (buffered.length < length + 4) return;
          const request = JSON.parse(buffered.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
          buffered = buffered.subarray(length + 4);
          if (request.action === 'hello') {
            socket.write(frame({ schemaVersion: 1, ok: true, action: 'hello' }));
            continue;
          }
          if (request.action === 'bind') {
            fs.writeFileSync(
              currentFile,
              JSON.stringify({
                schemaVersion: 1,
                requestId: request.requestId,
                sessionId: request.sessionId,
                inputId: request.inputId,
                routeKey: request.routeKey,
                acceptedAt: request.originalAcceptedAt,
                messageIds: request.messageIds,
                leaseId: request.leaseId,
              }),
            );
            // Simulate the only ambiguous window: the host commit and pointer
            // publication succeeded, then the authenticated response vanished.
            socket.destroy();
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(root, socketName), resolve);
    });

    initializeGwsCorrelationLaunchControl({
      schemaVersion: 1,
      agentGroupId: 'ag-test',
      sessionId: 'sess-test',
      providerName: 'codex',
      leaseId: 'lease-test',
      issuedAt: '2026-07-21T00:00:00.000Z',
      secret: Buffer.alloc(32, 7).toString('base64url'),
      socketName,
    });
    try {
      await connectGwsCorrelationControlSocket();
      await expect(
        bindHostGwsCorrelation('input-test', 'route-test', ['m-2', 'm-1'], 'claim-test', 'initial'),
      ).rejects.toBeInstanceOf(GwsCorrelationLifecycleFault);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('GWS correlation authentication contract', () => {
  it('serializes the host protocol tuple in the fixed cross-boundary order', () => {
    const payload = canonicalGwsCorrelationAuthPayload({
      schemaVersion: 2,
      action: 'bind',
      requestId: '11111111-1111-4111-8111-111111111111',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      providerName: 'opencode',
      leaseId: 'lease-1',
      claimToken: 'claim-1',
      sequence: 4,
      providerAcceptance: {
        event: 'input-accepted',
        scope: 'followup',
        acceptedAt: '2026-05-29T00:00:02.000Z',
      },
      originalAcceptedAt: '2026-05-29T00:00:01.000Z',
      inputId: 'in-1',
      routeKey: 'opencode|discord|chan-1|dm:mg-1',
      messageIds: ['m-2', 'm-1'],
      mac: '',
    });
    expect(payload).toBe(
      '["nanoclaw-gws-correlation-v2","bind","11111111-1111-4111-8111-111111111111","ag-1","sess-1","opencode","lease-1","claim-1",4,"in-1","opencode|discord|chan-1|dm:mg-1",["m-1","m-2"],"2026-05-29T00:00:01.000Z","input-accepted","followup","2026-05-29T00:00:02.000Z"]',
    );
  });
});
