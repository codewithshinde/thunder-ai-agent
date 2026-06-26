import type { LlmProvider } from './types';
import type { ProviderConfig } from '../config/schema';
import { EchoProvider } from './EchoProvider';
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';

export class LlmProviderRegistry {
  private providers = new Map<string, LlmProvider>();
  private activeProvider: LlmProvider | undefined;

  constructor() {
    this.register(new EchoProvider());
  }

  register(provider: LlmProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): LlmProvider | undefined {
    return this.providers.get(id);
  }

  getActive(): LlmProvider | undefined {
    return this.activeProvider;
  }

  async resolveFromConfig(
    config: ProviderConfig,
    apiKey?: string
  ): Promise<LlmProvider> {
    let provider: LlmProvider;

    switch (config.type) {
      case 'openai-compatible':
        provider = new OpenAiCompatibleProvider({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey,
          capabilities: {
            contextWindow: config.contextWindow,
            supportsStreaming: config.supportsStreaming,
            supportsTools: config.supportsTools,
            supportsEmbeddings: config.supportsEmbeddings,
          },
        });
        break;
      case 'echo':
      default:
        provider = this.providers.get('echo') ?? new EchoProvider();
        break;
    }

    this.activeProvider = provider;
    return provider;
  }
}
