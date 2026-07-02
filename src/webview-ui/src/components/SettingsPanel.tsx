import { useState, useEffect, useCallback } from 'react';
import { AGENT_NAME } from '../../../shared/brand';
import { LOCAL_MODEL_PRESETS, findLocalModelPreset } from '../../../shared/modelPresets';
import type {
  ApprovalMode,
  ContextToggles,
  McpToggles,
  ProviderSettingsPayload,
  SafetySettingsPayload,
  SettingsView,
  IndexingStatusView,
  MemoryItemView,
  CheckpointView,
  ThunderSettingsPayload,
  VectorIndexStatusView,
  WorkspaceNoticeView,
} from '../../../vscode/webview/messages';
import { McpServersEditor } from './McpServersEditor';
import { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
import { SettingsCard } from './SettingsCard';
import { SettingSwitch } from './SettingSwitch';
import { SettingStepper } from './SettingStepper';
import { MemoryPanel } from './MemoryPanel';
import { CheckpointPanel } from './CheckpointPanel';
import { getProviderPreset } from '../../../core/llm/providerPresets';
import {
  APPROVAL_MODE_OPTIONS,
  approvalModeDescription,
  deriveSafetySettings,
} from '../utils/approvalMode';

type SettingsTab = 'workspace' | 'model' | 'agent' | 'context' | 'integrations' | 'safety' | 'debug';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'model', label: 'Model' },
  { id: 'agent', label: 'Agent' },
  { id: 'context', label: 'Context' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'safety', label: 'Safety' },
  { id: 'debug', label: 'Debug' },
];

const PROVIDER_OPTIONS: Array<{ id: ProviderSettingsPayload['providerType']; label: string }> = [
  { id: 'echo', label: 'Echo (test / no LLM)' },
  { id: 'openai-compatible', label: 'OpenAI-compatible (Ollama, LM Studio)' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'azure-openai', label: 'Azure OpenAI' },
  { id: 'bedrock', label: 'AWS Bedrock' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'OpenAI Codex' },
];

const ASK_DEPTH_OPTIONS: Array<{ id: SettingsView['askDepth']; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'quick', label: 'Quick' },
  { id: 'standard', label: 'Standard' },
  { id: 'deep', label: 'Deep' },
  { id: 'pilot', label: 'Pilot' },
  { id: 'enterprise', label: 'Enterprise' },
];

const PLAN_DEPTH_OPTIONS: Array<{ id: SettingsView['planDepth']; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'quick', label: 'Quick discovery' },
  { id: 'standard', label: 'Standard discovery' },
  { id: 'deep', label: 'Deep discovery' },
  { id: 'pilot', label: 'Pilot discovery' },
  { id: 'enterprise', label: 'Enterprise discovery' },
];

const ACT_DEPTH_OPTIONS: Array<{ id: SettingsView['actDepth']; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'quick', label: 'Quick execution' },
  { id: 'standard', label: 'Standard execution' },
  { id: 'deep', label: 'Deep execution' },
  { id: 'pilot', label: 'Pilot execution' },
  { id: 'enterprise', label: 'Enterprise execution' },
];

const AUTONOMY_PRESETS: Array<{
  id: SafetySettingsPayload['autonomyPreset'];
  label: string;
  description: string;
}> = [
  { id: 'safe', label: 'Safe', description: 'Strictest — all edits/commands need approval, no network.' },
  { id: 'guided', label: 'Guided', description: 'Balanced — asks before edits; read-only shell and web fetch allowed.' },
  { id: 'builder', label: 'Builder', description: 'Fast — auto-approves writes; mutating shell still reviewed.' },
  { id: 'pilot', label: 'Pilot', description: 'High autonomy — auto-approves writes, reviews shell.' },
  { id: 'enterprise', label: 'Enterprise', description: 'Locked down — no network, all operations reviewed.' },
];

const CONTEXT_TOGGLES: Array<{
  key: keyof ContextToggles;
  label: string;
  description: string;
}> = [
  {
    key: 'repoMap',
    label: 'Repository map',
    description: 'Symbol outline so the model knows what files and exports exist.',
  },
  {
    key: 'fts',
    label: 'Full-text search',
    description: 'Keyword search over indexed files for symbols, imports, and strings.',
  },
  {
    key: 'gitDiff',
    label: 'Git diff',
    description: 'Uncommitted changes so the agent sees what you are already editing.',
  },
  {
    key: 'diagnostics',
    label: 'Diagnostics',
    description: 'Linter and TypeScript errors. Enable when fixing bugs.',
  },
  {
    key: 'memory',
    label: 'Session memory',
    description: 'Notes from past tasks injected into new chats.',
  },
  {
    key: 'vectors',
    label: 'Semantic vectors',
    description: 'Conceptual code search — finds related files even when wording differs.',
  },
];

