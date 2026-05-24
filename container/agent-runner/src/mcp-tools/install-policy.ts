import fs from 'fs';
import path from 'path';

export type InstallPurpose = 'general_capability' | 'deployed_skill_dependency';

export interface InstallPolicyInput {
  apt: string[];
  npm: string[];
  reason: string;
  purpose?: string;
  skillsRoot?: string;
}

export interface InstallPolicyDecision {
  allowed: boolean;
  message?: string;
}

const DEFAULT_SKILLS_ROOT = '/app/skills';
const DEPENDENCY_HINTS = [
  '/app/skills',
  'installed skill',
  'deployed skill',
  'skill dependency',
  'helper',
  'flight goat',
  'flight-goat',
  'pp-flight-goat',
  'flight-goat-pp-cli',
  'using-familiar',
  'familiar skill',
];

export function evaluateInstallPackagesRequest(input: InstallPolicyInput): InstallPolicyDecision {
  if (input.purpose === 'deployed_skill_dependency') {
    return reject();
  }
  if (input.purpose && input.purpose !== 'general_capability') {
    return { allowed: false, message: `install_packages failed: invalid purpose "${input.purpose}".` };
  }

  const reason = normalize(input.reason);
  const hints = new Set(DEPENDENCY_HINTS.map(normalize));
  for (const hint of loadSkillHints(input.skillsRoot ?? process.env.NANOCLAW_SKILLS_ROOT ?? DEFAULT_SKILLS_ROOT)) {
    hints.add(normalize(hint));
  }

  for (const hint of hints) {
    if (hint && reason.includes(hint)) return reject();
  }

  return { allowed: true };
}

function reject(): InstallPolicyDecision {
  return {
    allowed: false,
    message:
      'install_packages failed: installed skill dependencies are deployed by NanoClaw. Use the deployed helper under /app/skills/.bin or report a NanoClaw deployment error if it is missing.',
  };
}

function loadSkillHints(skillsRoot: string): string[] {
  try {
    const hints: string[] = [];
    if (!fs.existsSync(skillsRoot)) return hints;
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) hints.push(entry.name, entry.name.replace(/-/g, ' '));
    }
    const manifestPath = path.join(skillsRoot, 'skill-runtime-manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        skills?: Array<{ name?: string; skillLocalBins?: Record<string, unknown> }>;
      };
      for (const skill of manifest.skills ?? []) {
        if (skill.name) hints.push(skill.name, skill.name.replace(/-/g, ' '));
        hints.push(...Object.keys(skill.skillLocalBins ?? {}));
      }
    }
    return hints;
  } catch {
    return [];
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/g, ' ').trim();
}
