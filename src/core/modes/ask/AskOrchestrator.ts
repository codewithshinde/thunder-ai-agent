import type { AskRunPlan, ProjectCatalog } from './askTypes';
import type { AgentDepth } from '../../config/schema';
import { routeAskIntent } from './AskIntentRouter';
import { buildAskPromptContext } from './askPrompts';
import { loadProjectCatalog } from './ProjectCatalog';
import { resolveAskScope } from './AskScopeResolver';

export interface AskPrepareOptions {
  workspaceRoot?: string;
  catalog?: ProjectCatalog;
  configuredMaxSteps?: number;
  askDepth?: AgentDepth;
  askAutoContinue?: boolean;
  askMaxAutoContinues?: number;
}

export class AskOrchestrator {
  static prepare(userMessage: string, options: AskPrepareOptions = {}): AskRunPlan {
    const route = routeAskIntent(userMessage);
    const catalog = options.catalog ?? (options.workspaceRoot ? loadProjectCatalog(options.workspaceRoot) : undefined);
    const scope = resolveAskScope(userMessage, catalog);
    const maxSteps = resolveAskMaxSteps(route.profile, route.intent, options.configuredMaxSteps, options.askDepth);
    const maxAutoContinues = resolveAskMaxAutoContinues(route.profile, route.intent, options.askMaxAutoContinues, options.askDepth);

    return {
      route,
      catalog,
      scope,
      promptContext: buildAskPromptContext(userMessage, route, scope, catalog),
      maxSteps,
      autoContinue: Boolean(options.askAutoContinue ?? (route.groundingRequired && route.profile === 'deep')),
      maxAutoContinues,
    };
  }
}

function resolveAskMaxSteps(
  profile: string,
  intent: string,
  configuredMaxSteps: number | undefined,
  askDepth: AskPrepareOptions['askDepth'] = 'auto'
): number {
  const intentBudget = intentDefaultSteps(profile, intent);
  const depthBudget = depthDefaultSteps(askDepth);
  const automatic = depthBudget ?? intentBudget;
  if (!configuredMaxSteps || configuredMaxSteps <= 0) return automatic;
  return Math.max(1, Math.min(automatic, configuredMaxSteps, 50));
}

function resolveAskMaxAutoContinues(
  profile: string,
  intent: string,
  configured: number | undefined,
  askDepth: AskPrepareOptions['askDepth'] = 'auto'
): number {
  const automatic = askDepth === 'quick'
    ? 0
    : askDepth === 'pilot'
      ? 2
      : askDepth === 'enterprise'
        ? 3
    : intent === 'implement_here' || intent === 'architecture' || intent === 'cross_project'
      ? 1
      : profile === 'deep'
        ? 1
        : 0;
  if (configured === undefined) return automatic;
  return Math.max(0, Math.min(automatic, configured, 10));
}

function intentDefaultSteps(profile: string, intent: string): number {
  if (profile === 'concise' || intent === 'general_knowledge' || intent === 'locate') return 8;
  if (intent === 'implement_here' || intent === 'architecture' || intent === 'cross_project') return 20;
  return 16;
}

function depthDefaultSteps(askDepth: AskPrepareOptions['askDepth']): number | undefined {
  if (askDepth === 'quick') return 8;
  if (askDepth === 'standard') return 16;
  if (askDepth === 'deep') return 22;
  if (askDepth === 'pilot') return 28;
  if (askDepth === 'enterprise') return 34;
  return undefined;
}

export interface MitiiAskOptions {
  profile?: 'deep' | 'concise';
  scope?: string;
  includeImpact?: boolean;
  webSearch?: boolean;
}

export interface MitiiAskResult {
  text: string;
  projects: string[];
}

export interface MitiiAskRun {
  stream(): AsyncIterable<string>;
  wait(): Promise<MitiiAskResult>;
}

export interface MitiiHeadlessAskAgent {
  ask(message: string, options?: MitiiAskOptions): Promise<MitiiAskRun>;
}

export function createSdkCompatibilityNote(): string {
  return [
    'Ask is routed through a headless AskOrchestrator.prepare() boundary.',
    'A future @mitii/sdk can wrap the same route/scope/profile/impact decisions and expose Agent.ask().',
  ].join(' ');
}
