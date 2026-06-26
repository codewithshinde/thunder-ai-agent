import type { Tool, ToolResult, ToolCallAudit } from './types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ToolRuntime');

export class ToolRuntime {
  private tools = new Map<string, Tool>();
  private auditLog: ToolCallAudit[] = [];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: '', error: `Unknown tool: ${name}` };
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, output: '', error: `Invalid input: ${parsed.error.message}` };
    }

    const result = await tool.execute(parsed.data);
    this.auditLog.push({ toolName: name, input: parsed.data, result, timestamp: Date.now() });
    log.info('Tool executed', { tool: name, success: result.success });
    return result;
  }

  getAuditLog(): ToolCallAudit[] {
    return [...this.auditLog];
  }
}
