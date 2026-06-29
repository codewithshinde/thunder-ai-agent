import { extractFileMentions } from './fuzzyFileMatch';

const INTERNAL_AGENT_PATH =
  /(^|\/)(?:\.git|\.mitii|\.thunder|node_modules|dist|build|out)(?:\/|$)/i;

/** User is asking about errors, lint, or fixing broken code. */
export function isDiagnosticsRelevant(text: string): boolean {
  return /\b(error|errors|lint|diagnostic|typecheck|fix|broken|failing|warning|warnings|compile|build fail|doesn'?t work|not working|bug)\b/i.test(
    text
  );
}

/** User is asking about the active selection or "this file". */
export function isExplicitEditorReference(text: string): boolean {
  return /\b(this file|current file|open file|here|selected|selection|above code|below code)\b/i.test(
    text
  );
}

/** Whether a file path should be injected as passive editor/tab context. */
export function isFileContextRelevant(
  userMessage: string,
  relPath: string,
  options?: { hasSelection?: boolean }
): boolean {
  if (isInternalAgentPath(relPath)) {
    return false;
  }

  const mentions = extractFileMentions(userMessage);
  const base = relPath.split('/').pop() ?? relPath;
  const stem = base.replace(/\.[^.]+$/, '');

  if (mentions.some((m) => relPath.endsWith(m) || m.endsWith(base) || relPath.includes(m))) {
    return true;
  }

  if (userMessage.includes(relPath) || userMessage.includes(base) || userMessage.includes(stem)) {
    return true;
  }

  if (options?.hasSelection && isExplicitEditorReference(userMessage)) {
    return true;
  }

  return false;
}

export function isInternalAgentPath(relPath: string): boolean {
  return INTERNAL_AGENT_PATH.test(relPath.replace(/\\/g, '/'));
}

/** Score passive editor/tab context — query-relevant files rank higher. */
export function scorePassiveFileContext(
  userMessage: string,
  relPath: string,
  options?: { hasSelection?: boolean }
): number {
  if (!isFileContextRelevant(userMessage, relPath, options)) {
    return 0;
  }
  if (options?.hasSelection) {
    return 10;
  }
  return 6;
}
