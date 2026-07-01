import { routeAskIntent } from '../ask/AskIntentRouter';
import type { TaskAnalysis, TaskComplexity } from '../../runtime/TaskAnalyzer';
import type { PlanIntent, PlanRoute } from './planTypes';

const GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay)\b/i;
const DOCS_RE = /\b(docs?|documentation|docusaurus|mdx?|examples?)\b/i;
const AUDIT_RE = /\b(audit|cleanup|clean up|unused|dead code|dependenc(?:y|ies)|knip|depcheck)\b/i;
const BUG_RE = /\b(fix|bug|broken|failing|error|debug|regression|issue)\b/i;
const REFACTOR_RE = /\b(refactor|rewrite|migrate|simplify|restructure|rename|extract)\b/i;
const FEATURE_RE = /\b(implement|build|create|add|integrate|wire|support|setup|configure|enhance)\b/i;

export function routePlanIntent(userMessage: string, taskAnalysis?: TaskAnalysis): PlanRoute {
  const text = userMessage.trim();
  const askRoute = routeAskIntent(text);
  const intent = inferPlanIntent(text, taskAnalysis);
  const complexity = taskAnalysis?.complexity ?? inferComplexity(text, intent);
  const forcePlan = shouldForcePlan(text, askRoute.intent);
  const groundingRequired = forcePlan && askRoute.intent !== 'general_knowledge';
  const shouldUseSubagents =
    groundingRequired &&
    (taskAnalysis?.shouldUseSubagents ??
      (askRoute.shouldUseSubagents ||
        complexity === 'high' ||
        intent === 'audit' ||
        intent === 'spike'));

  return {
    intent,
    complexity,
    forcePlan,
    groundingRequired,
    shouldUseSubagents,
    qualityProfile: complexity === 'high' || intent === 'audit' ? 'strict' : intent === 'question' ? 'relaxed' : 'standard',
    summary: summarizeRoute(intent, complexity, forcePlan),
  };
}

function inferPlanIntent(text: string, taskAnalysis?: TaskAnalysis): PlanIntent {
  if (taskAnalysis?.kind === 'audit' || AUDIT_RE.test(text)) return 'audit';
  if (DOCS_RE.test(text)) return 'docs';
  if (BUG_RE.test(text)) return 'bugfix';
  if (REFACTOR_RE.test(text)) return 'refactor';
  if (FEATURE_RE.test(text)) return 'feature';

  const askIntent = routeAskIntent(text).intent;
  if (askIntent === 'architecture' || askIntent === 'cross_project' || askIntent === 'implement_here') return 'spike';
  if (askIntent === 'debug_explain') return 'bugfix';
  return 'question';
}

function shouldForcePlan(text: string, askIntent: ReturnType<typeof routeAskIntent>['intent']): boolean {
  if (!text) return false;
  if (GREETING_RE.test(text) && text.length < 48) return false;
  if (askIntent === 'general_knowledge') return false;
  return true;
}

function inferComplexity(text: string, intent: PlanIntent): TaskComplexity {
  if (intent === 'audit' || intent === 'spike') return 'high';
  let score = 0;
  if (text.length > 300) score += 2;
  else if (text.length > 140) score += 1;
  if (/\b(across|all|every|whole|entire|monorepo)\b/i.test(text)) score += 2;
  if (/\b(test|lint|build|verify|ci)\b/i.test(text)) score += 1;
  if (/\b(and|then|also|after that|next)\b/i.test(text)) score += 1;
  if (score >= 4) return 'high';
  if (score >= 2 || intent === 'docs' || intent === 'refactor') return 'medium';
  return 'low';
}

function summarizeRoute(intent: PlanIntent, complexity: TaskComplexity, forcePlan: boolean): string {
  if (!forcePlan) return 'Plan mode — direct response is acceptable for this trivial/general request.';
  const labels: Record<PlanIntent, string> = {
    feature: 'feature implementation plan',
    refactor: 'refactor plan',
    bugfix: 'bugfix plan',
    audit: 'audit/cleanup plan',
    docs: 'documentation plan',
    spike: 'read-only discovery and implementation plan',
    question: 'grounded investigation plan',
  };
  return `Plan mode — produce a ${labels[intent]} (${complexity} complexity); do not execute.`;
}
