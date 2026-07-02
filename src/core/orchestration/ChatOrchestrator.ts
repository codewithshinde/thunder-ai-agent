import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { ThunderDb } from '../indexing/ThunderDb';
import type { AssistantStreamChunk, LlmProvider, ChatMessage } from '../llm/types';
import { chunkContent, toAssistantStreamChunk } from '../llm/streamChunks';
import type { ThunderSession } from '../session/ThunderSession';
import type { ContextItem, ContextPack } from '../context/types';
import type {
  ContextItemView,
  PlanView,
  AgentActivityEntry,
  ContextBudgetView,
  AgentLiveStatusView,
  TokenUsageBreakdownItem,
} from '../../vscode/webview/messages';
import { HybridRetriever } from '../context/HybridRetriever';
import { ContextBudgeter } from '../context/ContextBudgeter';
import { UserExplicitContextBuilder, type PinnedContextEntry } from '../context/UserExplicitContextBuilder';
import { buildPrompt } from '../plans/promptBuilder';
import { parsePlanFromText, isWriteAllowed } from '../plans/PlanActEngine';
import { createLogger } from '../telemetry/Logger';
import type { SessionLogService } from '../telemetry/SessionLogService';
import { SessionTiming } from '../telemetry/SessionTiming';
import { extractFileMentions } from '../context/fuzzyFileMatch';
import { expandContextQuery } from '../context/contextQueryExpansion';
import { isInternalAgentPath } from '../context/contextRelevance';
import { AutoApplyService } from '../apply/AutoApplyService';
import type { ToolExecutor } from '../safety/ToolExecutor';
import type { ToolRuntime } from '../tools/ToolRuntime';
import { toolsToDefinitions } from '../tools/toolSchema';
import { AgentLoop, type ApprovedToolResult, type AgentLoopSuspendState } from '../runtime/AgentLoop';
import { isSkippedToolOutput } from '../runtime/toolSkip';
import { PlanExecutor } from '../runtime/PlanExecutor';
import { analyzeTask, type TaskAnalysis } from '../runtime/TaskAnalyzer';
import { extractOriginalTaskMessage, isApprovalContinuationMessage } from '../runtime/taskMessage';
import { compactMessagesWithLlm } from '../runtime/ContextCompaction';
import { getMaxInputTokens } from '../runtime/PromptBudget';
import { isAuditCleanupTask, AUDIT_AGENT_MAX_STEPS } from '../runtime/taskKind';
import {
  filterAskModeTools,
  needsAskGrounding,
  shouldEnableAskSubagents,
} from '../runtime/askMode';
import { AskOrchestrator } from '../modes/ask/AskOrchestrator';
import { PlanOrchestrator } from '../modes/plan/PlanOrchestrator';
import { filterPlanModeTools, needsPlanGrounding } from '../modes/plan/planMode';
import { loadPlanningSkillPlaybooks, resolvePlanningSkillNames } from '../modes/plan/planSkillRouting';
import { routePlanIntent } from '../modes/plan/PlanIntentRouter';
import { ActOrchestrator, filterActModeTools, shouldResumeSavedPlan, shouldUsePlannerForAct } from '../modes/agent';
import {
  extractMdxErrorFile,
  isMdxRepairTask,
  suggestDocsVerifyCommands,
} from '../runtime/mdxRepairRouting';
import { setResearchAgentRuntime } from '../tools/builtinTools';
import type { SessionService } from '../session/SessionService';
import type { PlanPersistence } from '../plans/PlanPersistence';
import type { MemoryExtractor } from '../runtime/MemoryExtractor';
import type { AgentConfig, MemoryConfig } from '../config/schema';
import type { PassiveMemoryInjector } from '../memory/PassiveMemoryInjector';
import type { MemoryHookService } from '../memory/MemoryHookService';
import type { MemoryService } from '../memory/MemoryService';
import type { AgentTaskState } from '../runtime/AgentTaskState';
import type { PostEditValidator } from '../apply/PostEditValidator';
import type { SkillCatalogService } from '../skills/SkillCatalogService';
import { thunderPlanToView } from '../modes/plan/planViewMapper';
import { showWriteDiffPreview, showPatchDiffPreview } from '../../vscode/diffPreview';
import { toWorkspaceRelPath } from '../util/paths';
import { estimateChatRequestTokens } from '../llm/UsageTrackingProvider';
import { resolveMaxContextItems } from '../context/resolveMaxContextItems';
import { enrichTask } from '../task';
import type { GitHubIssueFetcher } from '../integrations/github';

const log = createLogger('ChatOrchestrator');

export type ContextPackCallback = (pack: ContextPack, views: ContextItemView[], budget: ContextBudgetView) => void;
export type PlanCallback = (plan: PlanView | null) => void;
export type ActivityCallback = (entry: AgentActivityEntry) => void;
export type LiveStatusCallback = (status: AgentLiveStatusView | null) => void;
export type TokenUsageCallback = (
  promptTokens: number,
  contextTokens: number,
  responseText: string,
  breakdown: TokenUsageBreakdownItem[],
  options?: { final?: boolean }
) => void;

export interface ChatOrchestratorDeps {
  toolRuntime?: ToolRuntime;
  toolExecutor?: ToolExecutor;
  sessionService?: SessionService;
  planPersistence?: PlanPersistence;
  memoryExtractor?: MemoryExtractor;
  memoryConfig?: MemoryConfig;
  agentConfig?: AgentConfig;
  passiveMemoryInjector?: PassiveMemoryInjector;
  memoryHookService?: MemoryHookService;
  postEditValidator?: PostEditValidator;
  onPostWrite?: (relPath: string) => Promise<void>;
  workspace?: string;
  onDiffPreview?: (path: string, content: string) => Promise<void>;
  sessionLog?: SessionLogService;
  memoryService?: MemoryService;
  taskState?: AgentTaskState;
  researchAgentProvider?: LlmProvider;
  runVerifyHooks?: (commands: string[], userMessage?: string) => Promise<string>;
  skillCatalog?: SkillCatalogService;
  allowNetwork?: () => boolean;
  githubIssueFetcher?: GitHubIssueFetcher;
  githubTokenProvider?: () => Promise<string | undefined>;
  githubIssueFetchEnabled?: boolean;
  githubIssueCommentLimit?: number;
}

export class ChatOrchestrator {
  private abortController: AbortController | undefined;
  private onContextPack: ContextPackCallback | undefined;
  private onPlan: PlanCallback | undefined;
  private onActivity: ActivityCallback | undefined;
  private onLiveStatus: LiveStatusCallback | undefined;
  private onTokenUsage: TokenUsageCallback | undefined;
  private autoApply = new AutoApplyService();
  private deps: ChatOrchestratorDeps = {};
  private agentLoop: AgentLoop | undefined;
  private planExecutor: PlanExecutor | undefined;
  private suspendContext: {
    session: ThunderSession;
    provider: LlmProvider;
    userMessage: string;
    auditMode: boolean;
    agentMaxSteps?: number;
    autoContinue?: boolean;
    maxAutoContinues?: number;
    planningResume?: {
      displayPack: ContextPack;
      planningRequest: string;
      taskAnalysis: TaskAnalysis;
      initialPlanningDiscovery: string;
      skillPlaybookContext: string;
      appliedSkills: string[];
    };
  } | undefined;
  private retrievalCache: { key: string; items: ContextItem[]; at: number } | null = null;

  constructor(
    private readonly retriever: HybridRetriever,
    private readonly budgeter: ContextBudgeter,
    private readonly db?: ThunderDb
  ) {}

  configure(deps: ChatOrchestratorDeps): void {
    this.deps = { ...this.deps, ...deps };
    if (deps.toolExecutor) {
      this.autoApply = new AutoApplyService(deps.toolExecutor);
      this.agentLoop = new AgentLoop(deps.toolExecutor, 15);
    }
    if (deps.planPersistence && this.agentLoop) {
      this.planExecutor = new PlanExecutor(
        this.agentLoop,
        deps.planPersistence,
        deps.postEditValidator,
        deps.toolExecutor
      );
    }
  }

  setContextPackCallback(cb: ContextPackCallback): void {
    this.onContextPack = cb;
  }

  setPlanCallback(cb: PlanCallback): void {
    this.onPlan = cb;
  }

  setActivityCallback(cb: ActivityCallback): void {
    this.onActivity = cb;
  }

  setLiveStatusCallback(cb: LiveStatusCallback): void {
    this.onLiveStatus = cb;
  }

  setTokenUsageCallback(cb: TokenUsageCallback): void {
    this.onTokenUsage = cb;
  }

