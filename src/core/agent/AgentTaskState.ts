/** Tracks analyze → execute → verify phases and blocks redundant discovery. */

export type TaskPhase = 'analyze' | 'execute' | 'verify';

export interface ToolResultRecord {
  tool: string;
  key: string;
  summary: string;
  timestamp: number;
}

export class AgentTaskState {
  private phase: TaskPhase = 'analyze';
  private completedKeys = new Set<string>();
  private toolResults: ToolResultRecord[] = [];
  private pauseSummary = '';
  private executionToolsUsed = false;

  reset(): void {
    this.phase = 'analyze';
    this.completedKeys.clear();
    this.toolResults = [];
    this.pauseSummary = '';
    this.executionToolsUsed = false;
  }

  getPhase(): TaskPhase {
    return this.phase;
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
      if (this.phase === 'analyze') {
        this.phase = 'execute';
      }
    }

    if (toolName === 'run_command') {
      const key = toolKey(toolName, input);
      if ((key === 'depcheck' || key === 'eslint' || key === 'audit-dependencies' || key === 'audit-dead-code') && this.phase === 'analyze') {
        this.phase = 'execute';
      }
    }

    if (toolName === 'execute_workspace_script') {
      const script = typeof input.script === 'string' ? input.script : '';
      if (/audit-dependencies|audit-dead-code/.test(script) && this.phase === 'analyze') {
        this.phase = 'execute';
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
    if (this.phase === 'verify') return null;

    if (toolName === 'memory_search' && this.phase === 'execute') {
      return 'Execute phase — do not call memory_search. Use chat history and tool results above.';
    }

    const key = toolKey(toolName, input);
    if (!key || !this.completedKeys.has(key)) return null;

    if (this.executionToolsUsed) return null;

    if (toolName === 'run_command') {
      if (this.phase === 'execute') {
        return `${key} already completed. Use write_file or apply_patch to apply changes (see cached output below).`;
      }
      return (
        `Phase 1 (Analyze) already completed: ${key} was run successfully. ` +
        'Do NOT re-run diagnostics. Read chat history and proceed to Phase 2 (Execute): edit files and update package.json.'
      );
    }

    if (toolName === 'execute_workspace_script') {
      const script = typeof input.script === 'string' ? input.script : key;
      if (this.phase === 'execute') {
        return `Script ${script} already completed. Use write_file or apply_patch to apply findings.`;
      }
      return (
        `Script ${script} already ran this session. ` +
        'Read cached output from chat history. Proceed to Phase 2 (Execute).'
      );
    }

    if (toolName === 'list_files') {
      if (this.phase === 'execute') {
        return `Already listed \`${input.path ?? '.'}\`. Proceed with write_file/apply_patch.`;
      }
      return (
        `Already listed \`${input.path ?? '.'}\` this session. ` +
        'Use results from chat history. Proceed to Phase 2 (Execute).'
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
      `(Skipped redundant ${toolName} — phase: ${this.phase})`,
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

    lines.push(
      '',
      '## Required next action',
      'Call **write_file** or **apply_patch** now — do not run more discovery commands.',
      '- Remove unused dependencies from package.json (from depcheck output above)',
      '- Remove unused imports from source files',
      '- Delete orphan files only after confirming they are unreferenced',
    );

    return lines.join('\n');
  }

  advanceToExecute(): void {
    this.phase = 'execute';
  }

  advanceToVerify(): void {
    this.phase = 'verify';
  }

  buildPauseSummary(originalTask: string, taskKind?: string): string {
    const lines = [
      `Task: ${originalTask.slice(0, 200)}`,
      `Phase: ${this.phase}${taskKind ? ` (${taskKind})` : ''}`,
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
      lines.push('', `Next step: apply changes based on ${last.key} results (remove unused deps/imports, delete orphan files).`);
    } else if (this.executionToolsUsed) {
      lines.push('', 'Next step: continue execution or run Phase 3 verification (lint/test/build).');
    }

    return lines.join('\n');
  }

  buildPromptBlock(): string {
    const lines = [
      `Current phase: **${this.phase.toUpperCase()}** (${phaseInstructions(this.phase)})`,
    ];

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

    if (this.phase === 'execute') {
      lines.push('', '**ACTION REQUIRED**: You are in EXECUTE phase. Call write_file or apply_patch next — do not run run_command for discovery.');
    }

    if (this.pauseSummary) {
      lines.push('', 'Saved pause state:', this.pauseSummary);
    }

    return lines.join('\n');
  }
}

export function toolKey(toolName: string, input: Record<string, unknown>): string | null {
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
  if (/\bgrep\b|\brg\b/.test(cmd)) return 'grep/rg';
  if (/\bgit\s+diff\b/.test(cmd)) return 'git-diff';
  if (/^cat\s+.*package\.json/.test(cmd)) return 'read-package-json';
  return null;
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
