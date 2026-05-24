const REQUIRED_PATH_DIRS = ['/app/skills/.bin', '/pnpm/bin', '/pnpm'];

export function ensureAgentRunnerPath(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.PATH ? env.PATH.split(':').filter(Boolean) : [];
  const missing = REQUIRED_PATH_DIRS.filter((dir) => !existing.includes(dir));
  if (missing.length > 0) {
    env.PATH = [...missing, ...existing].join(':');
  }
  return env.PATH || '';
}

