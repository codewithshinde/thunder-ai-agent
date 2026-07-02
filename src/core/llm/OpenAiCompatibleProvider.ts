import type { LlmProvider, ChatRequest, ChatDelta, ModelCapabilities } from './types';
import { parseSseStream } from './sseParser';
import { normalizeProviderError, ProviderError } from './errors';
import { estimateTokensAsync } from './tokenEstimate';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  capabilities?: Partial<ModelCapabilities>;
  providerId?: string;
  defaultHeaders?: Record<string, string>;
  authHeader?: 'authorization' | 'api-key' | 'x-api-key';
  chatCompletionsPath?: string;
  queryParams?: Record<string, string>;
  includeReasoning?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.id = config.providerId ?? 'openai-compatible';
    this.capabilities = {
      contextWindow: config.capabilities?.contextWindow ?? 8192,
      supportsStreaming: config.capabilities?.supportsStreaming ?? true,
      supportsTools: config.capabilities?.supportsTools ?? true,
      supportsEmbeddings: config.capabilities?.supportsEmbeddings ?? false,
    };
  }

  async *complete(request: ChatRequest): AsyncIterable<ChatDelta> {
    const url = buildChatCompletionsUrl(this.config);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.defaultHeaders ?? {}),
    };
    if (this.config.apiKey) {
      const authHeader = this.config.authHeader ?? 'authorization';
      if (authHeader === 'api-key') {
        headers['api-key'] = this.config.apiKey;
      } else if (authHeader === 'x-api-key') {
        headers['x-api-key'] = this.config.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
    }

    const includeReasoning = request.includeReasoning ?? this.config.includeReasoning;
    const reasoningEffort = request.reasoningEffort ?? this.config.reasoningEffort;
    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model,
      messages: sanitizeOpenAiCompatibleMessages(request.messages).map(formatMessage),
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens,
      stream: request.stream !== false,
    };
    if (includeReasoning) {
      body.include_reasoning = true;
    }
    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }

    if (this.capabilities.supportsTools && request.tools && request.tools.length > 0) {
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
              reasoning?: string;
              reasoning_content?: string;
              redacted_reasoning?: string;
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
        const reasoning = message?.reasoning ?? message?.reasoning_content ?? message?.redacted_reasoning;
        if (reasoning) {
          yield { reasoning };
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

export function sanitizeOpenAiCompatibleMessages(messages: ChatRequest['messages']): ChatRequest['messages'] {
  const sanitized: ChatRequest['messages'] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === 'tool') {
      sanitized.push(toolResultAsUserMessage(message));
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const toolCallIds = new Set(message.tool_calls.map((tc) => tc.id));
      const toolResults: ChatRequest['messages'] = [];
      let lookahead = index + 1;

      while (lookahead < messages.length) {
        const candidate = messages[lookahead];
        if (candidate.role !== 'tool') break;
        if (!candidate.tool_call_id || !toolCallIds.has(candidate.tool_call_id)) break;
        toolResults.push(candidate);
        lookahead += 1;
      }

      const resultIds = new Set(toolResults.map((result) => result.tool_call_id).filter(Boolean));
      const hasAllToolResults = [...toolCallIds].every((id) => resultIds.has(id));

      if (hasAllToolResults) {
        sanitized.push(message, ...toolResults);
      } else {
        if (message.content.trim()) {
          sanitized.push({
            role: 'assistant',
            content: message.content,
          });
        }
        sanitized.push(...toolResults.map(toolResultAsUserMessage));
      }

      index = lookahead - 1;
      continue;
    }

    sanitized.push(message);
  }

  return sanitized;
}

function buildChatCompletionsUrl(config: OpenAiCompatibleConfig): string {
  const root = config.baseUrl.replace(/\/$/, '');
  const path = (config.chatCompletionsPath ?? 'chat/completions').replace(/^\//, '');
  const url = new URL(`${root}/${path}`);
  for (const [key, value] of Object.entries(config.queryParams ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function toolResultAsUserMessage(message: ChatRequest['messages'][number]): ChatRequest['messages'][number] {
  const label = message.name ? ` from ${message.name}` : '';
  return {
    role: 'user',
    content: `Tool result${label}:\n${message.content}`,
  };
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
