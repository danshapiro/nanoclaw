import fs from 'fs';
import path from 'path';

import type { SkillSelection } from '../container-config.js';

export interface ManagedSkill {
  name: string;
  sourcePath: string;
  mergedPath: string;
  sourceKind: 'bundled' | 'managed' | 'local';
  requirements: SkillRuntimeRequirements;
}

export interface ManagedSkillRoot {
  root: string;
  skills: ManagedSkill[];
}

interface SkillRootSource {
  kind: ManagedSkill['sourceKind'];
  root: string;
}

export interface SkillRuntimeRequirements {
  skillLocalBins: string[];
  runtimeBins: string[];
  baseCommands: string[];
}

interface RuntimeManifestSkill {
  name: string;
  skillLocalBins?: Record<string, unknown>;
  runtimeBins?: Record<string, unknown>;
  baseCommands?: Record<string, unknown>;
}

interface RuntimeManifest {
  skills?: RuntimeManifestSkill[];
}

const RUNTIME_SHIM_BINS = new Set(['gws']);
const BASE_RUNTIME_COMMANDS = new Set(['bash', 'sh', 'node', 'python3', 'agent-browser']);
const SKILL_RUNTIME_MANIFEST = 'skill-runtime-manifest.json';

let _cleanupRan = false;

export function cleanupStaleTempRoots(dataDir: string): void {
  // Run once per process lifetime. Called from buildMounts before any
  // temp roots are created, so it only removes dirs from a prior process.
  if (_cleanupRan) return;
  _cleanupRan = true;

  try {
    for (const entry of fs.readdirSync(dataDir)) {
      if (entry.startsWith('.nanoclaw-skills-')) {
        const dir = path.join(dataDir, entry);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Mount still active or permissions — skip, not fatal.
        }
      }
    }
  } catch {
    // dataDir may not exist yet on first-ever run.
  }
}