  setToolExecutor(executor: ToolExecutor | undefined): void {
    this.configure({ toolExecutor: executor });
  }

  private emitActivity(kind: AgentActivityEntry['kind'], message: string, detail?: string): void {
    this.onActivity?.({
      id: randomUUID(),
      kind,
      message,
      detail,
      timestamp: Date.now(),
    });
  }

  private setLiveStatus(
    label: string | null,
    detail?: string,
    stepCurrent?: number,
    stepTotal?: number
  ): void {
    if (!label) {
      this.onLiveStatus?.(null);
      return;
    }
    this.onLiveStatus?.({ label, detail, stepCurrent, stepTotal });
  }

  async *send(
    session: ThunderSession,
    provider: LlmProvider,
    userMessage: string,
    recentMessages: ChatMessage[] = [],
    options?: { pinnedContext?: PinnedContextEntry[] }
  ): AsyncIterable<AssistantStreamChunk> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const sessionLog = this.deps.sessionLog;
    const sessionTiming = new SessionTiming();
    sessionTiming.start('turn_total');
    this.setLiveStatus('Starting', `Mode: ${session.mode}`);
    this.emitActivity('info', `Mode: ${session.mode} · Provider: ${provider.id}`);

    this.deps.sessionService?.ensureSession(session, userMessage.slice(0, 64));
    this.deps.sessionLog?.append('user_message', userMessage.slice(0, 200), {
      mode: session.mode,
      provider: provider.id,
      messageLength: userMessage.length,
      auditMode: isAuditCleanupTask(userMessage),
    });

    const ws = this.deps.workspace ?? '';
    const editor = vscode.window.activeTextEditor;
    const rawCurrentFile = editor && ws
      ? toWorkspaceRelPath(editor.document.uri, ws) ?? undefined
      : undefined;
    const currentFile = rawCurrentFile && !isInternalAgentPath(rawCurrentFile)
      ? rawCurrentFile
      : undefined;

