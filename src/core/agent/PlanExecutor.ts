import type { LlmProvider } from '../llm/types';
import type { ToolDefinition } from '../llm/toolTypes';
import type { ThunderSession } from '../ThunderSession';
import type { ThunderPlan } from '../planning/PlanActEngine';
import type { PlanPersistence } from '../planning/PlanPersistence';
import type { AgentLoop } from './AgentLoop';
import type { AgentLoopCallbacks } from './AgentLoop';
import type { ContextPack } from '../context/types';
import { buildStepPrompt, buildPlanGenerationPrompt } from '../planning/promptBuilder';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('PlanExecutor');

export type PlanUpdateCallback = (plan: ThunderPlan) => void;

export class PlanExecutor {
  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly planPersistence: PlanPersistence
  ) {}

  async generatePlan(
    provider: LlmProvider,
    mode: ThunderSession['mode'],
    pack: ContextPack,
    userMessage: string
  ): Promise<ThunderPlan | null> {
    const messages = buildPlanGenerationPrompt(mode, pack, userMessage);
    let response = '';

    for await (const delta of provider.complete({ messages, stream: false })) {
      if (delta.content) response += delta.content;
      if (delta.error) throw new Error(delta.error);
    }

    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ?? response.match(/\{[\s\S]*"steps"[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const raw = jsonMatch[1] ?? jsonMatch[0];
      const parsed = JSON.parse(raw) as ThunderPlan;
      if (parsed.goal && Array.isArray(parsed.steps)) {
        parsed.steps = parsed.steps.map((s, i) => ({
          ...s,
          id: s.id ?? `step-${i + 1}`,
          status: s.status ?? 'pending',
          risk: s.risk ?? 'medium',
        }));
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  async *executePlan(
    session: ThunderSession,
    provider: LlmProvider,
    plan: ThunderPlan,
    pack: ContextPack,
    tools: ToolDefinition[],
    onPlanUpdate?: PlanUpdateCallback,
    signal?: AbortSignal,
    loopCallbacks?: AgentLoopCallbacks
  ): AsyncIterable<string> {
    this.planPersistence.save(session.id, plan, 'running');
    onPlanUpdate?.(plan);

    for (let i = 0; i < plan.steps.length; i++) {
      if (signal?.aborted) break;

      const step = plan.steps[i];
      if (step.status === 'done') continue;

      plan.steps[i] = { ...step, status: 'running' };
      this.planPersistence.updatePlan(session.id, plan, 'running');
      onPlanUpdate?.(plan);

      yield `\n\n### Step ${i + 1}/${plan.steps.length}: ${step.title}\n\n`;

      const messages = buildStepPrompt(session.mode, pack, plan, step);

      for await (const chunk of this.agentLoop.run(
        provider,
        messages,
        tools,
        signal,
        loopCallbacks
      )) {
        yield chunk;
      }

      const pendingApproval = this.agentLoop.hadPendingApproval();
      if (pendingApproval) {
        plan.steps[i] = { ...plan.steps[i], status: 'blocked' };
        this.planPersistence.updatePlan(session.id, plan, 'blocked');
        onPlanUpdate?.(plan);
        yield '\n\n⏸ Waiting for approval before continuing…\n';
        break;
      }

      plan.steps[i] = { ...plan.steps[i], status: 'done' };
      this.planPersistence.updatePlan(session.id, plan, 'running');
      onPlanUpdate?.(plan);
    }

    const allDone = plan.steps.every((s) => s.status === 'done');
    if (allDone) {
      this.planPersistence.complete(session.id);
      onPlanUpdate?.(plan);
    }

    log.info('Plan execution finished', { goal: plan.goal, steps: plan.steps.length });
  }
}

export function shouldDecomposeTask(userMessage: string, mode: string): boolean {
  // Cursor-style: run the agent loop directly. Only pre-plan when the user explicitly asks.
  if (mode !== 'act') return false;

  const explicitPlan =
    /step[- ]by[- ]step/i.test(userMessage) ||
    /break(?: it)? down/i.test(userMessage) ||
    /multi[- ]step/i.test(userMessage) ||
    /\b(create|make) a plan\b/i.test(userMessage) ||
    /\bplan (?:this|out)\b/i.test(userMessage) ||
    /execution plan/i.test(userMessage);

  if (!explicitPlan) return false;

  const implementationHeavy =
    /\b(implement|build|migrate|refactor|rewrite)\b/i.test(userMessage) &&
    (userMessage.match(/\b(and|then)\b/gi)?.length ?? 0) >= 1;

  return explicitPlan && (implementationHeavy || userMessage.length > 180);
}
