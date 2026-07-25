import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readAgentAndGlobalClaudeMd } from './codex.js';

describe('readAgentAndGlobalClaudeMd', () => {
  let groupDir: string;
  let globalDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claude-group-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claude-global-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  it('loads group CLAUDE.md, then global CLAUDE.local.md, then group CLAUDE.local.md', () => {
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'GROUP-BASE');
    fs.writeFileSync(path.join(globalDir, 'CLAUDE.local.md'), 'GLOBAL-PERSONA');
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'GROUP-MEMORY');

    const { text, sources } = readAgentAndGlobalClaudeMd(groupDir, globalDir);

    expect(text).toBe('GROUP-BASE\n\n---\n\nGLOBAL-PERSONA\n\n---\n\nGROUP-MEMORY');
    expect(sources).toEqual({
      'agent/CLAUDE.md': 'GROUP-BASE'.length,
      'global/CLAUDE.local.md': 'GLOBAL-PERSONA'.length,
      'agent/CLAUDE.local.md': 'GROUP-MEMORY'.length,
    });
  });

  it('includes the global layer even when the composed group CLAUDE.md has no global import', () => {
    // Regression guard: composeGroupClaudeMd emits only local @-imports, so
    // the global layer must be read explicitly by the provider.
    fs.writeFileSync(
      path.join(groupDir, 'CLAUDE.md'),
      '<!-- Composed at spawn -->\n@./.claude-shared.md\n',
    );
    fs.writeFileSync(path.join(groupDir, '.claude-shared.md'), 'SHARED-BASE');
    fs.writeFileSync(path.join(globalDir, 'CLAUDE.local.md'), 'SPEND THE MAXIMUM TOKENS');

    const { text, sources } = readAgentAndGlobalClaudeMd(groupDir, globalDir);

    expect(text).toContain('SHARED-BASE');
    expect(text).toContain('SPEND THE MAXIMUM TOKENS');
    expect(sources['global/CLAUDE.local.md']).toBeGreaterThan(0);
  });

  it('resolves @-imports in the global file relative to the global dir', () => {
    fs.writeFileSync(path.join(globalDir, 'CLAUDE.local.md'), '@./extra.md');
    fs.writeFileSync(path.join(globalDir, 'extra.md'), 'GLOBAL-EXTRA');

    const { text } = readAgentAndGlobalClaudeMd(groupDir, globalDir);

    expect(text).toContain('GLOBAL-EXTRA');
  });

  it('omits missing files and reports no source entry for them', () => {
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'ONLY-MEMORY');

    const { text, sources } = readAgentAndGlobalClaudeMd(groupDir, globalDir);

    expect(text).toBe('ONLY-MEMORY');
    expect(Object.keys(sources)).toEqual(['agent/CLAUDE.local.md']);
  });

  it('returns undefined text when nothing exists', () => {
    const { text, sources } = readAgentAndGlobalClaudeMd(groupDir, globalDir);
    expect(text).toBeUndefined();
    expect(sources).toEqual({});
  });
});
