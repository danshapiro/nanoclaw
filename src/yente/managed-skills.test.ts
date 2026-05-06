import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearManagedSkillRootCache, resolveManagedSkillRoot, syncManagedSkillSymlinks } from './managed-skills.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-managed-skills-'));
  tempRoots.push(dir);
  return dir;
}

function makeSkill(root: string, name: string): string {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\n`);
  return skillDir;
}

afterEach(() => {
  clearManagedSkillRootCache();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveManagedSkillRoot', () => {
  it('ships the validation skills required by the live proof harness', () => {
    const bundledRoot = path.join(process.cwd(), 'container', 'skills');

    expect(fs.existsSync(path.join(bundledRoot, 'status', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(bundledRoot, 'FullQAPass', 'SKILL.md'))).toBe(true);
  });

  it('keeps FullQAPass aligned with the v2 scheduling MCP contract', () => {
    const skillPath = path.join(process.cwd(), 'container', 'skills', 'FullQAPass', 'SKILL.md');
    const body = fs.readFileSync(skillPath, 'utf8');

    expect(body).toContain('mcp__nanoclaw__schedule_task');
    expect(body).toContain('session routing');
    expect(body).not.toContain('/workspace/ipc/available_groups.json');
    expect(body).not.toContain('target_group_jid');
  });

  it('merges bundled, managed, and portable skills into one root', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const managedRoot = makeTempDir();
    const writableRoot = makeTempDir();

    const bundledSkill = makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    const managedSkill = makeSkill(managedRoot, 'managed-one');
    const portableSkill = makeSkill(path.join(writableRoot, 'skills'), 'portable-one');

    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: {
        NANOCLAW_MANAGED_SKILLS_DIRS: managedRoot,
        NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot,
      },
    });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['bundled-one', 'managed-one', 'portable-one']);
    expect(result.root).toContain(path.join(dataDir, '.nanoclaw-skills-'));
    expect(fs.lstatSync(path.join(result.root, 'bundled-one')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(result.root, 'managed-one')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(result.root, 'portable-one')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(result.root, 'bundled-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(bundledSkill, 'SKILL.md'), 'utf8'),
    );
    expect(fs.readFileSync(path.join(result.root, 'managed-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(managedSkill, 'SKILL.md'), 'utf8'),
    );
    expect(fs.readFileSync(path.join(result.root, 'portable-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(portableSkill, 'SKILL.md'), 'utf8'),
    );
  });

  it('gives each spawn an isolated root', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');

    const first = resolveManagedSkillRoot({ projectRoot, dataDir });
    const second = resolveManagedSkillRoot({ projectRoot, dataDir });

    // Each spawn gets a unique root — no sharing, no races
    expect(first.root).not.toBe(second.root);
    expect(first.skills.map((s) => s.name)).toEqual(['bundled-one']);
    expect(second.skills.map((s) => s.name)).toEqual(['bundled-one']);
  });

  it('picks up skill changes between spawns (fresh copy each time)', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const writableRoot = makeTempDir();
    const portableSkillsRoot = path.join(writableRoot, 'skills');

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    makeSkill(portableSkillsRoot, 'portable-alpha');

    const env = { NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot };

    const first = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(first.skills.map((s) => s.name).sort()).toEqual(['bundled-one', 'portable-alpha']);

    // Add a new portable skill between spawns
    makeSkill(portableSkillsRoot, 'portable-beta');

    const second = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(second.skills.map((s) => s.name).sort()).toEqual(['bundled-one', 'portable-alpha', 'portable-beta']);
    expect(fs.existsSync(path.join(second.root, 'portable-beta', 'SKILL.md'))).toBe(true);
  });

  it('reflects removed skills on next spawn', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const writableRoot = makeTempDir();
    const portableSkillsRoot = path.join(writableRoot, 'skills');

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    const portableAlpha = makeSkill(portableSkillsRoot, 'portable-alpha');
    makeSkill(portableSkillsRoot, 'portable-beta');

    const env = { NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot };
    const first = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(first.skills.length).toBe(3);

    fs.rmSync(portableAlpha, { recursive: true, force: true });

    const second = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(second.skills.map((s) => s.name).sort()).toEqual(['bundled-one', 'portable-beta']);
  });

  it('throws on duplicate skill names and names both source paths', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const managedRoot = makeTempDir();
    const bundledDuplicate = makeSkill(path.join(projectRoot, 'container', 'skills'), 'duplicate');
    const managedDuplicate = makeSkill(managedRoot, 'duplicate');

    expect(() =>
      resolveManagedSkillRoot({
        projectRoot,
        dataDir,
        env: { NANOCLAW_MANAGED_SKILLS_DIRS: managedRoot },
      }),
    ).toThrow(`Duplicate skill name "duplicate" from ${managedDuplicate}; already provided by ${bundledDuplicate}`);
  });

  it('does not treat the writable portable skills root as a duplicate managed root', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const writableRoot = makeTempDir();
    const portableSkillsRoot = path.join(writableRoot, 'skills');
    const portableSkill = makeSkill(portableSkillsRoot, 'portable-one');

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');

    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: {
        NANOCLAW_MANAGED_SKILLS_DIRS: portableSkillsRoot,
        NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot,
      },
    });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['bundled-one', 'portable-one']);
    expect(fs.readFileSync(path.join(result.root, 'portable-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(portableSkill, 'SKILL.md'), 'utf8'),
    );
  });

  it('throws when a configured managed root is missing', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const missingRoot = path.join(makeTempDir(), 'missing');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');

    expect(() =>
      resolveManagedSkillRoot({
        projectRoot,
        dataDir,
        env: { NANOCLAW_MANAGED_SKILLS_DIRS: missingRoot },
      }),
    ).toThrow(`Configured managed skills root does not exist: ${missingRoot}`);
  });
});

describe('syncManagedSkillSymlinks', () => {
  it('links enabled skills to their container paths under .claude-shared', () => {
    const skillRoot = makeTempDir();
    const claudeDir = makeTempDir();
    makeSkill(skillRoot, 'alpha');
    makeSkill(skillRoot, 'beta');

    syncManagedSkillSymlinks({ claudeDir, skillRoot, selection: 'all' });

    expect(fs.lstatSync(path.join(claudeDir, 'skills', 'alpha')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'alpha'))).toBe('/app/skills/alpha');
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'beta'))).toBe('/app/skills/beta');
  });
});
