import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('BundledSkills');

export interface InstallBundledSkillsResult {
  installed: string[];
  skipped: string[];
  bundledRoot: string;
  destinationRoot: string;
}

/** Copy extension-bundled skills into the workspace `.mitii/skills` folder (idempotent). */
export function installBundledSkills(
  workspace: string,
  extensionRoot: string,
  options: { force?: boolean } = {}
): InstallBundledSkillsResult {
  const bundledRoot = join(extensionRoot, 'bundled-skills');
  const destinationRoot = join(workspace, '.mitii', 'skills');
  const installed: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(bundledRoot)) {
    log.warn('Bundled skills directory missing', { bundledRoot });
    return { installed, skipped, bundledRoot, destinationRoot };
  }

  mkdirSync(destinationRoot, { recursive: true });

  for (const skillDir of listBundledSkillDirs(bundledRoot)) {
    const skillName = basename(skillDir);
    const sourceSkillFile = join(skillDir, 'SKILL.md');
    const targetDir = join(destinationRoot, skillName);

    if (!existsSync(sourceSkillFile)) {
      log.warn('Bundled skill missing SKILL.md', { skillName, sourceSkillFile });
      continue;
    }

    const targetSkillFile = join(targetDir, 'SKILL.md');
    if (existsSync(targetDir) && !options.force) {
      skipped.push(skillName);
      continue;
    }

    mkdirSync(targetDir, { recursive: true });
    cpSync(skillDir, targetDir, {
      recursive: true,
      force: true,
      filter: (src) => basename(src) !== '.git',
    });

    if (!existsSync(targetSkillFile)) {
      cpSync(sourceSkillFile, targetSkillFile);
    }

    installed.push(skillName);
  }

  if (installed.length > 0 || skipped.length > 0) {
    log.info('Bundled skills install finished', {
      installed: installed.length,
      skipped: skipped.length,
      destinationRoot,
    });
  }

  return { installed, skipped, bundledRoot, destinationRoot };
}

export function listBundledSkillNames(extensionRoot: string): string[] {
  const bundledRoot = join(extensionRoot, 'bundled-skills');
  if (!existsSync(bundledRoot)) return [];
  return listBundledSkillDirs(bundledRoot).map((dir) => basename(dir)).sort();
}

export function readBundledSkillManifest(extensionRoot: string): Array<{ name: string; description: string }> {
  const bundledRoot = join(extensionRoot, 'bundled-skills');
  if (!existsSync(bundledRoot)) return [];

  return listBundledSkillDirs(bundledRoot).map((dir) => {
    const content = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const name = basename(dir);
    const description = extractBundledDescription(content) ?? `Bundled ${name} skill`;
    return { name, description };
  });
}

function listBundledSkillDirs(bundledRoot: string): string[] {
  return readdirSync(bundledRoot)
    .map((entry) => join(bundledRoot, entry))
    .filter((absPath) => {
      try {
        return statSync(absPath).isDirectory() && existsSync(join(absPath, 'SKILL.md'));
      } catch {
        return false;
      }
    })
    .sort();
}

function extractBundledDescription(content: string): string | undefined {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!match) return undefined;
  const block = match[0];
  const descriptionMatch = block.match(/^description:\s*(.+)$/m);
  if (!descriptionMatch) return undefined;
  return descriptionMatch[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 240);
}
