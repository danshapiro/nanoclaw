import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bindAcceptedGwsCorrelation } from './gws-correlation-ipc.js';
import { INBOUND_SCHEMA } from './db/schema.js';

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
