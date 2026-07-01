import * as vscode from 'vscode';
import type { ContextItem, ContextQuery, ContextSource } from '../types';
import { toWorkspaceRelPath } from '../../util/paths';
import { scorePassiveFileContext } from '../contextRelevance';
import {
  applyContentTier,
  getSourceContentTier,
  loadFileSignatures,
} from '../contextTier';
import type { ThunderDb } from '../../indexing/ThunderDb';

export class CurrentEditorContextSource implements ContextSource {
  readonly id = 'current-editor';

  constructor(
    private readonly workspace: string,
    private readonly db?: ThunderDb
  ) {}

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

    const rawContent = hasSelection ? doc.getText(selection) : doc.getText();
    const tier = getSourceContentTier(this.id, { hasSelection });
    const symbols = this.db ? loadFileSignatures(this.db, this.workspace, relPath) : [];
    const { content, reasonSuffix } = applyContentTier(rawContent, tier, symbols);

    return [{
      id: `editor-${relPath}`,
      source: this.id,
      relPath,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      content: content.slice(0, 4000),
      score,
      reason: hasSelection
        ? `Selected text in ${relPath} (lines ${selection.start.line + 1}-${selection.end.line + 1})`
        : `Open file relevant to query: ${relPath}${reasonSuffix}`,
      tokenEstimate: Math.ceil(content.length / 4),
    }];
  }
}

export class OpenFilesContextSource implements ContextSource {
  readonly id = 'open-files';

  constructor(
    private readonly workspace: string,
    private readonly db?: ThunderDb
  ) {}

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
          const tier = getSourceContentTier(this.id, {});
          const symbols = this.db ? loadFileSignatures(this.db, this.workspace, relPath) : [];
          const { content, reasonSuffix } = applyContentTier(doc.getText(), tier, symbols);

          items.push({
            id: `open-${relPath}`,
            source: this.id,
            relPath,
            content: content.slice(0, 2000),
            score: Math.min(score, 5),
            reason: `Open tab relevant to query: ${relPath}${reasonSuffix}`,
            tokenEstimate: Math.ceil(content.length / 4),
          });
        }
      }
    }
    return items.slice(0, 5);
  }
}
