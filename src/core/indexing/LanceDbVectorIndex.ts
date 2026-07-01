import { mkdirSync } from 'fs';
import { join } from 'path';
import type { ThunderDb } from './ThunderDb';
import { cosineSimilarity } from './EmbeddingProvider';
import { createLogger } from '../telemetry/Logger';
import type { VectorIndex, VectorSearchResult } from './VectorIndex';
import { resolveThunderDir } from './paths';

const log = createLogger('LanceDbVectorIndex');

type LanceTable = {
  add(rows: LanceRow[]): Promise<void>;
  delete(predicate: string): Promise<void>;
  search(vector: number[]): { limit(n: number): { toArray(): Promise<LanceRow[]> } };
  countRows(): Promise<number>;
};

type LanceDb = {
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, rows: LanceRow[]): Promise<LanceTable>;
};

type LanceRow = {
  chunk_id: number;
  workspace: string;
  rel_path: string;
  content: string;
  vector: number[];
};

const TABLE_NAME = 'chunk_embeddings';

export class LanceDbVectorIndex implements VectorIndex {
  private tablePromise: Promise<LanceTable | null> | null = null;

  constructor(
    private readonly sqliteDb: ThunderDb,
    private readonly workspace: string
  ) {}

  private lanceDir(): string {
    const base = join(resolveThunderDir(this.workspace), 'lance');
    mkdirSync(base, { recursive: true });
    return base;
  }

  private async getTable(): Promise<LanceTable | null> {
    if (!this.tablePromise) {
      this.tablePromise = this.openTable();
    }
    return this.tablePromise;
  }

  private async openTable(): Promise<LanceTable | null> {
    try {
      const lancedb = await import('@lancedb/lancedb');
      const connect = (lancedb as unknown as { connect: (uri: string) => Promise<LanceDb> }).connect;
      const db = await connect(this.lanceDir());
      try {
        return await db.openTable(TABLE_NAME);
      } catch {
        return await db.createTable(TABLE_NAME, []);
      }
    } catch (error) {
      log.warn('LanceDB unavailable, falling back to SQLite vectors', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  search(workspace: string, queryEmbedding: number[], limit = 10): VectorSearchResult[] {
    if (queryEmbedding.length === 0) return [];

    // LanceDB search is async; run synchronously via sqlite mirror for HybridRetriever sync callers.
    const rows = this.sqliteDb.raw.prepare(`
      SELECT ve.chunk_id, c.content, f.rel_path, ve.embedding_json
      FROM chunk_embeddings ve
      JOIN chunks c ON c.id = ve.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE ve.workspace = ?
      LIMIT 500
    `).all(workspace) as Array<{
      chunk_id: number;
      content: string;
      rel_path: string;
      embedding_json: string;
    }>;

    return rows
      .map((row) => {
        const embedding = JSON.parse(row.embedding_json) as number[];
        return {
          chunkId: row.chunk_id,
          relPath: row.rel_path,
          content: row.content,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .filter((r) => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async searchAsync(workspace: string, queryEmbedding: number[], limit = 10): Promise<VectorSearchResult[]> {
    if (queryEmbedding.length === 0) return [];
    const table = await this.getTable();
    if (!table) return this.search(workspace, queryEmbedding, limit);

    try {
      const rows = await table.search(queryEmbedding).limit(limit * 3).toArray();
      return rows
        .filter((row) => row.workspace === workspace)
        .map((row) => ({
          chunkId: row.chunk_id,
          relPath: row.rel_path,
          content: row.content,
          score: cosineSimilarity(queryEmbedding, row.vector),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      log.warn('LanceDB search failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.search(workspace, queryEmbedding, limit);
    }
  }

  upsertChunk(workspace: string, chunkId: number, relPath: string, embedding: number[]): void {
    this.sqliteDb.raw.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, workspace, embedding_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        embedding_json = excluded.embedding_json,
        updated_at = excluded.updated_at
    `).run(chunkId, workspace, JSON.stringify(embedding), Date.now());

    void this.upsertLanceRow(workspace, chunkId, relPath, embedding);
  }

  private async upsertLanceRow(
    workspace: string,
    chunkId: number,
    relPath: string,
    embedding: number[]
  ): Promise<void> {
    const table = await this.getTable();
    if (!table) return;

    try {
      const contentRow = this.sqliteDb.raw
        .prepare('SELECT content FROM chunks WHERE id = ?')
        .get(chunkId) as { content: string } | undefined;

      await table.delete(`chunk_id = ${chunkId}`);
      await table.add([{
        chunk_id: chunkId,
        workspace,
        rel_path: relPath,
        content: contentRow?.content ?? '',
        vector: embedding,
      }]);
    } catch (error) {
      log.warn('LanceDB upsert failed', {
        chunkId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  deleteFileChunks(fileId: number): void {
    const chunkIds = this.sqliteDb.raw
      .prepare('SELECT id FROM chunks WHERE file_id = ?')
      .all(fileId) as Array<{ id: number }>;

    this.sqliteDb.raw.prepare(`
      DELETE FROM chunk_embeddings
      WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)
    `).run(fileId);

    void (async () => {
      const table = await this.getTable();
      if (!table) return;
      for (const row of chunkIds) {
        try {
          await table.delete(`chunk_id = ${row.id}`);
        } catch {
          // Non-fatal
        }
      }
    })();
  }

  count(workspace: string): number {
    const row = this.sqliteDb.raw
      .prepare('SELECT COUNT(*) as cnt FROM chunk_embeddings WHERE workspace = ?')
      .get(workspace) as { cnt: number };
    return row.cnt;
  }
}

export function isLanceDbAvailable(): boolean {
  try {
    require.resolve('@lancedb/lancedb');
    return true;
  } catch {
    return false;
  }
}
