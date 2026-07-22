import fs from 'fs';
import os from 'os';
import path from 'path';
import net, { type Socket } from 'net';
import { createHmac } from 'crypto';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bindAcceptedGwsCorrelation,
  canonicalGwsCorrelationAuthPayload,
  DEFAULT_GWS_CORRELATION_IPC_ROOT,
  expireAllStaleGwsCorrelations,
  hostGwsCorrelationIpcDir,
  processAuthenticatedGwsCorrelationRequest,
  registerGwsCorrelationLaunchLease,
  setGwsCorrelationIpcRootForTests,
  type AuthenticatedGwsCorrelationRequest,
  type GwsCorrelationLaunchControl,
  type RegisteredGwsCorrelationLaunchControl,
} from './gws-correlation-ipc.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from './db/index.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './db/schema.js';
import { hostCorrelationPath, inboundDbPath, outboundDbPath, sessionDir } from './session-manager.js';

const testIpcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-correlation-ipc-root-'));

beforeAll(() => setGwsCorrelationIpcRootForTests(testIpcRoot));
afterAll(() => {
  setGwsCorrelationIpcRootForTests(DEFAULT_GWS_CORRELATION_IPC_ROOT);
  fs.rmSync(testIpcRoot, { recursive: true, force: true });
});

it('keeps production sockets outside systemd PrivateTmp', () => {
  expect(DEFAULT_GWS_CORRELATION_IPC_ROOT).toBe('/run/nanoclaw-gws-correlation');
});

function socketFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function connectSocket(socketPath: string): Promise<Socket> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const socket = net.createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      return socket;
    } catch (err) {
      socket.destroy();
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function authenticateSocket(control: GwsCorrelationLaunchControl): Promise<Socket> {
  const socketPath = path.join(hostGwsCorrelationIpcDir(control.agentGroupId, control.sessionId), control.socketName);
  const socket = await connectSocket(socketPath);
  const mac = createHmac('sha256', Buffer.from(control.secret, 'base64url'))
    .update(
      JSON.stringify([
        'nanoclaw-gws-correlation-v2',
        'hello',
        control.agentGroupId,
        control.sessionId,
        control.leaseId,
      ]),
    )
    .digest('base64url');
  socket.write(
    socketFrame({
      schemaVersion: 1,
      action: 'hello',
      agentGroupId: control.agentGroupId,
      sessionId: control.sessionId,
      leaseId: control.leaseId,
      mac,
    }),
  );
  const response = await readSocketFrame(socket);
  expect(response).toMatchObject({ schemaVersion: 1, ok: true, action: 'hello' });
  return socket;
}

async function readSocketFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('socket closed before response'));
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('socket response timed out'));
    }, 1_000);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

