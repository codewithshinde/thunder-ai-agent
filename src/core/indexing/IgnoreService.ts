import ignore, { type Ignore } from 'ignore';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('IgnoreService');

const DEFAULT_IGNORES = [
  'node_modules/',
  '.git/',
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

  load(workspacePath: string, options?: { respectGitignore?: boolean; respectThunderignore?: boolean }): void {
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
      const thunderignorePath = join(workspacePath, '.thunderignore');
      if (existsSync(thunderignorePath)) {
        try {
          const content = readFileSync(thunderignorePath, 'utf-8');
          this.ig.add(content);
        } catch {
          log.warn('Failed to read .thunderignore');
        }
      }
    }
  }

  isIgnored(relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    return this.ig.ignores(normalized);
  }

  filter(paths: string[]): string[] {
    return paths.filter((p) => !this.isIgnored(p));
  }
}
