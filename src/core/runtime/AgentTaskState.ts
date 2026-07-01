import type { TaskKind } from './TaskAnalyzer';
import { isMdxRepairTask as isMdxRepairTaskText } from './mdxRepairRouting';
import {
  createPhaseActor,
  getPhaseFromActor,
  sendPhaseEvent,
  type PhaseActor,
  type TaskPhase,
} from './agentPhaseMachine';

export type { TaskPhase };

/** Tracks analyze → execute → verify phases and blocks redundant discovery. */

export interface ToolResultRecord {
  tool: string;
  key: string;
  summary: string;
  timestamp: number;
}

export class AgentTaskState {
  private phaseActor: PhaseActor = createPhaseActor();
  private taskKind: TaskKind | undefined;
  private taskSummary = '';
  private originalTask = '';
  private completedKeys = new Set<string>();
  private toolResults: ToolResultRecord[] = [];
  private pauseSummary = '';
  private executionToolsUsed = false;

  reset(): void {
    sendPhaseEvent(this.phaseActor, { type: 'RESET' });
    this.taskKind = undefined;
    this.taskSummary = '';
    this.originalTask = '';
    this.completedKeys.clear();
    this.toolResults = [];
    this.pauseSummary = '';
    this.executionToolsUsed = false;
  }

  setTaskContext(kind: TaskKind, summary: string, originalTask: string): void {
    this.taskKind = kind;
    this.taskSummary = summary;
    this.originalTask = originalTask;
  }

  getPhase(): TaskPhase {
    return getPhaseFromActor(this.phaseActor);
  }

  setPauseSummary(summary: string): void {
    this.pauseSummary = summary;
  }

  getPauseSummary(): string {
    return this.pauseSummary;
  }

  recordToolSuccess(toolName: string, input: Record<string, unknown>, output: string): void {
    if (['write_file', 'apply_patch'].includes(toolName)) {
      this.executionToolsUsed = true;
      if (this.getPhase() === 'analyze') {
        sendPhaseEvent(this.phaseActor, { type: 'ADVANCE_EXECUTE' });
      }
    }

    if (toolName === 'run_command') {
      const key = toolKey(toolName, input);
      if (
        this.shouldDiagnosticAdvanceToExecute(key) &&
        this.getPhase() === 'analyze'
      ) {
        sendPhaseEvent(this.phaseActor, { type: 'ADVANCE_EXECUTE' });
      }
    }

    if (toolName === 'execute_workspace_script') {
      const script = typeof input.script === 'string' ? input.script : '';
      if (this.isAuditTask() && /audit-dependencies|audit-dead-code/.test(script) && this.getPhase() === 'analyze') {
        sendPhaseEvent(this.phaseActor, { type: 'ADVANCE_EXECUTE' });
      }
    }

    const key = toolKey(toolName, input);
    if (!key) return;

    this.completedKeys.add(key);
    this.toolResults.push({
      tool: toolName,
      key,
      summary: output.slice(0, 2000),
      timestamp: Date.now(),
    });
    if (this.toolResults.length > 12) {
      this.toolResults = this.toolResults.slice(-12);
    }
  }

  /** Returns block reason if this tool call should be rejected. */
  checkBlocked(toolName: string, input: Record<string, unknown>): string | null {
    if (this.getPhase() === 'verify') return null;

    if (toolName === 'memory_search' && this.getPhase() === 'execute') {
      return 'Execute phase — do not call memory_search. Use chat history and tool results above.';
    }

    const key = toolKey(toolName, input);
    if (!key || !this.completedKeys.has(key)) return null;

    if (toolName === 'run_command') {
      if (this.executionToolsUsed && isPostEditVerificationKey(key)) {
        return (
          `${key} already succeeded after edits. Verification for this task is complete. ` +
          'Stop calling tools and provide the final concise summary with any remaining issues.'
        );
      }
      if (this.executionToolsUsed) return null;
      if (this.getPhase() === 'execute') {
        return `${key} already completed. Use the cached output below instead of re-running the same command.`;
      }
      return (
        `Phase 1 (Analyze) already completed: ${key} was run successfully. ` +
        this.phaseRepeatInstruction()
      );
    }

    if (toolName === 'execute_workspace_script') {
      const script = typeof input.script === 'string' ? input.script : key;
      if (this.getPhase() === 'execute') {
        return `Script ${script} already completed. Use the cached output below instead of re-running it.`;
      }
      return (
        `Script ${script} already ran this session. ` +
        'Read cached output from chat history before deciding the next exact action.'
      );
    }

    if (toolName === 'list_files') {
      if (this.getPhase() === 'execute') {
        return `Already listed \`${input.path ?? '.'}\`. Use that listing unless a file change made it stale.`;
      }
      return (
        `Already listed \`${input.path ?? '.'}\` this session. ` +
        'Use results from chat history before deciding the next exact action.'
      );
    }

    return null;
  }