const MCP_BUILTIN_TOGGLES: Array<{
  key: keyof McpToggles;
  label: string;
  description: string;
}> = [
  {
    key: 'filesystem',
    label: 'Filesystem',
    description: 'Scoped file access via @modelcontextprotocol/server-filesystem.',
  },
  {
    key: 'memory',
    label: 'MCP memory',
    description: 'Knowledge-graph memory server. Thunder also has built-in session memory.',
  },
  {
    key: 'sequentialThinking',
    label: 'Sequential thinking',
    description: 'Structured reasoning helper for multi-step problems.',
  },
];

interface SettingsPanelProps {
  settings: SettingsView;
  workspaceOpen: boolean;
  workspacePath: string;
  vscodeWorkspaceFolders: string[];
  workspaceOverride: string;
  usingWorkspaceOverride: boolean;
  indexDbPath: string;
  indexing: IndexingStatusView;
  workspaceNotice: WorkspaceNoticeView | null;
  contextToggles: ContextToggles;
  mcpToggles: McpToggles;
  vectorIndex: VectorIndexStatusView;
  memories: MemoryItemView[];
  checkpoints: CheckpointView[];
  onSaveApiKey: (key: string) => void;
  onSaveGitHubToken: (token: string) => void;
  onSaveAllSettings: (settings: ThunderSettingsPayload) => void;
  onTestConnection: (settings: ProviderSettingsPayload) => void;
  onPickWorkspaceFolder: () => void;
  onSetWorkspaceOverride: (path: string) => void;
  onClearWorkspaceOverride: () => void;
  onIndex: () => void;
  onToggleContext: (source: keyof ContextToggles, enabled: boolean) => void;
  onToggleMcp: (server: keyof McpToggles, enabled: boolean) => void;
  onSaveCustomMcpServers: (servers: import('../../../vscode/webview/messages').McpCustomServerView[]) => void;
  onDeleteMemory: (id: number) => void;
  onClearMemory: () => void;
  onRestoreCheckpoint: (id: string) => void;
}

