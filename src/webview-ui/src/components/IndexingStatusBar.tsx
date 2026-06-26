import type { IndexingStatusView } from '../../../vscode/webview/messages';
import { IconButton } from './IconButton';
import { IconIndex } from './Icons';

interface IndexingStatusBarProps {
  status: IndexingStatusView;
  onIndex: () => void;
}

export function IndexingStatusBar({ status, onIndex }: IndexingStatusBarProps) {
  const label = status.running
    ? `Indexing… ${status.queued} queued`
    : status.indexed > 0
      ? `${status.indexed} files indexed${status.failed > 0 ? ` · ${status.failed} failed` : ''}`
      : 'Index workspace';

  return (
    <div className="indexing-chip">
      {status.running && <span className="indexing-chip__pulse" aria-hidden="true" />}
      <IconButton
        label={label}
        variant="ghost"
        onClick={onIndex}
        disabled={status.running}
        className="indexing-chip__btn"
      >
        <IconIndex width={14} height={14} />
      </IconButton>
    </div>
  );
}