describe('host-owned accepted GWS correlation', () => {
  let root: string;
  let dbPath: string;
  let correlationPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-correlation-'));
    dbPath = path.join(root, 'inbound.db');
    correlationPath = path.join(root, 'host-correlation', 'current.json');
    const db = new Database(dbPath);
    db.exec(INBOUND_SCHEMA);
    db.close();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('atomically advances from the exact first accepted input to a message received during that turn', () => {
    const routeKey = 'opencode|discord|chan-1|dm:mg-1';
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at)
       VALUES (?, ?, 'chat', ?, '{}', 1, ?, ?, ?)`,
    ).run('m-first', 2, '2026-05-29T00:00:00.000Z', 'in-first', routeKey, '2026-05-29T00:00:00.000Z');
    db.close();

    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-first',
      routeKey,
      messageIds: ['m-first'],
      acceptedAt: '2026-05-29T00:00:01.000Z',
    });
    expect(JSON.parse(fs.readFileSync(correlationPath, 'utf8'))).toMatchObject({
      inputId: 'in-first',
      routeKey,
      acceptedAt: '2026-05-29T00:00:01.000Z',
    });

    // Receipt during the first accepted claim must not change current
    // correlation. It advances only when the second input is accepted, even
    // though that happens more than six hours after receipt.
    const later = new Database(dbPath);
    later
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at)
         VALUES (?, ?, 'chat', ?, '{}', 1, ?, ?, ?)`,
      )
      .run('m-second', 4, '2026-05-29T00:05:00.000Z', 'in-second', routeKey, '2026-05-29T00:05:00.000Z');
    later.close();
    expect(JSON.parse(fs.readFileSync(correlationPath, 'utf8')).inputId).toBe('in-first');

    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-second',
      routeKey,
      messageIds: ['m-second'],
      acceptedAt: '2026-05-29T07:05:01.000Z',
    });
    expect(JSON.parse(fs.readFileSync(correlationPath, 'utf8'))).toMatchObject({
      inputId: 'in-second',
      routeKey,
      acceptedAt: '2026-05-29T07:05:01.000Z',
    });

    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare('SELECT id, host_accepted_input_id FROM messages_in ORDER BY seq').all()).toEqual([
      { id: 'm-first', host_accepted_input_id: 'in-first' },
      { id: 'm-second', host_accepted_input_id: 'in-second' },
    ]);
    verify.close();
  });

  it('rejects a stale or mismatched selector and preserves the current trusted correlation', () => {
    const routeKey = 'opencode|discord|chan-1|dm:mg-1';
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at)
       VALUES (?, ?, 'chat', ?, '{}', 1, ?, ?, ?)`,
    ).run('m-right', 2, '2026-05-29T00:00:00.000Z', 'in-right', routeKey, '2026-05-29T00:00:00.000Z');
    db.close();

    expect(() =>
      bindAcceptedGwsCorrelation({
        dbPath,
        correlationPath,
        sessionId: 'sess-1',
        inputId: 'in-stale',
        routeKey,
        messageIds: ['m-right'],
        acceptedAt: '2026-05-29T00:00:01.000Z',
      }),
    ).toThrow(/exact host input/i);
    expect(fs.existsSync(correlationPath)).toBe(false);
  });
});

describe('authenticated GWS correlation acceptance lease', () => {
  let root: string;
  let dbPath: string;
  let outDbPath: string;
  let correlationPath: string;
  const groupId = 'ag-auth';
  const sessionId = 'sess-auth';
  const routeKey = 'opencode|discord|chan-1|dm:mg-1';
  const issuedAt = '2026-05-29T00:00:00.000Z';
  const acceptedAt = '2026-05-29T00:00:01.000Z';
  let control: RegisteredGwsCorrelationLaunchControl;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-correlation-auth-'));
    dbPath = path.join(root, 'inbound.db');
    outDbPath = path.join(root, 'outbound.db');
    correlationPath = path.join(root, 'host-correlation', 'current.json');
    const db = new Database(dbPath);
    db.exec(INBOUND_SCHEMA);
    const insert = db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at)
       VALUES (?, ?, 'chat', ?, '{}', ?, ?, ?, ?)`,
    );
    insert.run('m-active', 1, issuedAt, 1, 'in-active', routeKey, issuedAt);
    insert.run('m-future', 2, '2026-05-29T00:00:02.000Z', 1, 'in-future', routeKey, '2026-05-29T00:00:02.000Z');
    db.close();
    const outDb = new Database(outDbPath);
    outDb.exec(OUTBOUND_SCHEMA);
    outDb
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed, claim_token) VALUES (?, 'processing', ?, ?)",
      )
      .run('m-active', issuedAt, 'claim-active');
    outDb.close();
    control = registerGwsCorrelationLaunchLease({
      agentGroupId: groupId,
      sessionId,
      providerName: 'opencode',
      issuedAt,
      secret: Buffer.alloc(32, 7),
      leaseId: 'lease-host-issued-1',
    });
  });

  afterEach(() => {
    control.revokeAfterConfirmedStop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function request(overrides: Record<string, unknown> = {}): AuthenticatedGwsCorrelationRequest {
    const unsigned = {
      schemaVersion: 2,
      action: 'bind',
      requestId: '11111111-1111-4111-8111-111111111111',
      agentGroupId: groupId,
      sessionId,
      providerName: control.providerName,
      leaseId: control.leaseId,
      claimToken: 'claim-active',
      sequence: 1,
      providerAcceptance: { event: 'input-accepted', scope: 'initial', acceptedAt },
      originalAcceptedAt: acceptedAt,
      inputId: 'in-active',
      routeKey,
      messageIds: ['m-active'],
      mac: '',
      ...overrides,
    } as AuthenticatedGwsCorrelationRequest;
    unsigned.mac = createHmac('sha256', Buffer.from(control.secret, 'base64url'))
      .update(canonicalGwsCorrelationAuthPayload(unsigned))
      .digest('base64url');
    return unsigned;
  }

  function process(requestValue: AuthenticatedGwsCorrelationRequest): void {
    processAuthenticatedGwsCorrelationRequest({
      agentGroupId: groupId,
      mountedSessionId: sessionId,
      dbPath,
      outDbPath,
      correlationPath,
      request: requestValue,
      now: '2026-05-29T00:00:01.100Z',
    });
  }

  it('rejects a direct forged inbox request and a forged future-pending batch', () => {
    const forged = request();
    forged.mac = 'agent-forged';
    expect(() => process(forged)).toThrow(/auth|mac/i);

    const future = request({
      requestId: '22222222-2222-4222-8222-222222222222',
      inputId: 'in-future',
      messageIds: ['m-future'],
      providerAcceptance: {
        event: 'input-accepted',
        scope: 'followup',
        acceptedAt: '2026-05-29T00:00:02.100Z',
      },
      originalAcceptedAt: '2026-05-29T00:00:02.100Z',
    });
    expect(() => process(future)).toThrow(/processing claim|claim token/i);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT host_accepted_input_id FROM messages_in WHERE id = ?').get('m-future')).toEqual({
      host_accepted_input_id: null,
    });
    db.close();
  });

  it('refuses to replace a lease before confirmed stop', () => {
    expect(() =>
      registerGwsCorrelationLaunchLease({
        agentGroupId: groupId,
        sessionId,
        providerName: 'opencode',
        issuedAt,
        secret: Buffer.alloc(32, 8),
        leaseId: 'lease-host-issued-2',
      }),
    ).toThrow(/still active|confirm container stop/i);
    control.revokeAfterConfirmedStop();
    control = registerGwsCorrelationLaunchLease({
      agentGroupId: groupId,
      sessionId,
      providerName: 'opencode',
      issuedAt,
      secret: Buffer.alloc(32, 8),
      leaseId: 'lease-host-issued-2',
    });
  });

  it('accepts one legitimate queued batch exactly once and never rewrites original accepted_at on replay', () => {
    const legitimate = request();
    expect(canonicalGwsCorrelationAuthPayload(legitimate)).toBe(
      '["nanoclaw-gws-correlation-v2","bind","11111111-1111-4111-8111-111111111111","ag-auth","sess-auth","opencode","lease-host-issued-1","claim-active",1,"in-active","opencode|discord|chan-1|dm:mg-1",["m-active"],"2026-05-29T00:00:01.000Z","input-accepted","initial","2026-05-29T00:00:01.000Z"]',
    );
    process(legitimate);
    const first = new Database(dbPath, { readonly: true });
    expect(
      first.prepare('SELECT host_accepted_input_id, host_accepted_at FROM messages_in WHERE id = ?').get('m-active'),
    ).toEqual({ host_accepted_input_id: 'in-active', host_accepted_at: acceptedAt });
    first.close();

    expect(() => process(legitimate)).toThrow(/replay|sequence|consumed/i);
    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare('SELECT host_accepted_at FROM messages_in WHERE id = ?').get('m-active')).toEqual({
      host_accepted_at: acceptedAt,
    });
    after.close();
  });

  it('releases only the exact last accepted claim and publishes an exact host receipt', () => {
    process(request());
    const release = request({
      action: 'release',
      requestId: '33333333-3333-4333-8333-333333333333',
      sequence: 2,
      releasedAt: '2026-05-29T00:00:01.050Z',
    });
    process(release);

    expect(fs.existsSync(correlationPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(correlationPath), 'last-request.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      requestId: release.requestId,
      action: 'release',
      inputId: 'in-active',
    });
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT host_acceptance_ended_at FROM messages_in WHERE id = ?').get('m-active')).toEqual({
      host_acceptance_ended_at: '2026-05-29T00:00:01.050Z',
    });
    db.close();

    expect(() => process(release)).toThrow(/replay|sequence|consumed/i);
  });
});

