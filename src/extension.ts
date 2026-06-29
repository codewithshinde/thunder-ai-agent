import * as vscode from 'vscode';
import { ThunderController } from './core/ThunderController';
import { registerCommands } from './vscode/commands';
import { ThunderWebviewProvider } from './vscode/webview/ThunderWebviewProvider';
import { createLogger } from './core/telemetry/Logger';
import { AGENT_FULL_NAME } from './shared/brand';

const log = createLogger('extension');

let controller: ThunderController | undefined;
let webviewProvider: ThunderWebviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info(`${AGENT_FULL_NAME} activating`);

  controller = new ThunderController(context);
  await controller.initialize();

  webviewProvider = new ThunderWebviewProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ThunderWebviewProvider.viewType,
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  registerCommands(context, controller, webviewProvider);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void controller?.reloadWorkspace();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void controller?.notifyTrustChanged();
    })
  );

  log.info(`${AGENT_FULL_NAME} activated`);
}

export function deactivate(): void {
  log.info(`${AGENT_FULL_NAME} deactivating`);
  controller?.dispose();
  controller = undefined;
  webviewProvider = undefined;
}
