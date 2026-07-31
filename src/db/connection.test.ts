import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from './connection.js';

describe('initDb pragmas', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-conn-test-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets WAL + explicit FULL sync + larger autocheckpoint + foreign keys', () => {
    const db = initDb(path.join(tmpDir, 'v2.db'));

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // synchronous: 2 = FULL — explicit and load-bearing (see the durability
    // note: scheduling-action replay is gated on session-DB acks written
    // AFTER the central apply; v2.db must stay at least as durable).
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(4000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
