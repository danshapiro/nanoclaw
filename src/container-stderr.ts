/**
 * R6: container stderr capture. Containers run with --rm, so the live stderr
 * stream is the ONLY copy of the agent-runner's crash output; before this
 * module it was logged at debug (below the prod threshold) and lost forever.
 * Pure helpers — no container-runner imports — so they unit-test without the
 * spawn harness.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Split a stderr chunk into complete lines, carrying partial tails across chunks. */
export function splitStderrChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split('\n');
  const nextCarry = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.length > 0), carry: nextCarry };
}

const POLL_LOOP_PREFIX = '[poll-loop] ';

/** Parse a structured agent-runner event line (bare JSON or '[poll-loop] '-prefixed). */
export function parseStructuredStderrEvent(line: string): Record<string, unknown> | null {
  const candidate = line.startsWith(POLL_LOOP_PREFIX) ? line.slice(POLL_LOOP_PREFIX.length) : line;
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { event?: unknown }).event === 'string') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Byte-capped rolling tail of stderr lines (drops oldest first). */
export class StderrTail {
  private lines: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  append(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line, 'utf8') + 1;
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const dropped = this.lines.shift()!;
      this.bytes -= Buffer.byteLength(dropped, 'utf8') + 1;
    }
  }
  contents(): string {
    return this.lines.join('\n');
  }
}

/** Fixed-window limiter: at most maxPerMinute allows per minute window. */
export class MinuteRateLimiter {
  private windowStartMs = 0;
  private count = 0;
  suppressed = 0;
  constructor(private readonly maxPerMinute: number) {}
  allow(nowMs: number): boolean {
    if (nowMs - this.windowStartMs >= 60_000) {
      this.windowStartMs = nowMs;
      this.count = 0;
    }
    if (this.count < this.maxPerMinute) {
      this.count += 1;
      return true;
    }
    this.suppressed += 1;
    return false;
  }
}

export function truncateForLog(line: string, max = 2000): string {
  return line.length <= max ? line : `${line.slice(0, max)}…[truncated ${line.length - max} chars]`;
}

/**
 * Persist a stderr tail into the HOST-OWNED per-session log dir (a sibling
 * tree outside the agent-writable workspace — see containerLogsDir; the
 * hostCorrelationDir precedent). Never write these files into /workspace:
 * the agent could forge or symlink-redirect its own crash evidence.
 *
 * Flushes the final unterminated `carry` line first (a crash's last line
 * often lacks a trailing newline — plausibly the most important line).
 * Labels a null exit code 'unknown' (verified stop), never 'null'.
 * Rotation is crash-privileged: clean tails (-exit-0.log) and crash tails
 * (everything else) rotate on SEPARATE budgets, so routine clean exits can
 * never evict crash evidence. Best-effort: returns the written path or
 * null; NEVER throws (post-mortem capture must not break container teardown).
 */
export function persistStderrTail(opts: {
  logDir: string;
  tail: StderrTail;
  carry?: string;
  exitCode: number | null;
  keepClean?: number;
  keepCrash?: number;
  nowMs?: number;
}): string | null {
  try {
    if (opts.carry) opts.tail.append(opts.carry);
    const contents = opts.tail.contents();
    if (!contents) return null;
    fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(opts.nowMs ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(opts.logDir, `${stamp}-exit-${opts.exitCode ?? 'unknown'}.log`);
    fs.writeFileSync(file, `${contents}\n`);
    const isClean = (f: string): boolean => f.endsWith('-exit-0.log');
    const entries = fs
      .readdirSync(opts.logDir)
      .filter((f) => f.endsWith('.log'))
      .sort();
    const prune = (names: string[], keep: number): void => {
      for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
        fs.rmSync(path.join(opts.logDir, stale), { force: true });
      }
    };
    prune(entries.filter(isClean), opts.keepClean ?? 5);
    prune(
      entries.filter((f) => !isClean(f)),
      opts.keepCrash ?? 5,
    );
    return file;
  } catch {
    return null;
  }
}
