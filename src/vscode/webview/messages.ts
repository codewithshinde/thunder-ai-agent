import type { ThunderMode } from '../../core/ThunderSession';

export type WebviewTab = 'chat' | 'settings';

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
}

export interface ContextItemView {
  id: string;
  source: string;
  relPath?: string;
  reason: string;
  tokenEstimate: number;
  preview: string;
}

export interface PlanStepView {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'blocked';
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
  indexingEnabled: boolean;
  requireApprovalWrites: boolean;
  requireApprovalShell: boolean;
  memoryEnabled: boolean;
  hasApiKey: boolean;
}

export interface ContextToggles {
  repoMap: boolean;
  fts: boolean;
  gitDiff: boolean;
  diagnostics: boolean;
  memory: boolean;
}

export interface WebviewState {
  tab: WebviewTab;
  messages: ChatMessage[];
  mode: ThunderMode;
  loading: boolean;
  error: string | null;
  approvals: ApprovalRequestView[];
  contextPreview: ContextItemView[];
  contextTokenEstimate: number;
  plan: PlanView | null;
  indexing: IndexingStatusView;
  memories: MemoryItemView[];
  checkpoints: CheckpointView[];
  settings: SettingsView;
  contextToggles: ContextToggles;
  showContextPreview: boolean;
}

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
  | { type: 'setPlan'; payload: PlanView | null };

// Webview -> Extension messages
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'sendMessage'; payload: { content: string } }
  | { type: 'setMode'; payload: ThunderMode }
  | { type: 'setTab'; payload: WebviewTab }
  | { type: 'stopGeneration' }
  | { type: 'clearError' }
  | { type: 'resolveApproval'; payload: { id: string; decision: 'approved' | 'denied' } }
  | { type: 'saveApiKey'; payload: { key: string } }
  | { type: 'indexWorkspace' }
  | { type: 'restoreCheckpoint'; payload: { id: string } }
  | { type: 'deleteMemory'; payload: { id: number } }
  | { type: 'clearMemory' }
  | { type: 'toggleContextSource'; payload: { source: keyof ContextToggles; enabled: boolean } }
  | { type: 'toggleContextPreview' }
  | { type: 'copyLastResponse' }
  | { type: 'refreshPanels' };

export const defaultContextToggles = (): ContextToggles => ({
  repoMap: true,
  fts: true,
  gitDiff: true,
  diagnostics: true,
  memory: true,
});

export const defaultSettingsView = (): SettingsView => ({
  providerType: 'echo',
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3',
  indexingEnabled: true,
  requireApprovalWrites: true,
  requireApprovalShell: true,
  memoryEnabled: true,
  hasApiKey: false,
});

export const initialWebviewState = (): WebviewState => ({
  tab: 'chat',
  messages: [],
  mode: 'plan',
  loading: false,
  error: null,
  approvals: [],
  contextPreview: [],
  contextTokenEstimate: 0,
  plan: null,
  indexing: { indexed: 0, queued: 0, running: false, failed: 0 },
  memories: [],
  checkpoints: [],
  settings: defaultSettingsView(),
  contextToggles: defaultContextToggles(),
  showContextPreview: false,
});
