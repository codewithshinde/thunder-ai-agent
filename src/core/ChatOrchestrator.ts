import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { ThunderDb } from './indexing/ThunderDb';
import type { LlmProvider, ChatMessage } from './llm/types';
import type { ThunderSession } from './ThunderSession';
import type { ContextItem, ContextPack } from './context/types';
import type {
  ContextItemView,
  PlanView,
  AgentActivityEntry,
  ContextBudgetView,
  AgentLiveStatusView,
  TokenUsageBreakdownItem,
} from '../vscode/webview/messages';
import { HybridRetriever } from './context/HybridRetriever';
import { ContextBudgeter } from './context/ContextBudgeter';
import { UserExplicitContextBuilder, type PinnedContextEntry } from './context/UserExplicitContextBuilder';
import { buildPrompt } from './planning/promptBuilder';
import { parsePlanFromText, isWriteAllowed } from './planning/PlanActEngine';
import { createLogger } from './telemetry/Logger';
import type { SessionLogService } from './telemetry/SessionLogService';
import { SessionTiming } from './telemetry/SessionTiming';
import { extractFileMentions } from './context/fuzzyFileMatch';
import { AutoApplyService } from './apply/AutoApplyService';
import type { ToolExecutor } from './safety/ToolExecutor';
import type { ToolRuntime } from './tools/ToolRuntime';
import { toolsToDefinitions } from './tools/toolSchema';
import { AgentLoop, type ApprovedToolResult, type AgentLoopSuspendState } from './agent/AgentLoop';
import { PlanExecutor } from './agent/PlanExecutor';
import { analyzeTask } from './agent/TaskAnalyzer';
import { extractOriginalTaskMessage, isApprovalContinuationMessage } from './agent/taskMessage';
import { compactMessagesWithLlm } from './agent/ContextCompaction';
import { isAuditCleanupTask, AUDIT_AGENT_MAX_STEPS } from './agent/taskKind';
import { setResearchAgentRuntime } from './tools/builtinTools';
import type { SessionService } from './session/SessionService';
import type { PlanPersistence } from './planning/PlanPersistence';
import type { MemoryExtractor } from './agent/MemoryExtractor';
import type { AgentConfig, MemoryConfig } from './config/schema';
import type { PassiveMemoryInjector } from './memory/PassiveMemoryInjector';
import type { MemoryHookService } from './memory/MemoryHookService';
import type { MemoryService } from './memory/MemoryService';
import type { AgentTaskState } from './agent/AgentTaskState';
import type { PostEditValidator } from './apply/PostEditValidator';
import { showWriteDiffPreview, showPatchDiffPreview } from '../vscode/diffPreview';
import { toWorkspaceRelPath } from './vscode/pathUtils';

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
  } | undefined;

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
        deps.postEditValidator
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
  ): AsyncIterable<string> {
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
    const currentFile = editor && ws
      ? toWorkspaceRelPath(editor.document.uri, ws) ?? undefined
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
              if (rel) openFiles.push(rel);
            }
          }
        }
      }
    }

    this.setLiveStatus('Gathering context');
    this.emitActivity('context', 'Retrieving workspace context…', extractFileMentions(userMessage).join(', ') || undefined);

    const pinnedContext = options?.pinnedContext ?? [];
    const explicitBuilder = new UserExplicitContextBuilder(this.db, ws);
    const explicitResult = explicitBuilder.build(pinnedContext);
    if (explicitResult.items.length > 0) {
      this.emitActivity(
        'context',
        `User-pinned context: ${explicitResult.items.length} item(s) · ${explicitResult.totalTokens} tokens`,
        pinnedContext.map((p) => p.path).join(', ')
      );
    }

    let items;
    sessionTiming.start('context_retrieval');
    try {
      items = await this.retriever.retrieve({
        text: userMessage,
        currentFile,
        openFiles,
        pinnedContext: pinnedContext.map((p) => ({ path: p.path, kind: p.kind })),
        maxItems: 28,
      });
    } catch (error) {
      sessionTiming.end('context_retrieval', sessionLog, { success: false });
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Context retrieval failed', { error: msg });
      this.emitActivity('error', 'Context retrieval failed', msg);
      throw error;
    }
    sessionTiming.end('context_retrieval', sessionLog, {
      success: true,
      itemCount: items.length,
    });

    const retrievedPaths = uniqueContextNames(items);
    this.emitActivity(
      'read',
      `Prepared ${items.length} context snippets from ${retrievedPaths.length} sources`,
      retrievedPaths.slice(0, 8).join('\n')
    );

    const contextBudget = Math.floor(provider.capabilities.contextWindow * 0.75);
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

    const transcriptBudget = Math.floor(provider.capabilities.contextWindow * 0.15);
    sessionTiming.start('context_compaction');
    const compacted = await compactMessagesWithLlm(recentMessages, transcriptBudget, provider);
    sessionTiming.end('context_compaction', sessionLog, {
      before: recentMessages.length,
      after: compacted.length,
    });
    if (compacted.length < recentMessages.length) {
      this.emitActivity('info', `Compacted ${recentMessages.length - compacted.length} older messages`);
    }

    const hookInjection = this.deps.memoryHookService
      ? await this.deps.memoryHookService.onUserPromptSubmit(session.id, userMessage)
      : undefined;
    const passiveMemories = this.deps.passiveMemoryInjector?.inject(userMessage, session.id) ?? [];
    if (passiveMemories.length > 0) {
      pack.items.push(...passiveMemories);
      this.emitActivity('info', `Injected ${passiveMemories.length} passive memories`);
    }
    if (hookInjection) {
      pack.items.push({
        id: 'hook-user-prompt',
        source: 'memory',
        content: hookInjection,
        score: 5,
        reason: 'UserPromptSubmit hook',
        tokenEstimate: Math.ceil(hookInjection.length / 4),
      });
      this.emitActivity('info', 'UserPromptSubmit hook injected context');
    }

    const toolsEnabled = provider.capabilities.supportsTools
      && Boolean(this.deps.toolRuntime && this.deps.toolExecutor && this.agentLoop);
    const agentConfig = this.deps.agentConfig;
    const taskForClassification = extractOriginalTaskMessage(userMessage) ?? userMessage;
    const auditMode = isAuditCleanupTask(taskForClassification);
    const taskAnalysis = analyzeTask(userMessage, session.mode);
    const isResume = isApprovalContinuationMessage(userMessage);
    if (!isResume) {
      this.suspendContext = undefined;
      this.agentLoop?.clearSuspendState();
    }
    const orchestrationEnabled = agentConfig?.orchestrationEnabled ?? true;
    const plannerEnabled = shouldUsePlanner(session.mode, taskAnalysis, orchestrationEnabled, auditMode);
    const subagentsEnabled =
      (agentConfig?.subagentsEnabled ?? true) &&
      !auditMode &&
      taskAnalysis.shouldUseSubagents;
    const tools = toolsEnabled
      ? toolsToDefinitions(this.deps.toolRuntime!.list()).filter((tool) =>
          subagentsEnabled || tool.function.name !== 'spawn_research_agent'
        )
      : [];

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
    } else if (isResume) {
      this.emitActivity('info', 'Resuming after approval — continuing execution');
    } else if (plannerEnabled) {
      this.emitActivity('info', `Orchestration: ${taskAnalysis.kind} (${taskAnalysis.complexity})`, taskAnalysis.summary);
    } else if (orchestrationEnabled && taskAnalysis.shouldPlan && session.mode === 'act') {
      this.emitActivity('info', 'Fast Act mode — sending directly to the tool-using agent', taskAnalysis.summary);
    }
    this.deps.sessionLog?.append('info', 'Task analysis', {
      kind: taskAnalysis.kind,
      complexity: taskAnalysis.complexity,
      shouldPlan: taskAnalysis.shouldPlan,
      plannerEnabled,
      shouldUseSubagents: subagentsEnabled,
      auditMode,
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
    livePromptTokens = displayPack.totalTokens + Math.ceil(userMessage.length / 4);
    livePromptMessages = [{ role: 'user', content: userMessage }];
    emitLiveTokenUsage();
    const sharedLoopCallbacks = this.buildLoopCallbacks(emitLiveTokenUsage);
    const sharedPlanOptions = {
      stepMaxRetries: agentConfig?.stepMaxRetries,
      finalValidationEnabled: agentConfig?.finalValidationEnabled,
      agentMaxSteps: agentConfig?.maxSteps,
      restrictRunCommandToReadOnly: auditMode,
      workspace: this.deps.workspace,
      sessionLog,
    };

    try {
      const activePlan = this.deps.planPersistence?.getActive(session.id);
      if (
        !isApprovalContinuationMessage(userMessage) &&
        shouldExecuteSavedPlan(session.mode, userMessage, Boolean(activePlan?.plan)) &&
        this.planExecutor &&
        activePlan
      ) {
        const plan = activePlan.plan;
        this.onPlan?.({ goal: plan.goal, assumptions: plan.assumptions, steps: plan.steps });
        this.setLiveStatus('Executing saved plan', plan.goal, 1, plan.steps.length);
        this.emitActivity('info', `Resuming saved plan (${plan.steps.length} steps)…`);
        sessionTiming.start('plan_execution');

        for await (const chunk of this.planExecutor.executePlan(
          session,
          provider,
          plan,
          displayPack,
          tools,
          (updated) => this.onPlan?.({ goal: updated.goal, assumptions: updated.assumptions, steps: updated.steps }),
          signal,
          sharedLoopCallbacks,
          sharedPlanOptions
        )) {
          if (signal.aborted) break;
          fullResponse += chunk;
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
        let planningDiscovery = '';

        if (toolsEnabled) {
          this.setLiveStatus('Planning discovery');
          this.emitActivity('info', 'Running read-only planning discovery…');
          sessionTiming.start('planning_discovery');
          try {
            planningDiscovery = await this.planExecutor.runPlanningDiscovery(
              provider,
              session.mode,
              displayPack,
              userMessage,
              taskAnalysis,
              tools,
              signal,
              sharedLoopCallbacks,
              {
                agentMaxSteps: auditMode ? Math.min(agentConfig?.maxSteps ?? 10, 12) : Math.min(agentConfig?.maxSteps ?? 6, 8),
                restrictRunCommandToReadOnly: true,
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
        }

        this.setLiveStatus('Analyzing requirements');
        this.emitActivity('info', 'Analyzing requirements…');
        sessionTiming.start('requirement_analysis');

        const requirementHeader = '## Requirement analysis\n\n';
        yield requirementHeader;
        fullResponse += requirementHeader;

        for await (const chunk of this.planExecutor.analyzeRequirementsStream(
          provider,
          displayPack,
          userMessage,
          taskAnalysis
        )) {
          if (signal.aborted) break;
          fullResponse += chunk;
          yield chunk;
        }
        yield '\n\n';
        fullResponse += '\n\n';
        sessionTiming.end('requirement_analysis', sessionLog);

        this.setLiveStatus('Creating plan');
        this.emitActivity('info', 'Planning multi-step task…');
        sessionTiming.start('plan_generation');

        const requirementAnalysis = extractRequirementAnalysis(fullResponse);

        const plan = await this.planExecutor.generatePlan(
          provider,
          session.mode,
          displayPack,
          userMessage,
          requirementAnalysis,
          planningDiscovery,
          taskAnalysis,
          session.id,
          {
            workspace: this.deps.workspace,
            useIsolatedPlanning: true,
          }
        );
        sessionTiming.end('plan_generation', sessionLog, {
          success: Boolean(plan),
          stepCount: plan?.steps.length ?? 0,
        });
        if (plan && plan.steps.length >= 1) {
          this.onPlan?.({ goal: plan.goal, assumptions: plan.assumptions, steps: plan.steps });
          this.deps.planPersistence?.save(session.id, plan);
          this.deps.sessionLog?.append('plan_created', plan.goal, {
            stepCount: plan.steps.length,
            steps: plan.steps.map((s) => ({ id: s.id, title: s.title, risk: s.risk, phase: s.phase })),
          });

          if (session.mode === 'act') {
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
                this.onPlan?.({
                  goal: updated.goal,
                  assumptions: updated.assumptions,
                  steps: updated.steps,
                });
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
              fullResponse += chunk;
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
            const planText = formatPlanAsResponse(plan);
            fullResponse = planText;
            yield planText;
            this.emitActivity('info', 'Plan ready — switch to Act mode to execute steps');
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
        taskStateBlock,
        isResume,
        explicitResult.formatted || undefined
      );
      const promptTokens = estimatePromptTokens(messages);
      livePromptTokens = promptTokens;
      livePromptMessages = messages;
      liveExplicitContextBlock = explicitResult.formatted || undefined;
      emitLiveTokenUsage();

      if (toolsEnabled && this.agentLoop) {
        this.setLiveStatus('Agent running');
        this.emitActivity('info', auditMode ? 'Scanning project with tools…' : 'Agent loop started');
        sessionTiming.start('direct_agent');

        for await (const chunk of this.agentLoop.run(
          provider,
          messages,
          tools,
          signal,
          sharedLoopCallbacks,
          {
            auditMode,
            maxSteps: auditMode ? AUDIT_AGENT_MAX_STEPS : agentConfig?.maxSteps,
            autoContinue: agentConfig?.autoContinue ?? true,
            maxAutoContinues: agentConfig?.maxAutoContinues,
          }
        )) {
          if (signal.aborted) break;
          fullResponse += chunk;
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
        } else if (
          orchestrationEnabled &&
          taskAnalysis.shouldVerify &&
          session.mode === 'act' &&
          this.planExecutor &&
          !signal.aborted
        ) {
          this.setLiveStatus('Final validation');
          this.emitActivity('info', 'Running post-task validation…');
          yield '\n\n### Post-task validation\n\n';

          const validationPlan = {
            goal: userMessage.slice(0, 200),
            assumptions: [] as string[],
            steps: [] as import('./planning/PlanActEngine').ThunderPlan['steps'],
            requiredApprovals: [] as string[],
          };

          for await (const chunk of this.planExecutor.runFinalValidation(
            session,
            provider,
            validationPlan,
            displayPack,
            tools,
            signal,
            sharedLoopCallbacks,
            {
              agentMaxSteps: Math.min(agentConfig?.maxSteps ?? 10, 10),
              restrictRunCommandToReadOnly: auditMode,
            }
          )) {
            if (signal.aborted) break;
            fullResponse += chunk;
            emitLiveTokenUsage();
            yield chunk;
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
            yield delta.content;
          }
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
    if (!fullResponse) return;

    this.saveTurn(session.id, 'assistant', fullResponse);
    this.deps.sessionLog?.append('assistant_message', fullResponse.slice(0, 200), {
      responseLength: fullResponse.length,
    });

    const parsed = parsePlanFromText(fullResponse);
    if (parsed) {
      this.onPlan?.({ goal: parsed.goal, assumptions: parsed.assumptions, steps: parsed.steps });
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
      await this.deps.memoryExtractor.extractAfterTask(
        session.id,
        userMessage,
        fullResponse,
        audit,
        this.deps.memoryConfig.summarizeAfterTask ? provider : undefined
      );
    }

    const usageMessages =
      promptMessages ??
      buildPrompt(session.mode, pack, userMessage, compacted, false, false, undefined, false, explicitContextBlock);
    const tokens = promptTokens || estimatePromptTokens(usageMessages);
    this.onTokenUsage?.(
      tokens,
      pack.totalTokens,
      fullResponse,
      this.buildTokenBreakdown(usageMessages, pack, compacted),
      { final: true }
    );
    this.deps.sessionLog?.append('token_usage', 'Turn token usage', {
      promptTokens: tokens,
      contextTokens: pack.totalTokens,
      responseTokens: Math.ceil(fullResponse.length / 4),
    });
  }

  private buildTokenBreakdown(
    messages: ChatMessage[],
    pack: ContextPack,
    compacted: ChatMessage[]
  ): TokenUsageBreakdownItem[] {
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    const tools = this.deps.toolRuntime
      ? JSON.stringify(toolsToDefinitions(this.deps.toolRuntime.list()))
      : '';
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

    return [
      { label: 'System prompt', tokens: Math.ceil(systemPrompt.length / 4), color: '#8b949e' },
      { label: 'Tool definitions', tokens: Math.ceil(tools.length / 4), color: '#a78bfa' },
      { label: 'Rules', tokens: sourceTokens(['project-rules']), color: '#4ade80' },
      { label: 'Skills', tokens: sourceTokens(['skills']), color: '#fbbf24' },
      { label: 'Memory', tokens: sourceTokens(['memory']), color: '#60a5fa' },
      { label: 'Pinned context', tokens: explicitContext, color: '#f472b6' },
      { label: 'Workspace context', tokens: fileContext, color: '#94a3b8' },
      { label: 'Conversation', tokens: conversation, color: '#64748b' },
    ].filter((item) => item.tokens > 0);
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

  private buildLoopCallbacks(onProgress?: () => void): import('./agent/AgentLoop').AgentLoopCallbacks {
    const lastToolInputs = new Map<string, Record<string, unknown>>();
    const sessionLog = this.deps.sessionLog;
    return {
      onToolStart: (name, input) => {
        lastToolInputs.set(name, input);
        sessionLog?.append('tool_start', name, {
          tool: name,
          path: typeof input.path === 'string' ? input.path : undefined,
        });
        sessionLog?.appendDebug('tool_start', name, { input });
        void this.previewDiffIfWrite(name, input);
        const activity = describeToolActivity(name, input, 'start');
        this.setLiveStatus(activity.liveLabel, activity.detail);
        this.emitActivity(activity.kind, activity.message, activity.detail);
      },
      onToolEnd: (name, success, output, durationMs) => {
        sessionLog?.append('tool_end', name, {
          success,
          durationMs,
          outputPreview: output?.slice(0, 500),
        });
        if (output === 'Awaiting approval') {
          this.setLiveStatus('Waiting for approval', name);
          this.emitActivity(
            'approval',
            `Waiting for approval: ${describeToolActivity(name, {}, 'start').message}`
          );
          return;
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
        return formatted;
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

  async *resumeAfterApproval(approved: ApprovedToolResult[]): AsyncIterable<string> {
    if (!this.agentLoop || !this.suspendContext || approved.length === 0) return;

    const baseState = this.agentLoop.getSuspendState();
    if (!baseState) return;

    const { session, provider, userMessage } = this.suspendContext;
    const taskStateBlock = this.deps.taskState?.buildPromptBlock();

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
            [
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
        fullResponse += chunk;
        yield chunk;
      }

      if (this.agentLoop.hadPendingApproval()) {
        const pauseBlock = this.savePauseState(session, userMessage);
        const approvalNote =
          `\n\n${pauseBlock}\n\n⏸ **Waiting for your approval** — review the proposed changes above, then approve or deny in the panel below.\n`;
        fullResponse += approvalNote;
        yield approvalNote;
        this.setLiveStatus('Waiting for approval', 'Review and approve below');
        this.emitActivity('approval', 'Paused — waiting for your approval', this.deps.taskState?.getPauseSummary());
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
  kind: import('../vscode/webview/messages').AgentActivityEntry['kind'];
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

function formatPlanHeader(plan: import('./planning/PlanActEngine').ThunderPlan): string {
  return `## Plan: ${plan.goal}\n\n${plan.steps.length} validated steps to execute.\n\n`;
}

function formatPlanAsResponse(plan: import('./planning/PlanActEngine').ThunderPlan): string {
  const lines = [
    `## ${plan.goal}`,
    '',
    '### Recommended steps',
  ];

  for (const [i, step] of plan.steps.entries()) {
    lines.push(`${i + 1}. **${step.title}** (${step.risk} risk${step.phase ? `, ${step.phase}` : ''})`);
    if (step.objective) lines.push(`   Objective: ${step.objective}`);
    if (step.files?.length) lines.push(`   Files: \`${step.files.join('`, `')}\``);
    if (step.tools?.length) lines.push(`   Tools: ${step.tools.join(', ')}`);
    if (step.successCriteria?.length) lines.push(`   Success: ${step.successCriteria.join('; ')}`);
  }

  if (plan.assumptions.length > 0) {
    lines.push('', '### Assumptions', ...plan.assumptions.map((a) => `- ${a}`));
  }
  if (plan.requiredApprovals.length > 0) {
    lines.push('', '### Required approvals', ...plan.requiredApprovals.map((a) => `- ${a}`));
  }
  lines.push('', '---', '*Switch to **Act** mode and ask to execute this plan when ready.*');
  return lines.join('\n');
}

function shouldUsePlanner(
  mode: ThunderSession['mode'],
  taskAnalysis: ReturnType<typeof analyzeTask>,
  orchestrationEnabled: boolean,
  auditMode = false
): boolean {
  if (!orchestrationEnabled || !taskAnalysis.shouldPlan) return false;
  // Audit in Act mode: script-first direct path — skip 9-step planner overhead
  if (auditMode && mode === 'act') return false;
  return mode === 'plan' || mode === 'act';
}

export { shouldUsePlanner };

function shouldExecuteSavedPlan(
  mode: ThunderSession['mode'],
  userMessage: string,
  hasActivePlan: boolean
): boolean {
  if (mode !== 'act' || !hasActivePlan) return false;
  const lower = userMessage.toLowerCase();
  return /\b(execute|run|start|continue|resume)\b.*\bplan\b/.test(lower)
    || /\bplan\b.*\b(execute|run|start|continue|resume)\b/.test(lower)
    || lower.includes('execute this plan')
    || lower.includes('run the plan');
}

export function contextPackToBudgetView(pack: ContextPack): ContextBudgetView {
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
