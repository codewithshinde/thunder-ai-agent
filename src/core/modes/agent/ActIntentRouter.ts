import type { ThunderMode } from '../../session/ThunderSession';
import type { TaskAnalysis } from '../../runtime/TaskAnalyzer';
import { isApprovalContinuationMessage } from '../../runtime/taskMessage';
import type { ActRoute } from './actTypes';

export interface ActRouteOptions {
  mode?: ThunderMode;
  hasActivePlan?: boolean;
  orchestrationEnabled?: boolean;
  auditMode?: boolean;
  mdxRepairMode?: boolean;
  githubIssueMode?: boolean;
}

const DOCS_HINT = /\b(docs?|documentation|docusaurus|mdx?|examples?)\b/i;
const REFACTOR_HINT = /\b(refactor|rewrite|migrate|cleanup architecture|restructure)\b/i;
const BUGFIX_HINT = /\b(fix|debug|repair|failing|failed|error|bug|regression|broken|crash|compile|test failure)\b/i;

const PLAN_NOUN_RESUME =
  /\b(execute|run|start|continue|resume|apply|implement|finish|complete|carry out)\b[\s\S]{0,80}\b(?:the|this|that|saved|approved|current|existing)?\s*plan\b/i;

const PLAN_NOUN_REVERSE =
  /\b(?:the|this|that|saved|approved|current|existing)?\s*plan\b[\s\S]{0,80}\b(execute|run|start|continue|resume|apply|implement|finish|complete|carry out)\b/i;

const IMPLICIT_APPROVAL_RESUME =
  /^(?:yes|yep|yeah|ok|okay|approved?|looks good|go ahead|do it|ship it|proceed|continue|resume|start|run it|execute it|implement it|apply it|make the changes|finish it|fix it|let'?s do it)[.!\s]*$/i;

export function routeActIntent(userMessage: string, analysis: TaskAnalysis, options: ActRouteOptions = {}): ActRoute {
  const mode = options.mode ?? 'agent';
  const auditMode = Boolean(options.auditMode || analysis.kind === 'audit');
  const mdxRepairMode = Boolean(options.mdxRepairMode);
  const githubIssueMode = Boolean(options.githubIssueMode);
  const hasActivePlan = Boolean(options.hasActivePlan);
  const orchestrationEnabled = options.orchestrationEnabled ?? true;

  if (mode !== 'agent') {
    return {
      intent: 'question',
      executionPath: 'direct',
      complexity: 'low',
      shouldUsePlanner: false,
      shouldUseSubagents: false,
      shouldVerify: false,
      summary: 'Non-Agent mode route — do not execute Act workflow.',
    };
  }

  if (!isApprovalContinuationMessage(userMessage) && shouldResumeSavedPlan(userMessage, hasActivePlan)) {
    return {
      intent: 'resume_plan',
      executionPath: 'resume_saved_plan',
      complexity: analysis.complexity,
      shouldUsePlanner: false,
      shouldUseSubagents: false,
      shouldVerify: true,
      summary: 'Resume the active saved plan instead of replanning or starting a direct task.',
    };
  }

  if (auditMode) {
    return {
      intent: 'audit',
      executionPath: 'audit',
      complexity: 'high',
      shouldUsePlanner: false,
      shouldUseSubagents: false,
      shouldVerify: true,
      summary: 'Audit/cleanup Act route — use script-first direct execution with read-only discovery before writes.',
    };
  }

  if (mdxRepairMode) {
    return {
      intent: 'mdx_repair',
      executionPath: 'mdx_repair',
      complexity: 'low',
      shouldUsePlanner: false,
      shouldUseSubagents: false,
      shouldVerify: true,
      summary: 'MDX repair Act route — fix the exact build-output file and rerun docs verification.',
    };
  }

  const shouldUsePlanner = shouldUsePlannerForAct(analysis, orchestrationEnabled, auditMode);
  if (githubIssueMode) {
    return {
      intent: 'bugfix',
      executionPath: shouldUsePlanner ? 'orchestrated' : 'direct',
      complexity: analysis.complexity,
      shouldUsePlanner,
      shouldUseSubagents: analysis.shouldUseSubagents,
      shouldVerify: true,
      summary: shouldUsePlanner
        ? 'GitHub issue Act route — plan from structured issue context, execute the fix, and verify.'
        : 'GitHub issue Act route — investigate issue context, make a focused fix, and verify.',
    };
  }

  const intent = inferActIntent(userMessage, analysis);

  return {
    intent,
    executionPath: shouldUsePlanner ? 'orchestrated' : 'direct',
    complexity: analysis.complexity,
    shouldUsePlanner,
    shouldUseSubagents: analysis.shouldUseSubagents,
    shouldVerify: analysis.shouldVerify,
    summary: shouldUsePlanner
      ? `${intentLabel(intent)} Act route — plan, execute, and verify step-by-step.`
      : `${intentLabel(intent)} Act route — execute directly with focused validation.`,
  };
}

export function shouldResumeSavedPlan(userMessage: string, hasActivePlan: boolean): boolean {
  if (!hasActivePlan) return false;
  const text = userMessage.trim();
  if (!text) return false;
  return PLAN_NOUN_RESUME.test(text) ||
    PLAN_NOUN_REVERSE.test(text) ||
    IMPLICIT_APPROVAL_RESUME.test(text);
}

export function shouldUsePlannerForAct(
  analysis: TaskAnalysis,
  orchestrationEnabled: boolean,
  auditMode = false
): boolean {
  if (!analysis.shouldPlan) return false;
  if (!orchestrationEnabled) return false;
  if (auditMode) return false;
  return true;
}

function inferActIntent(userMessage: string, analysis: TaskAnalysis): ActRoute['intent'] {
  if (analysis.kind === 'audit') return 'audit';
  if (analysis.kind === 'question') return 'question';
  if (DOCS_HINT.test(userMessage)) return 'docs';
  if (REFACTOR_HINT.test(userMessage)) return 'refactor';
  if (BUGFIX_HINT.test(userMessage) || analysis.kind === 'simple_edit') return 'bugfix';
  if (analysis.kind === 'implementation' || analysis.kind === 'explicit_plan') return 'feature';
  return 'direct';
}

function intentLabel(intent: ActRoute['intent']): string {
  return intent.replace(/_/g, ' ');
}
