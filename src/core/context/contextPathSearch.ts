import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { ThunderDb } from '../indexing/ThunderDb';
import type { ContextPathSuggestion } from '../../vscode/webview/messages';

const SKIP_DIRS = new Set(['node_modules', '.git', '.mitii', '.thunder', 'dist', 'build', 'out']);

export function searchWorkspacePaths(
  workspace: string,
  query: string,
  db: ThunderDb | undefined,
  limit = 20
): ContextPathSuggestion[] {
  const q = query.trim().toLowerCase().replace(/^@/, '').replace(/^\.\//, '');
  if (!q) return [];

  const results: ContextPathSuggestion[] = [];
  const seen = new Set<string>();

  const push = (path: string, kind: 'file' | 'folder', label?: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const key = `${kind}:${normalized}`;
    if (!normalized || seen.has(key)) return;
    if (!normalized.toLowerCase().includes(q) && !q.includes('/')) return;
    seen.add(key);
    results.push({ path: normalized, kind, label: label ?? normalized });
  };

  if (db?.isOpen()) {
    const rows = db.raw
      .prepare(
        'SELECT rel_path FROM files WHERE workspace = ? AND rel_path LIKE ? ORDER BY rel_path LIMIT ?'
      )
      .all(workspace, `%${q}%`, limit * 2) as Array<{ rel_path: string }>;

    for (const row of rows) {
      push(row.rel_path, 'file');
      const parts = row.rel_path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join('/');
        if (folder.toLowerCase().includes(q)) {
          push(folder, 'folder', `${folder}/`);
        }
      }
      if (results.length >= limit) break;
    }
  }

  if (results.length < limit) {
    walkWorkspace(workspace, workspace, q, results, seen, limit);
  }

  return results
    .sort((a, b) => scoreMatch(a.path, q) - scoreMatch(b.path, q))
    .slice(0, limit);
}

function scoreMatch(path: string, query: string): number {
  const lower = path.toLowerCase();
  if (lower === query) return 0;
  if (lower.endsWith(`/${query}`)) return 1;
  if (lower.startsWith(query)) return 2;
  const idx = lower.indexOf(query);
  return idx >= 0 ? 3 + idx / 100 : 99;
}

function walkWorkspace(
  root: string,
  dir: string,
  query: string,
  results: ContextPathSuggestion[],
  seen: Set<string>,
  limit: number,
  depth = 0
): void {
  if (results.length >= limit || depth > 6) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let rel: string;
    try {
      rel = relative(root, abs).replace(/\\/g, '/');
    } catch {
      continue;
    }
    if (!rel || rel.startsWith('..')) continue;

    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (rel.toLowerCase().includes(query)) {
        const key = `folder:${rel}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ path: rel, kind: 'folder', label: `${rel}/` });
        }
      }
      walkWorkspace(root, abs, query, results, seen, limit, depth + 1);
    } else if (rel.toLowerCase().includes(query)) {
      const key = `file:${rel}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ path: rel, kind: 'file', label: rel });
      }
    }

    if (results.length >= limit) return;
  }
}

export function resolvePickedPaths(
  workspace: string,
  picked: readonly { fsPath: string }[]
): ContextPathSuggestion[] {
  return picked
    .map((uri) => {
      const rel = relative(workspace, uri.fsPath).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) return undefined;
      const kind = existsSync(uri.fsPath) && statSync(uri.fsPath).isDirectory() ? 'folder' : 'file';
      return { path: rel.replace(/\/$/, ''), kind, label: rel } as ContextPathSuggestion;
    })
    .filter((p): p is ContextPathSuggestion => Boolean(p));
}
