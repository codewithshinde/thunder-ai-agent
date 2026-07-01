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
      const frontmatter = parseSkillFrontmatter(content);
      const relPath = relative(this.workspace, absPath).replace(/\\/g, '/');
      return {
        name: frontmatter.name || skillNameFromPath(absPath),
        description: extractDescription(content, frontmatter),
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
    const entry = this.entries.find((s) => {
      const folderName = basename(dirname(s.relPath)).toLowerCase();
      return s.name.toLowerCase() === normalized || folderName === normalized;
    });
    if (!entry) return undefined;
    return {
      entry,
      content: readFileSync(join(this.workspace, entry.relPath), 'utf8'),
    };
  }

  private skillsRoot(): string {
    return join(this.workspace, '.mitii', 'skills');
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
      relPath: '.mitii/skills/catalog.json',
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

function extractDescription(
  content: string,
  frontmatter: { name?: string; description?: string } = parseSkillFrontmatter(content)
): string {
  if (frontmatter.description) return frontmatter.description.slice(0, 240);

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('---'));
  return (lines[0] ?? 'Workspace skill playbook').slice(0, 240);
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const block = match[1];
  const name = readYamlScalar(block, 'name');
  const description = readYamlScalar(block, 'description');
  return { name, description };
}

function readYamlScalar(block: string, key: string): string | undefined {
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`));
    if (!match) continue;

    const value = match[1].trim();
    if (value === '|' || value === '>') {
      const indented: string[] = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        const childLine = lines[child];
        if (/^\S/.test(childLine)) break;
        if (!childLine.trim()) {
          indented.push('');
          continue;
        }
        indented.push(childLine.replace(/^\s{1,}/, ''));
      }
      const joined = value === '>'
        ? indented.join(' ').replace(/\s+/g, ' ').trim()
        : indented.join('\n').trim();
      return cleanYamlScalar(joined);
    }

    return cleanYamlScalar(value);
  }
  return undefined;
}

function cleanYamlScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^(['"])([\s\S]*)\1(?:\s+#.*)?$/);
  const cleaned = quoted ? quoted[2] : trimmed.replace(/\s+#.*$/, '');
  return cleaned.trim() || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { parseSkillFrontmatter };
