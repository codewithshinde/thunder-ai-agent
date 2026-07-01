export type AskIntent =
  | 'explain_code'
  | 'locate'
  | 'architecture'
  | 'compare'
  | 'implement_here'
  | 'debug_explain'
  | 'general_knowledge'
  | 'cross_project';

export type AskResponseProfile = 'deep' | 'concise';

export interface AskRoute {
  intent: AskIntent;
  profile: AskResponseProfile;
  includeImpact: boolean;
  allowWeb: boolean;
  shouldUseSubagents: boolean;
  groundingRequired: boolean;
  summary: string;
}

export interface ProjectNode {
  id: string;
  root: string;
  name: string;
  type: 'extension' | 'docs' | 'web' | 'lib' | 'service' | 'unknown';
  entryFiles: string[];
  scripts: Record<string, string>;
}

export interface ProjectCatalog {
  workspaceRoot: string;
  projects: ProjectNode[];
  generatedAt: string;
}

export interface AskScopeResolution {
  status: 'all' | 'matched' | 'ambiguous' | 'none';
  projects: ProjectNode[];
  scopeRoot?: string;
  reason: string;
}

export interface ImpactFile {
  path: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ImpactAnalysis {
  summary: string;
  projects: string[];
  files: {
    modify: ImpactFile[];
    create: ImpactFile[];
    maybe: ImpactFile[];
    tests: string[];
  };
  dependencies: string[];
  webReferences: Array<{ title: string; url: string }>;
  risks: string[];
  suggestedOrder: string[];
}

export interface AskRunPlan {
  route: AskRoute;
  catalog?: ProjectCatalog;
  scope: AskScopeResolution;
  promptContext: string;
  maxSteps: number;
  autoContinue: boolean;
  maxAutoContinues: number;
}
