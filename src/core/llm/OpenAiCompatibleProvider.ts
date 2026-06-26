import type { LlmProvider, ChatRequest, ChatDelta, ModelCapabilities } from './types';
import { parseSseStream } from './sseParser';
import { normalizeProviderError, ProviderError } from './errors';
import { estimateTokensAsync } from './tokenEstimate';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  capabilities?: Partial<ModelCapabilities>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible';
  readonly capabilities: ModelCapabilities;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.capabilities = {
      contextWindow: config.capabilities?.contextWindow ?? 8192,
      supportsStreaming: config.capabilities?.supportsStreaming ?? true,
      supportsTools: config.capabilities?.supportsTools ?? false,
      supportsEmbeddings: config.capabilities?.supportsEmbeddings ?? false,
    };
  }

  async *complete(request: ChatRequest): AsyncIterable<ChatDelta> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model ?? this.config.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
          stream: true,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
          throw new ProviderError('Authentication failed. Check your API key.', 'auth', 401);
        }
        if (response.status === 404) {
          throw new ProviderError(`Model "${this.config.model}" not found.`, 'model', 404);
        }
        throw new ProviderError(
          `Provider returned ${response.status}: ${text.slice(0, 200)}`,
          'unknown',
          response.status
        );
      }

      if (!response.body) {
        throw new ProviderError('Empty response body from provider', 'parse');
      }

      yield* parseSseStream(response.body);
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async countTokens(text: string): Promise<number> {
    return estimateTokensAsync(text);
  }
}
