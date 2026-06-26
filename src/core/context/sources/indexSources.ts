import type { ContextItem, ContextQuery, ContextSource } from '../types';
import { FtsIndex } from '../../indexing/FtsIndex';
import type { ThunderDb } from '../../indexing/ThunderDb';
import { RepoMapService } from '../RepoMapService';
import type { MemoryService } from '../../memory/MemoryService';

export class FtsContextSource implements ContextSource {
  readonly id = 'fts';
  private fts: FtsIndex;

  constructor(db: ThunderDb) {
    this.fts = new FtsIndex(db);
  }

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const results = this.fts.search(query.text, query.maxItems ?? 10);
    return results.map((r, i) => ({
      id: `fts-${r.relPath}-${i}`,
      source: this.id,
      relPath: r.relPath,
      content: r.snippet,
      score: Math.abs(r.rank),
      reason: `FTS match in ${r.relPath}`,
      tokenEstimate: Math.ceil(r.snippet.length / 4),
    }));
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

    const observations = this.memoryService.search(query.text, 5);
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
