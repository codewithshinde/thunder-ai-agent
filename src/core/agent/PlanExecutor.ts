import type { LlmProvider } from '../llm/types';
import type { ToolDefinition } from '../llm/toolTypes';
import type { ThunderSession } from '../ThunderSession';
import type { PlanPhase, ThunderPlan } from '../planning/PlanActEngine';
import {
  inferStepPhase,
  resolveStepPhaseLock,
  stepImpliesWrite,
} from '../planning/PlanActEngine';
import type { PlanPersistence } from '../planning/PlanPersistence';
import type { SessionLogService } from '../telemetry/SessionLogService';
import type { AgentLoop } from './AgentLoop';
import type { AgentLoopCallbacks } from './AgentLoop';
import type { ContextPack } from '../context/types';
import type { PostEditValidator } from '../apply/PostEditValidator';
import type { ToolExecutor, ToolExecutionResult } from '../safety/ToolExecutor';
import type { TaskAnalysis } from './TaskAnalyzer';
import {
  buildStepPrompt,
  buildPlanGenerationPrompt,
  buildRequirementAnalysisPrompt,
  buildPlanningDiscoveryPrompt,
  buildStepRetryPrompt,
  buildFinalValidationPrompt,
  buildIsolatedPlanPrompt,
} from '../planning/promptBuilder';
import { PlanFileStore } from '../planning/PlanFileStore';
import { applyDependencyLocks, getNextExecutableStep, PLANNING_DISCOVERY_TOOLS } from '../tools/planTools';
import { needsPlanGrounding } from '../plan/planMode';
import { filterDirectAgentTools } from '../tools/toolAliases';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('PlanExecutor');

export type PlanUpdateCallback = (plan: ThunderPlan) => void;

export interface PlanExecutorOptions {
  stepMaxRetries?: number;
  finalValidationEnabled?: boolean;
  agentMaxSteps?: number;
  restrictRunCommandToReadOnly?: boolean;
  workspace?: string;
  useIsolatedPlanning?: boolean;
  sessionLog?: SessionLogService;
  touchedFiles?: string[];
  planAutoContinue?: boolean;
  planMaxAutoContinues?: number;
  skillPlaybookContext?: string;
  onRequirementAnalysisDelta?: (text: string) => void;
}

export interface StepExecutionResult {
  stepIndex: number;
  success: boolean;
  summary: string;
  touchedFiles: string[];
  validationErrors: string[];
}

