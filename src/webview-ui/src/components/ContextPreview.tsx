import type { ContextItemView } from '../../../vscode/webview/messages';

interface ContextPreviewProps {
  items: ContextItemView[];
  totalTokens: number;
  visible: boolean;
  onToggle: () => void;
}

export function ContextPreview({ items, totalTokens, visible, onToggle }: ContextPreviewProps) {
  return (
    <div className="context-preview">
      <button type="button" className="context-preview__toggle" onClick={onToggle}>
        Context {visible ? '▾' : '▸'} — {items.length} items, ~{totalTokens} tokens
      </button>
      {visible && items.length > 0 && (
        <ul className="context-preview__list">
          {items.map((item) => (
            <li key={item.id} className="context-preview__item">
              <div className="context-preview__meta">
                <span className="context-preview__source">{item.source}</span>
                {item.relPath && <span className="context-preview__path">{item.relPath}</span>}
                <span className="context-preview__tokens">{item.tokenEstimate}t</span>
              </div>
              <p className="context-preview__reason">{item.reason}</p>
              <pre className="context-preview__snippet">{item.preview}</pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
