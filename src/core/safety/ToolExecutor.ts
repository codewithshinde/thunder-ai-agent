import type { ToolRuntime } from '../tools/ToolRuntime';
import type { ToolPolicyEngine } from './ToolPolicyEngine';
import type { ApprovalQueue } from './ApprovalQueue';
import { isWriteAllowed, isShellAllowed, isPatchAllowed } from '../planning/PlanActEngine';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ToolExecutor');

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  pendingApproval?: boolean;
}

export class ToolExecutor {
  constructor(
    private readonly toolRuntime: ToolRuntime,
    private readonly policyEngine: ToolPolicyEngine,
    private readonly approvalQueue: ApprovalQueue,
    private readonly getSessionId: () => string,
    private readonly getMode: () => string
  ) {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const mode = this.getMode();

    if (['write_file', 'apply_patch'].includes(toolName) && !isWriteAllowed(mode)) {
      return { success: false, output: '', error: 'Writes blocked in Plan/Review mode' };
    }
    if (toolName === 'apply_patch' && !isPatchAllowed(mode)) {
      return { success: false, output: '', error: 'Patch apply blocked in Plan/Review mode' };
    }
    if (toolName === 'run_command' && !isShellAllowed(mode)) {
      return { success: false, output: '', error: 'Shell blocked in Plan/Review mode' };
    }

    const sessionId = this.getSessionId();
    const policy = this.policyEngine.evaluate(toolName, input);

    if (policy.decision === 'block') {
      return { success: false, output: '', error: policy.reason };
    }

    if (policy.decision === 'require_approval') {
      if (!this.approvalQueue.isAllowOnce(sessionId, toolName)) {
        this.approvalQueue.createRequest(sessionId, toolName, input, policy);
        return { success: false, output: '', pendingApproval: true, error: 'Awaiting approval' };
      }
    }

    const result = await this.toolRuntime.execute(toolName, input);
    log.info('Tool executed via executor', { tool: toolName, success: result.success });
    return result;
  }

  async executeApproved(toolName: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const result = await this.toolRuntime.execute(toolName, input);
    return result;
  }
}
