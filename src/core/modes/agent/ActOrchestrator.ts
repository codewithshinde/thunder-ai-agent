import type { ProjectCatalog } from '../ask/askTypes';
import { loadProjectCatalog } from '../ask/ProjectCatalog';
import type { TaskAnalysis } from '../../runtime/TaskAnalyzer';
import { analyzeTask } from '../../runtime/TaskAnalyzer';
import { AUDIT_AGENT_MAX_STEPS } from '../../runtime/taskKind';
import type { SkillCatalogService } from '../../skills/SkillCatalogService';
import { resolvePlanScope } from '../plan/PlanScopeResolver';
import { routeActIntent } from './ActIntentRouter';
import { buildActPromptContext } from './actPrompts';
import { loadActSkillPlaybooks, resolveActSkillNames } from './actSkillRouting';
import type { ActDepth, ActRunPlan } from './actTypes';

export interface ActPrepareOptions {
  workspaceRoot?: string;
  catalog?: ProjectCatalog;
  skillCatalog?: SkillCatalogService;
  configuredMaxSteps?: number;
  actDepth?: ActDepth;
  actAutoContinue?: boolean;
  actMaxAutoContinues?: number;
  taskAnalysis?: TaskAnalysis;
  orchestrationEnabled?: boolean;
  auditMode?: boolean;
  mdxRepairMode?: boolean;
  githubIssueMode?: boolean;
  hasActivePlan?: boolean;
  savedPlanId?: string;
  /** Empty = discover verify commands from project manifests at runtime */
  verifyCommands?: string[];
}

export class ActOrchestrator {
  static prepare(userMessage: string, options: ActPrepareOptions = {}): ActRunPlan {
    const taskAnalysis = options.taskAnalysis ?? analyzeTask(userMessage, 'agent');
    const route = routeActIntent(userMessage, taskAnalysis, {
      mode: 'agent',
      hasActivePlan: options.hasActivePlan,
      orchestrationEnabled: options.orchestrationEnabled,
      auditMode: options.auditMode,
      mdxRepairMode: options.mdxRepairMode,
      githubIssueMode: options.githubIssueMode,
    });
    const catalog = options.catalog ?? (options.workspaceRoot ? loadProjectCatalog(options.workspaceRoot) : undefined);
    const scope = resolvePlanScope(userMessage, catalog);
    const suggestedSkills = resolveActSkillNames(route.intent, taskAnalysis);
    const { context: skillPlaybookContext, loaded: appliedSkills } = loadActSkillPlaybooks(
      options.skillCatalog,
      suggestedSkills
    );
    const maxSteps = resolveActMaxSteps(
      route.executionPath,
      route.complexity,
      options.configuredMaxSteps,
      options.actDepth
    );
    const autoContinue = options.actAutoContinue ?? route.executionPath !== 'resume_saved_plan';
    const maxAutoContinues = resolveActMaxAutoContinues(
      route.executionPath,
      route.complexity,
      options.actMaxAutoContinues
    );

    return {
      route,
      executionPath: route.executionPath,
      catalog,
      scope,
      promptContext: buildActPromptContext(userMessage, route, scope, catalog, {
        suggestedSkills,
        appliedSkills,
        savedPlanId: options.savedPlanId,
        verifyCommands: options.verifyCommands,
        workspaceRoot: options.workspaceRoot,
      }),
      maxSteps,
      autoContinue,
      maxAutoContinues,
      shouldVerify: route.shouldVerify,
      verifyCommands: options.verifyCommands ?? [],
      suggestedSkills,
      skillPlaybookContext,
      appliedSkills,
      savedPlanId: options.savedPlanId,
      taskAnalysis,
    };
  }
}

function resolveActMaxSteps(
  executionPath: string,
  complexity: string,
  configured: number | undefined,
  actDepth: ActDepth = 'auto'
): number {
  const automatic = depthDefaultSteps(actDepth) ?? pathDefaultSteps(executionPath, complexity);
  if (!configured || configured <= 0) return automatic;
  return Math.max(1, Math.min(automatic, configured, 60));
}

function resolveActMaxAutoContinues(
  executionPath: string,
  complexity: string,
  configured: number | undefined
): number {
  const automatic = executionPath === 'orchestrated' || complexity === 'high' ? 1 : 0;
  if (configured === undefined) return automatic;
  return Math.max(0, Math.min(configured, 10));
}

function pathDefaultSteps(executionPath: string, complexity: string): number {
  if (executionPath === 'audit') return AUDIT_AGENT_MAX_STEPS;
  if (executionPath === 'resume_saved_plan') return 15;
  if (executionPath === 'orchestrated') return complexity === 'high' ? 12 : 10;
  if (executionPath === 'mdx_repair') return 8;
  if (complexity === 'high') return 12;
  if (complexity === 'medium') return 10;
  return 6;
}

function depthDefaultSteps(actDepth: ActDepth): number | undefined {
  if (actDepth === 'quick') return 6;
  if (actDepth === 'standard') return 10;
  if (actDepth === 'deep') return 16;
  return undefined;
}

export interface MitiiExecuteOptions {
  depth?: Exclude<ActDepth, 'auto'>;
  verifyCommands?: string[];
}

export interface MitiiExecuteResult {
  summary: string;
  touchedFiles: string[];
  verification: string[];
}

export interface MitiiExecuteRun {
  stream(): AsyncIterable<string>;
  wait(): Promise<MitiiExecuteResult>;
}

export interface MitiiHeadlessActAgent {
  execute(message: string, options?: MitiiExecuteOptions): Promise<MitiiExecuteRun>;
  executePlan(planId: string, options?: MitiiExecuteOptions): Promise<MitiiExecuteRun>;
}

export function createActSdkCompatibilityNote(): string {
  return [
    'Act is routed through a headless ActOrchestrator.prepare() boundary.',
    'A future @mitii/sdk can wrap the same route/scope/skill/verification decisions and expose Agent.execute() plus Agent.executePlan().',
  ].join(' ');
}
