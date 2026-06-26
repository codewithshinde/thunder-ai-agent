import type { LlmProvider, ChatRequest, ChatDelta, ModelCapabilities } from './types';
import { estimateTokensAsync } from './tokenEstimate';

export class EchoProvider implements LlmProvider {
  readonly id = 'echo';
  readonly capabilities: ModelCapabilities = {
    contextWindow: 8192,
    supportsStreaming: true,
    supportsTools: false,
    supportsEmbeddings: false,
  };

  async *complete(request: ChatRequest): AsyncIterable<ChatDelta> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';
    const response = `Echo: ${content}`;

    for (let i = 0; i < response.length; i += 4) {
      yield { content: response.slice(i, i + 4) };
      await sleep(10);
    }
    yield { done: true };
  }

  async countTokens(text: string): Promise<number> {
    return estimateTokensAsync(text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
