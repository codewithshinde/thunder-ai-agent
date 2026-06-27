import * as vscode from 'vscode';
import { ThunderController } from '../../core/ThunderController';
import { createLogger } from '../../core/telemetry/Logger';
import { normalizeError, formatUserError } from '../../core/telemetry/errors';
import {
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
  type WebviewState,
  type ChatMessage,
  type ChatThreadSummary,
  initialWebviewState,
} from './messages';

const log = createLogger('ThunderWebviewProvider');

function removeTrailingAssistant(messages: ChatMessage[]): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role === 'assistant') {
    next.pop();
  }
  return next;
}

export class ThunderWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'thunder.sidebar';

  private view: vscode.WebviewView | undefined;
  private state: WebviewState = initialWebviewState();
  private archivedThreads = new Map<string, { summary: ChatThreadSummary; messages: ChatMessage[] }>();
  private isStreaming = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ThunderController
  ) {
    this.controller.setUiUpdateCallback((partial) => {
      this.state = { ...this.state, ...partial };

      if (this.isStreaming) {
        if (partial.agentActivity) {
          this.postMessage({ type: 'setAgentActivity', payload: partial.agentActivity });
        }
        if ('plan' in partial) {
          this.postMessage({ type: 'setPlan', payload: partial.plan ?? null });
        }
        if ('agentLiveStatus' in partial) {
          this.postMessage({ type: 'setAgentLiveStatus', payload: partial.agentLiveStatus ?? null });
        }
        if (partial.contextPreview) {
          this.postMessage({
            type: 'setContextPreview',
            payload: { items: partial.contextPreview, totalTokens: partial.contextTokenEstimate ?? 0 },
          });
        }
        if (partial.approvals) {
          this.postMessage({ type: 'setApprovals', payload: partial.approvals });
        }
        if (partial.tokenUsage) {
          this.postMessage({ type: 'setTokenUsage', payload: partial.tokenUsage });
        }
        return;
      }

      this.postMessage({ type: 'state', payload: this.state });
    });
    this.controller.setAutoFixCallback(async (message) => {
      await this.runChatCompletion(message, true);
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
        await this.runChatCompletion(content, true);
        break;
      }

      case 'retryLastMessage': {
        const lastUser = [...this.state.messages].reverse().find((m) => m.role === 'user');
        if (lastUser?.content) {
          await this.runChatCompletion(lastUser.content, false);
        }
        break;
      }

      case 'newChat':
        this.archiveCurrentThread();
        this.controller.startNewChat();
        this.state = {
          ...this.state,
          tab: 'chat',
          loading: false,
          error: null,
          messages: [],
          currentSessionId: this.controller.getSession()?.id ?? '',
          chatHistory: this.historySummaries(),
          contextPreview: [],
          contextTokenEstimate: 0,
          contextBudget: null,
          agentActivity: [],
          agentLiveStatus: null,
          plan: null,
        };
        this.postMessage({ type: 'state', payload: this.state });
        break;

      case 'openChatThread': {
        this.archiveCurrentThread();
        const thread = this.archivedThreads.get(message.payload.id);
        if (!thread) break;
        this.state = {
          ...this.state,
          tab: 'chat',
          loading: false,
          error: null,
          currentSessionId: message.payload.id,
          messages: thread.messages,
          chatHistory: this.historySummaries(),
        };
        this.postMessage({ type: 'state', payload: this.state });
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
        await this.controller.resolveApproval(
          message.payload.id,
          message.payload.decision,
          message.payload.selectedOption
        );
        await this.syncState();
        if (message.payload.decision === 'approved') {
          await this.continueAfterApproval();
        }
        break;

      case 'approveAllPending':
        await this.controller.approveAllPending();
        await this.syncState();
        await this.continueAfterApproval();
        break;

      case 'saveApiKey':
        if (message.payload.key.trim()) {
          await this.controller.saveApiKey(message.payload.key.trim());
          await this.syncState();
        }
        break;

      case 'saveProviderSettings':
        await this.controller.saveProviderSettings(message.payload);
        await this.syncState();
        break;

      case 'saveAgentSettings':
        await this.controller.saveAgentSettings(message.payload);
        await this.syncState();
        break;

      case 'testProviderConnection':
        await this.controller.testProviderConnection(message.payload);
        break;

      case 'pickWorkspaceFolder':
        await this.controller.pickWorkspaceFolder();
        await this.syncState();
        break;

      case 'setWorkspaceOverride':
        await this.controller.setWorkspaceOverride(message.payload.path);
        await this.syncState();
        break;

      case 'clearWorkspaceOverride':
        await this.controller.clearWorkspaceOverride();
        await this.syncState();
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

  private async runChatCompletion(content: string, appendUser: boolean): Promise<void> {
    if (!content || this.state.loading) return;

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    const messages = appendUser ? [...this.state.messages, userMessage] : removeTrailingAssistant(this.state.messages);
    this.state = {
      ...this.state,
      tab: 'chat',
      loading: true,
      error: null,
      messages,
    };
    this.postMessage({ type: 'state', payload: this.state });

    const assistantId = `msg-${Date.now()}-assistant`;
    this.isStreaming = true;
    try {
      const recentMessages = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(0, -1)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const stream = await this.controller.sendMessage(content, recentMessages);
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
        this.state = {
          ...this.state,
          messages: this.state.messages.map((m) =>
            m.id === assistantId ? { ...m, content: fullContent, streaming: true } : m
          ),
        };
        this.postMessage({
          type: 'updateLastAssistant',
          payload: { content: fullContent, streaming: true },
        });
      }

      this.isStreaming = false;
      const pendingApprovals = this.controller.getApprovalQueue()?.getPending() ?? [];
      this.state = {
        ...this.state,
        loading: false,
        messages: this.state.messages.map((m) =>
          m.id === assistantId ? { ...m, content: fullContent, streaming: false } : m
        ),
        approvals: pendingApprovals.map((r) => ({
          id: r.id,
          toolName: r.toolName,
          inputPreview: r.inputPreview,
          files: r.files,
          risk: r.risk,
          reason: r.reason,
          kind: r.kind,
          question: r.question,
          options: r.options,
        })),
      };
      this.archiveCurrentThread();
      this.state = { ...this.state, chatHistory: this.historySummaries() };
      this.postMessage({ type: 'state', payload: this.state });
      await this.syncState();
    } catch (error) {
      this.isStreaming = false;
      const safe = normalizeError(error);
      this.state = {
        ...this.state,
        loading: false,
        error: `${formatUserError(safe)}${formatErrorHint(safe.message)}`,
      };
      this.archiveCurrentThread();
      this.state = { ...this.state, chatHistory: this.historySummaries() };
      this.postMessage({ type: 'state', payload: this.state });
      log.error('sendMessage failed', { message: safe.message });
    } finally {
      this.isStreaming = false;
      if (this.state.loading) {
        this.state = { ...this.state, loading: false };
        this.postMessage({ type: 'state', payload: this.state });
      }
    }
  }

  private async continueAfterApproval(): Promise<void> {
    const pendingCount = this.controller.getApprovalQueue()?.getPending().length ?? 0;
    if (this.state.loading || pendingCount > 0) return;

    if (this.controller.hasSuspendedAgentLoop()) {
      await this.runResumeAfterApproval();
      return;
    }

    const lastAssistant = [...this.state.messages].reverse().find((m) => m.role === 'assistant');
    const paused =
      lastAssistant?.content.includes('Waiting for your approval') ||
      lastAssistant?.content.includes('Waiting for approval') ||
      (this.controller.getPendingApprovalContext().length > 0);
    if (!paused) return;

    const originalUser = [...this.state.messages]
      .filter((m) => m.role === 'user')
      .reverse()
      .find((m) => !m.content.trim().startsWith('Continue the current approved task'));
    if (!originalUser?.content) return;

    const approvalContext = this.controller.consumePendingApprovalContext();
    const continuation = [
      approvalContext,
      'Continue the current approved task from where it paused.',
      'Current phase: EXECUTE — apply file edits and dependency removals based on the approved command output above.',
      'Do not recreate the requirement analysis or plan.',
      'Do not call memory_search first — read the sections above and recent chat messages.',
      'Do not re-run depcheck, eslint, or list_files already marked complete in Task progress.',
      '',
      'Original user request:',
      originalUser.content,
    ].filter(Boolean).join('\n');

    await this.runChatCompletion(continuation, false);
  }

  private async runResumeAfterApproval(): Promise<void> {
    const lastAssistant = [...this.state.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return;

    this.state = { ...this.state, loading: true, error: null };
    this.postMessage({ type: 'state', payload: this.state });
    this.isStreaming = true;

    const assistantId = lastAssistant.id;
    let fullContent = lastAssistant.content;

    try {
      const stream = this.controller.resumeAfterApproval();
      for await (const chunk of stream) {
        fullContent += chunk;
        this.state = {
          ...this.state,
          messages: this.state.messages.map((m) =>
            m.id === assistantId ? { ...m, content: fullContent, streaming: true } : m
          ),
        };
        this.postMessage({
          type: 'updateLastAssistant',
          payload: { content: fullContent, streaming: true },
        });
      }

      this.isStreaming = false;
      const pendingApprovals = this.controller.getApprovalQueue()?.getPending() ?? [];
      this.state = {
        ...this.state,
        loading: false,
        messages: this.state.messages.map((m) =>
          m.id === assistantId ? { ...m, content: fullContent, streaming: false } : m
        ),
        approvals: pendingApprovals.map((r) => ({
          id: r.id,
          toolName: r.toolName,
          inputPreview: r.inputPreview,
          files: r.files,
          risk: r.risk,
          reason: r.reason,
          kind: r.kind,
          question: r.question,
          options: r.options,
        })),
      };
      this.archiveCurrentThread();
      this.state = { ...this.state, chatHistory: this.historySummaries() };
      this.postMessage({ type: 'state', payload: this.state });
      await this.syncState();

      if (pendingApprovals.length === 0 && !this.controller.hasSuspendedAgentLoop()) {
        return;
      }
      if (pendingApprovals.length === 0 && this.controller.hasSuspendedAgentLoop()) {
        await this.continueAfterApproval();
      }
    } catch (error) {
      this.isStreaming = false;
      const safe = normalizeError(error);
      this.state = {
        ...this.state,
        loading: false,
        error: `${formatUserError(safe)}${formatErrorHint(safe.message)}`,
      };
      this.postMessage({ type: 'state', payload: this.state });
      log.error('resumeAfterApproval failed', { message: safe.message });
    } finally {
      this.isStreaming = false;
      if (this.state.loading) {
        this.state = { ...this.state, loading: false };
        this.postMessage({ type: 'state', payload: this.state });
      }
    }
  }

  private archiveCurrentThread(): void {
    const id = this.state.currentSessionId || this.controller.getSession()?.id;
    const messages = this.state.messages.filter((m) => m.content.trim());
    if (!id || messages.length === 0) return;

    const firstUser = messages.find((m) => m.role === 'user');
    const last = messages[messages.length - 1];
    const title = firstUser?.content.slice(0, 64) || 'Untitled chat';
    this.archivedThreads.set(id, {
      messages,
      summary: {
        id,
        title,
        lastMessage: last.content.slice(0, 120),
        messageCount: messages.length,
        updatedAt: last.timestamp,
        tokenTotal: this.state.tokenUsage.sessionTotal,
        turnCount: this.state.tokenUsage.turnCount,
      },
    });
  }

  private historySummaries(): ChatThreadSummary[] {
    return [...this.archivedThreads.values()]
      .map((t) => t.summary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
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

function formatErrorHint(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('database not open') || lower.includes('no workspace')) {
    return '\n\nOpen a workspace folder or set a path in Thunder Settings → Workspace, then retry.';
  }
  if (lower.includes('provider') || lower.includes('model') || lower.includes('connection') || lower.includes('api')) {
    return '\n\nUse Retry after fixing the provider/model, or switch models in Settings.';
  }
  if (lower.includes('approval') || lower.includes('awaiting')) {
    return '\n\nReview the approval panel below and approve or deny the pending action.';
  }
  return '\n\nUse Retry or check Settings if the issue persists.';
}
