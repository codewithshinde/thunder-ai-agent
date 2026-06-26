import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ThunderDb } from '../src/core/indexing/ThunderDb';
import { MigrationRunner } from '../src/core/indexing/migrations';
import { checkDbHealth } from '../src/core/indexing/health';
import { WorkspaceScanner } from '../src/core/indexing/WorkspaceScanner';
import { ChunkingService } from '../src/core/indexing/ChunkingService';
import { FtsIndex, sanitizeFtsQuery } from '../src/core/indexing/FtsIndex';
import { tsExtractor } from '../src/core/indexing/SymbolExtractor';

describe('DB integration', () => {
  let tempDir: string;
  let db: ThunderDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'thunder-test-'));
    const dbPath = join(tempDir, 'test.sqlite');
    db = new ThunderDb(dbPath);
    db.open();
    new MigrationRunner(db).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('migrates fresh DB and passes health check', () => {
    const health = checkDbHealth(db);
    expect(health.ok).toBe(true);
    expect(health.ftsSupported).toBe(true);
    expect(health.missingTables).toHaveLength(0);
  });

  it('runs migrations idempotently', () => {
    new MigrationRunner(db).run();
    const health = checkDbHealth(db);
    expect(health.ok).toBe(true);
  });

  it('scan → chunk → FTS search pipeline', () => {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    const filePath = join(srcDir, 'index.ts');
    const content = 'export function hello(): string {\n  return "hello";\n}\n';
    writeFileSync(filePath, content);

    const scanner = new WorkspaceScanner(db, tempDir);
    const discovered = [{
      absPath: filePath,
      relPath: 'src/index.ts',
      size: content.length,
      mtime: Date.now(),
      language: 'typescript' as const,
    }];

    const diff = scanner.computeDiff(discovered);
    expect(diff.added).toHaveLength(1);
    scanner.persistScan(diff);

    const fileId = scanner.getFileId('src/index.ts');
    expect(fileId).toBeDefined();

    const chunker = new ChunkingService();
    const chunks = chunker.chunkFile(content, 'typescript');
    expect(chunks.length).toBeGreaterThan(0);

    const insertChunk = db.raw.prepare(`
      INSERT INTO chunks (file_id, chunk_index, start_line, end_line, content, token_estimate, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const fts = new FtsIndex(db);
    for (const chunk of chunks) {
      insertChunk.run(fileId, chunk.chunkIndex, chunk.startLine, chunk.endLine, chunk.content, chunk.tokenEstimate, chunk.hash);
      fts.insertChunk('src/index.ts', chunk.content);
    }

    const symbols = tsExtractor.extract(content);
    expect(symbols.some((s) => s.name === 'hello')).toBe(true);

    const insertSymbol = db.raw.prepare(`
      INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const sym of symbols) {
      insertSymbol.run(fileId, sym.name, sym.kind, sym.signature, sym.startLine, sym.endLine);
    }

    db.raw.prepare('UPDATE files SET indexed_at = ? WHERE id = ?').run(Date.now(), fileId);

    const query = sanitizeFtsQuery('hello');
    expect(query).toBeTruthy();
    const results = fts.search('hello');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].relPath).toBe('src/index.ts');
  });
});
