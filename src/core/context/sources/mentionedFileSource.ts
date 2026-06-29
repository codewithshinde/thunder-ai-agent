import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import * as vscode from 'vscode';
import type { ContextItem, ContextQuery, ContextSource } from '../types';
import {
  extractFileMentions,
  expandCamelCaseTerms,
  globPatternsForMention,
} from '../fuzzyFileMatch';
import { createWorkspacePattern, canUseVscodeFindFiles, toWorkspaceRelPath } from '../../vscode/pathUtils';
import { createLogger } from '../../telemetry/Logger';

const log = createLogger('MentionedFileSource');
const MAX_FILE_CHARS = 16_000;

export class MentionedFileContextSource implements ContextSource {
  readonly id = 'mentioned-files';

  constructor(private readonly workspace: string) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const mentions = extractFileMentions(query.text);
    if (mentions.length === 0) return [];

    const items: ContextItem[] = [];
    const seen = new Set<string>();
    const searchedPatterns: string[] = [];

    for (const mention of mentions.slice(0, 5)) {
      const relPaths = await findMatchingFiles(this.workspace, mention, searchedPatterns);
      for (const relPath of relPaths) {
        if (!relPath || relPath === '.' || seen.has(relPath)) continue;
        seen.add(relPath);

        const absPath = join(this.workspace, relPath);
        if (!existsSync(absPath)) continue;

        try {
          const content = readFileSync(absPath, 'utf-8').slice(0, MAX_FILE_CHARS);
          const fuzzy = !relPath.endsWith(mention) && !relPath.includes(mention);
          items.push({
            id: `mention-${relPath}`,
            source: this.id,
            relPath,
            content,
            score: fuzzy ? 13 : 14,
            reason: fuzzy
              ? `Fuzzy file match for "${mention}" → ${relPath}`
              : `File mentioned in user message: ${relPath}`,
            tokenEstimate: Math.ceil(content.length / 4),
          });
        } catch {
          // Skip unreadable files.
        }

        if (items.length >= 5) return items;
      }
    }

    if (items.length === 0) {
      const searched = mentions.slice(0, 5).join(', ');
      const hint = searchedPatterns.length
        ? ` Patterns tried: ${searchedPatterns.slice(0, 6).join(', ')}.`
        : '';
      return [{
        id: 'mention-not-found',
        source: this.id,
        content: `Searched the workspace for: ${searched}. No matching files were found.${hint}`,
        score: 12,
        reason: 'Mentioned files not found in workspace',
        tokenEstimate: 40,
      }];
    }

    return items;
  }
}

async function findMatchingFiles(
  workspace: string,
  mention: string,
  searchedPatterns: string[]
): Promise<string[]> {
  const patterns = globPatternsForMention(mention);
  const exclude = '**/{node_modules,.git,dist,out,build,.mitii,.thunder}/**';
  const uris: vscode.Uri[] = [];

  if (!canUseVscodeFindFiles(workspace)) {
    return walkFindOnDisk(workspace, mention, 5);
  }

  for (const pattern of patterns) {
    searchedPatterns.push(pattern);
    try {
      const found = await vscode.workspace.findFiles(
        createWorkspacePattern(workspace, pattern),
        exclude,
        5
      );
      uris.push(...found);
    } catch (error) {
      log.warn('findFiles failed, using disk fallback', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
      return walkFindOnDisk(workspace, mention, 5);
    }
    if (uris.length >= 5) break;
  }

  if (uris.length > 0) {
    return [...new Set(
      uris
        .map((u) => toWorkspaceRelPath(u, workspace))
        .filter((p): p is string => Boolean(p))
    )];
  }

  for (const term of expandCamelCaseTerms(mention)) {
    if (term.length < 4) continue;
    const pattern = `**/*${term}*`;
    searchedPatterns.push(pattern);
    try {
      const found = await vscode.workspace.findFiles(
        createWorkspacePattern(workspace, pattern),
        exclude,
        5
      );
      uris.push(...found);
    } catch {
      return walkFindOnDisk(workspace, term, 5);
    }
    if (uris.length >= 5) break;
  }

  if (uris.length > 0) {
    return [...new Set(
      uris
        .map((u) => toWorkspaceRelPath(u, workspace))
        .filter((p): p is string => Boolean(p))
    )];
  }

  return walkFindOnDisk(workspace, mention, 5);
}

function walkFindOnDisk(workspace: string, needle: string, limit: number): string[] {
  const root = resolve(workspace);
  const results: string[] = [];
  const needleLower = needle.toLowerCase().replace(/^\.\//, '');

  const walk = (dir: string, depth: number): void => {
    if (results.length >= limit || depth > 10) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (['node_modules', '.git', '.mitii', '.thunder', 'dist', 'build', 'out'].includes(entry)) continue;
      const abs = join(dir, entry);
      let rel: string;
      try {
        rel = relative(root, abs).replace(/\\/g, '/');
      } catch {
        continue;
      }
      if (!rel || rel === '.' || rel.startsWith('..')) continue;

      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        walk(abs, depth + 1);
      } else if (
        entry.toLowerCase().includes(needleLower) ||
        rel.toLowerCase().includes(needleLower)
      ) {
        results.push(rel);
        if (results.length >= limit) return;
      }
    }
  };

  walk(root, 0);
  return results;
}
