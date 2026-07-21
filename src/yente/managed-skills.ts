import { createHash } from 'crypto';
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
  /** Content digest of the managed skill roots this set was assembled from
   *  (see computeManagedSkillGeneration). Changes whenever any managed root's
   *  skill files change; empty only when every managed root is absent. */
  generation: string;
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
export const SKILL_GENERATION_FILE = '.skill-generation';
const TEMP_ROOT_PREFIX = '.nanoclaw-skills-';
const TEMP_ROOT_OWNER_FILE = '.nanoclaw-owner-pid';
const TEMP_ROOT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

let _cleanupRan = false;

export function cleanupStaleTempRoots(dataDir: string): void {
  // Run once per process lifetime. Called from buildMounts before any
  // temp roots are created by the long-lived service. Smoke helpers are
  // short-lived separate processes, so cleanup must not delete temp roots
  // currently owned by another live process.
  if (_cleanupRan) return;
  _cleanupRan = true;

  try {
    for (const entry of fs.readdirSync(dataDir)) {
      if (!entry.startsWith(TEMP_ROOT_PREFIX)) continue;
      const dir = path.join(dataDir, entry);
      if (!shouldRemoveTempRoot(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Mount still active or permissions — skip, not fatal.
      }
    }
  } catch {
    // dataDir may not exist yet on first-ever run.
  }
}

export function createManagedSkillTempRoot(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(dataDir, TEMP_ROOT_PREFIX));
  fs.writeFileSync(path.join(root, TEMP_ROOT_OWNER_FILE), `${process.pid}\n`, { mode: 0o600 });
  return root;
}

