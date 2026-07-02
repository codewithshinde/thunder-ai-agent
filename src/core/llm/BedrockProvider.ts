import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { ChatDelta, ChatMessage, ChatRequest, LlmProvider, ModelCapabilities } from './types';
import { normalizeProviderError } from './errors';
import { estimateTokensAsync } from './tokenEstimate';

export interface BedrockProviderConfig {
  region: string;
  model: string;
  capabilities?: Partial<ModelCapabilities>;
}

export class BedrockProvider implements LlmProvider {
  readonly id = 'bedrock';
  readonly capabilities: ModelCapabilities;
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly config: BedrockProviderConfig) {
    this.capabilities = {
      contextWindow: config.capabilities?.contextWindow ?? 200_000,
      supportsStreaming: config.capabilities?.supportsStreaming ?? true,
      supportsTools: false,
      supportsEmbeddings: false,
    };
    this.client = new BedrockRuntimeClient({ region: config.region || 'us-east-1' });
  }

  async *complete(request: ChatRequest): AsyncIterable<ChatDelta> {
    const input = {
      modelId: request.model ?? this.config.model,
      ...formatBedrockMessages(request.messages),
      inferenceConfig: {
        temperature: request.temperature ?? 0.2,
        maxTokens: request.maxTokens,
      },
    };

    try {
      if (request.stream === false) {
        const response = await this.client.send(new ConverseCommand(input));
        const content = response.output?.message?.content
          ?.map((block) => block.text ?? '')
          .join('') ?? '';
        if (content) yield { content };
        yield { done: true, finish_reason: response.stopReason };
        return;
      }

      const response = await this.client.send(new ConverseStreamCommand(input));
      for await (const event of response.stream ?? []) {
        const text = event.contentBlockDelta?.delta?.text;
        if (text) yield { content: text };
        if (event.messageStop?.stopReason) {
          yield { done: true, finish_reason: event.messageStop.stopReason };
          return;
        }
      }
      yield { done: true };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async countTokens(text: string): Promise<number> {
    return estimateTokensAsync(text);
  }
}

function formatBedrockMessages(messages: ChatMessage[]): {
  messages: Message[];
  system?: SystemContentBlock[];
} {
  const system: SystemContentBlock[] = [];
  const out: Message[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push({ text: message.content });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const prefix = message.role === 'tool'
      ? `Tool result${message.name ? ` from ${message.name}` : ''}:\n`
      : '';
    const text = `${prefix}${message.content}`.trim();
    if (!text) continue;

    const previous = out[out.length - 1];
    if (previous?.role === role) {
      previous.content?.push({ text });
    } else {
      out.push({
        role,
        content: [{ text }],
      });
    }
  }

  if (out.length === 0) {
    out.push({ role: 'user', content: [{ text: '' }] });
  }

  return {
    messages: out,
    ...(system.length > 0 ? { system } : {}),
  };
}
