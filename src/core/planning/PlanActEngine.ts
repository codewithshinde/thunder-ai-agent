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

export function isShellAllowed(mode: string): boolean {
  return mode === 'act';
}

export function isPatchAllowed(mode: string): boolean {
  return mode === 'act';
}
