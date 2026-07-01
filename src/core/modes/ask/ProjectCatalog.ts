import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { ContextItem, ContextQuery, ContextSource } from '../../context/types';
import type { ProjectCatalog, ProjectNode } from './askTypes';

const SKIP_DIRS = new Set([
  '.git',
  '.mitii',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.docusaurus',
  'out',
]);

const ENTRY_CANDIDATES = [
  'src/extension.ts',
  'src/index.ts',
  'src/main.ts',
  'src/App.tsx',
  'app/page.tsx',
  'pages/index.tsx',
  'docs/index.md',
  'docusaurus.config.ts',
  'vite.config.ts',
  'next.config.js',
  'README.md',
];

export function discoverProjectCatalog(workspaceRoot: string): ProjectCatalog {
  const roots = new Set<string>();
  if (existsSync(join(workspaceRoot, 'package.json'))) roots.add('.');

  for (const pattern of readPnpmWorkspacePatterns(workspaceRoot)) {
    for (const root of expandWorkspacePattern(workspaceRoot, pattern)) {
      if (existsSync(join(workspaceRoot, root, 'package.json'))) roots.add(root || '.');
    }
  }

  for (const relDir of walkDirs(workspaceRoot, '.', 4, 300)) {
    if (existsSync(join(workspaceRoot, relDir, 'package.json'))) roots.add(relDir);
    if (existsSync(join(workspaceRoot, relDir, 'Cargo.toml'))) roots.add(relDir);
    if (existsSync(join(workspaceRoot, relDir, 'go.mod'))) roots.add(relDir);
  }

  const projects = Array.from(roots)
    .sort((a, b) => projectSortKey(a).localeCompare(projectSortKey(b)))
    .map((root) => readProjectNode(workspaceRoot, root))
    .filter((project): project is ProjectNode => Boolean(project));

  return {
    workspaceRoot,
    projects,
    generatedAt: new Date().toISOString(),
  };
}

export function saveProjectCatalog(catalog: ProjectCatalog): void {
  const dir = join(catalog.workspaceRoot, '.mitii');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(catalog, null, 2), 'utf8');
}

export function loadProjectCatalog(workspaceRoot: string): ProjectCatalog {
  const path = join(workspaceRoot, '.mitii', 'projects.json');
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProjectCatalog;
      if (Array.isArray(parsed.projects)) return parsed;
    } catch {
      // Fall through to live discovery.
    }
  }
  return discoverProjectCatalog(workspaceRoot);
}

export function formatProjectCatalog(catalog: ProjectCatalog): string {
  if (catalog.projects.length === 0) return 'No project markers found.';
  const lines = [
    '## Workspace projects',
    '| ID | Root | Type | Entry files | Scripts |',
    '|---|---|---|---|---|',
  ];
  for (const project of catalog.projects) {
    lines.push(
      `| ${project.id} | ${project.root} | ${project.type} | ${project.entryFiles.join(', ') || '(none)'} | ${Object.keys(project.scripts).join(', ') || '(none)'} |`
    );
  }
  return lines.join('\n');
}

export class ProjectCatalogContextSource implements ContextSource {
  readonly id = 'project-catalog';

  constructor(private readonly workspaceRoot: string) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    if (!isProjectScopeQuestion(query.text)) return [];
    const catalog = loadProjectCatalog(this.workspaceRoot);
    const content = formatProjectCatalog(catalog);
    return [{
      id: 'project-catalog',
      source: this.id,
      content,
      score: 12,
      reason: 'Detected workspace project catalog',
      tokenEstimate: Math.ceil(content.length / 4),
    }];
  }
}

function readProjectNode(workspaceRoot: string, root: string): ProjectNode | null {
  const absRoot = join(workspaceRoot, root === '.' ? '' : root);
  const pkg = readJson(join(absRoot, 'package.json'));
  const cargo = readTomlName(join(absRoot, 'Cargo.toml'));
  const goName = readGoModule(join(absRoot, 'go.mod'));
  const name = String(pkg?.name ?? cargo ?? goName ?? (root === '.' ? basename(workspaceRoot) : basename(root)));
  const scripts = normalizeScripts(pkg?.scripts);
  const entryFiles = ENTRY_CANDIDATES.filter((candidate) => existsSync(join(absRoot, candidate)));

  return {
    id: toProjectId(root === '.' ? name : root),
    root,
    name,
    type: inferProjectType(root, name, pkg, scripts, entryFiles),
    entryFiles,
    scripts,
  };
}

function inferProjectType(
  root: string,
  name: string,
  pkg: Record<string, unknown> | undefined,
  scripts: Record<string, string>,
  entryFiles: string[]
): ProjectNode['type'] {
  const haystack = [
    root,
    name,
    Object.keys(scripts).join(' '),
    Object.keys((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}).join(' '),
    Object.keys((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}).join(' '),
    entryFiles.join(' '),
  ].join(' ').toLowerCase();

  if (haystack.includes('vscode') || entryFiles.includes('src/extension.ts')) return 'extension';
  if (haystack.includes('docusaurus') || /\bdocs?\b/.test(haystack)) return 'docs';
  if (haystack.includes('next') || haystack.includes('vite') || haystack.includes('website') || haystack.includes('web')) return 'web';
  if (haystack.includes('express') || haystack.includes('fastify') || haystack.includes('server')) return 'service';
  if (root.includes('packages/') || name.startsWith('@')) return 'lib';
  return 'unknown';
}

function normalizeScripts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const scripts: Record<string, string> = {};
  for (const [key, command] of Object.entries(value as Record<string, unknown>)) {
    if (typeof command === 'string') scripts[key] = command;
  }
  return scripts;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readTomlName(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  return content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
}

function readGoModule(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  return content.match(/^\s*module\s+(.+)$/m)?.[1];
}

function readPnpmWorkspacePatterns(workspaceRoot: string): string[] {
  const path = join(workspaceRoot, 'pnpm-workspace.yaml');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const patterns: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (match) patterns.push(match[1]);
  }
  return patterns;
}

function expandWorkspacePattern(workspaceRoot: string, pattern: string): string[] {
  if (!pattern.endsWith('/*')) return [pattern.replace(/\/+$/, '')];
  const base = pattern.slice(0, -2);
  const absBase = join(workspaceRoot, base);
  if (!existsSync(absBase)) return [];
  return readdirSync(absBase)
    .filter((entry) => isDirectory(join(absBase, entry)))
    .map((entry) => `${base}/${entry}`);
}

function walkDirs(workspaceRoot: string, start: string, maxDepth: number, maxDirs: number): string[] {
  const dirs: string[] = [];
  const visit = (relDir: string, depth: number): void => {
    if (dirs.length >= maxDirs || depth > maxDepth) return;
    const absDir = join(workspaceRoot, relDir === '.' ? '' : relDir);
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dirs.length >= maxDirs || SKIP_DIRS.has(entry)) continue;
      const childRel = relDir === '.' ? entry : `${relDir}/${entry}`;
      if (!isDirectory(join(workspaceRoot, childRel))) continue;
      dirs.push(childRel);
      visit(childRel, depth + 1);
    }
  };
  visit(start, 0);
  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isProjectScopeQuestion(text: string): boolean {
  return /\b(project|package|workspace|monorepo|docs|website|extension|app|library|service|scope|where is)\b/i.test(text);
}

function toProjectId(value: string): string {
  const last = value.split('/').filter(Boolean).at(-1) ?? value;
  return last.replace(/^@/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'root';
}

function projectSortKey(root: string): string {
  return root === '.' ? '0' : `1:${root}`;
}
