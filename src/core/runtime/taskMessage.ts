const CONTINUATION_PREFIX = /^continue the current approved task from where it paused\b/i;

/** Extract the user's real request from an approval-continuation prompt. */
export function extractOriginalTaskMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!CONTINUATION_PREFIX.test(trimmed)) return null;
  const marker = /\nOriginal user request:\s*\n/i;
  const match = marker.exec(trimmed);
  if (!match) return null;
  const original = trimmed.slice(match.index + match[0].length).trim();
  return original || null;
}

export function isApprovalContinuationMessage(message: string): boolean {
  return CONTINUATION_PREFIX.test(message.trim());
}
