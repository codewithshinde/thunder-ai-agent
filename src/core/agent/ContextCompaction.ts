import type { ChatMessage, LlmProvider } from '../llm/types';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('ContextCompaction');
const CHARS_PER_TOKEN = 4;

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / CHARS_PER_TOKEN), 0);
}

/**
 * Deterministic compaction first; optional LLM summarization for older turns (Continue/Cline pattern).
 */
export async function compactMessagesWithLlm(
  messages: ChatMessage[],
  maxTokens: number,
  provider?: LlmProvider
): Promise<ChatMessage[]> {
  const deterministic = compactMessages(messages, maxTokens);
  if (!provider || estimateMessageTokens(deterministic) <= maxTokens) {
    return deterministic;
  }

  const older = messages.slice(0, -6);
  if (older.length === 0) return deterministic;

  try {
    const transcript = older
      .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n')
      .slice(0, 6000);

    let summary = '';
    for await (const delta of provider.complete({
      messages: [
        {
          role: 'system',
          content: 'Summarize this conversation for an AI coding agent. Preserve file paths, decisions, and open tasks. Be concise.',
        },
        { role: 'user', content: transcript },
      ],
      stream: false,
      maxTokens: Math.min(800, Math.floor(maxTokens * 0.4)),
    })) {
      if (delta.content) summary += delta.content;
      if (delta.error) throw new Error(delta.error);
    }

    if (!summary.trim()) return deterministic;

    const recent = messages.slice(-6);
    return [
      { role: 'user', content: `## Earlier conversation (LLM-compacted)\n\n${summary.trim()}` },
      ...recent,
    ];
  } catch (error) {
    log.warn('LLM compaction failed, using deterministic fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return deterministic;
  }
}

/**
 * Keeps the most recent turns intact and truncates older messages to fit budget.
 */
export function compactMessages(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (messages.length === 0 || estimateMessageTokens(messages) <= maxTokens) {
    return messages;
  }

  const recent = messages.slice(-6);
  if (estimateMessageTokens(recent) <= maxTokens) {
    const older = messages.slice(0, -6);
    const summary = summarizeOlderMessages(older, maxTokens - estimateMessageTokens(recent));
    return summary ? [summary, ...recent] : recent;
  }

  return recent.map((m, i) => {
    if (i >= recent.length - 4) return m;
    const maxChars = Math.floor((maxTokens / recent.length) * CHARS_PER_TOKEN);
    if ((m.content?.length ?? 0) <= maxChars) return m;
    return { ...m, content: `${m.content.slice(0, maxChars)}\n…[truncated]` };
  });
}

function summarizeOlderMessages(older: ChatMessage[], budgetTokens: number): ChatMessage | null {
  if (older.length === 0 || budgetTokens < 50) return null;

  const maxChars = budgetTokens * CHARS_PER_TOKEN;
  const lines = older.map((m) => `${m.role}: ${m.content.slice(0, 300)}`);
  const summary = lines.join('\n').slice(0, maxChars);
  return {
    role: 'user',
    content: `## Earlier conversation (compacted)\n\n${summary}`,
  };
}

export function toLlmMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
