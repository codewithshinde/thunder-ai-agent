import { useState, useEffect, useCallback } from 'react';
import { AGENT_NAME } from '../../../shared/brand';
import type {
  ApprovalMode,
  ContextToggles,
  ProviderSettingsPayload,
  SafetySettingsPayload,
  SettingsView,
  ThunderSettingsPayload,
  WorkspaceNoticeView,
} from '../../../vscode/webview/messages';
import { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
import { SettingsCard } from './SettingsCard';
import { SettingSwitch } from './SettingSwitch';
import { SettingStepper } from './SettingStepper';

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
];

interface SettingsPanelProps {
  settings: SettingsView;
  workspaceOpen: boolean;
  workspacePath: string;
  vscodeWorkspaceFolders: string[];
  workspaceOverride: string;
  usingWorkspaceOverride: boolean;
  indexDbPath: string;
  indexed: number;
  indexingRunning: boolean;
  workspaceNotice: WorkspaceNoticeView | null;
  contextToggles: ContextToggles;
  onSaveApiKey: (key: string) => void;
  onSaveAllSettings: (settings: ThunderSettingsPayload) => void;
  onTestConnection: (settings: ProviderSettingsPayload) => void;
  onPickWorkspaceFolder: () => void;
  onSetWorkspaceOverride: (path: string) => void;
  onClearWorkspaceOverride: () => void;
  onIndex: () => void;
  onToggleContext: (source: keyof ContextToggles, enabled: boolean) => void;
}

