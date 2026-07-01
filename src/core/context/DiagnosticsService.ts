import * as vscode from 'vscode';
import type { ContextItem, ContextQuery, ContextSource } from './types';
import { GitService } from './GitService';
import { toWorkspaceRelPath } from '../util/paths';
import { isDiagnosticsRelevant } from './contextRelevance';

export class GitDiffContextSource implements ContextSource {
  readonly id = 'git-diff';

  constructor(private readonly gitService: GitService) {}

  async retrieve(_query: ContextQuery): Promise<ContextItem[]> {
    const diff = await this.gitService.getDiff();
    if (!diff) return [];

    return [{
      id: 'git-diff',
      source: this.id,
      content: diff,
      score: 6,
      reason: 'Git diff of changed files',
      tokenEstimate: Math.ceil(diff.length / 4),
    }];
  }
}

export class DiagnosticsService {
  private workspaceRoot = '';

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  getDiagnostics(): Array<{ file: string; severity: string; message: string; line: number }> {
    const results: Array<{ file: string; severity: string; message: string; line: number }> = [];

    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const relPath = this.workspaceRoot
        ? toWorkspaceRelPath(uri, this.workspaceRoot)
        : safeAsRelativePath(uri);
      if (!relPath) continue;

      for (const d of diags) {
        results.push({
          file: relPath,
          severity: vscode.DiagnosticSeverity[d.severity].toLowerCase(),
          message: d.message,
          line: d.range.start.line + 1,
        });
      }
    }
    return results;
  }

  formatCompact(maxItems = 20): string {
    const diags = this.getDiagnostics().slice(0, maxItems);
    return diags.map((d) => `${d.file}:${d.line} [${d.severity}] ${d.message}`).join('\n');
  }

  getHeavyFiles(): string[] {
    const counts = new Map<string, number>();
    for (const d of this.getDiagnostics()) {
      counts.set(d.file, (counts.get(d.file) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([file]) => file);
  }

  getFileErrors(relPath: string): Array<{ line: number; message: string }> {
    return this.getDiagnostics()
      .filter((d) => d.file === relPath && d.severity === 'error')
      .map((d) => ({ line: d.line, message: d.message }));
  }

  async waitForFileErrors(relPath: string, maxWaitMs = 2500): Promise<Array<{ line: number; message: string }>> {
    const deadline = Date.now() + maxWaitMs;
    let lastCount = -1;
    let stableRounds = 0;
    let latest: Array<{ line: number; message: string }> = [];

    while (Date.now() < deadline) {
      latest = this.getFileErrors(relPath);
      if (latest.length === lastCount) {
        stableRounds += 1;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
        lastCount = latest.length;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    return latest;
  }
}

function safeAsRelativePath(uri: vscode.Uri): string | null {
  if (uri.scheme !== 'file') return null;
  const rel = vscode.workspace.asRelativePath(uri, false);
  if (!rel || rel === '.' || rel.startsWith('..')) return null;
  return rel;
}

export class DiagnosticsContextSource implements ContextSource {
  readonly id = 'diagnostics';

  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    if (!isDiagnosticsRelevant(query.text)) return [];

    const formatted = this.diagnosticsService.formatCompact();
    if (!formatted) return [];

    return [{
      id: 'diagnostics',
      source: this.id,
      content: formatted,
      score: 5,
      reason: 'VS Code diagnostics (errors/warnings)',
      tokenEstimate: Math.ceil(formatted.length / 4),
    }];
  }
}
