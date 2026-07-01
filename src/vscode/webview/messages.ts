import type { ThunderMode } from '../../core/ThunderSession';

export type WebviewTab = 'chat' | 'history' | 'settings';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export interface ApprovalRequestView {
  id: string;
  toolName: string;
  inputPreview: string;
  files: string[];
  risk: 'low' | 'medium' | 'high';
  reason: string;
  contentLength?: number;
  kind?: 'approval' | 'question';
  question?: string;
  options?: string[];
}

export interface TokenUsageView {
  sessionTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  currentTurnTotal: number;
  currentTurnInputTokens: number;
  currentTurnOutputTokens: number;
  aiCallCount: number;
  currentTurnAiCallCount: number;
  lastCallInputTokens: number;
  lastCallOutputTokens: number;
  lastCallTotalTokens: number;
  lastPromptTokens: number;
  lastContextTokens: number;
  lastResponseTokens: number;
  turnCount: number;
  contextWindow: number;
  estimated: boolean;
  breakdown: TokenUsageBreakdownItem[];
}

export interface TokenUsageBreakdownItem {
  label: string;
  tokens: number;
  color: string;
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  updatedAt: number;
  tokenTotal: number;
  turnCount: number;
}

export interface PinnedContextView {
  path: string;
  kind: 'file' | 'folder';
  auto?: boolean;
}

export interface ContextPathSuggestion {
  path: string;
  kind: 'file' | 'folder';
  label: string;
}

export interface ContextItemView {
  id: string;
  source: string;
  relPath?: string;
  reason: string;
  tokenEstimate: number;
  preview: string;
  truncated?: boolean;
}

export interface ContextDropView {
  source: string;
  relPath?: string;
  reason: string;
  tokenEstimate: number;
  cause: string;
}

export interface SourceTokenSplit {
  source: string;
  tokens: number;
  count: number;
}

export interface ContextBudgetView {
  retrievedCount: number;
  includedCount: number;
  budgetLimit: number;
  usedTokens: number;
  truncatedCount: number;
  dropped: ContextDropView[];
  sourceBreakdown: SourceTokenSplit[];
}

export interface AgentLiveStatusView {
  label: string;
  detail?: string;
  stepCurrent?: number;
  stepTotal?: number;
}

