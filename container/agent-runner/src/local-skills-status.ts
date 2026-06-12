import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface LocalSkillsDirtyStatus {
  repoPath: string;
  lines: string[];
  truncated: boolean;
}

const DEFAULT_LOCAL_SKILLS_PATH = '/workspace/local-skills';
const STATUS_TIMEOUT_MS = 1000;
const MAX_STATUS_LINES = 20;

export function localSkillsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NANOCLAW_LOCAL_SKILLS_WORKSPACE?.trim() || DEFAULT_LOCAL_SKILLS_PATH;
}

export function readLocalSkillsDirtyStatus(env: NodeJS.ProcessEnv = process.env): LocalSkillsDirtyStatus | null {
  if (env.NANOCLAW_LOCAL_SKILLS_DIRTY_WARNING === '0') return null;

  const repoPath = localSkillsPath(env);
  if (!fs.existsSync(path.join(repoPath, '.git'))) return null;

  const result = spawnSync('git', ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    timeout: STATUS_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return null;

  return {
    repoPath,
    lines: lines.slice(0, MAX_STATUS_LINES),
    truncated: lines.length > MAX_STATUS_LINES,
  };
}
