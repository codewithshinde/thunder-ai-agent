import { isReadOnlyCommand } from '../planning/PlanActEngine';

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
]);

const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'memory_write']);
const SHELL_TOOLS = new Set(['run_command']);

export interface SafetyConfig {
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  allowNetwork: boolean;
  blockDangerousCommands: boolean;
  autonomyPreset?: string;
}

export class ToolPolicyEngine {
  constructor(
    private readonly safetyConfig: SafetyConfig,
    private readonly isIgnoredPath: (path: string) => boolean
  ) {}

  evaluate(toolName: string, input: Record<string, unknown>): PolicyResult {
    const path = typeof input.path === 'string' ? input.path : undefined;
    if (path && this.isIgnoredPath(path)) {
      return { decision: 'block', reason: 'Path is ignored' };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      return { decision: 'allow', reason: 'Read-only tool' };
    }

    if (toolName === 'memory_write') {
      return { decision: 'allow', reason: 'Memory writes are low risk' };
    }

    if (WRITE_TOOLS.has(toolName)) {
      if (this.safetyConfig.requireApprovalForWrites) {
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
      if (this.safetyConfig.requireApprovalForShell) {
        return { decision: 'require_approval', reason: 'Shell commands require approval' };
      }
      return { decision: 'allow', reason: 'Shell auto-approved by policy' };
    }

    return { decision: 'require_approval', reason: 'Unknown tool requires approval' };
  }
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((p) => p.test(command));
}