export class PlanExecutor {
  private stepSummaries: string[] = [];
  private touchedFiles = new Set<string>();

  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly planPersistence: PlanPersistence,
    private readonly postEditValidator?: PostEditValidator,
    private readonly toolExecutor?: ToolExecutor
  ) {}

  async *analyzeRequirementsStream(
    provider: LlmProvider,
    pack: ContextPack,
    userMessage: string,
    analysis: TaskAnalysis,
    skillPlaybookContext?: string,
    onDelta?: (text: string) => void
  ): AsyncIterable<string> {
    const messages = buildRequirementAnalysisPrompt(pack, userMessage, analysis, skillPlaybookContext);
    let response = '';

    for await (const delta of provider.complete({ messages, stream: true })) {
      if (delta.content) {
        response += delta.content;
        onDelta?.(response);
        yield delta.content;
      }
      if (delta.error) throw new Error(delta.error);
    }

    if (!response.trim()) {
      yield analysis.summary;
    }
  }

  async analyzeRequirements(
    provider: LlmProvider,
    pack: ContextPack,
    userMessage: string,
    analysis: TaskAnalysis
  ): Promise<string> {
    let response = '';
    for await (const chunk of this.analyzeRequirementsStream(provider, pack, userMessage, analysis)) {
      response += chunk;
    }
    return response.trim() || analysis.summary;
  }

  async generatePlan(
    provider: LlmProvider,
    mode: ThunderSession['mode'],
    pack: ContextPack,
    userMessage: string,
    requirementAnalysis?: string,
    planningDiscovery?: string,
    taskAnalysis?: TaskAnalysis,
    sessionId?: string,
    options?: PlanExecutorOptions
  ): Promise<ThunderPlan | null> {
    let repairNotes = '';
    let relaxedFallback: { plan: ThunderPlan; issues: string[] } | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const effectiveAnalysis = repairNotes
        ? `${requirementAnalysis ?? ''}\n\n## Previous plan was rejected\n${repairNotes}\nRegenerate a valid, more specific plan.`
        : requirementAnalysis;

      const messages = options?.useIsolatedPlanning
        ? buildIsolatedPlanPrompt(
            mode,
            pack,
            userMessage,
            effectiveAnalysis,
            planningDiscovery,
            taskAnalysis,
            options?.skillPlaybookContext
          )
        : buildPlanGenerationPrompt(
            mode,
            pack,
            userMessage,
            effectiveAnalysis,
            planningDiscovery,
            taskAnalysis,
            options?.skillPlaybookContext
          );
      let response = '';

      for await (const delta of provider.complete({ messages, stream: false })) {
        if (delta.content) response += delta.content;
        if (delta.error) throw new Error(delta.error);
      }

      const plan = parseGeneratedPlan(response, mode);
      if (!plan) {
        repairNotes = '- Response did not contain valid plan JSON with goal and steps/phases.';
        continue;
      }

      const issues = validatePlanQuality(plan, taskAnalysis);
      if (issues.length === 0) {
        applyDependencyLocks(plan);
        if (sessionId && options?.workspace) {
          const fileStore = new PlanFileStore(options.workspace, sessionId);
          fileStore.save(plan, 'planning');
        }
        return plan;
      }

      repairNotes = issues.map((issue) => `- ${issue}`).join('\n');
      relaxedFallback = { plan, issues };
      log.warn('Generated plan failed quality gate', { attempt: attempt + 1, issues });
    }

    if (mode === 'plan' && relaxedFallback) {
      const plan = relaxedFallback.plan;
      plan.assumptions = [
        ...plan.assumptions,
        `Planning quality warning: ${relaxedFallback.issues.join(' ')}`,
      ];
      applyDependencyLocks(plan);
      if (sessionId && options?.workspace) {
        const fileStore = new PlanFileStore(options.workspace, sessionId);
        fileStore.save(plan, 'planning');
      }
      log.warn('Returning relaxed Plan-mode fallback after quality gate rejection', {
        issues: relaxedFallback.issues,
        stepCount: plan.steps.length,
      });
      return plan;
    }

    return null;
  }

  async runPlanningDiscovery(
    provider: LlmProvider,
    mode: ThunderSession['mode'],
    pack: ContextPack,
    userMessage: string,
    analysis: TaskAnalysis,
    tools: ToolDefinition[],
    signal?: AbortSignal,
    loopCallbacks?: AgentLoopCallbacks,
    options?: PlanExecutorOptions
  ): Promise<string> {
    const messages = buildPlanningDiscoveryPrompt(
      mode,
      pack,
      userMessage,
      analysis,
      options?.skillPlaybookContext
    );
    const readOnlyTools = tools.filter((tool) => PLANNING_DISCOVERY_TOOLS.has(tool.function.name));
    let output = '';

    for await (const chunk of this.agentLoop.run(
      provider,
      messages,
      readOnlyTools,
      signal,
      loopCallbacks,
      {
        maxSteps: Math.min(options?.agentMaxSteps ?? 8, 12),
        phaseLock: 'diagnostics',
        restrictRunCommandToReadOnly: true,
        planMode: mode === 'plan',
        requiresPlanGrounding: mode === 'plan' && needsPlanGrounding(userMessage),
        autoContinue: options?.planAutoContinue ?? true,
        maxAutoContinues: options?.planMaxAutoContinues ?? 1,
      }
    )) {
      output += chunk;
      if (output.length > 12_000) {
        output = output.slice(-12_000);
      }
      if (signal?.aborted) break;
    }

    return output.trim();
  }

  async *executePlan(
    session: ThunderSession,
    provider: LlmProvider,
    plan: ThunderPlan,
    pack: ContextPack,
    tools: ToolDefinition[],
    onPlanUpdate?: PlanUpdateCallback,
    signal?: AbortSignal,
    loopCallbacks?: AgentLoopCallbacks,
    options?: PlanExecutorOptions
  ): AsyncIterable<string> {
    this.stepSummaries = [];
    this.touchedFiles.clear();
    const maxRetries = options?.stepMaxRetries ?? 2;

    this.planPersistence.save(session.id, plan, 'running');
    onPlanUpdate?.(plan);

    if (options?.workspace) {
      const fileStore = new PlanFileStore(options.workspace, session.id);
      fileStore.save(plan, 'running');
    }

    applyDependencyLocks(plan);

    for (let i = 0; i < plan.steps.length; i++) {
      if (signal?.aborted) break;

      const step = getNextExecutableStep(plan) ?? plan.steps[i];
      const stepIndex = plan.steps.findIndex((s) => s.id === step.id);
      if (stepIndex < 0 || step.status === 'done') continue;
      i = stepIndex;

      let attempt = 0;
      let stepSucceeded = false;
      let lastValidationErrors: string[] = [];

      while (attempt <= maxRetries && !stepSucceeded) {
        if (signal?.aborted) break;

        if (attempt > 0) {
          yield `\n\n🔄 Retrying step ${i + 1} (attempt ${attempt + 1}/${maxRetries + 1})…\n\n`;
        } else {
          yield `\n\n### Step ${i + 1}/${plan.steps.length}: ${step.title}\n\n`;
        }

        plan.steps[i] = { ...step, status: 'running' };
        this.planPersistence.updatePlan(session.id, plan, 'running');
        onPlanUpdate?.(plan);

        const stepStartedAt = Date.now();
        const messages =
          attempt === 0
            ? buildStepPrompt(session.mode, pack, plan, step, this.stepSummaries)
            : buildStepRetryPrompt(session.mode, pack, plan, step, this.stepSummaries, lastValidationErrors);

        let stepOutput = '';
        let successfulWrites = 0;
        let pendingApproval = false;
        const phaseLock = resolveStepPhaseLock(step, session.mode);
        const explicitToolCall = getExplicitStepToolCall(step);
        const writeExpected = stepImpliesWrite(step) && session.mode === 'agent' && !explicitToolCall;

        if (explicitToolCall && this.toolExecutor) {
          const toolStartedAt = Date.now();
          loopCallbacks?.onToolStart?.(explicitToolCall.name, explicitToolCall.input);
          const execResult = await this.toolExecutor.execute(explicitToolCall.name, explicitToolCall.input, {
            phaseLock,
            restrictRunCommandToReadOnly: options?.restrictRunCommandToReadOnly,
          });
          const output = summarizeToolExecution(explicitToolCall.name, execResult);
          loopCallbacks?.onToolEnd?.(explicitToolCall.name, execResult.success, output, Date.now() - toolStartedAt);
          stepOutput += output;
          yield output;

          if (execResult.pendingApproval) {
            plan.steps[i] = { ...plan.steps[i], status: 'blocked' };
            this.planPersistence.updatePlan(session.id, plan, 'blocked');
            onPlanUpdate?.(plan);
            yield '\n\n⏸ Waiting for approval before continuing…\n';
            return;
          }

          if (!execResult.success) {
            lastValidationErrors = [`${explicitToolCall.name} failed: ${execResult.error ?? execResult.output}`];
            attempt += 1;
            if (attempt <= maxRetries) {
              yield `\n\n⚠️ Step tool failed — retrying step (${attempt}/${maxRetries + 1})…\n`;
              plan.steps[i] = { ...plan.steps[i], status: 'pending' };
              continue;
            }
            plan.steps[i] = { ...plan.steps[i], status: 'failed' };
            this.planPersistence.updatePlan(session.id, plan, 'running');
            onPlanUpdate?.(plan);
            yield `\n\n❌ Step failed after ${maxRetries + 1} attempts. Errors:\n${lastValidationErrors.join('\n')}\n`;
            break;
          }

          if (['write_file', 'apply_patch'].includes(explicitToolCall.name)) {
            successfulWrites += 1;
          }
        } else {
          for await (const chunk of this.agentLoop.run(
            provider,
            messages,
            filterDirectAgentTools(tools),
            signal,
            {
              ...loopCallbacks,
              onToolEnd: (name, success, output) => {
                loopCallbacks?.onToolEnd?.(name, success, output);
                if (success && ['write_file', 'apply_patch'].includes(name)) {
                  successfulWrites += 1;
                }
              },
            },
            {
              maxSteps: options?.agentMaxSteps,
              phaseLock,
              restrictRunCommandToReadOnly: options?.restrictRunCommandToReadOnly,
              planTracker: plan,
            }
          )) {
            yield chunk;
            stepOutput += chunk;
          }
          pendingApproval = this.agentLoop.hadPendingApproval();
        }

        if (pendingApproval) {
          plan.steps[i] = { ...plan.steps[i], status: 'blocked' };
          this.planPersistence.updatePlan(session.id, plan, 'blocked');
          onPlanUpdate?.(plan);
          yield '\n\n⏸ Waiting for approval before continuing…\n';
          return;
        }

        if (step.files?.length) {
          for (const f of step.files) this.touchedFiles.add(f);
        }

        if (writeExpected && successfulWrites === 0 && !pendingApproval) {
          lastValidationErrors = [
            'This step requires file edits (write_file/apply_patch) but no writes succeeded.',
            phaseLock === 'execute'
              ? 'Review tool errors above and retry with a complete patch or write_file.'
              : `Step was locked to ${phaseLock ?? 'unknown'} phase — writes may have been blocked.`,
          ];
          attempt += 1;
          if (attempt <= maxRetries) {
            yield `\n\n⚠️ No file changes were applied — retrying step (${attempt}/${maxRetries + 1})…\n`;
            plan.steps[i] = { ...plan.steps[i], status: 'pending' };
            continue;
          }
        }

        lastValidationErrors = await this.validateStepFiles(step.files ?? []);
        if (lastValidationErrors.length > 0) {
          attempt += 1;
          if (attempt <= maxRetries) {
            yield `\n\n⚠️ Validation errors detected — will retry:\n${lastValidationErrors.join('\n')}\n`;
            continue;
          }
          plan.steps[i] = { ...plan.steps[i], status: 'failed' };
          this.planPersistence.updatePlan(session.id, plan, 'running');
          onPlanUpdate?.(plan);
          yield `\n\n❌ Step failed after ${maxRetries + 1} attempts. Errors:\n${lastValidationErrors.join('\n')}\n`;
          break;
        }

        stepSucceeded = true;
        const summary = summarizeStepOutput(stepOutput, step.title);
        this.stepSummaries.push(`Step ${i + 1} (${step.title}): ${summary}`);
        plan.steps[i] = { ...plan.steps[i], status: 'done' };
        const stepDurationMs = Date.now() - stepStartedAt;
        options?.sessionLog?.appendTiming(`plan_step:${step.id}`, stepDurationMs, {
          title: step.title,
          stepIndex: i + 1,
          success: true,
        });
        options?.sessionLog?.append('plan_step', step.title, {
          stepId: step.id,
          stepIndex: i + 1,
          status: 'done',
          durationMs: stepDurationMs,
        });
        this.planPersistence.updatePlan(session.id, plan, 'running');
        if (options?.workspace) {
          new PlanFileStore(options.workspace, session.id).markStepComplete(step.id);
        }
        onPlanUpdate?.(plan);
      }
    }

    const failed = plan.steps.some((s) => s.status === 'failed');
    const blocked = plan.steps.some((s) => s.status === 'blocked');
    const allDone = plan.steps.every((s) => s.status === 'done');

    if (allDone && !blocked && options?.finalValidationEnabled !== false) {
      yield '\n\n### Final validation\n\n';
      for await (const chunk of this.runFinalValidation(
        session,
        provider,
        plan,
        pack,
        tools,
        signal,
        loopCallbacks,
        options
      )) {
        yield chunk;
      }
    }

    if (allDone) {
      this.planPersistence.complete(session.id);
      onPlanUpdate?.(plan);
      yield '\n\n✅ All steps completed.\n';
    } else if (failed) {
      yield '\n\n⚠️ Plan finished with failed steps. Review errors above and retry failed steps.\n';
    }

    log.info('Plan execution finished', {
      goal: plan.goal,
      steps: plan.steps.length,
      done: plan.steps.filter((s) => s.status === 'done').length,
      failed: plan.steps.filter((s) => s.status === 'failed').length,
    });
  }

  private async validateStepFiles(files: string[]): Promise<string[]> {
    if (!this.postEditValidator || files.length === 0) return [];

    const errors: string[] = [];
    for (const relPath of files) {
      const result = await this.postEditValidator.validate(relPath);
      if (result.errors.length > 0) {
        errors.push(this.postEditValidator.formatForAgent(result));
      }
    }
    return errors;
  }

  async *runFinalValidation(
    session: ThunderSession,
    provider: LlmProvider,
    plan: ThunderPlan,
    pack: ContextPack,
    tools: ToolDefinition[],
    signal?: AbortSignal,
    loopCallbacks?: AgentLoopCallbacks,
    options?: PlanExecutorOptions
  ): AsyncIterable<string> {
    const touchedFiles = options?.touchedFiles ?? Array.from(this.touchedFiles);
    const workspaceErrors = await this.collectWorkspaceErrors(touchedFiles);
    const messages = buildFinalValidationPrompt(
      session.mode,
      pack,
      plan,
      this.stepSummaries,
      touchedFiles,
      workspaceErrors
    );

    for await (const chunk of this.agentLoop.run(
      provider,
      messages,
      tools,
      signal,
      loopCallbacks,
      {
        maxSteps: Math.min(options?.agentMaxSteps ?? 10, 10),
        phaseLock: 'verify',
        restrictRunCommandToReadOnly: options?.restrictRunCommandToReadOnly,
      }
    )) {
      yield chunk;
    }
  }

  private async collectWorkspaceErrors(files = Array.from(this.touchedFiles)): Promise<string[]> {
    if (!this.postEditValidator) return [];

    const errors: string[] = [];
    for (const relPath of files) {
      const result = await this.postEditValidator.validate(relPath);
      if (result.errors.length > 0) {
        errors.push(this.postEditValidator.formatForAgent(result));
      }
    }
    return errors;
  }

  getTouchedFiles(): string[] {
    return Array.from(this.touchedFiles);
  }
}

