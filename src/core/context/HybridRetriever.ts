import type { ContextItem, ContextQuery } from './types';
import type { ContextSource } from './types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('HybridRetriever');

export class HybridRetriever {
  constructor(private readonly sources: ContextSource[]) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const allItems: ContextItem[] = [];

    for (const source of this.sources) {
      try {
        const items = await source.retrieve(query);
        allItems.push(...items);
      } catch (error) {
        log.warn('Context source failed', {
          source: source.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return deduplicateItems(allItems)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.maxItems ?? 30);
  }
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
