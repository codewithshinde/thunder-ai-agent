import type { ThunderDb } from '../indexing/ThunderDb';
import { computePageRank } from './pageRank';

export interface RepoMapEntry {
  relPath: string;
  symbols: Array<{ name: string; kind: string }>;
  score: number;
}

export interface RepoMapOptions {
  query?: string;
  currentFile?: string;
  openFiles?: string[];
  gitDiffFiles?: string[];
  diagnosticFiles?: string[];
  recentEditFiles?: string[];
  maxChars?: number;
}

export class RepoMapService {
  constructor(
    private readonly db: ThunderDb,
    private readonly workspace: string
  ) {}

  build(options: RepoMapOptions = {}): string {
    const maxChars = options.maxChars ?? 8000;
    const entries = this.rankEntries(options);
    const budgeted = this.applyBudget(entries, maxChars);
    return this.render(budgeted);
  }

  private rankEntries(options: RepoMapOptions): RepoMapEntry[] {
    const files = this.db.raw
      .prepare('SELECT id, rel_path FROM files WHERE workspace = ?')
      .all(this.workspace) as Array<{ id: number; rel_path: string }>;

    const queryTerms = (options.query ?? '').toLowerCase().split(/\W+/).filter(Boolean);
    const refCounts = this.getRefCounts();
    const pageRankScores = this.computeFilePageRank(files);

    return files.map((file) => {
      let score = 0;
      const symbols = this.getSymbols(file.id);

      if (options.currentFile === file.rel_path) score += 5;
      if (options.openFiles?.includes(file.rel_path)) score += 3;
      if (options.gitDiffFiles?.includes(file.rel_path)) score += 4;
      if (options.diagnosticFiles?.includes(file.rel_path)) score += 3;
      if (options.recentEditFiles?.includes(file.rel_path)) score += 1;

      for (const term of queryTerms) {
        if (file.rel_path.toLowerCase().includes(term)) score += 6;
        for (const sym of symbols) {
          if (sym.name.toLowerCase() === term) score += 8;
          else if (sym.name.toLowerCase().includes(term)) score += 4;
        }
      }

      score += Math.min(refCounts.get(file.rel_path) ?? 0, 10) * 0.2;
      score += (pageRankScores.get(file.rel_path) ?? 0) * 15;

      return { relPath: file.rel_path, symbols, score };
    }).sort((a, b) => b.score - a.score);
  }

  /** Aider-style PageRank over symbol reference graph (file → file). */
  private computeFilePageRank(files: Array<{ id: number; rel_path: string }>): Map<string, number> {
    if (files.length === 0) return new Map();

    const fileIds = new Map(files.map((f) => [f.id, f.rel_path]));
    const nodes = files.map((f) => f.rel_path);
    const edges: Array<{ from: string; to: string; weight?: number }> = [];

    const refs = this.db.raw.prepare(`
      SELECT sr.file_id, sr.symbol_name, s.file_id as def_file_id
      FROM symbol_refs sr
      LEFT JOIN symbols s ON s.name = sr.symbol_name
      WHERE sr.file_id IN (${files.map(() => '?').join(',') || 'NULL'})
    `).all(...files.map((f) => f.id)) as Array<{
      file_id: number;
      symbol_name: string;
      def_file_id: number | null;
    }>;

    for (const ref of refs) {
      const from = fileIds.get(ref.file_id);
      const to = ref.def_file_id ? fileIds.get(ref.def_file_id) : undefined;
      if (from && to && from !== to) {
        edges.push({ from, to, weight: 1 });
      }
    }

    if (edges.length === 0) return new Map();
    return computePageRank(nodes, edges);
  }

  private getSymbols(fileId: number): Array<{ name: string; kind: string }> {
    return this.db.raw
      .prepare('SELECT name, kind FROM symbols WHERE file_id = ? ORDER BY start_line LIMIT 20')
      .all(fileId) as Array<{ name: string; kind: string }>;
  }

  private getRefCounts(): Map<string, number> {
    const rows = this.db.raw.prepare(`
      SELECT f.rel_path, COUNT(sr.id) as cnt
      FROM symbol_refs sr
      JOIN files f ON f.id = sr.file_id
      WHERE f.workspace = ?
      GROUP BY f.rel_path
    `).all(this.workspace) as Array<{ rel_path: string; cnt: number }>;

    return new Map(rows.map((r) => [r.rel_path, r.cnt]));
  }

  private applyBudget(entries: RepoMapEntry[], maxChars: number): RepoMapEntry[] {
    const result: RepoMapEntry[] = [];
    let chars = 0;
    for (const entry of entries) {
      const line = this.renderEntry(entry);
      if (chars + line.length > maxChars) break;
      result.push(entry);
      chars += line.length;
    }
    return result;
  }

  private render(entries: RepoMapEntry[]): string {
    if (entries.length === 0) return '(no indexed files)';
    return entries.map((e) => this.renderEntry(e)).join('\n');
  }

  private renderEntry(entry: RepoMapEntry): string {
    const symLines = entry.symbols.map((s) => `  ${s.kind} ${s.name}`).join('\n');
    return `${entry.relPath}\n${symLines}`;
  }
}
