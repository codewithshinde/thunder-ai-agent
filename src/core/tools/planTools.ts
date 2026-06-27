import type { PlanPersistence } from '../planning/PlanPersistence';
import type { ThunderPlan } from '../planning/PlanActEngine';
import type { Tool, ToolResult } from '../tools/types';
import { z } from 'zod';
import { PlanFileStore } from '../planning/PlanFileStore';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('PlanTools');

/** Read-only tools allowed during planning discovery phase. */
export const PLANNING_DISCOVERY_TOOLS = new Set([
  'read_file',
  'read_files',
  'list_files',
  'search',
  'search_batch',
  'search_script_catalog',
  'use_skill',
  'repo_map',
  'retrieve_context',
  'git_diff',
  'diagnostics',
  'memory_search',
  'run_command',
  'spawn_research_agent',
  'fetch_web',
  'ask_question',
]);

/** Tools available during plan step execution. */
export const PLAN_EXECUTION_TOOLS = new Set([
  ...PLANNING_DISCOVERY_TOOLS,
  'write_file',
  'apply_patch',
  'execute_workspace_script',
  'memory_write',
  'save_task_state',
  'mark_step_complete',
  'propose_plan_mutation',
]);

export interface PlanToolsContext {
  getPlan: () => ThunderPlan | null;
  setPlan: (plan: ThunderPlan) => void;
  planPersistence?: PlanPersistence;
  planFileStore?: PlanFileStore;
  getSessionId: () => string;
  /** Unlocks write tools when a mutation pivots to execute phase mid-step. */
  setPlanPhaseLock?: (phase: import('../planning/PlanActEngine').PlanPhase | undefined) => void;
}

export function createMarkStepCompleteTool(ctx: PlanToolsContext): Tool<{ stepId: string }> {
  return {
    name: 'mark_step_complete',
    description:
      'Mark the current plan step as completed. Call this ONLY after the active step objective is fully satisfied. The orchestrator updates plan state — do not skip this when a step is done.',
    risk: 'low',
    inputSchema: z.object({ stepId: z.string() }),
    async execute(input): Promise<ToolResult> {
      const plan = ctx.getPlan();
      if (!plan) {
        return { success: false, output: '', error: 'No active plan' };
      }

      const step = plan.steps.find((s) => s.id === input.stepId);
      if (!step) {
        return { success: false, output: '', error: `Step not found: ${input.stepId}` };
      }

      step.status = 'done';

      for (const s of plan.steps) {
        if (s.dependsOn?.includes(input.stepId) && s.status === 'blocked_by_dependency') {
          const depsMet = (s.dependsOn ?? []).every((depId) => {
            const dep = plan.steps.find((d) => d.id === depId);
            return dep?.status === 'done';
          });
          if (depsMet) s.status = 'pending';
        }
      }

      ctx.setPlan(plan);
      ctx.planPersistence?.updatePlan(ctx.getSessionId(), plan, 'running');
      ctx.planFileStore?.markStepComplete(input.stepId);

      log.info('Step marked complete', { stepId: input.stepId });
      return {
        success: true,
        output: `Step ${input.stepId} marked complete. Next pending: ${
          plan.steps.find((s) => s.status === 'pending')?.title ?? '(none — plan may be finished)'
        }`,
      };
    },
  };
}

const newStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string().optional(),
  tool: z.string().optional(),
  args: z.preprocess((val) => {
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return undefined;
      }
    }
    return val;
  }, z.record(z.unknown()).optional()),
  dependsOn: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  successCriteria: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  phase: z.enum(['diagnostics', 'review', 'execute', 'verify']).optional(),
});

export function createProposePlanMutationTool(ctx: PlanToolsContext): Tool<{
  reason: string;
  newSteps: z.infer<typeof newStepSchema>[];
}> {
  return {
    name: 'propose_plan_mutation',
    description:
      'Propose a structural change to the plan when you hit a major roadblock. Do NOT drift off-task silently — call this to pivot the architecture map with explicit new steps and dependencies.',
    risk: 'medium',
    inputSchema: z.object({
      reason: z.string(),
      newSteps: z.array(newStepSchema).min(1).max(20),
    }),
    async execute(input): Promise<ToolResult> {
      const plan = ctx.getPlan();
      if (!plan) {
        return { success: false, output: '', error: 'No active plan' };
      }

      const pendingIds = new Set(
        plan.steps.filter((s) => s.status === 'pending' || s.status === 'running').map((s) => s.id)
      );
      for (const step of plan.steps) {
        if (pendingIds.has(step.id) && step.status === 'running') {
          step.status = 'done';
        }
      }
      plan.steps = plan.steps.filter((s) => !pendingIds.has(s.id) || s.status === 'done');

      let firstNewRunning = false;
      for (const step of input.newSteps) {
        const deps = step.dependsOn ?? [];
        const blocked = deps.some((depId) => {
          const dep = plan.steps.find((s) => s.id === depId);
          return dep && dep.status !== 'done';
        });
        const phase = step.phase ?? 'execute';
        const shouldRunNow = !firstNewRunning && phase === 'execute' && !blocked;

        plan.steps.push({
          id: step.id,
          title: step.title,
          status: blocked ? 'blocked_by_dependency' : shouldRunNow ? 'running' : 'pending',
          phase,
          objective: step.objective,
          tool: step.tool,
          args: step.args,
          dependsOn: deps.length > 0 ? deps : undefined,
          tools: step.tools,
          successCriteria: step.successCriteria,
          files: step.files,
          risk: step.risk ?? 'medium',
        });

        if (shouldRunNow) firstNewRunning = true;
      }

      const hasExecutePhase = input.newSteps.some((s) => (s.phase ?? 'execute') === 'execute');
      if (hasExecutePhase) {
        ctx.setPlanPhaseLock?.('execute');
      }

      plan.assumptions.push(`Plan mutation: ${input.reason}`);
      ctx.setPlan(plan);
      ctx.planPersistence?.updatePlan(ctx.getSessionId(), plan, 'running');
      ctx.planFileStore?.mutatePlan(plan, 'running');

      log.info('Plan mutated', { reason: input.reason, newSteps: input.newSteps.length });
      const phaseNote = hasExecutePhase ? ' Phase lock set to execute — write_file/apply_patch allowed.' : '';
      return {
        success: true,
        output: `Plan updated: ${input.newSteps.length} new step(s) added. Reason: ${input.reason}.${phaseNote}`,
      };
    },
  };
}

/** Resolve step dependencies — mark steps blocked when deps are incomplete. */
export function applyDependencyLocks(plan: ThunderPlan): ThunderPlan {
  for (const step of plan.steps) {
    if (step.status === 'done' || step.status === 'failed' || step.status === 'blocked') continue;
    if (!step.dependsOn?.length) continue;

    const blocked = step.dependsOn.some((depId) => {
      const dep = plan.steps.find((s) => s.id === depId);
      return !dep || dep.status !== 'done';
    });

    if (blocked && step.status !== 'running') {
      step.status = 'blocked_by_dependency';
    } else if (!blocked && step.status === 'blocked_by_dependency') {
      step.status = 'pending';
    }
  }
  return plan;
}

/** Find the first executable step respecting DAG order. */
export function getNextExecutableStep(plan: ThunderPlan): ThunderPlan['steps'][number] | undefined {
  applyDependencyLocks(plan);
  return plan.steps.find((s) => s.status === 'pending');
}
