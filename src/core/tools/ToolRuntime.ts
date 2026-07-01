import type { Tool, ToolResult, ToolCallAudit } from './types';
import { normalizeToolInput } from './coerceInput';
import { resolveToolName } from './toolAliases';
import { createLogger } from '../telemetry/Logger';
import type { SessionLogService } from '../telemetry/SessionLogService';

const log = createLogger('ToolRuntime');

export class ToolRuntime {
  private tools = new Map<string, Tool>();
  private auditLog: ToolCallAudit[] = [];
  private sessionLog: SessionLogService | undefined;

  setSessionLog(sessionLog: SessionLogService): void {
    this.sessionLog = sessionLog;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  unregisterByPrefix(prefix: string): void {
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
      }
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, input: unknown): Promise<ToolResult> {
    const startedAt = Date.now();
    const resolvedName = resolveToolName(name);
    const toolCallId = createToolCallId(resolvedName);
    const normalized = normalizeToolInput(resolvedName, input);
    this.logToolStart(resolvedName, normalized, toolCallId);

    const tool = this.tools.get(resolvedName);
    if (!tool) {
      const result = {
        success: false,
        output: '',
        error: `Unknown tool: ${name}${resolvedName !== name ? ` (alias for ${resolvedName} not registered)` : ''}`,
      };
      this.logToolEnd(resolvedName, normalized, result, startedAt, toolCallId);
      return result;
    }

    const parsed = tool.inputSchema.safeParse(normalized);
    if (!parsed.success) {
      const result = { success: false, output: '', error: `Invalid input: ${parsed.error.message}` };
      this.logToolEnd(resolvedName, normalized, result, startedAt, toolCallId);
      return result;
    }

    try {
      const result = await tool.execute(parsed.data);
      this.auditLog.push({ toolName: resolvedName, input: parsed.data, result, timestamp: Date.now() });
      this.logToolEnd(resolvedName, parsed.data, result, startedAt, toolCallId);
      log.info('Tool executed', { tool: resolvedName, success: result.success });
      return result;
    } catch (error) {
      const result = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
      this.auditLog.push({ toolName: resolvedName, input: parsed.data, result, timestamp: Date.now() });
      this.logToolEnd(resolvedName, parsed.data, result, startedAt, toolCallId);
      throw error;
    }
  }

  getAuditLog(): ToolCallAudit[] {
    return [...this.auditLog];
  }

  clearAuditLog(): void {
    this.auditLog = [];
  }

  private logToolStart(name: string, input: unknown, toolCallId: string): void {
    this.sessionLog?.append('tool_start', name, {
      toolCallId,
      tool: name,
      toolName: name,
      ...extractToolLocator(input),
      inputPreview: previewValue(input),
    });
    this.sessionLog?.appendDebug('info', `debug tool_start ${name}`, {
      eventType: 'tool_start',
      toolCallId,
      tool: name,
      toolName: name,
      input,
    });
  }

  private logToolEnd(
    name: string,
    input: unknown,
    result: ToolResult,
    startedAt: number,
    toolCallId: string
  ): void {
    const durationMs = Date.now() - startedAt;
    const output = result.output || result.error || '';
    const inputPreview = previewValue(input);
    this.sessionLog?.append('tool_end', name, {
      toolCallId,
      tool: name,
      toolName: name,
      ...extractToolLocator(input),
      success: result.success,
      failure: !result.success,
      durationMs,
      inputPreview,
      outputPreview: output.slice(0, 500),
      error: result.error,
    });
    this.sessionLog?.appendDebug('info', `debug tool_end ${name}`, {
      eventType: 'tool_end',
      toolCallId,
      tool: name,
      toolName: name,
      input,
      result,
      durationMs,
    });
  }
}

function createToolCallId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractToolLocator(input: unknown): { path?: string; command?: string } {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return {
    path: typeof record.path === 'string' ? record.path : undefined,
    command: typeof record.command === 'string' ? record.command : undefined,
  };
}

function previewValue(value: unknown): string {
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return (raw ?? '').slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
