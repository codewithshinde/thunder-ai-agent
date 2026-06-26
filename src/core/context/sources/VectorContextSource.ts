import type { ContextItem, ContextQuery, ContextSource } from '../types';
import type { VectorIndexService } from '../../indexing/VectorIndex';

export class VectorContextSource implements ContextSource {
  readonly id = 'vector';

  constructor(
    private readonly vectorService: VectorIndexService,
    private readonly workspace: string
  ) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const results = await this.vectorService.search(this.workspace, query.text, query.maxItems ?? 8);
    return results.map((r, i) => ({
      id: `vector-${r.chunkId}-${i}`,
      source: this.id,
      relPath: r.relPath,
      content: r.content.slice(0, 1500),
      score: r.score * 10,
      reason: `Semantic match in ${r.relPath}`,
      tokenEstimate: Math.ceil(r.content.length / 4),
    }));
  }
}
