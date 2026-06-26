import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { ThunderDb } from './indexing/ThunderDb';
import type { LlmProvider, ChatMessage } from './llm/types';
import type { ThunderSession } from './ThunderSession';
import type { ContextItem, ContextPack } from './context/types';
import type { ContextItemView, PlanView, AgentActivityEntry, ContextBudgetView, AgentLiveStatusView } from '../vscode/webview/messages';
import { HybridRetriever } from './context/HybridRetriever';
import { ContextBudgeter } from './context/ContextBudgeter';
import { buildPrompt } from './planning/promptBuilder';
import { parsePlanFromText, isWriteAllowed } from './planning/PlanActEngine';
import { createLogger } from './telemetry/Logger';
import { extractFileMentions } from './context/fuzzyFileMatch';
import { AutoApplyService } from './apply/AutoApplyService';
import type { ToolExecutor } from './safety/ToolExecutor';
import type { ToolRuntime } from './tools/ToolRuntime';
import { toolsToDefinitions } from './tools/toolSchema';
import { AgentLoop } from './agent/AgentLoop';
import { PlanExecutor, shouldDecomposeTask } from './agent/PlanExecutor';
import { compactMessagesWithLlm } from './agent/ContextCompaction';
import { isAuditCleanupTask, AUDIT_AGENT_MAX_STEPS } from './agent/taskKind';
import { setResearchAgentRuntime } from './tools/builtinTools';
import type { SessionService } from './session/SessionService';
import type { PlanPersistence } from './planning/PlanPersistence';
import type { MemoryExtractor } from './agent/MemoryExtractor';
import type { MemoryConfig } from './config/schema';
import type { PassiveMemoryInjector } from './memory/PassiveMemoryInjector';
import type { MemoryHookService } from './memory/MemoryHookService';
import type { PostEditValidator } from './apply/PostEditValidator';
import { showWriteDiffPreview, showPatchDiffPreview } from '../vscode/diffPreview';
import { toWorkspaceRelPath } from './vscode/pathUtils';

const log = createLogger('ChatOrchestrator');

export type ContextPackCallback = (pack: ContextPack, views: ContextItemView[], budget: ContextBudgetView) => void;
export type PlanCallback = (plan: PlanView | null) => void;
export type ActivityCallback = (entry: AgentActivityEntry) => void;
export type LiveStatusCallback = (status: AgentLiveStatusView | null) => void;
export type TokenUsageCallback = (promptTokens: number, contextTokens: number, responseText: string) => void;

