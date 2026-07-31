import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireProcessSingletonLock, releaseProcessSingletonLockForTest } from './process-singleton.js';

describe('process-singleton guard', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-singleton-test-'));
    lockPath = path.join(tmpDir, 'nanoclaw.lock.db');
  });

  afterEach(() => {
    releaseProcessSingletonLockForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires the lock on a fresh path', () => {
    expect(() => acquireProcessSingletonLock(lockPath)).not.toThrow();
  });

  it('a second connection cannot acquire the held lock (loud contention failure)', () => {
    acquireProcessSingletonLock(lockPath);
    // Each call opens an independent better-sqlite3 connection — the same
    // OS-level file-lock contention two overlapping processes would hit.
    expect(() => acquireProcessSingletonLock(lockPath)).toThrow(/already holds the singleton lock/);
  });

  it('re-acquisition succeeds after the holder releases (process-exit analogue)', () => {
    acquireProcessSingletonLock(lockPath);
    releaseProcessSingletonLockForTest();
    expect(() => acquireProcessSingletonLock(lockPath)).not.toThrow();
  });
});
