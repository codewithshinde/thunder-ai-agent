import * as vscode from 'vscode';
import { ThunderSession } from './ThunderSession';
import { ConfigService } from './config/ConfigService';
import { LlmProviderRegistry } from './llm/LlmProviderRegistry';
import { IndexService } from './indexing/IndexService';
import { IgnoreService } from './indexing/IgnoreService';
import { FileDiscoveryService } from './indexing/FileDiscoveryService';
import { WorkspaceScanner } from './indexing/WorkspaceScanner';
import { IndexQueue } from './indexing/IndexQueue';
import { FtsIndex } from './indexing/FtsIndex';
import { HybridRetriever } from './context/HybridRetriever';
import { ContextBudgeter } from './context/ContextBudgeter';
import { CurrentEditorContextSource, OpenFilesContextSource } from './context/sources/editorSources';
import { FtsContextSource, RepoMapContextSource, MemoryContextSource } from './context/sources/indexSources';
import { GitService } from './context/GitService';
import { DiagnosticsService, GitDiffContextSource, DiagnosticsContextSource } from './context/DiagnosticsService';
import { RepoMapService } from './context/RepoMapService';
import { ChatOrchestrator, contextItemsToViews } from './ChatOrchestrator';
import { ToolRuntime } from './tools/ToolRuntime';
import {
  createReadFileTool, createListFilesTool, createSearchTool,
  createRepoMapTool, createRetrieveContextTool, createGitDiffTool,
  createDiagnosticsTool, createWriteFileTool, createApplyPatchTool, createRunCommandTool,
} from './tools/builtinTools';
import { ToolPolicyEngine } from './safety/ToolPolicyEngine';
import { ApprovalQueue } from './safety/ApprovalQueue';
import { ToolExecutor } from './safety/ToolExecutor';
import { CheckpointService } from './apply/CheckpointService';
import { MemoryService } from './memory/MemoryService';
import { createLogger } from './telemetry/Logger';
import { normalizeError } from './telemetry/errors';
import type { IndexingStatus } from './indexing/IndexQueue';
import type {
  WebviewState,
  ContextToggles,
  ApprovalRequestView,
  PlanView,
} from '../vscode/webview/messages';
import {
  initialWebviewState,
  defaultContextToggles,
} from '../vscode/webview/messages';

const log = createLogger('ThunderController');

export type UiUpdateCallback = (partial: Partial<WebviewState>) => void;