  /** Actionable tool output when a redundant diagnostic is skipped (avoids error loops). */
  buildSoftBlockResponse(toolName: string, input: Record<string, unknown>): string | null {
    const reason = this.checkBlocked(toolName, input);
    if (!reason) return null;

    const key = toolKey(toolName, input);
    const cached = key ? this.toolResults.find((r) => r.key === key) : undefined;

    const lines = [
      `(Skipped redundant ${toolName} — phase: ${this.getPhase()})`,
      reason,
    ];

    if (cached) {
      lines.push('', `Cached output from ${cached.key}:`, cached.summary);
    } else if (this.toolResults.length > 0) {
      lines.push('', 'Recent diagnostic results from this session:');
      for (const r of this.toolResults.slice(-4)) {
        lines.push(`### ${r.key}`, r.summary.slice(0, 1500), '');
      }
    }

    lines.push('', '## Required next action', ...this.requiredNextActionLines());

    return lines.join('\n');
  }

  advanceToExecute(): void {
    sendPhaseEvent(this.phaseActor, { type: 'ADVANCE_EXECUTE' });
  }

  advanceToVerify(): void {
    sendPhaseEvent(this.phaseActor, { type: 'ADVANCE_VERIFY' });
  }

  buildPauseSummary(originalTask: string, taskKind?: string): string {
    const lines = [
      `Task: ${originalTask.slice(0, 200)}`,
      `Phase: ${this.getPhase()}${taskKind ? ` (${taskKind})` : ''}`,
      `Execution started: ${this.executionToolsUsed ? 'yes' : 'no'}`,
    ];

    if (this.toolResults.length > 0) {
      lines.push('', 'Completed steps:');
      for (const r of this.toolResults.slice(-6)) {
        const preview = r.summary.split('\n').slice(0, 4).join(' ').slice(0, 200);
        lines.push(`- ${r.key}: ${preview}`);
      }
    }

    const last = this.toolResults[this.toolResults.length - 1];
    if (last && !this.executionToolsUsed) {
      lines.push('', `Next step: ${this.nextStepSummary(last.key)}.`);
    } else if (this.executionToolsUsed) {
      lines.push('', 'Next step: continue execution or run Phase 3 verification (lint/test/build).');
    }

    return lines.join('\n');
  }

  buildPromptBlock(): string {
    const lines = [
      `Current phase: **${this.getPhase().toUpperCase()}** (${phaseInstructions(this.getPhase())})`,
    ];
    if (this.taskKind || this.taskSummary) {
      lines.push(`Task context: ${this.taskKind ?? 'task'}${this.taskSummary ? ` — ${this.taskSummary}` : ''}`);
    }

    if (this.completedKeys.size > 0) {
      lines.push('', 'Completed this session (do NOT repeat until Execute phase progresses):');
      for (const key of this.completedKeys) {
        lines.push(`- ${key}`);
      }
    }

    if (this.toolResults.length > 0) {
      lines.push('', 'Recent tool results:');
      for (const r of this.toolResults.slice(-4)) {
        lines.push(`### ${r.key}`, r.summary.slice(0, 1200), '');
      }
    }

    if (this.getPhase() === 'execute') {
      lines.push('', `**ACTION REQUIRED**: ${this.executePhaseInstruction()}`);
    }

    if (this.pauseSummary) {
      lines.push('', 'Saved pause state:', this.pauseSummary);
    }

    return lines.join('\n');
  }

  buildApprovalResumeInstruction(): string {
    if (this.isAuditTask()) {
      return 'Analysis phase is complete for the approved audit command output above. Proceed to Phase 2 (Execute): edit only the confirmed unused dependencies/imports/files, then verify.';
    }
    if (this.isMdxRepairTask()) {
      return 'Use the approved output above to fix only the next exact MDX/Docusaurus failure. Read the named file, patch that file, then run the docs build again. Do not guess sibling files unless the build names them.';
    }
    return 'Use the approved tool output above as current context. Continue with the smallest exact file edit or verification step required by the user request; do not restart diagnostics.';
  }

  private shouldDiagnosticAdvanceToExecute(key: string | null): boolean {
    if (!key) return false;
    if (this.isAuditTask()) {
      return key === 'depcheck' || key === 'eslint' || key === 'audit-dependencies' || key === 'audit-dead-code';
    }
    return key === 'eslint';
  }

  private phaseRepeatInstruction(): string {
    if (this.isAuditTask()) {
      return 'Do NOT re-run diagnostics. Read chat history and proceed to Phase 2 (Execute): edit only confirmed cleanup targets.';
    }
    if (this.isMdxRepairTask()) {
      return 'Do NOT re-run the same discovery command. Read the exact MDX file from the error, patch that file, then verify with the docs build.';
    }
    return 'Do NOT re-run the same command just to recover context. Use cached output, then inspect or patch the exact file named by the error.';
  }

