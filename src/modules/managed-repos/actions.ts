import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import type Database from 'better-sqlite3';

import { NANOCLAW_ROOT } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCAL_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ManagedRepoCommandResult {
  stdout: string;
  stderr: string;
}

export async function runManagedRepoCommand(
  scriptName: string,
  args: string[] = [],
): Promise<ManagedRepoCommandResult> {
  const scriptPath = path.join(NANOCLAW_ROOT, scriptName);
  const { stdout, stderr } = await execFileAsync(scriptPath, args, {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  return {
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
}

function formatCommandResult(action: string, result: ManagedRepoCommandResult): string {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return output ? `${action} completed:\n${output}` : `${action} completed.`;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const message = error instanceof Error ? error.message : String(error);
    return [stdout, stderr, message].filter(Boolean).join('\n');
  }
  return String(error);
}

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-managed-repos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) =>
      log.error('Failed to wake container after managed-repos notification', { err }),
    );
  }
}

function requireKnownGroup(session: Session): boolean {
  const group = getAgentGroup(session.agent_group_id);
  if (!group) {
    notifyAgent(session, 'managed repos action failed: source agent group not found.');
    return false;
  }
  return true;
}

async function applyManagedRepos(session: Session): Promise<void> {
  if (!requireKnownGroup(session)) return;
  try {
    const result = await runManagedRepoCommand('apply-managed-repos.sh');
    notifyAgent(session, formatCommandResult('apply_managed_repos', result));
  } catch (error) {
    log.error('apply_managed_repos failed', { err: error });
    notifyAgent(session, `apply_managed_repos failed:\n${errorMessage(error)}`);
  }
}

async function pushManagedRepo(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!requireKnownGroup(session)) return;
  const repoId = content.repoId;
  if (typeof repoId !== 'string' || !REPO_ID_RE.test(repoId)) {
    notifyAgent(session, 'push_managed_repo failed: repoId must be a managed repo id.');
    return;
  }
  try {
    const result = await runManagedRepoCommand('push-managed-repo.sh', [repoId]);
    notifyAgent(session, formatCommandResult('push_managed_repo', result));
  } catch (error) {
    log.error('push_managed_repo failed', { repoId, err: error });
    notifyAgent(session, `push_managed_repo failed for ${repoId}:\n${errorMessage(error)}`);
  }
}

async function publishLocalSkill(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!requireKnownGroup(session)) return;
  const skillName = content.skillName;
  const commitMessage = content.commitMessage;
  if (typeof skillName !== 'string' || !LOCAL_SKILL_NAME_RE.test(skillName)) {
    notifyAgent(session, 'publish_local_skill failed: skillName must be a local skill directory name.');
    return;
  }
  if (typeof commitMessage !== 'string' || commitMessage.trim() === '') {
    notifyAgent(session, 'publish_local_skill failed: commitMessage must be a non-empty string.');
    return;
  }
  try {
    const result = await runManagedRepoCommand('publish-local-skill.sh', [skillName, commitMessage.trim()]);
    notifyAgent(session, formatCommandResult('publish_local_skill', result));
  } catch (error) {
    log.error('publish_local_skill failed', { skillName, err: error });
    notifyAgent(session, `publish_local_skill failed for ${skillName}:\n${errorMessage(error)}`);
  }
}

export async function handleApplyManagedRepos(
  _content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  await applyManagedRepos(session);
}

export async function handlePushManagedRepo(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  await pushManagedRepo(content, session);
}

export async function handlePublishLocalSkill(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  await publishLocalSkill(content, session);
}
