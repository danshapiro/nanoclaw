import fs from 'fs';
import path from 'path';

import type { SkillSelection } from '../container-config.js';

export interface ManagedSkill {
  name: string;
  sourcePath: string;
  mergedPath: string;
  sourceKind: 'bundled' | 'managed' | 'portable';
}

export interface ManagedSkillRoot {
  root: string;
  skills: ManagedSkill[];
}

interface SkillRootSource {
  kind: ManagedSkill['sourceKind'];
  root: string;
}

export function resolveManagedSkillRoot(args: {
  projectRoot: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): ManagedSkillRoot {
  const env = args.env ?? process.env;
  const mergedRoot = path.join(args.dataDir, 'managed-skills');
  const sources = collectSkillRootSources(args.projectRoot, env);
  const skillsByName = new Map<string, ManagedSkill>();
  const seenSourceRoots = new Set<string>();

  for (const source of sources) {
    assertSkillRootExists(source);
    const sourceRootKey = fs.realpathSync(source.root);
    if (seenSourceRoots.has(sourceRootKey)) {
      continue;
    }
    seenSourceRoots.add(sourceRootKey);
    for (const skill of listSkillSourceDirs(source.root)) {
      const existing = skillsByName.get(skill.name);
      if (existing) {
        throw new Error(
          `Duplicate skill name "${skill.name}" from ${skill.sourcePath}; already provided by ${existing.sourcePath}`,
        );
      }
      skillsByName.set(skill.name, {
        name: skill.name,
        sourcePath: skill.sourcePath,
        mergedPath: path.join(mergedRoot, skill.name),
        sourceKind: source.kind,
      });
    }
  }

  const skills = [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  refreshMergedRoot(mergedRoot, skills);
  return { root: mergedRoot, skills };
}

export function syncManagedSkillSymlinks(args: {
  claudeDir: string;
  skillRoot: string;
  selection: SkillSelection;
}): void {
  const skillsDir = path.join(args.claudeDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  const available = new Set(listSkillNames(args.skillRoot));
  const desired = args.selection === 'all' ? [...available].sort() : args.selection;

  for (const skill of desired) {
    if (!available.has(skill)) {
      throw new Error(`Configured skill "${skill}" is not available in managed skill root: ${args.skillRoot}`);
    }
  }

  const desiredSet = new Set(desired);
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    const stat = fs.lstatSync(entryPath);
    if (!desiredSet.has(entry)) {
      if (!stat.isSymbolicLink()) {
        throw new Error(`Unexpected non-symlink entry in managed skill symlink directory: ${entryPath}`);
      }
      fs.unlinkSync(entryPath);
    }
  }

  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    const target = `/app/skills/${skill}`;
    if (fs.existsSync(linkPath) || pathExistsNoFollow(linkPath)) {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        throw new Error(`Cannot create skill symlink because path exists and is not a symlink: ${linkPath}`);
      }
      if (fs.readlinkSync(linkPath) === target) continue;
      fs.unlinkSync(linkPath);
    }
    fs.symlinkSync(target, linkPath);
  }
}

function collectSkillRootSources(projectRoot: string, env: NodeJS.ProcessEnv): SkillRootSource[] {
  const sources: SkillRootSource[] = [{ kind: 'bundled', root: path.join(projectRoot, 'container', 'skills') }];

  for (const root of splitPathList(env.NANOCLAW_MANAGED_SKILLS_DIRS)) {
    sources.push({ kind: 'managed', root });
  }

  const writableSkillsDir = env.NANOCLAW_WRITABLE_SKILLS_DIR?.trim();
  if (writableSkillsDir) {
    sources.push({ kind: 'portable', root: path.join(writableSkillsDir, 'skills') });
  }

  return sources;
}

function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertSkillRootExists(source: SkillRootSource): void {
  if (fs.existsSync(source.root) && fs.statSync(source.root).isDirectory()) return;
  if (source.kind === 'bundled') {
    throw new Error(`Bundled skills root does not exist: ${source.root}`);
  }
  if (source.kind === 'portable') {
    throw new Error(`Configured portable skills root does not exist: ${source.root}`);
  }
  throw new Error(`Configured managed skills root does not exist: ${source.root}`);
}

function listSkillSourceDirs(root: string): Array<{ name: string; sourcePath: string }> {
  return fs
    .readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ name, sourcePath: path.join(root, name) }))
    .filter((skill) => isDirectory(skill.sourcePath));
}

function listSkillNames(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => isDirectory(path.join(root, name)))
    .sort();
}

function isDirectory(entryPath: string): boolean {
  if (!fs.existsSync(entryPath)) return false;
  return fs.statSync(entryPath).isDirectory();
}

function refreshMergedRoot(root: string, skills: ManagedSkill[]): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const skill of skills) {
    fs.cpSync(skill.sourcePath, skill.mergedPath, { recursive: true, dereference: true });
  }
}

function pathExistsNoFollow(entryPath: string): boolean {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
