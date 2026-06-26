import { useState } from 'react';
import type { SettingsView } from '../../../vscode/webview/messages';

interface SettingsPanelProps {
  settings: SettingsView;
  onSaveApiKey: (key: string) => void;
  onIndex: () => void;
}

export function SettingsPanel({ settings, onSaveApiKey, onIndex }: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState('');

  const handleSaveKey = () => {
    if (apiKey.trim()) {
      onSaveApiKey(apiKey.trim());
      setApiKey('');
    }
  };

  return (
    <div className="settings-panel">
      <h2 className="settings-title">Settings</h2>

      <section className="settings-section">
        <h3>Provider</h3>
        <p className="settings-row">Type: <strong>{settings.providerType}</strong></p>
        <p className="settings-row">Base URL: <strong>{settings.baseUrl}</strong></p>
        <p className="settings-row">Model: <strong>{settings.model}</strong></p>
        <p className="settings-row">API key: <strong>{settings.hasApiKey ? 'Saved' : 'Not set'}</strong></p>
        <div className="api-key-row">
          <input
            type="password"
            className="api-key-input"
            placeholder="Enter API key…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-label="API key"
          />
          <button type="button" className="btn btn--primary btn--small" onClick={handleSaveKey} disabled={!apiKey.trim()}>
            Save key
          </button>
        </div>
        <p className="settings-placeholder">Provider type/URL/model via VS Code settings (thunder.provider.*).</p>
      </section>

      <section className="settings-section">
        <h3>Indexing</h3>
        <p className="settings-row">Enabled: <strong>{settings.indexingEnabled ? 'Yes' : 'No'}</strong></p>
        <button type="button" className="btn btn--secondary" onClick={onIndex}>
          Index Workspace
        </button>
      </section>

      <section className="settings-section">
        <h3>Safety</h3>
        <p className="settings-row">Approve writes: <strong>{settings.requireApprovalWrites ? 'Yes' : 'No'}</strong></p>
        <p className="settings-row">Approve shell: <strong>{settings.requireApprovalShell ? 'Yes' : 'No'}</strong></p>
      </section>

      <section className="settings-section">
        <h3>Memory</h3>
        <p className="settings-row">Enabled: <strong>{settings.memoryEnabled ? 'Yes' : 'No'}</strong></p>
      </section>
    </div>
  );
}
