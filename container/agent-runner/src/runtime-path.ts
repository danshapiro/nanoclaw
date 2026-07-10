const REQUIRED_PATH_DIRS = ['/app/skills/.bin', '/pnpm/bin', '/pnpm'];

export function ensureAgentRunnerPath(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.PATH ? env.PATH.split(':').filter(Boolean) : [];
  const missing = REQUIRED_PATH_DIRS.filter((dir) => !existing.includes(dir));
  if (missing.length > 0) {
    env.PATH = [...missing, ...existing].join(':');
  }
  return env.PATH || '';
}


/**
 * Node CLI flag suppressing the `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is
 * experimental` noise. Agent containers run with NODE_USE_ENV_PROXY=1 +
 * HTTP(S)_PROXY (OneCLI gateway), so every Node CLI we spawn (claude-code and
 * its children) emits the warning to stderr on first fetch — ~2 per container
 * spawn in journald. `--disable-warning=<code>` is code-specific (Node >= 20.11
 * / 21.3; image is node:22), so all other warnings still surface. Bun ignores
 * the flag, so bun-spawned children (MCP servers) are unaffected.
 */
const DISABLE_UNDICI_EHPA_WARNING = '--disable-warning=UNDICI-EHPA';

/**
 * Append the UNDICI-EHPA suppression flag to NODE_OPTIONS (preserving any
 * existing options, idempotent). Mutates `env` like ensureAgentRunnerPath.
 */
export function suppressUndiciProxyWarning(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.NODE_OPTIONS?.trim();
  if (existing && existing.includes(DISABLE_UNDICI_EHPA_WARNING)) {
    return existing;
  }
  env.NODE_OPTIONS = existing ? `${existing} ${DISABLE_UNDICI_EHPA_WARNING}` : DISABLE_UNDICI_EHPA_WARNING;
  return env.NODE_OPTIONS;
}
