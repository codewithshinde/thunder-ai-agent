import { z } from 'zod';

export const ProviderTypeSchema = z.enum([
  'openai-compatible',
  'echo',
]);

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema.default('echo'),
  baseUrl: z.string().url().default('http://localhost:11434/v1'),
  model: z.string().default('qwen3-coder:30b'),
  apiKeyRef: z.string().default('thunder.apiKey'),
  contextWindow: z.number().int().positive().default(8192),
  supportsStreaming: z.boolean().default(true),
  supportsTools: z.boolean().default(true),
  supportsEmbeddings: z.boolean().default(false),
});

export const IndexingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxFileSizeBytes: z.number().int().positive().default(512_000),
  hardSkipSizeBytes: z.number().int().positive().default(2_000_000),
  respectGitignore: z.boolean().default(true),
  respectThunderignore: z.boolean().default(true),
  maxConcurrency: z.number().int().positive().default(2),
  vectorsEnabled: z.boolean().default(false),
});

export const SafetyConfigSchema = z.object({
  requireApprovalForWrites: z.boolean().default(true),
  requireApprovalForShell: z.boolean().default(true),
  allowNetwork: z.boolean().default(false),
  blockDangerousCommands: z.boolean().default(true),
  autonomyPreset: z.enum(['safe', 'guided', 'builder', 'pilot', 'enterprise']).default('guided'),
});

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxItems: z.number().int().positive().default(500),
  summarizeAfterTask: z.boolean().default(true),
});

export const WorkspaceConfigSchema = z.object({
  rootPathOverride: z.string().default(''),
});

export const ThunderConfigSchema = z.object({
  debug: z.boolean().default(false),
  provider: ProviderConfigSchema.default({}),
  indexing: IndexingConfigSchema.default({}),
  safety: SafetyConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  workspace: WorkspaceConfigSchema.default({}),
});

export type ProviderType = z.infer<typeof ProviderTypeSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type ThunderConfig = z.infer<typeof ThunderConfigSchema>;

export function defaultThunderConfig(): ThunderConfig {
  return ThunderConfigSchema.parse({});
}
