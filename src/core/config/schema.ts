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

export const EmbeddingProviderSchema = z.enum(['hash', 'minilm']).default('hash');
export const VectorBackendSchema = z.enum(['sqlite', 'lancedb']).default('sqlite');

export const IndexingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoIndexOnOpen: z.boolean().default(true),
  maxFileSizeBytes: z.number().int().positive().default(512_000),
  hardSkipSizeBytes: z.number().int().positive().default(2_000_000),
  respectGitignore: z.boolean().default(true),
  respectThunderignore: z.boolean().default(true),
  maxConcurrency: z.number().int().positive().default(2),
  treeSitterEnabled: z.boolean().default(true),
  vectorsEnabled: z.boolean().default(false),
  embeddingProvider: EmbeddingProviderSchema,
  vectorBackend: VectorBackendSchema,
});

export const ContextConfigSchema = z.object({
  rerankerEnabled: z.boolean().default(true),
  rerankerCandidatePool: z.number().int().min(5).max(50).default(20),
  rerankerTopK: z.number().int().min(3).max(30).default(8),
});

export const SafetyConfigSchema = z.object({
  requireApprovalForWrites: z.boolean().default(true),
  requireApprovalForShell: z.boolean().default(true),
  allowNetwork: z.boolean().default(false),
  blockDangerousCommands: z.boolean().default(true),
  approvalMode: z.enum(['review_all', 'ask_edits', 'ask_deletes', 'ask_commands', 'auto']).default('review_all'),
  autonomyPreset: z.enum(['safe', 'guided', 'builder', 'pilot', 'enterprise']).default('guided'),
});

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxItems: z.number().int().positive().default(500),
  summarizeAfterTask: z.boolean().default(true),
  hybridSearchEnabled: z.boolean().default(true),
});

export const AgentConfigSchema = z.object({
  subagentsEnabled: z.boolean().default(true),
  maxSteps: z.number().int().min(1).max(100).default(15),
  autoContinue: z.boolean().default(true),
  maxAutoContinues: z.number().int().min(0).max(10).default(2),
  researchAgentMaxSteps: z.number().int().min(1).max(50).default(6),
  researchAgentTimeoutMs: z.number().int().min(10_000).max(300_000).default(90_000),
  researchAgentModel: z.string().default(''),
  researchAgentBaseUrl: z.string().default(''),
  orchestrationEnabled: z.boolean().default(true),
  stepMaxRetries: z.number().int().min(0).max(5).default(2),
  finalValidationEnabled: z.boolean().default(true),
  showDiffPreview: z.boolean().default(false),
});

export const McpServerConfigSchema = z.object({
  disabled: z.boolean().default(false),
  type: z.enum(['stdio']).default('stdio'),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().default(60_000),
});

export const McpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  preloadBuiltin: z.boolean().default(true),
  maxConcurrentStartup: z.number().int().min(1).max(20).default(4),
  servers: z.record(McpServerConfigSchema).default({}),
});

export const WorkspaceConfigSchema = z.object({
  rootPathOverride: z.string().default(''),
});

export const TelemetryConfigSchema = z.object({
  sessionLogging: z.boolean().default(true),
  /** Extra diagnostics: tool inputs, context sources, LLM step metadata. Off by default for speed. */
  debugMetrics: z.boolean().default(false),
});

export const ThunderConfigSchema = z.object({
  debug: z.boolean().default(false),
  provider: ProviderConfigSchema.default({}),
  indexing: IndexingConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  safety: SafetyConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  mcp: McpConfigSchema.default({}),
  workspace: WorkspaceConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
});

export type ProviderType = z.infer<typeof ProviderTypeSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type EmbeddingProviderKind = z.infer<typeof EmbeddingProviderSchema>;
export type VectorBackendKind = z.infer<typeof VectorBackendSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type ThunderConfig = z.infer<typeof ThunderConfigSchema>;

export function defaultThunderConfig(): ThunderConfig {
  return ThunderConfigSchema.parse({});
}
