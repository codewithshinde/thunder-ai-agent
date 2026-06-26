import { randomUUID } from 'crypto';
import type { PolicyResult } from './ToolPolicyEngine';
import type { ThunderDb } from '../indexing/ThunderDb';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  inputPreview: string;
  files: string[];
  risk: 'low' | 'medium' | 'high';
  reason: string;
  policy: PolicyResult;
  createdAt: number;
}

export type ApprovalDecision = 'approved' | 'denied';

export class ApprovalQueue {
  private pending = new Map<string, ApprovalRequest>();
  private allowOnce = new Set<string>();

  constructor(private readonly db?: ThunderDb) {}

  createRequest(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    policy: PolicyResult
  ): ApprovalRequest {
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId,
      toolName,
      inputPreview: JSON.stringify(input).slice(0, 500),
      files: typeof input.path === 'string' ? [input.path] : [],
      risk: toolName.includes('write') || toolName.includes('patch') || toolName === 'run_command' ? 'high' : 'medium',
      reason: policy.reason,
      policy,
      createdAt: Date.now(),
    };
    this.pending.set(request.id, request);
    return request;
  }

  resolve(id: string, decision: ApprovalDecision, reason?: string): ApprovalRequest | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;

    this.pending.delete(id);
    if (decision === 'approved') {
      this.allowOnce.add(`${request.sessionId}:${request.toolName}`);
    }

    if (this.db) {
      this.db.raw.prepare(`
        INSERT INTO approval_audit (id, session_id, tool_name, input_json, decision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.sessionId, request.toolName, request.inputPreview, decision, reason ?? null, Date.now());
    }

    return request;
  }

  isAllowOnce(sessionId: string, toolName: string): boolean {
    const key = `${sessionId}:${toolName}`;
    if (this.allowOnce.has(key)) {
      this.allowOnce.delete(key);
      return true;
    }
    return false;
  }

  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values());
  }
}
