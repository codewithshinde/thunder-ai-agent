import * as vscode from 'vscode';
import type { ContextItem, ContextQuery, ContextSource } from '../types';
import { toWorkspaceRelPath } from '../../vscode/pathUtils';
import { scorePassiveFileContext } from '../contextRelevance';

export class CurrentEditorContextSource implements ContextSource {
  readonly id = 'current-editor';

  constructor(private readonly workspace: string) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];

    const doc = editor.document;
    const relPath = toWorkspaceRelPath(doc.uri, this.workspace);
    if (!relPath) return [];

    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    const score = scorePassiveFileContext(query.text, relPath, { hasSelection });
    if (score === 0) return [];

    let content: string;
    let reason: string;

    if (hasSelection) {
      content = doc.getText(selection);
      reason = `Selected text in ${relPath} (lines ${selection.start.line + 1}-${selection.end.line + 1})`;
    } else {
      content = doc.getText();
      reason = `Open file relevant to query: ${relPath}`;
    }

    return [{
      id: `editor-${relPath}`,
      source: this.id,
      relPath,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      content: content.slice(0, 4000),
      score,
      reason,
      tokenEstimate: Math.ceil(content.length / 4),
    }];
  }
}

export class OpenFilesContextSource implements ContextSource {
  readonly id = 'open-files';

  constructor(private readonly workspace: string) {}

  async retrieve(query: ContextQuery): Promise<ContextItem[]> {
    const items: ContextItem[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input && typeof input === 'object' && 'uri' in input) {
          const uri = (input as { uri: vscode.Uri }).uri;
          if (uri.scheme !== 'file') continue;

          const relPath = toWorkspaceRelPath(uri, this.workspace);
          if (!relPath) continue;

          const score = scorePassiveFileContext(query.text, relPath);
          if (score === 0) continue;

          const doc = await vscode.workspace.openTextDocument(uri);
          items.push({
            id: `open-${relPath}`,
            source: this.id,
            relPath,
            content: doc.getText().slice(0, 2000),
            score: Math.min(score, 5),
            reason: `Open tab relevant to query: ${relPath}`,
            tokenEstimate: Math.ceil(doc.getText().length / 4),
          });
        }
      }
    }
    return items.slice(0, 5);
  }
}
