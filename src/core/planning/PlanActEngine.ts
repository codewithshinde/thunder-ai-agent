export type ThunderPlan = {
  goal: string;
  assumptions: string[];
  phases?: Array<{
    id: string;
    title: string;
    phase: PlanPhase;
    objective?: string;
    steps: Array<{
      id: string;
      title: string;
      objective?: string;
      tools?: string[];
      tool?: string;
      args?: Record<string, unknown>;
      dependsOn?: string[];
      successCriteria?: string[];
      files?: string[];
      risk: 'low' | 'medium' | 'high';
    }>;
  }>;
  steps: Array<{
    id: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'blocked_by_dependency';
    phase?: PlanPhase;
    objective?: string;
    tools?: string[];
    tool?: string;
    args?: Record<string, unknown>;
    dependsOn?: string[];
    successCriteria?: string[];
    files?: string[];
    risk: 'low' | 'medium' | 'high';
  }>;
  requiredApprovals: string[];
};

export type PlanPhase = 'diagnostics' | 'review' | 'execute' | 'verify';

export type AutonomyPreset = 'safe' | 'guided' | 'builder' | 'pilot' | 'enterprise';

export function parsePlanFromText(text: string): ThunderPlan | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]) as ThunderPlan;
    if (parsed.goal && Array.isArray(parsed.phases)) {
      parsed.steps = parsed.phases.flatMap((phase, phaseIndex) =>
        (phase.steps ?? []).map((step, stepIndex) => ({
          id: step.id ?? `step-${phaseIndex + 1}-${stepIndex + 1}`,
          title: step.title,
          status: 'pending' as const,
          phase: phase.phase,
          objective: step.objective ?? phase.objective,
          tool: step.tool,
          args: step.args,
          dependsOn: step.dependsOn,
          tools: step.tools,
          successCriteria: step.successCriteria,
          files: step.files,
          risk: step.risk ?? 'medium',
        }))
      );
    }
    if (parsed.goal && Array.isArray(parsed.steps)) {
      parsed.assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
      parsed.requiredApprovals = Array.isArray(parsed.requiredApprovals) ? parsed.requiredApprovals : [];
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function isWriteAllowed(mode: string): boolean {
  return mode === 'act';
}

/** Shell commands that only inspect the repo (allowed in plan/review for audits). */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = stripLeadingCd(command).trim();
  if (!cmd) return false;
  const segments = splitShellSegments(cmd).map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlyCommandSegment);
}

function isReadOnlyCommandSegment(cmd: string): boolean {
  if (/^(npx\s+(--yes\s+)?)?depcheck\b/i.test(cmd)) return true;
  if (/^(npx\s+(--yes\s+)?)?knip\b/i.test(cmd)) return true;
  if (/^npx\s+eslint\b/i.test(cmd) && !/\s--fix\b/.test(cmd)) return true;
  if (/^npm\s+(ls|list|outdated|audit|run\s+(lint|test|typecheck|check|build))\b/i.test(cmd)) return true;
  if (/^yarn\s+(why|list|info|lint|test|build)\b/i.test(cmd)) return true;
  if (/^pnpm\s+(why|list|lint|test|build)\b/i.test(cmd)) return true;
  if (/^(grep|rg|find|cat|head|tail|sed|wc|sort|uniq|ls|tree|which|echo)\b/i.test(cmd)) return true;
  if (/^git\s+(status|diff|log|ls-files)\b/i.test(cmd)) return true;
  return false;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }

    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }

    if (ch === ';' || (ch === '&' && next === '&') || ch === '|' || (ch === '|' && next === '|')) {
      segments.push(current);
      current = '';
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i += 1;
      continue;
    }

    current += ch;
  }

  segments.push(current);
  return segments;
}