export function SettingsPanel({
  settings,
  workspaceOpen,
  workspacePath,
  vscodeWorkspaceFolders,
  workspaceOverride,
  usingWorkspaceOverride,
  indexDbPath,
  indexed,
  indexingRunning,
  workspaceNotice,
  contextToggles,
  onSaveApiKey,
  onSaveAllSettings,
  onTestConnection,
  onPickWorkspaceFolder,
  onSetWorkspaceOverride,
  onClearWorkspaceOverride,
  onIndex,
  onToggleContext,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('workspace');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [providerType, setProviderType] = useState<'echo' | 'openai-compatible'>(
    settings.providerType as 'echo' | 'openai-compatible'
  );
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [contextWindow, setContextWindow] = useState(settings.contextWindow);

  const [subagentsEnabled, setSubagentsEnabled] = useState(settings.subagentsEnabled);
  const [agentMaxSteps, setAgentMaxSteps] = useState(settings.agentMaxSteps);
  const [agentAutoContinue, setAgentAutoContinue] = useState(settings.agentAutoContinue);
  const [agentMaxAutoContinues, setAgentMaxAutoContinues] = useState(settings.agentMaxAutoContinues);
  const [researchAgentMaxSteps, setResearchAgentMaxSteps] = useState(settings.researchAgentMaxSteps);
  const [showDiffPreview, setShowDiffPreview] = useState(settings.showDiffPreview);

  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(settings.approvalMode);
  const [mcpEnabled, setMcpEnabled] = useState(settings.mcpEnabled);
  const [sessionLogging, setSessionLogging] = useState(settings.sessionLogging);
  const [debugMetrics, setDebugMetrics] = useState(settings.debugMetrics);

  useEffect(() => {
    setProviderType(settings.providerType as 'echo' | 'openai-compatible');
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
    setContextWindow(settings.contextWindow);
    setSubagentsEnabled(settings.subagentsEnabled);
    setAgentMaxSteps(settings.agentMaxSteps);
    setAgentAutoContinue(settings.agentAutoContinue);
    setAgentMaxAutoContinues(settings.agentMaxAutoContinues);
    setResearchAgentMaxSteps(settings.researchAgentMaxSteps);
    setShowDiffPreview(settings.showDiffPreview);
    setApprovalMode(settings.approvalMode);
    setMcpEnabled(settings.mcpEnabled);
    setSessionLogging(settings.sessionLogging);
    setDebugMetrics(settings.debugMetrics);
    setDirty(false);
  }, [settings]);

  const markDirty = useCallback(() => setDirty(true), []);

  const buildPayload = (): ThunderSettingsPayload | null => {
    if (!baseUrl.trim() || !model.trim() || contextWindow < 1024) {
      return null;
    }
    return {
      provider: {
        providerType,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        contextWindow,
      },
      agent: {
        subagentsEnabled,
        maxSteps: agentMaxSteps,
        autoContinue: agentAutoContinue,
        maxAutoContinues: agentMaxAutoContinues,
        researchAgentMaxSteps,
        showDiffPreview,
      },
      safety: deriveSafetySettings(approvalMode),
      mcp: { enabled: mcpEnabled },
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
    setSaved(true);
    setDirty(false);
    setTimeout(() => setSaved(false), 2500);
  };

  const currentProviderSettings = (): ProviderSettingsPayload => ({
    providerType,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    contextWindow,
  });

  const isLocalProvider = providerType === 'openai-compatible';
  const showSaveBar = activeTab !== 'workspace' && activeTab !== 'context';
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
            indexed={indexed}
            indexingRunning={indexingRunning}
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
                    setProviderType(e.target.value as 'echo' | 'openai-compatible');
                    markDirty();
                  }}
                >
                  <option value="echo">Echo (test / no LLM)</option>
                  <option value="openai-compatible">OpenAI-compatible (Ollama, LM Studio, cloud)</option>
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
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        markDirty();
                      }}
                      placeholder="qwen3-coder:30b"
                    />
                  </label>

                  <SettingStepper
                    label="Context window"
                    description="Token budget for codebase context per request."
                    value={contextWindow}
                    min={1024}
                    max={128000}
                    step={1024}
                    onChange={(v) => {
                      setContextWindow(v);
                      markDirty();
                    }}
                  />
                </>
              )}

              {providerType === 'echo' && (
                <p className="settings-inline-note">
                  Echo mode repeats your message — useful to verify workspace, indexing, and UI without a model.
                </p>
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
          </SettingsCard>
        )}

        {activeTab === 'context' && (
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
                onChange={(enabled) => onToggleContext(key, enabled)}
              />
            ))}
          </SettingsCard>
        )}

        {activeTab === 'integrations' && (
          <>
            <SettingsCard
              title="Model Context Protocol (MCP)"
              description="Built-in free servers (filesystem, memory, sequential-thinking) start automatically. Add more via VS Code settings or workspace mcp.json."
            >
              <SettingSwitch
                label="Enable MCP"
                description="Load built-in servers plus thunder.mcp.servers, .mitii/mcp.json, and .mcp.json."
                checked={mcpEnabled}
                onChange={(v) => {
                  setMcpEnabled(v);
                  markDirty();
                }}
              />

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
                  No MCP servers connected yet. Built-in servers start when a workspace folder is open.
                  Add more in VS Code settings under <code>thunder.mcp.servers</code> or{' '}
                  <code>.mitii/mcp.json</code>.
                </p>
              )}
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
              <span className="settings-label">Approval mode</span>
              <select
                className="settings-input settings-select"
                value={approvalMode}
                onChange={(e) => {
                  setApprovalMode(e.target.value as ApprovalMode);
                  markDirty();
                }}
              >
                <option value="review_all">Ask before edits and commands</option>
                <option value="ask_edits">Ask before edits</option>
                <option value="ask_deletes">Ask before deletes</option>
                <option value="ask_commands">Ask before commands</option>
                <option value="auto">Auto approve allowed operations</option>
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
            disabled={!dirty && !apiKey.trim()}
          >
            {saved ? 'Saved' : 'Save changes'}
          </button>
        </footer>
      )}
    </div>
  );
}

function deriveSafetySettings(approvalMode: ApprovalMode): SafetySettingsPayload {
  switch (approvalMode) {
    case 'review_all':
      return { approvalMode, requireApprovalForWrites: true, requireApprovalForShell: true };
    case 'ask_edits':
      return { approvalMode, requireApprovalForWrites: true, requireApprovalForShell: false };
    case 'ask_deletes':
      return { approvalMode, requireApprovalForWrites: false, requireApprovalForShell: false };
    case 'ask_commands':
      return { approvalMode, requireApprovalForWrites: false, requireApprovalForShell: true };
    case 'auto':
      return { approvalMode, requireApprovalForWrites: false, requireApprovalForShell: false };
  }
}

function approvalModeDescription(mode: ApprovalMode): string {
  switch (mode) {
    case 'review_all':
      return 'Pause before file edits and mutating shell commands.';
    case 'ask_edits':
      return 'Pause before write_file, apply_patch, and delete-like shell commands.';
    case 'ask_deletes':
      return 'Pause only for delete-like shell commands such as rm or npm uninstall.';
    case 'ask_commands':
      return 'Pause before mutating shell commands, but allow file edits.';
    case 'auto':
      return 'Do not pause for allowed operations. Dangerous commands remain blocked.';
  }
}
