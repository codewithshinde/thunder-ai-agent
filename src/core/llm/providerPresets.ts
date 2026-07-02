import type { ProviderType } from '../config/schema';

export interface ProviderPreset {
  type: ProviderType;
  label: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  requiresApiKey: boolean;
  apiKeyHeader?: 'authorization' | 'api-key' | 'x-api-key' | 'query';
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    type: 'openai-compatible',
    label: 'OpenAI-compatible (Ollama, LM Studio)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3-coder:30b',
    contextWindow: 8192,
    requiresApiKey: false,
  },
  {
    type: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    requiresApiKey: true,
  },
  {
    type: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    contextWindow: 128_000,
    requiresApiKey: true,
  },
  {
    type: 'azure-openai',
    label: 'Azure OpenAI',
    baseUrl: 'https://your-resource.openai.azure.com',
    model: 'your-deployment-name',
    contextWindow: 128_000,
    requiresApiKey: true,
    apiKeyHeader: 'api-key',
  },
  {
    type: 'bedrock',
    label: 'AWS Bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    contextWindow: 200_000,
    requiresApiKey: false,
  },
  {
    type: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    contextWindow: 200_000,
    requiresApiKey: true,
    apiKeyHeader: 'x-api-key',
  },
  {
    type: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.0-flash',
    contextWindow: 1_000_000,
    requiresApiKey: true,
    apiKeyHeader: 'query',
  },
  {
    type: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    contextWindow: 64_000,
    requiresApiKey: true,
  },
  {
    type: 'cursor',
    label: 'Cursor',
    baseUrl: 'https://api.cursor.com/v1',
    model: 'cursor-small',
    contextWindow: 128_000,
    requiresApiKey: true,
  },
  {
    type: 'codex',
    label: 'OpenAI Codex',
    baseUrl: 'https://api.openai.com/v1',
    model: 'codex-mini-latest',
    contextWindow: 200_000,
    requiresApiKey: true,
  },
];

export function getProviderPreset(type: ProviderType): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.type === type);
}

export function isCloudProvider(type: ProviderType): boolean {
  return type !== 'echo' && type !== 'openai-compatible';
}
