import { z } from 'zod';

export type ToolRisk = 'low' | 'medium' | 'high';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput): Promise<ToolResult>;
}

export interface ToolCallAudit {
  toolName: string;
  input: unknown;
  result: ToolResult;
  timestamp: number;
}