function flattenPlanPhases(
  phases: NonNullable<ThunderPlan['phases']>,
  mode: ThunderSession['mode']
): ThunderPlan['steps'] {
  const steps: ThunderPlan['steps'] = [];
  for (const phase of phases) {
    const declaredPhase = normalizePlanPhase(phase.phase) ?? inferPhaseFromTitle(phase.title);
    for (const step of phase.steps ?? []) {
      steps.push({
        id: step.id ?? `step-${steps.length + 1}`,
        title: step.title,
        status: 'pending',
        phase: resolveStepPhaseLock(
          {
            title: step.title,
            objective: step.objective ?? phase.objective,
            phase: declaredPhase,
            tools: normalizeStringArray(step.tools),
            files: step.files,
          },
          mode
        ),
        objective: step.objective ?? phase.objective,
        tool: step.tool,
        args: step.args,
        script: step.script,
        dependsOn: step.dependsOn,
        tools: normalizeStringArray(step.tools),
        successCriteria: normalizeStringArray(step.successCriteria),
        files: step.files,
        risk: step.risk ?? 'medium',
      });
    }
  }
  return steps;
}

function parseGeneratedPlan(response: string, mode: ThunderSession['mode'] = 'plan'): ThunderPlan | null {
  const jsonMatch =
    response.match(/```json\s*([\s\S]*?)\s*```/) ??
    response.match(/\{[\s\S]*"(?:phases|steps)"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const raw = jsonMatch[1] ?? jsonMatch[0];
    const parsed = JSON.parse(raw) as ThunderPlan;
    if (parsed.goal && Array.isArray(parsed.phases)) {
      parsed.steps = flattenPlanPhases(parsed.phases, mode);
    }
    if (parsed.goal && Array.isArray(parsed.steps)) {
      parsed.assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
      parsed.requiredApprovals = Array.isArray(parsed.requiredApprovals) ? parsed.requiredApprovals : [];
      parsed.steps = parsed.steps.map((s, i) => ({
        ...s,
        id: s.id ?? `step-${i + 1}`,
        status: s.status ?? 'pending',
        phase: resolveStepPhaseLock(
          {
            title: s.title,
            objective: typeof s.objective === 'string' ? s.objective : undefined,
            phase: normalizePlanPhase(s.phase) ?? inferStepPhase(s.title, i),
            tools: normalizeStringArray(s.tools),
            files: normalizeStringArray(s.files),
          },
          mode
        ),
        objective: typeof s.objective === 'string' ? s.objective : undefined,
        tool: typeof s.tool === 'string' ? s.tool : undefined,
        args: typeof s.args === 'object' && s.args !== null ? s.args as Record<string, unknown> : undefined,
        script: normalizeStepScript((s as ThunderPlan['steps'][number]).script),
        dependsOn: normalizeStringArray(s.dependsOn),
        tools: normalizeStringArray(s.tools),
        successCriteria: normalizeStringArray(s.successCriteria),
        files: normalizeStringArray(s.files),
        risk: normalizeRisk(s.risk),
      }));
      applyDependencyLocks(parsed);
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function validatePlanQuality(plan: ThunderPlan, taskAnalysis?: TaskAnalysis): string[] {
  const issues: string[] = [];
  const stepCount = plan.steps.length;
  const phases = new Set(plan.steps.map((step) => step.phase).filter(Boolean));

  if (stepCount < 1) issues.push('Plan must contain at least one step.');

  if (taskAnalysis?.kind === 'audit') {
    if (stepCount < 8) issues.push('Audit/cleanup plans must contain at least 8 granular steps.');
    for (const phase of ['diagnostics', 'review', 'execute', 'verify'] as const) {
      if (!phases.has(phase)) issues.push(`Audit/cleanup plans must include a ${phase} phase.`);
    }
  } else if (taskAnalysis?.complexity === 'high' && stepCount < 4) {
    issues.push('High-complexity plans must contain at least 4 steps.');
  } else if (taskAnalysis?.shouldPlan && stepCount < 2) {
    issues.push('Planned tasks must contain at least 2 steps.');
  }

  if (isDocumentationPlan(taskAnalysis)) {
    const planText = plan.steps
      .map((step) => [
        step.title,
        step.objective,
        step.tools?.join(' '),
        step.successCriteria?.join(' '),
        step.files?.join(' '),
      ].filter(Boolean).join(' '))
      .join('\n')
      .toLowerCase();

    if (!/(docusaurus\.config|sidebars?|navbar|routebasepath|sidebarpath|docspluginid|docs plugin|docs routing)/i.test(planText)) {
      issues.push('Documentation plans must inspect/update docs routing/config such as docusaurus.config.ts, sidebars, navbar, or docs plugin settings.');
    }
    if (!phases.has('verify') && !/\b(build|validate|verify|test)\b/.test(planText)) {
      issues.push('Documentation plans must include a verification step, such as running the docs build.');
    }
  }

  const vagueSteps = plan.steps.filter((step) => step.title.trim().split(/\s+/).length < 3);
  if (vagueSteps.length > 0) {
    issues.push(`Step titles are too vague: ${vagueSteps.map((step) => step.id).join(', ')}.`);
  }

  const missingExecutionDetail = plan.steps.filter(
    (step) => !step.objective || !step.tools?.length || !step.successCriteria?.length
  );
  if (taskAnalysis?.kind === 'audit' && missingExecutionDetail.length > 0) {
    issues.push(`Audit steps must include objective, tools, and successCriteria: ${missingExecutionDetail.map((step) => step.id).join(', ')}.`);
  }

  const missingVerification = plan.steps.filter(
    (step) => !step.successCriteria?.some((criterion) => /\b(verify|test|lint|build|validate|pass)\b/i.test(criterion))
  );
  if (
    (taskAnalysis?.shouldPlan || taskAnalysis?.complexity === 'high') &&
    missingVerification.length === plan.steps.length &&
    plan.steps.length >= 3
  ) {
    issues.push('Planned tasks should include verification-oriented successCriteria on at least one step.');
  }

  return issues;
}

function isDocumentationPlan(taskAnalysis?: TaskAnalysis): boolean {
  return Boolean(
    taskAnalysis?.kind === 'implementation' &&
    /\b(documentation|docs?|docusaurus)\b/i.test(taskAnalysis.summary)
  );
}

function normalizeRisk(risk: unknown): 'low' | 'medium' | 'high' {
  if (risk === 'low' || risk === 'medium' || risk === 'high') return risk;
  return 'medium';
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStepScript(value: unknown): { command?: string; args?: unknown[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const script = value as { command?: unknown; args?: unknown };
  const command = typeof script.command === 'string' && script.command.trim() ? script.command.trim() : undefined;
  const args = Array.isArray(script.args) ? script.args : undefined;
  return command || args ? { command, args } : undefined;
}

function getExplicitStepToolCall(
  step: ThunderPlan['steps'][number]
): { name: string; input: Record<string, unknown> } | null {
  if (step.tool && step.args && typeof step.args === 'object') {
    return { name: step.tool, input: step.args };
  }

  if (step.script?.command) {
    return { name: 'run_command', input: { command: step.script.command } };
  }

  return null;
}

function summarizeToolExecution(toolName: string, result: ToolExecutionResult): string {
  if (result.pendingApproval) {
    return `\n\n${toolName} is awaiting approval.\n`;
  }

  const body = result.success ? result.output : (result.error ?? result.output);
  const trimmed = body.trim();
  const capped = trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
  return `\n\n${toolName} ${result.success ? 'succeeded' : 'failed'}${capped ? `:\n${capped}\n` : '.\n'}`;
}

function summarizeStepOutput(output: string, title: string): string {
  const trimmed = output.trim();
  if (!trimmed) return `Completed: ${title}`;
  const summaryMatch = trimmed.match(/(?:summary|result|completed)[:\s]+([\s\S]{80,4000})$/i);
  const summary = summaryMatch?.[1]?.trim() ?? trimmed.slice(-2500).trim();
  return summary.length > 3000 ? summary.slice(-3000).trim() : summary;
}

function normalizePlanPhase(phase: unknown): PlanPhase | undefined {
  if (phase === 'diagnostics' || phase === 'review' || phase === 'execute' || phase === 'verify') {
    return phase;
  }
  return undefined;
}

function inferPhaseFromTitle(title: string): PlanPhase {
  const text = title.toLowerCase();
  if (text.includes('phase 1') || text.includes('diagnostic')) return 'diagnostics';
  if (text.includes('phase 2') || text.includes('review')) return 'review';
  if (text.includes('phase 4') || text.includes('verify')) return 'verify';
  return inferStepPhase(title, 0);
}

// Re-export for backward compatibility
export { shouldDecomposeTask } from './TaskAnalyzer';
export { PLANNING_DISCOVERY_TOOLS } from '../tools/planTools';
