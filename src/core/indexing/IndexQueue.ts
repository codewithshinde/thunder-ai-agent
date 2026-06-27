import { readFileSync } from 'fs';
import type { ThunderDb } from './ThunderDb';
import { ChunkingService } from './ChunkingService';
import { FtsIndex } from './FtsIndex';
import { getExtractor, extractSymbolRefs } from './SymbolExtractor';
import { extractImports, resolveImportTarget } from './ImportExtractor';
import { createLogger } from '../telemetry/Logger';

import type { VectorIndexService } from './VectorIndex';

const log = createLogger('IndexQueue');

export interface IndexJob {
  fileId: number;
  relPath: string;
  absPath: string;
  language: string | null;
}

export interface IndexingStatus {
  indexed: number;
  queued: number;
  running: boolean;
  failed: number;
}

type ProgressCallback = (status: IndexingStatus) => void;

export class IndexQueue {
  private queue: IndexJob[] = [];
  private running = false;
  private cancelled = false;
  private failed = 0;
  private readonly chunker = new ChunkingService();
  private readonly fts: FtsIndex;
  private knownSymbols = new Set<string>();
  private onProgress?: ProgressCallback;
  private vectorService: VectorIndexService | undefined;
  private workspace = '';

  constructor(private readonly db: ThunderDb) {
    this.fts = new FtsIndex(db);
    this.loadKnownSymbols();
  }

  onStatusChange(cb: ProgressCallback): void {
    this.onProgress = cb;
  }

  setVectorService(workspace: string, service: VectorIndexService | undefined): void {
    this.workspace = workspace;
    this.vectorService = service;
  }

  enqueue(jobs: IndexJob[]): void {
    const existing = new Set(this.queue.map((j) => j.relPath));
    for (const job of jobs) {
      if (!existing.has(job.relPath)) {
        this.queue.push(job);
        existing.add(job.relPath);
      }
    }
    void this.process();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
  }

  getStatus(): IndexingStatus {
    const indexed = (this.db.raw
      .prepare('SELECT COUNT(*) as c FROM files WHERE indexed_at IS NOT NULL')
      .get() as { c: number }).c;
    return {
      indexed,
      queued: this.queue.length,
      running: this.running,
      failed: this.failed,
    };
  }

  private async process(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;

    while (this.queue.length > 0 && !this.cancelled) {
      const job = this.queue.shift()!;
      try {
        this.indexFile(job);
      } catch (e) {
        this.failed++;
        log.error('Index failed', { path: job.relPath, error: String(e) });
      }
      this.onProgress?.(this.getStatus());
    }

    this.running = false;
    this.onProgress?.(this.getStatus());
  }

  private indexFile(job: IndexJob): void {
    const content = readFileSync(job.absPath, 'utf-8');
    const chunks = this.chunker.chunkFile(content, job.language);

    this.db.transaction(() => {
      this.db.raw.prepare('DELETE FROM chunks WHERE file_id = ?').run(job.fileId);
      this.db.raw.prepare('DELETE FROM symbols WHERE file_id = ?').run(job.fileId);
      this.db.raw.prepare('DELETE FROM symbol_refs WHERE file_id = ?').run(job.fileId);
      this.db.raw.prepare('DELETE FROM file_imports WHERE from_file_id = ?').run(job.fileId);
      this.fts.deleteByFile(job.relPath);

      const insertChunk = this.db.raw.prepare(`
        INSERT INTO chunks (file_id, chunk_index, start_line, end_line, content, token_estimate, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        const result = insertChunk.run(
          job.fileId, chunk.chunkIndex, chunk.startLine, chunk.endLine,
          chunk.content, chunk.tokenEstimate, chunk.hash
        );
        this.fts.insertChunk(job.relPath, chunk.content);
        if (this.vectorService && this.workspace) {
          void this.vectorService.indexChunk(
            this.workspace,
            Number(result.lastInsertRowid),
            job.relPath,
            chunk.content
          );
        }
      }

      const extractor = getExtractor(job.language);
      if (extractor) {
        const symbols = extractor.extract(content);
        const insertSymbol = this.db.raw.prepare(`
          INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const sym of symbols) {
          insertSymbol.run(job.fileId, sym.name, sym.kind, sym.signature, sym.startLine, sym.endLine);
          this.knownSymbols.add(sym.name);
        }

        const refs = extractSymbolRefs(content, this.knownSymbols);
        const insertRef = this.db.raw.prepare(
          'INSERT INTO symbol_refs (file_id, symbol_name, line) VALUES (?, ?, ?)'
        );
        for (const ref of refs) {
          insertRef.run(job.fileId, ref.name, ref.line);
        }
      }

      const imports = extractImports(content);
      const insertImport = this.db.raw.prepare(
        'INSERT INTO file_imports (from_file_id, to_rel_path, specifier, line) VALUES (?, ?, ?, ?)'
      );
      for (const imp of imports) {
        const target = resolveImportTarget(job.relPath, imp.specifier);
        if (target) {
          insertImport.run(job.fileId, target, imp.specifier, imp.line);
        }
      }

      this.db.raw.prepare('UPDATE files SET indexed_at = ? WHERE id = ?').run(Date.now(), job.fileId);
    });
  }

  private loadKnownSymbols(): void {
    const rows = this.db.raw.prepare('SELECT DISTINCT name FROM symbols').all() as Array<{ name: string }>;
    this.knownSymbols = new Set(rows.map((r) => r.name));
  }
}
