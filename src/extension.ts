import * as vscode from 'vscode';
import { ThunderController } from './core/ThunderController';
import { registerCommands } from './vscode/commands';
import { ThunderWebviewProvider } from './vscode/webview/ThunderWebviewProvider';
import { createLogger } from './core/telemetry/Logger';

const log = createLogger('extension');

let controller: ThunderController | undefined;
let webviewProvider: ThunderWebviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('Thunder AI Agent activating');

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

  log.info('Thunder AI Agent activated');
}

export function deactivate(): void {
  log.info('Thunder AI Agent deactivating');
  controller?.dispose();
  controller = undefined;
  webviewProvider = undefined;
}
