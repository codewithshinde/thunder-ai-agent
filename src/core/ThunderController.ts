import * as vscode from 'vscode';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
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
import { FtsContextSource, RepoMapContextSource, MemoryContextSource, WorkspaceOverviewContextSource } from './context/sources/indexSources';
import { IndexedFileSearchContextSource } from './context/sources/indexedFileSource';
import { MentionedFileContextSource } from './context/sources/mentionedFileSource';
import { GitService } from './context/GitService';
import { DiagnosticsService, GitDiffContextSource, DiagnosticsContextSource } from './context/DiagnosticsService';
import { RepoMapService } from './context/RepoMapService';
import { ChatOrchestrator } from './ChatOrchestrator';
import { ToolRuntime } from './tools/ToolRuntime';
import {
  createReadFileTool, createReadFilesTool, createListFilesTool, createSearchTool,
  createSearchBatchTool, createSearchScriptCatalogTool, createSpawnResearchAgentTool,
  createExecuteWorkspaceScriptTool, createUseSkillTool,
  createRepoMapTool, createRetrieveContextTool, createGitDiffTool,
  createDiagnosticsTool, createWriteFileTool, createApplyPatchTool, createRunCommandTool,
  createMemorySearchTool, createMemoryWriteTool, createSaveTaskStateTool,
  createFetchWebTool, createAskQuestionTool,
  setSubagentTracker,
} from './tools/builtinTools';
import { createMarkStepCompleteTool, createProposePlanMutationTool } from './tools/planTools';
import { OpenAiCompatibleProvider } from './llm/OpenAiCompatibleProvider';
import type { LlmProvider } from './llm/types';
import { AgentTaskState } from './agent/AgentTaskState';
import { isApprovalContinuationMessage } from './agent/taskMessage';
import { ToolPolicyEngine } from './safety/ToolPolicyEngine';
import { applyAutonomyPreset } from './safety/autonomyPresets';
import { ApprovalQueue } from './safety/ApprovalQueue';
import { ToolExecutor } from './safety/ToolExecutor';
import { CheckpointService } from './apply/CheckpointService';
import { MemoryService } from './memory/MemoryService';
import { SessionService } from './session/SessionService';
import { PlanPersistence } from './planning/PlanPersistence';
import { PlanFileStore } from './planning/PlanFileStore';
import { MemoryExtractor } from './agent/MemoryExtractor';
import { SubagentTracker } from './agent/SubagentTracker';
import { PassiveMemoryInjector } from './memory/PassiveMemoryInjector';
import { MemoryHookService } from './memory/MemoryHookService';
import { PostEditValidator } from './apply/PostEditValidator';
import { VectorContextSource } from './context/sources/VectorContextSource';
import { SqliteVectorIndex, VectorIndexService } from './indexing/VectorIndex';
import { HashEmbeddingProvider } from './indexing/EmbeddingProvider';
import { McpManager } from './mcp/McpManager';
import { ProjectRulesContextSource, ProjectRulesService } from './rules/ProjectRulesService';
import { SkillCatalogContextSource, SkillCatalogService } from './skills/SkillCatalogService';
import { showWriteDiffPreview, showPatchDiffPreview } from '../vscode/diffPreview';
import { testOpenAiCompatibleConnection } from './llm/testConnection';
import { createLogger } from './telemetry/Logger';
import { SessionLogService } from './telemetry/SessionLogService';
import { normalizeError } from './telemetry/errors';
import type { IndexingStatus } from './indexing/IndexQueue';
import type {
  WebviewState,
  ContextToggles,
  ApprovalRequestView,
  PlanView,
  PinnedContextView,
  ContextPathSuggestion,
} from '../vscode/webview/messages';
import {
  initialWebviewState,
  defaultContextToggles,
} from '../vscode/webview/messages';
import { resolveDbPath } from './indexing/paths';
import { searchWorkspacePaths, resolvePickedPaths } from './context/contextPathSearch';
import { createWorkspacePattern, isWorkspaceInVscodeFolders, normalizeWorkspaceRoot, toWorkspaceRelPath } from './vscode/pathUtils';

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
  private sessionService: SessionService | undefined;
  private planPersistence: PlanPersistence | undefined;
  private memoryExtractor: MemoryExtractor | undefined;
  private subagentTracker = new SubagentTracker();
  private passiveMemoryInjector: PassiveMemoryInjector | undefined;
  private memoryHookService: MemoryHookService | undefined;
  private postEditValidator: PostEditValidator | undefined;
  private vectorIndexService: VectorIndexService | undefined;
  private mcpManager = new McpManager();
  private projectRulesService: ProjectRulesService | undefined;
  private skillCatalogService: SkillCatalogService | undefined;
  private researchAgentProvider: LlmProvider | undefined;
  private sessionLog = new SessionLogService();
  private lastSubagentSnapshot = new Map<string, string>();
  private indexingStatus: IndexingStatus = { indexed: 0, queued: 0, running: false, failed: 0 };
  private contextToggles: ContextToggles = defaultContextToggles();
  private currentPlan: PlanView | null = null;
  private agentActivity: import('../vscode/webview/messages').AgentActivityEntry[] = [];
  private agentLiveStatus: import('../vscode/webview/messages').AgentLiveStatusView | null = null;
  private tokenUsage = {
    sessionTotal: 0,
    lastPromptTokens: 0,
    lastContextTokens: 0,
    lastResponseTokens: 0,
    turnCount: 0,
    breakdown: [] as import('../vscode/webview/messages').TokenUsageBreakdownItem[],
  };
  private uiUpdate: UiUpdateCallback | undefined;
  private autoFixCallback: ((message: string) => Promise<void>) | undefined;
  private autoFixDepth = 0;
  private disposed = false;
  private workspaceNotice: { kind: 'ok' | 'error' | 'warn'; message: string } | null = null;
  private configDisposable: vscode.Disposable | undefined;
  private pendingApprovalOutputs: string[] = [];
  private resumeApprovalResults: import('./agent/AgentLoop').ApprovedToolResult[] = [];
  private agentTaskState = new AgentTaskState();
  private pinnedContext: PinnedContextView[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configService = new ConfigService(context);
    this.providerRegistry = new LlmProviderRegistry();
  }

  setUiUpdateCallback(cb: UiUpdateCallback): void {
    this.uiUpdate = cb;
  }

  setAutoFixCallback(cb: (message: string) => Promise<void>): void {
    this.autoFixCallback = cb;
  }

  private notifyUi(partial: Partial<WebviewState>): void {
    this.uiUpdate?.(partial);
  }

  private configureSessionLogging(session: ThunderSession, workspace: string): void {
    const telemetry = this.configService.getConfig().telemetry;
    this.sessionLog.configure(workspace, session.id, telemetry.sessionLogging, telemetry.debugMetrics);
    this.sessionLog.writeSessionHeader({
      mode: session.mode,
      model: this.configService.getConfig().provider.model,
      provider: this.configService.getConfig().provider.type,
      debugMetrics: telemetry.debugMetrics,
    });
  }

  private async refreshResearchAgentProvider(): Promise<void> {
    const config = this.configService.getConfig();
    const model = config.agent.researchAgentModel?.trim();
    if (!model || config.provider.type !== 'openai-compatible') {
      this.researchAgentProvider = undefined;
      return;
    }

    const apiKey = await this.configService.getApiKey();
    this.researchAgentProvider = new OpenAiCompatibleProvider({
      baseUrl: config.agent.researchAgentBaseUrl?.trim() || config.provider.baseUrl,
      model,
      apiKey,
      capabilities: {
        contextWindow: config.provider.contextWindow,
        supportsStreaming: config.provider.supportsStreaming,
        supportsTools: config.provider.supportsTools,
        supportsEmbeddings: config.provider.supportsEmbeddings,
      },
    });
  }

  async initialize(): Promise<void> {
    await this.configService.initialize();

    const workspace = this.resolveWorkspacePath();
    this.session = new ThunderSession(workspace);
    if (workspace) {
      this.configureSessionLogging(this.session, workspace);
    }

    if (workspace) {
      try {
        await this.initializeWorkspaceServices(workspace);
      } catch (error) {
        log.error('Workspace services init failed, using minimal context', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.initMinimalChat(workspace);
      }
    }

    if (workspace && !this.chatOrchestrator) {
      this.initMinimalChat(workspace);
    }

    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    await this.providerRegistry.resolveFromConfig(config.provider, apiKey);
    await this.refreshResearchAgentProvider();
    this.chatOrchestrator?.configure({ researchAgentProvider: this.researchAgentProvider });

    this.configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('thunder.workspace') || e.affectsConfiguration('thunder')) {
        void this.reloadWorkspace();
      }
    });
    this.context.subscriptions.push(this.configDisposable);

    log.info('ThunderController initialized', { workspace });
  }

  private initMinimalChat(workspace: string): void {
    this.diagnosticsService.setWorkspaceRoot(workspace);
    this.projectRulesService = new ProjectRulesService(workspace);
    this.skillCatalogService = new SkillCatalogService(workspace);
    this.skillCatalogService.refresh();
    const retriever = new HybridRetriever([
      new ProjectRulesContextSource(this.projectRulesService),
      new SkillCatalogContextSource(this.skillCatalogService),
      new MentionedFileContextSource(workspace),
      new WorkspaceOverviewContextSource(workspace),
      new CurrentEditorContextSource(workspace),
      new OpenFilesContextSource(workspace),
    ]);
    this.chatOrchestrator = this.createChatOrchestrator(retriever, new ContextBudgeter(), undefined, workspace);
    log.info('Minimal chat orchestrator initialized');
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
    this.vectorIndexService = new VectorIndexService(
      new SqliteVectorIndex(db),
      new HashEmbeddingProvider()
    );
    this.indexQueue = new IndexQueue(db);
    this.indexQueue.onStatusChange((status) => {
      this.indexingStatus = status;
      this.notifyUi({ indexing: status });
    });
    if (config.indexing.vectorsEnabled) {
      this.indexQueue.setVectorService(workspace, this.vectorIndexService);
    }
    this.indexingStatus = this.indexQueue.getStatus();

    this.gitService = new GitService(workspace);
    await this.gitService.initialize();

    this.diagnosticsService.setWorkspaceRoot(workspace);
    this.projectRulesService = new ProjectRulesService(workspace);
    this.skillCatalogService = new SkillCatalogService(workspace);
    this.skillCatalogService.refresh();
    this.memoryService = new MemoryService(db, workspace);
    this.passiveMemoryInjector = new PassiveMemoryInjector(this.memoryService);
    this.memoryHookService = new MemoryHookService(workspace);
    this.postEditValidator = new PostEditValidator(this.diagnosticsService);
    this.subagentTracker.setUpdateCallback((runs) => {
      for (const run of runs) {
        const prev = this.lastSubagentSnapshot.get(run.id);
        const statusKey = `${run.status}:${run.summary ?? ''}:${run.error ?? ''}`;
        if (prev === statusKey) continue;
        this.lastSubagentSnapshot.set(run.id, statusKey);
        if (run.status === 'running' && !prev) {
          this.sessionLog.append('subagent_start', run.task.slice(0, 120), {
            id: run.id,
            focus: run.focus,
          });
        } else if (run.status === 'done') {
          this.sessionLog.append('subagent_end', run.task.slice(0, 120), {
            id: run.id,
            success: true,
            summary: run.summary,
            durationMs: run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : undefined,
          });
        } else if (run.status === 'error') {
          this.sessionLog.append('subagent_end', run.task.slice(0, 120), {
            id: run.id,
            success: false,
            error: run.error,
          });
        }
      }
      this.notifyUi({
        subagents: runs.map((r) => ({
          id: r.id,
          task: r.task,
          focus: r.focus,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          summary: r.summary,
          error: r.error,
        })),
      });
    });
    this.checkpointService = new CheckpointService(db, workspace, this.gitService);
    this.sessionService = new SessionService(db);
    this.planPersistence = new PlanPersistence(db);
    this.approvalQueue = new ApprovalQueue(db);

    const effectiveSafety = applyAutonomyPreset(config.safety, config.safety.autonomyPreset);

    this.policyEngine = new ToolPolicyEngine(
      effectiveSafety,
      (path) => this.ignoreService.isIgnored(path)
    );

    this.toolExecutor = new ToolExecutor(
      this.toolRuntime,
      this.policyEngine,
      this.approvalQueue,
      () => this.session?.id ?? '',
      () => this.session?.mode ?? 'plan',
      () => {
        const pending = this.approvalQueue?.getPending() ?? [];
        this.agentLiveStatus = {
          label: 'Waiting for approval',
          detail: `${pending.length} action${pending.length === 1 ? '' : 's'} need your review`,
        };
        this.pushActivity(
          'approval',
          'Waiting for your approval',
          pending.map((p) => p.inputPreview).join('\n') || undefined
        );
        this.notifyUi({
          approvals: pending.map(toApprovalView),
          agentLiveStatus: this.agentLiveStatus,
          agentActivity: this.agentActivity,
        });
      },
      () => this.agentTaskState
    );

    const retriever = this.buildRetriever(db, workspace);
    const budgeter = new ContextBudgeter();
    this.chatOrchestrator = this.createChatOrchestrator(retriever, budgeter, db, workspace);

    const repoMap = new RepoMapService(db, workspace);
    const fts = new FtsIndex(db);

    this.toolRuntime.register(createReadFileTool(workspace, this.ignoreService));
    this.toolRuntime.register(createReadFilesTool(workspace, this.ignoreService));
    this.toolRuntime.register(createListFilesTool(workspace, this.ignoreService));
    this.toolRuntime.register(createSearchTool(fts, workspace));
    this.toolRuntime.register(createSearchBatchTool(fts, workspace));
    this.toolRuntime.register(createSearchScriptCatalogTool(workspace, this.context.extensionPath));
    this.toolRuntime.register(createExecuteWorkspaceScriptTool(workspace, this.context.extensionPath, this.ignoreService));
    this.toolRuntime.register(createUseSkillTool(this.skillCatalogService));
    this.toolRuntime.register(createSpawnResearchAgentTool());
    this.toolRuntime.register(createRepoMapTool(repoMap));
    this.toolRuntime.register(createRetrieveContextTool(retriever, budgeter));
    this.toolRuntime.register(createGitDiffTool(this.gitService));
    this.toolRuntime.register(createDiagnosticsTool(this.diagnosticsService));
    this.toolRuntime.register(createWriteFileTool(workspace, this.ignoreService));
    this.toolRuntime.register(createApplyPatchTool(workspace, this.ignoreService));
    this.toolRuntime.register(createRunCommandTool(workspace, () => this.session?.mode ?? 'plan'));
    this.toolRuntime.register(createMemorySearchTool(this.memoryService));
    this.toolRuntime.register(createMemoryWriteTool(this.memoryService, () => this.session?.id ?? ''));
    this.toolRuntime.register(createSaveTaskStateTool(this.memoryService, () => this.session?.id ?? '', () => this.agentTaskState));
    this.toolRuntime.register(createFetchWebTool(() => this.configService.getConfig().safety.allowNetwork));
    this.toolRuntime.register(createAskQuestionTool());

    const sessionIdForPlans = () => this.session?.id ?? '';
    const planToolsCtx = {
      getPlan: () => this.planPersistence?.getActive(sessionIdForPlans())?.plan ?? null,
      setPlan: (plan: import('./planning/PlanActEngine').ThunderPlan) => {
        const sid = sessionIdForPlans();
        if (sid) this.planPersistence?.updatePlan(sid, plan);
      },
      planPersistence: this.planPersistence,
      getSessionId: sessionIdForPlans,
      setPlanPhaseLock: (phase: import('./planning/PlanActEngine').PlanPhase | undefined) => {
        this.toolExecutor?.setPlanPhaseLock(phase);
      },
      get planFileStore() {
        const sid = sessionIdForPlans();
        return sid ? new PlanFileStore(workspace, sid) : undefined;
      },
    };
    this.toolRuntime.register(createMarkStepCompleteTool(planToolsCtx));
    this.toolRuntime.register(createProposePlanMutationTool(planToolsCtx));
    await this.mcpManager.reload(config.mcp, workspace, this.toolRuntime);

    this.memoryExtractor = new MemoryExtractor(
      this.memoryService,
      config.memory.summarizeAfterTask
    );

    this.setupFileWatcher(workspace);
  }

  private createChatOrchestrator(
    retriever: HybridRetriever,
    budgeter: ContextBudgeter,
    db?: import('./indexing/ThunderDb').ThunderDb,
    workspace?: string
  ): ChatOrchestrator {
    const orchestrator = new ChatOrchestrator(retriever, budgeter, db);
    const ws = workspace ?? this.resolveWorkspacePath();
    orchestrator.configure({
      toolRuntime: this.toolRuntime,
      toolExecutor: this.toolExecutor,
      sessionService: this.sessionService,
      planPersistence: this.planPersistence,
      memoryExtractor: this.memoryExtractor,
      memoryConfig: this.configService.getConfig().memory,
      agentConfig: this.configService.getConfig().agent,
      researchAgentProvider: this.researchAgentProvider,
      passiveMemoryInjector: this.passiveMemoryInjector,
      memoryHookService: this.memoryHookService,
      postEditValidator: this.postEditValidator,
      sessionLog: this.sessionLog,
      onPostWrite: async (relPath) => {
        await this.validateAfterWrite(relPath);
      },
      workspace: ws,
      memoryService: this.memoryService,
      taskState: this.agentTaskState,
    });
    orchestrator.setToolExecutor(this.toolExecutor);
    orchestrator.setContextPackCallback((pack, views, budget) => {
      this.notifyUi({
        contextPreview: views,
        contextTokenEstimate: pack.totalTokens,
        contextBudget: budget,
        showContextPreview: true,
      });
    });
    orchestrator.setActivityCallback((entry) => {
      this.agentActivity = [...this.agentActivity.slice(-20), entry];
      if (entry.kind === 'error' && entry.detail !== 'Awaiting approval') {
        this.sessionLog.append('error', entry.message, { detail: entry.detail });
      }
      const partial: Partial<WebviewState> = { agentActivity: this.agentActivity };
      const pending = this.approvalQueue?.getPending() ?? [];
      if (pending.length > 0) {
        partial.approvals = pending.map(toApprovalView);
      }
      this.notifyUi(partial);
    });
    orchestrator.setLiveStatusCallback((status) => {
      this.agentLiveStatus = status;
      this.notifyUi({ agentLiveStatus: status });
    });
    orchestrator.setTokenUsageCallback((promptTokens, contextTokens, responseText, breakdown, options) => {
      const responseTokens = Math.ceil(responseText.length / 4);
      const turnTokens = promptTokens + responseTokens;
      this.tokenUsage.lastPromptTokens = promptTokens;
      this.tokenUsage.lastContextTokens = contextTokens;
      this.tokenUsage.lastResponseTokens = responseTokens;
      if (options?.final !== false) {
        this.tokenUsage.sessionTotal += turnTokens;
        this.tokenUsage.turnCount += 1;
      }
      this.tokenUsage.breakdown = breakdown;
      const config = this.configService.getConfig();
      if (options?.final !== false) {
        this.sessionLog.append('token_usage', 'Session token rollup', {
          turnPromptTokens: promptTokens,
          turnContextTokens: contextTokens,
          turnResponseTokens: responseTokens,
          sessionTotal: this.tokenUsage.sessionTotal,
          turnCount: this.tokenUsage.turnCount,
        });
      }
      const visibleSessionTotal = options?.final === false
        ? this.tokenUsage.sessionTotal + turnTokens
        : this.tokenUsage.sessionTotal;
      const visibleTurnCount = options?.final === false
        ? this.tokenUsage.turnCount + 1
        : this.tokenUsage.turnCount;

      this.notifyUi({
        tokenUsage: {
          ...this.tokenUsage,
          sessionTotal: visibleSessionTotal,
          turnCount: visibleTurnCount,
          contextWindow: config.provider.contextWindow,
        },
      });
    });
    orchestrator.setPlanCallback((plan) => {
      this.currentPlan = plan;
      this.notifyUi({ plan });
    });
    return orchestrator;
  }

  private rebuildRetriever(): void {
    const workspace = this.resolveWorkspacePath();
    const db = this.indexService?.getDb();
    if (!workspace || !db?.isOpen()) return;
    const retriever = this.buildRetriever(db, workspace);
    this.chatOrchestrator = this.createChatOrchestrator(retriever, new ContextBudgeter(), db, workspace);
  }

  private buildRetriever(db: import('./indexing/ThunderDb').ThunderDb, workspace: string): HybridRetriever {
    const sources = [];
    if (this.projectRulesService) {
      sources.push(new ProjectRulesContextSource(this.projectRulesService));
    }
    if (this.skillCatalogService) {
      sources.push(new SkillCatalogContextSource(this.skillCatalogService));
    }
    sources.push(
      new MentionedFileContextSource(workspace),
      new WorkspaceOverviewContextSource(workspace),
      new CurrentEditorContextSource(workspace),
      new OpenFilesContextSource(workspace)
    );
    if (this.contextToggles.fts) {
      sources.push(new FtsContextSource(db));
      sources.push(new IndexedFileSearchContextSource(db, workspace));
    }
    if (this.contextToggles.repoMap) sources.push(new RepoMapContextSource(db, workspace));
    if (this.contextToggles.gitDiff && this.gitService) sources.push(new GitDiffContextSource(this.gitService));
    if (this.contextToggles.diagnostics) sources.push(new DiagnosticsContextSource(this.diagnosticsService));
    if (this.contextToggles.memory) sources.push(new MemoryContextSource(this.memoryService));
    if (this.contextToggles.vectors && this.vectorIndexService) {
      sources.push(new VectorContextSource(this.vectorIndexService, workspace));
    }
    return new HybridRetriever(sources);
  }

  private setupFileWatcher(workspace: string): void {
    if (!isWorkspaceInVscodeFolders(workspace)) {
      log.info('Skipping VS Code file watcher — workspace override is outside open folders');
      return;
    }

    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        createWorkspacePattern(workspace, '**/*')
      );

      const enqueue = (uri: vscode.Uri) => {
        if (!this.indexQueue || !this.scanner) return;
        const relPath = toWorkspaceRelPath(uri, workspace);
        if (!relPath || this.ignoreService.isIgnored(relPath)) return;
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

      const skillWatcher = vscode.workspace.createFileSystemWatcher(
        createWorkspacePattern(workspace, '.thunder/skills/**/SKILL.md')
      );
      const refreshSkills = () => {
        this.skillCatalogService?.refresh();
        this.pushActivity('info', 'Workspace skills catalog refreshed');
      };
      skillWatcher.onDidChange(refreshSkills);
      skillWatcher.onDidCreate(refreshSkills);
      skillWatcher.onDidDelete(refreshSkills);
      this.context.subscriptions.push(skillWatcher);
    } catch (error) {
      log.warn('File watcher setup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async buildUiState(base: Partial<WebviewState> = {}): Promise<WebviewState> {
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    const workspacePath = this.resolveWorkspacePath();
    const override = this.configService.getWorkspaceOverride();
    const vscodeFolders = this.getVscodeWorkspaceFolders();
    const indexDbPath = workspacePath ? resolveDbPath(workspacePath) : '';

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
      tab: base.tab ?? 'chat',
      messages: base.messages ?? [],
      currentSessionId: base.currentSessionId ?? this.session?.id ?? '',
      chatHistory: base.chatHistory ?? [],
      loading: base.loading ?? false,
      error: base.error ?? null,
      showContextPreview: base.showContextPreview ?? false,
      pinnedContext: base.pinnedContext ?? this.pinnedContext,
      contextPreview: base.contextPreview ?? [],
      contextTokenEstimate: base.contextTokenEstimate ?? 0,
      contextBudget: base.contextBudget ?? null,
      agentActivity: this.agentActivity,
      agentLiveStatus: base.agentLiveStatus ?? this.agentLiveStatus,
      subagents: base.subagents ?? this.subagentTracker.getRuns().map((r) => ({
        id: r.id,
        task: r.task,
        focus: r.focus,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        summary: r.summary,
        error: r.error,
      })),
      vectorIndex: {
        enabled: config.indexing.vectorsEnabled,
        embeddedChunks: this.vectorIndexService?.count(workspacePath) ?? 0,
        provider: config.indexing.vectorsEnabled ? 'hash-fallback' : 'none',
      },
      tokenUsage: base.tokenUsage ?? {
        ...this.tokenUsage,
        contextWindow: config.provider.contextWindow,
      },
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
        contextWindow: config.provider.contextWindow,
        indexingEnabled: config.indexing.enabled,
        approvalMode: config.safety.approvalMode,
        requireApprovalWrites: config.safety.requireApprovalForWrites,
        requireApprovalShell: config.safety.requireApprovalForShell,
        memoryEnabled: config.memory.enabled,
        subagentsEnabled: config.agent.subagentsEnabled,
        agentMaxSteps: config.agent.maxSteps,
        agentAutoContinue: config.agent.autoContinue,
        agentMaxAutoContinues: config.agent.maxAutoContinues,
        researchAgentMaxSteps: config.agent.researchAgentMaxSteps,
        showDiffPreview: config.agent.showDiffPreview,
        hasApiKey: Boolean(apiKey),
        mcpEnabled: config.mcp.enabled,
        mcpServers: this.mcpManager.getStatuses().length,
        mcpTools: this.mcpManager.getConnectedToolCount(),
        projectRules: this.projectRulesService?.count() ?? 0,
      },
      contextToggles: this.contextToggles,
      providerLabel: `${config.provider.type} / ${config.provider.model}`,
      workspaceOpen: Boolean(workspacePath),
      workspacePath,
      vscodeWorkspaceFolders: vscodeFolders,
      workspaceOverride: override,
      usingWorkspaceOverride: Boolean(override),
      indexDbPath,
      workspaceNotice: this.workspaceNotice,
    };
  }

  private pushActivity(
    kind: import('../vscode/webview/messages').AgentActivityEntry['kind'],
    message: string,
    detail?: string
  ): void {
    const entry = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      message,
      detail,
      timestamp: Date.now(),
    };
    this.agentActivity = [...this.agentActivity.slice(-40), entry];
    this.notifyUi({ agentActivity: this.agentActivity });
  }

  private async validateAfterWrite(relPath: string): Promise<void> {
    const errors = await this.diagnosticsService.waitForFileErrors(relPath);
    if (errors.length === 0) {
      this.pushActivity('info', `Validated ${relPath}`, 'No TypeScript/linter errors detected');
      return;
    }

    const detail = errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
    this.pushActivity('error', `${errors.length} error(s) in ${relPath} after apply`, detail);

    if (this.session?.mode !== 'act' || !this.autoFixCallback || this.autoFixDepth >= 2) {
      return;
    }
    if (this.shouldDeferAutoFixUntilApprovalResume()) {
      this.pushActivity('info', 'Auto-fix deferred until approved task resumes', relPath);
      return;
    }

    this.autoFixDepth += 1;
    try {
      const fixMessage = [
        `The file \`${relPath}\` was written but VS Code reports these errors:`,
        detail,
        '',
        `Fix all errors and output the corrected FULL file using:`,
        '```tsx|CODE_EDIT_BLOCK|' + relPath,
        '// complete corrected file',
        '```',
      ].join('\n');
      this.pushActivity('info', 'Auto-fixing validation errors…', relPath);
      await this.autoFixCallback(fixMessage);
    } finally {
      this.autoFixDepth -= 1;
    }
  }

  private shouldDeferAutoFixUntilApprovalResume(): boolean {
    const pendingApprovals = this.approvalQueue?.getPending().length ?? 0;
    return pendingApprovals > 0 || this.resumeApprovalResults.length > 0 || Boolean(this.chatOrchestrator?.hasSuspendState());
  }

  getSession(): ThunderSession | undefined { return this.session; }
  getConfigService(): ConfigService { return this.configService; }
  getProviderRegistry(): LlmProviderRegistry { return this.providerRegistry; }
  getIndexingStatus(): IndexingStatus { return this.indexingStatus; }
  getApprovalQueue(): ApprovalQueue | undefined { return this.approvalQueue; }
  getToolExecutor(): ToolExecutor | undefined { return this.toolExecutor; }
  getMemoryService(): MemoryService | undefined { return this.memoryService; }
  getCheckpointService(): CheckpointService | undefined { return this.checkpointService; }

  startNewChat(): string {
    const workspace = this.resolveWorkspacePath();
    const mode = this.session?.mode ?? 'plan';
    this.session = new ThunderSession(workspace, mode);
    this.sessionService?.ensureSession(this.session);
    if (workspace) {
      this.configureSessionLogging(this.session, workspace);
    }
    this.lastSubagentSnapshot.clear();
    this.currentPlan = null;
    this.agentActivity = [];
    this.agentLiveStatus = null;
    this.pinnedContext = [];
    this.syncActiveEditorPin();
    this.tokenUsage = {
      sessionTotal: 0,
      lastPromptTokens: 0,
      lastContextTokens: 0,
      lastResponseTokens: 0,
      turnCount: 0,
      breakdown: [],
    };
    this.notifyUi({
      currentSessionId: this.session.id,
      plan: null,
      agentActivity: [],
      agentLiveStatus: null,
      subagents: [],
      pinnedContext: this.pinnedContext,
      contextPreview: [],
      contextTokenEstimate: 0,
      contextBudget: null,
      tokenUsage: {
        ...this.tokenUsage,
        contextWindow: this.configService.getConfig().provider.contextWindow,
      },
    });
    return this.session.id;
  }

  getWorkspacePath(): string {
    return this.resolveWorkspacePath();
  }

  resolveWorkspacePath(): string {
    const override = this.configService.getWorkspaceOverride();
    if (override) {
      const resolved = normalizeWorkspaceRoot(override);
      if (!resolved) {
        log.warn('Invalid workspace override', { path: override });
        return '';
      }
      if (!existsSync(resolved)) {
        log.warn('Configured workspace override does not exist', { path: resolved });
      }
      return resolved;
    }
    return normalizeWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') ?? '';
  }

  private setWorkspaceNotice(kind: 'ok' | 'error' | 'warn', message: string): void {
    this.workspaceNotice = { kind, message };
    this.notifyUi({ workspaceNotice: this.workspaceNotice });
  }

  getVscodeWorkspaceFolders(): string[] {
    return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  }

  async pickWorkspaceFolder(): Promise<void> {
    const current = this.resolveWorkspacePath();
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use as Thunder workspace',
      defaultUri: current ? vscode.Uri.file(current) : undefined,
    });
    if (!picked?.[0]) return;

    await this.setWorkspaceOverride(picked[0].fsPath);
  }

  async setWorkspaceOverride(path: string): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed) {
      await this.clearWorkspaceOverride();
      return;
    }

    const resolved = normalizeWorkspaceRoot(trimmed);
    if (!resolved) {
      this.setWorkspaceNotice('error', 'Invalid path. Use an absolute path like /Users/you/project');
      void vscode.window.showErrorMessage('Thunder: Invalid workspace path.');
      return;
    }
    if (!existsSync(resolved)) {
      this.setWorkspaceNotice('error', `Path does not exist: ${resolved}`);
      void vscode.window.showErrorMessage(`Thunder: Path does not exist: ${resolved}`);
      return;
    }
    if (!statSync(resolved).isDirectory()) {
      this.setWorkspaceNotice('error', `Path is not a folder: ${resolved}`);
      void vscode.window.showErrorMessage(`Thunder: Path is not a folder: ${resolved}`);
      return;
    }

    await this.configService.setWorkspaceOverride(resolved);
    await this.reloadWorkspace();
    this.setWorkspaceNotice('ok', `Workspace saved: ${resolved}`);
    void vscode.window.showInformationMessage(`Thunder: Using workspace ${resolved}`);
  }

  async clearWorkspaceOverride(): Promise<void> {
    await this.configService.clearWorkspaceOverride();
    await this.reloadWorkspace();
    const fallback = this.resolveWorkspacePath();
    if (fallback) {
      this.setWorkspaceNotice('ok', `Using VS Code folder: ${fallback}`);
    } else {
      this.setWorkspaceNotice('warn', 'Override cleared. Open a folder or set a path below.');
    }
    void vscode.window.showInformationMessage('Thunder: Using VS Code open folder for workspace.');
  }

  async sendMessage(
    content: string,
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    options?: { preserveActivity?: boolean; pinnedContext?: PinnedContextView[] }
  ): Promise<AsyncIterable<string>> {
    if (!this.session) throw normalizeError(new Error('Session not initialized'));
    const provider = this.providerRegistry.getActive();
    if (!provider) throw normalizeError(new Error('No LLM provider configured'));

    const isContinuation = isApprovalContinuationMessage(content.trim());
    this.sessionService?.ensureSession(this.session, content.slice(0, 64));
    const workspace = this.resolveWorkspacePath();
    if (workspace) {
      this.configureSessionLogging(this.session, workspace);
    }
    this.toolRuntime.clearAuditLog();
    this.subagentTracker.clear();
    setSubagentTracker(this.subagentTracker);

    if (!isContinuation && !options?.preserveActivity) {
      this.approvalQueue?.clearTaskGrants(this.session?.id);
      this.agentActivity = [];
      this.agentLiveStatus = null;
      this.pendingApprovalOutputs = [];
      this.agentTaskState.reset();
      this.notifyUi({ agentActivity: [], agentLiveStatus: null, contextBudget: null, subagents: [] });
    }

    this.ensureChatOrchestrator();
    if (!this.chatOrchestrator) {
      throw normalizeError(new Error(
        'No workspace configured. Open a folder (File → Open Folder) or set a path in Thunder Settings → Workspace.'
      ));
    }
    return this.chatOrchestrator.send(this.session, provider, content, recentMessages, {
      pinnedContext: options?.pinnedContext ?? this.pinnedContext,
    });
  }

  getPinnedContext(): PinnedContextView[] {
    return [...this.pinnedContext];
  }

  addPinnedContext(path: string, kind: 'file' | 'folder', auto = false): void {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized) return;
    if (this.pinnedContext.some((p) => p.path === normalized && p.kind === kind)) return;
    this.pinnedContext = [
      ...this.pinnedContext.filter((p) => !(p.path === normalized && p.kind === kind)),
      { path: normalized, kind, auto },
    ];
    this.notifyUi({ pinnedContext: this.pinnedContext });
  }

  removePinnedContext(path: string): void {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    this.pinnedContext = this.pinnedContext.filter((p) => p.path !== normalized);
    this.notifyUi({ pinnedContext: this.pinnedContext });
  }

  clearPinnedContext(): void {
    this.pinnedContext = [];
    this.syncActiveEditorPin();
    this.notifyUi({ pinnedContext: this.pinnedContext });
  }

  searchContextPaths(query: string, limit = 20): ContextPathSuggestion[] {
    const workspace = this.resolveWorkspacePath();
    if (!workspace) return [];
    return searchWorkspacePaths(workspace, query, this.indexService?.getDb(), limit);
  }

  async pickContextPaths(): Promise<ContextPathSuggestion[]> {
    const workspace = this.resolveWorkspacePath();
    if (!workspace) return [];

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(workspace),
      openLabel: 'Add to context',
    });
    if (!picked?.length) return [];
    return resolvePickedPaths(workspace, picked);
  }

  syncActiveEditorPin(): void {
    const workspace = this.resolveWorkspacePath();
    if (!workspace) return;
    const editor = vscode.window.activeTextEditor;
    const rel = editor ? toWorkspaceRelPath(editor.document.uri, workspace) : undefined;
    const manual = this.pinnedContext.filter((p) => !p.auto);
    if (!rel) {
      this.pinnedContext = manual;
      this.notifyUi({ pinnedContext: this.pinnedContext });
      return;
    }
    if (manual.some((p) => p.path === rel)) {
      this.pinnedContext = manual;
    } else {
      this.pinnedContext = [...manual, { path: rel, kind: 'file', auto: true }];
    }
    this.notifyUi({ pinnedContext: this.pinnedContext });
  }

  private ensureChatOrchestrator(): void {
    if (this.chatOrchestrator) return;
    const workspace = this.resolveWorkspacePath();
    if (workspace) {
      this.initMinimalChat(workspace);
    }
  }

  async reloadWorkspace(): Promise<void> {
    const workspace = this.resolveWorkspacePath();
    this.session = new ThunderSession(workspace);
    this.chatOrchestrator = undefined;
    this.indexService?.dispose();
    this.indexService = undefined;
    this.scanner = undefined;
    this.indexQueue = undefined;
    this.projectRulesService = undefined;
    this.indexingStatus = { indexed: 0, queued: 0, running: false, failed: 0 };
    await this.mcpManager.closeAll();
    this.toolRuntime.unregisterByPrefix('mcp__');

    if (workspace) {
      try {
        await this.initializeWorkspaceServices(workspace);
      } catch (error) {
        log.error('Workspace reload failed, using minimal context', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.initMinimalChat(workspace);
      }
      if (!this.chatOrchestrator) {
        this.initMinimalChat(workspace);
      }
    }

    this.notifyUi(await this.buildUiState());
    log.info('Workspace reloaded', { workspace });
  }

  getSessionLogService(): SessionLogService {
    return this.sessionLog;
  }

  async exportSessionLog(): Promise<void> {
    const logPath = this.sessionLog.getLogPath();
    if (!logPath) {
      void vscode.window.showWarningMessage('Thunder: No workspace configured for session logging.');
      return;
    }

    const summary = this.sessionLog.exportSummary();
    await vscode.env.clipboard.writeText(summary);

    const choice = await vscode.window.showInformationMessage(
      `Session log summary copied to clipboard.\nLog file: ${logPath}`,
      'Open log file',
      'Reveal in Finder'
    );

    if (choice === 'Open log file') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } else if (choice === 'Reveal in Finder') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logPath));
    }
  }

  async openSessionLog(): Promise<void> {
    const logPath = this.sessionLog.getLogPath();
    if (!logPath) {
      void vscode.window.showWarningMessage('Thunder: No session log yet. Send a message first.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  getPendingApprovalContext(): string {
    const parts: string[] = [];
    const taskBlock = this.agentTaskState.buildPromptBlock();
    if (taskBlock) {
      parts.push('## Task progress (from state machine)', '', taskBlock);
    }
    if (this.pendingApprovalOutputs.length > 0) {
      parts.push(
        '## Approved command output',
        '',
        ...this.pendingApprovalOutputs,
        '',
        'Analysis phase is complete for the commands above. Proceed to Phase 2 (Execute): edit files and update package.json.',
      );
    }
    return parts.join('\n');
  }

  consumePendingApprovalContext(): string {
    const ctx = this.getPendingApprovalContext();
    this.pendingApprovalOutputs = [];
    return ctx;
  }

  getAgentTaskState(): AgentTaskState {
    return this.agentTaskState;
  }

  hasSuspendedAgentLoop(): boolean {
    this.ensureChatOrchestrator();
    return this.chatOrchestrator?.hasSuspendState() ?? false;
  }

  resumeAfterApproval(): AsyncIterable<string> {
    this.ensureChatOrchestrator();
    if (!this.chatOrchestrator) {
      return (async function* empty() {})();
    }
    const approved = [...this.resumeApprovalResults];
    this.resumeApprovalResults = [];
    return this.chatOrchestrator.resumeAfterApproval(approved);
  }

  stopGeneration(): void {
    this.chatOrchestrator?.stop();
  }

  clearTaskApprovalGrants(): void {
    this.approvalQueue?.clearTaskGrants(this.session?.id);
  }

  async resolveApproval(
    id: string,
    decision: 'approved' | 'denied',
    selectedOption?: string,
    scope: 'single' | 'task' = 'single'
  ): Promise<void> {
    const fullInput = this.approvalQueue?.getFullInput(id);
    const request = this.approvalQueue?.resolve(id, decision);
    if (!request) return;

    this.sessionLog.append('approval_decision', `${decision}: ${request.toolName}`, {
      id,
      toolName: request.toolName,
      files: request.files,
      risk: request.risk,
      selectedOption,
      scope,
    });

    this.notifyUi({ approvals: (this.approvalQueue?.getPending() ?? []).map(toApprovalView) });

    if (request.toolName === 'ask_question') {
      const options = request.options ?? (Array.isArray(fullInput?.options) ? fullInput.options as string[] : []);
      const answer = decision === 'approved'
        ? (selectedOption ?? options[0] ?? 'User confirmed')
        : 'User declined to answer the clarifying question.';
      this.pushActivity('info', decision === 'approved' ? 'Question answered' : 'Question skipped', answer);
      if (request.toolCallId) {
        this.resumeApprovalResults.push({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          output: `User selected: ${answer}`,
          success: decision === 'approved',
          input: fullInput,
        });
      }
      return;
    }

    if (decision === 'denied') {
      this.pushActivity('info', `Denied ${request.toolName}`, request.files.join(', ') || undefined);
      if (request.toolCallId) {
        this.resumeApprovalResults.push({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          output: 'User denied this tool call.',
          success: false,
          input: fullInput,
        });
      }
      return;
    }

    if (!this.toolExecutor || !fullInput) {
      log.warn('Approval missing full input', { id, tool: request.toolName });
      void vscode.window.showErrorMessage(
        'Thunder: Could not apply change — approval data was missing. Please ask again in Act mode.'
      );
      this.pushActivity('error', 'Approval failed — payload missing', request.files.join(', '));
      return;
    }

    if (scope === 'task') {
      this.approvalQueue?.grantForTask(request.sessionId, request.toolName);
      this.pushActivity('info', `Approved ${request.toolName} for this task`, request.files.join(', ') || undefined);
    }

    const path = typeof fullInput.path === 'string' ? fullInput.path : request.files[0];
    const workspace = this.resolveWorkspacePath();

    if (path && workspace && ['write_file', 'apply_patch'].includes(request.toolName)) {
      try {
        if (request.toolName === 'write_file' && typeof fullInput.content === 'string') {
          await showWriteDiffPreview(workspace, path, fullInput.content);
        } else if (
          request.toolName === 'apply_patch' &&
          typeof fullInput.oldText === 'string' &&
          typeof fullInput.newText === 'string'
        ) {
          await showPatchDiffPreview(workspace, path, fullInput.oldText, fullInput.newText);
        }
      } catch {
        // Non-fatal
      }

      if (this.checkpointService && this.session) {
        await this.checkpointService.create(this.session.id, [path], 'pre-write');
        this.refreshCheckpointPanel();
      }
    }

    if (request.toolName === 'run_command' && workspace && typeof fullInput.command === 'string') {
      if (this.checkpointService && this.session) {
        await this.checkpointService.create(this.session.id, [], 'pre-write');
        this.refreshCheckpointPanel();
      }
    }

    const result = await this.toolExecutor.executeApproved(request.toolName, fullInput);

    if (result.success) {
      const successMessage = request.toolName === 'run_command'
        ? 'Ran approved command'
        : `Applied ${path ?? request.toolName}`;
      this.pushActivity(request.toolName === 'run_command' ? 'tool' : 'apply', successMessage, result.output);
      if (request.toolName === 'run_command' && typeof fullInput.command === 'string') {
        this.pendingApprovalOutputs.push(
          `### Command\n\`${fullInput.command}\`\n\n### Output\n${result.output.slice(0, 6000)}`
        );
      } else if (path) {
        this.pendingApprovalOutputs.push(`Applied ${request.toolName} to \`${path}\``);
      }
      if (request.toolCallId) {
        this.resumeApprovalResults.push({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          output: result.output,
          success: true,
          input: fullInput,
        });
      }
      void vscode.window.showInformationMessage(
        request.toolName === 'run_command' ? 'Thunder: Command completed.' : `Thunder: Updated ${path ?? 'file'}`
      );
      if (path) {
        const workspace = this.resolveWorkspacePath();
        if (workspace) {
          void vscode.window.showTextDocument(vscode.Uri.file(join(workspace, path)));
        }
        await this.validateAfterWrite(path);
      }
    } else {
      this.pushActivity('error', `Failed to apply ${path ?? request.toolName}`, result.error);
      void vscode.window.showErrorMessage(`Thunder: ${result.error ?? 'Write failed'}`);
      if (request.toolCallId) {
        this.resumeApprovalResults.push({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          output: result.error ?? 'Tool failed',
          success: false,
          input: fullInput,
        });
      }
    }
  }

  async approveAllPending(): Promise<void> {
    const pending = this.approvalQueue?.getPending() ?? [];
    for (const req of [...pending]) {
      await this.resolveApproval(req.id, 'approved', undefined, 'task');
    }
  }

  async testProviderConnection(settings?: import('../vscode/webview/messages').ProviderSettingsPayload): Promise<void> {
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    const providerType = settings?.providerType ?? config.provider.type;
    const baseUrl = settings?.baseUrl.trim() || config.provider.baseUrl;
    const model = settings?.model.trim() || config.provider.model;
    const contextWindow = settings?.contextWindow
      ? Math.max(1024, Math.min(settings.contextWindow, 1_000_000))
      : config.provider.contextWindow;

    if (providerType === 'echo') {
      this.notifyUi({
        settings: {
          ...(await this.buildUiState()).settings,
          providerType,
          baseUrl,
          model,
          contextWindow,
          connectionOk: true,
          connectionStatus: 'Echo mode — no LLM needed. Responses are mirrored for UI testing.',
        },
      });
      return;
    }

    const result = await testOpenAiCompatibleConnection(
      baseUrl,
      model,
      apiKey
    );

    this.notifyUi({
      settings: {
        ...(await this.buildUiState()).settings,
        providerType,
        baseUrl,
        model,
        contextWindow,
        connectionOk: result.ok,
        connectionStatus: result.message,
      },
    });

    if (!result.ok) {
      void vscode.window.showErrorMessage(`Thunder: ${result.message}`);
    }
  }

  async saveApiKey(key: string): Promise<void> {
    await this.configService.setApiKey(key);
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    await this.providerRegistry.resolveFromConfig(config.provider, apiKey);
    await this.refreshResearchAgentProvider();
    this.chatOrchestrator?.configure({ researchAgentProvider: this.researchAgentProvider });
    this.notifyUi({ settings: (await this.buildUiState()).settings });
  }

  async saveProviderSettings(settings: import('../vscode/webview/messages').ProviderSettingsPayload): Promise<void> {
    const contextWindow = Math.max(1024, Math.min(settings.contextWindow, 1_000_000));
    await this.configService.updateProviderSettings({
      providerType: settings.providerType,
      baseUrl: settings.baseUrl.trim(),
      model: settings.model.trim(),
      contextWindow,
    });
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();
    await this.providerRegistry.resolveFromConfig(config.provider, apiKey);
    await this.refreshResearchAgentProvider();
    this.chatOrchestrator?.configure({ researchAgentProvider: this.researchAgentProvider });
    this.rebuildRetriever();
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage('Thunder: Provider settings saved.');
  }

  async saveAgentSettings(settings: import('../vscode/webview/messages').AgentSettingsPayload): Promise<void> {
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(Number.isFinite(value) ? Math.floor(value) : min, max));

    await this.configService.updateAgentSettings({
      subagentsEnabled: settings.subagentsEnabled,
      maxSteps: clamp(settings.maxSteps, 1, 100),
      autoContinue: settings.autoContinue,
      maxAutoContinues: clamp(settings.maxAutoContinues, 0, 10),
      researchAgentMaxSteps: clamp(settings.researchAgentMaxSteps, 1, 50),
      showDiffPreview: settings.showDiffPreview,
    });

    const config = this.configService.getConfig();
    await this.refreshResearchAgentProvider();
    this.chatOrchestrator?.configure({
      agentConfig: config.agent,
      researchAgentProvider: this.researchAgentProvider,
    });
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage('Thunder: Agent settings saved.');
  }

  async saveSafetySettings(settings: import('../vscode/webview/messages').SafetySettingsPayload): Promise<void> {
    await this.configService.updateSafetySettings(settings);
    const config = this.configService.getConfig();
    const effectiveSafety = applyAutonomyPreset(config.safety, config.safety.autonomyPreset);
    this.policyEngine?.updateSafetyConfig(effectiveSafety);
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage('Thunder: Approval mode saved.');
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
    const workspace = this.resolveWorkspacePath();
    if (!workspace) {
      this.setWorkspaceNotice('warn', 'Set a workspace path first (Browse or paste an absolute path).');
      void vscode.window.showWarningMessage('Thunder: Set a workspace path in Settings before indexing.');
      return;
    }

    if (!this.indexService) {
      try {
        await this.initializeWorkspaceServices(workspace);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.setWorkspaceNotice('error', `Index init failed: ${msg}`);
        void vscode.window.showErrorMessage(`Thunder: Could not initialize index — ${msg}`);
        return;
      }
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
    this.indexingStatus = this.indexQueue.getStatus();
    this.setWorkspaceNotice('ok', `Indexing ${jobs.length} files…`);
    this.notifyUi({ indexing: this.indexingStatus, workspaceNotice: this.workspaceNotice });
    log.info('indexWorkspace', { total: jobs.length });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.configService.dispose();
    void this.mcpManager.closeAll();
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
    contentLength: r.contentLength,
    kind: r.kind,
    question: r.question,
    options: r.options,
  };
}
