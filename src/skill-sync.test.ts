import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncAgentSkills } from './skill-sync.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-skill-sync-'),
  );
  tempRoots.push(tempDir);
  return tempDir;
}

function writeSkill(rootDir: string, skillName: string, body: string): void {
  const skillDir = path.join(rootDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('syncAgentSkills', () => {
  it('copies bundled non-gws skills and managed gws skills', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const managedGwsSkillsDir = path.join(rootDir, 'managed-gws');
    const destinationDir = path.join(rootDir, 'group-skills');

    writeSkill(bundledSkillsDir, 'status', 'bundled status');
    writeSkill(bundledSkillsDir, 'agent-browser', 'bundled browser');
    writeSkill(bundledSkillsDir, 'gws-gmail', 'bundled gws should be ignored');
    writeSkill(managedGwsSkillsDir, 'gws-gmail', 'managed gmail');
    writeSkill(managedGwsSkillsDir, 'gws-shared', 'managed shared');
    writeSkill(destinationDir, 'using-familiar', 'keep existing familiar');
    writeSkill(destinationDir, 'gws-stale', 'remove stale gws');

    syncAgentSkills({
      bundledSkillsDir,
      managedGwsSkillsDir,
      destinationDir,
    });

    expect(
      fs.readFileSync(path.join(destinationDir, 'status', 'SKILL.md'), 'utf8'),
    ).toBe('bundled status');
    expect(
      fs.readFileSync(
        path.join(destinationDir, 'agent-browser', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('bundled browser');
    expect(
      fs.readFileSync(
        path.join(destinationDir, 'gws-gmail', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('managed gmail');
    expect(
      fs.readFileSync(
        path.join(destinationDir, 'gws-shared', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('managed shared');
    expect(
      fs.readFileSync(
        path.join(destinationDir, 'using-familiar', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('keep existing familiar');
    expect(fs.existsSync(path.join(destinationDir, 'gws-stale'))).toBe(false);
  });

  it('throws when the managed gws skill directory is missing', () => {
    const rootDir = makeTempDir();

    writeSkill(path.join(rootDir, 'bundled'), 'status', 'bundled status');

    expect(() =>
      syncAgentSkills({
        bundledSkillsDir: path.join(rootDir, 'bundled'),
        managedGwsSkillsDir: path.join(rootDir, 'missing-gws'),
        destinationDir: path.join(rootDir, 'group-skills'),
      }),
    ).toThrowError(
      `Managed GWS skills directory does not exist: ${path.join(rootDir, 'missing-gws')}`,
    );
  });

  it('throws when a managed gws skill is missing its SKILL.md', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const managedGwsSkillsDir = path.join(rootDir, 'managed-gws');

    writeSkill(bundledSkillsDir, 'status', 'bundled status');
    fs.mkdirSync(path.join(managedGwsSkillsDir, 'gws-gmail'), {
      recursive: true,
    });

    expect(() =>
      syncAgentSkills({
        bundledSkillsDir,
        managedGwsSkillsDir,
        destinationDir: path.join(rootDir, 'group-skills'),
      }),
    ).toThrowError(
      `Managed GWS skill is missing SKILL.md: ${path.join(managedGwsSkillsDir, 'gws-gmail')}`,
    );
  });
});
