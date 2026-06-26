import type { LlmProvider } from '../llm/types';
import type { ToolDefinition } from '../llm/toolTypes';
import type { ToolExecutor } from '../safety/ToolExecutor';
import { AgentLoop } from './AgentLoop';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ResearchAgent');

const RESEARCH_SYSTEM = `You are a read-only research subagent. Investigate ONLY the assigned task.
Use read_file, read_files, list_files, search, search_batch, repo_map, and read-only run_command.
Return a concise report: findings, file paths, confidence (high/medium/low). Do NOT edit files.`;

const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'read_files',
  'list_files',
  'search',
  'search_batch',
  'repo_map',
  'retrieve_context',
  'git_diff',
  'diagnostics',
  'memory_search',
  'run_command',
]);

export class ResearchAgent {
  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly maxSteps = 10
  ) {}

  async run(
    provider: LlmProvider,
    task: string,
    focus: string | undefined,
    allTools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<string> {
    const tools = allTools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.function.name));
    const loop = new AgentLoop(this.toolExecutor, this.maxSteps);

    const userContent = focus
      ? `## Focus\n${focus}\n\n## Task\n${task}`
      : task;

    const messages = [
      { role: 'system' as const, content: RESEARCH_SYSTEM },
      { role: 'user' as const, content: userContent },
    ];

    const result = await loop.runToCompletion(provider, messages, tools, signal, undefined, false);
    log.info('Research subagent finished', { task: task.slice(0, 80), toolCalls: result.toolCallsMade });
    return result.fullContent || '(no findings)';
  }
}
