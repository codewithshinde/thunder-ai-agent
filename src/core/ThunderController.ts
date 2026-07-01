import * as vscode from 'vscode';
import { AGENT_NAME, brandMessage } from '../shared/brand';
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
import { initTreeSitter, preloadCommonLanguages } from './indexing/TreeSitterService';
import { setTreeSitterEnabled } from './indexing/SymbolExtractor';
import { FtsIndex } from './indexing/FtsIndex';
import { HybridRetriever } from './context/HybridRetriever';
import { createContextReranker } from './context/ContextReranker';
import { ContextBudgeter } from './context/ContextBudgeter';
import { CurrentEditorContextSource, OpenFilesContextSource } from './context/sources/editorSources';
import { FtsContextSource, RepoMapContextSource, MemoryContextSource, WorkspaceOverviewContextSource } from './context/sources/indexSources';
import { IndexedFileSearchContextSource } from './context/sources/indexedFileSource';
import { MentionedFileContextSource } from './context/sources/mentionedFileSource';
import { GitService } from './context/GitService';
import { DiagnosticsService, GitDiffContextSource, DiagnosticsContextSource } from './context/DiagnosticsService';
import { RepoMapService } from './context/RepoMapService';
import { setVerifyCommandPatterns, isReadOnlyCommand } from './planning/PlanActEngine';
import { debounce } from './util/debounce';
import { ChatOrchestrator } from './ChatOrchestrator';
import { ToolRuntime } from './tools/ToolRuntime';
import {
  createReadFileTool, createReadFilesTool, createListFilesTool, createSearchTool,
  createSearchBatchTool, createSearchScriptCatalogTool, createSpawnResearchAgentTool,
  createExecuteWorkspaceScriptTool, createUseSkillTool,
  createRepoMapTool, createRetrieveContextTool, createGitDiffTool,
  createDiagnosticsTool, createWriteFileTool, createApplyPatchTool, createRunCommandTool,
  createMemorySearchTool, createMemoryWriteTool, createSaveTaskStateTool,
  createFetchWebTool, createAskQuestionTool, createProjectCatalogTool, createAnalyzeChangeImpactTool,
  setSubagentTracker,
} from './tools/builtinTools';
import { ProjectCatalogContextSource, discoverProjectCatalog, saveProjectCatalog } from './ask';
import { createMarkStepCompleteTool, createProposePlanMutationTool } from './tools/planTools';
import type { LlmProvider } from './llm/types';
import { UsageTrackingProvider, type ModelCallUsage } from './llm/UsageTrackingProvider';
import { scaffoldMitiiWorkspace } from './mcp/scaffoldMitiiWorkspace';
import { AgentTaskState } from './agent/AgentTaskState';
import { resolveProjectVerifyCommands } from './agent/verifyCommandDiscovery';
import { isApprovalContinuationMessage } from './agent/taskMessage';
import { ToolPolicyEngine } from './safety/ToolPolicyEngine';
import { resolveEffectiveSafety } from './safety/autonomyPresets';
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
import { VectorIndexService } from './indexing/VectorIndex';
import { createEmbeddingProvider, describeEmbeddingProvider } from './indexing/embeddingFactory';
import { createVectorIndex, describeVectorBackend } from './indexing/vectorIndexFactory';
import { isLanceDbAvailable, isMinilmAvailable } from './indexing/vectorAvailability';
import type { EmbeddingProvider } from './indexing/EmbeddingProvider';
import { McpManager } from './mcp/McpManager';
import { ProjectRulesContextSource, ProjectRulesService } from './rules/ProjectRulesService';
import { SkillCatalogContextSource, SkillCatalogService } from './skills/SkillCatalogService';
import { InlineDiffManager } from '../vscode/inlineDiffManager';
import { testProviderConnection } from './llm/testConnection';
import { createLogger } from './telemetry/Logger';
import { SessionLogService } from './telemetry/SessionLogService';
import { normalizeError } from './telemetry/errors';
import type { IndexingStatus } from './indexing/IndexQueue';
import type {
  WebviewState,
  ContextToggles,
  McpToggles,
  ApprovalRequestView,
  PlanView,
  PinnedContextView,
  ContextPathSuggestion,
  TokenUsageView,
  TokenUsageBreakdownItem,
  McpCustomServerView,
} from '../vscode/webview/messages';
import {
  initialWebviewState,
  defaultContextToggles,
  defaultMcpToggles,
} from '../vscode/webview/messages';
import { listCustomMcpServers } from './mcp/mcpWorkspaceConfig';
import { resolveDbPath } from './indexing/paths';
import { searchWorkspacePaths, resolvePickedPaths } from './context/contextPathSearch';
import { createWorkspacePattern, isWorkspaceInVscodeFolders, normalizeWorkspaceRoot, toWorkspaceRelPath } from './vscode/pathUtils';
import { collectCommitMessageInput, generateCommitMessage, type CommitMessageResult } from './scm';

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
  private embeddingProvider: EmbeddingProvider | undefined;
  private mcpManager = new McpManager();
  private projectRulesService: ProjectRulesService | undefined;
  private skillCatalogService: SkillCatalogService | undefined;
  private inlineDiffManager: InlineDiffManager | undefined;
  private researchAgentProvider: LlmProvider | undefined;
  private sessionLog = new SessionLogService();
  private lastSubagentSnapshot = new Map<string, string>();
  private indexingStatus: IndexingStatus = { indexed: 0, queued: 0, running: false, failed: 0, total: 0, activeWorkers: 0, processed: 0, runTotal: 0 };
  private contextToggles: ContextToggles = defaultContextToggles();
  private mcpToggles: McpToggles = defaultMcpToggles();
  private pendingWatchJobs = new Map<string, import('./indexing/IndexQueue').IndexJob>();
  private watchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private debouncedRebuildRetriever: (() => void) | undefined;
  private currentPlan: PlanView | null = null;
  private agentActivity: import('../vscode/webview/messages').AgentActivityEntry[] = [];
  private agentLiveStatus: import('../vscode/webview/messages').AgentLiveStatusView | null = null;
  private tokenUsage: Omit<TokenUsageView, 'contextWindow'> = {
    sessionTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    currentTurnTotal: 0,
    currentTurnInputTokens: 0,
    currentTurnOutputTokens: 0,
    aiCallCount: 0,
    currentTurnAiCallCount: 0,
    lastCallInputTokens: 0,
    lastCallOutputTokens: 0,
    lastCallTotalTokens: 0,
    lastPromptTokens: 0,
    lastContextTokens: 0,
    lastResponseTokens: 0,
    turnCount: 0,
    estimated: true,
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
  private indexStatusNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingIndexStatus: IndexingStatus | undefined;
  private tokenUsageNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTokenUsage: TokenUsageView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configService = new ConfigService(context);
    this.providerRegistry = new LlmProviderRegistry();
    this.inlineDiffManager = new InlineDiffManager(
      async (approvalId) => { await this.resolveApproval(approvalId, 'approved'); },
      async (approvalId) => { await this.resolveApproval(approvalId, 'denied'); }
    );
    context.subscriptions.push(this.inlineDiffManager);
    this.toolRuntime.setSessionLog(this.sessionLog);
    this.debouncedRebuildRetriever = debounce(() => this.rebuildRetriever(), 400);
  }

  async notifyTrustChanged(): Promise<void> {
    this.notifyUi({ workspaceTrusted: this.isWorkspaceTrusted() });
  }

  private isWorkspaceTrusted(): boolean {
    const config = this.configService.getConfig();
    if (config.safety.allowUntrustedWorkspace) return true;
    return vscode.workspace.isTrusted;
  }

  setUiUpdateCallback(cb: UiUpdateCallback): void {
    this.uiUpdate = cb;
  }

  setAutoFixCallback(cb: (message: string) => Promise<void>): void {
    this.autoFixCallback = cb;
  }

  private notifyUi(partial: Partial<WebviewState>): void {
    if (this.sessionLog.isEnabled() && this.configService.getConfig().telemetry.debugMetrics) {
      const keys = Object.keys(partial);
      const skipTrace =
        (keys.length === 1 && keys[0] === 'indexing') ||
        (keys.length === 1 && keys[0] === 'tokenUsage');
      if (!skipTrace) {
        this.sessionLog.appendUiTrace('UI partial update', {
          keys,
          loading: partial.loading,
          activityCount: partial.agentActivity?.length,
          planSteps: partial.plan?.steps.length,
          indexingRunning: partial.indexing?.running,
        });
      }
    }

    if (partial.indexing && Object.keys(partial).length === 1) {
      this.scheduleIndexingUiUpdate(partial.indexing);
      return;
    }
    if (partial.tokenUsage && Object.keys(partial).length === 1) {
      this.scheduleTokenUsageUiUpdate(partial.tokenUsage);
      return;
    }

    this.uiUpdate?.(partial);
  }

  private scheduleIndexingUiUpdate(status: IndexingStatus | WebviewState['indexing']): void {
    const normalized: IndexingStatus = {
      ...status,
      activeWorkers: status.activeWorkers ?? 0,
      processed: status.processed ?? 0,
      runTotal: status.runTotal ?? 0,
    };
    this.indexingStatus = normalized;
    this.pendingIndexStatus = normalized;
    if (this.indexStatusNotifyTimer) return;
    this.indexStatusNotifyTimer = setTimeout(() => {
      this.indexStatusNotifyTimer = undefined;
      const next = this.pendingIndexStatus;
      this.pendingIndexStatus = undefined;
      if (next) this.uiUpdate?.({ indexing: next });
    }, 250);
  }

  private scheduleTokenUsageUiUpdate(usage: TokenUsageView): void {
    this.pendingTokenUsage = usage;
    if (this.tokenUsageNotifyTimer) return;
    this.tokenUsageNotifyTimer = setTimeout(() => {
      this.tokenUsageNotifyTimer = undefined;
      const next = this.pendingTokenUsage;
      this.pendingTokenUsage = undefined;
      if (next) this.uiUpdate?.({ tokenUsage: next });
    }, 200);
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
    if (!model || config.provider.type === 'echo') {
      this.researchAgentProvider = undefined;
      return;
    }

    const apiKey = await this.configService.getApiKey();
    this.researchAgentProvider = this.providerRegistry.resolveFromOptions({
      type: config.provider.type,
      baseUrl: config.agent.researchAgentBaseUrl?.trim() || config.provider.baseUrl,
      model,
      contextWindow: config.provider.contextWindow,
      supportsStreaming: config.provider.supportsStreaming,
      supportsTools: config.provider.supportsTools,
      supportsEmbeddings: config.provider.supportsEmbeddings,
    }, apiKey);
  }

  async initialize(): Promise<void> {
    await this.configService.initialize();
    this.mcpToggles = this.loadMcpTogglesFromConfig();
    this.contextToggles = {
      ...defaultContextToggles(),
      vectors: this.configService.getConfig().indexing.vectorsEnabled,
    };

    const workspace = this.resolveWorkspacePath();
    const vscodeFolder = this.getPrimaryVscodeFolder();
    const source: 'vscode' | 'override' | 'none' = vscodeFolder
      ? 'vscode'
      : this.configService.getWorkspaceOverride()
        ? 'override'
        : 'none';
    this.session = new ThunderSession(workspace);
    if (workspace) {
      this.configureSessionLogging(this.session, workspace);
    }
    this.logWorkspaceResolution(workspace, source);

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
    if (workspace) {
      void this.maybeAutoIndex();
    }
  }

  private getPrimaryVscodeFolder(): string {
    return normalizeWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') ?? '';
  }

  private logWorkspaceResolution(workspace: string, source: 'vscode' | 'override' | 'none'): void {
    log.info('Workspace resolved', {
      workspace,
      source,
      vscodeFolders: this.getVscodeWorkspaceFolders(),
      override: this.configService.getWorkspaceOverride() || undefined,
    });
    this.sessionLog.append('workspace_resolved', `Workspace: ${workspace || '(none)'}`, {
      workspace,
      source,
      vscodeFolders: this.getVscodeWorkspaceFolders(),
      override: this.configService.getWorkspaceOverride() || undefined,
    });
  }

  private async maybeAutoIndex(): Promise<void> {
    const config = this.configService.getConfig();
    if (!config.indexing.enabled || !config.indexing.autoIndexOnOpen) return;
    try {
      await this.indexWorkspace({ force: false });
    } catch (error) {
      log.warn('Auto-index on open failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private initMinimalChat(workspace: string): void {
    this.diagnosticsService.setWorkspaceRoot(workspace);
    scaffoldMitiiWorkspace(workspace, { extensionRoot: this.context.extensionPath });
    this.projectRulesService = new ProjectRulesService(workspace);
    this.skillCatalogService = new SkillCatalogService(workspace);
    this.skillCatalogService.refresh();
    const retriever = new HybridRetriever(
      [
        new ProjectRulesContextSource(this.projectRulesService),
        new SkillCatalogContextSource(this.skillCatalogService),
        new ProjectCatalogContextSource(workspace),
        new MentionedFileContextSource(workspace),
        new WorkspaceOverviewContextSource(workspace),
        new CurrentEditorContextSource(workspace),
        new OpenFilesContextSource(workspace),
      ],
      createContextReranker(),
      this.rerankerConfigFromSettings()
    );
    this.chatOrchestrator = this.createChatOrchestrator(retriever, new ContextBudgeter(), undefined, workspace);
    log.info('Minimal chat orchestrator initialized');
  }

  private async initializeWorkspaceServices(workspace: string): Promise<void> {
    const config = this.configService.getConfig();

    this.indexService = new IndexService(workspace);
    await this.indexService.initialize();
    scaffoldMitiiWorkspace(workspace, { extensionRoot: this.context.extensionPath });
    try {
      saveProjectCatalog(discoverProjectCatalog(workspace));
    } catch (error) {
      log.warn('Project catalog discovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const db = this.indexService.getDb();
    if (!db) return;

    this.ignoreService.load(workspace, {
      respectGitignore: config.indexing.respectGitignore,
      respectThunderignore: config.indexing.respectThunderignore,
    });

    this.scanner = new WorkspaceScanner(db, workspace);
    setTreeSitterEnabled(config.indexing.treeSitterEnabled);
    this.embeddingProvider = createEmbeddingProvider(config.indexing);
    this.vectorIndexService = new VectorIndexService(
      createVectorIndex(db, workspace, config.indexing),
      this.embeddingProvider
    );
    this.indexQueue = new IndexQueue(db, {
      maxConcurrency: config.indexing.maxConcurrency,
      maxFileSizeBytes: config.indexing.maxFileSizeBytes,
    });
    this.indexQueue.setVectorService(workspace, this.vectorIndexService);
    this.indexQueue.onIndexingComplete(() => {
      RepoMapService.invalidateWorkspace(workspace);
    });
    if (config.indexing.treeSitterEnabled) {
      void initTreeSitter().then((ready) => {
        if (ready) void preloadCommonLanguages();
      });
    }
    this.indexQueue.onStatusChange((status) => {
      this.scheduleIndexingUiUpdate(status);
    });
    this.indexingStatus = this.indexQueue.getStatus();

    this.gitService = new GitService(workspace);
    await this.gitService.initialize();

    this.diagnosticsService.setWorkspaceRoot(workspace);
    this.projectRulesService = new ProjectRulesService(workspace);
    this.skillCatalogService = new SkillCatalogService(workspace);
    this.skillCatalogService.refresh();
    this.memoryService = new MemoryService(db, workspace, {
      maxItems: config.memory.maxItems,
      hybridSearchEnabled: config.memory.hybridSearchEnabled,
    });
    if (config.indexing.vectorsEnabled) {
      this.memoryService.setEmbedder(this.embeddingProvider);
    }
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
    this.checkpointService.setStrategy(config.agent.checkpointStrategy);
    this.sessionService = new SessionService(db);
    this.planPersistence = new PlanPersistence(db);
    this.approvalQueue = new ApprovalQueue(db);

    const effectiveSafety = resolveEffectiveSafety(config.safety);

    setVerifyCommandPatterns(config.agent.verifyCommands);

    this.policyEngine = new ToolPolicyEngine(
      effectiveSafety,
      (path) => this.ignoreService.isIgnored(path),
      () => this.isWorkspaceTrusted()
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
      () => this.agentTaskState,
      this.sessionLog,
      () => this.toolExecutor?.setPlanPhaseLock('execute')
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
    this.toolRuntime.register(createProjectCatalogTool(workspace));
    this.toolRuntime.register(createAnalyzeChangeImpactTool(workspace));
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
    await this.mcpManager.reload(config.mcp, workspace, this.toolRuntime, this.mcpToggles);

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
      runVerifyHooks: async (commands) => this.runVerifyHooks(commands),
      workspace: ws,
      memoryService: this.memoryService,
      taskState: this.agentTaskState,
      skillCatalog: this.skillCatalogService,
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
      const effectivePromptTokens = Math.max(promptTokens, this.tokenUsage.lastCallInputTokens);
      const effectiveBreakdown = normalizePromptBreakdown(breakdown, effectivePromptTokens);
      this.tokenUsage.lastPromptTokens = effectivePromptTokens;
      this.tokenUsage.lastContextTokens = contextTokens;
      this.tokenUsage.lastResponseTokens = responseTokens;
      if (options?.final !== false) {
        this.tokenUsage.turnCount += 1;
      }
      this.tokenUsage.breakdown = effectiveBreakdown;
      const config = this.configService.getConfig();
      if (options?.final !== false) {
        this.sessionLog.append('token_usage', 'Session token rollup', {
          turnPromptTokens: effectivePromptTokens,
          estimatedPromptTokens: promptTokens,
          turnContextTokens: contextTokens,
          turnResponseTokens: responseTokens,
          turnAiCallCount: this.tokenUsage.currentTurnAiCallCount,
          turnInputTokens: this.tokenUsage.currentTurnInputTokens,
          turnOutputTokens: this.tokenUsage.currentTurnOutputTokens,
          turnTotalTokens: this.tokenUsage.currentTurnTotal,
          sessionInputTokens: this.tokenUsage.inputTokensTotal,
          sessionOutputTokens: this.tokenUsage.outputTokensTotal,
          sessionTotal: this.tokenUsage.sessionTotal,
          turnCount: this.tokenUsage.turnCount,
          estimated: this.tokenUsage.estimated,
        });
      }

      this.notifyUi({
        tokenUsage: {
          ...this.tokenUsage,
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

  private rerankerConfigFromSettings(): import('./context/HybridRetriever').RerankerConfig {
    const context = this.configService.getConfig().context;
    return {
      enabled: context.rerankerEnabled,
      candidatePool: context.rerankerCandidatePool,
      topK: context.rerankerTopK,
    };
  }

  private buildRetriever(db: import('./indexing/ThunderDb').ThunderDb, workspace: string): HybridRetriever {
    const sources = [];
    if (this.projectRulesService) {
      sources.push(new ProjectRulesContextSource(this.projectRulesService));
    }
    if (this.skillCatalogService) {
      sources.push(new SkillCatalogContextSource(this.skillCatalogService));
    }
    sources.push(new ProjectCatalogContextSource(workspace));
    sources.push(
      new MentionedFileContextSource(workspace),
      new WorkspaceOverviewContextSource(workspace),
      new CurrentEditorContextSource(workspace, db),
      new OpenFilesContextSource(workspace, db)
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

    const config = this.configService.getConfig();
    const reranker = createContextReranker(
      this.embeddingProvider,
      config.indexing.vectorsEnabled && config.indexing.embeddingProvider === 'minilm'
    );

    return new HybridRetriever(sources, reranker, this.rerankerConfigFromSettings());
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
        if (!this.isWorkspaceTrusted()) return;
        const relPath = toWorkspaceRelPath(uri, workspace);
        if (!relPath || this.ignoreService.isIgnored(relPath)) return;
        const fileId = this.scanner.getFileId(relPath);
        if (fileId) {
          this.pendingWatchJobs.set(relPath, {
            fileId,
            relPath,
            absPath: uri.fsPath,
            language: null,
          });
          if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
          this.watchDebounceTimer = setTimeout(() => {
            const jobs = [...this.pendingWatchJobs.values()];
            this.pendingWatchJobs.clear();
            this.indexQueue?.enqueue(jobs);
          }, 5000);
        }
      };

      watcher.onDidChange(enqueue);
      watcher.onDidCreate(enqueue);
      this.context.subscriptions.push(watcher);

      const refreshSkills = () => {
        this.skillCatalogService?.refresh();
        this.pushActivity('info', 'Workspace skills catalog refreshed');
      };
      for (const skillPattern of ['.mitii/skills/**/SKILL.md']) {
        const skillWatcher = vscode.workspace.createFileSystemWatcher(
          createWorkspacePattern(workspace, skillPattern)
        );
        skillWatcher.onDidChange(refreshSkills);
        skillWatcher.onDidCreate(refreshSkills);
        skillWatcher.onDidDelete(refreshSkills);
        this.context.subscriptions.push(skillWatcher);
      }
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
    const appVersion = String(this.context.extension.packageJSON.version ?? '');

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
        provider: describeEmbeddingProvider(config.indexing),
        backend: describeVectorBackend(config.indexing),
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
        strategy: c.strategy,
      })),
      settings: {
        appVersion,
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
        askDepth: config.agent.askDepth,
        planDepth: config.agent.planDepth,
        askMaxSteps: config.agent.askMaxSteps,
        askAutoContinue: config.agent.askAutoContinue,
        askMaxAutoContinues: config.agent.askMaxAutoContinues,
        agentAutoContinue: config.agent.autoContinue,
        agentMaxAutoContinues: config.agent.maxAutoContinues,
        researchAgentMaxSteps: config.agent.researchAgentMaxSteps,
        showDiffPreview: config.agent.showDiffPreview,
        hasApiKey: Boolean(apiKey),
        mcpEnabled: config.mcp.enabled,
        mcpServers: this.mcpManager.getStatuses().length,
        mcpTools: this.mcpManager.getConnectedToolCount(),
        mcpServerStatuses: this.mcpManager.getStatuses().map((s) => ({
          name: s.name,
          connected: s.connected,
          toolCount: s.toolCount,
          builtin: s.builtin,
          error: s.error,
        })),
        customMcpServers: listCustomMcpServers(config.mcp.servers, workspacePath ?? '').map((server) => ({
          name: server.name,
          type: server.type,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          url: server.url,
          headers: server.headers,
          disabled: server.disabled,
          source: server.source,
        })),
        projectRules: this.projectRulesService?.count() ?? 0,
        sessionLogging: config.telemetry.sessionLogging,
        debugMetrics: config.telemetry.debugMetrics,
        localDebugAvailable: this.context.extensionMode === vscode.ExtensionMode.Development,
        vectorsEnabled: config.indexing.vectorsEnabled,
        embeddingProvider: config.indexing.embeddingProvider,
        vectorBackend: config.indexing.vectorBackend,
        hybridMemorySearch: config.memory.hybridSearchEnabled,
        minilmAvailable: isMinilmAvailable(),
        lancedbAvailable: isLanceDbAvailable(),
        autonomyPreset: config.safety.autonomyPreset,
        planModel: config.agent.planModel,
        planBaseUrl: config.agent.planBaseUrl,
        actModel: config.agent.actModel,
        actBaseUrl: config.agent.actBaseUrl,
        checkpointStrategy: config.agent.checkpointStrategy,
      },
      contextToggles: this.contextToggles,
      mcpToggles: this.mcpToggles,
      providerLabel: `${config.provider.type} / ${config.provider.model}`,
      workspaceOpen: Boolean(workspacePath),
      workspacePath,
      vscodeWorkspaceFolders: vscodeFolders,
      workspaceOverride: override,
      usingWorkspaceOverride: this.isUsingWorkspaceOverride(),
      indexDbPath,
      workspaceNotice: this.workspaceNotice,
      workspaceTrusted: this.isWorkspaceTrusted(),
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

  private async runVerifyHooks(commands: string[]): Promise<string> {
    const workspace = this.resolveWorkspacePath();
    if (!workspace || !this.isWorkspaceTrusted()) return '';

    const lines: string[] = [];
    const touchedFiles = this.getTouchedFilesFromAudit();
    const plan = resolveProjectVerifyCommands(workspace, commands, { touchedFiles });
    for (const skipped of plan.skipped) {
      this.pushActivity('info', 'Verify skipped', skipped);
    }

    if (plan.commands.length === 0) {
      if (plan.skipped.length > 0) {
        return `Skipped verify commands:\n${plan.skipped.map((line) => `- ${line}`).join('\n')}`;
      }
      return '';
    }

    for (const command of plan.commands) {
      const trimmed = command.trim();
      if (!trimmed || !isReadOnlyCommand(trimmed)) continue;
      try {
        const result = await this.toolRuntime.execute('run_command', { command: trimmed });
        const body = result.success
          ? (result.output || '(no output)')
          : (result.error ?? 'command failed');
        lines.push(`$ ${trimmed}\n${body.slice(0, 4000)}`);
        this.pushActivity('info', `Verify: ${trimmed}`, body.slice(0, 200));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        lines.push(`$ ${trimmed}\n${msg}`);
      }
    }
    if (plan.skipped.length > 0) {
      lines.push(`Skipped verify commands:\n${plan.skipped.map((line) => `- ${line}`).join('\n')}`);
    }
    return lines.join('\n\n');
  }

  private getTouchedFilesFromAudit(): string[] {
    const audit = this.toolRuntime.getAuditLog();
    const files = new Set<string>();
    for (const { toolName, input, result } of audit) {
      if (!result.success || !['write_file', 'apply_patch'].includes(toolName)) continue;
      const path = (input as Record<string, unknown>).path;
      if (typeof path === 'string') files.add(path);
    }
    return [...files];
  }

  private async validateAfterWrite(relPath: string): Promise<void> {
    const errors = await this.diagnosticsService.waitForFileErrors(relPath);
    if (errors.length === 0) {
      this.pushActivity('info', `Validated ${relPath}`, 'No TypeScript/linter errors detected');
      return;
    }

    const detail = errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
    this.pushActivity('error', `${errors.length} error(s) in ${relPath} after apply`, detail);

    if (this.session?.mode !== 'agent' || !this.autoFixCallback || this.autoFixDepth >= 2) {
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

  async generateCommitMessage(): Promise<CommitMessageResult> {
    const config = this.configService.getConfig();
    if (!config.scm.commitMessageEnabled) {
      throw normalizeError(new Error('Commit message generation is disabled in settings.'));
    }
    if (!this.gitService?.isGitRepo) {
      throw normalizeError(new Error('No Git repository found for this workspace.'));
    }
    const provider = this.trackProvider(await this.resolveProviderForMode('ask'));
    const input = await collectCommitMessageInput(this.gitService);
    if (!input.stagedDiff.trim() && input.unstagedDiff?.trim()) {
      throw normalizeError(new Error('Only unstaged changes found. Stage files before generating a commit message.'));
    }
    return generateCommitMessage(input, provider);
  }

  private async resolveProviderForMode(mode: string): Promise<LlmProvider> {
    const config = this.configService.getConfig();
    const apiKey = await this.configService.getApiKey();

    if (mode === 'plan') {
      const planModel = config.agent.planModel?.trim();
      if (planModel) {
        return this.providerRegistry.resolveFromOptions({
          type: config.agent.planProviderType ?? config.provider.type,
          baseUrl: config.agent.planBaseUrl?.trim() || config.provider.baseUrl,
          model: planModel,
          contextWindow: config.provider.contextWindow,
          supportsStreaming: config.provider.supportsStreaming,
          supportsTools: config.provider.supportsTools,
          supportsEmbeddings: config.provider.supportsEmbeddings,
        }, apiKey);
      }
    }

    if (mode === 'agent') {
      const actModel = config.agent.actModel?.trim();
      if (actModel) {
        return this.providerRegistry.resolveFromOptions({
          type: config.agent.actProviderType ?? config.provider.type,
          baseUrl: config.agent.actBaseUrl?.trim() || config.provider.baseUrl,
          model: actModel,
          contextWindow: config.provider.contextWindow,
          supportsStreaming: config.provider.supportsStreaming,
          supportsTools: config.provider.supportsTools,
          supportsEmbeddings: config.provider.supportsEmbeddings,
        }, apiKey);
      }
    }

    const active = this.providerRegistry.getActive();
    if (!active) {
      throw normalizeError(new Error('No LLM provider configured'));
    }
    return active;
  }

  private async showInlineDiffForPendingApprovals(approvalId?: string): Promise<void> {
    if (!this.inlineDiffManager) return;
    const workspace = this.resolveWorkspacePath();
    if (!workspace) return;

    const pending = this.approvalQueue?.getPending() ?? [];
    const writeApproval = pending.find((req) =>
      ['write_file', 'apply_patch'].includes(req.toolName) &&
      (!approvalId || req.id === approvalId)
    );
    if (!writeApproval) {
      this.inlineDiffManager.setPending(undefined);
      return;
    }

    const fullInput = this.approvalQueue?.getFullInput(writeApproval.id);
    const path = typeof fullInput?.path === 'string'
      ? fullInput.path
      : writeApproval.files[0];
    if (!path) return;

    if (writeApproval.toolName === 'write_file' && typeof fullInput?.content === 'string') {
      await this.inlineDiffManager.showForApproval(
        workspace,
        writeApproval.id,
        path,
        'write_file',
        fullInput.content
      );
      return;
    }

    if (
      writeApproval.toolName === 'apply_patch' &&
      typeof fullInput?.oldText === 'string' &&
      typeof fullInput?.newText === 'string'
    ) {
      await this.inlineDiffManager.showForApproval(
        workspace,
        writeApproval.id,
        path,
        'apply_patch',
        fullInput.newText,
        fullInput.oldText
      );
    }
  }

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
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      currentTurnTotal: 0,
      currentTurnInputTokens: 0,
      currentTurnOutputTokens: 0,
      aiCallCount: 0,
      currentTurnAiCallCount: 0,
      lastCallInputTokens: 0,
      lastCallOutputTokens: 0,
      lastCallTotalTokens: 0,
      lastPromptTokens: 0,
      lastContextTokens: 0,
      lastResponseTokens: 0,
      turnCount: 0,
      estimated: true,
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
    const vscodeFolder = this.getPrimaryVscodeFolder();
    if (vscodeFolder) {
      return vscodeFolder;
    }

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
    return '';
  }

  /** Whether Thunder is using a manual path override (no VS Code folder open). */
  isUsingWorkspaceOverride(): boolean {
    return !this.getPrimaryVscodeFolder() && Boolean(this.configService.getWorkspaceOverride());
  }

  private setWorkspaceNotice(kind: 'ok' | 'error' | 'warn', message: string): void {
    this.workspaceNotice = { kind, message };
    this.notifyUi({ workspaceNotice: this.workspaceNotice });
  }

  private resetCurrentTurnUsage(): void {
    this.tokenUsage.currentTurnTotal = 0;
    this.tokenUsage.currentTurnInputTokens = 0;
    this.tokenUsage.currentTurnOutputTokens = 0;
    this.tokenUsage.currentTurnAiCallCount = 0;
    this.tokenUsage.lastCallInputTokens = 0;
    this.tokenUsage.lastCallOutputTokens = 0;
    this.tokenUsage.lastCallTotalTokens = 0;
    this.tokenUsage.lastPromptTokens = 0;
    this.tokenUsage.lastContextTokens = 0;
    this.tokenUsage.lastResponseTokens = 0;
  }

  private trackProvider(provider: LlmProvider): LlmProvider {
    return new UsageTrackingProvider(provider, (usage) => this.recordModelCallUsage(usage));
  }

  private recordModelCallUsage(usage: ModelCallUsage): void {
    this.tokenUsage.inputTokensTotal += usage.inputTokens;
    this.tokenUsage.outputTokensTotal += usage.outputTokens;
    this.tokenUsage.sessionTotal += usage.totalTokens;
    this.tokenUsage.currentTurnInputTokens += usage.inputTokens;
    this.tokenUsage.currentTurnOutputTokens += usage.outputTokens;
    this.tokenUsage.currentTurnTotal += usage.totalTokens;
    this.tokenUsage.aiCallCount += 1;
    this.tokenUsage.currentTurnAiCallCount += 1;
    this.tokenUsage.lastCallInputTokens = usage.inputTokens;
    this.tokenUsage.lastCallOutputTokens = usage.outputTokens;
    this.tokenUsage.lastCallTotalTokens = usage.totalTokens;
    this.tokenUsage.lastPromptTokens = Math.max(this.tokenUsage.lastPromptTokens, usage.inputTokens);
    this.tokenUsage.breakdown = normalizePromptBreakdown(this.tokenUsage.breakdown, this.tokenUsage.lastPromptTokens);
    this.tokenUsage.estimated = usage.estimated;

    this.sessionLog.append('token_usage', 'AI call token usage', {
      provider: usage.providerId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      currentTurnTotal: this.tokenUsage.currentTurnTotal,
      sessionTotal: this.tokenUsage.sessionTotal,
      aiCallCount: this.tokenUsage.aiCallCount,
      estimated: usage.estimated,
    });

    this.scheduleTokenUsageUiUpdate({
      ...this.tokenUsage,
      contextWindow: this.configService.getConfig().provider.contextWindow,
    });
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
      openLabel: `Use as ${AGENT_NAME} workspace`,
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
      void vscode.window.showErrorMessage(brandMessage('Invalid workspace path.'));
      return;
    }
    if (!existsSync(resolved)) {
      this.setWorkspaceNotice('error', `Path does not exist: ${resolved}`);
      void vscode.window.showErrorMessage(`${AGENT_NAME}: Path does not exist: ${resolved}`);
      return;
    }
    if (!statSync(resolved).isDirectory()) {
      this.setWorkspaceNotice('error', `Path is not a folder: ${resolved}`);
      void vscode.window.showErrorMessage(`${AGENT_NAME}: Path is not a folder: ${resolved}`);
      return;
    }

    await this.configService.setWorkspaceOverride(resolved);
    await this.reloadWorkspace();
    this.setWorkspaceNotice('ok', `Workspace saved: ${resolved}`);
    void vscode.window.showInformationMessage(`${AGENT_NAME}: Using workspace ${resolved}`);
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
    void vscode.window.showInformationMessage(brandMessage('Using VS Code open folder for workspace.'));
  }

  async sendMessage(
    content: string,
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    options?: { preserveActivity?: boolean; pinnedContext?: PinnedContextView[] }
  ): Promise<AsyncIterable<string>> {
    if (!this.session) throw normalizeError(new Error('Session not initialized'));
    const provider = await this.resolveProviderForMode(this.session.mode);
    if (!provider) throw normalizeError(new Error('No LLM provider configured'));
    this.resetCurrentTurnUsage();
    const meteredProvider = this.trackProvider(provider);

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
      this.notifyUi({ agentActivity: [], agentLiveStatus: null, subagents: [] });
    }

    this.ensureChatOrchestrator();
    if (!this.chatOrchestrator) {
      throw normalizeError(new Error(
        brandMessage('No workspace configured. Open a folder (File → Open Folder) or set a path in Settings → Workspace.')
      ));
    }
    this.chatOrchestrator.configure({
      researchAgentProvider: this.researchAgentProvider
        ? this.trackProvider(this.researchAgentProvider)
        : undefined,
    });
    return this.chatOrchestrator.send(this.session, meteredProvider, content, recentMessages, {
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

  async reloadWorkspace(options: { autoIndex?: boolean } = { autoIndex: true }): Promise<void> {
    const vscodeFolder = this.getPrimaryVscodeFolder();
    const override = this.configService.getWorkspaceOverride();
    if (vscodeFolder && override) {
      const normalizedOverride = normalizeWorkspaceRoot(override);
      if (normalizedOverride && normalizedOverride !== vscodeFolder) {
        log.info('Clearing stale workspace override; VS Code folder takes precedence', {
          vscodeFolder,
          override: normalizedOverride,
        });
        await this.configService.clearWorkspaceOverride();
      }
    }

    const workspace = this.resolveWorkspacePath();
    const source: 'vscode' | 'override' | 'none' = vscodeFolder
      ? 'vscode'
      : override
        ? 'override'
        : 'none';
    this.logWorkspaceResolution(workspace, source);

    this.session = new ThunderSession(workspace);
    if (workspace) {
      this.configureSessionLogging(this.session, workspace);
    }
    this.chatOrchestrator = undefined;
    this.indexService?.dispose();
    this.indexService = undefined;
    this.scanner = undefined;
    this.indexQueue = undefined;
    this.projectRulesService = undefined;
    this.indexingStatus = { indexed: 0, queued: 0, running: false, failed: 0, total: 0, activeWorkers: 0, processed: 0, runTotal: 0 };
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
    if (workspace && options.autoIndex !== false) {
      void this.maybeAutoIndex();
    }
  }

  finishAgentTurn(options?: { hadError?: boolean }): void {
    this.agentLiveStatus = null;
    const pending = this.approvalQueue?.getPending() ?? [];
    if (pending.length > 0) {
      this.notifyUi({ agentLiveStatus: null });
      return;
    }

    const audit = this.toolRuntime.getAuditLog();
    const summary = this.buildTurnSummary(audit);
    const hadActivityErrors = this.agentActivity.some((entry) => entry.kind === 'error');
    const hadToolFailures = audit.some((entry) => !entry.result.success);
    const hadError = options?.hadError || hadActivityErrors || hadToolFailures;

    const entry: import('../vscode/webview/messages').AgentActivityEntry = {
      id: `act-complete-${Date.now()}`,
      kind: hadError ? 'error' : 'success',
      message: hadError ? 'Completed with issues' : 'All done',
      detail: summary,
      timestamp: Date.now(),
    };
    this.agentActivity = [...this.agentActivity.filter((e) => e.kind !== 'success'), entry];
    this.sessionLog.append('turn_complete', entry.message, {
      summary,
      toolCalls: audit.length,
      hadError,
      tools: audit.map((a) => a.toolName),
    });
    this.notifyUi({ agentActivity: this.agentActivity, agentLiveStatus: null });
  }

  private buildTurnSummary(audit: import('./tools/types').ToolCallAudit[]): string {
    const lines: string[] = [];
    const writes = new Set<string>();
    const reads = new Set<string>();
    const commands: string[] = [];
    const mcpCalls = new Map<string, number>();

    for (const { toolName, input, result } of audit) {
      if (toolName.startsWith('mcp__')) {
        const server = toolName.split('__')[1] ?? 'mcp';
        mcpCalls.set(server, (mcpCalls.get(server) ?? 0) + 1);
        continue;
      }
      const record = input as Record<string, unknown>;
      if (toolName === 'write_file' || toolName === 'apply_patch') {
        if (typeof record.path === 'string' && result.success) writes.add(record.path);
      } else if (toolName === 'read_file' || toolName === 'read_files') {
        if (typeof record.path === 'string') reads.add(record.path);
        if (Array.isArray(record.paths)) {
          for (const p of record.paths) {
            if (typeof p === 'string') reads.add(p);
          }
        }
      } else if (toolName === 'run_command' && typeof record.command === 'string') {
        commands.push(record.command.slice(0, 100));
      }
    }

    if (writes.size > 0) {
      lines.push(`Modified ${writes.size} file(s): ${[...writes].slice(0, 8).join(', ')}${writes.size > 8 ? '…' : ''}`);
    }
    if (reads.size > 0) {
      lines.push(`Read ${reads.size} file(s)`);
    }
    if (commands.length > 0) {
      lines.push(`Ran ${commands.length} command(s)`);
    }
    if (mcpCalls.size > 0) {
      const mcpSummary = [...mcpCalls.entries()]
        .map(([server, count]) => `${server} (${count})`)
        .join(', ');
      lines.push(`MCP: ${mcpSummary}`);
    }
    if (audit.length > 0) {
      lines.push(`${audit.length} tool call(s) this turn`);
    }
    return lines.length > 0 ? lines.join('\n') : 'Response complete — no tool actions';
  }

  getSessionLogService(): SessionLogService {
    return this.sessionLog;
  }

  async exportSessionLog(): Promise<void> {
    const logPath = this.sessionLog.getLogPath();
    if (!logPath) {
      void vscode.window.showWarningMessage(brandMessage('No workspace configured for session logging.'));
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
      void vscode.window.showWarningMessage(brandMessage('No session log yet. Send a message first.'));
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
        this.agentTaskState.buildApprovalResumeInstruction(),
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
    this.inlineDiffManager?.setPending(undefined);

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
        brandMessage('Could not apply change — approval data was missing. Please ask again in Agent mode.')
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
        request.toolName === 'run_command' ? brandMessage('Command completed.') : `${AGENT_NAME}: Updated ${path ?? 'file'}`
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
      void vscode.window.showErrorMessage(`${AGENT_NAME}: ${result.error ?? 'Write failed'}`);
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

    const result = await testProviderConnection(
      providerType as import('./config/schema').ProviderType,
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
      void vscode.window.showErrorMessage(`${AGENT_NAME}: ${result.message}`);
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
    this.debouncedRebuildRetriever?.();
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage(brandMessage('Provider settings saved.'));
  }

  async saveAgentSettings(settings: import('../vscode/webview/messages').AgentSettingsPayload): Promise<void> {
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(Number.isFinite(value) ? Math.floor(value) : min, max));

    await this.configService.updateAgentSettings({
      subagentsEnabled: settings.subagentsEnabled,
      maxSteps: clamp(settings.maxSteps, 1, 100),
      askDepth: settings.askDepth,
      planDepth: settings.planDepth,
      askMaxSteps: clamp(settings.askMaxSteps, 1, 50),
      askAutoContinue: settings.askAutoContinue,
      askMaxAutoContinues: clamp(settings.askMaxAutoContinues, 0, 10),
      autoContinue: settings.autoContinue,
      maxAutoContinues: clamp(settings.maxAutoContinues, 0, 10),
      researchAgentMaxSteps: clamp(settings.researchAgentMaxSteps, 1, 50),
      showDiffPreview: settings.showDiffPreview,
      planModel: settings.planModel,
      planBaseUrl: settings.planBaseUrl,
      actModel: settings.actModel,
      actBaseUrl: settings.actBaseUrl,
      checkpointStrategy: settings.checkpointStrategy,
    });

    const config = this.configService.getConfig();
    await this.refreshResearchAgentProvider();
    this.chatOrchestrator?.configure({
      agentConfig: config.agent,
      researchAgentProvider: this.researchAgentProvider,
    });
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage(brandMessage('Agent settings saved.'));
  }

  async saveSafetySettings(settings: import('../vscode/webview/messages').SafetySettingsPayload): Promise<void> {
    await this.configService.updateSafetySettings(settings);
    const config = this.configService.getConfig();
    const effectiveSafety = resolveEffectiveSafety({ ...config.safety, ...settings });
    this.policyEngine?.updateSafetyConfig(effectiveSafety);
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage(brandMessage('Approval mode saved.'));
  }

  async saveMcpSettings(settings: import('../vscode/webview/messages').McpSettingsPayload): Promise<void> {
    await this.configService.updateMcpSettings(settings);
    await this.reloadMcpServers();
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage(
      settings.enabled ? brandMessage('MCP enabled.') : brandMessage('MCP disabled.')
    );
  }

  async saveAllSettings(settings: import('../vscode/webview/messages').ThunderSettingsPayload): Promise<void> {
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(Number.isFinite(value) ? Math.floor(value) : min, max));

    const beforeConfig = this.configService.getConfig();
    const contextWindow = Math.max(1024, Math.min(settings.provider.contextWindow, 1_000_000));
    const normalized: import('../vscode/webview/messages').ThunderSettingsPayload = {
      provider: {
        ...settings.provider,
        baseUrl: settings.provider.baseUrl.trim(),
        model: settings.provider.model.trim(),
        contextWindow,
      },
      agent: {
        ...settings.agent,
        maxSteps: clamp(settings.agent.maxSteps, 1, 100),
        askMaxSteps: clamp(settings.agent.askMaxSteps, 1, 50),
        askMaxAutoContinues: clamp(settings.agent.askMaxAutoContinues, 0, 10),
        maxAutoContinues: clamp(settings.agent.maxAutoContinues, 0, 10),
        researchAgentMaxSteps: clamp(settings.agent.researchAgentMaxSteps, 1, 50),
      },
      safety: settings.safety,
      mcp: {
        enabled: settings.mcp.enabled,
        builtinServers: this.mcpToggles,
      },
      indexing: settings.indexing,
      telemetry: {
        sessionLogging: settings.telemetry.sessionLogging,
        debugMetrics: settings.telemetry.debugMetrics,
      },
    };

    const vectorConfigChanged =
      beforeConfig.indexing.vectorsEnabled !== normalized.indexing.vectorsEnabled ||
      beforeConfig.indexing.embeddingProvider !== normalized.indexing.embeddingProvider ||
      beforeConfig.indexing.vectorBackend !== normalized.indexing.vectorBackend ||
      beforeConfig.memory.hybridSearchEnabled !== normalized.indexing.hybridMemorySearch;

    await this.configService.updateAllSettings(normalized);

    if (!normalized.indexing.vectorsEnabled) {
      this.contextToggles = { ...this.contextToggles, vectors: false };
    } else if (!beforeConfig.indexing.vectorsEnabled && normalized.indexing.vectorsEnabled) {
      this.contextToggles = { ...this.contextToggles, vectors: true };
    }

    const config = this.configService.getConfig();
    if (this.session) {
      this.configureSessionLogging(this.session, this.resolveWorkspacePath() ?? '');
    }
    const apiKey = await this.configService.getApiKey();
    await this.providerRegistry.resolveFromConfig(config.provider, apiKey);
    await this.refreshResearchAgentProvider();
    this.chatOrchestrator?.configure({
      agentConfig: config.agent,
      researchAgentProvider: this.researchAgentProvider,
    });

    const effectiveSafety = resolveEffectiveSafety(config.safety);
    this.policyEngine?.updateSafetyConfig(effectiveSafety);
    this.checkpointService?.setStrategy(config.agent.checkpointStrategy);

    setVerifyCommandPatterns(config.agent.verifyCommands);

    await this.reloadMcpServers();
    this.debouncedRebuildRetriever?.();

    if (vectorConfigChanged) {
      await this.reloadWorkspace({ autoIndex: false });
      if (normalized.indexing.vectorsEnabled) {
        await this.indexWorkspace({ force: true });
      }
      void vscode.window.showInformationMessage(
        brandMessage(
          normalized.indexing.vectorsEnabled
            ? 'Vector settings saved. Re-indexing workspace to build embeddings.'
            : 'Vector search disabled. Settings saved.'
        )
      );
    } else {
      this.notifyUi({
        settings: (await this.buildUiState()).settings,
        contextToggles: this.contextToggles,
      });
      void vscode.window.showInformationMessage(brandMessage('Settings saved.'));
    }
  }

  private async reloadMcpServers(): Promise<void> {
    if (!this.toolRuntime) return;
    const config = this.configService.getConfig();
    const workspace = this.resolveWorkspacePath() ?? '';
    await this.mcpManager.reload(config.mcp, workspace, this.toolRuntime, this.mcpToggles);
  }

  private loadMcpTogglesFromConfig(): McpToggles {
    const builtin = this.configService.getConfig().mcp.builtinServers;
    return {
      filesystem: builtin.filesystem,
      memory: builtin.memory,
      sequentialThinking: builtin.sequentialThinking,
    };
  }

  setMcpToggle(server: keyof McpToggles, enabled: boolean): void {
    this.mcpToggles = { ...this.mcpToggles, [server]: enabled };
    this.notifyUi({ mcpToggles: this.mcpToggles });
    void this.reloadMcpServers().then(() => {
      void this.buildUiState().then((state) => {
        this.notifyUi({ settings: state.settings });
      });
    });
  }

  async saveCustomMcpServers(servers: McpCustomServerView[]): Promise<void> {
    const workspace = this.resolveWorkspacePath() ?? '';
    await this.configService.updateCustomMcpServers(servers, workspace);
    await this.reloadMcpServers();
    this.notifyUi({ settings: (await this.buildUiState()).settings });
    void vscode.window.showInformationMessage(brandMessage('MCP servers saved.'));
  }

  setContextToggle(source: keyof ContextToggles, enabled: boolean): void {
    if (source === 'vectors' && enabled && !this.configService.getConfig().indexing.vectorsEnabled) {
      return;
    }
    this.contextToggles = { ...this.contextToggles, [source]: enabled };
    this.notifyUi({ contextToggles: this.contextToggles });
    this.debouncedRebuildRetriever?.();
  }

  async restoreCheckpoint(id: string): Promise<boolean> {
    const ok = await (this.checkpointService?.restore(id) ?? Promise.resolve(false));
    if (ok) {
      void vscode.window.showInformationMessage(brandMessage('Checkpoint restored.'));
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
        id: c.id, kind: c.kind, files: c.files, createdAt: c.createdAt, strategy: c.strategy,
      })),
    });
  }

  async showInlineDiffForApproval(approvalId: string): Promise<void> {
    const pending = this.approvalQueue?.getPending() ?? [];
    if (!pending.some((req) => req.id === approvalId)) return;
    await this.showInlineDiffForPendingApprovals(approvalId);
  }

  async indexWorkspace(options: { force?: boolean } = { force: true }): Promise<void> {
    const workspace = this.resolveWorkspacePath();
    if (!workspace) {
      this.setWorkspaceNotice('warn', 'Set a workspace path first (Browse or paste an absolute path).');
      void vscode.window.showWarningMessage(brandMessage('Set a workspace path in Settings before indexing.'));
      return;
    }

    if (!this.indexService) {
      try {
        await this.initializeWorkspaceServices(workspace);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.setWorkspaceNotice('error', `Index init failed: ${msg}`);
        void vscode.window.showErrorMessage(`${AGENT_NAME}: Could not initialize index — ${msg}`);
        return;
      }
    }

    const config = this.configService.getConfig();
    if (!config.indexing.enabled) {
      void vscode.window.showInformationMessage(brandMessage('Indexing is disabled in settings.'));
      return;
    }
    if (!this.isWorkspaceTrusted()) {
      this.setWorkspaceNotice('warn', 'Indexing is disabled in untrusted workspace mode.');
      void vscode.window.showWarningMessage(brandMessage('Trust this workspace to enable indexing.'));
      return;
    }

    const discovery = new FileDiscoveryService(workspace, this.ignoreService, config.indexing);
    const files = discovery.discover();

    if (!this.scanner || !this.indexQueue) {
      void vscode.window.showErrorMessage(brandMessage('Index services not initialized.'));
      return;
    }

    const diff = this.scanner.computeDiff(files);
    this.scanner.persistScan(diff);

    const filesToIndex = options.force ? files : [...diff.added, ...diff.changed];
    const jobs = filesToIndex.map((f) => ({
      fileId: this.scanner!.getFileId(f.relPath)!,
      relPath: f.relPath,
      absPath: f.absPath,
      language: f.language,
    })).filter((j) => j.fileId !== undefined);

    if (jobs.length === 0) {
      this.indexingStatus = this.indexQueue.getStatus();
      this.setWorkspaceNotice('ok', 'Index is up to date');
      this.sessionLog.append('index_complete', 'Index up to date', { workspace, jobCount: 0 });
      this.notifyUi({ indexing: this.indexingStatus, workspaceNotice: this.workspaceNotice });
      return;
    }

    this.indexQueue.enqueue(jobs);
    this.indexingStatus = this.indexQueue.getStatus();
    this.setWorkspaceNotice('ok', `${options.force ? 'Reindexing' : 'Indexing'} ${jobs.length} files…`);
    this.sessionLog.append('index_start', `${options.force ? 'Reindexing' : 'Indexing'} ${jobs.length} files`, {
      workspace,
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.deleted.length,
      forced: options.force,
    });
    this.notifyUi({ indexing: this.indexingStatus, workspaceNotice: this.workspaceNotice });
    log.info('indexWorkspace', { total: jobs.length });

    void this.waitForIndexingComplete(workspace, jobs.length);
  }

  private async waitForIndexingComplete(workspace: string, jobCount: number): Promise<void> {
    if (!this.indexQueue || jobCount === 0) {
      this.sessionLog.append('index_complete', 'Index up to date', { workspace, jobCount: 0 });
      return;
    }

    const start = Date.now();
    while (this.indexQueue.getStatus().running || this.indexQueue.getStatus().queued > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (Date.now() - start > 600_000) break;
    }

    const status = this.indexQueue.getStatus();
    this.sessionLog.append('index_complete', 'Indexing finished', {
      workspace,
      jobCount,
      indexed: status.indexed,
      failed: status.failed,
      durationMs: Date.now() - start,
    });
    this.setWorkspaceNotice('ok', `Indexed ${status.indexed} files`);
    this.notifyUi({ indexing: status, workspaceNotice: this.workspaceNotice });
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

function normalizePromptBreakdown(
  breakdown: TokenUsageBreakdownItem[],
  promptTokens: number
): TokenUsageBreakdownItem[] {
  if (promptTokens <= 0) return breakdown;

  const overheadLabel = 'Agent transcript + request overhead';
  const base = breakdown.filter((item) => item.label !== overheadLabel);
  const visibleTotal = base.reduce((sum, item) => sum + item.tokens, 0);
  const residual = promptTokens - visibleTotal;
  if (residual <= 0) return base;

  return [
    ...base,
    {
      label: overheadLabel,
      tokens: residual,
      color: '#38bdf8',
    },
  ];
}
