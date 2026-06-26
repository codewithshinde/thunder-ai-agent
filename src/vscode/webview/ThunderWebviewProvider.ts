import * as vscode from 'vscode';
import { ThunderController } from '../../core/ThunderController';
import { createLogger } from '../../core/telemetry/Logger';
import { normalizeError, formatUserError } from '../../core/telemetry/errors';
import {
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
  type WebviewState,
  initialWebviewState,
} from './messages';

const log = createLogger('ThunderWebviewProvider');

export class ThunderWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'thunder.sidebar';

  private view: vscode.WebviewView | undefined;
  private state: WebviewState = initialWebviewState();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ThunderController
  ) {
    this.controller.setUiUpdateCallback((partial) => {
      this.state = { ...this.state, ...partial };
      this.postMessage({ type: 'state', payload: this.state });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.handleMessage(message);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  showChat(): void {
    this.setTab('chat');
  }

  showSettings(): void {
    this.setTab('settings');
  }

  private setTab(tab: WebviewState['tab']): void {
    this.state = { ...this.state, tab };
    this.postMessage({ type: 'setTab', payload: tab });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async syncState(): Promise<void> {
    this.state = await this.controller.buildUiState(this.state);
    this.postMessage({ type: 'state', payload: this.state });
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.syncState();
        break;

      case 'sendMessage': {
        const content = message.payload.content.trim();
        if (!content || this.state.loading) return;

        const userMessage = {
          id: `msg-${Date.now()}`,
          role: 'user' as const,
          content,
          timestamp: Date.now(),
        };

        this.state = {
          ...this.state,
          loading: true,
          error: null,
          messages: [...this.state.messages, userMessage],
        };
        this.postMessage({ type: 'state', payload: this.state });

        try {
          const stream = await this.controller.sendMessage(content);
          const assistantId = `msg-${Date.now()}-assistant`;
          let fullContent = '';

          this.state = {
            ...this.state,
            messages: [
              ...this.state.messages,
              { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true },
            ],
          };
          this.postMessage({ type: 'state', payload: this.state });

          for await (const chunk of stream) {
            fullContent += chunk;
            this.postMessage({
              type: 'updateLastAssistant',
              payload: { content: fullContent, streaming: true },
            });
          }

          this.state = {
            ...this.state,
            loading: false,
            messages: this.state.messages.map((m) =>
              m.id === assistantId ? { ...m, content: fullContent, streaming: false } : m
            ),
          };
          this.postMessage({ type: 'state', payload: this.state });
        } catch (error) {
          const safe = normalizeError(error);
          this.state = { ...this.state, loading: false, error: formatUserError(safe) };
          this.postMessage({ type: 'state', payload: this.state });
          log.error('sendMessage failed', { message: safe.message });
        }
        break;
      }

      case 'setMode':
        this.state = { ...this.state, mode: message.payload };
        this.controller.getSession()?.setMode(message.payload);
        this.postMessage({ type: 'setMode', payload: message.payload });
        break;

      case 'setTab':
        this.state = { ...this.state, tab: message.payload };
        this.postMessage({ type: 'setTab', payload: message.payload });
        break;

      case 'stopGeneration':
        this.controller.stopGeneration();
        this.state = { ...this.state, loading: false };
        this.postMessage({ type: 'setLoading', payload: false });
        break;

      case 'clearError':
        this.state = { ...this.state, error: null };
        this.postMessage({ type: 'setError', payload: null });
        break;

      case 'resolveApproval':
        await this.controller.resolveApproval(message.payload.id, message.payload.decision);
        await this.syncState();
        break;

      case 'saveApiKey':
        if (message.payload.key.trim()) {
          await this.controller.saveApiKey(message.payload.key.trim());
          await this.syncState();
        }
        break;

      case 'indexWorkspace':
        await this.controller.indexWorkspace();
        await this.syncState();
        break;

      case 'restoreCheckpoint':
        await this.controller.restoreCheckpoint(message.payload.id);
        await this.syncState();
        break;

      case 'deleteMemory':
        this.controller.deleteMemory(message.payload.id);
        await this.syncState();
        break;

      case 'clearMemory':
        this.controller.clearMemory();
        await this.syncState();
        break;

      case 'toggleContextSource':
        this.controller.setContextToggle(message.payload.source, message.payload.enabled);
        await this.syncState();
        break;

      case 'toggleContextPreview':
        this.state = { ...this.state, showContextPreview: !this.state.showContextPreview };
        this.postMessage({ type: 'state', payload: this.state });
        break;

      case 'copyLastResponse': {
        const lastAssistant = [...this.state.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant?.content) {
          await vscode.env.clipboard.writeText(lastAssistant.content);
        }
        break;
      }

      case 'refreshPanels':
        this.controller.refreshMemoryPanel();
        this.controller.refreshCheckpointPanel();
        await this.syncState();
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'assets', 'index.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Thunder AI Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
