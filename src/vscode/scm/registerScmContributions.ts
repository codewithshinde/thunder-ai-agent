import * as vscode from 'vscode';
import { brandMessage } from '../../shared/brand';
import type { ThunderController } from '../../core/ThunderController';
import { setGitCommitInputBox } from './ScmInputBoxBridge';

export function registerScmContributions(
  context: vscode.ExtensionContext,
  controller: ThunderController
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('thunder.generateCommitMessage', async () => {
      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
      status.name = 'Mitii commit message generation';
      status.text = '$(sync~spin) Mitii generating commit message';
      status.tooltip = 'Mitii is reading staged changes and asking the model for a commit message.';
      status.show();
      try {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Mitii: Generating commit message',
          cancellable: false,
        }, async (progress) => {
          progress.report({ message: 'Reading staged changes and recent commits…' });
          const result = await controller.generateCommitMessage();
          progress.report({ message: 'Writing message to Source Control…' });
          const workspace = controller.resolveWorkspacePath();
          const applied = workspace
            ? await setGitCommitInputBox(workspace, result.fullMessage)
            : false;
          if (!applied) {
            await vscode.env.clipboard.writeText(result.fullMessage);
            void vscode.window.showWarningMessage(
              brandMessage('Could not find the Git input box, so the commit message was copied to clipboard.')
            );
            return;
          }
          void vscode.window.showInformationMessage(brandMessage('Commit message added to Source Control.'));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(brandMessage(message));
      } finally {
        status.dispose();
      }
    })
  );
}
