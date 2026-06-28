import type { ThunderDb } from '../indexing/ThunderDb';
import { computePageRank } from './pageRank';

export interface RepoMapEntry {
  relPath: string;
  symbols: Array<{ name: string; kind: string; exported?: boolean; signature?: string | null }>;
  score: number;
  pageRank: number;
  importCount: number;
}

export interface RepoMapOptions {
  query?: string;
  currentFile?: string;
  openFiles?: string[];
  gitDiffFiles?: string[];
  diagnosticFiles?: string[];
  recentEditFiles?: string[];
  /** Restrict map to files under this relative folder prefix (e.g. src/core/). */
  folderPrefix?: string;
  maxChars?: number;
}

const KIND_PRIORITY: Record<string, number> = {
  class: 5,
  interface: 4,
  struct: 4,
  function: 3,
  method: 2,
  type: 2,
  enum: 2,
  const: 1,
  symbol: 0,
};

export class RepoMapService {
  constructor(
    private readonly db: ThunderDb,
    private readonly workspace: string
  ) {}

  build(options: RepoMapOptions = {}): string {
    const maxChars = options.maxChars ?? 8000;
    const entries = this.rankEntries(options);
    const budgeted = this.applyBudget(entries, maxChars);
    return this.render(budgeted, Boolean(options.folderPrefix));
  }

