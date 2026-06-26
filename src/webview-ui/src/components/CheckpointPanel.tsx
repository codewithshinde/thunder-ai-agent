import type { CheckpointView } from '../../../vscode/webview/messages';

interface CheckpointPanelProps {
  checkpoints: CheckpointView[];
  onRestore: (id: string) => void;
}

export function CheckpointPanel({ checkpoints, onRestore }: CheckpointPanelProps) {
  if (checkpoints.length === 0) {
    return (
      <div className="side-panel">
        <h3 className="panel-title">Checkpoints</h3>
        <p className="panel-empty">No checkpoints yet.</p>
      </div>
    );
  }

  return (
    <div className="side-panel">
      <h3 className="panel-title">Checkpoints</h3>
      <ul className="checkpoint-list">
        {checkpoints.map((cp) => (
          <li key={cp.id} className="checkpoint-item">
            <div className="checkpoint-item__meta">
              <span className="checkpoint-item__kind">{cp.kind}</span>
              <span className="checkpoint-item__time">
                {new Date(cp.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="checkpoint-item__files">{cp.files.join(', ') || '(no files)'}</p>
            <button type="button" className="btn btn--secondary btn--small" onClick={() => onRestore(cp.id)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
