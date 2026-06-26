import * as vscode from 'vscode';
import type { ContextItem, ContextQuery, ContextSource } from '../types';

export class CurrentEditorContextSource implements ContextSource {
  readonly id = 'current-editor';

  async retrieve(_query: ContextQuery): Promise<ContextItem[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];

    const doc = editor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const selection = editor.selection;
    let content: string;
    let reason: string;

    if (!selection.isEmpty) {
      content = doc.getText(selection);
      reason = `Selected text in ${relPath} (lines ${selection.start.line + 1}-${selection.end.line + 1})`;
    } else {
      content = doc.getText();
      reason = `Currently open file: ${relPath}`;
    }

    return [{
      id: `editor-${relPath}`,
      source: this.id,
      relPath,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      content: content.slice(0, 4000),
      score: 10,
      reason,
      tokenEstimate: Math.ceil(content.length / 4),
    }];
  }
}

export class OpenFilesContextSource implements ContextSource {
  readonly id = 'open-files';

  async retrieve(_query: ContextQuery): Promise<ContextItem[]> {
    const items: ContextItem[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input && typeof input === 'object' && 'uri' in input) {
          const uri = (input as { uri: vscode.Uri }).uri;
          if (uri.scheme === 'file') {
            const relPath = vscode.workspace.asRelativePath(uri);
            const doc = await vscode.workspace.openTextDocument(uri);
            items.push({
              id: `open-${relPath}`,
              source: this.id,
              relPath,
              content: doc.getText().slice(0, 2000),
              score: 5,
              reason: `Open tab: ${relPath}`,
              tokenEstimate: Math.ceil(doc.getText().length / 4),
            });
          }
        }
      }
    }
    return items.slice(0, 5);
  }
}
