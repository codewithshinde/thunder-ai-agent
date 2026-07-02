import { AGENT_NAME } from '../../shared/brand';
import * as vscode from 'vscode';
import { basename, dirname, join, relative, resolve, isAbsolute, win32 } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';

/**
 * Resolve and validate a Thunder workspace root (must be absolute, non-empty).
 */
export function normalizeWorkspaceRoot(workspaceRoot: string | undefined | null): string | null {
  if (!workspaceRoot?.trim()) return null;
  const trimmed = workspaceRoot.trim();
  if (isWindowsAbsolutePath(trimmed)) {
    return win32.normalize(trimmed);
  }
  const abs = resolve(isAbsolute(trimmed) ? trimmed : resolve(trimmed));
  if (!abs) return null;
  return abs;
}

/**
 * Convert a file URI to a path relative to the Thunder workspace root.
 * Returns null for ".", paths outside the workspace, or non-file URIs.
 */
export function toWorkspaceRelPath(uri: vscode.Uri, workspaceRoot: string): string | null {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  if (!root) return null;
  if (uri.scheme !== 'file') return null;

  const abs = resolve(uri.fsPath);
  const rel = relative(root, abs).replace(/\\/g, '/');

  if (!rel || rel === '.' || rel.startsWith('..')) return null;
  return rel;
}

export function createWorkspacePattern(workspaceRoot: string, pattern: string): vscode.RelativePattern {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  if (!root) {
    throw new Error(`${AGENT_NAME} workspace path is not set. Open a folder or set a path in Settings.`);
  }
  if (!existsSync(root)) {
    throw new Error(`${AGENT_NAME} workspace path does not exist: ${root}`);
  }
  return new vscode.RelativePattern(vscode.Uri.file(root), pattern);
}

/** VS Code findFiles only works reliably when the root is inside an open workspace folder. */
export function canUseVscodeFindFiles(workspaceRoot: string): boolean {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  if (!root) return false;
  return isWorkspaceInVscodeFolders(root);
}

/** Normalize tool/list paths — "." means workspace root (empty relative path). */
export function normalizeRelPath(path: string | undefined): string {
  if (!path) return '';
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (p === '.' || p === '/') return '';
  return p;
}

export function isPathInsideWorkspace(absPath: string, workspaceRoot: string): boolean {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  if (!root) return false;
  const rel = relative(root, resolve(absPath)).replace(/\\/g, '/');
  return Boolean(rel && rel !== '.' && !rel.startsWith('..'));
}

export function isWorkspaceInVscodeFolders(workspaceRoot: string): boolean {
  const resolved = normalizeWorkspaceRoot(workspaceRoot);
  if (!resolved) return false;
  return (vscode.workspace.workspaceFolders ?? []).some((f) => {
    const folder = resolve(f.uri.fsPath);
    return resolved === folder || resolved.startsWith(folder + '/');
  });
}

/**
 * Resolve a tool path to a workspace-relative path.
 * Handles absolute paths, pseudo-absolute paths (missing leading /), and embedded workspace roots.
 */
