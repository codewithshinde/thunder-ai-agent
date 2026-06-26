export type ThunderPlan = {
  goal: string;
  assumptions: string[];
  steps: Array<{
    id: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'blocked';
    files?: string[];
    risk: 'low' | 'medium' | 'high';
  }>;
  requiredApprovals: string[];
};

export type AutonomyPreset = 'safe' | 'guided' | 'builder' | 'pilot' | 'enterprise';

export function parsePlanFromText(text: string): ThunderPlan | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]) as ThunderPlan;
    if (parsed.goal && Array.isArray(parsed.steps)) {
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
  const cmd = command.trim();
  if (!cmd) return false;
  if (/^(npx\s+)?depcheck\b/i.test(cmd)) return true;
  if (/^npm\s+(ls|list|outdated|audit)\b/i.test(cmd)) return true;
  if (/^yarn\s+(why|list|info)\b/i.test(cmd)) return true;
  if (/^pnpm\s+(why|list)\b/i.test(cmd)) return true;
  if (/^(grep|rg|find|cat|head|tail|wc|sort|uniq|ls|tree)\b/i.test(cmd)) return true;
  if (/^git\s+(status|diff|log|ls-files)\b/i.test(cmd)) return true;
  return false;
}

export function isShellAllowed(mode: string, command?: string): boolean {
  if (mode === 'act') return true;
  if (command && isReadOnlyCommand(command)) return true;
  return false;
}

export function isPatchAllowed(mode: string): boolean {
  return mode === 'act';
}
