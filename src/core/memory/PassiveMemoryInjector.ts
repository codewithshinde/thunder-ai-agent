import type { MemoryService } from './MemoryService';
import type { ContextItem } from '../context/types';

/**
 * claude-mem style passive memory injection — surfaces relevant memories
 * without requiring the agent to call memory_search.
 */
export class PassiveMemoryInjector {
  constructor(private readonly memoryService?: MemoryService) {}

  inject(query: string, sessionId?: string): ContextItem[] {
    if (!this.memoryService) return [];

    const observations = this.memoryService.search(query, 5);
    const sessionRecent = sessionId
      ? this.memoryService.recent(3).filter((o) => o.sessionId === sessionId)
      : [];

    const seen = new Set<number>();
    const merged = [...observations, ...sessionRecent].filter((o) => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });

    return merged.map((obs) => ({
      id: `passive-memory-${obs.id}`,
      source: 'memory',
      content: `[${obs.type}] ${obs.text}`,
      score: obs.type === 'decision' || obs.type === 'user_preference' ? 6 : 4,
      reason: `Passive memory (${obs.type})`,
      tokenEstimate: Math.ceil(obs.text.length / 4),
    }));
  }
}
