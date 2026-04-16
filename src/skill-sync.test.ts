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

function writeDirectory(
  rootDir: string,
  dirName: string,
  filename: string,
  contents: string,
): void {
  const dirPath = path.join(rootDir, dirName);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, filename), contents);
}

function readSkill(rootDir: string, skillName: string): string {
  return fs.readFileSync(path.join(rootDir, skillName, 'SKILL.md'), 'utf8');
}

function readManifest(manifestPath: string): Record<string, string[]> {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
    string,
    string[]
  >;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('syncAgentSkills', () => {
  it('copies built-in, gws, and portable skills and records ownership by source root', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const managedGwsSkillsDir = path.join(rootDir, 'managed-gws');
    const portableSkillsDir = path.join(rootDir, 'portable-skills');
    const destinationDir = path.join(rootDir, 'group-skills');
    const manifestPath = path.join(rootDir, '.nanoclaw-managed-skills.json');

    writeSkill(bundledSkillsDir, 'status', 'bundled status');
    writeSkill(bundledSkillsDir, 'agent-browser', 'bundled browser');
    writeSkill(managedGwsSkillsDir, 'gws-gmail', 'managed gmail');
    writeSkill(portableSkillsDir, 'large-outputs', 'portable large outputs');
    writeSkill(destinationDir, 'using-familiar', 'service-owned familiar');
    writeSkill(destinationDir, 'agent-browser', 'stale bundled browser');
    writeSkill(destinationDir, 'gws-gmail', 'stale managed gmail');
    writeSkill(destinationDir, 'large-outputs', 'stale portable outputs');

    syncAgentSkills({
      sourceRoots: [
        bundledSkillsDir,
        managedGwsSkillsDir,
        portableSkillsDir,
      ],
      destinationDir,
      manifestPath,
    });

    expect(readSkill(destinationDir, 'status')).toBe('bundled status');
    expect(readSkill(destinationDir, 'agent-browser')).toBe('bundled browser');
    expect(readSkill(destinationDir, 'gws-gmail')).toBe('managed gmail');
    expect(readSkill(destinationDir, 'large-outputs')).toBe(
      'portable large outputs',
    );
    expect(readSkill(destinationDir, 'using-familiar')).toBe(
      'service-owned familiar',
    );
    expect(readManifest(manifestPath)).toEqual({
      [bundledSkillsDir]: ['agent-browser', 'status'],
      [managedGwsSkillsDir]: ['gws-gmail'],
      [portableSkillsDir]: ['large-outputs'],
    });
  });

  it('adopts legacy managed-cache directories on first sync when no manifest exists', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const managedGwsSkillsDir = path.join(rootDir, 'managed-gws');
    const portableSkillsDir = path.join(rootDir, 'portable-skills');
    const destinationDir = path.join(rootDir, 'group-skills');
    const manifestPath = path.join(rootDir, '.nanoclaw-managed-skills.json');

    writeSkill(bundledSkillsDir, 'agent-browser', 'bundled browser');
    writeSkill(managedGwsSkillsDir, 'gws-gmail', 'managed gmail');
    writeSkill(portableSkillsDir, 'large-outputs', 'portable large outputs');
    writeSkill(destinationDir, 'using-familiar', 'service-owned familiar');
    writeSkill(destinationDir, 'agent-browser', 'legacy browser');
    writeSkill(destinationDir, 'gws-gmail', 'legacy gmail');
    writeSkill(destinationDir, 'large-outputs', 'legacy outputs');

    syncAgentSkills({
      sourceRoots: [
        bundledSkillsDir,
        managedGwsSkillsDir,
        portableSkillsDir,
      ],
      destinationDir,
      manifestPath,
    });

    expect(readSkill(destinationDir, 'agent-browser')).toBe('bundled browser');
    expect(readSkill(destinationDir, 'gws-gmail')).toBe('managed gmail');
    expect(readSkill(destinationDir, 'large-outputs')).toBe(
      'portable large outputs',
    );
    expect(readSkill(destinationDir, 'using-familiar')).toBe(
      'service-owned familiar',
    );
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('prunes only the skills previously owned by the same source root', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const managedGwsSkillsDir = path.join(rootDir, 'managed-gws');
    const portableSkillsDir = path.join(rootDir, 'portable-skills');
    const destinationDir = path.join(rootDir, 'group-skills');
    const manifestPath = path.join(rootDir, '.nanoclaw-managed-skills.json');

    writeSkill(bundledSkillsDir, 'agent-browser', 'bundled browser');
    writeSkill(managedGwsSkillsDir, 'gws-gmail', 'managed gmail');
    writeSkill(portableSkillsDir, 'large-outputs', 'portable large outputs');
    writeSkill(destinationDir, 'using-familiar', 'service-owned familiar');

    syncAgentSkills({
      sourceRoots: [
        bundledSkillsDir,
        managedGwsSkillsDir,
        portableSkillsDir,
      ],
      destinationDir,
      manifestPath,
    });

    fs.rmSync(path.join(portableSkillsDir, 'large-outputs'), {
      recursive: true,
      force: true,
    });

    syncAgentSkills({
      sourceRoots: [
        bundledSkillsDir,
        managedGwsSkillsDir,
        portableSkillsDir,
      ],
      destinationDir,
      manifestPath,
    });

    expect(readSkill(destinationDir, 'agent-browser')).toBe('bundled browser');
    expect(readSkill(destinationDir, 'gws-gmail')).toBe('managed gmail');
    expect(readSkill(destinationDir, 'using-familiar')).toBe(
      'service-owned familiar',
    );
    expect(fs.existsSync(path.join(destinationDir, 'large-outputs'))).toBe(
      false,
    );
    expect(readManifest(manifestPath)).toEqual({
      [bundledSkillsDir]: ['agent-browser'],
      [managedGwsSkillsDir]: ['gws-gmail'],
      [portableSkillsDir]: [],
    });
  });

  it('ignores directories that do not contain SKILL.md', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const destinationDir = path.join(rootDir, 'group-skills');
    const manifestPath = path.join(rootDir, '.nanoclaw-managed-skills.json');

    writeSkill(bundledSkillsDir, 'agent-browser', 'bundled browser');
    writeDirectory(bundledSkillsDir, 'not-a-skill', 'README.md', 'ignore me');

    syncAgentSkills({
      sourceRoots: [bundledSkillsDir],
      destinationDir,
      manifestPath,
    });

    expect(readSkill(destinationDir, 'agent-browser')).toBe('bundled browser');
    expect(fs.existsSync(path.join(destinationDir, 'not-a-skill'))).toBe(false);
    expect(readManifest(manifestPath)).toEqual({
      [bundledSkillsDir]: ['agent-browser'],
    });
  });

  it('rejects duplicate managed skill names across source roots', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const portableSkillsDir = path.join(rootDir, 'portable-skills');

    writeSkill(bundledSkillsDir, 'large-outputs', 'bundled outputs');
    writeSkill(portableSkillsDir, 'large-outputs', 'portable outputs');

    expect(() =>
      syncAgentSkills({
        sourceRoots: [bundledSkillsDir, portableSkillsDir],
        destinationDir: path.join(rootDir, 'group-skills'),
        manifestPath: path.join(rootDir, '.nanoclaw-managed-skills.json'),
      }),
    ).toThrowError(
      `Managed skill "large-outputs" is provided by multiple source roots: ${bundledSkillsDir}, ${portableSkillsDir}`,
    );
  });

  it('rejects overwriting an unmanaged destination skill after manifest initialization', () => {
    const rootDir = makeTempDir();
    const bundledSkillsDir = path.join(rootDir, 'bundled');
    const portableSkillsDir = path.join(rootDir, 'portable-skills');
    const destinationDir = path.join(rootDir, 'group-skills');
    const manifestPath = path.join(rootDir, '.nanoclaw-managed-skills.json');

    writeSkill(bundledSkillsDir, 'agent-browser', 'bundled browser');

    syncAgentSkills({
      sourceRoots: [bundledSkillsDir],
      destinationDir,
      manifestPath,
    });

    writeSkill(destinationDir, 'large-outputs', 'user-owned large outputs');
    writeSkill(portableSkillsDir, 'large-outputs', 'portable large outputs');

    expect(() =>
      syncAgentSkills({
        sourceRoots: [bundledSkillsDir, portableSkillsDir],
        destinationDir,
        manifestPath,
      }),
    ).toThrowError(
      `Managed skill "large-outputs" would overwrite unmanaged destination directory: ${path.join(destinationDir, 'large-outputs')}`,
    );
  });
});