describe('bounded GWS correlation socket transport', () => {
  const controls: RegisteredGwsCorrelationLaunchControl[] = [];
  const sockets: Socket[] = [];
  const createdSessions: string[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const control of controls.splice(0)) {
      control.revokeAfterConfirmedStop();
    }
    closeDb();
    for (const dir of createdSessions.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function register(group: string, session: string): RegisteredGwsCorrelationLaunchControl {
    const control = registerGwsCorrelationLaunchLease({
      agentGroupId: group,
      sessionId: session,
      providerName: 'opencode',
      secret: Buffer.alloc(32, controls.length + 11),
    });
    controls.push(control);
    return control;
  }

  it('isolates sessions under forged, oversize, and slow-client pressure without creating request files', async () => {
    const flooded = register('ag-socket-a', 'sess-socket-a');
    const healthy = register('ag-socket-b', 'sess-socket-b');
    const floodedPath = path.join(
      hostGwsCorrelationIpcDir(flooded.agentGroupId, flooded.sessionId),
      flooded.socketName,
    );

    const forged = await connectSocket(floodedPath);
    sockets.push(forged);
    forged.write(socketFrame({ schemaVersion: 1, action: 'hello', mac: 'forged' }));

    const oversize = await connectSocket(floodedPath);
    sockets.push(oversize);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(64 * 1024 + 1, 0);
    oversize.write(header);

    // Occupy the bounded pre-auth capacity with absolute-deadline slow clients.
    for (let index = 0; index < 4; index++) {
      try {
        sockets.push(await connectSocket(floodedPath));
      } catch {
        // The bounded backlog may reject the last connection immediately.
      }
    }

    const started = Date.now();
    const healthySocket = await authenticateSocket(healthy);
    sockets.push(healthySocket);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      fs.existsSync(path.join(hostGwsCorrelationIpcDir(healthy.agentGroupId, healthy.sessionId), healthy.socketName)),
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const recovered = await authenticateSocket(flooded);
    sockets.push(recovered);
    const entries = fs.readdirSync(hostGwsCorrelationIpcDir(flooded.agentGroupId, flooded.sessionId));
    expect(entries).toEqual([]);
  }, 10_000);

  it('accepts a legitimate authenticated bind over the persistent socket without an inbox file', async () => {
    const groupId = `ag-socket-bind-${Date.now()}`;
    const sessionId = 'sess-socket-bind';
    const issuedAt = new Date(Date.now() - 100).toISOString();
    const central = initTestDb();
    runMigrations(central);
    createAgentGroup({
      id: groupId,
      name: 'Socket Bind Agent',
      folder: 'socket-bind-agent',
      agent_provider: 'opencode',
      created_at: issuedAt,
    });
    createSession({
      id: sessionId,
      agent_group_id: groupId,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'opencode',
      status: 'active',
      container_status: 'running',
      last_active: issuedAt,
      created_at: issuedAt,
    });

    const dir = sessionDir(groupId, sessionId);
    createdSessions.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    const inbound = new Database(inboundDbPath(groupId, sessionId));
    inbound.exec(INBOUND_SCHEMA);
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at)
         VALUES ('m-socket-bind', 1, 'chat', ?, '{}', 1, 'in-socket-bind', 'route-socket-bind', ?)`,
      )
      .run(issuedAt, issuedAt);
    inbound.close();
    const outbound = new Database(outboundDbPath(groupId, sessionId));
    outbound.exec(OUTBOUND_SCHEMA);
    outbound
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed, claim_token) VALUES ('m-socket-bind', 'processing', ?, 'claim-socket-bind')",
      )
      .run(issuedAt);
    outbound.close();

    const control = register(groupId, sessionId);
    const socket = await authenticateSocket(control);
    sockets.push(socket);
    const acceptedAt = new Date().toISOString();
    const request: AuthenticatedGwsCorrelationRequest = {
      schemaVersion: 2,
      action: 'bind',
      requestId: '44444444-4444-4444-8444-444444444444',
      agentGroupId: groupId,
      sessionId,
      providerName: control.providerName,
      leaseId: control.leaseId,
      claimToken: 'claim-socket-bind',
      sequence: 1,
      providerAcceptance: { event: 'input-accepted', scope: 'initial', acceptedAt },
      originalAcceptedAt: acceptedAt,
      inputId: 'in-socket-bind',
      routeKey: 'route-socket-bind',
      messageIds: ['m-socket-bind'],
      mac: '',
    };
    request.mac = createHmac('sha256', Buffer.from(control.secret, 'base64url'))
      .update(canonicalGwsCorrelationAuthPayload(request))
      .digest('base64url');
    socket.write(socketFrame(request));

    await expect(readSocketFrame(socket)).resolves.toMatchObject({
      schemaVersion: 1,
      ok: true,
      requestId: request.requestId,
    });
    expect(JSON.parse(fs.readFileSync(hostCorrelationPath(groupId, sessionId), 'utf8'))).toMatchObject({
      inputId: request.inputId,
      requestId: request.requestId,
      leaseId: control.leaseId,
    });
    expect(fs.readdirSync(hostGwsCorrelationIpcDir(groupId, sessionId))).toEqual([]);

    socket.destroy();
    await new Promise<void>((resolve) => socket.once('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Losing the runner's control fd must stop future binds, but it cannot end
    // the active execution interval while the owning container may still have
    // a GWS tool in flight. Only confirmed container stop may revoke it.
    expect(fs.existsSync(hostCorrelationPath(groupId, sessionId))).toBe(true);
    const stillOpen = new Database(inboundDbPath(groupId, sessionId), { readonly: true });
    expect(
      stillOpen.prepare("SELECT host_acceptance_ended_at FROM messages_in WHERE id = 'm-socket-bind'").get(),
    ).toEqual({
      host_acceptance_ended_at: null,
    });
    stillOpen.close();

    expect(control.revokeAfterConfirmedStop()).toBe(true);
    expect(fs.existsSync(hostCorrelationPath(groupId, sessionId))).toBe(false);
  });
});

describe('GWS acceptance lifecycle barriers', () => {
  const createdSessions: string[] = [];

  afterEach(() => {
    for (const dir of createdSessions.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function createAcceptedSession(groupId: string, sessionId: string, leaseId: string | null): string {
    const dir = sessionDir(groupId, sessionId);
    createdSessions.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = inboundDbPath(groupId, sessionId);
    const db = new Database(dbPath);
    db.exec(INBOUND_SCHEMA);
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at,
          host_accepted_input_id, host_accepted_route_key, host_accepted_at, host_acceptance_lease_id)
       VALUES ('m-life', 1, 'chat', ?, '{}', 1, 'in-life', 'route-life', ?,
               'in-life', 'route-life', ?, ?)`,
    ).run('2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:01.000Z', leaseId);
    db.close();
    return dbPath;
  }

  it('invalidates marker and pointer before expiring every row from a replaced lease', () => {
    const groupId = `ag-life-${Date.now()}`;
    const sessionId = 'sess-life';
    const leaseId = 'lease-life-old';
    const dbPath = createAcceptedSession(groupId, sessionId, leaseId);
    const control = registerGwsCorrelationLaunchLease({
      agentGroupId: groupId,
      sessionId,
      providerName: 'opencode',
      leaseId,
      secret: Buffer.alloc(32, 31),
    });
    const pointerPath = hostCorrelationPath(groupId, sessionId);
    fs.writeFileSync(pointerPath, JSON.stringify({ schemaVersion: 1, inputId: 'in-life', leaseId }));

    expect(control.revokeAfterConfirmedStop()).toBe(true);
    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(pointerPath), 'active-lease.json'))).toBe(false);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT host_acceptance_ended_at FROM messages_in WHERE id = 'm-life'").get() as {
      host_acceptance_ended_at: string | null;
    };
    expect(row.host_acceptance_ended_at).not.toBeNull();
    db.close();
  });

  it('startup expiry ends legacy/null-lease rows even when the pointer is missing', () => {
    const groupId = `ag-restart-${Date.now()}`;
    const sessionId = 'sess-restart';
    const dbPath = createAcceptedSession(groupId, sessionId, null);
    expireAllStaleGwsCorrelations('2026-07-21T00:00:02.000Z');
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT host_acceptance_ended_at FROM messages_in WHERE id = 'm-life'").get()).toEqual({
      host_acceptance_ended_at: '2026-07-21T00:00:02.000Z',
    });
    db.close();
  });
});
