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
  contentLength?: number;
  toolCallId?: string;
  kind?: 'approval' | 'question';
  question?: string;
  options?: string[];
}

export type ApprovalDecision = 'approved' | 'denied';

export class ApprovalQueue {
  private pending = new Map<string, ApprovalRequest>();
  private fullInputs = new Map<string, Record<string, unknown>>();
  private allowOnce = new Set<string>();

  constructor(private readonly db?: ThunderDb) {}

  createRequest(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    policy: PolicyResult,
    metadata?: { toolCallId?: string }
  ): ApprovalRequest {
    const path = typeof input.path === 'string' ? input.path : undefined;
    const contentLen = typeof input.content === 'string' ? input.content.length : undefined;

    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId,
      toolName,
      inputPreview: buildDisplayPreview(toolName, input),
      files: path ? [path] : [],
      risk: toolName.includes('write') || toolName.includes('patch') || toolName === 'run_command' ? 'high' : 'medium',
      reason: policy.reason,
      policy,
      createdAt: Date.now(),
      contentLength: contentLen,
      toolCallId: metadata?.toolCallId,
      kind: toolName === 'ask_question' ? 'question' : 'approval',
      question: toolName === 'ask_question' && typeof input.question === 'string' ? input.question : undefined,
      options: toolName === 'ask_question' && Array.isArray(input.options)
        ? input.options.filter((o): o is string => typeof o === 'string')
        : undefined,
    };

    this.pending.set(request.id, request);
    this.fullInputs.set(request.id, input);
    return request;
  }

  getFullInput(id: string): Record<string, unknown> | undefined {
    return this.fullInputs.get(id);
  }

  resolve(id: string, decision: ApprovalDecision, reason?: string): ApprovalRequest | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;

    this.pending.delete(id);
    const fullInput = this.fullInputs.get(id);
    this.fullInputs.delete(id);

    if (decision === 'approved') {
      this.allowOnce.add(`${request.sessionId}:${request.toolName}`);
    }

    if (this.db?.tryRaw() && fullInput) {
      this.db.tryRaw()!.prepare(`
        INSERT INTO approval_audit (id, session_id, tool_name, input_json, decision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        request.sessionId,
        request.toolName,
        JSON.stringify({ path: fullInput.path, contentLength: typeof fullInput.content === 'string' ? fullInput.content.length : 0 }),
        decision,
        reason ?? null,
        Date.now()
      );
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

function buildDisplayPreview(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'ask_question' && typeof input.question === 'string') {
    const opts = Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string') : [];
    return `${input.question}${opts.length ? `\nOptions: ${opts.join(' | ')}` : ''}`;
  }
  if (toolName === 'fetch_web' && typeof input.url === 'string') {
    return `Fetch: ${input.url}`;
  }
  if (toolName === 'write_file' && typeof input.path === 'string') {
    const len = typeof input.content === 'string' ? input.content.length : 0;
    return `Write file: ${input.path} (${len.toLocaleString()} characters)`;
  }
  if (toolName === 'apply_patch' && typeof input.path === 'string') {
    return `Patch file: ${input.path}`;
  }
  if (toolName === 'run_command' && typeof input.command === 'string') {
    return `Run: ${input.command.slice(0, 200)}`;
  }
  return JSON.stringify(input).slice(0, 500);
}
