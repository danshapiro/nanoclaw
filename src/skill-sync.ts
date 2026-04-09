import fs from 'fs';
import path from 'path';

interface SyncAgentSkillsOptions {
  bundledSkillsDir: string;
  managedGwsSkillsDir: string;
  destinationDir: string;
}

function listSkillDirectories(rootDir: string): string[] {
  return fs
    .readdirSync(rootDir)
    .filter((entry) => fs.statSync(path.join(rootDir, entry)).isDirectory())
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

export function syncAgentSkills({
  bundledSkillsDir,
  managedGwsSkillsDir,
  destinationDir,
}: SyncAgentSkillsOptions): void {
  if (!fs.existsSync(managedGwsSkillsDir)) {
    throw new Error(
      `Managed GWS skills directory does not exist: ${managedGwsSkillsDir}`,
    );
  }

  fs.mkdirSync(destinationDir, { recursive: true });

  const bundledSkillNames = listSkillDirectories(bundledSkillsDir).filter(
    (skillName) => !skillName.startsWith('gws-'),
  );
  for (const skillName of bundledSkillNames) {
    copySkillDirectory(
      path.join(bundledSkillsDir, skillName),
      destinationDir,
      skillName,
    );
  }

  const managedSkillNames = listSkillDirectories(managedGwsSkillsDir).filter(
    (skillName) => skillName.startsWith('gws-'),
  );

  for (const existingSkillName of listSkillDirectories(destinationDir)) {
    if (
      existingSkillName.startsWith('gws-') &&
      !managedSkillNames.includes(existingSkillName)
    ) {
      fs.rmSync(path.join(destinationDir, existingSkillName), {
        recursive: true,
        force: true,
      });
    }
  }

  for (const skillName of managedSkillNames) {
    const sourceDir = path.join(managedGwsSkillsDir, skillName);
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
      throw new Error(`Managed GWS skill is missing SKILL.md: ${sourceDir}`);
    }
    copySkillDirectory(sourceDir, destinationDir, skillName);
  }
}
