import type { ProjectCatalog } from '../ask/askTypes';
import { loadProjectCatalog } from '../ask/ProjectCatalog';
import type { TaskAnalysis } from '../../runtime/TaskAnalyzer';
import type { SkillCatalogService } from '../../skills/SkillCatalogService';
import { routePlanIntent } from './PlanIntentRouter';
import { resolvePlanScope } from './PlanScopeResolver';
import { buildPlanPromptContext } from './planPrompts';
import { loadPlanningSkillPlaybooks, resolvePlanningSkillNames } from './planSkillRouting';
import type { PlanDepth, PlanRunPlan } from './planTypes';

export interface PlanPrepareOptions {
  workspaceRoot?: string;
  catalog?: ProjectCatalog;
  skillCatalog?: SkillCatalogService;
  configuredMaxSteps?: number;
  planDepth?: PlanDepth;
  planAutoContinue?: boolean;
  planMaxAutoContinues?: number;
  taskAnalysis?: TaskAnalysis;
}

export class PlanOrchestrator {
  static prepare(userMessage: string, options: PlanPrepareOptions = {}): PlanRunPlan {
    const route = routePlanIntent(userMessage, options.taskAnalysis);
    const catalog = options.catalog ?? (options.workspaceRoot ? loadProjectCatalog(options.workspaceRoot) : undefined);
    const scope = resolvePlanScope(userMessage, catalog);
    const discoveryMaxSteps = resolvePlanDiscoveryMaxSteps(
      route.complexity,
      route.intent,
      options.configuredMaxSteps,
      options.planDepth
    );
    const suggestedSkills = resolvePlanningSkillNames(route.intent, options.taskAnalysis);
    const { context: skillPlaybookContext, loaded: appliedSkills } = loadPlanningSkillPlaybooks(
      options.skillCatalog,
      suggestedSkills
    );

    return {
      route,
      catalog,
      scope,
      promptContext: buildPlanPromptContext(userMessage, route, scope, catalog, {
        suggestedSkills,
        appliedSkills,
      }),
      discoveryMaxSteps,
      autoContinue: Boolean(options.planAutoContinue ?? (route.groundingRequired && route.complexity === 'high')),
      maxAutoContinues: resolvePlanMaxAutoContinues(route.complexity, route.intent, options.planMaxAutoContinues),
      suggestedSkills,
      skillPlaybookContext,
      appliedSkills,
    };
  }
}

function resolvePlanDiscoveryMaxSteps(
  complexity: string,
  intent: string,
  configuredMaxSteps: number | undefined,
  planDepth: PlanDepth = 'auto'
): number {
  const automatic = depthDefaultSteps(planDepth) ?? intentDefaultSteps(complexity, intent);
  if (!configuredMaxSteps || configuredMaxSteps <= 0) return automatic;
  return Math.max(1, Math.min(automatic, configuredMaxSteps, 50));
}

function resolvePlanMaxAutoContinues(
  complexity: string,
  intent: string,
  configured: number | undefined
): number {
  const automatic = complexity === 'high' || intent === 'audit' || intent === 'spike' ? 1 : 0;
  if (configured === undefined) return automatic;
  return Math.max(0, Math.min(automatic, configured, 10));
}

function intentDefaultSteps(complexity: string, intent: string): number {
  if (intent === 'audit' || intent === 'spike') return 12;
  if (complexity === 'high') return 10;
  if (complexity === 'medium') return 8;
  return 6;
}

function depthDefaultSteps(planDepth: PlanDepth): number | undefined {
  if (planDepth === 'quick') return 5;
  if (planDepth === 'standard') return 8;
  if (planDepth === 'deep') return 12;
  return undefined;
}

export interface MitiiPlanOptions {
  depth?: Exclude<PlanDepth, 'auto'>;
  scope?: string;
  includeRisks?: boolean;
}

export interface MitiiPlanResult {
  goal: string;
  assumptions: string[];
  steps: Array<{ id: string; title: string; files?: string[]; risk: 'low' | 'medium' | 'high' }>;
}

export interface MitiiPlanRun {
  stream(): AsyncIterable<string>;
  wait(): Promise<MitiiPlanResult>;
}

export interface MitiiHeadlessPlanAgent {
  plan(message: string, options?: MitiiPlanOptions): Promise<MitiiPlanRun>;
}

export function createSdkCompatibilityNote(): string {
  return [
    'Plan is routed through a headless PlanOrchestrator.prepare() boundary.',
    'A future @mitii/sdk can wrap the same route/scope/discovery/quality decisions and expose Agent.plan() plus Agent.executePlan().',
  ].join(' ');
}
