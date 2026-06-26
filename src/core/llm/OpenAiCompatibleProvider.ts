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
      supportsTools: config.capabilities?.supportsTools ?? true,
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

    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model,
      messages: request.messages.map(formatMessage),
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens,
      stream: request.stream !== false,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? 'auto';
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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

      const stream = request.stream !== false;
      if (!stream) {
        const json = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
              }>;
            };
            finish_reason?: string;
          }>;
        };
        const message = json.choices?.[0]?.message;
        if (message?.content) {
          yield { content: message.content };
        }
        if (message?.tool_calls) {
          for (const [index, tc] of message.tool_calls.entries()) {
            yield {
              tool_calls: [{
                index,
                id: tc.id,
                function: tc.function,
              }],
            };
          }
        }
        yield { done: true, finish_reason: json.choices?.[0]?.finish_reason };
        return;
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

function formatMessage(msg: ChatRequest['messages'][number]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.name) out.name = msg.name;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  if (msg.tool_calls) out.tool_calls = msg.tool_calls;
  return out;
}
