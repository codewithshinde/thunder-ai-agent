import type { ProviderConfig, ProviderType } from '../config/schema';
import type { LlmProvider } from './types';
import { EchoProvider } from './EchoProvider';
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { GeminiProvider } from './GeminiProvider';
import { BedrockProvider } from './BedrockProvider';
import { getProviderPreset } from './providerPresets';
import { normalizeProviderModel } from './modelNormalize';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('createProvider');

export interface ProviderResolveOptions {
  type?: ProviderType;
  baseUrl?: string;
  model?: string;
  apiVersion?: string;
  region?: string;
  apiKey?: string;
  contextWindow?: number;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsEmbeddings?: boolean;
}

export function createProvider(
  config: ProviderConfig | ProviderResolveOptions,
  apiKey?: string
): LlmProvider {
  const type = config.type ?? 'echo';
  const preset = getProviderPreset(type);
  const baseUrl = ('baseUrl' in config && config.baseUrl) || preset?.baseUrl || 'http://localhost:11434/v1';
  const resolved = normalizeProviderModel(type, 'model' in config ? config.model : undefined);
  if (resolved.warning) {
    log.warn(resolved.warning);
  }
  const model = resolved.model;
  const key = apiKey;
  const apiVersion = 'apiVersion' in config && config.apiVersion
    ? config.apiVersion
    : '2024-10-21';
  const region = 'region' in config && config.region
    ? config.region
    : 'us-east-1';
  const capabilities = {
    contextWindow: config.contextWindow ?? preset?.contextWindow ?? 8192,
    supportsStreaming: config.supportsStreaming ?? true,
    supportsTools: config.supportsTools ?? true,
    supportsEmbeddings: config.supportsEmbeddings ?? false,
  };

  switch (type) {
    case 'anthropic':
      return new AnthropicProvider({ baseUrl, model, apiKey: key, capabilities });
    case 'gemini':
      return new GeminiProvider({ baseUrl, model, apiKey: key, capabilities });
    case 'openrouter':
      return new OpenAiCompatibleProvider({
        baseUrl,
        model,
        apiKey: key,
        capabilities,
        providerId: 'openrouter',
        defaultHeaders: {
          'HTTP-Referer': 'https://mitii.dev',
          'X-Title': 'Mitii Agent',
        },
        includeReasoning: true,
      });
    case 'azure-openai':
      return new OpenAiCompatibleProvider({
        baseUrl,
        model,
        apiKey: key,
        capabilities,
        providerId: 'azure-openai',
        authHeader: 'api-key',
        chatCompletionsPath: `openai/deployments/${encodeURIComponent(model)}/chat/completions`,
        queryParams: { 'api-version': apiVersion },
      });
    case 'bedrock':
      return new BedrockProvider({
        region,
        model,
        capabilities: {
          ...capabilities,
          supportsTools: false,
          supportsEmbeddings: false,
        },
      });
    case 'openai':
    case 'deepseek':
    case 'cursor':
    case 'codex':
    case 'openai-compatible':
      return new OpenAiCompatibleProvider({ baseUrl, model, apiKey: key, capabilities });
    case 'echo':
    default:
      return new EchoProvider();
  }
}
