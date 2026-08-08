import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearManagedSkillRootCache,
  cleanupStaleTempRoots,
  computeManagedSkillGeneration,
  createManagedSkillTempRoot,
  currentManagedSkillGeneration,
  managedSkillRootsFromEnv,
  readSkillRuntimeRequirements,
  resolveManagedSkillRoot,
  syncManagedSkillSymlinks,
} from './managed-skills.js';

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

function makeExecutable(filePath: string, body = '#!/usr/bin/env bash\nprintf ok\\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  clearManagedSkillRootCache();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveManagedSkillRoot', () => {
  it('uses one validated, de-duplicated effective inventory for all and explicit selections', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const bundledRoot = path.join(projectRoot, 'container', 'skills');
    makeSkill(bundledRoot, 'status');
    makeSkill(bundledRoot, 'gws-calendar');
    makeSkill(bundledRoot, 'gws-drive');
    makeSkill(bundledRoot, 'gws-gmail');

    const all = resolveManagedSkillRoot({ projectRoot, dataDir, selection: 'all' });
    const restricted = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      selection: ['status', 'gws-drive', 'status'],
    });

    expect(all.skills.map((skill) => skill.name)).toEqual(['gws-calendar', 'gws-drive', 'gws-gmail', 'status']);
    expect(restricted.skills.map((skill) => skill.name)).toEqual(['gws-calendar', 'gws-drive', 'gws-gmail', 'status']);
    expect(fs.existsSync(path.join(restricted.root, 'status'))).toBe(true);
    expect(fs.existsSync(path.join(restricted.root, 'gws-drive', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(restricted.root, 'gws-gmail', 'SKILL.md'))).toBe(true);
  });

  it('fails closed when an explicit effective inventory names an unavailable skill', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'gws-drive');

    expect(() => resolveManagedSkillRoot({ projectRoot, dataDir, selection: ['gws-drive', 'gws-missing'] })).toThrow(
      'Configured skill "gws-missing" is not available',
    );
  });

  it('assembles the same selected GWS inventory for every provider and threaded runtime row', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const bundledRoot = path.join(projectRoot, 'container', 'skills');
    for (const skill of ['gws-drive', 'gws-gmail', 'gws-calendar', 'status']) makeSkill(bundledRoot, skill);

    const rows = [
      ['claude/all', 'all'],
      ['codex/all', 'all'],
      ['opencode/all', 'all'],
      ['claude/restricted', ['status', 'gws-drive', 'status']],
      ['codex/restricted', ['status', 'gws-drive', 'status']],
      ['opencode/restricted', ['status', 'gws-drive', 'status']],
      ['threaded/restricted', ['status', 'gws-drive', 'status']],
    ] as const;

    const inventories = new Map<string, string[]>();
    for (const [runtime, selection] of rows) {
      const resolved = resolveManagedSkillRoot({
        projectRoot,
        dataDir,
        selection: selection === 'all' ? 'all' : [...selection],
      });
      inventories.set(
        runtime,
        resolved.skills.map((skill) => skill.name).filter((name) => name.startsWith('gws-')),
      );
    }

    for (const runtime of ['claude/all', 'codex/all', 'opencode/all']) {
      expect(inventories.get(runtime)).toEqual(['gws-calendar', 'gws-drive', 'gws-gmail']);
    }
    for (const runtime of ['claude/restricted', 'codex/restricted', 'opencode/restricted', 'threaded/restricted']) {
      expect(inventories.get(runtime)).toEqual(['gws-calendar', 'gws-drive', 'gws-gmail']);
    }
  });

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

  it('ships the local-skill publish workflow as a skill-local CLI helper', () => {
    const result = resolveManagedSkillRoot({
      projectRoot: process.cwd(),
      dataDir: makeTempDir(),
      env: {},
    });

    expect(result.skills.map((skill) => skill.name)).toContain('local-skills');
    expect(fs.lstatSync(path.join(result.root, '.bin', 'publish-local-skill')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(result.root, '.bin', 'publish-local-skill'))).toBe(
      '../local-skills/scripts/publish-local-skill',
    );
  });

  it('merges bundled, managed, and local skills into one root', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const managedRoot = makeTempDir();
    const writableRoot = makeTempDir();

    const bundledSkill = makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    const managedSkill = makeSkill(managedRoot, 'managed-one');
    const localSkill = makeSkill(path.join(writableRoot, 'skills'), 'local-one');

    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: {
        NANOCLAW_MANAGED_SKILLS_DIRS: managedRoot,
        NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot,
      },
    });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['bundled-one', 'local-one', 'managed-one']);
    expect(result.root).toContain(path.join(dataDir, '.nanoclaw-skills-'));
    expect(fs.lstatSync(path.join(result.root, 'bundled-one')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(result.root, 'managed-one')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(result.root, 'local-one')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(result.root, 'bundled-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(bundledSkill, 'SKILL.md'), 'utf8'),
    );
    expect(fs.readFileSync(path.join(result.root, 'managed-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(managedSkill, 'SKILL.md'), 'utf8'),
    );
    expect(fs.readFileSync(path.join(result.root, 'local-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(localSkill, 'SKILL.md'), 'utf8'),
    );
  });

  it('synthesizes .bin helpers from the deploy manifest in the merged root', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const managedRoot = makeTempDir();

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    const familiar = makeSkill(managedRoot, 'using-familiar');
    const flight = makeSkill(managedRoot, 'pp-flight-goat');
    makeExecutable(path.join(familiar, 'scripts', 'familiar'));
    makeExecutable(path.join(flight, 'scripts', 'flight-goat-pp-cli'));
    fs.writeFileSync(
      path.join(managedRoot, 'skill-runtime-manifest.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { name: 'using-familiar', skillLocalBins: { familiar: { containerPath: '/app/skills/.bin/familiar' } } },
          {
            name: 'pp-flight-goat',
            skillLocalBins: {
              'flight-goat-pp-cli': { containerPath: '/app/skills/.bin/flight-goat-pp-cli' },
            },
          },
        ],
      }),
    );

    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: { NANOCLAW_MANAGED_SKILLS_DIRS: managedRoot },
    });

    expect(fs.existsSync(path.join(result.root, 'skill-runtime-manifest.json'))).toBe(true);
    expect(fs.lstatSync(path.join(result.root, '.bin', 'familiar')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(result.root, '.bin', 'familiar'))).toBe('../using-familiar/scripts/familiar');
    expect(fs.lstatSync(path.join(result.root, '.bin', 'flight-goat-pp-cli')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(result.root, '.bin', 'flight-goat-pp-cli'))).toBe(
      '../pp-flight-goat/scripts/flight-goat-pp-cli',
    );
  });

  it('validates writable local skill helper declarations on each merge', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const writableRoot = makeTempDir();
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    const local = makeSkill(path.join(writableRoot, 'skills'), 'local-tool');
    fs.writeFileSync(path.join(local, 'SKILL.md'), `---\nname: local-tool\nbins: ["local-tool"]\n---\n# Local Tool\n`);

    expect(() =>
      resolveManagedSkillRoot({
        projectRoot,
        dataDir,
        env: { NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot },
      }),
    ).toThrow('declares helper "local-tool" but executable script is missing');

    makeExecutable(path.join(local, 'scripts', 'local-tool'));
    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: { NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot },
    });
    expect(fs.lstatSync(path.join(result.root, '.bin', 'local-tool')).isSymbolicLink()).toBe(true);
  });

  it('spawns cleanly when bins appear only nested under informational metadata (last30days regression)', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const skillDir = makeSkill(path.join(projectRoot, 'container', 'skills'), 'last30days');
    // Modeled on upstream mvanhorn/last30days-skill frontmatter: the nested
    // metadata.openclaw.requires.bins list is informational for OpenClaw.
    // There is deliberately NO scripts/node or scripts/python3 — before the
    // fix, resolveManagedSkillRoot threw 'Skill "last30days" declares helper
    // "node" but executable script is missing' and every spawn failed
    // (shapiroserver2 kata 23ma, 2026-08-07 fleet outage).
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: last30days\ndescription: Research the last 30 days of a topic.\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - node\n        - python3\n---\n# last30days\n`,
    );

    const result = resolveManagedSkillRoot({ projectRoot, dataDir });

    expect(result.skills.find((entry) => entry.name === 'last30days')?.requirements).toEqual({
      skillLocalBins: [],
      runtimeBins: [],
      baseCommands: [],
    });
    expect(fs.existsSync(path.join(result.root, '.bin'))).toBe(false);
  });

  it('treats gws as a runtime shim and base commands outside .bin', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const local = makeSkill(path.join(projectRoot, 'container', 'skills'), 'gws-like');
    fs.writeFileSync(
      path.join(local, 'SKILL.md'),
      `---\nname: gws-like\nbins:\n  - gws\nbaseCommands: ["bash", "node"]\n---\n# GWS Like\n`,
    );

    const result = resolveManagedSkillRoot({ projectRoot, dataDir });

    expect(fs.existsSync(path.join(result.root, '.bin', 'gws'))).toBe(false);
    expect(result.skills.find((skill) => skill.name === 'gws-like')?.requirements).toEqual({
      skillLocalBins: [],
      runtimeBins: ['gws'],
      baseCommands: ['bash', 'node'],
    });
  });

  it('fails closed for unknown runtime shims and base commands', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const skill = makeSkill(path.join(projectRoot, 'container', 'skills'), 'bad-runtime');
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: bad-runtime\nruntimeBins: ["not-a-shim"]\n---\n# Bad\n`);

    expect(() => resolveManagedSkillRoot({ projectRoot, dataDir })).toThrow(
      'Skill "bad-runtime" declares unknown runtime shim "not-a-shim"',
    );

    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: bad-runtime\nbaseCommands: ["gcc"]\n---\n# Bad\n`);
    expect(() => resolveManagedSkillRoot({ projectRoot, dataDir })).toThrow(
      'Skill "bad-runtime" declares unknown base runtime command "gcc"',
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
    const localSkillsRoot = path.join(writableRoot, 'skills');

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    makeSkill(localSkillsRoot, 'local-alpha');

    const env = { NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot };

    const first = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(first.skills.map((s) => s.name).sort()).toEqual(['bundled-one', 'local-alpha']);

    // Add a new local skill between spawns
    makeSkill(localSkillsRoot, 'local-beta');

    const second = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(second.skills.map((s) => s.name).sort()).toEqual(['bundled-one', 'local-alpha', 'local-beta']);
    expect(fs.existsSync(path.join(second.root, 'local-beta', 'SKILL.md'))).toBe(true);
  });

  it('reflects removed skills on next spawn', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const writableRoot = makeTempDir();
    const localSkillsRoot = path.join(writableRoot, 'skills');

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    const localAlpha = makeSkill(localSkillsRoot, 'local-alpha');
    makeSkill(localSkillsRoot, 'local-beta');

    const env = { NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot };
    const first = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(first.skills.length).toBe(3);

    fs.rmSync(localAlpha, { recursive: true, force: true });

    const second = resolveManagedSkillRoot({ projectRoot, dataDir, env });
    expect(second.skills.map((s) => s.name).sort()).toEqual(['bundled-one', 'local-beta']);
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

  it('does not treat the writable local skills root as a duplicate managed root', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const writableRoot = makeTempDir();
    const localSkillsRoot = path.join(writableRoot, 'skills');
    const localSkill = makeSkill(localSkillsRoot, 'local-one');

    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');

    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: {
        NANOCLAW_MANAGED_SKILLS_DIRS: localSkillsRoot,
        NANOCLAW_WRITABLE_SKILLS_DIR: writableRoot,
      },
    });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['bundled-one', 'local-one']);
    expect(fs.readFileSync(path.join(result.root, 'local-one', 'SKILL.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(localSkill, 'SKILL.md'), 'utf8'),
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

describe('managed skill temp root cleanup', () => {
  it('does not remove roots owned by the current process', () => {
    const dataDir = makeTempDir();
    const root = createManagedSkillTempRoot(dataDir);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(root, old, old);

    cleanupStaleTempRoots(dataDir);

    expect(fs.existsSync(root)).toBe(true);
  });

  it('does not remove recent roots without an owner marker', () => {
    const dataDir = makeTempDir();
    const root = fs.mkdtempSync(path.join(dataDir, '.nanoclaw-skills-'));

    cleanupStaleTempRoots(dataDir);

    expect(fs.existsSync(root)).toBe(true);
  });

  it('removes old roots without a live owner marker', () => {
    const dataDir = makeTempDir();
    const root = fs.mkdtempSync(path.join(dataDir, '.nanoclaw-skills-'));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(root, old, old);

    cleanupStaleTempRoots(dataDir);

    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('syncManagedSkillSymlinks', () => {
  it('links enabled skills to their container paths under .claude-shared', () => {
    const skillRoot = makeTempDir();
    const claudeDir = makeTempDir();
    makeSkill(skillRoot, 'alpha');
    makeSkill(skillRoot, 'beta');

    syncManagedSkillSymlinks({ claudeDir, skillNames: ['alpha', 'beta'] });

    expect(fs.lstatSync(path.join(claudeDir, 'skills', 'alpha')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'alpha'))).toBe('/app/skills/alpha');
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'beta'))).toBe('/app/skills/beta');
  });
});

describe('managed skill generation (content digest)', () => {
  it('is deterministic for identical content', () => {
    const a = makeTempDir();
    makeSkill(a, 'alpha');
    expect(computeManagedSkillGeneration([a])).toBe(computeManagedSkillGeneration([a]));
  });

  it("depends only on content, not the root's absolute path", () => {
    const a = makeTempDir();
    const b = makeTempDir();
    makeSkill(a, 'alpha'); // both create <root>/alpha/SKILL.md with identical content
    makeSkill(b, 'alpha');
    expect(computeManagedSkillGeneration([a])).toBe(computeManagedSkillGeneration([b]));
  });

  it('changes when a skill is added to the FIRST managed root', () => {
    const a = makeTempDir();
    makeSkill(a, 'alpha');
    const before = computeManagedSkillGeneration([a]);
    makeSkill(a, 'beta');
    expect(computeManagedSkillGeneration([a])).not.toBe(before);
  });

  // Regression for the shipped bug: the local-skills root is the SECOND managed
  // root and never carried a `.skill-generation` marker, so deploying a local
  // skill (e.g. ntfy) left the generation unchanged and long-lived sessions
  // never recycled to pick it up. A content digest MUST react to it.
  it('changes when a skill is added to the SECOND (local) managed root', () => {
    const shared = makeTempDir();
    const local = makeTempDir();
    makeSkill(shared, 'alpha');
    const before = computeManagedSkillGeneration([shared, local]);
    makeSkill(local, 'ntfy');
    expect(computeManagedSkillGeneration([shared, local])).not.toBe(before);
  });

  it("changes when an existing skill's body changes", () => {
    const a = makeTempDir();
    const skill = makeSkill(a, 'alpha');
    const before = computeManagedSkillGeneration([a]);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '# alpha\nedited body\n');
    expect(computeManagedSkillGeneration([a])).not.toBe(before);
  });

  it('changes when a nested file inside a skill changes (recurses subdirectories)', () => {
    const a = makeTempDir();
    const skill = makeSkill(a, 'alpha');
    const before = computeManagedSkillGeneration([a]);
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'scripts', 'helper.sh'), '#!/bin/bash\necho hi\n');
    expect(computeManagedSkillGeneration([a])).not.toBe(before);
  });

  it('ignores the .skill-generation marker and skill-runtime-manifest.json', () => {
    const a = makeTempDir();
    makeSkill(a, 'alpha');
    const before = computeManagedSkillGeneration([a]);
    fs.writeFileSync(path.join(a, '.skill-generation'), 'deadbeef\n');
    fs.writeFileSync(path.join(a, 'skill-runtime-manifest.json'), '{"generatedAt":"2026-06-08T00:00:00Z"}\n');
    expect(computeManagedSkillGeneration([a])).toBe(before);
  });

  it('skips a non-existent root and returns empty when all roots are missing', () => {
    const missing = path.join(makeTempDir(), 'does-not-exist');
    expect(computeManagedSkillGeneration([missing])).toBe('');
  });

  it('managedSkillRootsFromEnv splits NANOCLAW_MANAGED_SKILLS_DIRS on the path delimiter', () => {
    const a = makeTempDir();
    const b = makeTempDir();
    expect(managedSkillRootsFromEnv({ NANOCLAW_MANAGED_SKILLS_DIRS: `${a}${path.delimiter}${b}` })).toEqual([a, b]);
    expect(managedSkillRootsFromEnv({})).toEqual([]);
  });

  it('currentManagedSkillGeneration digests the env-configured managed roots', () => {
    const a = makeTempDir();
    makeSkill(a, 'alpha');
    expect(currentManagedSkillGeneration({ NANOCLAW_MANAGED_SKILLS_DIRS: a })).toBe(computeManagedSkillGeneration([a]));
  });

  it('resolveManagedSkillRoot returns the content-digest generation of its managed roots', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const managedRoot = makeTempDir();
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'bundled-one');
    makeSkill(managedRoot, 'managed-one');

    const result = resolveManagedSkillRoot({
      projectRoot,
      dataDir,
      env: { NANOCLAW_MANAGED_SKILLS_DIRS: managedRoot },
    });

    // Generation covers ONLY the env managed roots, not the bundled source.
    expect(result.generation).toBe(computeManagedSkillGeneration([managedRoot]));
    expect(result.generation).not.toBe('');
  });
});
describe('readSkillRuntimeRequirements', () => {
  function writeSkillMd(contents: string): string {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'SKILL.md'), contents);
    return dir;
  }

  it('ignores bin keys nested under informational metadata at any depth', () => {
    // Real-world shape from upstream mvanhorn/last30days-skill (kata 23ma).
    const dir = writeSkillMd(
      `---\nname: last30days\ndescription: Research the last 30 days of a topic.\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - node\n        - python3\n---\n# last30days\n`,
    );

    expect(readSkillRuntimeRequirements(dir)).toEqual({
      skillLocalBins: [],
      runtimeBins: [],
      baseCommands: [],
    });
  });

  it('parses top-level bins in block and inline forms', () => {
    const block = writeSkillMd(`---\nname: t\nbins:\n  - helper-a\n  - gws\n---\n# t\n`);
    expect(readSkillRuntimeRequirements(block)).toEqual({
      skillLocalBins: ['helper-a'],
      runtimeBins: ['gws'],
      baseCommands: [],
    });

    const inline = writeSkillMd(`---\nname: t\nbins: ["helper-a", "gws"]\n---\n# t\n`);
    expect(readSkillRuntimeRequirements(inline)).toEqual({
      skillLocalBins: ['helper-a'],
      runtimeBins: ['gws'],
      baseCommands: [],
    });
  });

  it('parses top-level skillLocalBins and skill_local_bins in block and inline forms', () => {
    const block = writeSkillMd(
      `---\nname: t\nskillLocalBins:\n  - helper-a\nskill_local_bins:\n  - helper-b\n---\n# t\n`,
    );
    expect(readSkillRuntimeRequirements(block)).toEqual({
      skillLocalBins: ['helper-a', 'helper-b'],
      runtimeBins: [],
      baseCommands: [],
    });

    const inline = writeSkillMd(
      `---\nname: t\nskillLocalBins: ["helper-a"]\nskill_local_bins: ["helper-b"]\n---\n# t\n`,
    );
    expect(readSkillRuntimeRequirements(inline)).toEqual({
      skillLocalBins: ['helper-a', 'helper-b'],
      runtimeBins: [],
      baseCommands: [],
    });
  });

  it('parses top-level runtimeBins and baseCommands (and snake_case aliases) in block and inline forms', () => {
    const block = writeSkillMd(`---\nname: t\nruntimeBins:\n  - gws\nbaseCommands:\n  - bash\n  - node\n---\n# t\n`);
    expect(readSkillRuntimeRequirements(block)).toEqual({
      skillLocalBins: [],
      runtimeBins: ['gws'],
      baseCommands: ['bash', 'node'],
    });

    const inline = writeSkillMd(`---\nname: t\nruntime_bins: ["gws"]\nbase_commands: ["bash", "node"]\n---\n# t\n`);
    expect(readSkillRuntimeRequirements(inline)).toEqual({
      skillLocalBins: [],
      runtimeBins: ['gws'],
      baseCommands: ['bash', 'node'],
    });
  });

  it('does not double-count a nested key shadowing a top-level key of the same name', () => {
    const dir = writeSkillMd(
      `---\nname: t\nbins: ["jq-helper"]\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - node\n        - python3\n---\n# t\n`,
    );

    expect(readSkillRuntimeRequirements(dir)).toEqual({
      skillLocalBins: ['jq-helper'],
      runtimeBins: [],
      baseCommands: [],
    });
  });

  it('ignores a nested gws runtime-shim declaration (fleet gws-* skills parse to empty)', () => {
    // Real-world shape shared by the 25 deployed gws-* skills
    // (gws-shared/SKILL.md): nested metadata.openclaw.requires.bins ["gws"]
    // at indent 6. Before the fix this parsed to runtimeBins ['gws']; that
    // entry was validation-only and the gws shim is image-provided at
    // /usr/local/bin/gws, so the correct post-fix result is empty.
    const dir = writeSkillMd(
      `---\nname: gws-mail\ndescription: GWS mail helper.\nmetadata:\n  openclaw:\n    requires:\n      bins: ["gws"]\n---\n# gws-mail\n`,
    );

    expect(readSkillRuntimeRequirements(dir)).toEqual({
      skillLocalBins: [],
      runtimeBins: [],
      baseCommands: [],
    });
  });
});
