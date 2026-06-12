import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import {
  buildNanoclawSkillInventoryInstructions,
  CodexProvider,
  resolveClaudeImports,
  syncCodexManagedSkillLinks,
} from './codex.js';

describe('createProvider (codex)', () => {
  it('returns CodexProvider for codex', () => {
    expect(createProvider('codex')).toBeInstanceOf(CodexProvider);
  });

  it('flags stale thread errors as session-invalid (2-arg signature)', () => {
    const p = new CodexProvider();
    expect(p.isSessionInvalid(new Error('thread not found'), { attemptedContinuation: 'thread-1' })).toBe(true);
    expect(p.isSessionInvalid(new Error('unknown thread 123'), { attemptedContinuation: 'thread-1' })).toBe(true);
    expect(p.isSessionInvalid(new Error('No such thread: abc'), { attemptedContinuation: 'thread-1' })).toBe(true);
  });

  it('does not flag unrelated errors as session-invalid', () => {
    const p = new CodexProvider();
    expect(p.isSessionInvalid(new Error('rate limit exceeded'), { attemptedContinuation: 'thread-1' })).toBe(false);
    expect(p.isSessionInvalid(new Error('connection reset'), { attemptedContinuation: 'thread-1' })).toBe(false);
    expect(p.isSessionInvalid(new Error('codex app-server exited: code=1'), { attemptedContinuation: 'thread-1' })).toBe(
      false,
    );
  });

  it('declares no native slash command support', () => {
    const p = new CodexProvider();
    expect(p.supportsNativeSlashCommands).toBe(false);
  });
});

describe('resolveClaudeImports', () => {
  function scratchDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-imports-'));
  }

  it('inlines a single relative import', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'fragment.md'), 'FRAGMENT CONTENT');
    const resolved = resolveClaudeImports('before\n@./fragment.md\nafter', dir);
    expect(resolved).toContain('FRAGMENT CONTENT');
    expect(resolved).not.toContain('@./fragment.md');
    expect(resolved).toMatch(/before[\s\S]*FRAGMENT CONTENT[\s\S]*after/);
  });

  it('expands nested imports relative to the parent file', () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), 'INNER');
    fs.writeFileSync(path.join(dir, 'sub', 'outer.md'), '@./inner.md');
    const resolved = resolveClaudeImports('@./sub/outer.md', dir);
    expect(resolved).toBe('INNER');
  });

  it('drops missing imports to empty text rather than leaving raw @path', () => {
    const dir = scratchDir();
    const resolved = resolveClaudeImports('before\n@./does-not-exist.md\nafter', dir);
    expect(resolved).not.toContain('@./does-not-exist.md');
    expect(resolved).toContain('before');
    expect(resolved).toContain('after');
  });

  it('breaks cycles', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), '@./a.md');
    // Just needs to terminate without a stack overflow.
    const resolved = resolveClaudeImports('@./a.md', dir);
    expect(typeof resolved).toBe('string');
  });

  it('leaves non-import @ mentions alone (only line-anchored @<path> is imported)', () => {
    const dir = scratchDir();
    const resolved = resolveClaudeImports('email @someone for details', dir);
    expect(resolved).toBe('email @someone for details');
  });
});

describe('Codex NanoClaw skill bridge', () => {
  function writeSkill(root: string, name: string): void {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  }

  it('links deployed NanoClaw skills into the Codex skill root and prunes stale managed links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-root-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-dest-'));
    writeSkill(root, 'gws-calendar');
    writeSkill(root, 'using-familiar');
    fs.mkdirSync(path.join(root, '.bin'));
    fs.mkdirSync(path.join(root, 'not-a-skill'));
    fs.symlinkSync(path.join(root, 'removed-skill'), path.join(dest, 'removed-skill'), 'dir');
    fs.mkdirSync(path.join(dest, 'imagegen'), { recursive: true });

    const linked = syncCodexManagedSkillLinks(root, dest);

    expect(linked).toEqual(['gws-calendar', 'using-familiar']);
    expect(fs.readlinkSync(path.join(dest, 'gws-calendar'))).toBe(path.join(root, 'gws-calendar'));
    expect(fs.readlinkSync(path.join(dest, 'using-familiar'))).toBe(path.join(root, 'using-familiar'));
    expect(fs.existsSync(path.join(dest, 'removed-skill'))).toBe(false);
    expect(fs.lstatSync(path.join(dest, 'imagegen')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dest, '.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'not-a-skill'))).toBe(false);
  });

  it('builds a compact deployed-skill inventory for Codex base instructions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-inventory-'));
    writeSkill(root, 'using-msgvault');
    writeSkill(root, 'agent-browser');

    const text = buildNanoclawSkillInventoryInstructions(root);

    expect(text).toContain('Available NanoClaw skills: agent-browser, using-msgvault');
  });
});
