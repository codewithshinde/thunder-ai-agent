import { useState, useEffect } from 'react';
import type { ContextToggles, ProviderSettingsPayload, SettingsView, WorkspaceNoticeView } from '../../../vscode/webview/messages';
import { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
import { SettingNote } from './SettingNote';

const CONTEXT_TOGGLES: Array<{
  key: keyof ContextToggles;
  label: string;
  why: string;
}> = [
  {
    key: 'repoMap',
    label: 'Repository map',
    why: 'Compact symbol outline of the codebase so the model knows what files and exports exist.',
  },
  {
    key: 'fts',
    label: 'Full-text search',
    why: 'Keyword search over indexed files — best for finding symbols, imports, and strings.',
  },
  {
    key: 'gitDiff',
    label: 'Git diff',
    why: 'Includes your uncommitted changes so the agent sees what you are already editing.',
  },
  {
    key: 'diagnostics',
    label: 'Diagnostics',
    why: 'Linter/TypeScript errors from VS Code. Enable when fixing bugs; off by default to avoid unrelated file noise.',
  },
  {
    key: 'memory',
    label: 'Session memory',
    why: 'Long-term notes from past tasks (decisions, conventions) injected into new chats.',
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
  onSaveProviderSettings: (settings: ProviderSettingsPayload) => void;
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
  onSaveProviderSettings,
  onTestConnection,
  onPickWorkspaceFolder,
  onSetWorkspaceOverride,
  onClearWorkspaceOverride,
  onIndex,
  onToggleContext,
}: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState('');
  const [providerType, setProviderType] = useState<'echo' | 'openai-compatible'>(
    settings.providerType as 'echo' | 'openai-compatible'
  );
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [contextWindow, setContextWindow] = useState(String(settings.contextWindow));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setProviderType(settings.providerType as 'echo' | 'openai-compatible');
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
    setContextWindow(String(settings.contextWindow));
  }, [settings]);

  const handleSaveKey = () => {
    if (apiKey.trim()) {
      onSaveApiKey(apiKey.trim());
      setApiKey('');
    }
  };

  const handleSaveProvider = () => {
    const parsedContext = parseInt(contextWindow, 10);
    if (!baseUrl.trim() || !model.trim() || isNaN(parsedContext) || parsedContext < 1024) {
      return;
    }
    onSaveProviderSettings({
      providerType,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      contextWindow: parsedContext,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const currentProviderSettings = (): ProviderSettingsPayload => {
    const parsedContext = parseInt(contextWindow, 10);
    return {
      providerType,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      contextWindow: Number.isFinite(parsedContext) ? parsedContext : settings.contextWindow,
    };
  };

  const isLocalProvider = providerType === 'openai-compatible';

  return (
    <div className="settings-panel">
      <h2 className="settings-title">Settings</h2>
      <p className="settings-intro">
        Configure where Thunder works, which model it calls, and what context it gathers.
        Changes apply to the next message.
      </p>

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

      <section className="settings-section">
        <h3>Provider (LLM)</h3>
        <SettingNote title="Why this matters">
          Thunder sends your messages and tool results to this endpoint. Use <strong>Echo</strong> to test the UI
          without a model. Use <strong>OpenAI-compatible</strong> for Ollama, LM Studio, or cloud APIs that speak
          the OpenAI chat/completions format.
        </SettingNote>

        <label className="settings-field">
          <span className="settings-label">Provider type</span>
          <select
            className="settings-input"
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as 'echo' | 'openai-compatible')}
          >
            <option value="echo">Echo (test / no LLM)</option>
            <option value="openai-compatible">OpenAI-compatible (Ollama, LM Studio, etc.)</option>
          </select>
        </label>

        {isLocalProvider && (
          <>
            <label className="settings-field">
              <span className="settings-label">Local API URL</span>
              <input
                type="url"
                className="settings-input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                aria-label="Local API URL"
              />
              <span className="settings-hint">Base URL for chat completions. Ollama: http://localhost:11434/v1</span>
            </label>

            <label className="settings-field">
              <span className="settings-label">Model</span>
              <input
                type="text"
                className="settings-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="qwen3-coder:30b"
                aria-label="Model name"
              />
              <span className="settings-hint">Must match a model pulled/loaded at your endpoint (e.g. ollama list).</span>
            </label>

            <label className="settings-field">
              <span className="settings-label">Context window (tokens)</span>
              <input
                type="number"
                className="settings-input"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                min={1024}
                max={1000000}
                step={1024}
                aria-label="Context window tokens"
              />
              <span className="settings-hint">
                Used to budget how much codebase context fits in each request. Set to your model&apos;s real limit.
              </span>
            </label>

            <button
              type="button"
              className="btn btn--primary"
              onClick={handleSaveProvider}
              disabled={!baseUrl.trim() || !model.trim()}
            >
              {saved ? 'Saved!' : 'Save provider settings'}
            </button>

            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => onTestConnection(currentProviderSettings())}
              style={{ marginTop: '8px' }}
            >
              Test connection
            </button>

            {settings.connectionStatus && (
              <p
                className={`settings-hint ${settings.connectionOk ? 'connection-ok' : 'connection-fail'}`}
                role="status"
              >
                {settings.connectionStatus}
              </p>
            )}
          </>
        )}

        {providerType === 'echo' && (
          <>
            <SettingNote>
              Echo repeats your message — useful to verify workspace, indexing, and the chat UI without GPU/API setup.
            </SettingNote>
            <button type="button" className="btn btn--primary" onClick={handleSaveProvider}>
              {saved ? 'Saved!' : 'Save provider settings'}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => onTestConnection(currentProviderSettings())}
              style={{ marginTop: '8px' }}
            >
              Test echo mode
            </button>
            {settings.connectionStatus && (
              <p className="settings-hint connection-ok" role="status">
                {settings.connectionStatus}
              </p>
            )}
          </>
        )}

        <div className="settings-divider" />

        <p className="settings-row">
          API key: <strong>{settings.hasApiKey ? 'Saved' : 'Not set'}</strong>
        </p>
        <div className="api-key-row">
          <input
            type="password"
            className="api-key-input"
            placeholder="Enter API key (if required)…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-label="API key"
          />
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={handleSaveKey}
            disabled={!apiKey.trim()}
          >
            Save key
          </button>
        </div>
        <span className="settings-hint">
          Optional for local Ollama. Required for cloud APIs. Stored in VS Code SecretStorage, not plain settings.
        </span>
      </section>

      <section className="settings-section">
        <h3>Context sources</h3>
        <SettingNote title="Why this matters">
          These are mixed into the prompt <em>before</em> the model runs. The agent can still use tools to read more.
          Disable sources you do not need to save tokens and reduce distraction (e.g. diagnostics during audits).
        </SettingNote>
        <div className="settings-toggles">
          {CONTEXT_TOGGLES.map(({ key, label, why }) => (
            <label key={key} className="settings-toggle settings-toggle--rich">
              <span className="settings-toggle-head">
                <input
                  type="checkbox"
                  checked={contextToggles[key]}
                  onChange={(e) => onToggleContext(key, e.target.checked)}
                />
                <span>{label}</span>
              </span>
              <span className="settings-hint">{why}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3>Indexing</h3>
        <SettingNote>
          When enabled, Thunder respects .gitignore and skips huge files. Indexing is required for full-text search
          and accurate repo map. Controlled in VS Code settings: <code>thunder.indexing.enabled</code>.
        </SettingNote>
        <p className="settings-row">Enabled: <strong>{settings.indexingEnabled ? 'Yes' : 'No'}</strong></p>
      </section>

      <section className="settings-section">
        <h3>Safety</h3>
        <SettingNote>
          Writes and shell commands can change your project. Approvals let you review diffs before apply.
          Autonomy presets are configured in VS Code user settings under <code>thunder.safety</code>.
        </SettingNote>
        <p className="settings-row">Approve writes: <strong>{settings.requireApprovalWrites ? 'Yes' : 'No'}</strong></p>
        <p className="settings-row">Approve shell: <strong>{settings.requireApprovalShell ? 'Yes' : 'No'}</strong></p>
      </section>

      <section className="settings-section">
        <h3>Memory</h3>
        <SettingNote>
          After tasks, Thunder can save short observations (decisions, conventions) for future chats in this workspace.
        </SettingNote>
        <p className="settings-row">Enabled: <strong>{settings.memoryEnabled ? 'Yes' : 'No'}</strong></p>
      </section>
    </div>
  );
}
