/** Audit / cleanup / dependency analysis tasks (report-first, tools-heavy). */
export function isAuditCleanupTask(text: string): boolean {
  return /\b(unused|dead code|orphan|cleanup|clean up|remove unused|depcheck|dependencies audit|dependency audit|find unused|list unused|reduce bundle|tree[- ]shake)\b/i.test(
    text
  );
}

export const AUDIT_AGENT_MAX_STEPS = 30;

export const NO_TOOLS_AUDIT_NUDGE = `You responded without calling any tools. For audit/cleanup tasks you MUST use tools now:
- read_file / read_files for package.json and key entry points
- list_files (recursive) to map src/
- search / search_batch to check imports per dependency or file
- spawn_research_agent to parallelize large analyses (deps, unused files, static assets)
- run_command for depcheck, npm ls, ripgrep (read-only)

Do not describe what you will do — call the tools in this turn.`;