export function resolveManagedSkillRoot(args: {
  projectRoot: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  root?: string;
}): ManagedSkillRoot {
  const env = args.env ?? process.env;
  const sources = collectSkillRootSources(args.projectRoot, env);
  const skillsByName = new Map<string, ManagedSkill>();
  const manifestBinsBySkill = new Map<string, Set<string>>();
  const seenSourceRoots = new Set<string>();

  for (const source of sources) {
    assertSkillRootExists(source);
    const sourceRootKey = fs.realpathSync(source.root);
    if (seenSourceRoots.has(sourceRootKey)) {
      continue;
    }
    seenSourceRoots.add(sourceRootKey);
    collectManifestSkillLocalBins(source.root, manifestBinsBySkill);
    for (const skill of listSkillSourceDirs(source.root)) {
      const existing = skillsByName.get(skill.name);
      if (existing) {
        throw new Error(
          `Duplicate skill name "${skill.name}" from ${skill.sourcePath}; already provided by ${existing.sourcePath}`,
        );
      }
      const requirements = readSkillRuntimeRequirements(skill.sourcePath);
      for (const bin of manifestBinsBySkill.get(skill.name) ?? []) {
        addUnique(requirements.skillLocalBins, bin);
      }
      skillsByName.set(skill.name, {
        name: skill.name,
        sourcePath: skill.sourcePath,
        mergedPath: '', // set below
        sourceKind: source.kind,
        requirements,
      });
    }
  }

  const skills = [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Each spawn gets a fresh, isolated merged root. If the caller provides
  // a root path (created externally with its own lifecycle), use it.
  // Otherwise create one under the data directory.
  const root = args.root ?? fs.mkdtempSync(path.join(args.dataDir, '.nanoclaw-skills-'));
  for (const skill of skills) {
    skill.mergedPath = path.join(root, skill.name);
    fs.cpSync(skill.sourcePath, skill.mergedPath, { recursive: true, dereference: true });
  }
  copyRuntimeManifests(sources, root);
  synthesizeSkillBinLinks(root, skills);

  return { root, skills };
}

export function clearManagedSkillRootCache(): void {
  _cleanupRan = false;
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
  const sources: SkillRootSource[] = [];

  // Local sources are added before managed so the realpath dedup
  // classifies overlapping roots as local.
  const writableSkillsDir = env.NANOCLAW_WRITABLE_SKILLS_DIR?.trim();
  if (writableSkillsDir) {
    sources.push({ kind: 'local', root: path.join(writableSkillsDir, 'skills') });
  }

  sources.push({ kind: 'bundled', root: path.join(projectRoot, 'container', 'skills') });

  for (const root of splitPathList(env.NANOCLAW_MANAGED_SKILLS_DIRS)) {
    sources.push({ kind: 'managed', root });
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
  if (source.kind === 'local') {
    throw new Error(`Configured local skills root does not exist: ${source.root}`);
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

function collectManifestSkillLocalBins(root: string, binsBySkill: Map<string, Set<string>>): void {
  const manifestPath = path.join(root, SKILL_RUNTIME_MANIFEST);
  if (!fs.existsSync(manifestPath)) return;
  const manifest = readRuntimeManifest(manifestPath);
  for (const skill of manifest.skills ?? []) {
    if (!skill.name || !skill.skillLocalBins) continue;
    const bins = Object.keys(skill.skillLocalBins);
    if (bins.length === 0) continue;
    const existing = binsBySkill.get(skill.name) ?? new Set<string>();
    for (const bin of bins) existing.add(bin);
    binsBySkill.set(skill.name, existing);
  }
}

function readRuntimeManifest(manifestPath: string): RuntimeManifest {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as RuntimeManifest;
  if (!parsed || typeof parsed !== 'object' || (parsed.skills !== undefined && !Array.isArray(parsed.skills))) {
    throw new Error(`Invalid ${SKILL_RUNTIME_MANIFEST}: ${manifestPath}`);
  }
  return parsed;
}

function copyRuntimeManifests(sources: SkillRootSource[], mergedRoot: string): void {
  const manifests = sources
    .map((source) => path.join(source.root, SKILL_RUNTIME_MANIFEST))
    .filter((file) => fs.existsSync(file));
  if (manifests.length === 0) return;
  if (manifests.length > 1) {
    throw new Error(`Multiple ${SKILL_RUNTIME_MANIFEST} files are not supported in one merged skill root`);
  }
  fs.copyFileSync(manifests[0], path.join(mergedRoot, SKILL_RUNTIME_MANIFEST));
}

function synthesizeSkillBinLinks(root: string, skills: ManagedSkill[]): void {
  const links = new Map<string, { skill: ManagedSkill; scriptPath: string }>();
  for (const skill of skills) {
    validateRuntimeBins(skill);
    validateBaseCommands(skill);
    for (const bin of skill.requirements.skillLocalBins) {
      const scriptPath = path.join(skill.mergedPath, 'scripts', bin);
      if (!isExecutableFile(scriptPath)) {
        throw new Error(
          `Skill "${skill.name}" declares helper "${bin}" but executable script is missing: ${scriptPath}`,
        );
      }
      const existing = links.get(bin);
      if (existing && existing.scriptPath !== scriptPath) {
        throw new Error(
          `Duplicate skill-local helper "${bin}" declared by "${skill.name}" and "${existing.skill.name}"`,
        );
      }
      links.set(bin, { skill, scriptPath });
    }
  }

  if (links.size === 0) return;
  const binDir = path.join(root, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [bin, link] of [...links.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.relative(binDir, link.scriptPath);
    fs.symlinkSync(target, path.join(binDir, bin));
  }
}

function validateRuntimeBins(skill: ManagedSkill): void {
  for (const bin of skill.requirements.runtimeBins) {
    if (!RUNTIME_SHIM_BINS.has(bin)) {
      throw new Error(`Skill "${skill.name}" declares unknown runtime shim "${bin}"`);
    }
  }
}

function validateBaseCommands(skill: ManagedSkill): void {
  for (const command of skill.requirements.baseCommands) {
    if (!BASE_RUNTIME_COMMANDS.has(command)) {
      throw new Error(`Skill "${skill.name}" declares unknown base runtime command "${command}"`);
    }
  }
}

export function readSkillRuntimeRequirements(skillDir: string): SkillRuntimeRequirements {
  const skillMd = path.join(skillDir, 'SKILL.md');
  const requirements: SkillRuntimeRequirements = { skillLocalBins: [], runtimeBins: [], baseCommands: [] };
  if (!fs.existsSync(skillMd)) return requirements;

  const frontmatter = extractFrontmatter(fs.readFileSync(skillMd, 'utf8'));
  if (!frontmatter) return requirements;

  for (const bin of readYamlStringList(frontmatter, 'skillLocalBins')) addUnique(requirements.skillLocalBins, bin);
  for (const bin of readYamlStringList(frontmatter, 'skill_local_bins')) addUnique(requirements.skillLocalBins, bin);
  for (const bin of readYamlStringList(frontmatter, 'runtimeBins')) addUnique(requirements.runtimeBins, bin);
  for (const bin of readYamlStringList(frontmatter, 'runtime_bins')) addUnique(requirements.runtimeBins, bin);
  for (const command of readYamlStringList(frontmatter, 'baseCommands')) addUnique(requirements.baseCommands, command);
  for (const command of readYamlStringList(frontmatter, 'base_commands')) addUnique(requirements.baseCommands, command);
  for (const bin of readYamlStringList(frontmatter, 'bins')) {
    if (RUNTIME_SHIM_BINS.has(bin)) addUnique(requirements.runtimeBins, bin);
    else addUnique(requirements.skillLocalBins, bin);
  }

  return requirements;
}

function extractFrontmatter(body: string): string | null {
  if (!body.startsWith('---\n')) return null;
  const end = body.indexOf('\n---', 4);
  if (end === -1) return null;
  return body.slice(4, end);
}

function readYamlStringList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const values: string[] = [];
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(keyPattern);
    if (!match) continue;
    const rest = match[1].trim();
    if (rest.startsWith('[')) {
      values.push(...parseInlineStringList(rest));
      continue;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = lines[j].match(/^\s*-\s*["']?([^"',\]]+)["']?\s*$/);
      if (item) {
        values.push(item[1].trim());
        continue;
      }
      if (lines[j].trim() === '') continue;
      break;
    }
  }
  return values.filter(Boolean);
}

function parseInlineStringList(value: string): string[] {
  const match = value.match(/^\[(.*)\]$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDirectory(entryPath: string): boolean {
  if (!fs.existsSync(entryPath)) return false;
  return fs.statSync(entryPath).isDirectory();
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