  private requiredNextActionLines(): string[] {
    if (this.executionToolsUsed) {
      return [
        'A post-edit verification command already succeeded.',
        'Stop using tools now and answer with the final summary: what changed, verification run, and remaining issues.',
      ];
    }

    if (this.isAuditTask()) {
      return [
        'Call **write_file** or **apply_patch** for confirmed cleanup changes; do not run more broad discovery commands.',
        '- Remove unused dependencies from package.json only when audit output confirms they are unused.',
        '- Remove unused imports from source files.',
        '- Delete orphan files only after confirming they are unreferenced.',
      ];
    }

    if (this.isMdxRepairTask()) {
      return [
        'Follow the MDX repair loop:',
        '1. Read the exact MDX file named by the error.',
        '2. Read a working sibling doc in the same folder that already uses LiveCodeBlock (for example form-builder.md).',
        '3. For "Unexpected character `,` in name", code-span raw TypeScript generics in Markdown table cells.',
        '4. For "Could not parse expression with acorn", fix LiveCodeBlock syntax: use `code={` + backtick on the same line, close with `` `} ``, and do not include render() in the code string.',
        '5. For "Can\'t resolve", check workspace deps in apps/docs/package.json and run pnpm install from the monorepo root.',
        '6. Run the docs build (read package.json scripts first — do not assume npm run lint exists).',
        '7. If the build fails, fix only the next exact file from the build output.',
      ];
    }

    return [
      'Use the cached output and continue with the smallest exact next action.',
      '- If the failure names a file, read or patch that exact file.',
      '- If enough context is already present, apply the edit before running more diagnostics.',
      '- Verify with the narrowest relevant command after edits.',
    ];
  }

  private nextStepSummary(lastKey: string): string {
    if (this.isAuditTask()) {
      return `apply confirmed cleanup changes based on ${lastKey} results`;
    }
    if (this.isMdxRepairTask()) {
      return `fix the exact MDX file indicated by ${lastKey} output, then rerun the docs build`;
    }
    return `continue from ${lastKey} results with the smallest exact edit or verification step`;
  }

  private executePhaseInstruction(): string {
    if (this.isAuditTask()) {
      return 'You are in EXECUTE phase. Apply confirmed cleanup edits; do not run broad discovery again until at least one edit succeeds.';
    }
    if (this.isMdxRepairTask()) {
      return 'Patch the exact MDX file named by the error, then verify with the docs build. Do not broaden to unrelated docs.';
    }
    return 'Use cached tool output to make the smallest exact edit, or verify if edits already succeeded.';
  }

  private isAuditTask(): boolean {
    return this.taskKind === 'audit';
  }

  private isMdxRepairTask(): boolean {
    return isMdxRepairTaskText(`${this.originalTask}\n${this.taskSummary}`);
  }
}

export function toolKey(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'git_diff') {
    const staged = input.staged === true || input.cached === true;
    return staged ? 'git-diff:cached' : 'git-diff:unstaged';
  }
  if (toolName === 'run_command') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    return normalizeDiagnosticKey(cmd);
  }
  if (toolName === 'list_files') {
    const path = typeof input.path === 'string' ? input.path : '.';
    const recursive = input.recursive ? 'recursive' : 'flat';
    return `list_files:${path}:${recursive}`;
  }
  if (toolName === 'read_file' && typeof input.path === 'string') {
    return `read_file:${input.path}`;
  }
  if (toolName === 'execute_workspace_script' && typeof input.script === 'string') {
    return `script:${input.script}`;
  }
  if (toolName === 'spawn_research_agent' && typeof input.task === 'string') {
    return `research:${input.task.slice(0, 80)}`;
  }
  return null;
}

export function normalizeDiagnosticKey(command: string): string | null {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return null;
  if (/\bdepcheck\b/.test(cmd)) return 'depcheck';
  if (/\bknip\b/.test(cmd)) return 'audit-dead-code';
  if (/audit-dependencies/.test(cmd)) return 'audit-dependencies';
  if (/\beslint\b/.test(cmd)) return cmd.includes('--fix') ? 'eslint:fix' : 'eslint';
  if (/\bnpm\s+(ls|list)\b/.test(cmd)) return 'npm-ls';
  if (/\bdocusaurus\s+build\b/.test(cmd) || /\bnpm\s+run\s+build(?:\s|$)/.test(cmd)) return 'docs-build';
  if (/\bpnpm\s+--filter\s+docs\s+build\b/.test(cmd)) return 'docs-build';
  if (/\bgrep\b|\brg\b/.test(cmd)) return 'grep/rg';
  if (/\bgit\s+diff\b/.test(cmd)) {
    if (/--cached|--staged/.test(cmd)) return 'git-diff:cached';
    if (/\bhead\b/.test(cmd)) return 'git-diff:head';
    return 'git-diff:unstaged';
  }
  if (/^cat\s+.*package\.json/.test(cmd)) return 'read-package-json';
  return null;
}

function isPostEditVerificationKey(key: string): boolean {
  return key === 'docs-build' ||
    key === 'eslint' ||
    key === 'eslint:fix' ||
    key === 'npm-ls' ||
    key === 'git-diff' ||
    key.startsWith('git-diff:');
}

function phaseInstructions(phase: TaskPhase): string {
  switch (phase) {
    case 'analyze':
      return 'run diagnostics once, then move to Execute';
    case 'execute':
      return 'apply file edits and dependency changes — no more discovery';
    case 'verify':
      return 'run lint/test/build to confirm changes';
  }
}
