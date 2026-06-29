import * as vscode from 'vscode';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export async function showWriteDiffPreview(
  workspace: string,
  relPath: string,
  newContent: string
): Promise<void> {
  const originalPath = join(workspace, relPath);
  const previewDir = join(workspace, '.mitii', 'diff-preview');
  mkdirSync(previewDir, { recursive: true });
  const previewPath = join(previewDir, relPath.replace(/\//g, '__'));
  mkdirSync(dirname(previewPath), { recursive: true });

  writeFileSync(previewPath, newContent, 'utf-8');

  const originalUri = vscode.Uri.file(originalPath);
  const previewUri = vscode.Uri.file(previewPath);

  const title = existsSync(originalPath)
    ? `${relPath} (current ↔ proposed)`
    : `${relPath} (new file)`;

  await vscode.commands.executeCommand('vscode.diff', originalUri, previewUri, title);
}

export async function showPatchDiffPreview(
  workspace: string,
  relPath: string,
  oldText: string,
  newText: string
): Promise<void> {
  const previewDir = join(workspace, '.mitii', 'diff-preview');
  mkdirSync(previewDir, { recursive: true });
  const oldPath = join(previewDir, `old__${relPath.replace(/\//g, '__')}`);
  const newPath = join(previewDir, `new__${relPath.replace(/\//g, '__')}`);
  mkdirSync(dirname(oldPath), { recursive: true });
  writeFileSync(oldPath, oldText, 'utf-8');
  writeFileSync(newPath, newText, 'utf-8');

  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(oldPath),
    vscode.Uri.file(newPath),
    `${relPath} (patch preview)`
  );
}
