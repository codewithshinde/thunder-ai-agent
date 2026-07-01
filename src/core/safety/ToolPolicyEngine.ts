import { isReadOnlyCommand } from '../plans/PlanActEngine';

export type PolicyDecision = 'allow' | 'require_approval' | 'block';

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

const DANGEROUS_COMMANDS = [
  /rm\s+-rf/i, /\bsudo\b/i, /chmod\s+-R/i, /chown\s+-R/i,
  /\bmkfs\b/i, /\bdd\b/i, /\bshutdown\b/i, /\breboot\b/i,
  /curl\s+.*\|\s*sh/i, /wget\s+.*\|\s*sh/i,
  /\bnpm\s+publish\b/i, /git\s+push\s+--force/i,
];

const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_files', 'list_files', 'search', 'search_batch', 'repo_map',
  'retrieve_context', 'git_diff', 'diagnostics', 'memory_search', 'spawn_research_agent',
  'save_task_state', 'search_script_catalog', 'execute_workspace_script', 'use_skill',
  'fetch_web', 'ask_question', 'mark_step_complete', 'propose_plan_mutation',
]);

const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'memory_write']);
const SHELL_TOOLS = new Set(['run_command']);

export interface SafetyConfig {
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  allowNetwork: boolean;
  blockDangerousCommands: boolean;
  approvalMode?: 'review_all' | 'ask_edits' | 'ask_deletes' | 'ask_commands' | 'auto';
  autonomyPreset?: string;
  allowUntrustedWorkspace?: boolean;
}

export class ToolPolicyEngine {
  constructor(
    private safetyConfig: SafetyConfig,
    private readonly isIgnoredPath: (path: string) => boolean,
    private readonly isWorkspaceTrusted: () => boolean = () => true
  ) {}

  updateSafetyConfig(safetyConfig: SafetyConfig): void {
    this.safetyConfig = safetyConfig;
  }

  evaluate(toolName: string, input: Record<string, unknown>): PolicyResult {
    const path = typeof input.path === 'string' ? input.path : undefined;
    if (path && this.isIgnoredPath(path)) {
      return { decision: 'block', reason: 'Path is ignored' };
    }

    if (
      !this.isWorkspaceTrusted() &&
      !this.safetyConfig.allowUntrustedWorkspace &&
      (WRITE_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName))
    ) {
      return {
        decision: 'block',
        reason: 'Workspace is not trusted — file writes and shell commands are disabled',
      };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      if (toolName === 'fetch_web' && !this.safetyConfig.allowNetwork) {
        return { decision: 'block', reason: 'Network access disabled' };
      }
      if (toolName === 'ask_question') {
        return { decision: 'require_approval', reason: 'Clarifying question requires user response' };
      }
      return { decision: 'allow', reason: 'Read-only tool' };
    }

    if (toolName === 'memory_write') {
      return { decision: 'allow', reason: 'Memory writes are low risk' };
    }

    if (WRITE_TOOLS.has(toolName)) {
      if (this.requiresWriteApproval()) {
        return { decision: 'require_approval', reason: 'Write operations require approval' };
      }
      return { decision: 'allow', reason: 'Writes auto-approved by policy' };
    }

    if (SHELL_TOOLS.has(toolName)) {
      const command = typeof input.command === 'string' ? input.command : '';
      if (this.safetyConfig.blockDangerousCommands && isDangerousCommand(command)) {
        return { decision: 'block', reason: 'Dangerous command blocked' };
      }
      if (isReadOnlyCommand(command)) {
        return { decision: 'allow', reason: 'Read-only inspection command' };
      }
      if (this.requiresShellApproval(command)) {
        return { decision: 'require_approval', reason: 'Shell commands require approval' };
      }
      return { decision: 'allow', reason: 'Shell auto-approved by policy' };
    }

    if (this.safetyConfig.approvalMode === 'auto') {
      return { decision: 'allow', reason: 'Unknown tool auto-approved by policy' };
    }
    return { decision: 'require_approval', reason: 'Unknown tool requires approval' };
  }

  private requiresWriteApproval(): boolean {
    switch (this.safetyConfig.approvalMode) {
      case 'auto':
      case 'ask_deletes':
      case 'ask_commands':
        return false;
      case 'ask_edits':
      case 'review_all':
        return true;
      default:
        return this.safetyConfig.requireApprovalForWrites;
    }
  }

  private requiresShellApproval(command: string): boolean {
    switch (this.safetyConfig.approvalMode) {
      case 'auto':
        return false;
      case 'ask_deletes':
        return isDeleteLikeCommand(command);
      case 'ask_edits':
        return isDeleteLikeCommand(command);
      case 'ask_commands':
      case 'review_all':
        return true;
      default:
        return this.safetyConfig.requireApprovalForShell;
    }
  }
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((p) => p.test(command));
}

export function isDeleteLikeCommand(command: string): boolean {
  return [
    /\brm\s+(?:-[^\s]*\s+)*[^\s]/i,
    /\bgit\s+rm\b/i,
    /\b(?:npm|pnpm|yarn)\s+(?:uninstall|remove|rm|prune)\b/i,
    /\bunlink\b/i,
    /\brmdir\b/i,
    /\brimraf\b/i,
    /\btrash\b/i,
    /\bfind\b[\s\S]*\s-delete\b/i,
  ].some((p) => p.test(command));
}
