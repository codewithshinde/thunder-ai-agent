import type { ContextItem, ContextQuery } from './types';
import type { ContextSource } from './types';
import type { ContextReranker } from './ContextReranker';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('HybridRetriever');

const SOURCE_TIMEOUT_MS = 800;

/** Fast explicit sources first; heavy search sources in parallel tier 2. */
const SOURCE_TIERS: string[][] = [
  ['project-rules', 'project-catalog', 'mentioned-files', 'skill-catalog'],
  ['workspace-overview', 'current-editor', 'open-files', 'git-diff', 'diagnostics'],
  ['fts', 'indexed-file-search', 'vector', 'repo-map', 'memory'],
];

export interface RerankerConfig {
  enabled: boolean;
  candidatePool: number;
  topK: number;
}

export interface ContextRetrievalTiming {
  source: string;
  durationMs: number;
  success: boolean;
  itemCount: number;
  tier: number;
  error?: string;
}

export interface RerankTiming {
  source: 'reranker';
  durationMs: number;
  success: boolean;
  candidateCount: number;
  resultCount: number;
  error?: string;
}

export type RetrievalTimingCallback = (timing: ContextRetrievalTiming | RerankTiming) => void;

export class HybridRetriever {
  constructor(
    private readonly sources: ContextSource[],
    private readonly reranker?: ContextReranker,
    private readonly rerankerConfig?: RerankerConfig,
    private readonly onTiming?: RetrievalTimingCallback
  ) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const sourceById = new Map(this.sources.map((s) => [s.id, s]));
    const orderedSources: ContextSource[] = [];
    const seen = new Set<string>();

    for (const tier of SOURCE_TIERS) {
      for (const id of tier) {
        const source = sourceById.get(id);
        if (source && !seen.has(id)) {
          orderedSources.push(source);
          seen.add(id);
        }
      }
    }
    for (const source of this.sources) {
      if (!seen.has(source.id)) {
        orderedSources.push(source);
      }
    }

    const allItems: ContextItem[] = [];
    const tiers = chunkByTier(orderedSources);
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      const tierSources = tiers[tierIndex];
      const tierResults = await Promise.allSettled(
        tierSources.map((source) => retrieveWithTiming(source, query, SOURCE_TIMEOUT_MS, tierIndex + 1))
      );

      for (let i = 0; i < tierResults.length; i++) {
        const result = tierResults[i];
        const source = tierSources[i];
        if (result.status === 'fulfilled') {
          this.onTiming?.(result.value.timing);
          allItems.push(...result.value.items);
        } else {
          const reason = result.reason as { durationMs?: unknown; error?: unknown };
          const durationMs = typeof reason.durationMs === 'number' ? reason.durationMs : 0;
          const error = reason.error ?? result.reason;
          this.onTiming?.({
            source: source.id,
            durationMs,
            success: false,
            itemCount: 0,
            tier: tierIndex + 1,
            error: error instanceof Error ? error.message : String(error),
          });
          log.warn('Context source failed', {
            source: source.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const deduped = deduplicateItems(allItems).sort((a, b) => b.score - a.score);

    if (this.reranker && this.rerankerConfig?.enabled) {
      const pool = deduped.slice(0, this.rerankerConfig.candidatePool);
      const startedAt = Date.now();
      try {
        const reranked = await this.reranker.rerank(
          query.text,
          pool,
          this.rerankerConfig.topK
        );
        const sliced = reranked.slice(0, query.maxItems ?? this.rerankerConfig.topK);
        this.onTiming?.({
          source: 'reranker',
          durationMs: Date.now() - startedAt,
          success: true,
          candidateCount: pool.length,
          resultCount: sliced.length,
        });
        return sliced;
      } catch (error) {
        this.onTiming?.({
          source: 'reranker',
          durationMs: Date.now() - startedAt,
          success: false,
          candidateCount: pool.length,
          resultCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    return deduped.slice(0, query.maxItems ?? 30);
  }
}

function chunkByTier(sources: ContextSource[]): ContextSource[][] {
  const tiers: ContextSource[][] = [];
  let currentTier = -1;
  let bucket: ContextSource[] = [];

  for (const source of sources) {
    const tierIdx = SOURCE_TIERS.findIndex((tier) => tier.includes(source.id));
    const tier = tierIdx >= 0 ? tierIdx : SOURCE_TIERS.length;
    if (tier !== currentTier) {
      if (bucket.length > 0) tiers.push(bucket);
      bucket = [source];
      currentTier = tier;
    } else {
      bucket.push(source);
    }
  }
  if (bucket.length > 0) tiers.push(bucket);
  return tiers;
}

async function retrieveWithTiming(
  source: ContextSource,
  query: ContextQuery,
  timeoutMs: number,
  tier: number
): Promise<{ items: ContextItem[]; timing: ContextRetrievalTiming }> {
  const startedAt = Date.now();
  return new Promise<{ items: ContextItem[]; timing: ContextRetrievalTiming }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject({ error: new Error(`timeout after ${timeoutMs}ms`), durationMs: Date.now() - startedAt });
    }, timeoutMs);

    source.retrieve(query)
      .then((items) => {
        clearTimeout(timer);
        resolve({
          items,
          timing: {
            source: source.id,
            durationMs: Date.now() - startedAt,
            success: true,
            itemCount: items.length,
            tier,
          },
        });
      })
      .catch((error) => {
        clearTimeout(timer);
        reject({ error, durationMs: Date.now() - startedAt });
      });
  });
}

function deduplicateItems(items: ContextItem[]): ContextItem[] {
  const seen = new Map<string, ContextItem>();

  for (const item of items) {
    const key = item.relPath
      ? `${item.relPath}:${item.startLine ?? 0}:${item.endLine ?? 0}`
      : item.id;

    const existing = seen.get(key);
    if (!existing || item.score > existing.score) {
      const merged: ContextItem = existing
        ? { ...item, score: Math.max(item.score, existing.score), reason: `${existing.reason}; ${item.reason}` }
        : item;
      seen.set(key, merged);
    }
  }

  return Array.from(seen.values());
}
