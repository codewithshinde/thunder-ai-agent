import type { LlmProvider } from './types';
import type { ProviderConfig } from '../config/schema';
import { EchoProvider } from './EchoProvider';
import { createProvider } from './createProvider';

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
    const provider = createProvider(config, apiKey);
    this.activeProvider = provider;
    return provider;
  }

  resolveFromOptions(
    options: Partial<ProviderConfig> & { type: ProviderConfig['type'] },
    apiKey?: string
  ): LlmProvider {
    return createProvider({
      type: options.type,
      baseUrl: options.baseUrl ?? '',
      model: options.model ?? '',
      apiVersion: options.apiVersion ?? '2024-10-21',
      region: options.region ?? 'us-east-1',
      apiKeyRef: 'thunder.apiKey',
      contextWindow: options.contextWindow ?? 8192,
      supportsStreaming: options.supportsStreaming ?? true,
      supportsTools: options.supportsTools ?? true,
      supportsEmbeddings: options.supportsEmbeddings ?? false,
    }, apiKey);
  }
}
