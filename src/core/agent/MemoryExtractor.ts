import type { LlmProvider } from '../llm/types';
import type { MemoryService, ObservationType } from '../memory/MemoryService';
import type { ToolCallAudit } from '../tools/types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('MemoryExtractor');

export class MemoryExtractor {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly summarizeAfterTask: boolean
  ) {}

  async extractAfterTask(
    sessionId: string,
    userMessage: string,
    assistantResponse: string,
    toolAudit: ToolCallAudit[],
    provider?: LlmProvider
  ): Promise<void> {
    const filesTouched = new Set<string>();
    for (const entry of toolAudit) {
      const input = entry.input as Record<string, unknown>;
      if (typeof input.path === 'string') filesTouched.add(input.path);
    }

    if (filesTouched.size > 0) {
      this.memoryService.write(
        sessionId,
        'file_fact',
        `Modified files: ${[...filesTouched].join(', ')}`,
        [...filesTouched]
      );
    }

    const type = inferObservationType(userMessage, assistantResponse);
    const heuristic = buildHeuristicSummary(userMessage, assistantResponse, toolAudit);
    if (heuristic) {
      this.memoryService.write(sessionId, type, heuristic, [...filesTouched]);
    }

    if (this.summarizeAfterTask && provider) {
      await this.llmSummarize(sessionId, userMessage, assistantResponse, [...filesTouched], provider);
    }

    log.info('Memory extracted', { sessionId, files: filesTouched.size });
  }

  private async llmSummarize(
    sessionId: string,
    userMessage: string,
    assistantResponse: string,
    files: string[],
    provider: LlmProvider
  ): Promise<void> {
    const prompt = [
      'Summarize this coding task outcome in 2-3 sentences for future sessions.',
      'Focus on decisions, patterns, and what was changed. No secrets.',
      '',
      `User: ${userMessage.slice(0, 500)}`,
      `Assistant: ${assistantResponse.slice(0, 800)}`,
      files.length ? `Files: ${files.join(', ')}` : '',
    ].join('\n');

    let summary = '';
    try {
      for await (const delta of provider.complete({
        messages: [
          { role: 'system', content: 'You extract durable coding session memories. Be concise.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        maxTokens: 200,
      })) {
        if (delta.content) summary += delta.content;
      }
      if (summary.trim()) {
        this.memoryService.write(sessionId, 'decision', summary.trim(), files);
      }
    } catch {
      // Non-fatal
    }
  }
}

function inferObservationType(userMessage: string, response: string): ObservationType {
  const text = `${userMessage} ${response}`.toLowerCase();
  if (/bug|fix|error|broken/.test(text)) return 'bugfix';
  if (/refactor|restructure|rename/.test(text)) return 'refactor';
  if (/architect|design|pattern|structure/.test(text)) return 'architecture';
  return 'decision';
}

function buildHeuristicSummary(
  userMessage: string,
  response: string,
  audit: ToolCallAudit[]
): string | null {
  const toolsUsed = [...new Set(audit.map((a) => a.toolName))];
  const parts: string[] = [];

  if (userMessage.length > 0) {
    parts.push(`Task: ${userMessage.slice(0, 200)}`);
  }
  if (toolsUsed.length > 0) {
    parts.push(`Tools: ${toolsUsed.join(', ')}`);
  }
  const firstLine = response.split('\n').find((l) => l.trim().length > 10);
  if (firstLine) {
    parts.push(`Outcome: ${firstLine.slice(0, 200)}`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