export function resolveWorkspaceRelPath(
  workspace: string,
  rawPath: string | undefined
): string | null {
  const normalizedWorkspace = normalizeWorkspaceRoot(workspace);
  if (!normalizedWorkspace) return null;

  const trimmed = rawPath?.trim() ?? '';
  if (!trimmed || trimmed === '.' || trimmed === './') return '';

  const normalized = trimmed.replace(/\\/g, '/');
  if (isWindowsAbsolutePath(trimmed)) {
    const relPath = win32.relative(win32.normalize(workspace), win32.normalize(trimmed));
    if (!relPath || relPath === '.') return '';
    if (relPath.startsWith('..') || isWindowsAbsolutePath(relPath)) return null;
    return normalizeRelPath(relPath);
  }

  if (isAbsolute(normalized)) {
    const relPath = relative(normalizedWorkspace, resolve(normalized)).replace(/\\/g, '/');
    if (!relPath || relPath === '.') return '';
    if (relPath.startsWith('..') || isAbsolute(relPath)) return null;
    return normalizeRelPath(relPath);
  }

  const wsNorm = normalizedWorkspace.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const wsLower = wsNorm.toLowerCase();
  if (lower.startsWith(wsLower + '/') || lower === wsLower) {
    const stripped = normalized.slice(wsNorm.length).replace(/^\/+/, '');
    return normalizeRelPath(stripped);
  }

  const usersIdx = lower.indexOf('/users/');
  if (usersIdx >= 0) {
    const candidate = normalized.slice(usersIdx);
    if (candidate.startsWith('/')) {
      const abs = resolve(candidate);
      if (isPathInsideWorkspace(abs, normalizedWorkspace)) {
        return normalizeRelPath(relative(normalizedWorkspace, abs).replace(/\\/g, '/'));
      }
    }
  }

  if (/^(?:users|home|var)\//i.test(normalized)) {
    const abs = resolve('/' + normalized);
    if (isPathInsideWorkspace(abs, normalizedWorkspace)) {
      return normalizeRelPath(relative(normalizedWorkspace, abs).replace(/\\/g, '/'));
    }
  }

  const relPath = normalizeRelPath(normalized);
  if (relPath.includes('..')) return null;
  return relPath;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

/** Common extension / naming variants when a path is missing. */
export function pathExistenceVariants(relPath: string): string[] {
  const variants = new Set<string>([relPath]);
  if (relPath.endsWith('.js')) variants.add(relPath.replace(/\.js$/, '.ts'));
  if (relPath.endsWith('.ts')) variants.add(relPath.replace(/\.ts$/, '.js'));
  if (relPath.endsWith('.mjs')) variants.add(relPath.replace(/\.mjs$/, '.ts'));
  if (relPath.endsWith('.cjs')) variants.add(relPath.replace(/\.cjs$/, '.ts'));
  if (relPath.endsWith('.ts')) {
    variants.add(relPath.replace(/\.ts$/, '.mjs'));
    variants.add(relPath.replace(/\.ts$/, '.js'));
  }
  if (relPath.endsWith('.jsx')) variants.add(relPath.replace(/\.jsx$/, '.tsx'));
  if (relPath.endsWith('.tsx')) variants.add(relPath.replace(/\.tsx$/, '.jsx'));
  if (relPath.endsWith('.md')) variants.add(relPath.replace(/\.md$/, '.mdx'));
  if (relPath.endsWith('.mdx')) variants.add(relPath.replace(/\.mdx$/, '.md'));
  if (/\/introduction\.mdx?$/i.test(relPath)) {
    variants.add(relPath.replace(/\/introduction\.mdx?$/i, '/intro.md'));
    variants.add(relPath.replace(/\/introduction\.mdx?$/i, '/intro.mdx'));
  }
  if (/\/install\.mdx?$/i.test(relPath)) {
    variants.add(relPath.replace(/\/install\.mdx?$/i, '/installation.md'));
  }
  if (/\/installation\.mdx?$/i.test(relPath)) {
    variants.add(relPath.replace(/\/installation\.mdx?$/i, '/install.md'));
  }
  if (relPath.includes('/index.')) {
    variants.add(relPath.replace(/\/index\.[^/]+$/, basename(relPath).replace(/^index\./, '')));
  } else if (/\.[a-z]+$/i.test(relPath)) {
    const dir = dirname(relPath);
    const file = basename(relPath);
    variants.add(join(dir, 'index.' + file.split('.').pop()!).replace(/\\/g, '/'));
  }
  return [...variants];
}

/** Find existing paths similar to a missing relative path. */
export function findSimilarWorkspacePaths(workspace: string, relPath: string, limit = 5): string[] {
  const root = normalizeWorkspaceRoot(workspace);
  if (!root) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string) => {
    const norm = normalizeRelPath(candidate);
    if (!norm || seen.has(norm)) return;
    if (existsSync(join(root, norm))) {
      seen.add(norm);
      found.push(norm);
    }
  };

  for (const variant of pathExistenceVariants(relPath)) {
    push(variant);
    if (found.length >= limit) return found;
  }

  const name = basename(relPath);
  if (name.length >= 4) {
    walkForBasename(root, root, name.toLowerCase(), found, seen, limit, 0, 5);
  }

  return found.slice(0, limit);
}

function walkForBasename(
  root: string,
  dir: string,
  targetName: string,
  found: string[],
  seen: Set<string>,
  limit: number,
  depth: number,
  maxDepth: number
): void {
  if (found.length >= limit || depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.mitii') continue;
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
      walkForBasename(root, abs, targetName, found, seen, limit, depth + 1, maxDepth);
    } else if (entry.toLowerCase() === targetName || entry.toLowerCase().includes(targetName)) {
      if (!seen.has(rel)) {
        seen.add(rel);
        found.push(rel);
      }
    }
    if (found.length >= limit) return;
  }
}

export function formatPathNotFoundHint(workspace: string, rawPath: string, relPath: string): string {
  const similar = findSimilarWorkspacePaths(workspace, relPath);
  if (similar.length === 0) {
    return `File not found: ${rawPath}. Use workspace-relative paths like apps/docs/docusaurus.config.ts`;
  }
  return [
    `File not found: ${rawPath}`,
    'Did you mean one of these?',
    ...similar.map((p) => `- ${p}`),
  ].join('\n');
}