  private rankEntries(options: RepoMapOptions): RepoMapEntry[] {
    const prefix = options.folderPrefix?.replace(/\\/g, '/').replace(/^\.\//, '');
    const files = prefix
      ? (this.db.raw
          .prepare('SELECT id, rel_path FROM files WHERE workspace = ? AND rel_path LIKE ?')
          .all(this.workspace, `${prefix}%`) as Array<{ id: number; rel_path: string }>)
      : (this.db.raw
          .prepare('SELECT id, rel_path FROM files WHERE workspace = ?')
          .all(this.workspace) as Array<{ id: number; rel_path: string }>);

    const queryTerms = (options.query ?? '').toLowerCase().split(/\W+/).filter(Boolean);
    const refCounts = this.getRefCounts();
    const importCounts = this.getImportCounts();
    const personalization = this.buildPersonalization(files, options);
    const pageRankScores = this.computeFilePageRank(files, personalization);

    return files.map((file) => {
      let score = 0;
      const symbols = this.getSymbols(file.id);
      const pageRank = pageRankScores.get(file.rel_path) ?? 0;
      const imports = importCounts.get(file.rel_path) ?? 0;

      if (options.currentFile === file.rel_path) score += 8;
      if (options.openFiles?.includes(file.rel_path)) score += 5;
      if (options.gitDiffFiles?.includes(file.rel_path)) score += 6;
      if (options.diagnosticFiles?.includes(file.rel_path)) score += 4;
      if (options.recentEditFiles?.includes(file.rel_path)) score += 2;

      for (const term of queryTerms) {
        if (file.rel_path.toLowerCase().includes(term)) score += 8;
        for (const sym of symbols) {
          if (sym.name.toLowerCase() === term) score += 10;
          else if (sym.name.toLowerCase().includes(term)) score += 5;
        }
      }

      score += Math.min(refCounts.get(file.rel_path) ?? 0, 15) * 0.3;
      score += Math.min(imports, 10) * 0.15;
      score += pageRank * 25;

      // Boost entry points (index, main, app files)
      const baseName = file.rel_path.split('/').pop()?.toLowerCase() ?? '';
      if (/^(index|main|app|server|extension)\.(tsx?|jsx?|py|go)$/.test(baseName)) {
        score += 3;
      }

      return { relPath: file.rel_path, symbols, score, pageRank, importCount: imports };
    }).sort((a, b) => b.score - a.score);
  }

  private buildPersonalization(
    files: Array<{ rel_path: string }>,
    options: RepoMapOptions
  ): Map<string, number> {
    const personalization = new Map<string, number>();

    for (const file of files) {
      let weight = 0.1;
      if (options.currentFile === file.rel_path) weight += 5;
      if (options.openFiles?.includes(file.rel_path)) weight += 3;
      if (options.gitDiffFiles?.includes(file.rel_path)) weight += 4;
      if (options.diagnosticFiles?.includes(file.rel_path)) weight += 2;
      if (options.recentEditFiles?.includes(file.rel_path)) weight += 1;
      personalization.set(file.rel_path, weight);
    }

    return personalization;
  }

  /** PageRank over import graph + symbol reference graph (file → file). */
  private computeFilePageRank(
    files: Array<{ id: number; rel_path: string }>,
    personalization: Map<string, number>
  ): Map<string, number> {
    if (files.length === 0) return new Map();

    const fileIds = new Map(files.map((f) => [f.id, f.rel_path]));
    const pathToId = new Map(files.map((f) => [f.rel_path, f.id]));
    const nodes = files.map((f) => f.rel_path);
    const edges: Array<{ from: string; to: string; weight?: number }> = [];

    // Import-resolved edges (stronger signal)
    const importRows = this.db.raw.prepare(`
      SELECT fi.from_file_id, fi.to_rel_path, COUNT(*) as cnt
      FROM file_imports fi
      JOIN files f ON f.id = fi.from_file_id
      WHERE f.workspace = ?
      GROUP BY fi.from_file_id, fi.to_rel_path
    `).all(this.workspace) as Array<{ from_file_id: number; to_rel_path: string; cnt: number }>;

    for (const row of importRows) {
      const from = fileIds.get(row.from_file_id);
      const to = pathToId.has(row.to_rel_path) ? row.to_rel_path : undefined;
      if (from && to && from !== to) {
        edges.push({ from, to, weight: Math.min(row.cnt, 3) * 2 });
      }
    }

    // Symbol reference edges (weaker, name-only match)
    const refs = this.db.raw.prepare(`
      SELECT sr.file_id, sr.symbol_name, s.file_id as def_file_id
      FROM symbol_refs sr
      LEFT JOIN symbols s ON s.name = sr.symbol_name AND s.file_id != sr.file_id
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
        edges.push({ from, to, weight: 0.5 });
      }
    }

    if (edges.length === 0) return new Map();
    return computePageRank(nodes, edges, { personalization, iterations: 30 });
  }

  private getSymbols(fileId: number): Array<{ name: string; kind: string; exported?: boolean; signature?: string | null }> {
    const rows = this.db.raw
      .prepare('SELECT name, kind, signature FROM symbols WHERE file_id = ? ORDER BY start_line LIMIT 30')
      .all(fileId) as Array<{ name: string; kind: string; signature: string | null }>;

    return rows
      .sort((a, b) => (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0))
      .slice(0, 20)
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        signature: r.signature,
        exported: r.signature?.includes('export') ?? false,
      }));
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

  private getImportCounts(): Map<string, number> {
    const rows = this.db.raw.prepare(`
      SELECT fi.to_rel_path as rel_path, COUNT(*) as cnt
      FROM file_imports fi
      JOIN files f ON f.id = fi.from_file_id
      WHERE f.workspace = ?
      GROUP BY fi.to_rel_path
    `).all(this.workspace) as Array<{ rel_path: string; cnt: number }>;

    return new Map(rows.map((r) => [r.rel_path, r.cnt]));
  }

  private applyBudget(entries: RepoMapEntry[], maxChars: number): RepoMapEntry[] {
    const result: RepoMapEntry[] = [];
    let chars = 0;
    for (const entry of entries) {
      const line = this.renderEntry(entry);
      if (chars + line.length > maxChars && result.length >= 3) break;
      result.push(entry);
      chars += line.length;
    }
    return result;
  }

  private render(entries: RepoMapEntry[], scoped = false): string {
    if (entries.length === 0) return '(no indexed files)';
    const header = scoped
      ? `# Scoped repo map (${entries.length} files in folder)\n`
      : `# Repo map (${entries.length} files, ranked by relevance)\n`;
    return header + entries.map((e) => this.renderEntry(e)).join('\n');
  }

  private renderEntry(entry: RepoMapEntry): string {
    const symLines = entry.symbols
      .map((s) => {
        const exportMark = s.exported ? ' (exported)' : '';
        const sig = s.signature ? ` — ${s.signature}` : '';
        return `  ${s.kind} ${s.name}${exportMark}${sig}`;
      })
      .join('\n');
    return `${entry.relPath}\n${symLines}`;
  }
}
