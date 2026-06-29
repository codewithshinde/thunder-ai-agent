import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import type { ContextItem, ContextQuery, ContextSource } from '../context/types';
import { createLogger } from '../telemetry/Logger';
import { AGENT_NAME } from '../../shared/brand';

const log = createLogger('SkillCatalog');

export interface SkillCatalogEntry {
  name: string;
  description: string;
  relPath: string;
}

export class SkillCatalogService {
  private entries: SkillCatalogEntry[] = [];

  constructor(private readonly workspace: string) {}

  refresh(): SkillCatalogEntry[] {
    const root = this.skillsRoot();
    if (!existsSync(root)) {
      this.entries = [];
      return [];
    }

    const skillFiles = findSkillFiles(root);
    this.entries = skillFiles.map((absPath) => {
      const content = readFileSync(absPath, 'utf8');
      const relPath = relative(this.workspace, absPath).replace(/\\/g, '/');
      return {
        name: skillNameFromPath(absPath),
        description: extractDescription(content),
        relPath,
      };
    });

    this.writeCatalog();
    log.info('Skill catalog refreshed', { count: this.entries.length });
    return this.list();
  }

  list(): SkillCatalogEntry[] {
    return [...this.entries];
  }

  get(name: string): { entry: SkillCatalogEntry; content: string } | undefined {
    const normalized = name.trim().toLowerCase();
    const entry = this.entries.find((s) => s.name.toLowerCase() === normalized);
    if (!entry) return undefined;
    return {
      entry,
      content: readFileSync(join(this.workspace, entry.relPath), 'utf8'),
    };
  }

  private skillsRoot(): string {
    return join(this.workspace, '.thunder', 'skills');
  }

  private writeCatalog(): void {
    const root = this.skillsRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'catalog.json'), `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8');
  }
}

export class SkillCatalogContextSource implements ContextSource {
  id = 'skill-catalog';

  constructor(private readonly catalog: SkillCatalogService) {}

  async retrieve(_query: ContextQuery): Promise<ContextItem[]> {
    const entries = this.catalog.list();
    if (entries.length === 0) return [];
    const content = [
      `## Available ${AGENT_NAME} Skills`,
      'Use the use_skill tool with one of these names when the playbook applies:',
      ...entries.map((entry) => `- ${entry.name}: ${entry.description} (${entry.relPath})`),
    ].join('\n');
    return [{
      id: 'skill-catalog',
      source: 'skills',
      relPath: '.thunder/skills/catalog.json',
      content,
      score: 3,
      reason: 'Workspace skill catalog',
      tokenEstimate: Math.ceil(content.length / 4),
    }];
  }
}

function findSkillFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry === 'SKILL.md') {
        out.push(abs);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

function skillNameFromPath(skillPath: string): string {
  return basename(dirname(skillPath));
}

function extractDescription(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return (lines[0] ?? 'Workspace skill playbook').slice(0, 240);
}