export interface SubagentStatusView {
  id: string;
  task: string;
  focus?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

export interface VectorIndexStatusView {
  enabled: boolean;
  embeddedChunks: number;
  provider: string;
  backend?: string;
}

export interface AgentActivityEntry {
  id: string;
  kind: 'context' | 'read' | 'budget' | 'apply' | 'info' | 'approval' | 'error' | 'tool' | 'success';
  message: string;
  detail?: string;
  timestamp: number;
}

export interface PlanStepView {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'blocked_by_dependency';
  risk: 'low' | 'medium' | 'high';
  files?: string[];
}

export interface PlanView {
  goal: string;
  assumptions: string[];
  steps: PlanStepView[];
}

export interface IndexingStatusView {
  indexed: number;
  queued: number;
  running: boolean;
  failed: number;
  total: number;
  activeWorkers?: number;
  processed?: number;
  runTotal?: number;
}

export interface MemoryItemView {
  id: number;
  type: string;
  text: string;
  createdAt: number;
}

export interface CheckpointView {
  id: string;
  kind: string;
  files: string[];
  createdAt: number;
  strategy?: string;
}

export interface SettingsView {
  appVersion: string;
  providerType: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  indexingEnabled: boolean;
  approvalMode: ApprovalMode;
  requireApprovalWrites: boolean;
  requireApprovalShell: boolean;
  memoryEnabled: boolean;
  subagentsEnabled: boolean;
  agentMaxSteps: number;
  askDepth: 'auto' | 'quick' | 'standard' | 'deep';
  askMaxSteps: number;
  askAutoContinue: boolean;
  askMaxAutoContinues: number;
  agentAutoContinue: boolean;
  agentMaxAutoContinues: number;
  researchAgentMaxSteps: number;
  showDiffPreview: boolean;
  hasApiKey: boolean;
  connectionStatus?: string;
  connectionOk?: boolean;
  mcpEnabled: boolean;
  mcpServers: number;
  mcpTools: number;
  mcpServerStatuses: McpServerStatusView[];
  customMcpServers: McpCustomServerView[];
  projectRules: number;
  sessionLogging: boolean;
  debugMetrics: boolean;
  localDebugAvailable: boolean;
  vectorsEnabled: boolean;
  embeddingProvider: 'minilm' | 'hash';
  vectorBackend: 'sqlite' | 'lancedb';
  hybridMemorySearch: boolean;
  minilmAvailable: boolean;
  lancedbAvailable: boolean;
  autonomyPreset: 'safe' | 'guided' | 'builder' | 'pilot' | 'enterprise';
  planModel: string;
  planBaseUrl: string;
  actModel: string;
  actBaseUrl: string;
  checkpointStrategy: 'file-copy' | 'git-stash' | 'shadow-git';
}

export type ApprovalMode = 'review_all' | 'ask_edits' | 'ask_deletes' | 'ask_commands' | 'auto';

export interface ProviderSettingsPayload {
  providerType: ProviderTypeView;
  baseUrl: string;
  model: string;
  contextWindow: number;
}

export interface AgentSettingsPayload {
  subagentsEnabled: boolean;
  maxSteps: number;
  askDepth: 'auto' | 'quick' | 'standard' | 'deep';
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

export interface McpSettingsPayload {
  enabled: boolean;
  builtinServers?: McpToggles;
  customServers?: McpCustomServerView[];
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

export interface TelemetrySettingsPayload {
  sessionLogging: boolean;
  debugMetrics: boolean;
}

export interface McpServerStatusView {
  name: string;
  connected: boolean;
  toolCount: number;
  builtin?: boolean;
  error?: string;
}

export interface IndexingSettingsPayload {
  vectorsEnabled: boolean;
  embeddingProvider: 'minilm' | 'hash';
  vectorBackend: 'sqlite' | 'lancedb';
  hybridMemorySearch: boolean;
  autonomyPreset: 'safe' | 'guided' | 'builder' | 'pilot' | 'enterprise';
  planModel: string;
  planBaseUrl: string;
  actModel: string;
  actBaseUrl: string;
  checkpointStrategy: 'file-copy' | 'git-stash' | 'shadow-git';
}

export type ProviderTypeView =
  | 'echo'
  | 'openai-compatible'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'cursor'
  | 'codex';

export interface ThunderSettingsPayload {
  provider: ProviderSettingsPayload;
  agent: AgentSettingsPayload;
  safety: SafetySettingsPayload;
  mcp: McpSettingsPayload;
  indexing: IndexingSettingsPayload;
  telemetry: TelemetrySettingsPayload;
}

export interface ContextToggles {
  repoMap: boolean;
  fts: boolean;
  gitDiff: boolean;
  diagnostics: boolean;
  memory: boolean;
  vectors: boolean;
}

export interface WebviewState {
  tab: WebviewTab;
  messages: ChatMessage[];
  currentSessionId: string;
  chatHistory: ChatThreadSummary[];
  mode: ThunderMode;
  loading: boolean;
  error: string | null;
  approvals: ApprovalRequestView[];
  pinnedContext: PinnedContextView[];
  contextPreview: ContextItemView[];
  contextTokenEstimate: number;
  contextBudget: ContextBudgetView | null;
  agentActivity: AgentActivityEntry[];
  agentLiveStatus: AgentLiveStatusView | null;
  subagents: SubagentStatusView[];
  vectorIndex: VectorIndexStatusView;
  plan: PlanView | null;
  indexing: IndexingStatusView;
  memories: MemoryItemView[];
  checkpoints: CheckpointView[];
  settings: SettingsView;
  contextToggles: ContextToggles;
  mcpToggles: McpToggles;
  logoUri: string;
  showContextPreview: boolean;
  providerLabel: string;
  workspaceOpen: boolean;
  workspacePath: string;
  vscodeWorkspaceFolders: string[];
  workspaceOverride: string;
  usingWorkspaceOverride: boolean;
  indexDbPath: string;
  workspaceNotice: WorkspaceNoticeView | null;
  tokenUsage: TokenUsageView;
  workspaceTrusted: boolean;
}

export type WorkspaceNoticeView = {
  kind: 'ok' | 'error' | 'warn';
  message: string;
};

// Extension -> Webview messages
export type ExtensionToWebviewMessage =
  | { type: 'state'; payload: WebviewState }
  | { type: 'appendMessage'; payload: ChatMessage }
  | { type: 'updateLastAssistant'; payload: { content: string; streaming: boolean } }
  | { type: 'setError'; payload: string | null }
  | { type: 'setLoading'; payload: boolean }
  | { type: 'setMode'; payload: ThunderMode }
  | { type: 'setTab'; payload: WebviewTab }
  | { type: 'setIndexing'; payload: IndexingStatusView }
  | { type: 'setApprovals'; payload: ApprovalRequestView[] }
  | { type: 'setContextPreview'; payload: { items: ContextItemView[]; totalTokens: number; budget?: ContextBudgetView | null } }
  | { type: 'setPlan'; payload: PlanView | null }
  | { type: 'setAgentActivity'; payload: AgentActivityEntry[] }
  | { type: 'setAgentLiveStatus'; payload: AgentLiveStatusView | null }
  | { type: 'setSubagents'; payload: SubagentStatusView[] }
  | { type: 'setTokenUsage'; payload: TokenUsageView }
  | { type: 'setContextPaths'; payload: { requestId: string; paths: ContextPathSuggestion[] } };

// Webview -> Extension messages
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'sendMessage'; payload: { content: string; pinnedContext?: PinnedContextView[] } }
  | { type: 'retryLastMessage' }
  | { type: 'newChat' }
  | { type: 'openChatThread'; payload: { id: string } }
  | { type: 'setMode'; payload: ThunderMode }
  | { type: 'setTab'; payload: WebviewTab }
  | { type: 'stopGeneration' }
  | { type: 'clearError' }
  | { type: 'resolveApproval'; payload: { id: string; decision: 'approved' | 'denied'; selectedOption?: string; scope?: 'single' | 'task' } }
  | { type: 'approveAllPending' }
  | { type: 'saveApiKey'; payload: { key: string } }
  | { type: 'saveProviderSettings'; payload: ProviderSettingsPayload }
  | { type: 'saveAgentSettings'; payload: AgentSettingsPayload }
  | { type: 'saveSafetySettings'; payload: SafetySettingsPayload }
  | { type: 'saveMcpSettings'; payload: McpSettingsPayload }
  | { type: 'saveAllSettings'; payload: ThunderSettingsPayload }
  | { type: 'testProviderConnection'; payload?: ProviderSettingsPayload }
  | { type: 'pickWorkspaceFolder' }
  | { type: 'setWorkspaceOverride'; payload: { path: string } }
  | { type: 'clearWorkspaceOverride' }
  | { type: 'indexWorkspace' }
  | { type: 'restoreCheckpoint'; payload: { id: string } }
  | { type: 'deleteMemory'; payload: { id: number } }
  | { type: 'clearMemory' }
  | { type: 'showInlineDiff'; payload: { approvalId: string } }
  | { type: 'toggleContextSource'; payload: { source: keyof ContextToggles; enabled: boolean } }
  | { type: 'toggleMcpServer'; payload: { server: keyof McpToggles; enabled: boolean } }
  | { type: 'saveCustomMcpServers'; payload: { servers: McpCustomServerView[] } }
  | { type: 'toggleContextPreview' }
  | { type: 'copyLastResponse' }
  | { type: 'copyChatHistoryMarkdown' }
  | { type: 'addPinnedContext'; payload: { path: string; kind: 'file' | 'folder' } }
  | { type: 'removePinnedContext'; payload: { path: string } }
  | { type: 'clearPinnedContext' }
  | { type: 'searchContextPaths'; payload: { query: string; requestId: string } }
  | { type: 'pickContextPath' }
  | { type: 'refreshPanels' };

export const defaultMcpToggles = (): McpToggles => ({
  filesystem: true,
  memory: true,
  sequentialThinking: true,
});

export const defaultContextToggles = (): ContextToggles => ({
  repoMap: true,
  fts: true,
  gitDiff: true,
  diagnostics: false,
  memory: true,
  vectors: true,
});

export const defaultSettingsView = (): SettingsView => ({
  appVersion: '',
  providerType: 'echo',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3-coder:30b',
  contextWindow: 8192,
  indexingEnabled: true,
  approvalMode: 'review_all',
  requireApprovalWrites: true,
  requireApprovalShell: true,
  memoryEnabled: true,
  subagentsEnabled: true,
  agentMaxSteps: 15,
  askDepth: 'auto',
  askMaxSteps: 18,
  askAutoContinue: true,
  askMaxAutoContinues: 1,
  agentAutoContinue: true,
  agentMaxAutoContinues: 2,
  researchAgentMaxSteps: 6,
  showDiffPreview: false,
  hasApiKey: false,
  mcpEnabled: true,
  mcpServers: 0,
  mcpTools: 0,
  mcpServerStatuses: [],
  customMcpServers: [],
  projectRules: 0,
  sessionLogging: true,
  debugMetrics: false,
  localDebugAvailable: false,
  vectorsEnabled: true,
  embeddingProvider: 'minilm',
  vectorBackend: 'sqlite',
  hybridMemorySearch: true,
  minilmAvailable: false,
  lancedbAvailable: false,
  autonomyPreset: 'guided',
  planModel: '',
  planBaseUrl: '',
  actModel: '',
  actBaseUrl: '',
  checkpointStrategy: 'git-stash',
});

export const initialWebviewState = (): WebviewState => ({
  tab: 'chat',
  messages: [],
  currentSessionId: '',
  chatHistory: [],
  mode: 'plan',
  loading: false,
  error: null,
  approvals: [],
  pinnedContext: [],
  contextPreview: [],
  contextTokenEstimate: 0,
  contextBudget: null,
  agentActivity: [],
  agentLiveStatus: null,
  subagents: [],
  vectorIndex: { enabled: false, embeddedChunks: 0, provider: 'none', backend: 'none' },
  plan: null,
  indexing: { indexed: 0, queued: 0, running: false, failed: 0, total: 0, activeWorkers: 0, processed: 0, runTotal: 0 },
  memories: [],
  checkpoints: [],
  settings: defaultSettingsView(),
  contextToggles: defaultContextToggles(),
  mcpToggles: defaultMcpToggles(),
  logoUri: '',
  showContextPreview: false,
  providerLabel: 'echo',
  workspaceOpen: false,
  workspacePath: '',
  vscodeWorkspaceFolders: [],
  workspaceOverride: '',
  usingWorkspaceOverride: false,
  indexDbPath: '',
  workspaceNotice: null,
  tokenUsage: {
    sessionTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    currentTurnTotal: 0,
    currentTurnInputTokens: 0,
    currentTurnOutputTokens: 0,
    aiCallCount: 0,
    currentTurnAiCallCount: 0,
    lastCallInputTokens: 0,
    lastCallOutputTokens: 0,
    lastCallTotalTokens: 0,
    lastPromptTokens: 0,
    lastContextTokens: 0,
    lastResponseTokens: 0,
    turnCount: 0,
    contextWindow: 8192,
    estimated: true,
    breakdown: [],
  },
  workspaceTrusted: true,
});