export interface ChatOrchestratorDeps {
  toolRuntime?: ToolRuntime;
  toolExecutor?: ToolExecutor;
  sessionService?: SessionService;
  planPersistence?: PlanPersistence;
  memoryExtractor?: MemoryExtractor;
  memoryConfig?: MemoryConfig;
  passiveMemoryInjector?: PassiveMemoryInjector;
  memoryHookService?: MemoryHookService;
  postEditValidator?: PostEditValidator;
  onPostWrite?: (relPath: string) => Promise<void>;
  workspace?: string;
  onDiffPreview?: (path: string, content: string) => Promise<void>;
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
      this.planExecutor = new PlanExecutor(this.agentLoop, deps.planPersistence);
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
    recentMessages: ChatMessage[] = []
  ): AsyncIterable<string> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.setLiveStatus('Starting', `Mode: ${session.mode}`);
    this.emitActivity('info', `Mode: ${session.mode} · Provider: ${provider.id}`);

    this.deps.sessionService?.ensureSession(session, userMessage.slice(0, 64));

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

    let items;
    try {
      items = await this.retriever.retrieve({
        text: userMessage,
        currentFile,
        openFiles,
        maxItems: 40,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Context retrieval failed', { error: msg });
      this.emitActivity('error', 'Context retrieval failed', msg);
      throw error;
    }

    this.emitActivity(
      'read',
      `Retrieved ${items.length} context items`,
      items.slice(0, 6).map((i) => i.relPath ?? i.source).join(', ')
    );

    const contextBudget = Math.floor(provider.capabilities.contextWindow * 0.75);
    const pack = this.budgeter.budget(items, contextBudget);
    const views = contextItemsToViews(pack.items);
    const budgetView = contextPackToBudgetView(pack);

    this.setLiveStatus('Context ready', `${pack.items.length} items · ${pack.totalTokens} tokens`);

    this.onContextPack?.(pack, views, budgetView);

    this.emitActivity(
      'budget',
      `Context: ${pack.totalTokens}/${pack.budgetLimit} tokens · ${pack.items.length} items`,
      pack.dropped.length > 0 ? `${pack.dropped.length} dropped` : undefined
    );

    const transcriptBudget = Math.floor(provider.capabilities.contextWindow * 0.15);
    const compacted = await compactMessagesWithLlm(recentMessages, transcriptBudget, provider);
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
    const tools = toolsEnabled
      ? toolsToDefinitions(this.deps.toolRuntime!.list())
      : [];
    const auditMode = isAuditCleanupTask(userMessage);

    if (toolsEnabled && this.deps.toolExecutor) {
      setResearchAgentRuntime({
        toolExecutor: this.deps.toolExecutor,
        getProvider: () => provider,
        getTools: () => tools,
      });
    } else {
      setResearchAgentRuntime(undefined);
    }

    if (auditMode) {
      this.emitActivity('info', 'Audit mode — using tools to scan project');
    }

    this.saveTurn(session.id, 'user', userMessage);

    let fullResponse = '';

    try {
      if (toolsEnabled && this.planExecutor && shouldDecomposeTask(userMessage, session.mode)) {
        this.setLiveStatus('Creating plan');
        this.emitActivity('info', 'Planning multi-step task…');

        const plan = await this.planExecutor.generatePlan(provider, session.mode, pack, userMessage);
        if (plan && plan.steps.length > 1) {
          this.onPlan?.({ goal: plan.goal, assumptions: plan.assumptions, steps: plan.steps });

          if (session.mode === 'act') {
            this.setLiveStatus('Executing plan', plan.goal, 1, plan.steps.length);
            this.emitActivity('info', `Executing ${plan.steps.length} steps…`);
            yield formatPlanHeader(plan);

            for await (const chunk of this.planExecutor.executePlan(
              session,
              provider,
              plan,
              pack,
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
              {
                onToolStart: (name, input) => {
                  void this.previewDiffIfWrite(name, input);
                  this.setLiveStatus(`Tool: ${name}`);
                  this.emitActivity('tool', `Calling ${name}`, JSON.stringify(input).slice(0, 120));
                },
                onToolEnd: (name, success) => {
                  this.emitActivity(success ? 'read' : 'error', `${name} ${success ? 'ok' : 'failed'}`);
                },
              }
            )) {
              if (signal.aborted) break;
              fullResponse += chunk;
              yield chunk;
            }
          } else {
            const planText = formatPlanAsResponse(plan);
            fullResponse = planText;
            yield planText;
            this.emitActivity('info', 'Plan ready — switch to Act mode to execute steps');
          }

          await this.finishTurn(session, provider, userMessage, fullResponse, pack, compacted);
          this.setLiveStatus(null);
          return;
        }
      }

      const messages = buildPrompt(session.mode, pack, userMessage, compacted, toolsEnabled, auditMode);
      const promptTokens = estimatePromptTokens(messages);

      if (toolsEnabled && this.agentLoop) {
        this.setLiveStatus('Agent running');
        this.emitActivity('info', auditMode ? 'Scanning project with tools…' : 'Agent loop started');

        for await (const chunk of this.agentLoop.run(
          provider,
          messages,
          tools,
          signal,
          {
            onToolStart: (name, input) => {
              void this.previewDiffIfWrite(name, input);
              this.setLiveStatus(`Tool: ${name}`);
              this.emitActivity('tool', `Calling ${name}`, JSON.stringify(input).slice(0, 120));
            },
            onToolEnd: (name, success, output) => {
              this.emitActivity(success ? 'read' : 'error', `${name} ${success ? 'ok' : 'failed'}`, output.slice(0, 200));
            },
            onStep: (step, max) => {
              this.setLiveStatus('Agent step', `${step}/${max}`, step, max);
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
          },
          {
            auditMode,
            maxSteps: auditMode ? AUDIT_AGENT_MAX_STEPS : undefined,
            autoContinue: true,
          }
        )) {
          if (signal.aborted) break;
          fullResponse += chunk;
          yield chunk;
        }
      } else {
        this.setLiveStatus('Generating response');
        this.emitActivity('info', 'Streaming response…');
        for await (const delta of provider.complete({ messages, stream: true })) {
          if (signal.aborted) break;
          if (delta.content) {
            fullResponse += delta.content;
            yield delta.content;
          }
          if (delta.error) throw new Error(delta.error);
        }
      }

      await this.finishTurn(session, provider, userMessage, fullResponse, pack, compacted, promptTokens);
      this.onLiveStatus?.(null);
    } finally {
      log.info('Chat completed', { sessionId: session.id, tokens: pack.totalTokens });
    }
  }

  private async finishTurn(
    session: ThunderSession,
    provider: LlmProvider,
    userMessage: string,
    fullResponse: string,
    pack: ContextPack,
    compacted: ChatMessage[],
    promptTokens = 0
  ): Promise<void> {
    if (!fullResponse) return;

    this.saveTurn(session.id, 'assistant', fullResponse);

    const parsed = parsePlanFromText(fullResponse);
    if (parsed) {
      this.onPlan?.({ goal: parsed.goal, assumptions: parsed.assumptions, steps: parsed.steps });
      this.deps.planPersistence?.save(session.id, parsed);
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

    const tokens = promptTokens || estimatePromptTokens(buildPrompt(session.mode, pack, userMessage, compacted));
    this.onTokenUsage?.(tokens, pack.totalTokens, fullResponse);
  }

  private async previewDiffIfWrite(name: string, input: Record<string, unknown>): Promise<void> {
    const workspace = this.deps.workspace;
    if (!workspace) return;

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

  stop(): void {
    this.abortController?.abort();
  }

  private saveTurn(sessionId: string, role: string, content: string): void {
    if (this.deps.sessionService) {
      this.deps.sessionService.saveTurn(sessionId, role, content);
      return;
    }
    if (!this.db) return;
    try {
      this.db.raw.prepare(`
        INSERT INTO agent_turns (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), sessionId, role, content, Date.now());
    } catch {
      // Session may not exist in DB yet
    }
  }
}

function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  const serialized = messages.map((m) => `${m.role}\n${m.content}`).join('\n\n');
  return Math.ceil(serialized.length / 4);
}

function formatPlanHeader(plan: import('./planning/PlanActEngine').ThunderPlan): string {
  return `## Plan: ${plan.goal}\n\n${plan.steps.length} steps to execute.\n\n`;
}

function formatPlanAsResponse(plan: import('./planning/PlanActEngine').ThunderPlan): string {
  const lines = [
    `## ${plan.goal}`,
    '',
    '### Recommended steps',
    ...plan.steps.map((s, i) => `${i + 1}. **${s.title}** (${s.risk} risk)${s.files?.length ? ` — \`${s.files.join('`, `')}\`` : ''}`),
  ];
  if (plan.assumptions.length > 0) {
    lines.push('', '### Assumptions', ...plan.assumptions.map((a) => `- ${a}`));
  }
  lines.push('', '---', '*Switch to **Act** mode and ask to execute this plan when ready.*');
  return lines.join('\n');
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
