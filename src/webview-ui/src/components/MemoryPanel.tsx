import type { MemoryItemView } from '../../../vscode/webview/messages';

interface MemoryPanelProps {
  memories: MemoryItemView[];
  onDelete: (id: number) => void;
  onClear: () => void;
}

export function MemoryPanel({ memories, onDelete, onClear }: MemoryPanelProps) {
  if (memories.length === 0) {
    return (
      <div className="side-panel">
        <h3 className="panel-title">Memory</h3>
        <p className="panel-empty">No observations yet.</p>
      </div>
    );
  }

  return (
    <div className="side-panel">
      <div className="panel-header">
        <h3 className="panel-title">Memory</h3>
        <button type="button" className="btn btn--secondary btn--small" onClick={onClear}>
          Clear all
        </button>
      </div>
      <ul className="memory-list">
        {memories.map((m) => (
          <li key={m.id} className="memory-item">
            <div className="memory-item__meta">
              <span className="memory-item__type">{m.type}</span>
              <button type="button" className="memory-item__delete" onClick={() => onDelete(m.id)} aria-label="Delete">
                ×
              </button>
            </div>
            <p className="memory-item__text">{m.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
