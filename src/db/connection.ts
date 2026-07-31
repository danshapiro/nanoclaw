import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function isDbInitialized(): boolean {
  return _db !== null;
}

export function initDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  // FULL is EXPLICIT and load-bearing. Scheduling-action replay is gated on
  // acks/drain ledgers persisted in the FULL-durable session DBs AFTER the
  // central apply — synchronous=NORMAL would let a power loss drop the
  // central write while the durable ack suppresses replay (schedule_task
  // silently lost; cancel_task resurrected by the per-minute repair). Do
  // NOT downgrade to NORMAL without first moving those replay gates into
  // this database.
  _db.pragma('synchronous = FULL');
  _db.pragma('wal_autocheckpoint = 4000');
  _db.pragma('foreign_keys = ON');
  log.info('Central DB initialized', { path: dbPath });
  return _db;
}

/** For tests only — creates an in-memory DB and runs migrations. */
export function initTestDb(): Database.Database {
  _db = new Database(':memory:');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Cheap: a single indexed lookup on
 * sqlite_master. Results are not cached — a module install adds the
 * table at runtime (next service start), and callers may run before
 * or after that boundary.
 */
export function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
    | { '1': number }
    | undefined;
  return row !== undefined;
}
