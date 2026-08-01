import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MinuteRateLimiter,
  parseStructuredStderrEvent,
  persistStderrTail,
  splitStderrChunk,
  StderrTail,
  truncateForLog,
} from './container-stderr.js';

describe('splitStderrChunk', () => {
  it('reassembles JSON split across chunk boundaries', () => {
    const first = splitStderrChunk('', '{"severity":"error","ev');
    expect(first.lines).toEqual([]);
    const second = splitStderrChunk(first.carry, 'ent":"boom"}\nplain line\npartial');
    expect(second.lines).toEqual(['{"severity":"error","event":"boom"}', 'plain line']);
    expect(second.carry).toBe('partial');
  });

  it('caps a newline-free carry at the byte budget, keeping the tail end', () => {
    const cap = 1024;
    const huge = 'A'.repeat(cap) + 'B'.repeat(cap); // 2x the cap, no newline anywhere
    const first = splitStderrChunk('', huge, cap);
    expect(first.lines).toEqual([]);
    expect(Buffer.byteLength(first.carry, 'utf8')).toBeLessThanOrEqual(cap); // bounded
    expect(first.carry).toBe('B'.repeat(cap)); // tail end kept — most recent bytes are the evidence
    // A subsequent normal line is reassembled from the truncated carry without corruption.
    const second = splitStderrChunk(first.carry, '-end\nnext line\n', cap);
    expect(second.lines).toEqual(['B'.repeat(cap) + '-end', 'next line']);
    expect(second.carry).toBe('');
  });
});

describe('parseStructuredStderrEvent', () => {
  it('parses bare and poll-loop-prefixed JSON events, rejects everything else', () => {
    expect(parseStructuredStderrEvent('{"severity":"error","event":"fatal_error"}')).toMatchObject({
      event: 'fatal_error',
    });
    expect(parseStructuredStderrEvent('[poll-loop] {"severity":"info","event":"tick"}')).toMatchObject({
      event: 'tick',
    });
    expect(parseStructuredStderrEvent('plain stderr noise')).toBeNull();
    expect(parseStructuredStderrEvent('{"no_event_field":true}')).toBeNull();
    expect(parseStructuredStderrEvent('{broken json')).toBeNull();
  });
});

describe('StderrTail', () => {
  it('caps at maxBytes by dropping oldest lines', () => {
    const tail = new StderrTail(64);
    for (let i = 0; i < 20; i++) tail.append(`line-${String(i).padStart(2, '0')} xxxxxxxxxx`);
    const contents = tail.contents();
    expect(Buffer.byteLength(contents, 'utf8')).toBeLessThanOrEqual(64 + 32); // one line of slack
    expect(contents).toContain('line-19');
    expect(contents).not.toContain('line-00');
  });
});

describe('MinuteRateLimiter', () => {
  it('allows maxPerMinute then suppresses until the window rolls', () => {
    const limiter = new MinuteRateLimiter(2);
    const t0 = 1_000_000;
    expect(limiter.allow(t0)).toBe(true);
    expect(limiter.allow(t0 + 1)).toBe(true);
    expect(limiter.allow(t0 + 2)).toBe(false);
    expect(limiter.suppressed).toBe(1);
    expect(limiter.allow(t0 + 61_000)).toBe(true);
  });
});

describe('persistStderrTail', () => {
  function writeOne(dir: string, exitCode: number | null, text: string, second: number): string | null {
    const tail = new StderrTail(4096);
    tail.append(text);
    return persistStderrTail({
      logDir: dir,
      tail,
      exitCode,
      keepClean: 5,
      keepCrash: 5,
      nowMs: Date.UTC(2026, 6, 31, 12, 0, second),
    });
  }

  it('rotates clean and crash tails on SEPARATE budgets — clean exits never evict crash evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-tail-'));
    writeOne(dir, 1, 'crash output A', 0);
    writeOne(dir, null, 'crash output B (verify path, unknown code)', 1);
    for (let i = 0; i < 9; i++) writeOne(dir, 0, `clean output ${i}`, 2 + i);
    const files = fs.readdirSync(dir).sort();
    const clean = files.filter((f) => f.endsWith('-exit-0.log'));
    const crash = files.filter((f) => !f.endsWith('-exit-0.log'));
    expect(clean).toHaveLength(5); // newest 5 clean kept
    expect(crash).toHaveLength(2); // BOTH crash tails survive 9 clean exits
    expect(crash.some((f) => f.endsWith('-exit-unknown.log'))).toBe(true); // never '-exit-null'
    expect(fs.readFileSync(path.join(dir, crash[0]), 'utf8')).toContain('crash output A');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates crash tails down to keepCrash among themselves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-tail-'));
    for (let i = 0; i < 7; i++) writeOne(dir, 1, `crash output ${i}`, i);
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(5);
    expect(fs.readFileSync(path.join(dir, files.at(-1)!), 'utf8')).toContain('crash output 6');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flushes the final unterminated carry line into the persisted tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-tail-'));
    const tail = new StderrTail(4096);
    tail.append('complete line');
    const file = persistStderrTail({ logDir: dir, tail, carry: 'FATAL: last words with no newline', exitCode: 1 });
    expect(fs.readFileSync(file!, 'utf8')).toContain('FATAL: last words with no newline');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never throws and returns null for an empty tail+carry or unwritable dir', () => {
    // Empty tail short-circuits before any fs work.
    expect(persistStderrTail({ logDir: '/nonexistent/no-perms/x', tail: new StderrTail(64), exitCode: 0 })).toBeNull();
    // A NON-EMPTY tail actually reaches the mkdir/write against an unwritable
    // root-owned path — advisory capture must swallow the error (fail-open).
    const tail = new StderrTail(4096);
    tail.append('crash output that cannot be persisted');
    expect(persistStderrTail({ logDir: '/nonexistent/no-perms/x', tail, exitCode: 1 })).toBeNull();
  });
});

describe('truncateForLog', () => {
  it('truncates long lines with a marker', () => {
    expect(truncateForLog('x'.repeat(3000), 2000)).toHaveLength(2000 + '…[truncated 1000 chars]'.length);
    expect(truncateForLog('short')).toBe('short');
  });
});
