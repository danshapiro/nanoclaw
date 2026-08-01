/**
 * R9: bounded busy-retry for session-DB access. The host legitimately takes
 * short write locks on outbound.db (direct notices, recovery); a lock hold
 * longer than busy_timeout must NOT crash the container mid-turn (the
 * hypothesized 07-31 crash-cluster mechanism: SQLITE_BUSY unwinding
 * runPollLoop straight into process.exit(1) — mechanism-consistent, but the
 * stderr that would prove it was lost; R6 closes that gap). Defense-in-depth:
 * retries are bounded and exhaustion RETHROWS — fail loud, never swallow.
 */

export function isSqliteBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('database is locked');
}

export async function withSqliteRetry<T>(
  fn: () => T,
  opts: { label: string; attempts?: number; baseDelayMs?: number },
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= attempts) throw err;
      console.error(
        JSON.stringify({
          severity: 'warn',
          event: 'sqlite_busy_retry',
          label: opts.label,
          attempt,
          max_attempts: attempts,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, baseDelayMs * 2 ** (attempt - 1))));
    }
  }
}
