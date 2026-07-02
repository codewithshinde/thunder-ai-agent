import type { AskScopeResolution, ProjectCatalog } from '../ask/askTypes';
import type { AgentDepth } from '../../config/schema';
import type { TaskAnalysis, TaskComplexity } from '../../runtime/TaskAnalyzer';

export type ActIntent =
  | 'resume_plan'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'docs'
  | 'audit'
  | 'mdx_repair'
  | 'direct'
  | 'question';

export type ActExecutionPath =
  | 'resume_saved_plan'
  | 'orchestrated'
  | 'direct'
  | 'audit'
  | 'mdx_repair';

export interface ActRoute {
  intent: ActIntent;
  executionPath: ActExecutionPath;
  complexity: TaskComplexity;
  shouldUsePlanner: boolean;
  shouldUseSubagents: boolean;
  shouldVerify: boolean;
  summary: string;
}

export interface ActRunPlan {
  route: ActRoute;
  executionPath: ActExecutionPath;
  catalog?: ProjectCatalog;
  scope: AskScopeResolution;
  promptContext: string;
  maxSteps: number;
  autoContinue: boolean;
  maxAutoContinues: number;
  shouldVerify: boolean;
  verifyCommands: string[];
  suggestedSkills: string[];
  skillPlaybookContext: string;
  appliedSkills: string[];
  savedPlanId?: string;
  taskAnalysis: TaskAnalysis;
}

export type ActDepth = AgentDepth;