export function stripLeadingCd(command: string): string {
  const match = command.trim().match(/^cd\s+(?:"[^"]+"|'[^']+'|[^\s&;|]+)\s*&&\s*([\s\S]+)$/i);
  return match ? match[1].trim() : command.trim();
}

export function isShellAllowed(mode: string, command?: string): boolean {
  if (mode === 'act') return true;
  if (command && isReadOnlyCommand(command)) return true;
  return false;
}

export function isPatchAllowed(mode: string): boolean {
  return mode === 'act';
}

export function inferStepPhase(title: string, index: number): PlanPhase {
  const text = title.toLowerCase();
  if (/\b(verify|test|lint|build|validate)\b/.test(text)) return 'verify';
  if (/\b(execute|implement|edit|patch|write|remove|update|fix|rewrite|redesign|overhaul|refactor|prepare|theme|style|component)\b/.test(text)) {
    return 'execute';
  }
  if (/\b(review|cross-check|confirm|decide)\b/.test(text)) return 'review';
  if (/\b(audit|inspect|analyze|read|identify|diagnostic)\b/.test(text)) return 'diagnostics';
  return index === 0 ? 'diagnostics' : 'execute';
}

const WRITE_INTENT_PATTERN =
  /\b(fix|rewrite|redesign|overhaul|implement|refactor|update|patch|write|prepare|create|add|remove|migrate|build|style|theme|component)\b/i;

export function stepImpliesWrite(step: {
  title: string;
  objective?: string;
  tools?: string[];
  files?: string[];
}): boolean {
  const text = `${step.title} ${step.objective ?? ''}`;
  const lower = text.toLowerCase();
  if (step.tools?.some((t) => ['write_file', 'apply_patch'].includes(t))) return true;
  if (
    /\b(audit|inspect|analyze|diagnostic|identify)\b/.test(lower) &&
    !/\b(fix|rewrite|redesign|overhaul|implement|refactor|update|patch|write|prepare|create|add|remove|migrate|build|style|theme|component)\b/.test(lower)
  ) {
    return false;
  }
  if (WRITE_INTENT_PATTERN.test(text)) return true;
  return false;
}

/** Resolve the effective phase lock for a plan step (Act mode upgrades write steps stuck in diagnostics). */
export function resolveStepPhaseLock(
  step: {
    title: string;
    objective?: string;
    phase?: PlanPhase;
    tools?: string[];
    files?: string[];
  },
  mode: string
): PlanPhase | undefined {
  const declared = step.phase ?? inferStepPhase(step.title, 0);
  if (mode !== 'act') return declared;
  if (
    stepImpliesWrite(step) &&
    (declared === 'diagnostics' || declared === 'review')
  ) {
    return 'execute';
  }
  return declared;
}

export function isPhaseLockWriteError(error?: string): boolean {
  return Boolean(error?.includes('file writes are locked until Phase 3'));
}

export function isToolAllowedInPlanPhase(
  phase: PlanPhase | undefined,
  toolName: string,
  input: Record<string, unknown>
): { allowed: boolean; reason?: string } {
  if (!phase) return { allowed: true };

  if (phase === 'diagnostics' || phase === 'review') {
    if (['write_file', 'apply_patch'].includes(toolName)) {
      return {
        allowed: false,
        reason: `${phaseLabel(phase)} is read-only; file writes are locked until Phase 3 (Execute). If analysis is complete, stop retrying writes — the orchestrator advances steps automatically.`,
      };
    }
    if (toolName === 'run_command' && !isReadOnlyCommand(typeof input.command === 'string' ? input.command : '')) {
      return {
        allowed: false,
        reason: `${phaseLabel(phase)} allows only read-only shell commands.`,
      };
    }
  }

  if (phase === 'verify') {
    if (toolName === 'run_command' && !isReadOnlyCommand(typeof input.command === 'string' ? input.command : '')) {
      return {
        allowed: false,
        reason: 'Phase 4 (Verify) allows diagnostics, lint, tests, builds, and targeted file fixes, not arbitrary shell commands.',
      };
    }
  }

  return { allowed: true };
}

function phaseLabel(phase: PlanPhase): string {
  switch (phase) {
    case 'diagnostics':
      return 'Phase 1 (Diagnostics)';
    case 'review':
      return 'Phase 2 (Review)';
    case 'execute':
      return 'Phase 3 (Execute)';
    case 'verify':
      return 'Phase 4 (Verify)';
  }
}
