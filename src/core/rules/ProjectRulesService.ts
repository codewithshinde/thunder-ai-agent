import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { ContextItem, ContextQuery, ContextSource } from '../context/types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ProjectRulesService');

const RULE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'WARP.md',
  '.cursorrules',
  '.clinerules',
];

const RULE_DIRS = [
  '.mitii/rules',
  '.mitii/agents',
  '.mitii/checks',
  '.mitii/prompts',
  '.clinerules',
  '.continue/rules',
  '.continue/agents',
  '.continue/checks',
  '.continue/prompts',
  '.cursor/rules',
];

export interface ProjectRuleFile {
  relPath: string;
  content: string;
}

export class ProjectRulesService {
  constructor(private readonly workspace: string) {}

  load(maxFiles = 24, maxCharsPerFile = 5000): ProjectRuleFile[] {
    if (!this.workspace) return [];
    const files: ProjectRuleFile[] = [];

    for (const relPath of RULE_FILES) {
      this.tryAddFile(files, relPath, maxCharsPerFile);
    }

    for (const relDir of RULE_DIRS) {
      const absDir = join(this.workspace, relDir);
      if (!existsSync(absDir)) continue;
      if (!statSync(absDir).isDirectory()) continue;
      try {
        for (const entry of walkRuleDir(this.workspace, relDir, 2)) {
          this.tryAddFile(files, entry, maxCharsPerFile);
          if (files.length >= maxFiles) return files;
        }
      } catch (error) {
        log.warn('Could not read rules directory', {
          relDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return files.slice(0, maxFiles);
  }

  count(): number {
    return this.load(200, 1).length;
  }

  private tryAddFile(files: ProjectRuleFile[], relPath: string, maxChars: number): void {
    if (files.some((f) => f.relPath === relPath)) return;
    const abs = join(this.workspace, relPath);
    if (!existsSync(abs)) return;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 256_000) return;
      const content = readFileSync(abs, 'utf-8').slice(0, maxChars).trim();
      if (content) files.push({ relPath, content });
    } catch {
      // Ignore unreadable rule files.
    }
  }
}

export class ProjectRulesContextSource implements ContextSource {
  readonly id = 'project-rules';

  constructor(private readonly rulesService: ProjectRulesService) {}

  async retrieve(_query: ContextQuery): Promise<ContextItem[]> {
    return this.rulesService.load().map((rule, index) => ({
      id: `project-rule-${index}-${rule.relPath}`,
      source: 'project-rules',
      relPath: rule.relPath,
      content: rule.content,
      score: 9,
      reason: 'Project methodology/rules file',
      tokenEstimate: Math.ceil(rule.content.length / 4),
    }));
  }
}

function walkRuleDir(workspace: string, relDir: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (currentRel: string, depth: number) => {
    if (depth > maxDepth) return;
    const abs = join(workspace, currentRel);
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = `${currentRel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childRel, depth + 1);
      } else if (/\.(md|mdc)$/i.test(entry.name) || entry.name === '.cursorrules') {
        out.push(childRel);
      }
    }
  };
  walk(relDir, 0);
  return out.sort();
}
