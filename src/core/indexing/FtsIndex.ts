import type { ThunderDb } from './ThunderDb';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('FtsIndex');

export interface FtsSearchResult {
  relPath: string;
  snippet: string;
  rank: number;
  startLine?: number;
  endLine?: number;
}

export class FtsIndex {
  constructor(private readonly db: ThunderDb) {}

  insertChunk(relPath: string, content: string): void {
    this.db.raw.prepare('INSERT INTO fts_chunks (rel_path, content) VALUES (?, ?)').run(relPath, content);
  }

  deleteByFile(relPath: string): void {
    this.db.raw.prepare('DELETE FROM fts_chunks WHERE rel_path = ?').run(relPath);
  }

  search(query: string, limit = 20): FtsSearchResult[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) {
      return [];
    }

    try {
      const rows = this.db.raw
        .prepare(`
          SELECT rel_path, snippet(fts_chunks, 1, '[[', ']]', '...', 32) as snippet,
                 rank
          FROM fts_chunks
          WHERE fts_chunks MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(sanitized, limit) as Array<{ rel_path: string; snippet: string; rank: number }>;

      return rows.map((r) => ({
        relPath: r.rel_path,
        snippet: r.snippet,
        rank: r.rank,
      }));
    } catch (e) {
      log.warn('FTS search failed', { query: sanitized });
      return [];
    }
  }
}

export function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[^\w\s.-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"`)
    .join(' OR ');
}
