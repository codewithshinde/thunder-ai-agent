import type { AskScopeResolution, ProjectCatalog } from '../ask/askTypes';
import type { TaskComplexity } from '../../runtime/TaskAnalyzer';
import type { AgentDepth } from '../../config/schema';

export type PlanIntent = 'feature' | 'refactor' | 'bugfix' | 'audit' | 'docs' | 'spike' | 'question';

export type PlanDepth = AgentDepth;

export interface PlanRoute {
  intent: PlanIntent;
  complexity: TaskComplexity;
  forcePlan: boolean;
  groundingRequired: boolean;
  shouldUseSubagents: boolean;
  qualityProfile: 'relaxed' | 'standard' | 'strict';
  summary: string;
}

export interface PlanRunPlan {
  route: PlanRoute;
  catalog?: ProjectCatalog;
  scope: AskScopeResolution;
  promptContext: string;
  discoveryMaxSteps: number;
  autoContinue: boolean;
  maxAutoContinues: number;
  /** Skill names recommended for this planning session. */
  suggestedSkills: string[];
  /** Pre-loaded skill playbook text injected into discovery and plan compilation. */
  skillPlaybookContext: string;
  /** Skills successfully loaded from the workspace catalog. */
  appliedSkills: string[];
}
