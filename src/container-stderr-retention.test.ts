import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistStderrTail, StderrTail, withContainerLogRetentionLease } from './container-stderr.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-retention-'));
  roots.push(root);
  const logDir = path.join(root, 'logs');
  const lock = path.join(root, '.container-log-retention.lock');
  fs.mkdirSync(logDir);
  fs.writeFileSync(lock, '', { mode: 0o600 });
  return { root, logDir, lock };
}
function exclusive(fd: number) {
  return spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
}
function write(
  f: ReturnType<typeof fixture>,
  time: number,
  code = 137,
  deferred?: (why: 'busy' | 'unavailable') => void,
) {
  const tail = new StderrTail(4096);
  tail.append(`forensic tail ${time}`);
  return persistStderrTail({
    logDir: f.logDir,
    retentionLockPath: f.lock,
    tail,
    exitCode: code,
    keepCrash: 1,
    keepClean: 1,
    nowMs: time,
    onRetentionDeferred: deferred,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('real kernel retention lease', () => {
  it('keeps the shared lease in the parent after flock exits, then releases it', () => {
    const f = fixture();
    expect(
      withContainerLogRetentionLease(f.lock, () => {
        const competitor = fs.openSync(f.lock, 'r');
        try {
          expect(exclusive(competitor).status).toBe(1);
        } finally {
          fs.closeSync(competitor);
        }
      }),
    ).toBe('pruned');
    const competitor = fs.openSync(f.lock, 'r');
    try {
      expect(exclusive(competitor).status).toBe(0);
    } finally {
      fs.closeSync(competitor);
    }
  });
  it('retains every censused tail while backup holds exclusive, still writes new tails, then resumes retention', () => {
    const f = fixture();
    const old = write(f, 1000)!;
    const fd = fs.openSync(f.lock, 'r');
    const reasons: string[] = [];
    try {
      expect(exclusive(fd).status).toBe(0);
      expect(write(f, 2000, 137, (why) => reasons.push(why))).not.toBeNull();
      expect(write(f, 3000, 0)).not.toBeNull();
      expect(fs.existsSync(old)).toBe(true);
      expect(reasons).toEqual(['busy']);
    } finally {
      fs.closeSync(fd);
    }
    expect(write(f, 4000)).not.toBeNull();
    expect(fs.existsSync(old)).toBe(false);
    const logs = fs.readdirSync(f.logDir).filter((name) => name.endsWith('.log'));
    expect(logs.filter((name) => name.endsWith('-exit-0.log'))).toHaveLength(1);
    expect(logs.filter((name) => name.endsWith('-exit-137.log'))).toHaveLength(1);
  });
  it('never overwrites a same-millisecond tail and leaves no temporary payload', () => {
    const f = fixture();
    const fd = fs.openSync(f.lock, 'r');
    try {
      expect(exclusive(fd).status).toBe(0);
      const first = write(f, 1000)!;
      const second = write(f, 1000)!;
      expect(first).not.toBe(second);
      expect(fs.readFileSync(first, 'utf8')).toBe('forensic tail 1000\n');
      expect(fs.readFileSync(second, 'utf8')).toBe('forensic tail 1000\n');
      expect(fs.readdirSync(f.logDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.closeSync(fd);
    }
  });
  it('resolves a deployed release/data symlink to the SAME shared-root mutex', () => {
    const f = fixture();
    const release = path.join(f.root, 'release');
    const shared = path.join(f.root, 'shared');
    fs.mkdirSync(release);
    fs.mkdirSync(shared);
    fs.mkdirSync(path.join(shared, 'data'));
    fs.symlinkSync(path.join(shared, 'data'), path.join(release, 'data'));
    const mutex = path.join(shared, '.container-log-retention.lock');
    expect(withContainerLogRetentionLease(`${release}/data/../.container-log-retention.lock`, () => {})).toBe('pruned');
    expect(fs.existsSync(mutex)).toBe(true);
    expect(fs.existsSync(path.join(release, '.container-log-retention.lock'))).toBe(false);
    const fd = fs.openSync(mutex, 'r');
    try {
      expect(exclusive(fd).status).toBe(0);
      expect(
        withContainerLogRetentionLease(`${release}/data/../.container-log-retention.lock`, () => {
          throw Error('must not prune');
        }),
      ).toBe('busy');
    } finally {
      fs.closeSync(fd);
    }
  });
  it('releases the shared lease even when pruning throws', () => {
    const f = fixture();
    expect(
      withContainerLogRetentionLease(f.lock, () => {
        throw Error('I/O failure');
      }),
    ).toBe('unavailable');
    const fd = fs.openSync(f.lock, 'r');
    try {
      expect(exclusive(fd).status).toBe(0);
    } finally {
      fs.closeSync(fd);
    }
  });
  it.each(['symlink', 'fifo', 'directory', 'nonempty', 'hardlink', 'loose-mode'] as const)(
    'refuses %s mutex without deleting tails',
    (kind) => {
      const f = fixture();
      const old = write(f, 1000)!;
      fs.unlinkSync(f.lock);
      if (kind === 'symlink') fs.symlinkSync(old, f.lock);
      if (kind === 'fifo') expect(spawnSync('mkfifo', [f.lock]).status).toBe(0);
      if (kind === 'directory') fs.mkdirSync(f.lock);
      if (kind === 'nonempty') fs.writeFileSync(f.lock, 'not a mutex', { mode: 0o600 });
      if (kind === 'hardlink') {
        fs.writeFileSync(f.lock, '', { mode: 0o600 });
        fs.linkSync(f.lock, f.lock + '.other');
      }
      if (kind === 'loose-mode') fs.writeFileSync(f.lock, '', { mode: 0o666 });
      if (kind === 'loose-mode') fs.chmodSync(f.lock, 0o666);
      const reasons: string[] = [];
      expect(write(f, 2000, 137, (why) => reasons.push(why))).not.toBeNull();
      expect(reasons).toEqual(['unavailable']);
      expect(fs.existsSync(old)).toBe(true);
    },
  );
});
