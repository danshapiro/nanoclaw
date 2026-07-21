import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHmac } from 'crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindAcceptedGwsCorrelation,
  canonicalGwsCorrelationAuthPayload,
  processAuthenticatedGwsCorrelationRequest,
  registerGwsCorrelationLaunchLease,
  unregisterGwsCorrelationLaunchLease,
  type AuthenticatedGwsCorrelationRequest,
  type GwsCorrelationLaunchControl,
} from './gws-correlation-ipc.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './db/schema.js';

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
  let control: GwsCorrelationLaunchControl;

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
    unregisterGwsCorrelationLaunchLease(groupId, sessionId);
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

  it('invalidates the old lease on respawn', () => {
    const oldRequest = request();
    control = registerGwsCorrelationLaunchLease({
      agentGroupId: groupId,
      sessionId,
      providerName: 'opencode',
      issuedAt,
      secret: Buffer.alloc(32, 8),
      leaseId: 'lease-host-issued-2',
    });
    expect(() => process(oldRequest)).toThrow(/lease|auth|mac/i);
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
