import { extractOriginalTaskMessage, isApprovalContinuationMessage } from './taskMessage';

export type TaskKind = 'question' | 'audit' | 'simple_edit' | 'implementation' | 'explicit_plan';

export type TaskComplexity = 'low' | 'medium' | 'high';

export interface TaskAnalysis {
  kind: TaskKind;
  complexity: TaskComplexity;
  shouldPlan: boolean;
  shouldVerify: boolean;
  shouldUseSubagents: boolean;
  summary: string;
}

const ACTION_VERBS =
  /\b(implement|build|create|add|fix|refactor|migrate|rewrite|update|remove|delete|integrate|wire|connect|setup|configure|optimize|debug|test)\b/i;

const EXPLICIT_PLAN =
  /step[- ]by[- ]step|break(?: it)? down|multi[- ]step|\b(create|make) a plan\b|\bplan (?:this|out)\b|execution plan/i;

const QUESTION =
  /^(what|how|why|where|when|who|which|explain|describe|tell me|show me|list|summarize|overview)\b/i;

const SIMPLE_EDIT =
  /\b(fix typo|rename|change (?:the )?(?:name|text|label)|update import|add comment|format)\b/i;

const AUDIT_CLEANUP =
  /\b(unus[a-z]*|dead code|orphan|cleanup|clean up|remove\s+(?:all\s+)?(?:the\s+)?(?:(?:uns[a-z]*|unused)\s+)?(?:imports?|files?|dependenc(?:y|ies)?)|depcheck|dependencies audit|dependency audit|find unused|list unused|reduce bundle|tree[- ]shake)\b/i;

export function analyzeTask(userMessage: string, mode: string): TaskAnalysis {
  const text = userMessage.trim();
  const isContinuation = isApprovalContinuationMessage(text);
  const taskText = extractOriginalTaskMessage(text) ?? text;

  if (isContinuation) {
    const original = classifyTask(taskText);
    return {
      ...original,
      shouldPlan: mode === 'plan' ? original.shouldPlan : false,
      shouldUseSubagents: false,
      summary: mode === 'plan'
        ? `Plan-mode continuation review — do not execute: ${original.summary}`
        : `Approval continuation — resume: ${original.summary}`,
    };
  }

  const classified = classifyTask(taskText);
  if (mode === 'plan') {
    return {
      ...classified,
      shouldVerify: false,
      shouldUseSubagents: classified.shouldUseSubagents || classified.kind === 'audit',
      summary: `${classified.summary} Plan mode — produce the plan only; do not execute.`,
    };
  }

  if (mode !== 'act') {
    return {
      kind: 'question',
      complexity: 'low',
      shouldPlan: false,
      shouldVerify: false,
      shouldUseSubagents: false,
      summary: 'Non-act mode — respond without execution.',
    };
  }

  return classified;
}

function classifyTask(text: string): TaskAnalysis {
  const lower = text.toLowerCase();

  if (AUDIT_CLEANUP.test(text)) {
    return {
      kind: 'audit',
      complexity: 'high',
      shouldPlan: true,
      shouldVerify: true,
      shouldUseSubagents: true,
      summary: 'Audit/cleanup task — plan scan steps, verify before removal.',
    };
  }

  if (EXPLICIT_PLAN.test(text)) {
    return {
      kind: 'explicit_plan',
      complexity: estimateComplexity(text),
      shouldPlan: true,
      shouldVerify: true,
      shouldUseSubagents: text.length > 200,
      summary: 'User requested explicit step-by-step plan.',
    };
  }

  if (QUESTION.test(lower) && !ACTION_VERBS.test(text)) {
    return {
      kind: 'question',
      complexity: 'low',
      shouldPlan: false,
      shouldVerify: false,
      shouldUseSubagents: false,
      summary: 'Informational question — answer directly.',
    };
  }

  if (SIMPLE_EDIT.test(text) && text.length < 120) {
    return {
      kind: 'simple_edit',
      complexity: 'low',
      shouldPlan: false,
      shouldVerify: true,
      shouldUseSubagents: false,
      summary: 'Small targeted edit — execute directly with validation.',
    };
  }

  const actionCount = (text.match(ACTION_VERBS) ?? []).length;
  const connectorCount = (text.match(/\b(and|then|also|after that|next)\b/gi) ?? []).length;
  const fileMentions = (text.match(/[`'"]?[\w./-]+\.(tsx?|jsx?|py|go|rs|json|md|css|scss|yaml|yml)[`'"]?/gi) ?? []).length;
  const complexity = estimateComplexity(text);

  const isImplementation =
    actionCount >= 1 &&
    (connectorCount >= 1 || fileMentions >= 2 || text.length > 140 || complexity !== 'low');

  if (isImplementation) {
    return {
      kind: 'implementation',
      complexity,
      shouldPlan: true,
      shouldVerify: true,
      shouldUseSubagents: complexity === 'high',
      summary: `Implementation task (${complexity} complexity) — analyze, plan, execute step-by-step, verify.`,
    };
  }

  if (actionCount >= 1) {
    return {
      kind: 'simple_edit',
      complexity: 'low',
      shouldPlan: false,
      shouldVerify: true,
      shouldUseSubagents: false,
      summary: 'Single-action task — execute with post-edit validation.',
    };
  }

  return {
    kind: 'question',
    complexity: 'low',
    shouldPlan: false,
    shouldVerify: false,
    shouldUseSubagents: false,
    summary: 'General request — respond with tools as needed.',
  };
}

function estimateComplexity(text: string): TaskComplexity {
  let score = 0;
  if (text.length > 300) score += 2;
  else if (text.length > 150) score += 1;

  const connectors = text.match(/\b(and|then|also|after that|next)\b/gi)?.length ?? 0;
  if (connectors >= 3) score += 2;
  else if (connectors >= 1) score += 1;

  const actions = text.match(/\b(implement|build|migrate|refactor|rewrite|integrate)\b/gi)?.length ?? 0;
  if (actions >= 2) score += 2;
  else if (actions >= 1) score += 1;

  const files = text.match(/[`'"]?[\w./-]+\.(tsx?|jsx?|py|go|rs)[`'"]?/gi)?.length ?? 0;
  if (files >= 3) score += 2;
  else if (files >= 1) score += 1;

  if (/\b(entire|whole|all|across|every|full)\b/i.test(text)) score += 1;
  if (/\b(test|lint|build|ci)\b/i.test(text)) score += 1;

  if (score >= 5) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

export function shouldDecomposeTask(userMessage: string, mode: string): boolean {
  return analyzeTask(userMessage, mode).shouldPlan;
}
