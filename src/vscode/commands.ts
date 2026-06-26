import * as vscode from 'vscode';
import { ThunderController } from '../core/ThunderController';
import { ThunderWebviewProvider } from './webview/ThunderWebviewProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: ThunderController,
  webviewProvider: ThunderWebviewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('thunder.openChat', async () => {
      await vscode.commands.executeCommand('thunder.sidebar.focus');
      webviewProvider.showChat();
    }),

    vscode.commands.registerCommand('thunder.indexWorkspace', async () => {
      await controller.indexWorkspace();
    }),

    vscode.commands.registerCommand('thunder.showSettings', async () => {
      await vscode.commands.executeCommand('thunder.sidebar.focus');
      webviewProvider.showSettings();
    })
  );
}
