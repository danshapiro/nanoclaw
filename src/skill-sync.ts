import fs from 'fs';
import path from 'path';

interface SyncAgentSkillsOptions {
  sourceRoots: string[];
  destinationDir: string;
  manifestPath: string;
}

type SkillManifest = Record<string, string[]>;

function listManagedSkills(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Managed skills directory does not exist: ${rootDir}`);
  }

  return fs
    .readdirSync(rootDir)
    .filter((entry) => {
      const entryPath = path.join(rootDir, entry);
      return (
        fs.statSync(entryPath).isDirectory() &&
        fs.existsSync(path.join(entryPath, 'SKILL.md'))
      );
    })
    .sort();
}

function copySkillDirectory(
  sourceDir: string,
  destinationRoot: string,
  skillName: string,
): void {
  const destinationDir = path.join(destinationRoot, skillName);
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true });
}

function readManifest(manifestPath: string): SkillManifest {
  if (!fs.existsSync(manifestPath)) {
    return {};
  }

  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Managed skills manifest is invalid: ${manifestPath}`);
  }

  const manifest: SkillManifest = {};
  for (const [rootDir, skillNames] of Object.entries(parsed)) {
    if (
      !Array.isArray(skillNames) ||
      skillNames.some((name) => typeof name !== 'string')
    ) {
      throw new Error(`Managed skills manifest is invalid: ${manifestPath}`);
    }
    manifest[rootDir] = [...skillNames].sort();
  }

  return manifest;
}

function writeManifest(manifestPath: string, manifest: SkillManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const normalized = Object.fromEntries(
    Object.entries(manifest)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rootDir, skillNames]) => [rootDir, [...skillNames].sort()]),
  );
  fs.writeFileSync(manifestPath, JSON.stringify(normalized, null, 2) + '\n');
}

function buildCurrentManifest(sourceRoots: string[]): SkillManifest {
  const manifest: SkillManifest = {};
  const ownersBySkill = new Map<string, string>();

  for (const sourceRoot of sourceRoots) {
    const skillNames = listManagedSkills(sourceRoot);
    for (const skillName of skillNames) {
      const existingOwner = ownersBySkill.get(skillName);
      if (existingOwner) {
        throw new Error(
          `Managed skill "${skillName}" is provided by multiple source roots: ${existingOwner}, ${sourceRoot}`,
        );
      }
      ownersBySkill.set(skillName, sourceRoot);
    }
    manifest[sourceRoot] = skillNames;
  }

  return manifest;
}

function buildOwnedDestinations(manifest: SkillManifest): Map<string, string> {
  const ownedDestinations = new Map<string, string>();

  for (const [sourceRoot, skillNames] of Object.entries(manifest)) {
    for (const skillName of skillNames) {
      ownedDestinations.set(skillName, sourceRoot);
    }
  }

  return ownedDestinations;
}

export function syncAgentSkills({
  sourceRoots,
  destinationDir,
  manifestPath,
}: SyncAgentSkillsOptions): void {
  fs.mkdirSync(destinationDir, { recursive: true });

  const previousManifest = readManifest(manifestPath);
  const hasExistingManifest = fs.existsSync(manifestPath);
  const currentManifest = buildCurrentManifest(sourceRoots);
  const previousOwners = buildOwnedDestinations(previousManifest);
  const currentOwners = buildOwnedDestinations(currentManifest);

  for (const [sourceRoot, previousSkillNames] of Object.entries(
    previousManifest,
  )) {
    const currentSkillNames = new Set(currentManifest[sourceRoot] ?? []);
    for (const skillName of previousSkillNames) {
      const destinationDirForSkill = path.join(destinationDir, skillName);
      if (!fs.existsSync(destinationDirForSkill)) {
        continue;
      }
      if (currentSkillNames.has(skillName)) {
        continue;
      }
      if (previousOwners.get(skillName) !== sourceRoot) {
        continue;
      }
      fs.rmSync(destinationDirForSkill, { recursive: true, force: true });
    }
  }

  for (const [sourceRoot, skillNames] of Object.entries(currentManifest)) {
    for (const skillName of skillNames) {
      const sourceDir = path.join(sourceRoot, skillName);
      const destinationDirForSkill = path.join(destinationDir, skillName);
      const currentOwner = currentOwners.get(skillName);
      const previousOwner = previousOwners.get(skillName);

      if (
        hasExistingManifest &&
        fs.existsSync(destinationDirForSkill) &&
        previousOwner !== currentOwner
      ) {
        throw new Error(
          `Managed skill "${skillName}" would overwrite unmanaged destination directory: ${destinationDirForSkill}`,
        );
      }

      copySkillDirectory(sourceDir, destinationDir, skillName);
    }
  }

  writeManifest(manifestPath, currentManifest);
}
