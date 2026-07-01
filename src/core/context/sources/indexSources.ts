import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ContextItem, ContextQuery, ContextSource } from '../types';
import { FtsIndex } from '../../indexing/FtsIndex';
import type { ThunderDb } from '../../indexing/ThunderDb';
import { RepoMapService } from '../RepoMapService';
import type { MemoryService } from '../../memory/MemoryService';
import { isProjectOverviewQuestion } from '../fuzzyFileMatch';
import { filterItemsToScope } from '../scopeFilter';

const OVERVIEW_FILES = [
  'README.md',
  'package.json',
  'thunder-ai-agent/README.md',
  'thunder-ai-agent/package.json',
  'Thunder-Execution-Plan/THUNDER_AI_AGENT_MASTER_PLAN.md',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'tsconfig.json',
];

export class WorkspaceOverviewContextSource implements ContextSource {
  readonly id = 'workspace-overview';

  constructor(private readonly workspace: string) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const projectQuestion = isProjectOverviewQuestion(query.text);
    const items: ContextItem[] = [];

    for (const relPath of OVERVIEW_FILES) {
      const absPath = join(this.workspace, relPath);
      if (!existsSync(absPath)) continue;

      try {
        const limit = relPath === 'README.md' ? 8000 : 4000;
        const content = readFileSync(absPath, 'utf-8').slice(0, limit);
        items.push({
          id: `overview-${relPath}`,
          source: this.id,
          relPath,
          content,
          score: relPath === 'README.md' && projectQuestion ? 15 : 9,
          reason: relPath === 'README.md'
            ? 'Project README'
            : `Root project file: ${relPath}`,
          tokenEstimate: Math.ceil(content.length / 4),
        });
      } catch {
        // Ignore unreadable optional overview files.
      }
    }

    return items;
  }
}

export class FtsContextSource implements ContextSource {
  readonly id = 'fts';
  private fts: FtsIndex;

  constructor(db: ThunderDb) {
    this.fts = new FtsIndex(db);
  }

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const results = this.fts.search(query.text, query.maxItems ?? 10);
    return filterItemsToScope(results.map((r, i) => ({
      id: `fts-${r.relPath}-${i}`,
      source: this.id,
      relPath: r.relPath,
      content: r.snippet,
      score: Math.abs(r.rank),
      reason: `FTS match in ${r.relPath}`,
      tokenEstimate: Math.ceil(r.snippet.length / 4),
    })), query.scopeRoot);
  }
}

export class RepoMapContextSource implements ContextSource {
  readonly id = 'repo-map';
  private repoMap: RepoMapService;

  constructor(db: ThunderDb, workspace: string) {
    this.repoMap = new RepoMapService(db, workspace);
  }

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const map = this.repoMap.build({
      query: query.text,
      currentFile: query.currentFile,
      openFiles: query.openFiles,
      gitDiffFiles: query.gitDiffFiles,
      diagnosticFiles: query.diagnosticFiles,
      maxChars: 4000,
    });

    return [{
      id: 'repo-map',
      source: this.id,
      content: map,
      score: 7,
      reason: 'Compact repo map with ranked symbols',
      tokenEstimate: Math.ceil(map.length / 4),
    }];
  }
}

export class MemoryContextSource implements ContextSource {
  readonly id = 'memory';

  constructor(private readonly memoryService?: MemoryService) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    if (!this.memoryService) return [];

    const observations = await this.memoryService.searchAsync(query.text, 5);
    return observations.map((obs) => ({
      id: `memory-${obs.id}`,
      source: this.id,
      content: obs.text,
      score: 4,
      reason: `Memory (${obs.type})`,
      tokenEstimate: Math.ceil(obs.text.length / 4),
    }));
  }
}
