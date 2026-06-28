interface WorkspaceBannerProps {
  workspaceOpen: boolean;
  workspacePath: string;
  vscodeWorkspaceFolders: string[];
  usingWorkspaceOverride: boolean;
  indexed: number;
}

export function WorkspaceBanner({
  workspaceOpen,
  workspacePath,
  vscodeWorkspaceFolders,
  usingWorkspaceOverride,
  indexed,
}: WorkspaceBannerProps) {
  if (workspaceOpen && indexed > 0 && !usingWorkspaceOverride) {
    return null;
  }

  if (workspaceOpen && indexed > 0) {
    return (
      <div className="workspace-banner workspace-banner--info" role="status">
        Using VS Code folder: <code title={workspacePath}>{shortPath(workspacePath)}</code>
      </div>
    );
  }

  if (!workspaceOpen) {
    return (
      <div className="workspace-banner workspace-banner--warn" role="alert">
        <strong>No workspace.</strong> Open a folder or set a path in Settings.
        {vscodeWorkspaceFolders.length === 0 && (
          <span> F5: use <em>Run Extension (parent monorepo)</em> launch config.</span>
        )}
      </div>
    );
  }

  return (
    <div className="workspace-banner workspace-banner--info" role="status">
      <code title={workspacePath}>{shortPath(workspacePath)}</code>
      {usingWorkspaceOverride && <span> (manual override — open a VS Code folder to auto-detect)</span>}
      {' '}— indexing…
    </div>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[/\\]/);
  if (parts.length <= 4) return path;
  return `…/${parts.slice(-3).join('/')}`;
}
