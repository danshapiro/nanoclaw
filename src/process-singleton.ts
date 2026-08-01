import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

let lockDb: Database.Database | null = null;

/**
 * Boot-time process-singleton guard.
 *
 * In-process runtime locks (src/db/runtime-locks.ts) cannot detect a SECOND
 * nanoclaw process — and real overlap paths exist (manual start beside the
 * service, legacy + slug launchd labels on one checkout, unload→load during
 * the graceful drain, the nohup fallback). This takes an EXCLUSIVE SQLite
 * lock on a dedicated lock DB beside v2.db and HOLDS it for the process
 * lifetime; a second service process fails loudly at boot instead of
 * silently double-writing v2.db.
 *
 * Deliberately service-scoped: ops scripts (scripts/run-migrations.ts,
 * scripts/q.ts, yente tools) remain outside the guard — operator-supervised.
 */
export function acquireProcessSingletonLock(lockDbPath: string): void {
  fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
  // Short busy timeout: a conflicting boot should fail fast, not hang.
  const db = new Database(lockDbPath, { timeout: 1_000 });
  try {
    // locking_mode=EXCLUSIVE + a write transaction acquires the OS-level
    // exclusive file lock; in this mode SQLite NEVER releases it until the
    // connection closes (process exit) — no lease, no renewal, no staleness:
    // the kernel drops the lock the instant the process dies.
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS singleton (pid INTEGER NOT NULL); DELETE FROM singleton;');
    db.prepare('INSERT INTO singleton (pid) VALUES (?)').run(process.pid);
    db.exec('COMMIT;');
    lockDb = db; // held for process lifetime — deliberately never closed
    log.info('Process-singleton lock acquired', { lockDbPath, pid: process.pid });
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === 'SQLITE_BUSY') {
      log.error('Another nanoclaw process already holds the singleton lock — refusing to start', { lockDbPath });
      throw new Error(
        `Another nanoclaw process already holds the singleton lock at ${lockDbPath}; ` +
          'refusing to start a second writer against the same v2.db',
        { cause: err },
      );
    }
    throw err;
  }
}

/** Test-only: release the held lock so contention can be exercised. */
export function releaseProcessSingletonLockForTest(): void {
  lockDb?.close();
  lockDb = null;
}
