import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const runtimeSkillAndAgentDocs = [
  'container/skills/vercel-subagent/SKILL.md',
  'container/skills/vercel-cli/SKILL.md',
  'container/skills/self-customize/SKILL.md',
  'container/agent-runner/src/mcp-tools/agents.instructions.md',
  'container/agent-runner/src/mcp-tools/agents.ts',
];

describe('vercel-subagent runtime contract', () => {
  it('removes the old separate frontend skill', () => {
    expect(fs.existsSync(path.join(root, 'container/skills/frontend-engineer/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'container/skills/vercel-subagent/SKILL.md'))).toBe(true);
  });

  it('documents stateful Codex and OpenCode subprocess continuation', () => {
    const skill = read('container/skills/vercel-subagent/SKILL.md');

    expect(skill).toContain('name: vercel-subagent');
    expect(skill).toContain('Vercel frontend engineer');
    expect(skill).toContain('/workspace/agent/.nanoclaw/vercel-subagents/');
    expect(skill).toContain('codex exec --cd "$PROJECT_DIR"');
    expect(skill).toContain('codex exec resume');
    expect(skill).toContain('opencode run --dir "$PROJECT_DIR"');
    expect(skill).toContain('opencode run --session');
    expect(skill).toContain('agent-browser screenshot "$SESSION_DIR/desktop.png"');
    expect(skill).toContain('vercel deploy --yes --prod --token placeholder --cwd "$PROJECT_DIR"');
    expect(skill).not.toContain('codex exec --cwd');
    expect(skill).not.toContain('opencode run --cwd');
    expect(skill).not.toContain('opencode run --continue "$(cat "$SESSION_DIR/opencode-session-id")"');
  });

  it('routes website builds through the vercel-subagent skill', () => {
    const vercelCli = read('container/skills/vercel-cli/SKILL.md');

    expect(vercelCli).toContain('use the `vercel-subagent` skill');
    expect(vercelCli).toContain('/workspace/agent/.nanoclaw/vercel-subagents/');
    expect(vercelCli).not.toContain('create_agent');
  });

  it('keeps legacy frontend-destination language out of runtime skills and agent guidance', () => {
    const combined = runtimeSkillAndAgentDocs.map((file) => read(file)).join('\n---FILE---\n');

    for (const forbidden of [
      '/app/skills/frontend-engineer',
      'Frontend Engineer',
      'frontend-engineer',
      'Claude Code native binary',
      'pathToClaudeCodeExecutable',
      'send_message(to',
      'send_to_agent',
      'code-build-subagent',
      'ephemeral build agents',
      '--ephemeral',
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });
});
