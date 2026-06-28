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
  lastPromptTokens: number;
  lastContextTokens: number;
  lastResponseTokens: number;
  turnCount: number;
  contextWindow: number;
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

export interface ContextBudgetView {
  retrievedCount: number;
  includedCount: number;
  budgetLimit: number;
  usedTokens: number;
  truncatedCount: number;
  dropped: ContextDropView[];
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
}

export interface AgentActivityEntry {
  id: string;
  kind: 'context' | 'read' | 'budget' | 'apply' | 'info' | 'approval' | 'error' | 'tool';
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
}

export interface SettingsView {
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
  projectRules: number;
}

export type ApprovalMode = 'review_all' | 'ask_edits' | 'ask_deletes' | 'ask_commands' | 'auto';

export interface ProviderSettingsPayload {
  providerType: 'echo' | 'openai-compatible';
  baseUrl: string;
  model: string;
  contextWindow: number;
}

export interface AgentSettingsPayload {
  subagentsEnabled: boolean;
  maxSteps: number;
  autoContinue: boolean;
  maxAutoContinues: number;
  researchAgentMaxSteps: number;
  showDiffPreview: boolean;
}

export interface SafetySettingsPayload {
  approvalMode: ApprovalMode;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
}

export interface McpSettingsPayload {
  enabled: boolean;
}

export interface McpServerStatusView {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface ThunderSettingsPayload {
  provider: ProviderSettingsPayload;
  agent: AgentSettingsPayload;
  safety: SafetySettingsPayload;
  mcp: McpSettingsPayload;
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
  | { type: 'setContextPreview'; payload: { items: ContextItemView[]; totalTokens: number } }
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
  | { type: 'toggleContextSource'; payload: { source: keyof ContextToggles; enabled: boolean } }
  | { type: 'toggleContextPreview' }
  | { type: 'copyLastResponse' }
  | { type: 'copyChatHistoryMarkdown' }
  | { type: 'addPinnedContext'; payload: { path: string; kind: 'file' | 'folder' } }
  | { type: 'removePinnedContext'; payload: { path: string } }
  | { type: 'clearPinnedContext' }
  | { type: 'searchContextPaths'; payload: { query: string; requestId: string } }
  | { type: 'pickContextPath' }
  | { type: 'refreshPanels' };

export const defaultContextToggles = (): ContextToggles => ({
  repoMap: true,
  fts: true,
  gitDiff: true,
  diagnostics: false,
  memory: true,
  vectors: false,
});

export const defaultSettingsView = (): SettingsView => ({
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
  agentAutoContinue: true,
  agentMaxAutoContinues: 2,
  researchAgentMaxSteps: 6,
  showDiffPreview: false,
  hasApiKey: false,
  mcpEnabled: true,
  mcpServers: 0,
  mcpTools: 0,
  mcpServerStatuses: [],
  projectRules: 0,
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
  vectorIndex: { enabled: false, embeddedChunks: 0, provider: 'none' },
  plan: null,
  indexing: { indexed: 0, queued: 0, running: false, failed: 0 },
  memories: [],
  checkpoints: [],
  settings: defaultSettingsView(),
  contextToggles: defaultContextToggles(),
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
    lastPromptTokens: 0,
    lastContextTokens: 0,
    lastResponseTokens: 0,
    turnCount: 0,
    contextWindow: 8192,
    breakdown: [],
  },
});
