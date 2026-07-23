import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroup } from './types.js';

/**
 * Loads claude-md-compose with `GROUPS_DIR` pointed at a fresh temp dir so the
 * composer writes into a sandbox. `process.cwd()` is left at the project root,
 * so the real skill / mcp-tool fragments are also discovered — the assertions
 * target only the Granola-unavailable fragment this task adds, which never
 * collides with those names.
 */
async function loadComposer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-md-'));
  const groupsDir = path.join(root, 'groups');
  fs.mkdirSync(groupsDir, { recursive: true });

  vi.resetModules();
  vi.doMock('./config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./config.js')>();
    return { ...actual, GROUPS_DIR: groupsDir };
  });

  const compose = await import('./claude-md-compose.js');
  return {
    compose,
    groupsDir,
    close() {
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('./config.js');
      vi.resetModules();
    },
  };
}

const group: AgentGroup = {
  id: 'ag-main',
  name: 'Yente',
  folder: 'main',
  agent_provider: null,
  created_at: '2026-05-28T00:00:00.000Z',
};

function writeContainerJson(groupsDir: string, value: unknown): void {
  const dir = path.join(groupsDir, group.folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(value, null, 2));
}

function fragmentPath(groupsDir: string, name: string): string {
  return path.join(groupsDir, group.folder, '.claude-fragments', name);
}

describe('provider-independent shared guidance', () => {
  let harness: Awaited<ReturnType<typeof loadComposer>>;

  beforeEach(async () => {
    harness = await loadComposer();
  });

  afterEach(() => {
    harness.close();
  });

  it('routes the composed project entry to the release-owned two-account GWS policy', () => {
    writeContainerJson(harness.groupsDir, { mcpServers: {} });

    harness.compose.composeGroupClaudeMd(group);

    const groupDir = path.join(harness.groupsDir, group.folder);
    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    expect(composed).toContain('@./.claude-shared.md');
    expect(fs.readlinkSync(path.join(groupDir, '.claude-shared.md'))).toBe('/app/CLAUDE.md');
  });
});

describe('composeGroupClaudeMd Granola unavailable fragment', () => {
  let harness: Awaited<ReturnType<typeof loadComposer>>;

  beforeEach(async () => {
    harness = await loadComposer();
  });

  afterEach(() => {
    harness.close();
  });

  it('writes a sanitized unavailable fragment into the OpenCode-loaded .claude-fragments dir', () => {
    writeContainerJson(harness.groupsDir, {
      mcpServers: {},
      agentMcpUnavailable: {
        granola: {
          category: 'auth_required',
          message: 'Granola is temporarily unavailable: its credentials need to be refreshed.',
        },
      },
    });

    harness.compose.composeGroupClaudeMd(group);

    const fragPath = fragmentPath(harness.groupsDir, 'mcp-granola-unavailable.md');
    expect(fs.existsSync(fragPath)).toBe(true);
    const body = fs.readFileSync(fragPath, 'utf8');
    expect(body.toLowerCase()).toContain('granola');
    expect(body.toLowerCase()).toContain('unavailable');

    // The composed entry imports the fragment so OpenCode's instructions glob
    // (/workspace/agent/.claude-fragments/*.md) loads it into system context.
    const composed = fs.readFileSync(path.join(harness.groupsDir, group.folder, 'CLAUDE.md'), 'utf8');
    expect(composed).toContain('@./.claude-fragments/mcp-granola-unavailable.md');
  });

  it('keeps the unavailable text free of host paths, uid/gid values, and raw errors', () => {
    writeContainerJson(harness.groupsDir, {
      mcpServers: {},
      agentMcpUnavailable: {
        granola: {
          category: 'auth_expired',
          message: 'Granola is temporarily unavailable: its credentials have expired.',
        },
      },
    });

    harness.compose.composeGroupClaudeMd(group);

    const body = fs.readFileSync(fragmentPath(harness.groupsDir, 'mcp-granola-unavailable.md'), 'utf8');
    expect(body).not.toContain('/home/');
    expect(body).not.toContain('/srv/');
    expect(body).not.toContain('.mcp-auth');
    expect(body).not.toMatch(/\b\d{3,5}:\d{3,5}\b/); // uid:gid
    expect(body).not.toMatch(/Error:/);
  });

  it('removes a stale unavailable fragment once Granola is available again', () => {
    // First spawn: Granola degraded.
    writeContainerJson(harness.groupsDir, {
      mcpServers: {},
      agentMcpUnavailable: {
        granola: { category: 'auth_required', message: 'Granola is temporarily unavailable.' },
      },
    });
    harness.compose.composeGroupClaudeMd(group);
    expect(fs.existsSync(fragmentPath(harness.groupsDir, 'mcp-granola-unavailable.md'))).toBe(true);

    // Next spawn: Granola available, no unavailable state recorded.
    writeContainerJson(harness.groupsDir, { mcpServers: {} });
    harness.compose.composeGroupClaudeMd(group);
    expect(fs.existsSync(fragmentPath(harness.groupsDir, 'mcp-granola-unavailable.md'))).toBe(false);

    const composed = fs.readFileSync(path.join(harness.groupsDir, group.folder, 'CLAUDE.md'), 'utf8');
    expect(composed).not.toContain('mcp-granola-unavailable.md');
  });
});
