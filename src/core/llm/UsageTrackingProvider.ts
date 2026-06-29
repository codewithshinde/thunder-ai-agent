import type { ChatDelta, ChatRequest, LlmProvider, ModelCapabilities } from './types';
import { estimateTokens } from './tokenEstimate';

export interface ModelCallUsage {
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export type ModelCallUsageCallback = (usage: ModelCallUsage) => void;

export class UsageTrackingProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  constructor(
    private readonly inner: LlmProvider,
    private readonly onUsage: ModelCallUsageCallback
  ) {
    this.id = inner.id;
    this.capabilities = inner.capabilities;
  }

  async *complete(request: ChatRequest): AsyncIterable<ChatDelta> {
    const inputTokens = estimateChatRequestTokens(request);
    let outputText = '';

    try {
      for await (const delta of this.inner.complete(request)) {
        if (delta.content) {
          outputText += delta.content;
        }
        if (delta.tool_calls) {
          outputText += JSON.stringify(delta.tool_calls);
        }
        yield delta;
      }
    } finally {
      const outputTokens = estimateTokens(outputText);
      this.onUsage({
        providerId: this.inner.id,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: true,
      });
    }
  }

  async countTokens(text: string): Promise<number> {
    return this.inner.countTokens?.(text) ?? estimateTokens(text);
  }
}

export function estimateChatRequestTokens(request: ChatRequest): number {
  const messageTokens = estimateTokens(
    request.messages
      .map((message) => {
        const toolCalls = message.tool_calls ? `\n${JSON.stringify(message.tool_calls)}` : '';
        return `${message.role}\n${message.name ?? ''}\n${message.content ?? ''}${toolCalls}`;
      })
      .join('\n\n')
  );
  const toolTokens = request.tools?.length ? estimateTokens(JSON.stringify(request.tools)) : 0;
  return messageTokens + toolTokens;
}