export function SettingsPanel({
  settings,
  workspaceOpen,
  workspacePath,
  vscodeWorkspaceFolders,
  workspaceOverride,
  usingWorkspaceOverride,
  indexDbPath,
  indexing,
  workspaceNotice,
  contextToggles,
  mcpToggles,
  vectorIndex,
  memories,
  checkpoints,
  onSaveApiKey,
  onSaveAllSettings,
  onTestConnection,
  onPickWorkspaceFolder,
  onSetWorkspaceOverride,
  onClearWorkspaceOverride,
  onIndex,
  onToggleContext,
  onToggleMcp,
  onSaveCustomMcpServers,
  onDeleteMemory,
  onClearMemory,
  onRestoreCheckpoint,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('workspace');
  const [apiKey, setApiKey] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [providerType, setProviderType] = useState<ProviderSettingsPayload['providerType']>(
    settings.providerType as ProviderSettingsPayload['providerType']
  );
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [apiVersion, setApiVersion] = useState(settings.apiVersion);
  const [region, setRegion] = useState(settings.region);
  const [contextWindow, setContextWindow] = useState(settings.contextWindow);

  const [subagentsEnabled, setSubagentsEnabled] = useState(settings.subagentsEnabled);
  const [agentMaxSteps, setAgentMaxSteps] = useState(settings.agentMaxSteps);
  const [askDepth, setAskDepth] = useState<SettingsView['askDepth']>(settings.askDepth);
  const [planDepth, setPlanDepth] = useState<SettingsView['planDepth']>(settings.planDepth);
  const [actDepth, setActDepth] = useState<SettingsView['actDepth']>(settings.actDepth);
  const [askMaxSteps, setAskMaxSteps] = useState(settings.askMaxSteps);
  const [askAutoContinue, setAskAutoContinue] = useState(settings.askAutoContinue);
  const [askMaxAutoContinues, setAskMaxAutoContinues] = useState(settings.askMaxAutoContinues);
  const [agentAutoContinue, setAgentAutoContinue] = useState(settings.agentAutoContinue);
  const [agentMaxAutoContinues, setAgentMaxAutoContinues] = useState(settings.agentMaxAutoContinues);
  const [researchAgentMaxSteps, setResearchAgentMaxSteps] = useState(settings.researchAgentMaxSteps);
  const [showDiffPreview, setShowDiffPreview] = useState(settings.showDiffPreview);
  const [planModel, setPlanModel] = useState(settings.planModel);
  const [planBaseUrl, setPlanBaseUrl] = useState(settings.planBaseUrl);
  const [actModel, setActModel] = useState(settings.actModel);
  const [actBaseUrl, setActBaseUrl] = useState(settings.actBaseUrl);
  const [checkpointStrategy, setCheckpointStrategy] = useState(settings.checkpointStrategy);

  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(settings.approvalMode);
  const [autonomyPreset, setAutonomyPreset] = useState<SafetySettingsPayload['autonomyPreset']>(
    settings.autonomyPreset
  );
  const [mcpEnabled, setMcpEnabled] = useState(settings.mcpEnabled);
  const [sessionLogging, setSessionLogging] = useState(settings.sessionLogging);
  const [debugMetrics, setDebugMetrics] = useState(settings.debugMetrics);
  const [vectorsEnabled, setVectorsEnabled] = useState(settings.vectorsEnabled);
  const [embeddingProvider, setEmbeddingProvider] = useState<'minilm' | 'hash'>(settings.embeddingProvider);
  const [vectorBackend, setVectorBackend] = useState<'sqlite' | 'lancedb'>(settings.vectorBackend);
  const [hybridMemorySearch, setHybridMemorySearch] = useState(settings.hybridMemorySearch);

  useEffect(() => {
    setProviderType(settings.providerType as ProviderSettingsPayload['providerType']);
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
    setApiVersion(settings.apiVersion);
    setRegion(settings.region);
    setContextWindow(settings.contextWindow);
    setSubagentsEnabled(settings.subagentsEnabled);
    setAgentMaxSteps(settings.agentMaxSteps);
    setAskDepth(settings.askDepth);
    setPlanDepth(settings.planDepth);
    setActDepth(settings.actDepth);
    setAskMaxSteps(settings.askMaxSteps);
    setAskAutoContinue(settings.askAutoContinue);
    setAskMaxAutoContinues(settings.askMaxAutoContinues);
    setAgentAutoContinue(settings.agentAutoContinue);
    setAgentMaxAutoContinues(settings.agentMaxAutoContinues);
    setResearchAgentMaxSteps(settings.researchAgentMaxSteps);
    setShowDiffPreview(settings.showDiffPreview);
    setPlanModel(settings.planModel);
    setPlanBaseUrl(settings.planBaseUrl);
    setActModel(settings.actModel);
    setActBaseUrl(settings.actBaseUrl);
    setCheckpointStrategy(settings.checkpointStrategy);
    setApprovalMode(settings.approvalMode);
    setAutonomyPreset(settings.autonomyPreset);
    setMcpEnabled(settings.mcpEnabled);
    setSessionLogging(settings.sessionLogging);
    setDebugMetrics(settings.debugMetrics);
    setVectorsEnabled(settings.vectorsEnabled);
    setEmbeddingProvider(settings.embeddingProvider);
    setVectorBackend(settings.vectorBackend);
    setHybridMemorySearch(settings.hybridMemorySearch);
    setDirty(false);
  }, [settings]);

  const markDirty = useCallback(() => setDirty(true), []);

  const clampContextWindow = (value: number) =>
    Math.max(1024, Math.min(Number.isFinite(value) ? Math.floor(value) : 1024, 1_000_000));

  const applyModelPreset = (value: string) => {
    const preset = findLocalModelPreset(value);
    if (preset?.contextWindow) {
      setContextWindow(preset.contextWindow);
    }
  };

  const buildPayload = (): ThunderSettingsPayload | null => {
    if (!baseUrl.trim() || !model.trim() || !Number.isFinite(contextWindow)) {
      return null;
    }
    const normalizedContextWindow = clampContextWindow(contextWindow);
    return {
      provider: {
        providerType,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiVersion: apiVersion.trim(),
        region: region.trim(),
        contextWindow: normalizedContextWindow,
      },
      agent: {
        subagentsEnabled,
        maxSteps: agentMaxSteps,
        askDepth,
        planDepth,
        actDepth,
        askMaxSteps,
        askAutoContinue,
        askMaxAutoContinues,
        autoContinue: agentAutoContinue,
        maxAutoContinues: agentMaxAutoContinues,
        researchAgentMaxSteps,
        showDiffPreview,
        planModel: planModel.trim(),
        planBaseUrl: planBaseUrl.trim(),
        actModel: actModel.trim(),
        actBaseUrl: actBaseUrl.trim(),
        checkpointStrategy,
      },
      safety: deriveSafetySettings(approvalMode),
      mcp: { enabled: mcpEnabled, builtinServers: mcpToggles },
      indexing: {
        vectorsEnabled,
        embeddingProvider,
        vectorBackend,
        hybridMemorySearch,
      },
      telemetry: {
        sessionLogging,
        debugMetrics: settings.localDebugAvailable && sessionLogging ? debugMetrics : false,
      },
    };
  };

  const handleSaveAll = () => {
    const payload = buildPayload();
    if (!payload) return;
    onSaveAllSettings(payload);
    if (apiKey.trim()) {
      onSaveApiKey(apiKey.trim());
      setApiKey('');
    }
    if (githubToken.trim()) {
      onSaveGitHubToken(githubToken.trim());
      setGithubToken('');
    }
    setSaved(true);
    setDirty(false);
    setTimeout(() => setSaved(false), 2500);
  };

  const currentProviderSettings = (): ProviderSettingsPayload => ({
    providerType,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    apiVersion: apiVersion.trim(),
    region: region.trim(),
    contextWindow: clampContextWindow(contextWindow),
  });

  const activeLocalPreset = providerType === 'openai-compatible' ? findLocalModelPreset(model) : undefined;
  const hasPresetContextMismatch = Boolean(
    activeLocalPreset?.contextWindow && activeLocalPreset.contextWindow !== clampContextWindow(contextWindow)
  );

  const contextWindowField = (
    <label className="settings-field">
      <span className="settings-label">Context window (tokens)</span>
      <input
        type="number"
        className="settings-input"
        min={1024}
        max={1_000_000}
        step={1}
        value={contextWindow}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          if (Number.isFinite(parsed)) {
            setContextWindow(parsed);
            markDirty();
          }
        }}
      />
      <span className="settings-hint">
        Hard cap per model request. Prompts trim automatically when over budget (min 1024).
      </span>
    </label>
  );

  const isLocalProvider = providerType !== 'echo';
  const showSaveBar = activeTab !== 'workspace';
  const visibleTabs = settings.localDebugAvailable
    ? TABS
    : TABS.filter((tab) => tab.id !== 'debug');

  return (
    <div className="settings-shell">
      <header className="settings-shell__header">
        <div>
          <h2 className="settings-shell__title">Settings</h2>
          <p className="settings-shell__subtitle">
            Configure {AGENT_NAME} for your workspace and model. Changes apply on save.
          </p>
        </div>
        {settings.appVersion && (
          <span className="settings-shell__version" title={`${AGENT_NAME} version`}>
            v{settings.appVersion}
          </span>
        )}
      </header>

      <nav className="settings-nav" aria-label="Settings sections">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`settings-nav__item ${activeTab === tab.id ? 'settings-nav__item--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="settings-shell__content">
        {activeTab === 'workspace' && (
          <WorkspaceSettingsSection
            workspaceOpen={workspaceOpen}
            workspacePath={workspacePath}
            vscodeWorkspaceFolders={vscodeWorkspaceFolders}
            workspaceOverride={workspaceOverride}
            usingWorkspaceOverride={usingWorkspaceOverride}
            indexDbPath={indexDbPath}
            indexing={indexing}
            workspaceNotice={workspaceNotice}
            onPickFolder={onPickWorkspaceFolder}
            onSetOverride={onSetWorkspaceOverride}
            onClearOverride={onClearWorkspaceOverride}
            onIndex={onIndex}
          />
        )}

        {activeTab === 'model' && (
          <>
            <SettingsCard
              title="Provider"
              description={`Endpoint ${AGENT_NAME} calls for chat completions and tool loops.`}
            >
              <label className="settings-field">
                <span className="settings-label">Provider type</span>
                <select
                  className="settings-input settings-select"
                  value={providerType}
                  onChange={(e) => {
                    const next = e.target.value as ProviderSettingsPayload['providerType'];
                    setProviderType(next);
                    const preset = getProviderPreset(next);
                    if (preset) {
                      setBaseUrl(preset.baseUrl);
                      setModel(preset.model);
                      setApiVersion(next === 'azure-openai' ? '2024-10-21' : apiVersion);
                      setRegion(next === 'bedrock' ? 'us-east-1' : region);
                      setContextWindow(preset.contextWindow);
                    }
                    markDirty();
                  }}
                >
                  {PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {isLocalProvider && (
                <>
                  <label className="settings-field">
                    <span className="settings-label">API base URL</span>
                    <input
                      type="url"
                      className="settings-input"
                      value={baseUrl}
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        markDirty();
                      }}
                      placeholder="http://localhost:11434/v1"
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">Model</span>
                    <input
                      type="text"
                      className="settings-input"
                      list="local-model-presets"
                      value={model}
                      onChange={(e) => {
                        const value = e.target.value;
                        setModel(value);
                        applyModelPreset(value);
                        markDirty();
                      }}
                      placeholder="qwen3-coder:30b"
                    />
                    <datalist id="local-model-presets">
                      {LOCAL_MODEL_PRESETS.map((preset) => (
                        <option key={preset.model} value={preset.model} label={preset.label} />
                      ))}
                    </datalist>
                    <span className="settings-hint">
                      Pick a local Ollama model, cloud model ID, or Azure deployment name.
                    </span>
                  </label>

                  {providerType === 'azure-openai' && (
                    <label className="settings-field">
                      <span className="settings-label">Azure API version</span>
                      <input
                        type="text"
                        className="settings-input"
                        value={apiVersion}
                        onChange={(e) => {
                          setApiVersion(e.target.value);
                          markDirty();
                        }}
                        placeholder="2024-10-21"
                      />
                      <span className="settings-hint">
                        The model field is your Azure deployment name.
                      </span>
                    </label>
                  )}

                  {providerType === 'bedrock' && (
                    <label className="settings-field">
                      <span className="settings-label">AWS region</span>
                      <input
                        type="text"
                        className="settings-input"
                        value={region}
                        onChange={(e) => {
                          setRegion(e.target.value);
                          markDirty();
                        }}
                        placeholder="us-east-1"
                      />
                      <span className="settings-hint">
                        Uses AWS default credentials from your environment, profile, SSO, or instance role.
                      </span>
                    </label>
                  )}

                  {contextWindowField}
                  {hasPresetContextMismatch && activeLocalPreset?.contextWindow && (
                    <p className="settings-inline-note" role="status">
                      Preset context for <strong>{activeLocalPreset.model}</strong> is{' '}
                      <strong>{activeLocalPreset.contextWindow.toLocaleString()}</strong> tokens. Save or reselect the model
                      to use that window, or keep your custom value.
                    </p>
                  )}
                </>
              )}

              {providerType === 'echo' && (
                <>
                  <p className="settings-inline-note">
                    Echo mode repeats your message — useful to verify workspace, indexing, and UI without a model.
                  </p>
                  {contextWindowField}
                </>
              )}

              <div className="settings-inline-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => onTestConnection(currentProviderSettings())}
                >
                  Test connection
                </button>
                {settings.connectionStatus && (
                  <span
                    className={`settings-status-pill ${settings.connectionOk ? 'settings-status-pill--ok' : 'settings-status-pill--err'}`}
                    role="status"
                  >
                    {settings.connectionStatus}
                  </span>
                )}
              </div>
            </SettingsCard>

            <SettingsCard title="API key" description="Optional for local Ollama. Stored in VS Code SecretStorage.">
              <div className="settings-key-row">
                <input
                  type="password"
                  className="settings-input"
                  placeholder={settings.hasApiKey ? 'Key saved — enter to replace' : 'Enter API key…'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <p className="settings-inline-note">
                Status: <strong>{settings.hasApiKey ? 'Saved' : 'Not set'}</strong>
              </p>
            </SettingsCard>
          </>
        )}

        {activeTab === 'agent' && (
          <>
            <SettingsCard
              title="Agent behavior"
              description="Control tool rounds, subagents, and editor integration."
            >
              <SettingSwitch
                label="Research subagents"
                description="Parallel read-only investigation via spawn_research_agent."
                checked={subagentsEnabled}
                onChange={(v) => {
                  setSubagentsEnabled(v);
                  markDirty();
                }}
              />
              <SettingSwitch
                label="Auto-continue rounds"
                description="Keep working after the main step budget is spent."
                checked={agentAutoContinue}
                onChange={(v) => {
                  setAgentAutoContinue(v);
                  markDirty();
                }}
              />

              <label className="settings-field">
                <span className="settings-label">Ask depth</span>
                <select
                  className="settings-input settings-select"
                  value={askDepth}
                  onChange={(e) => {
                    setAskDepth(e.target.value as SettingsView['askDepth']);
                    markDirty();
                  }}
                >
                  {ASK_DEPTH_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <span className="settings-hint">
                  Auto chooses by question type; quick favors locate answers, deep allows broader read-only exploration.
                </span>
              </label>
              <label className="settings-field">
                <span className="settings-label">Plan depth</span>
                <select
                  className="settings-input settings-select"
                  value={planDepth}
                  onChange={(e) => {
                    setPlanDepth(e.target.value as SettingsView['planDepth']);
                    markDirty();
                  }}
                >
                  {PLAN_DEPTH_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <span className="settings-hint">
                  Controls read-only discovery before plan compilation. Deep allows more codebase exploration in Plan mode.
                </span>
              </label>
              <label className="settings-field">
                <span className="settings-label">Act depth</span>
                <select
                  className="settings-input settings-select"
                  value={actDepth}
                  onChange={(e) => {
                    setActDepth(e.target.value as SettingsView['actDepth']);
                    markDirty();
                  }}
                >
                  {ACT_DEPTH_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <span className="settings-hint">
                  Controls direct Agent execution steps. Deep allows longer implementation runs before auto-continue.
                </span>
              </label>

              <SettingSwitch
                label="Ask auto-continue"
                description="Let deep Ask continue once when exploration reaches its cap."
                checked={askAutoContinue}
                onChange={(v) => {
                  setAskAutoContinue(v);
                  markDirty();
                }}
              />
              <SettingSwitch
                label="Diff previews"
                description="Open VS Code diff tabs before file edits."
                checked={showDiffPreview}
                onChange={(v) => {
                  setShowDiffPreview(v);
                  markDirty();
                }}
              />

              <div className="settings-divider" />

              <SettingStepper
                label="Main agent max steps"
                value={agentMaxSteps}
                min={1}
                max={100}
                onChange={(v) => {
                  setAgentMaxSteps(v);
                  markDirty();
                }}
              />
              <SettingStepper
                label="Max Ask tool steps"
                description="Advanced ceiling; Ask still chooses smaller budgets automatically."
                value={askMaxSteps}
                min={1}
                max={50}
                onChange={(v) => {
                  setAskMaxSteps(v);
                  markDirty();
                }}
              />
              <SettingStepper
                label="Ask max auto-continues"
                value={askMaxAutoContinues}
                min={0}
                max={10}
                disabled={!askAutoContinue}
                onChange={(v) => {
                  setAskMaxAutoContinues(v);
                  markDirty();
                }}
              />
              <SettingStepper
                label="Max auto-continues"
                value={agentMaxAutoContinues}
                min={0}
                max={10}
                disabled={!agentAutoContinue}
                onChange={(v) => {
                  setAgentMaxAutoContinues(v);
                  markDirty();
                }}
              />
              <SettingStepper
                label="Research subagent max steps"
                value={researchAgentMaxSteps}
                min={1}
                max={50}
                disabled={!subagentsEnabled}
                onChange={(v) => {
                  setResearchAgentMaxSteps(v);
                  markDirty();
                }}
              />

              <div className="settings-divider" />

              <h4 className="settings-subheading">Plan vs Act models</h4>
              <p className="settings-inline-note">
                Optional overrides. Leave blank to use the main provider model for both modes.
              </p>
              <label className="settings-field">
                <span className="settings-label">Plan mode model</span>
                <input
                  type="text"
                  className="settings-input"
                  value={planModel}
                  onChange={(e) => {
                    setPlanModel(e.target.value);
                    markDirty();
                  }}
                  placeholder={model || 'Same as main model'}
                />
              </label>
              <label className="settings-field">
                <span className="settings-label">Plan mode base URL (optional)</span>
                <input
                  type="url"
                  className="settings-input"
                  value={planBaseUrl}
                  onChange={(e) => {
                    setPlanBaseUrl(e.target.value);
                    markDirty();
                  }}
                  placeholder={baseUrl || 'Same as main provider'}
                />
              </label>
              <label className="settings-field">
                <span className="settings-label">Act mode model</span>
                <input
                  type="text"
                  className="settings-input"
                  value={actModel}
                  onChange={(e) => {
                    setActModel(e.target.value);
                    markDirty();
                  }}
                  placeholder={model || 'Same as main model'}
                />
              </label>
              <label className="settings-field">
                <span className="settings-label">Act mode base URL (optional)</span>
                <input
                  type="url"
                  className="settings-input"
                  value={actBaseUrl}
                  onChange={(e) => {
                    setActBaseUrl(e.target.value);
                    markDirty();
                  }}
                  placeholder={baseUrl || 'Same as main provider'}
                />
              </label>

              <label className="settings-field">
                <span className="settings-label">Checkpoint strategy</span>
                <select
                  className="settings-input settings-select"
                  value={checkpointStrategy}
                  onChange={(e) => {
                    setCheckpointStrategy(e.target.value as SettingsView['checkpointStrategy']);
                    markDirty();
                  }}
                >
                  <option value="git-stash">Git stash (recommended)</option>
                  <option value="shadow-git">Shadow git stash</option>
                  <option value="file-copy">File copy fallback</option>
                </select>
                <span className="settings-hint">
                  Uses git stash when the workspace is a repo; falls back to file copies otherwise.
                </span>
              </label>
            </SettingsCard>

            <SettingsCard
              title={`Checkpoints (${checkpoints.length})`}
              description="Restore pre-write snapshots created before agent edits."
            >
              <CheckpointPanel checkpoints={checkpoints} onRestore={onRestoreCheckpoint} />
            </SettingsCard>
          </>
        )}

        {activeTab === 'context' && (
          <>
            <SettingsCard
              title="Semantic vector search"
              description="Local embeddings for conceptual code search, smarter reranking, and hybrid memory recall."
            >
              <SettingSwitch
                label="Enable vector indexing"
                description="Embed code chunks during indexing. Uses MiniLM locally when available, hash fallback otherwise."
                checked={vectorsEnabled}
                onChange={(v) => {
                  setVectorsEnabled(v);
                  markDirty();
                }}
              />

              <label className="settings-field">
                <span className="settings-label">Embedding provider</span>
                <select
                  className="settings-input settings-select"
                  value={embeddingProvider}
                  disabled={!vectorsEnabled}
                  onChange={(e) => {
                    setEmbeddingProvider(e.target.value as 'minilm' | 'hash');
                    markDirty();
                  }}
                >
                  <option value="minilm">
                    MiniLM (Xenova/all-MiniLM-L6-v2){settings.minilmAvailable ? '' : ' — not installed'}
                  </option>
                  <option value="hash">Hash fallback (lightweight, lower quality)</option>
                </select>
                <span className="settings-hint">
                  {settings.minilmAvailable
                    ? 'MiniLM runs fully on your machine via @xenova/transformers.'
                    : 'Install @xenova/transformers for better semantic search, or use hash fallback.'}
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-label">Vector storage backend</span>
                <select
                  className="settings-input settings-select"
                  value={vectorBackend}
                  disabled={!vectorsEnabled}
                  onChange={(e) => {
                    setVectorBackend(e.target.value as 'sqlite' | 'lancedb');
                    markDirty();
                  }}
                >
                  <option value="sqlite">SQLite (.mitii/mitii.sqlite)</option>
                  <option value="lancedb">
                    LanceDB (.mitii/lance/){settings.lancedbAvailable ? '' : ' — not installed'}
                  </option>
                </select>
                <span className="settings-hint">
                  LanceDB scales better on large repos; SQLite is simpler and always available.
                </span>
              </label>

              <SettingSwitch
                label="Hybrid memory search"
                description="Combine keyword + vector search when recalling saved observations."
                checked={hybridMemorySearch}
                disabled={!vectorsEnabled}
                onChange={(v) => {
                  setHybridMemorySearch(v);
                  markDirty();
                }}
              />

              <div className="settings-stats-row">
                <div className="settings-stat">
                  <span className="settings-stat__value">{vectorIndex.embeddedChunks.toLocaleString()}</span>
                  <span className="settings-stat__label">Embedded chunks</span>
                </div>
                <div className="settings-stat">
                  <span className="settings-stat__value">{vectorIndex.provider}</span>
                  <span className="settings-stat__label">Provider active</span>
                </div>
                <div className="settings-stat">
                  <span className="settings-stat__value">{vectorIndex.backend}</span>
                  <span className="settings-stat__label">Backend</span>
                </div>
              </div>

              <p className="settings-inline-note">
                Save settings after changing vector options. Vector changes reload the index and rebuild embeddings.
              </p>
            </SettingsCard>

            <SettingsCard
              title="Context sources"
              description="Mixed into the prompt before the model runs. Toggles apply immediately."
            >
            {CONTEXT_TOGGLES.map(({ key, label, description }) => (
              <SettingSwitch
                key={key}
                label={label}
                description={description}
                checked={contextToggles[key]}
                disabled={key === 'vectors' && !vectorsEnabled}
                onChange={(enabled) => onToggleContext(key, enabled)}
              />
            ))}
            </SettingsCard>

            <SettingsCard
              title={`Memory (${memories.length})`}
              description="Review or clear saved observations that can be recalled in future chats."
            >
              <MemoryPanel memories={memories} onDelete={onDeleteMemory} onClear={onClearMemory} />
            </SettingsCard>
          </>
        )}

        {activeTab === 'integrations' && (
          <>
            <SettingsCard
              title="GitHub issues"
              description="Fetch private issue details when a GitHub issue URL is pasted into chat."
            >
              <div className="settings-key-row">
                <input
                  type="password"
                  className="settings-input"
                  placeholder={settings.hasGithubToken ? 'Token saved - enter to replace' : 'Enter GitHub token...'}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                />
              </div>
              <p className="settings-inline-note">
                Status: <strong>{settings.hasGithubToken ? 'Saved' : 'Not set'}</strong>
              </p>
            </SettingsCard>

            <SettingsCard
              title="Model Context Protocol (MCP)"
              description="Enable built-in servers per task and add custom MCP servers without editing JSON."
            >
              <SettingSwitch
                label="Enable MCP"
                description="Load MCP tools for this session. Built-in servers can be toggled below."
                checked={mcpEnabled}
                onChange={(v) => {
                  setMcpEnabled(v);
                  markDirty();
                }}
              />

              <div className="settings-subsection">
                <h4 className="settings-subsection__title">Built-in servers</h4>
                <p className="settings-inline-note">Toggles apply immediately for this session. Save settings to remember defaults.</p>
                {MCP_BUILTIN_TOGGLES.map(({ key, label, description }) => (
                  <SettingSwitch
                    key={key}
                    label={label}
                    description={description}
                    checked={mcpToggles[key]}
                    disabled={!mcpEnabled}
                    onChange={(enabled) => {
                      onToggleMcp(key, enabled);
                      markDirty();
                    }}
                  />
                ))}
              </div>

              <div className="settings-stats-row">
                <div className="settings-stat">
                  <span className="settings-stat__value">{settings.mcpServers}</span>
                  <span className="settings-stat__label">Servers</span>
                </div>
                <div className="settings-stat">
                  <span className="settings-stat__value">{settings.mcpTools}</span>
                  <span className="settings-stat__label">Tools</span>
                </div>
                <div className="settings-stat">
                  <span className="settings-stat__value">{settings.projectRules}</span>
                  <span className="settings-stat__label">Rules</span>
                </div>
              </div>

              {settings.mcpServerStatuses.length > 0 ? (
                <ul className="settings-mcp-list">
                  {settings.mcpServerStatuses.map((server) => (
                    <li key={server.name} className="settings-mcp-item">
                      <span className={`settings-mcp-dot ${server.connected ? 'settings-mcp-dot--ok' : 'settings-mcp-dot--err'}`} />
                      <span className="settings-mcp-name">
                        {server.name}
                        {server.builtin ? <span className="settings-mcp-badge">built-in</span> : null}
                      </span>
                      <span className="settings-mcp-meta">
                        {server.connected
                          ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
                          : server.error ?? 'Disconnected'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="settings-inline-note">
                  No MCP servers connected yet. Built-in servers start when a workspace folder is open and MCP is enabled.
                </p>
              )}
            </SettingsCard>

            <SettingsCard
              title="Custom MCP servers"
              description="Add stdio MCP servers from the UI instead of hand-editing mcp.json."
            >
              <McpServersEditor
                servers={settings.customMcpServers}
                workspaceOpen={workspaceOpen}
                onSave={onSaveCustomMcpServers}
              />
            </SettingsCard>

            <SettingsCard title="Project rules" description="Automatically loaded from your workspace.">
              <p className="settings-inline-note">
                {AGENT_NAME} reads <code>AGENTS.md</code>, <code>CLAUDE.md</code>, <code>.mitii/rules</code>,{' '}
                <code>.clinerules</code>, and Continue/Cursor rule folders into context.
              </p>
              <p className="settings-inline-note">
                Active rule files: <strong>{settings.projectRules}</strong>
              </p>
            </SettingsCard>
          </>
        )}

        {activeTab === 'safety' && (
          <SettingsCard
            title="Approval policy"
            description={`When ${AGENT_NAME} pauses for review before edits or shell commands.`}
          >
            <label className="settings-field">
              <span className="settings-label">Autonomy preset</span>
              <select
                className="settings-input settings-select"
                value={autonomyPreset}
                onChange={(e) => {
                  const preset = e.target.value as SafetySettingsPayload['autonomyPreset'];
                  setAutonomyPreset(preset);
                  if (preset === 'safe' || preset === 'enterprise') {
                    setApprovalMode('review_all');
                  } else if (preset === 'guided') {
                    setApprovalMode('ask_edits');
                  } else if (preset === 'builder') {
                    setApprovalMode('ask_commands');
                  } else if (preset === 'pilot') {
                    setApprovalMode('auto');
                  }
                  markDirty();
                }}
              >
                {AUTONOMY_PRESETS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="settings-hint">
                {AUTONOMY_PRESETS.find((p) => p.id === autonomyPreset)?.description}
              </span>
            </label>

            <label className="settings-field">
              <span className="settings-label">Approval mode</span>
              <select
                className="settings-input settings-select"
                value={approvalMode}
                onChange={(e) => {
                  const mode = e.target.value as ApprovalMode;
                  setApprovalMode(mode);
                  setAutonomyPreset(deriveSafetySettings(mode).autonomyPreset);
                  markDirty();
                }}
              >
                {APPROVAL_MODE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="settings-hint">{approvalModeDescription(approvalMode)}</span>
            </label>

            <div className="settings-policy-summary">
              <span>{settings.requireApprovalWrites ? 'Edits: ask' : 'Edits: auto'}</span>
              <span>{settings.requireApprovalShell ? 'Commands: ask' : 'Commands: auto'}</span>
            </div>
          </SettingsCard>
        )}

        {activeTab === 'debug' && settings.localDebugAvailable && (
          <>
            <SettingsCard
              title="Local debug"
              description="Development-only diagnostics for inspecting agent prompts, context, tool calls, and UI traces."
            >
              <SettingSwitch
                label="JSONL session log"
                description="Write canonical session events to .mitii/logs, including every tool start/end."
                checked={sessionLogging}
                onChange={(v) => {
                  setSessionLogging(v);
                  if (!v) setDebugMetrics(false);
                  markDirty();
                }}
              />
              <SettingSwitch
                label="Verbose debug traces"
                description="Include full sanitized inputs, context queries, LLM step metadata, and UI update traces."
                checked={debugMetrics && sessionLogging}
                disabled={!sessionLogging}
                onChange={(v) => {
                  setDebugMetrics(v);
                  markDirty();
                }}
              />
              <p className="settings-inline-note">
                This panel only appears in the Extension Development Host. Logs are local files under{' '}
                <code>.mitii/logs</code>.
              </p>
            </SettingsCard>
          </>
        )}
      </div>

      {showSaveBar && (
        <footer className="settings-save-bar">
          <span className="settings-save-bar__hint">
            {dirty ? 'Unsaved changes' : saved ? 'All changes saved' : 'No pending changes'}
          </span>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSaveAll}
            disabled={!dirty && !apiKey.trim() && !githubToken.trim()}
          >
            {saved ? 'Saved' : 'Save changes'}
          </button>
        </footer>
      )}
    </div>
  );
}