    const openFiles: string[] = [];
    if (ws) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (input && typeof input === 'object' && 'uri' in input) {
            const uri = (input as { uri: vscode.Uri }).uri;
            if (uri.scheme === 'file') {
              const rel = toWorkspaceRelPath(uri, ws);
              if (rel && !isInternalAgentPath(rel)) openFiles.push(rel);
            }
          }
        }
      }
    }

    const agentConfig = this.deps.agentConfig;
    const originalTaskMessage = extractOriginalTaskMessage(userMessage) ?? userMessage;
    const taskEnrichment = await enrichTask(originalTaskMessage, {
      github: {
        enabled: this.deps.githubIssueFetchEnabled ?? true,
        allowNetwork: Boolean(this.deps.allowNetwork?.()),
        tokenProvider: this.deps.githubTokenProvider,
        fetcher: this.deps.githubIssueFetcher,
        maxComments: this.deps.githubIssueCommentLimit,
      },
    });
    if (taskEnrichment.signals.githubIssue) {
      const signalInfo = taskEnrichment.signals.githubIssue;
      this.emitActivity(
        signalInfo.fetched ? 'context' : 'info',
        signalInfo.fetched
          ? `Fetched GitHub issue ${signalInfo.ref.owner}/${signalInfo.ref.repo}#${signalInfo.ref.number}`
          : `Detected GitHub issue ${signalInfo.ref.owner}/${signalInfo.ref.repo}#${signalInfo.ref.number}`,
        signalInfo.error
      );
    }

    const taskForClassification = taskEnrichment.classificationText;
    const isAskMode = session.mode === 'ask';
    const isPlanMode = session.mode === 'plan';
    const isAgentMode = session.mode === 'agent';
    const auditMode = isAuditCleanupTask(taskForClassification);
    const mdxRepairMode = isMdxRepairTask(taskForClassification);
    const mdxErrorFile = mdxRepairMode ? extractMdxErrorFile(taskForClassification) : undefined;
    const orchestrationEnabled = agentConfig?.orchestrationEnabled ?? true;
    const activePlanAtStart = isAgentMode
      ? this.deps.planPersistence?.getActive(session.id)
      : undefined;
    const taskAnalysis = analyzeTask(taskForClassification, session.mode);
    const askPlan = isAskMode
      ? AskOrchestrator.prepare(taskForClassification, {
          workspaceRoot: this.deps.workspace,
          configuredMaxSteps: agentConfig?.askMaxSteps,
          askDepth: agentConfig?.askDepth,
          askAutoContinue: agentConfig?.askAutoContinue,
          askMaxAutoContinues: agentConfig?.askMaxAutoContinues,
        })
      : undefined;
    const planPlan = isPlanMode
      ? PlanOrchestrator.prepare(taskForClassification, {
          workspaceRoot: this.deps.workspace,
          skillCatalog: this.deps.skillCatalog,
          configuredMaxSteps: agentConfig?.maxSteps,
          planDepth: agentConfig?.planDepth,
          planAutoContinue: agentConfig?.autoContinue,
          planMaxAutoContinues: agentConfig?.maxAutoContinues,
          taskAnalysis,
        })
      : undefined;
    const actPlan = isAgentMode
      ? ActOrchestrator.prepare(taskForClassification, {
          workspaceRoot: this.deps.workspace,
          skillCatalog: this.deps.skillCatalog,
          configuredMaxSteps: agentConfig?.maxSteps,
          actDepth: agentConfig?.actDepth,
          actAutoContinue: agentConfig?.autoContinue,
          actMaxAutoContinues: agentConfig?.maxAutoContinues,
          taskAnalysis,
          orchestrationEnabled,
          auditMode,
          mdxRepairMode,
          githubIssueMode: taskEnrichment.signals.githubIssue?.fetched === true,
          hasActivePlan: Boolean(activePlanAtStart?.plan),
          savedPlanId: activePlanAtStart?.id,
          verifyCommands: agentConfig?.verifyCommands,
        })
      : undefined;
    const scopedRoot =
      askPlan?.scope.status === 'matched'
        ? askPlan.scope.scopeRoot
        : planPlan?.scope.status === 'matched'
          ? planPlan.scope.scopeRoot
          : actPlan?.scope.status === 'matched'
            ? actPlan.scope.scopeRoot
            : undefined;

    this.setLiveStatus('Gathering context');
    this.emitActivity('context', 'Retrieving workspace context…', extractFileMentions(userMessage).join(', ') || undefined);

    const maxInputTokens = getMaxInputTokens(provider.capabilities.contextWindow);
    const explicitContextTokenBudget = Math.min(32_000, Math.floor(maxInputTokens * 0.08));
    const pinnedContext = options?.pinnedContext ?? [];
    const explicitBuilder = new UserExplicitContextBuilder(this.db, ws, explicitContextTokenBudget);
    const explicitResult = explicitBuilder.build(pinnedContext);
    if (explicitResult.items.length > 0) {
      this.emitActivity(
        'context',
        `User-pinned context: ${explicitResult.items.length} item(s) · ${explicitResult.totalTokens} tokens`,
        pinnedContext.map((p) => p.path).join(', ')
      );
    }

    const retrievalText = expandContextQuery(taskEnrichment.retrievalText);
    let items;
    const retrievalKey = JSON.stringify({
      text: retrievalText,
      currentFile,
      openFiles,
      scopeRoot: scopedRoot,
      pinned: pinnedContext.map((p) => p.path),
    });
    const cacheFresh =
      this.retrievalCache &&
      this.retrievalCache.key === retrievalKey &&
      Date.now() - this.retrievalCache.at < 60_000;

    sessionTiming.start('context_retrieval');
    try {
      if (cacheFresh && this.retrievalCache) {
        items = this.retrievalCache.items;
        sessionTiming.end('context_retrieval', sessionLog, { success: true, itemCount: items.length, cached: true });
      } else {
        items = await this.retriever.retrieve({
          text: retrievalText,
          currentFile,
          openFiles,
          scopeRoot: scopedRoot,
          pinnedContext: pinnedContext.map((p) => ({ path: p.path, kind: p.kind })),
          maxItems: resolveMaxContextItems({
            contextWindow: provider.capabilities.contextWindow,
            actDepth: agentConfig?.actDepth,
            expandedQuery: retrievalText !== userMessage,
          }),
        });
        this.retrievalCache = { key: retrievalKey, items, at: Date.now() };
        sessionTiming.end('context_retrieval', sessionLog, {
          success: true,
          itemCount: items.length,
        });
      }
    } catch (error) {
      sessionTiming.end('context_retrieval', sessionLog, { success: false });
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Context retrieval failed', { error: msg });
      this.emitActivity('error', 'Context retrieval failed', msg);
      throw error;
    }

    const retrievedPaths = uniqueContextNames(items);
    this.emitActivity(
      'read',
      `Prepared ${items.length} context snippets from ${retrievedPaths.length} sources`,
      retrievedPaths.slice(0, 8).join('\n')
    );

    const hookInjection = this.deps.memoryHookService
      ? await this.deps.memoryHookService.onUserPromptSubmit(session.id, userMessage)
      : undefined;
    const passiveMemories = await (this.deps.passiveMemoryInjector?.inject(userMessage, session.id) ?? Promise.resolve([]));
    if (passiveMemories.length > 0) {
      items = [...items, ...passiveMemories];
      this.emitActivity('info', `Injected ${passiveMemories.length} passive memories`);
    }
    if (hookInjection) {
      items = [
        ...items,
        {
          id: 'hook-user-prompt',
          source: 'memory',
          content: hookInjection,
          score: 5,
          reason: 'UserPromptSubmit hook',
          tokenEstimate: Math.ceil(hookInjection.length / 4),
        },
      ];
      this.emitActivity('info', 'UserPromptSubmit hook injected context');
    }

    const contextBudget = Math.floor(maxInputTokens * 0.65);
    const pack = this.budgeter.budget(items, contextBudget);
    const displayPack: ContextPack = {
      ...pack,
      items: [...explicitResult.items, ...pack.items],
      totalTokens: pack.totalTokens + explicitResult.totalTokens,
      formatted: explicitResult.formatted
        ? `${explicitResult.formatted}\n\n---\n\n${pack.formatted}`
        : pack.formatted,
    };
    const views = contextItemsToViews(displayPack.items);
    const budgetView = contextPackToBudgetView(displayPack);

    this.setLiveStatus('Context ready', `${displayPack.items.length} snippets · ${displayPack.totalTokens} tokens`);

    this.onContextPack?.(displayPack, views, budgetView);

    this.emitActivity(
      'budget',
      `Prompt context: ${displayPack.totalTokens}/${pack.budgetLimit} tokens · ${displayPack.items.length} snippets`,
      pack.dropped.length > 0 ? `${pack.dropped.length} dropped` : undefined
    );
    this.deps.sessionLog?.append('info', `Context ${displayPack.totalTokens}/${pack.budgetLimit} tokens`, {
      snippetCount: displayPack.items.length,
      droppedCount: pack.dropped.length,
    });
    this.deps.sessionLog?.appendDebug('context_pack', `Context ${displayPack.totalTokens}/${pack.budgetLimit} tokens`, {
      snippetCount: displayPack.items.length,
      droppedCount: pack.dropped.length,
      sources: displayPack.items.map((i) => i.source).slice(0, 20),
      currentFile,
      openFiles: openFiles.slice(0, 10),
      pinnedContext: pinnedContext.map((p) => p.path),
    });

    const transcriptBudget = Math.floor(maxInputTokens * 0.12);
    sessionTiming.start('context_compaction');
    const compacted = await compactMessagesWithLlm(recentMessages, transcriptBudget, provider);
    sessionTiming.end('context_compaction', sessionLog, {
      before: recentMessages.length,
      after: compacted.length,
    });
    if (compacted.length < recentMessages.length) {
      this.emitActivity('info', `Compacted ${recentMessages.length - compacted.length} older messages`);
    }

    const toolsEnabled = provider.capabilities.supportsTools
      && Boolean(this.deps.toolRuntime && this.deps.toolExecutor && this.agentLoop);
    const isResume = isApprovalContinuationMessage(userMessage);
    this.deps.taskState?.setTaskContext(taskAnalysis.kind, taskAnalysis.summary, taskForClassification);
    if (!isResume) {
      this.suspendContext = undefined;
      this.agentLoop?.clearSuspendState();
    }
    const plannerEnabled = actPlan?.route.shouldUsePlanner
      ?? shouldUsePlanner(session.mode, taskAnalysis, orchestrationEnabled, auditMode);
    const subagentsEnabled =
      (agentConfig?.subagentsEnabled ?? true) &&
      !auditMode &&
      (isAskMode
        ? (askPlan?.route.shouldUseSubagents ?? shouldEnableAskSubagents(userMessage))
        : isPlanMode
          ? (planPlan?.route.shouldUseSubagents ?? taskAnalysis.shouldUseSubagents)
          : (actPlan?.route.shouldUseSubagents ?? taskAnalysis.shouldUseSubagents));
    let tools = toolsEnabled
      ? toolsToDefinitions(this.deps.toolRuntime!.list()).filter((tool) =>
          subagentsEnabled || tool.function.name !== 'spawn_research_agent'
        )
      : [];
    if (isAskMode) {
      tools = filterAskModeTools(tools);
    } else if (isPlanMode) {
      tools = filterPlanModeTools(tools);
    }

    if (toolsEnabled && this.deps.toolExecutor) {
      setResearchAgentRuntime({
        toolExecutor: this.deps.toolExecutor,
        getProvider: () => this.deps.researchAgentProvider ?? provider,
        getTools: () => tools,
        maxSteps: agentConfig?.researchAgentMaxSteps,
        timeoutMs: agentConfig?.researchAgentTimeoutMs,
      });
    } else {
      setResearchAgentRuntime(undefined);
    }

    if (auditMode) {
      this.emitActivity('info', 'Audit mode — using tools to scan project');
    } else if (mdxRepairMode) {
      this.emitActivity('info', 'MDX repair mode — fix exact build failure', mdxErrorFile ?? taskAnalysis.summary);
    } else if (isResume) {
      this.emitActivity('info', 'Resuming after approval — continuing execution');
    } else if (isAskMode) {
      this.emitActivity('info', 'Ask mode — read-only exploration', taskAnalysis.summary);
    } else if (actPlan?.executionPath === 'resume_saved_plan') {
      this.emitActivity('info', 'Act handoff — executing the saved plan', actPlan.route.summary);
    } else if (plannerEnabled) {
      this.emitActivity('info', `Orchestration: ${taskAnalysis.kind} (${taskAnalysis.complexity})`, taskAnalysis.summary);
    } else if (orchestrationEnabled && taskAnalysis.shouldPlan && session.mode === 'agent') {
      this.emitActivity('info', 'Fast Agent mode — sending directly to the tool-using agent', taskAnalysis.summary);
    }
    this.deps.sessionLog?.append('info', 'Task analysis', {
      kind: taskAnalysis.kind,
      complexity: taskAnalysis.complexity,
      shouldPlan: taskAnalysis.shouldPlan,
      plannerEnabled,
      shouldUseSubagents: subagentsEnabled,
      askIntent: askPlan?.route.intent,
      askProfile: askPlan?.route.profile,
      askScope: askPlan?.scope.status,
      planIntent: planPlan?.route.intent,
      planScope: planPlan?.scope.status,
      planQualityProfile: planPlan?.route.qualityProfile,
      actIntent: actPlan?.route.intent,
      actExecutionPath: actPlan?.executionPath,
      actScope: actPlan?.scope.status,
      actSkills: actPlan?.appliedSkills,
      auditMode,
      mdxRepairMode,
      toolsEnabled,
    });

    this.saveTurn(session.id, 'user', userMessage);

    let fullResponse = '';
    let livePromptTokens = 0;
    let livePromptMessages: ChatMessage[] | undefined;
    let liveExplicitContextBlock = explicitResult.formatted || undefined;
    const emitLiveTokenUsage = () => {
      const messagesForBreakdown = livePromptMessages;
      if (!messagesForBreakdown || livePromptTokens <= 0) return;
      this.onTokenUsage?.(
        livePromptTokens,
        displayPack.totalTokens,
        fullResponse,
        this.buildTokenBreakdown(messagesForBreakdown, displayPack, compacted),
        { final: false }
      );
    };
    const sharedLoopCallbacks = this.buildLoopCallbacks(emitLiveTokenUsage);
    const sharedPlanOptions = {
      stepMaxRetries: agentConfig?.stepMaxRetries,
      finalValidationEnabled: agentConfig?.finalValidationEnabled,
      agentMaxSteps: actPlan?.maxSteps ?? agentConfig?.maxSteps,
      restrictRunCommandToReadOnly: auditMode,
      workspace: this.deps.workspace,
      sessionLog,
    };
    const planningContextBlock = mergePromptContexts(
      isAgentMode && actPlan ? actPlan.promptContext : undefined,
      planPlan?.promptContext,
      ...taskEnrichment.contextBlocks
    );
    const planningRequest = planningContextBlock
      ? `${planningContextBlock}\n\n## User request\n${userMessage}`
      : userMessage;

    try {
      const activePlan = activePlanAtStart ?? this.deps.planPersistence?.getActive(session.id);
      if (
        !isApprovalContinuationMessage(userMessage) &&
        actPlan?.executionPath === 'resume_saved_plan' &&
        this.planExecutor &&
        activePlan
      ) {
        const plan = activePlan.plan;
        this.onPlan?.(thunderPlanToView(plan, { status: 'running' }));
        this.setLiveStatus('Executing saved plan', plan.goal, 1, plan.steps.length);
        this.emitActivity('info', `Resuming saved plan (${plan.steps.length} steps)…`);
        sessionTiming.start('plan_execution');

        for await (const chunk of this.planExecutor.executePlan(
          session,
          provider,
          plan,
          displayPack,
          tools,
          (updated) => this.onPlan?.(thunderPlanToView(updated, { status: 'running' })),
          signal,
          sharedLoopCallbacks,
          sharedPlanOptions
        )) {
          if (signal.aborted) break;
          fullResponse += chunkContent(chunk);
          yield chunk;
        }
        sessionTiming.end('plan_execution', sessionLog, { resumed: true, stepCount: plan.steps.length });

        await this.finishTurn(session, provider, userMessage, fullResponse, displayPack, compacted);
        this.setLiveStatus(null);
        return;
      }

      if (
        plannerEnabled &&
        this.planExecutor &&
        taskAnalysis.shouldPlan
      ) {
        const planningRoute = planPlan?.route ?? routePlanIntent(planningRequest, taskAnalysis);
        const skillContext = planPlan
          ? {
              skillPlaybookContext: planPlan.skillPlaybookContext,
              appliedSkills: planPlan.appliedSkills,
            }
          : actPlan
            ? {
                skillPlaybookContext: actPlan.skillPlaybookContext,
                appliedSkills: actPlan.appliedSkills,
              }
          : (() => {
              const loaded = loadPlanningSkillPlaybooks(
                this.deps.skillCatalog,
                resolvePlanningSkillNames(planningRoute.intent, taskAnalysis)
              );
              return {
                skillPlaybookContext: loaded.context,
                appliedSkills: loaded.loaded,
              };
            })();

        const planningSkillOptions = {
          skillPlaybookContext: skillContext.skillPlaybookContext,
        };

        let requirementAnalysisText = '';
        let planningDiscovery = '';

        this.onPlan?.({
          goal: planningRequest.slice(0, 240),
          assumptions: [],
          steps: [],
          status: 'planning',
          appliedSkills: skillContext.appliedSkills,
        });

        if (toolsEnabled) {
          this.setLiveStatus('Planning discovery');
          this.emitActivity('info', 'Running read-only planning discovery…');
          if (skillContext.appliedSkills.length > 0) {
            this.emitActivity(
              'info',
              `Loaded planning skills: ${skillContext.appliedSkills.join(', ')}`
            );
          }
          sessionTiming.start('planning_discovery');
          try {
            planningDiscovery = await this.planExecutor.runPlanningDiscovery(
              provider,
              session.mode,
              displayPack,
              planningRequest,
              taskAnalysis,
              tools,
              signal,
              sharedLoopCallbacks,
              {
                agentMaxSteps: planPlan?.discoveryMaxSteps ??
                  actPlan?.maxSteps ??
                  (auditMode ? Math.min(agentConfig?.maxSteps ?? 10, 12) : Math.min(agentConfig?.maxSteps ?? 6, 8)),
                restrictRunCommandToReadOnly: true,
                planAutoContinue: planPlan?.autoContinue ?? actPlan?.autoContinue ?? agentConfig?.autoContinue,
                planMaxAutoContinues: planPlan?.maxAutoContinues ??
                  actPlan?.maxAutoContinues ??
                  agentConfig?.maxAutoContinues,
                ...planningSkillOptions,
              }
            );
            if (planningDiscovery) {
              this.emitActivity('info', 'Planning discovery complete', planningDiscovery.slice(0, 500));
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.emitActivity('error', 'Planning discovery failed; continuing with retrieved context', msg);
          } finally {
            sessionTiming.end('planning_discovery', sessionLog, {
              hasOutput: Boolean(planningDiscovery),
            });
          }
        } else {
          this.emitActivity(
            'error',
            'Planning discovery skipped — current model/provider does not support tools',
            'Use a tool-capable model: qwen3-coder via OpenAI-compatible (Ollama), or deepseek-chat via DeepSeek API. Do not pair DeepSeek provider with local Ollama model names.'
          );
        }

        if (session.mode === 'plan' && this.agentLoop?.hadPendingApproval()) {
          this.suspendContext = {
            session,
            provider,
            userMessage: taskForClassification,
            auditMode,
            agentMaxSteps: agentConfig?.maxSteps,
            autoContinue: agentConfig?.autoContinue,
            maxAutoContinues: agentConfig?.maxAutoContinues,
            planningResume: {
              displayPack,
              planningRequest,
              taskAnalysis,
              initialPlanningDiscovery: planningDiscovery,
              skillPlaybookContext: skillContext.skillPlaybookContext,
              appliedSkills: skillContext.appliedSkills,
            },
          };
          const questionNote =
            '\n\n**Planning paused for a clarification.** Choose an option in the question panel below, and I will resume discovery and compile the plan from that answer.\n';
          fullResponse += questionNote;
          yield questionNote;
          this.setLiveStatus('Waiting for planning answer', 'Choose an option below');
          this.emitActivity('approval', 'Planning paused for a clarifying question');
          await this.finishTurn(session, provider, userMessage, fullResponse, displayPack, compacted);
          this.setLiveStatus(null);
          return;
        }

        this.setLiveStatus('Analyzing requirements');
        this.emitActivity('info', 'Analyzing requirements…');
        sessionTiming.start('requirement_analysis');

        for await (const chunk of this.planExecutor.analyzeRequirementsStream(
          provider,
          displayPack,
          planningRequest,
          taskAnalysis,
          skillContext.skillPlaybookContext,
          (text) => {
            requirementAnalysisText = text;
            if (session.mode === 'plan') {
              this.onPlan?.({
                goal: planningRequest.slice(0, 240),
                assumptions: [],
                steps: [],
                status: 'planning',
                requirementAnalysis: text,
                appliedSkills: skillContext.appliedSkills,
              });
            }
          }
        )) {
          if (signal.aborted) break;
          if (session.mode !== 'plan') {
            fullResponse += chunkContent(chunk);
            yield chunk;
          }
        }
        sessionTiming.end('requirement_analysis', sessionLog);

        this.setLiveStatus('Creating plan');
        this.emitActivity('info', 'Planning multi-step task…');
        sessionTiming.start('plan_generation');

        const requirementAnalysis =
          requirementAnalysisText.trim() || extractRequirementAnalysis(fullResponse);

        const plan = await this.planExecutor.generatePlan(
          provider,
          session.mode,
          displayPack,
          planningRequest,
          requirementAnalysis,
          planningDiscovery,
          taskAnalysis,
          session.id,
          {
            workspace: this.deps.workspace,
            useIsolatedPlanning: true,
            ...planningSkillOptions,
          }
        );
        sessionTiming.end('plan_generation', sessionLog, {
          success: Boolean(plan),
          stepCount: plan?.steps.length ?? 0,
        });
        if (plan && plan.steps.length >= 1) {
          const planView = thunderPlanToView(plan, {
            status: session.mode === 'plan' ? 'ready' : 'running',
            requirementAnalysis: requirementAnalysis || undefined,
            appliedSkills: skillContext.appliedSkills,
          });
          this.onPlan?.(planView);
          this.deps.planPersistence?.save(session.id, plan);
          this.deps.sessionLog?.append('plan_created', plan.goal, {
            stepCount: plan.steps.length,
            steps: plan.steps.map((s) => ({ id: s.id, title: s.title, risk: s.risk, phase: s.phase })),
            appliedSkills: skillContext.appliedSkills,
          });

          if (session.mode === 'agent') {
            this.setLiveStatus('Executing plan', plan.goal, 1, plan.steps.length);
            this.emitActivity('info', `Executing ${plan.steps.length} steps…`);
            const planHeader = formatPlanHeader(plan);
            fullResponse += planHeader;
            yield planHeader;
            sessionTiming.start('plan_execution');

            for await (const chunk of this.planExecutor.executePlan(
              session,
              provider,
              plan,
              displayPack,
              tools,
              (updated) => {
                this.onPlan?.(
                  thunderPlanToView(updated, {
                    status: 'running',
                    requirementAnalysis: requirementAnalysis || undefined,
                    appliedSkills: skillContext.appliedSkills,
                  })
                );
                const running = updated.steps.findIndex((s) => s.status === 'running');
                const idx = running >= 0 ? running : updated.steps.filter((s) => s.status === 'done').length;
                const step = updated.steps[idx];
                if (step) {
                  this.setLiveStatus('Running step', step.title, idx + 1, updated.steps.length);
                }
              },
              signal,
              sharedLoopCallbacks,
              sharedPlanOptions
            )) {
              if (signal.aborted) break;
              fullResponse += chunkContent(chunk);
              yield chunk;
            }
            sessionTiming.end('plan_execution', sessionLog, {
              stepCount: plan.steps.length,
            });

            if (this.agentLoop?.hadPendingApproval()) {
              this.suspendContext = {
                session,
                provider,
                userMessage: taskForClassification,
                auditMode,
                agentMaxSteps: agentConfig?.maxSteps,
                autoContinue: agentConfig?.autoContinue,
                maxAutoContinues: agentConfig?.maxAutoContinues,
              };
              const pauseBlock = this.savePauseState(session, taskForClassification, taskAnalysis.kind);
              const approvalNote =
                `\n\n${pauseBlock}\n\n⏸ **Waiting for your approval** — review the proposed changes above, then approve or deny in the panel below.\n`;
              fullResponse += approvalNote;
              yield approvalNote;
              this.setLiveStatus('Waiting for approval', 'Review and approve below');
              this.emitActivity('approval', 'Paused — waiting for your approval', this.deps.taskState?.getPauseSummary());
              await this.finishTurn(session, provider, userMessage, fullResponse, displayPack, compacted);
              this.setLiveStatus(null);
              return;
            }
          } else {
            const planText = formatPlanModeChatSummary(planView);
            fullResponse = planText;
            yield planText;
            this.emitActivity('info', 'Plan ready — switch to Agent mode to execute steps');
          }

          await this.finishTurn(session, provider, userMessage, fullResponse, displayPack, compacted);
          this.setLiveStatus(null);
          return;
        }

        const failureText =
          '\n\n⚠️ I could not produce a plan that passed the planning quality gate. No execution was started. Please retry with a little more scope detail, or switch off orchestration for a direct answer.\n';
        fullResponse += failureText;
        yield failureText;
        this.emitActivity('error', 'Planning failed quality gate');
        await this.finishTurn(session, provider, userMessage, fullResponse, displayPack, compacted);
        this.setLiveStatus(null);
        return;
      }

      const isResume = isApprovalContinuationMessage(userMessage);
      const taskStateBlock = this.deps.taskState?.buildPromptBlock();
      const messages = buildPrompt(
        session.mode,
        pack,
        userMessage,
        compacted,
        toolsEnabled,
        auditMode,
        mdxRepairMode,
        mdxErrorFile,
        taskStateBlock,
        isResume,
        explicitResult.formatted || undefined,
        mergePromptContexts(
          askPlan?.promptContext,
          planPlan?.promptContext,
          actPlan?.promptContext,
          ...taskEnrichment.contextBlocks
        )
      );
      const promptTokens = estimateChatRequestTokens({
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });
      livePromptTokens = promptTokens;
      livePromptMessages = messages;
      liveExplicitContextBlock = explicitResult.formatted || undefined;
      emitLiveTokenUsage();

      if (toolsEnabled && this.agentLoop) {
        const directAgentTools = filterActModeTools(tools);
        this.setLiveStatus(isAskMode ? 'Answering' : 'Agent running');
        this.emitActivity(
          'info',
          isAskMode ? 'Exploring codebase (read-only)…' : auditMode ? 'Scanning project with tools…' : 'Agent loop started'
        );
        sessionTiming.start('direct_agent');

        for await (const chunk of this.agentLoop.run(
          provider,
          messages,
          directAgentTools,
          signal,
          sharedLoopCallbacks,
          {
            auditMode,
            askMode: isAskMode,
            planMode: isPlanMode,
            requiresAskGrounding: isAskMode && needsAskGrounding(userMessage),
            requiresPlanGrounding: isPlanMode && needsPlanGrounding(taskForClassification),
            maxSteps: isAskMode
              ? (askPlan?.maxSteps ?? agentConfig?.askMaxSteps ?? 18)
              : isPlanMode
                ? (planPlan?.discoveryMaxSteps ?? agentConfig?.maxSteps ?? 8)
                : auditMode
                  ? AUDIT_AGENT_MAX_STEPS
                  : (actPlan?.maxSteps ?? agentConfig?.maxSteps),
            autoContinue: isAskMode
              ? (askPlan?.autoContinue ?? true)
              : isPlanMode
                ? (planPlan?.autoContinue ?? agentConfig?.autoContinue ?? true)
                : (actPlan?.autoContinue ?? agentConfig?.autoContinue ?? true),
            maxAutoContinues: isAskMode
              ? (askPlan?.maxAutoContinues ?? 1)
              : isPlanMode
                ? (planPlan?.maxAutoContinues ?? agentConfig?.maxAutoContinues)
                : (actPlan?.maxAutoContinues ?? agentConfig?.maxAutoContinues),
          }
        )) {
          if (signal.aborted) break;
          fullResponse += chunkContent(chunk);
          emitLiveTokenUsage();
          yield chunk;
        }
        sessionTiming.end('direct_agent', sessionLog, {
          auditMode,
          pendingApproval: this.agentLoop.hadPendingApproval(),
        });

        if (this.agentLoop.hadPendingApproval()) {
          this.suspendContext = {
            session,
            provider,
            userMessage: taskForClassification,
            auditMode,
            agentMaxSteps: agentConfig?.maxSteps,
            autoContinue: agentConfig?.autoContinue,
            maxAutoContinues: agentConfig?.maxAutoContinues,
          };
          const pauseBlock = this.savePauseState(session, taskForClassification, taskAnalysis.kind);
          const approvalNote =
            `\n\n${pauseBlock}\n\n⏸ **Waiting for your approval** — review the proposed changes above, then approve or deny in the panel below.\n`;
          fullResponse += approvalNote;
          yield approvalNote;
          this.setLiveStatus('Waiting for approval', 'Review and approve below');
          this.emitActivity('approval', 'Paused — waiting for your approval', this.deps.taskState?.getPauseSummary());
        } else if (!this.agentLoop.hadPendingApproval() && !signal.aborted) {
          if (
            session.mode === 'agent' &&
            agentConfig?.verifyOnActComplete
          ) {
            this.setLiveStatus('Running verify hooks');
            this.emitActivity('info', 'Discovering and running project verification…');
            const verifyCommands = mdxRepairMode
              ? suggestDocsVerifyCommands()
              : (agentConfig.verifyCommands ?? []);
            const verifyOutput = await this.deps.runVerifyHooks?.(verifyCommands, taskForClassification);
            if (verifyOutput?.trim()) {
              const block = `\n\n### Verify\n\n${verifyOutput}\n`;
              fullResponse += block;
              yield block;
            }
          }
          if (
            orchestrationEnabled &&
            taskAnalysis.shouldVerify &&
            session.mode === 'agent' &&
            this.planExecutor &&
            shouldRunDirectFinalValidation(taskAnalysis.kind, getTouchedFilesFromAudit(this.deps.toolRuntime))
          ) {
            const directTouchedFiles = getTouchedFilesFromAudit(this.deps.toolRuntime);
            this.setLiveStatus('Final validation');
            this.emitActivity('info', 'Running post-task validation…');
            yield '\n\n### Post-task validation\n\n';

            const validationPlan = {
              goal: userMessage.slice(0, 200),
              assumptions: [] as string[],
              steps: [] as import('../plans/PlanActEngine').ThunderPlan['steps'],
              requiredApprovals: [] as string[],
            };

            for await (const chunk of this.planExecutor.runFinalValidation(
              session,
              provider,
              validationPlan,
              displayPack,
              directAgentTools,
              signal,
              sharedLoopCallbacks,
              {
                agentMaxSteps: Math.min(agentConfig?.maxSteps ?? 10, 10),
                restrictRunCommandToReadOnly: auditMode,
                touchedFiles: directTouchedFiles,
              }
            )) {
              if (signal.aborted) break;
              fullResponse += chunkContent(chunk);
              emitLiveTokenUsage();
              yield chunk;
            }
          }
        }
      } else {
        this.setLiveStatus('Generating response');
        this.emitActivity('info', 'Streaming response…');
        for await (const delta of provider.complete({ messages, stream: true })) {
          if (signal.aborted) break;
          if (delta.content) {
            fullResponse += delta.content;
            emitLiveTokenUsage();
          }
          const chunk = toAssistantStreamChunk(delta.content, delta.reasoning);
          if (chunk) yield chunk;
          if (delta.error) throw new Error(delta.error);
        }
      }

      await this.finishTurn(
        session,
        provider,
        userMessage,
        fullResponse,
        displayPack,
        compacted,
        promptTokens,
        messages,
        liveExplicitContextBlock
      );
      this.onLiveStatus?.(null);
    } finally {
      sessionTiming.end('turn_total', sessionLog, {
        mode: session.mode,
        responseLength: fullResponse.length,
      });
      log.info('Chat completed', { sessionId: session.id, tokens: displayPack.totalTokens });
    }
  }

  private async finishTurn(
    session: ThunderSession,
    provider: LlmProvider,
    userMessage: string,
    fullResponse: string,
    pack: ContextPack,
    compacted: ChatMessage[],
    promptTokens = 0,
    promptMessages?: ChatMessage[],
    explicitContextBlock?: string
  ): Promise<void> {
    const usageMessages =
      promptMessages ??
      buildPrompt(session.mode, pack, userMessage, compacted, false, false, false, undefined, undefined, false, explicitContextBlock);
    const tokens = promptTokens || estimateChatRequestTokens({ messages: usageMessages });
    this.emitTurnTokenUsage(tokens, pack, fullResponse, usageMessages, compacted);

    if (!fullResponse) return;

    this.saveTurn(session.id, 'assistant', fullResponse);
    this.deps.sessionLog?.append('assistant_message', fullResponse.slice(0, 200), {
      responseLength: fullResponse.length,
    });

    const parsed = parsePlanFromText(fullResponse);
    if (parsed) {
      this.onPlan?.(thunderPlanToView(parsed, { status: 'ready' }));
      this.deps.planPersistence?.save(session.id, parsed);
      this.deps.sessionLog?.append('plan_created', parsed.goal, {
        stepCount: parsed.steps.length,
        steps: parsed.steps.map((s) => ({ id: s.id, title: s.title, risk: s.risk })),
      });
    }

    if (isWriteAllowed(session.mode)) {
      const applyResults = await this.autoApply.applyFromResponse(fullResponse, userMessage);
      for (const result of applyResults) {
        this.emitActivity(
          result.pendingApproval ? 'approval' : result.success ? 'apply' : 'error',
          result.message,
          result.path
        );
      }
    }

    if (this.deps.memoryExtractor && this.deps.memoryConfig?.enabled) {
      const audit = this.deps.toolRuntime?.getAuditLog() ?? [];
      this.deps.memoryExtractor.extractAfterTask(
        session.id,
        userMessage,
        fullResponse,
        audit,
        this.deps.memoryConfig.summarizeAfterTask ? provider : undefined
      );
    }

  }

  private emitTurnTokenUsage(
    tokens: number,
    pack: ContextPack,
    fullResponse: string,
    usageMessages: ChatMessage[],
    compacted: ChatMessage[]
  ): void {
    this.onTokenUsage?.(
      tokens,
      pack.totalTokens,
      fullResponse,
      this.buildTokenBreakdown(usageMessages, pack, compacted),
      { final: true }
    );
    this.deps.sessionLog?.appendDebug('token_usage', 'Prompt assembly token estimate', {
      promptAssemblyTokens: tokens,
      retrievedContextTokens: pack.totalTokens,
      responseEstimateTokens: Math.ceil(fullResponse.length / 4),
    });
  }

  private buildTokenBreakdown(
    messages: ChatMessage[],
    pack: ContextPack,
    compacted: ChatMessage[]
  ): TokenUsageBreakdownItem[] {
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    const allTools = this.deps.toolRuntime?.list() ?? [];
    const builtinDefs = JSON.stringify(toolsToDefinitions(allTools.filter((t) => !t.name.startsWith('mcp__'))));
    const mcpByServer = new Map<string, typeof allTools>();
    for (const tool of allTools) {
      if (!tool.name.startsWith('mcp__')) continue;
      const server = tool.name.split('__')[1] ?? 'mcp';
      const list = mcpByServer.get(server) ?? [];
      list.push(tool);
      mcpByServer.set(server, list);
    }
    const sourceTokens = (sources: string[]) =>
      pack.items
        .filter((item) => sources.includes(item.source))
        .reduce((sum, item) => sum + item.tokenEstimate, 0);
    const fileContext = pack.items
      .filter((item) => !['project-rules', 'skills', 'memory', 'user-explicit'].includes(item.source))
      .reduce((sum, item) => sum + item.tokenEstimate, 0);
    const explicitContext = pack.items
      .filter((item) => item.source === 'user-explicit')
      .reduce((sum, item) => sum + item.tokenEstimate, 0);
    const conversation = estimatePromptTokens(compacted);

    const items: TokenUsageBreakdownItem[] = [
      { label: 'System prompt', tokens: Math.ceil(systemPrompt.length / 4), color: '#8b949e' },
      { label: 'Builtin tools', tokens: Math.ceil(builtinDefs.length / 4), color: '#a78bfa' },
      { label: 'Rules', tokens: sourceTokens(['project-rules']), color: '#4ade80' },
      { label: 'Skills', tokens: sourceTokens(['skills']), color: '#fbbf24' },
      { label: 'Memory', tokens: sourceTokens(['memory']), color: '#60a5fa' },
      { label: 'Pinned context', tokens: explicitContext, color: '#f472b6' },
      { label: 'Workspace context', tokens: fileContext, color: '#94a3b8' },
      { label: 'Conversation', tokens: conversation, color: '#64748b' },
    ];

    for (const [server, tools] of mcpByServer) {
      const defs = JSON.stringify(toolsToDefinitions(tools));
      items.push({
        label: `MCP: ${server}`,
        tokens: Math.ceil(defs.length / 4),
        color: '#c084fc',
      });
    }

    return items.filter((item) => item.tokens > 0);
  }

  private savePauseState(
    session: ThunderSession,
    originalTask: string,
    taskKind?: string
  ): string {
    const summary = this.deps.taskState?.buildPauseSummary(originalTask, taskKind) ?? '';
    if (summary) {
      this.deps.taskState?.setPauseSummary(summary);
      this.deps.memoryService?.write(session.id, 'decision', summary, undefined, ['task_state', 'approval_pause']);
      this.emitActivity('info', 'Task state saved before approval pause', summary.slice(0, 300));
    }
    return summary ? `### Task state saved\n\n${summary}` : '';
  }

  private buildLoopCallbacks(onProgress?: () => void): import('../runtime/AgentLoop').AgentLoopCallbacks {
    const lastToolInputs = new Map<string, Record<string, unknown>>();
    const sessionLog = this.deps.sessionLog;
    return {
      onToolStart: (name, input) => {
        lastToolInputs.set(name, input);
        const activity = describeToolActivity(name, input, 'start');
        this.setLiveStatus(activity.liveLabel, activity.detail);
        this.emitActivity(activity.kind, activity.message, activity.detail);
      },
      onToolEnd: (name, success, output) => {
        if (output === 'Awaiting approval') {
          this.setLiveStatus('Waiting for approval', name);
          this.emitActivity(
            'approval',
            `Waiting for approval: ${describeToolActivity(name, {}, 'start').message}`
          );
          return;
        }
        if (!success && isSkippedToolOutput(output)) {
          this.setLiveStatus('Skipped redundant tool', toolDisplayName(name));
          this.emitActivity('skipped', `${toolDisplayName(name)} skipped`, output?.slice(0, 240));
          return;
        }
        if (success && isSkippedToolOutput(output)) {
          this.setLiveStatus('Skipped redundant tool', toolDisplayName(name));
          this.emitActivity('skipped', `${toolDisplayName(name)} skipped`, output?.slice(0, 240));
          return;
        }
        if (success) {
          const input = lastToolInputs.get(name);
          if (input) void this.previewDiffIfWrite(name, input);
        }
        const activity = describeToolActivity(name, {}, success ? 'success' : 'error');
        this.emitActivity(success ? activity.kind : 'error', activity.message, output?.slice(0, 240));
      },
      onStep: (step, max) => {
        this.setLiveStatus('Agent step', `${step}/${max}`, step, max);
        onProgress?.();
      },
      onLlmStepComplete: (step, durationMs, toolCallCount) => {
        sessionLog?.appendTiming('llm_step', durationMs, { step, toolCallCount });
        sessionLog?.appendDebug('info', 'LLM step complete', { step, durationMs, toolCallCount });
      },
      onAutoContinue: (round) => {
        this.emitActivity('info', `Auto-continuing agent loop (round ${round})`);
        this.setLiveStatus('Auto-continuing', `Round ${round}`);
      },
      onPostWriteValidation: async (relPath) => {
        if (!this.deps.postEditValidator) return undefined;
        const result = await this.deps.postEditValidator.validate(relPath);
        const formatted = this.deps.postEditValidator.formatForAgent(result);
        if (result.errors.length > 0) {
          this.emitActivity('error', `Lint errors in ${relPath}`, formatted);
          await this.deps.onPostWrite?.(relPath);
        } else {
          this.emitActivity('info', `Validated ${relPath}`, 'No errors');
        }
        return { message: formatted, hasErrors: result.errors.length > 0 };
      },
    };
  }

  private async previewDiffIfWrite(name: string, input: Record<string, unknown>): Promise<void> {
    const workspace = this.deps.workspace;
    if (!workspace) return;
    if (!(this.deps.agentConfig?.showDiffPreview ?? false)) return;

    if (name === 'write_file' && typeof input.path === 'string' && typeof input.content === 'string') {
      try {
        await showWriteDiffPreview(workspace, input.path, input.content);
      } catch {
        // Non-fatal
      }
    }
    if (name === 'apply_patch' && typeof input.path === 'string' && typeof input.oldText === 'string' && typeof input.newText === 'string') {
      try {
        await showPatchDiffPreview(workspace, input.path, input.oldText, input.newText);
      } catch {
        // Non-fatal
      }
    }
  }

  hasSuspendState(): boolean {
    return Boolean(this.agentLoop?.getSuspendState() && this.suspendContext);
  }

  async *resumeAfterApproval(approved: ApprovedToolResult[]): AsyncIterable<AssistantStreamChunk> {
    if (!this.agentLoop || !this.suspendContext || approved.length === 0) return;

    const baseState = this.agentLoop.getSuspendState();
    if (!baseState) return;

    const { session, provider, userMessage } = this.suspendContext;
    const taskStateBlock = this.deps.taskState?.buildPromptBlock();
    const planningResume = this.suspendContext.planningResume;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.setLiveStatus('Resuming agent', 'Continuing after approval');
    this.emitActivity('info', 'Resuming agent loop after approval');

    const state: AgentLoopSuspendState = {
      ...baseState,
      messages: [
        ...baseState.messages,
        {
          role: 'user',
          content:
            planningResume
              ? [
                  'User answered the pending planning clarification. Resume read-only planning discovery from the approved tool result.',
                  baseState.checkpoint ? `\n## Approval checkpoint\n${baseState.checkpoint}` : '',
                  '\nContinue with only the extra read-only discovery needed, then output DISCOVERY_SUMMARY.',
                  'Do not execute edits. Do not compile the structured plan yourself; the orchestrator will compile it after discovery.',
                ].filter(Boolean).join('\n')
              : [
                  'User approved the pending tool(s). Resume the existing task state machine from the approved tool result(s).',
                  taskStateBlock ? `\n## Task progress\n${taskStateBlock}` : '',
                  baseState.checkpoint ? `\n## Approval checkpoint\n${baseState.checkpoint}` : '',
                  '\nContinue from the pending Execute/Verify step. Do not restart planning or diagnostics.',
                  'Do not re-run audit-dependencies, audit-dead-code, depcheck, knip, eslint discovery, list_files, or memory_search unless the approved result proves the prior output is stale.',
                  'If final verification reports unrelated TypeScript errors outside touched files, log them as remaining issues instead of derailing the cleanup task.',
                ].filter(Boolean).join('\n'),
        },
      ],
    };

    let fullResponse = '';
    const sharedLoopCallbacks = this.buildLoopCallbacks();

    try {
      for await (const chunk of this.agentLoop.resume(
        provider,
        state,
        approved,
        signal,
        sharedLoopCallbacks
      )) {
        if (signal.aborted) break;
        fullResponse += chunkContent(chunk);
        yield chunk;
      }

      if (this.agentLoop.hadPendingApproval()) {
        const pauseBlock = planningResume ? '' : this.savePauseState(session, userMessage);
        const approvalNote = planningResume
          ? '\n\n**Planning paused for another clarification.** Choose an option below and I will continue the plan.\n'
          : `\n\n${pauseBlock}\n\n⏸ **Waiting for your approval** — review the proposed changes above, then approve or deny in the panel below.\n`;
        fullResponse += approvalNote;
        yield approvalNote;
        this.setLiveStatus(
          planningResume ? 'Waiting for planning answer' : 'Waiting for approval',
          planningResume ? 'Choose an option below' : 'Review and approve below'
        );
        this.emitActivity(
          'approval',
          planningResume ? 'Planning paused for a clarifying question' : 'Paused — waiting for your approval',
          planningResume ? undefined : this.deps.taskState?.getPauseSummary()
        );
      } else if (planningResume) {
        const planText = await this.compilePlanAfterPlanningDiscovery(
          session,
          provider,
          planningResume.displayPack,
          planningResume.planningRequest,
          planningResume.taskAnalysis,
          [planningResume.initialPlanningDiscovery, fullResponse].filter((part) => part.trim()).join('\n\n'),
          planningResume.skillPlaybookContext,
          planningResume.appliedSkills,
          signal
        );
        fullResponse += planText;
        yield planText;
        this.suspendContext = undefined;
        this.agentLoop.clearSuspendState();
      } else {
        this.suspendContext = undefined;
        this.agentLoop.clearSuspendState();
      }

      if (fullResponse) {
        this.saveTurn(session.id, 'assistant', fullResponse);
        this.deps.sessionLog?.append('assistant_message', fullResponse.slice(0, 200), {
          responseLength: fullResponse.length,
        });
      }
    } finally {
      this.onLiveStatus?.(null);
    }
  }

  private async compilePlanAfterPlanningDiscovery(
    session: ThunderSession,
    provider: LlmProvider,
    displayPack: ContextPack,
    planningRequest: string,
    taskAnalysis: TaskAnalysis,
    planningDiscovery: string,
    skillPlaybookContext: string,
    appliedSkills: string[],
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.planExecutor) {
      return '\n\n⚠️ Planning could not resume because the plan executor is unavailable.\n';
    }

    this.setLiveStatus('Analyzing requirements');
    this.emitActivity('info', 'Analyzing requirements after clarification…');
    let requirementAnalysisText = '';
    for await (const chunk of this.planExecutor.analyzeRequirementsStream(
      provider,
      displayPack,
      planningRequest,
      taskAnalysis,
      skillPlaybookContext,
      (text) => {
        requirementAnalysisText = text;
        this.onPlan?.({
          goal: planningRequest.slice(0, 240),
          assumptions: [],
          steps: [],
          status: 'planning',
          requirementAnalysis: text,
          appliedSkills,
        });
      }
    )) {
      if (signal?.aborted) break;
      void chunk;
    }

    if (signal?.aborted) return '';

    this.setLiveStatus('Creating plan');
    this.emitActivity('info', 'Creating plan from clarified requirements…');
    const requirementAnalysis = requirementAnalysisText.trim();
    const plan = await this.planExecutor.generatePlan(
      provider,
      session.mode,
      displayPack,
      planningRequest,
      requirementAnalysis,
      planningDiscovery,
      taskAnalysis,
      session.id,
      {
        workspace: this.deps.workspace,
        useIsolatedPlanning: true,
        skillPlaybookContext,
      }
    );

    if (plan && plan.steps.length >= 1) {
      const planView = thunderPlanToView(plan, {
        status: 'ready',
        requirementAnalysis: requirementAnalysis || undefined,
        appliedSkills,
      });
      this.onPlan?.(planView);
      this.deps.planPersistence?.save(session.id, plan);
      this.deps.sessionLog?.append('plan_created', plan.goal, {
        stepCount: plan.steps.length,
        steps: plan.steps.map((s) => ({ id: s.id, title: s.title, risk: s.risk, phase: s.phase })),
        appliedSkills,
        resumedAfterClarification: true,
      });
      this.emitActivity('info', 'Plan ready — switch to Agent mode to execute steps');
      return formatPlanModeChatSummary(planView);
    }

    this.emitActivity('error', 'Planning failed quality gate after clarification');
    return '\n\n⚠️ I could not produce a plan that passed the planning quality gate after the clarification. Please retry with a little more scope detail.\n';
  }

  stop(): void {
    this.abortController?.abort();
  }

  private saveTurn(sessionId: string, role: string, content: string): void {
    if (this.deps.sessionService) {
      this.deps.sessionService.saveTurn(sessionId, role, content);
      return;
    }
    if (!this.db) return;
    const raw = this.db.tryRaw();
    if (!raw) return;
    try {
      raw.prepare(`
        INSERT INTO agent_turns (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), sessionId, role, content, Date.now());
    } catch {
      // Session may not exist in DB yet
    }
  }
}

function describeToolActivity(
  name: string,
  input: Record<string, unknown>,
  phase: 'start' | 'success' | 'error'
): {
  kind: import('../../vscode/webview/messages').AgentActivityEntry['kind'];
  liveLabel: string;
  message: string;
  detail?: string;
} {
  const path = typeof input.path === 'string' ? input.path : undefined;
  const command = typeof input.command === 'string' ? input.command : undefined;
  const query = typeof input.query === 'string' ? input.query : undefined;
  const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string') : [];
  const queries = Array.isArray(input.queries) ? input.queries.filter((q): q is string => typeof q === 'string') : [];

  if (phase !== 'start') {
    return {
      kind: name.includes('write') || name.includes('patch') ? 'apply' : 'read',
      liveLabel: phase === 'success' ? 'Completed tool' : 'Tool failed',
      message: `${toolDisplayName(name)} ${phase === 'success' ? 'completed' : 'failed'}`,
    };
  }

  switch (name) {
    case 'read_file':
      return { kind: 'read', liveLabel: 'Reading file', message: `Reading ${path ?? 'a file'}`, detail: path };
    case 'read_files':
      return {
        kind: 'read',
        liveLabel: 'Reading files',
        message: `Reading ${paths.length || 'multiple'} files`,
        detail: paths.slice(0, 6).join('\n'),
      };
    case 'list_files':
      return { kind: 'read', liveLabel: 'Listing files', message: `Listing ${path ?? 'workspace files'}`, detail: path };
    case 'search':
      return { kind: 'read', liveLabel: 'Searching code', message: `Searching for ${query ?? 'matches'}`, detail: query };
    case 'search_batch':
      return {
        kind: 'read',
        liveLabel: 'Searching code',
        message: `Searching ${queries.length || 'multiple'} queries`,
        detail: queries.slice(0, 6).join('\n'),
      };
    case 'run_command':
      return { kind: 'tool', liveLabel: 'Running command', message: `Running ${command ?? 'command'}`, detail: command };
    case 'write_file':
      return { kind: 'apply', liveLabel: 'Writing file', message: `Writing ${path ?? 'file'}`, detail: path };
    case 'apply_patch':
      return { kind: 'apply', liveLabel: 'Applying patch', message: `Patching ${path ?? 'file'}`, detail: path };
    case 'spawn_research_agent':
      return {
        kind: 'tool',
        liveLabel: 'Starting subagent',
        message: 'Starting research subagent',
        detail: typeof input.task === 'string' ? input.task.slice(0, 180) : undefined,
      };
    case 'retrieve_context':
      return { kind: 'context', liveLabel: 'Retrieving context', message: 'Retrieving relevant context' };
    case 'diagnostics':
      return { kind: 'read', liveLabel: 'Checking diagnostics', message: 'Checking editor diagnostics' };
    case 'git_diff':
      return { kind: 'read', liveLabel: 'Reading changes', message: 'Reading current git diff' };
    default:
      return {
        kind: 'tool',
        liveLabel: toolDisplayName(name),
        message: `Using ${toolDisplayName(name)}`,
        detail: JSON.stringify(input).slice(0, 180),
      };
  }
}

function toolDisplayName(name: string): string {
  return name.replace(/_/g, ' ');
}

export { isSkippedToolOutput } from '../runtime/toolSkip';

function uniqueContextNames(items: Array<{ relPath?: string; source: string }>): string[] {
  return Array.from(new Set(items.map((item) => item.relPath ?? item.source)));
}

function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  const serialized = messages.map((m) => `${m.role}\n${m.content}`).join('\n\n');
  return Math.ceil(serialized.length / 4);
}

function extractRequirementAnalysis(fullResponse: string): string {
  const marker = '## Requirement analysis';
  const start = fullResponse.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = fullResponse.indexOf('\n', start);
  if (bodyStart === -1) return '';
  const rest = fullResponse.slice(bodyStart + 1);
  const nextHeading = rest.search(/\n## /);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

function formatPlanHeader(plan: import('../plans/PlanActEngine').ThunderPlan): string {
  return `## Plan: ${plan.goal}\n\n${plan.steps.length} validated steps to execute.\n\n`;
}

function formatPlanModeChatSummary(plan: PlanView): string {
  const stepCount = plan.steps.length;
  const skillNote = plan.appliedSkills?.length
    ? `\n\nSkills applied: ${plan.appliedSkills.join(', ')}`
    : '';
  return [
    `## Plan ready`,
    '',
    `**${plan.goal}**`,
    '',
    `${stepCount} step${stepCount === 1 ? '' : 's'} compiled in the **Planner** panel above — requirement analysis, phased steps, tools, and success criteria are shown there.`,
    skillNote,
    '',
    '---',
    '*Switch to **Agent** mode and ask to execute this plan when ready.*',
  ].join('\n');
}

export { filterDirectAgentTools } from '../tools/toolAliases';

export function shouldRunDirectFinalValidation(
  taskKind: ReturnType<typeof analyzeTask>['kind'],
  touchedFiles: string[] = []
): boolean {
  if (taskKind === 'question') return false;
  if (taskKind === 'simple_edit') return touchesDocs(touchedFiles);
  return true;
}

function shouldUsePlanner(
  mode: ThunderSession['mode'],
  taskAnalysis: ReturnType<typeof analyzeTask>,
  orchestrationEnabled: boolean,
  auditMode = false
): boolean {
  // Plan mode always uses the structured planner when the route requires a plan.
  if (mode === 'plan') return taskAnalysis.shouldPlan;
  if (mode === 'agent') return shouldUsePlannerForAct(taskAnalysis, orchestrationEnabled, auditMode);
  return false;
}

export { shouldUsePlanner };

export function shouldExecuteSavedPlan(
  mode: ThunderSession['mode'],
  userMessage: string,
  hasActivePlan: boolean
): boolean {
  return mode === 'agent' && shouldResumeSavedPlan(userMessage, hasActivePlan);
}

function getTouchedFilesFromAudit(toolRuntime?: ToolRuntime): string[] {
  const audit = toolRuntime?.getAuditLog() ?? [];
  const files = new Set<string>();
  for (const { toolName, input, result } of audit) {
    if (!result.success || !['write_file', 'apply_patch'].includes(toolName)) continue;
    const path = (input as Record<string, unknown>).path;
    if (typeof path === 'string') files.add(path);
  }
  return [...files];
}

function touchesDocs(files: string[]): boolean {
  return files.some((file) =>
    /(?:^|\/)(?:apps\/docs|docs)\/.+\.(?:mdx?|tsx?|jsx?)$/i.test(file) ||
    /\.(?:mdx?)$/i.test(file)
  );
}

function mergePromptContexts(...blocks: Array<string | undefined>): string | undefined {
  const merged = blocks
    .map((block) => block?.trim())
    .filter((block): block is string => Boolean(block));
  if (merged.length === 0) return undefined;
  return [...new Set(merged)].join('\n\n---\n\n');
}

export function contextPackToBudgetView(pack: ContextPack): ContextBudgetView {
  const sourceMap = new Map<string, { tokens: number; count: number }>();
  for (const item of pack.items) {
    const entry = sourceMap.get(item.source) ?? { tokens: 0, count: 0 };
    entry.tokens += item.tokenEstimate;
    entry.count += 1;
    sourceMap.set(item.source, entry);
  }

  return {
    retrievedCount: pack.retrievedCount,
    includedCount: pack.items.length,
    budgetLimit: pack.budgetLimit,
    usedTokens: pack.totalTokens,
    truncatedCount: pack.truncatedCount,
    dropped: pack.dropped.map((d) => ({
      source: d.source,
      relPath: d.relPath,
      reason: d.reason,
      tokenEstimate: d.tokenEstimate,
      cause: d.cause,
    })),
    sourceBreakdown: [...sourceMap.entries()]
      .map(([source, stats]) => ({ source, tokens: stats.tokens, count: stats.count }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

export function contextItemsToViews(items: ContextItem[]): ContextItemView[] {
  return items.map((item) => ({
    id: item.id,
    source: item.source,
    relPath: item.relPath,
    reason: item.reason,
    tokenEstimate: item.tokenEstimate,
    preview: item.content.slice(0, 300),
    truncated: item.reason.includes('truncated'),
  }));
}