export class ThunderController {
  private session: ThunderSession | undefined;
  private configService: ConfigService;
  private providerRegistry: LlmProviderRegistry;
  private indexService: IndexService | undefined;
  private ignoreService = new IgnoreService();
  private indexQueue: IndexQueue | undefined;
  private scanner: WorkspaceScanner | undefined;
  private chatOrchestrator: ChatOrchestrator | undefined;
  private toolRuntime = new ToolRuntime();
  private toolExecutor: ToolExecutor | undefined;
  private policyEngine: ToolPolicyEngine | undefined;
  private approvalQueue: ApprovalQueue | undefined;
  private gitService: GitService | undefined;
  private diagnosticsService = new DiagnosticsService();
  private memoryService: MemoryService | undefined;
  private checkpointService: CheckpointService | undefined;
  private indexingStatus: IndexingStatus = { indexed: 0, queued: 0, running: false, failed: 0 };
  private contextToggles: ContextToggles = defaultContextToggles();
  private currentPlan: PlanView | null = null;
  private uiUpdate: UiUpdateCallback | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configService = new ConfigService(context);
    this.providerRegistry = new LlmProviderRegistry();
  }

  setUiUpdateCallback(cb: UiUpdateCallback): void {
    this.uiUpdate = cb;
  }

  private notifyUi(partial: Partial<WebviewState>): void {
    this.uiUpdate?.(partial);
  }

  async initialize(): Promise<void> {
    await this.configService.initialize();

    const workspace = this.getWorkspacePath();
    this.session = new ThunderSession(workspace);

    if (workspace) {
      await this.initializeWorkspaceServices(workspace);
    }

    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    await this.providerRegistry.resolveFromConfig(config.provider, apiKey);

    log.info('ThunderController initialized', { workspace });
  }

  private async initializeWorkspaceServices(workspace: string): Promise<void> {
    const config = this.configService.getConfig();

    this.indexService = new IndexService(workspace);
    await this.indexService.initialize();

    const db = this.indexService.getDb();
    if (!db) return;

    this.ignoreService.load(workspace, {
      respectGitignore: config.indexing.respectGitignore,
      respectThunderignore: config.indexing.respectThunderignore,
    });

    this.scanner = new WorkspaceScanner(db, workspace);
    this.indexQueue = new IndexQueue(db);
    this.indexQueue.onStatusChange((status) => {
      this.indexingStatus = status;
      this.notifyUi({ indexing: status });
    });

    this.gitService = new GitService(workspace);
    await this.gitService.initialize();

    this.memoryService = new MemoryService(db, workspace);
    this.checkpointService = new CheckpointService(db, workspace, this.gitService);
    this.approvalQueue = new ApprovalQueue(db);

    this.policyEngine = new ToolPolicyEngine(
      config.safety,
      (path) => this.ignoreService.isIgnored(path)
    );

    this.toolExecutor = new ToolExecutor(
      this.toolRuntime,
      this.policyEngine,
      this.approvalQueue,
      () => this.session?.id ?? '',
      () => this.session?.mode ?? 'plan'
    );

    const retriever = this.buildRetriever(db, workspace);
    const budgeter = new ContextBudgeter();
    this.chatOrchestrator = this.createChatOrchestrator(retriever, budgeter, db);

    const repoMap = new RepoMapService(db, workspace);
    const fts = new FtsIndex(db);

    this.toolRuntime.register(createReadFileTool(workspace, this.ignoreService));
    this.toolRuntime.register(createListFilesTool(workspace, this.ignoreService));
    this.toolRuntime.register(createSearchTool(fts));
    this.toolRuntime.register(createRepoMapTool(repoMap));
    this.toolRuntime.register(createRetrieveContextTool(retriever, budgeter));
    this.toolRuntime.register(createGitDiffTool(this.gitService));
    this.toolRuntime.register(createDiagnosticsTool(this.diagnosticsService));
    this.toolRuntime.register(createWriteFileTool());
    this.toolRuntime.register(createApplyPatchTool());
    this.toolRuntime.register(createRunCommandTool());

    this.setupFileWatcher(workspace);
  }

  private createChatOrchestrator(
    retriever: HybridRetriever,
    budgeter: ContextBudgeter,
    db: import('./indexing/ThunderDb').ThunderDb
  ): ChatOrchestrator {
    const orchestrator = new ChatOrchestrator(retriever, budgeter, db);
    orchestrator.setContextPackCallback((items, totalTokens) => {
      this.notifyUi({
        contextPreview: contextItemsToViews(items),
        contextTokenEstimate: totalTokens,
      });
    });
    orchestrator.setPlanCallback((plan) => {
      this.currentPlan = plan;
      this.notifyUi({ plan });
    });
    return orchestrator;
  }

  private rebuildRetriever(): void {
    const workspace = this.getWorkspacePath();
    const db = this.indexService?.getDb();
    if (!workspace || !db) return;
    const retriever = this.buildRetriever(db, workspace);
    this.chatOrchestrator = this.createChatOrchestrator(retriever, new ContextBudgeter(), db);
  }

  private buildRetriever(db: import('./indexing/ThunderDb').ThunderDb, workspace: string): HybridRetriever {
    const sources = [];
    sources.push(new CurrentEditorContextSource(), new OpenFilesContextSource());
    if (this.contextToggles.fts) sources.push(new FtsContextSource(db));
    if (this.contextToggles.repoMap) sources.push(new RepoMapContextSource(db, workspace));
    if (this.contextToggles.gitDiff && this.gitService) sources.push(new GitDiffContextSource(this.gitService));
    if (this.contextToggles.diagnostics) sources.push(new DiagnosticsContextSource(this.diagnosticsService));
    if (this.contextToggles.memory) sources.push(new MemoryContextSource(this.memoryService));
    return new HybridRetriever(sources);
  }

  private setupFileWatcher(workspace: string): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspace, '**/*')
    );

    const enqueue = (uri: vscode.Uri) => {
      if (!this.indexQueue || !this.scanner) return;
      const relPath = vscode.workspace.asRelativePath(uri);
      if (this.ignoreService.isIgnored(relPath)) return;
      const fileId = this.scanner.getFileId(relPath);
      if (fileId) {
        this.indexQueue.enqueue([{
          fileId,
          relPath,
          absPath: uri.fsPath,
          language: null,
        }]);
      }
    };

    watcher.onDidChange(enqueue);
    watcher.onDidCreate(enqueue);
    this.context.subscriptions.push(watcher);
  }

  async buildUiState(base: Partial<WebviewState> = {}): Promise<WebviewState> {
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();

    const approvals: ApprovalRequestView[] = (this.approvalQueue?.getPending() ?? []).map((r) => ({
      id: r.id,
      toolName: r.toolName,
      inputPreview: r.inputPreview,
      files: r.files,
      risk: r.risk,
      reason: r.reason,
    }));

    return {
      ...initialWebviewState(),
      mode: this.session?.mode ?? 'plan',
      indexing: this.indexingStatus,
      approvals,
      plan: this.currentPlan,
      memories: (this.memoryService?.recent(20) ?? []).map((m) => ({
        id: m.id,
        type: m.type,
        text: m.text,
        createdAt: m.createdAt,
      })),
      checkpoints: (this.checkpointService?.list(this.session?.id) ?? []).map((c) => ({
        id: c.id,
        kind: c.kind,
        files: c.files,
        createdAt: c.createdAt,
      })),
      settings: {
        providerType: config.provider.type,
        baseUrl: config.provider.baseUrl,
        model: config.provider.model,
        indexingEnabled: config.indexing.enabled,
        requireApprovalWrites: config.safety.requireApprovalForWrites,
        requireApprovalShell: config.safety.requireApprovalForShell,
        memoryEnabled: config.memory.enabled,
        hasApiKey: Boolean(apiKey),
      },
      contextToggles: this.contextToggles,
      ...base,
    };
  }

  getSession(): ThunderSession | undefined { return this.session; }
  getConfigService(): ConfigService { return this.configService; }
  getProviderRegistry(): LlmProviderRegistry { return this.providerRegistry; }
  getIndexingStatus(): IndexingStatus { return this.indexingStatus; }
  getApprovalQueue(): ApprovalQueue | undefined { return this.approvalQueue; }
  getToolExecutor(): ToolExecutor | undefined { return this.toolExecutor; }
  getMemoryService(): MemoryService | undefined { return this.memoryService; }
  getCheckpointService(): CheckpointService | undefined { return this.checkpointService; }

  getWorkspacePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath ?? '';
  }

  async sendMessage(content: string): Promise<AsyncIterable<string>> {
    if (!this.session) throw normalizeError(new Error('Session not initialized'));
    const provider = this.providerRegistry.getActive();
    if (!provider) throw normalizeError(new Error('No LLM provider configured'));
    if (this.chatOrchestrator) {
      return this.chatOrchestrator.send(this.session, provider, content);
    }
    return streamProviderResponse(provider, content);
  }

  stopGeneration(): void {
    this.chatOrchestrator?.stop();
  }

  async resolveApproval(id: string, decision: 'approved' | 'denied'): Promise<void> {
    const request = this.approvalQueue?.resolve(id, decision);
    if (!request) return;

    this.notifyUi({ approvals: (this.approvalQueue?.getPending() ?? []).map(toApprovalView) });

    if (decision === 'approved' && this.toolExecutor) {
      try {
        const input = JSON.parse(request.inputPreview) as Record<string, unknown>;
        await this.toolExecutor.executeApproved(request.toolName, input);
      } catch {
        log.warn('Could not execute approved tool — invalid input preview');
      }
    }
  }

  async saveApiKey(key: string): Promise<void> {
    await this.configService.setApiKey(key);
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    await this.providerRegistry.resolveFromConfig(config.provider, apiKey);
    this.notifyUi({ settings: { ...(await this.buildUiState()).settings, hasApiKey: true } });
  }

  setContextToggle(source: keyof ContextToggles, enabled: boolean): void {
    this.contextToggles = { ...this.contextToggles, [source]: enabled };
    this.notifyUi({ contextToggles: this.contextToggles });
    this.rebuildRetriever();
  }

  async restoreCheckpoint(id: string): Promise<boolean> {
    const ok = this.checkpointService?.restore(id) ?? false;
    if (ok) {
      void vscode.window.showInformationMessage('Thunder: Checkpoint restored.');
      this.notifyUi({
        checkpoints: (this.checkpointService?.list(this.session?.id) ?? []).map((c) => ({
          id: c.id, kind: c.kind, files: c.files, createdAt: c.createdAt,
        })),
      });
    }
    return ok;
  }

  deleteMemory(id: number): boolean {
    const ok = this.memoryService?.delete(id) ?? false;
    if (ok) this.refreshMemoryPanel();
    return ok;
  }

  clearMemory(): number {
    const count = this.memoryService?.clear() ?? 0;
    this.refreshMemoryPanel();
    return count;
  }

  refreshMemoryPanel(): void {
    this.notifyUi({
      memories: (this.memoryService?.recent(20) ?? []).map((m) => ({
        id: m.id, type: m.type, text: m.text, createdAt: m.createdAt,
      })),
    });
  }

  refreshCheckpointPanel(): void {
    this.notifyUi({
      checkpoints: (this.checkpointService?.list(this.session?.id) ?? []).map((c) => ({
        id: c.id, kind: c.kind, files: c.files, createdAt: c.createdAt,
      })),
    });
  }

  async indexWorkspace(): Promise<void> {
    const workspace = this.getWorkspacePath();
    if (!workspace) {
      void vscode.window.showWarningMessage('Thunder: Open a workspace folder to index.');
      return;
    }

    if (!this.indexService) {
      await this.initializeWorkspaceServices(workspace);
    }

    const config = this.configService.getConfig();
    if (!config.indexing.enabled) {
      void vscode.window.showInformationMessage('Thunder: Indexing is disabled in settings.');
      return;
    }

    const discovery = new FileDiscoveryService(workspace, this.ignoreService, config.indexing);
    const files = discovery.discover();

    if (!this.scanner || !this.indexQueue) {
      void vscode.window.showErrorMessage('Thunder: Index services not initialized.');
      return;
    }

    const diff = this.scanner.computeDiff(files);
    this.scanner.persistScan(diff);

    const jobs = [...diff.added, ...diff.changed].map((f) => ({
      fileId: this.scanner!.getFileId(f.relPath)!,
      relPath: f.relPath,
      absPath: f.absPath,
      language: f.language,
    })).filter((j) => j.fileId !== undefined);

    this.indexQueue.enqueue(jobs);
    this.notifyUi({ indexing: this.indexingStatus });
    log.info('indexWorkspace', { total: jobs.length });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.configService.dispose();
    this.indexService?.dispose();
    this.indexQueue?.cancel();
    this.session = undefined;
    log.info('ThunderController disposed');
  }
}

function toApprovalView(r: import('./safety/ApprovalQueue').ApprovalRequest): ApprovalRequestView {
  return {
    id: r.id,
    toolName: r.toolName,
    inputPreview: r.inputPreview,
    files: r.files,
    risk: r.risk,
    reason: r.reason,
  };
}

async function* streamProviderResponse(
  provider: import('./llm/types').LlmProvider,
  content: string
): AsyncIterable<string> {
  const stream = provider.complete({
    messages: [{ role: 'user', content }],
    stream: true,
  });
  for await (const delta of stream) {
    if (delta.content) yield delta.content;
    if (delta.error) throw new Error(delta.error);
  }
}
