import * as vscode from 'vscode';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { IgnoreService } from './IgnoreService';
import { isBinaryByExtension, detectLanguage } from './fileUtils';
import type { IndexingConfig } from '../config/schema';

export interface DiscoveredFile {
  absPath: string;
  relPath: string;
  size: number;
  mtime: number;
  language: string | null;
}

export class FileDiscoveryService {
  constructor(
    private readonly workspacePath: string,
    private readonly ignoreService: IgnoreService,
    private readonly config: IndexingConfig
  ) {}

  discover(): DiscoveredFile[] {
    const results: DiscoveredFile[] = [];
    const exclude = this.getVsCodeExcludes();

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const absPath = join(dir, entry);
        const relPath = relative(this.workspacePath, absPath).replace(/\\/g, '/');

        if (this.ignoreService.isIgnored(relPath)) {
          continue;
        }

        if (this.isVsCodeExcluded(relPath, exclude)) {
          continue;
        }

        let stat;
        try {
          stat = statSync(absPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(absPath);
          continue;
        }

        if (!stat.isFile()) {
          continue;
        }

        if (stat.size > this.config.hardSkipSizeBytes) {
          continue;
        }

        if (isBinaryByExtension(relPath)) {
          continue;
        }

        results.push({
          absPath,
          relPath,
          size: stat.size,
          mtime: stat.mtimeMs,
          language: detectLanguage(relPath),
        });
      }
    };

    walk(this.workspacePath);
    return results;
  }

  private getVsCodeExcludes(): Record<string, boolean> {
    const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {});
    const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude', {});
    return { ...filesExclude, ...searchExclude };
  }

  private isVsCodeExcluded(relPath: string, exclude: Record<string, boolean>): boolean {
    for (const [pattern, enabled] of Object.entries(exclude)) {
      if (!enabled) {
        continue;
      }
      const regex = globToRegex(pattern);
      if (regex.test(relPath)) {
        return true;
      }
    }
    return false;
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
