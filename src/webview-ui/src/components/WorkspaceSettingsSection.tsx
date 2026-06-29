import { useState, useEffect } from 'react';
import { AGENT_NAME } from '../../../shared/brand';
import type { WorkspaceNoticeView } from '../../../vscode/webview/messages';
import { SettingNote } from './SettingNote';

interface WorkspaceSettingsSectionProps {
  workspaceOpen: boolean;
  workspacePath: string;
  vscodeWorkspaceFolders: string[];
  workspaceOverride: string;
  usingWorkspaceOverride: boolean;
  indexDbPath: string;
  indexed: number;
  indexingRunning: boolean;
  workspaceNotice: WorkspaceNoticeView | null;
  onPickFolder: () => void;
  onSetOverride: (path: string) => void;
  onClearOverride: () => void;
  onIndex: () => void;
}

export function WorkspaceSettingsSection({
  workspaceOpen,
  workspacePath,
  vscodeWorkspaceFolders,
  workspaceOverride,
  usingWorkspaceOverride,
  indexDbPath,
  indexed,
  indexingRunning,
  workspaceNotice,
  onPickFolder,
  onSetOverride,
  onClearOverride,
  onIndex,
}: WorkspaceSettingsSectionProps) {
  const [overrideInput, setOverrideInput] = useState(workspaceOverride);

  useEffect(() => {
    setOverrideInput(workspaceOverride);
  }, [workspaceOverride]);

  return (
    <section className="settings-section">
      <h3>Workspace</h3>

      <SettingNote title="Why this matters">
        {AGENT_NAME} needs a <strong>project root</strong> to index files, run tools, and build context.
        When you debug with F5, the Extension Host may open the <em>monorepo</em> folder — not your app.
        Use <strong>Browse</strong> or paste the absolute path to the project you want the agent to work on
        (e.g. your Kitchen KOT app), then <strong>Save &amp; apply</strong> and <strong>Index</strong>.
      </SettingNote>

      {workspaceNotice && (
        <p
          className={`workspace-notice workspace-notice--${workspaceNotice.kind}`}
          role="status"
        >
          {workspaceNotice.message}
        </p>
      )}

      <div className="settings-status-grid">
        <div className="settings-status-item">
          <span className="settings-label">Effective path</span>
          <strong className="settings-path" title={workspacePath}>
            {workspaceOpen ? workspacePath : 'Not set'}
          </strong>
        </div>
        <div className="settings-status-item">
          <span className="settings-label">Source</span>
          <strong>{usingWorkspaceOverride ? 'Saved override' : 'VS Code open folder'}</strong>
        </div>
        <div className="settings-status-item">
          <span className="settings-label">Indexed files</span>
          <strong>{indexed}{indexingRunning ? ' (running…)' : ''}</strong>
        </div>
      </div>

      {indexDbPath && (
        <p className="settings-hint settings-path" title={indexDbPath}>
          Index database: {indexDbPath}
        </p>
      )}

      <div className="settings-divider" />

      <p className="settings-label">VS Code open folders (this window)</p>
      {vscodeWorkspaceFolders.length === 0 ? (
        <SettingNote variant="warn" title="F5 / Extension Development Host">
          No folder is open in this window. That is normal when debugging {AGENT_NAME} itself.
          Set a <strong>workspace path override</strong> below — it is saved even without an open folder.
          Launch config tip: use <em>Run Extension (parent monorepo)</em> or open your target project folder.
        </SettingNote>
      ) : (
        <ul className="settings-folder-list">
          {vscodeWorkspaceFolders.map((folder) => (
            <li key={folder} className="settings-path" title={folder}>
              {folder}
            </li>
          ))}
        </ul>
      )}

      <label className="settings-field">
        <span className="settings-label">Workspace path override</span>
        <input
          type="text"
          className="settings-input"
          value={overrideInput}
          onChange={(e) => setOverrideInput(e.target.value)}
          placeholder="/absolute/path/to/your/project"
          aria-label="Workspace path override"
        />
        <span className="settings-hint">
          Absolute path to the repo {AGENT_NAME} should use. Persisted locally (works without an open VS Code folder).
          Leave empty to use the folder open in VS Code.
        </span>
      </label>

      <div className="settings-button-row">
        <button type="button" className="btn btn--secondary btn--small" onClick={onPickFolder}>
          Browse…
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          onClick={() => onSetOverride(overrideInput)}
          disabled={!overrideInput.trim() && !usingWorkspaceOverride}
        >
          Save &amp; apply
        </button>
        {usingWorkspaceOverride && (
          <button type="button" className="btn btn--secondary btn--small" onClick={onClearOverride}>
            Use VS Code folder
          </button>
        )}
      </div>

      <div className="settings-divider" />

      <SettingNote title="Indexing">
        Indexing scans your project into a local SQLite database for fast search, repo map, and context.
        Run this after changing the workspace path. Large projects may take a minute.
      </SettingNote>

      <button
        type="button"
        className="btn btn--secondary"
        onClick={onIndex}
        disabled={!workspaceOpen || indexingRunning}
      >
        {indexingRunning ? 'Indexing…' : 'Index workspace'}
      </button>
    </section>
  );
}
