export type MicroTaskId = 'commit_message' | 'changelog_entry' | 'release_notes_draft';

export interface MicroTaskInput {
  userMessage: string;
  workspace: string;
}

export interface MicroTaskResult {
  id: MicroTaskId;
  content: string;
  metadata?: Record<string, unknown>;
}

const MICRO_TASK_PATTERNS: Array<[MicroTaskId, RegExp]> = [
  ['commit_message', /\b(commit message|write commit|git commit)\b/i],
  ['release_notes_draft', /\b(release notes?|what'?s new)\b/i],
  ['changelog_entry', /\b(changelog|what changed since)\b/i],
];

export function detectMicroTask(userMessage: string): MicroTaskId | null {
  const text = userMessage.trim();
  if (!text) return null;
  return MICRO_TASK_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

