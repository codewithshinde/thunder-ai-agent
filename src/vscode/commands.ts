import * as vscode from 'vscode';
import { ThunderController } from '../core/app/ThunderController';
import { ThunderWebviewProvider } from './webview/ThunderWebviewProvider';
import { registerScmContributions } from './scm/registerScmContributions';

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
    }),

    vscode.commands.registerCommand('thunder.exportSessionLog', async () => {
      await controller.exportSessionLog();
    }),

    vscode.commands.registerCommand('thunder.exportAuditPack', async () => {
      await controller.exportAuditPack();
    }),

    vscode.commands.registerCommand('thunder.openSessionLog', async () => {
      await controller.openSessionLog();
    }),

    vscode.commands.registerCommand('thunder.generateChangelog', async () => {
      await controller.generateChangelog();
    }),

    vscode.commands.registerCommand('thunder.prepareRelease', async () => {
      await controller.prepareRelease();
    }),

    vscode.commands.registerCommand('thunder.showInlineDiff', async (approvalId?: string) => {
      if (typeof approvalId === 'string') {
        await controller.showInlineDiffForApproval(approvalId);
      }
    })
  );

  registerScmContributions(context, controller);
}