export function resolveManagedSkillRoot(args: {
  projectRoot: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  root?: string;
  selection?: SkillSelection;
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

  const availableSkills = [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const skills = resolveEffectiveSkillInventory(availableSkills, args.selection ?? 'all');

  // Each spawn gets a fresh, isolated merged root. If the caller provides
  // a root path (created externally with its own lifecycle), use it.
  // Otherwise create one under the data directory.
  const root = args.root ?? createManagedSkillTempRoot(args.dataDir);
  for (const skill of skills) {
    skill.mergedPath = path.join(root, skill.name);
    fs.cpSync(skill.sourcePath, skill.mergedPath, { recursive: true, dereference: true });
  }
  copyRuntimeManifests(sources, root, new Set(skills.map((skill) => skill.name)));
  synthesizeSkillBinLinks(root, skills);

  const generation = computeManagedSkillGeneration(managedSkillRootsFromEnv(env));
  return { root, skills, generation };
}

export function clearManagedSkillRootCache(): void {
  _cleanupRan = false;
}

/**
 * Resolve the one effective inventory mounted into a runtime. Explicit
 * selections are set unions with every available `gws-*` skill: duplicates are
 * removed, names are sorted for a stable mount, and every requested name must
 * exist before anything is copied. GWS is a baseline capability, not a
 * provider- or group-specific privilege tier.
 * Because `/app/skills` itself contains only this result, Claude symlinks,
 * Codex discovery, OpenCode compatibility discovery, threaded sessions, and
 * operator forks cannot accidentally see different inventories.
 */
export function resolveEffectiveSkillInventory(
  availableSkills: readonly ManagedSkill[],
  selection: SkillSelection,
): ManagedSkill[] {
  const availableByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const desiredNames =
    selection === 'all'
      ? [...availableByName.keys()].sort((a, b) => a.localeCompare(b))
      : [...new Set([...selection, ...[...availableByName.keys()].filter((name) => name.startsWith('gws-'))])].sort(
          (a, b) => a.localeCompare(b),
        );

  for (const name of desiredNames) {
    if (!availableByName.has(name)) {
      throw new Error(`Configured skill "${name}" is not available in the managed skill inventory`);
    }
  }

  return desiredNames.map((name) => availableByName.get(name)!);
}

export function syncManagedSkillSymlinks(args: { claudeDir: string; skillNames: readonly string[] }): void {
  const skillsDir = path.join(args.claudeDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  const desired = [...args.skillNames];

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

function copyRuntimeManifests(
  sources: SkillRootSource[],
  mergedRoot: string,
  selectedNames: ReadonlySet<string>,
): void {
  const manifests = sources
    .map((source) => path.join(source.root, SKILL_RUNTIME_MANIFEST))
    .filter((file) => fs.existsSync(file));
  if (manifests.length === 0) return;
  if (manifests.length > 1) {
    throw new Error(`Multiple ${SKILL_RUNTIME_MANIFEST} files are not supported in one merged skill root`);
  }
  const manifest = readRuntimeManifest(manifests[0]);
  const filtered = {
    ...manifest,
    ...(manifest.skills ? { skills: manifest.skills.filter((skill) => selectedNames.has(skill.name)) } : {}),
  };
  fs.writeFileSync(path.join(mergedRoot, SKILL_RUNTIME_MANIFEST), `${JSON.stringify(filtered, null, 2)}\n`);
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

function shouldRemoveTempRoot(root: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  if (tempRootOwnerIsRunning(root)) return false;
  return Date.now() - stat.mtimeMs >= TEMP_ROOT_MIN_AGE_MS;
}

function tempRootOwnerIsRunning(root: string): boolean {
  const pidPath = path.join(root, TEMP_ROOT_OWNER_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8').trim();
  } catch {
    return false;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) return false;
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Managed skill roots from NANOCLAW_MANAGED_SKILLS_DIRS, in declared order.
 * Intentionally covers ONLY the env-derived managed roots — NOT the `local`
 * (writable-source) or `bundled` (container/skills) classifications that
 * resolveManagedSkillRoot also merges and realpath-dedups. Bundled skills change
 * only with a runtime redeploy (which restarts everything), so they need no
 * recycle coverage. NOTE: the live env lists the local-skills root
 * (/srv/nanoclaw/shared/repos/local-skills/skills) as a managed root, so its
 * content IS covered here even though its merge-classification is `local`. Do
 * NOT expand this to the full merged source set. Both the spawn read
 * (resolveManagedSkillRoot) and the host-sweep read (currentManagedSkillGeneration)
 * call this same helper on the same process.env, and computeManagedSkillGeneration
 * digests the same roots, so spawn-gen and current-gen stay symmetric.
 */
export function managedSkillRootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return splitPathList(env.NANOCLAW_MANAGED_SKILLS_DIRS);
}

/**
 * Recursively collect regular files under `root` as POSIX-relative paths,
 * skipping symlinks (e.g. `.bin/*`). Two volatile files are excluded by
 * basename at any depth so they cannot perturb the digest, mirroring the
 * deploy-side `srv/nanoclaw/skill-generation.sh` (`find ! -name ...`), which is
 * the single source of truth for this algorithm:
 *   - `.skill-generation` — the deploy-lane generation marker written at the
 *     managed root (chicken-and-egg). This is NOT the per-session spawn marker
 *     that writeSpawnSkillGeneration writes into the session dir; that file
 *     lives outside the managed roots and is never walked here.
 *   - `skill-runtime-manifest.json` — carries a per-deploy `generatedAt`
 *     timestamp that would otherwise change the digest on every deploy with no
 *     real skill change.
 * The exclusion matches these reserved basenames at any depth (as the bash
 * reference does); skills do not ship files of these names. Defensive against a
 * directory vanishing mid-walk during a deploy (errors -> skip).
 */
function collectSkillDigestFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectSkillDigestFiles(root, relPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === SKILL_GENERATION_FILE || entry.name === SKILL_RUNTIME_MANIFEST) continue;
    out.push(relPath);
  }
  return out;
}

/**
 * Per-root content digest: sha256 over every regular file under `root`
 * (relative path + content) in locale-independent byte-sorted order, so the
 * digest depends only on the skill *content* — never on the root's absolute
 * path or readdir order. Returns '' for a non-directory root (skipped by the
 * caller, matching the old marker-absent behavior). An existing-but-empty root
 * returns the stable empty-set digest, so adding its first skill changes it.
 */
function digestSkillRoot(root: string): string {
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    return '';
  }
  if (!isDir) return '';
  const files = collectSkillDigestFiles(root).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const hash = createHash('sha256');
  for (const rel of files) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(root, rel));
    } catch {
      continue; // vanished mid-walk during a deploy — skip; next pass re-reads
    }
    hash.update(rel, 'utf8');
    hash.update('\0');
    hash.update(createHash('sha256').update(content).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Content "generation" of the managed skill roots: a digest of each root's
 * skill files, joined in declared order. REPLACES the old `.skill-generation`
 * marker read so the generation reflects the ACTUAL deployed skill content of
 * every managed root — including the local-skills root, whose deploy lane never
 * wrote a marker. Symmetry by construction: spawn (resolveManagedSkillRoot) and
 * host-sweep (currentManagedSkillGeneration) call this same helper over the same
 * env-derived roots, so identical content ⇒ identical generation ⇒ no spurious
 * recycle, and any skill change in any managed root ⇒ different generation ⇒
 * idle-recycle on the next sweep.
 */
export function computeManagedSkillGeneration(managedRoots: string[]): string {
  const parts: string[] = [];
  for (const root of managedRoots) {
    const digest = digestSkillRoot(root);
    if (digest) parts.push(digest);
  }
  return parts.join('\n');
}

/** Current managed-skill generation as seen via the process environment. */
export function currentManagedSkillGeneration(env: NodeJS.ProcessEnv): string {
  return computeManagedSkillGeneration(managedSkillRootsFromEnv(env));
}
