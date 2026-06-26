import * as vscode from 'vscode';
import type { ContextItem, ContextQuery, ContextSource } from './types';
import { GitService } from './GitService';

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
  getDiagnostics(): Array<{ file: string; severity: string; message: string; line: number }> {
    const results: Array<{ file: string; severity: string; message: string; line: number }> = [];

    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const relPath = vscode.workspace.asRelativePath(uri);
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
}

export class DiagnosticsContextSource implements ContextSource {
  readonly id = 'diagnostics';

  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  async retrieve(_query: ContextQuery): Promise<ContextItem[]> {
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
