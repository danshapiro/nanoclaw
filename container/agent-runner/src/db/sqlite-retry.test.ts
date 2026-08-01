import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSqliteBusyError, withSqliteRetry } from './sqlite-retry.js';

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sqlite-retry-')), 't.db');
}

describe('isSqliteBusyError', () => {
  it('classifies a real bun:sqlite lock error and shaped errors; rejects others', () => {
    const path = tempDbPath();
    const a = new Database(path);
    a.exec('PRAGMA journal_mode = DELETE');
    a.exec('CREATE TABLE t (id INTEGER)');
    a.exec('BEGIN EXCLUSIVE');
    const b = new Database(path);
    b.exec('PRAGMA busy_timeout = 50');
    let caught: unknown;
    try {
      b.exec('BEGIN EXCLUSIVE');
    } catch (err) {
      caught = err;
    }
    a.exec('ROLLBACK');
    a.close();
    b.close();
    expect(caught).toBeDefined();
    expect(isSqliteBusyError(caught)).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true);
    expect(isSqliteBusyError(new Error('boom'))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });
});

describe('withSqliteRetry', () => {
  it('retries a busy operation until the lock is released', async () => {
    const path = tempDbPath();
    const a = new Database(path);
    a.exec('PRAGMA journal_mode = DELETE');
    a.exec('CREATE TABLE t (id INTEGER)');
    a.exec('BEGIN EXCLUSIVE');
    setTimeout(() => {
      a.exec('ROLLBACK');
      a.close();
    }, 300);
    const b = new Database(path);
    b.exec('PRAGMA busy_timeout = 50');
    const result = await withSqliteRetry(
      () => {
        b.exec('BEGIN IMMEDIATE');
        b.exec('COMMIT');
        return 'ok';
      },
      { label: 'test', attempts: 10, baseDelayMs: 100 },
    );
    b.close();
    expect(result).toBe('ok');
  });

  it('rethrows non-busy errors immediately and busy errors after the attempt cap', async () => {
    await expect(
      withSqliteRetry(
        () => {
          throw new Error('boom');
        },
        { label: 'x', attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('boom');

    let calls = 0;
    await expect(
      withSqliteRetry(
        () => {
          calls += 1;
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
        { label: 'x', attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('database is locked');
    expect(calls).toBe(3);
  });
});
