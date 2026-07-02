export type ApprovalMode = 'review_all' | 'ask_edits' | 'ask_deletes' | 'ask_commands' | 'auto';
export type AgentDepthView = 'auto' | 'quick' | 'standard' | 'deep' | 'pilot' | 'enterprise';

export type ProviderTypeView =
  | 'echo'
  | 'openai-compatible'
  | 'openrouter'
  | 'openai'
  | 'azure-openai'
  | 'bedrock'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'cursor'
  | 'codex';

export interface ProviderSettingsPayload {
  providerType: ProviderTypeView;
  baseUrl: string;
  model: string;
  apiVersion?: string;
  region?: string;
  contextWindow: number;
}

export interface AgentSettingsPayload {
  subagentsEnabled: boolean;
  maxSteps: number;
  askDepth: AgentDepthView;
  planDepth: AgentDepthView;
  actDepth: AgentDepthView;
  askMaxSteps: number;
  askAutoContinue: boolean;
  askMaxAutoContinues: number;
  autoContinue: boolean;
  maxAutoContinues: number;
  researchAgentMaxSteps: number;
  showDiffPreview: boolean;
  planModel: string;
  planBaseUrl: string;
  actModel: string;
  actBaseUrl: string;
  checkpointStrategy: 'file-copy' | 'git-stash' | 'shadow-git';
}

export interface SafetySettingsPayload {
  approvalMode: ApprovalMode;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  autonomyPreset: 'safe' | 'guided' | 'builder' | 'pilot' | 'enterprise';
}

export interface McpToggles {
  filesystem: boolean;
  memory: boolean;
  sequentialThinking: boolean;
}

export interface McpCustomServerView {
  name: string;
  type?: 'stdio' | 'sse' | 'streamable-http';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled: boolean;
  source: 'workspace' | 'settings';
}

export interface McpSettingsPayload {
  enabled: boolean;
  builtinServers?: McpToggles;
  customServers?: McpCustomServerView[];
}

export interface TelemetrySettingsPayload {
  sessionLogging: boolean;
  debugMetrics: boolean;
}

export interface IndexingSettingsPayload {
  vectorsEnabled: boolean;
  embeddingProvider: 'minilm' | 'hash';
  vectorBackend: 'sqlite' | 'lancedb';
  hybridMemorySearch: boolean;
}

export interface ThunderSettingsPayload {
  provider: ProviderSettingsPayload;
  agent: AgentSettingsPayload;
  safety: SafetySettingsPayload;
  mcp: McpSettingsPayload;
  indexing: IndexingSettingsPayload;
  telemetry: TelemetrySettingsPayload;
}
