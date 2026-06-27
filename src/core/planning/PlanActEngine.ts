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
  const segments = cmd.split(/\s*(?:&&|\|\|?|\;)\s*/).map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlyCommandSegment);
}

function isReadOnlyCommandSegment(cmd: string): boolean {
  if (/^(npx\s+(--yes\s+)?)?depcheck\b/i.test(cmd)) return true;
  if (/^(npx\s+(--yes\s+)?)?knip\b/i.test(cmd)) return true;
  if (/^npx\s+eslint\b/i.test(cmd) && !/\s--fix\b/.test(cmd)) return true;
  if (/^npm\s+(ls|list|outdated|audit|run\s+(lint|test|typecheck|check))\b/i.test(cmd)) return true;
  if (/^yarn\s+(why|list|info|lint|test|build)\b/i.test(cmd)) return true;
  if (/^pnpm\s+(why|list|lint|test|build)\b/i.test(cmd)) return true;
  if (/^(grep|rg|find|cat|head|tail|wc|sort|uniq|ls|tree|which|echo)\b/i.test(cmd)) return true;
  if (/^git\s+(status|diff|log|ls-files)\b/i.test(cmd)) return true;
  return false;
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
        reason: `${phaseLabel(phase)} is read-only; file writes are locked until Phase 3 (Execute).`,
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
