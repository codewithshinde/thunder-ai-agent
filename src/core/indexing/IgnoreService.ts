import ignore, { type Ignore } from 'ignore';
import { readFileSync, existsSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('IgnoreService');

const DEFAULT_IGNORES = [
  'node_modules/',
  '.git/',
  '.mitii/',
  '.thunder/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  'coverage/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

export class IgnoreService {
  private ig: Ignore = ignore().add(DEFAULT_IGNORES);
  private workspacePath = '';

  load(workspacePath: string, options?: { respectGitignore?: boolean; respectThunderignore?: boolean }): void {
    this.workspacePath = resolve(workspacePath);
    this.ig = ignore().add(DEFAULT_IGNORES);

    if (options?.respectGitignore !== false) {
      const gitignorePath = join(workspacePath, '.gitignore');
      if (existsSync(gitignorePath)) {
        try {
          const content = readFileSync(gitignorePath, 'utf-8');
          this.ig.add(content);
        } catch {
          log.warn('Failed to read .gitignore');
        }
      }
    }

    if (options?.respectThunderignore !== false) {
      const ignorePath = join(workspacePath, '.mitiiignore');
      if (existsSync(ignorePath)) {
        try {
          const content = readFileSync(ignorePath, 'utf-8');
          this.ig.add(content);
        } catch {
          log.warn('Failed to read Mitii ignore file');
        }
      }
    }
  }

  isIgnored(relPath: string): boolean {
    const normalized = normalizeIgnorePath(relPath, this.workspacePath);
    if (!normalized || normalized === '.') return false;
    if (normalized.startsWith('..')) return true;
    return this.ig.ignores(normalized);
  }

  filter(paths: string[]): string[] {
    return paths.filter((p) => !this.isIgnored(p));
  }
}

function normalizeIgnorePath(path: string, workspacePath: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';

  if (isAbsolute(trimmed)) {
    const rel = workspacePath
      ? relative(workspacePath, resolve(trimmed)).replace(/\\/g, '/')
      : trimmed.replace(/\\/g, '/');
    return rel || '.';
  }

  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}
