import type { IndexingStatusView } from '../../../vscode/webview/messages';

interface IndexingStatusBarProps {
  status: IndexingStatusView;
  onIndex: () => void;
}

export function IndexingStatusBar({ status, onIndex }: IndexingStatusBarProps) {
  return (
    <div className="indexing-bar">
      <span className="indexing-bar__label">
        {status.running
          ? `Indexing… ${status.queued} queued`
          : `${status.indexed} indexed`}
        {status.failed > 0 && ` · ${status.failed} failed`}
      </span>
      <button type="button" className="btn btn--secondary btn--small" onClick={onIndex} disabled={status.running}>
        {status.running ? 'Running…' : 'Index'}
      </button>
    </div>
  );
}
