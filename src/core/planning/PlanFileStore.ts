import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ThunderPlan } from './PlanActEngine';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('PlanFileStore');

export interface PlanFileDocument {
  taskId: string;
  status: 'planning' | 'running' | 'blocked' | 'completed' | 'failed';
  goal: string;
  assumptions: string[];
  requiredApprovals: string[];
  steps: ThunderPlan['steps'];
  updatedAt: number;
}

export class PlanFileStore {
  constructor(
    private readonly workspace: string,
    private readonly taskId: string
  ) {}

  private planDir(): string {
    return join(this.workspace, '.mitii', 'tasks', this.taskId);
  }

  private planPath(): string {
    return join(this.planDir(), 'plan.json');
  }

  save(plan: ThunderPlan, status: PlanFileDocument['status'] = 'running'): void {
    try {
      mkdirSync(this.planDir(), { recursive: true });
      const doc: PlanFileDocument = {
        taskId: this.taskId,
        status,
        goal: plan.goal,
        assumptions: plan.assumptions,
        requiredApprovals: plan.requiredApprovals,
        steps: plan.steps,
        updatedAt: Date.now(),
      };
      writeFileSync(this.planPath(), JSON.stringify(doc, null, 2), 'utf-8');
      log.info('Plan file saved', { path: this.planPath(), steps: plan.steps.length, status });
    } catch (error) {
      log.warn('Failed to save plan file', { error: String(error) });
    }
  }

  load(): PlanFileDocument | null {
    const path = this.planPath();
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as PlanFileDocument;
    } catch {
      return null;
    }
  }

  markStepComplete(stepId: string): ThunderPlan | null {
    const doc = this.load();
    if (!doc) return null;

    const step = doc.steps.find((s) => s.id === stepId);
    if (!step) return null;

    step.status = 'done';
    for (const dependent of doc.steps) {
      if (dependent.dependsOn?.includes(stepId) && dependent.status === 'blocked_by_dependency') {
        const depsMet = (dependent.dependsOn ?? []).every((depId) => {
          const dep = doc.steps.find((s) => s.id === depId);
          return dep?.status === 'done';
        });
        if (depsMet) dependent.status = 'pending';
      }
    }

    doc.updatedAt = Date.now();
    if (doc.steps.every((s) => s.status === 'done')) {
      doc.status = 'completed';
    }

    const plan: ThunderPlan = {
      goal: doc.goal,
      assumptions: doc.assumptions,
      requiredApprovals: doc.requiredApprovals,
      steps: doc.steps,
    };
    this.save(plan, doc.status);
    return plan;
  }

  mutatePlan(plan: ThunderPlan, status: PlanFileDocument['status'] = 'running'): void {
    this.save(plan, status);
  }

  getPath(): string {
    return this.planPath();
  }
}

/** Build immutable execution context packet for AgentLoop injection. */
export function buildPlanTrackerPacket(plan: ThunderPlan): string {
  const active = plan.steps.find((s) => s.status === 'running')
    ?? plan.steps.find((s) => s.status === 'pending' || s.status === 'blocked_by_dependency');

  const completed = plan.steps.filter((s) => s.status === 'done').map((s) => `- [done] ${s.id}: ${s.title}`);
  const pending = plan.steps
    .filter((s) => s.status !== 'done')
    .map((s) => `- [${s.status}] ${s.id}: ${s.title}${s.dependsOn?.length ? ` (depends: ${s.dependsOn.join(', ')})` : ''}`);

  const activeBlock = active
    ? `\nCurrently executing: **${active.title}** (${active.id}).\nYou are forbidden from doing work outside this atomic step scope.\n`
    : '\nNo active step — all steps may be complete.\n';

  return `[MASTER PLAN TRACKER — IMMUTABLE STATE]
Goal: ${plan.goal}
${activeBlock}
Completed:
${completed.length ? completed.join('\n') : '(none)'}

Remaining:
${pending.join('\n')}

Do NOT modify this plan tracker text. Use mark_step_complete when the active step is finished.`;
}
