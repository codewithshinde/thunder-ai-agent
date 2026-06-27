import type { ToolRuntime } from '../tools/ToolRuntime';
import type { ToolPolicyEngine } from './ToolPolicyEngine';
import type { ApprovalQueue } from './ApprovalQueue';
import type { AgentTaskState } from '../agent/AgentTaskState';
import {
  isWriteAllowed,
  isShellAllowed,
  isPatchAllowed,
  isReadOnlyCommand,
  isToolAllowedInPlanPhase,
  type PlanPhase,
} from '../planning/PlanActEngine';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ToolExecutor');

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  pendingApproval?: boolean;
}

export interface ToolExecuteContext {
  toolCallId?: string;
  phaseLock?: PlanPhase;
  restrictRunCommandToReadOnly?: boolean;
}

export class ToolExecutor {
  private planPhaseLockOverride?: PlanPhase;

  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly policyEngine: ToolPolicyEngine,
    private readonly approvalQueue: ApprovalQueue,
    private readonly getSessionId: () => string,
    private readonly getMode: () => string,
    private readonly onPendingApproval?: () => void,
    private readonly getTaskState?: () => AgentTaskState | undefined
  ) {}

  setPlanPhaseLock(phase?: PlanPhase): void {
    this.planPhaseLockOverride = phase;
  }

  clearPlanPhaseLock(): void {
    this.planPhaseLockOverride = undefined;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    context?: ToolExecuteContext
  ): Promise<ToolExecutionResult> {
    const mode = this.getMode();

    const effectivePhaseLock = context?.phaseLock ?? this.planPhaseLockOverride;
    const phaseCheck = isToolAllowedInPlanPhase(effectivePhaseLock, toolName, input);
    if (!phaseCheck.allowed) {
      return { success: false, output: '', error: phaseCheck.reason ?? 'Tool blocked by current plan phase' };
    }

    if (
      context?.restrictRunCommandToReadOnly &&
      toolName === 'run_command' &&
      !isReadOnlyCommand(typeof input.command === 'string' ? input.command : '')
    ) {
      return {
        success: false,
        output: '',
        error: 'Generic run_command is restricted to read-only commands during high-complexity audit tasks. Use execute_workspace_script for approved helper scripts.',
      };
    }

    const blocked = this.getTaskState?.()?.checkBlocked(toolName, input);
    if (blocked) {
      const soft = this.getTaskState?.()?.buildSoftBlockResponse(toolName, input);
      return { success: true, output: soft ?? blocked };
    }

    if (['write_file', 'apply_patch'].includes(toolName) && !isWriteAllowed(mode)) {
      return { success: false, output: '', error: 'Writes blocked in Plan/Review mode' };
    }
    if (toolName === 'apply_patch' && !isPatchAllowed(mode)) {
      return { success: false, output: '', error: 'Patch apply blocked in Plan/Review mode' };
    }
    if (toolName === 'run_command' && !isShellAllowed(mode, typeof input.command === 'string' ? input.command : undefined)) {
      return { success: false, output: '', error: 'Shell blocked in Plan/Review mode (read-only commands like depcheck/grep are allowed)' };
    }

    const sessionId = this.getSessionId();
    const policy = this.policyEngine.evaluate(toolName, input);

    if (policy.decision === 'block') {
      return { success: false, output: '', error: policy.reason };
    }

    if (policy.decision === 'require_approval') {
      if (!this.approvalQueue.isAllowOnce(sessionId, toolName)) {
        this.approvalQueue.createRequest(sessionId, toolName, input, policy, {
          toolCallId: context?.toolCallId,
        });
        this.onPendingApproval?.();
        return { success: false, output: '', pendingApproval: true, error: 'Awaiting approval' };
      }
    }

    const result = await this.toolRuntime.execute(toolName, input);
    log.info('Tool executed via executor', { tool: toolName, success: result.success });
    if (result.success) {
      this.getTaskState?.()?.recordToolSuccess(toolName, input, result.output);
    }
    return result;
  }

  async executeApproved(toolName: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const result = await this.toolRuntime.execute(toolName, input);
    if (result.success) {
      this.getTaskState?.()?.recordToolSuccess(toolName, input, result.output);
    }
    return result;
  }
}
