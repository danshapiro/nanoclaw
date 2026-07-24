/**
 * Tests for the route_quarantine persistence accessors -- bounded quarantine
 * state for side-effect import failures, stored in the host-owned per-session
 * inbound DB. Runs against real SQLite files in tmpdirs.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearImportFailures,
  clearRouteQuarantine,
  isRouteQuarantined,
  markRouteQuarantined,
  recordImportFailure,
} from './route-quarantine.js';
import { INBOUND_SCHEMA } from './schema.js';
import { ensureSchema, openInboundDb } from './session-db.js';

const tmpDirs: string[] = [];
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freshInboundDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-route-quarantine-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'inbound.db');
  ensureSchema(dbPath, 'inbound');
  const db = openInboundDb(dbPath);
  openDbs.push(db);
  return db;
}

interface Row {
  route_key: string;
  consecutive_failures: number;
  last_error: string | null;
  quarantined_at: string | null;
  reason: string | null;
  updated_at: string;
}

function getRow(db: Database.Database, routeKey: string): Row | undefined {
  return db.prepare('SELECT * FROM route_quarantine WHERE route_key = ?').get(routeKey) as Row | undefined;
}

describe('route_quarantine persistence', () => {
  it('records a failure and reads it back', () => {
    const db = freshInboundDb();

    expect(recordImportFailure(db, 'route-a', 'boom')).toEqual({ action: 'track', consecutive: 1 });
    let row = getRow(db, 'route-a');
    expect(row).toBeDefined();
    expect(row!.consecutive_failures).toBe(1);
    expect(row!.last_error).toBe('boom');
    expect(row!.quarantined_at).toBeNull();

    // A repeat of the SAME error increments; a different route is untouched.
    expect(recordImportFailure(db, 'route-a', 'boom')).toEqual({ action: 'track', consecutive: 2 });
    row = getRow(db, 'route-a');
    expect(row!.consecutive_failures).toBe(2);
    expect(getRow(db, 'route-b')).toBeUndefined();
  });

  it('resets the counter on a successful import via clearImportFailures', () => {
    const db = freshInboundDb();
    recordImportFailure(db, 'route-a', 'boom');
    recordImportFailure(db, 'route-a', 'boom');

    clearImportFailures(db, 'route-a');
    const row = getRow(db, 'route-a');
    expect(row!.consecutive_failures).toBe(0);
    expect(row!.last_error).toBeNull();

    // The next failure starts a fresh streak at 1.
    expect(recordImportFailure(db, 'route-a', 'boom')).toEqual({ action: 'track', consecutive: 1 });
  });

  it('clearImportFailures on an untracked route is a safe no-op', () => {
    const db = freshInboundDb();
    expect(() => clearImportFailures(db, 'route-never-seen')).not.toThrow();
    expect(getRow(db, 'route-never-seen')).toBeUndefined();
  });

  it('marks a route quarantined and round-trips isRouteQuarantined', () => {
    const db = freshInboundDb();
    expect(isRouteQuarantined(db, 'route-a')).toBe(false);

    markRouteQuarantined(db, 'route-a', '5 consecutive identical import failures');
    expect(isRouteQuarantined(db, 'route-a')).toBe(true);
    expect(isRouteQuarantined(db, 'route-b')).toBe(false);

    const row = getRow(db, 'route-a');
    expect(row!.quarantined_at).not.toBeNull();
    expect(row!.reason).toBe('5 consecutive identical import failures');
  });

  it('quarantine survives clearImportFailures -- no automatic retry-out (NFR6)', () => {
    const db = freshInboundDb();
    recordImportFailure(db, 'route-a', 'boom');
    markRouteQuarantined(db, 'route-a', 'threshold reached');

    clearImportFailures(db, 'route-a');
    expect(isRouteQuarantined(db, 'route-a')).toBe(true);
  });

  it('clearRouteQuarantine is the explicit operator exit', () => {
    const db = freshInboundDb();
    recordImportFailure(db, 'route-a', 'boom');
    markRouteQuarantined(db, 'route-a', 'threshold reached');
    expect(isRouteQuarantined(db, 'route-a')).toBe(true);

    clearRouteQuarantine(db, 'route-a');
    expect(isRouteQuarantined(db, 'route-a')).toBe(false);
    const row = getRow(db, 'route-a');
    expect(row!.quarantined_at).toBeNull();
    expect(row!.reason).toBeNull();
    expect(row!.consecutive_failures).toBe(0);
    expect(row!.last_error).toBeNull();
  });

  it('openInboundDb migrates a pre-existing inbound DB that lacks route_quarantine', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-route-quarantine-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'inbound.db');

    // Simulate a legacy inbound DB created before the table existed.
    const legacy = new Database(dbPath);
    legacy.exec(INBOUND_SCHEMA);
    legacy.exec('DROP TABLE IF EXISTS route_quarantine');
    legacy.close();

    const db = openInboundDb(dbPath);
    openDbs.push(db);
    expect(recordImportFailure(db, 'route-a', 'boom')).toEqual({ action: 'track', consecutive: 1 });
    expect(isRouteQuarantined(db, 'route-a')).toBe(false);
  });
});
