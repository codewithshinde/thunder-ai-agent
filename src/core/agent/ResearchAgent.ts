import type { LlmProvider } from '../llm/types';
import type { ToolDefinition } from '../llm/toolTypes';
import type { ToolExecutor } from '../safety/ToolExecutor';
import { AgentLoop } from './AgentLoop';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ResearchAgent');

const DEFAULT_RESEARCH_SYSTEM = `You are a read-only research subagent. Investigate ONLY the assigned task.
Use read_file, read_files, list_files, search, search_batch, repo_map, and read-only run_command.

Rules:
- Complete in ≤4 tool rounds. Be fast and focused.
- Batch reads/searches in parallel when possible.
- Return a concise report (max 400 words): findings, file paths, confidence (high/medium/low).
- Do NOT edit files. Do NOT explore unrelated areas.

NEVER enumerate npm dependencies via search/read_file loops — the main agent must use
execute_workspace_script (audit-dependencies.mjs / audit-dead-code.sh) for that.
If your task is to check unused dependencies, refuse and tell the main agent to run scripts.`;

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
    private readonly maxSteps = 6,
    private readonly timeoutMs = 90_000
  ) {}

  async run(
    provider: LlmProvider,
    task: string,
    focus: string | undefined,
    allTools: ToolDefinition[],
    signal?: AbortSignal,
    personaInstructions?: string
  ): Promise<string> {
    const tools = allTools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.function.name));
    const loop = new AgentLoop(this.toolExecutor, this.maxSteps);

    const userContent = focus
      ? `## Focus\n${focus}\n\n## Task\n${task}\n\nBe concise. Max 4 tool rounds.`
      : `${task}\n\nBe concise. Max 4 tool rounds.`;

    const messages = [
      { role: 'system' as const, content: buildResearchSystemPrompt(personaInstructions) },
      { role: 'user' as const, content: userContent },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const result = await loop.runToCompletion(provider, messages, tools, controller.signal, undefined, false, {
        maxSteps: this.maxSteps,
      });
      log.info('Research subagent finished', { task: task.slice(0, 80), toolCalls: result.toolCallsMade });
      return result.fullContent || '(no findings)';
    } catch (e) {
      if (controller.signal.aborted) {
        log.warn('Research subagent timed out', { task: task.slice(0, 80), timeoutMs: this.timeoutMs });
        return `(research timed out after ${Math.round(this.timeoutMs / 1000)}s — partial task: ${task.slice(0, 120)})`;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildResearchSystemPrompt(personaInstructions?: string): string {
  const persona = personaInstructions?.trim()
    ? `\n\nPersona / task-specific instructions from main agent:\n${personaInstructions.trim().slice(0, 1200)}`
    : '';
  return `${DEFAULT_RESEARCH_SYSTEM}${persona}`;
}
