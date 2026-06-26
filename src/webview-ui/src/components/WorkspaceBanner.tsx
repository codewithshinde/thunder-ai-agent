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
  if (workspaceOpen && indexed > 0) {
    return null;
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
      {usingWorkspaceOverride && <span> (override)</span>}
      {' '}— not indexed. Use Settings → Index.
    </div>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[/\\]/);
  if (parts.length <= 4) return path;
  return `…/${parts.slice(-3).join('/')}`;
}
