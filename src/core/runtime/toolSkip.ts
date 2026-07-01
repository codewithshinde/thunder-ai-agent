/** Detect soft-block / dedup tool responses that are intentional skips, not failures. */
export function isSkippedToolOutput(text?: string): boolean {
  return Boolean(text && /\bSkipped redundant\b|Skipped redundant tool call|cap reached for this task/i.test(text));
}
