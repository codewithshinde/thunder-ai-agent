import type { ContextBudgetView, ContextItemView } from '../../../vscode/webview/messages';

interface ContextDebuggerPanelProps {
  budget: ContextBudgetView | null;
  items: ContextItemView[];
  totalTokens: number;
  lastRequestTokens?: number;
  contextWindow?: number;
  expanded: boolean;
  onToggle: () => void;
}

export function ContextDebuggerPanel({
  budget,
  items,
  totalTokens,
  lastRequestTokens = 0,
  contextWindow = 0,
  expanded,
  onToggle,
}: ContextDebuggerPanelProps) {
  if (!budget && items.length === 0 && lastRequestTokens <= 0) return null;

  const used = budget?.usedTokens ?? totalTokens;
  const limit = budget?.budgetLimit ?? Math.max(used, 1);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const requestTokens = lastRequestTokens > 0 ? lastRequestTokens : used;
  const requestLimit = contextWindow > 0 ? contextWindow : limit;
  const requestPct = requestLimit > 0
    ? Math.min(100, Math.round((requestTokens / requestLimit) * 100))
    : 0;

  return (
    <section className="context-debugger" aria-label="Retrieved context debugger">
      <button type="button" className="context-debugger__toggle" onClick={onToggle}>
        <span>Retrieved context</span>
        <span className="context-debugger__meta">
          {used.toLocaleString()} / {limit.toLocaleString()} retrieved ({pct}%)
          {requestTokens > 0 && requestTokens !== used && (
            <> · {requestTokens.toLocaleString()} / {requestLimit.toLocaleString()} request ({requestPct}%)</>
          )}
        </span>
        <span className="context-debugger__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      <div className="context-debugger__meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} title="Retrieved context budget">
        <div className="context-debugger__meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {requestTokens > 0 && requestLimit > 0 && (
        <div
          className="context-debugger__meter context-debugger__meter--request"
          role="meter"
          aria-valuenow={requestPct}
          aria-valuemin={0}
          aria-valuemax={100}
          title="Latest model request size"
        >
          <div className="context-debugger__meter-fill context-debugger__meter-fill--request" style={{ width: `${requestPct}%` }} />
        </div>
      )}

      {expanded && (
        <div className="context-debugger__body">
          {budget && (
            <div className="context-debugger__stats">
              <span>Retrieved {budget.retrievedCount}</span>
              <span>Included {budget.includedCount}</span>
              {budget.truncatedCount > 0 && <span>Truncated {budget.truncatedCount}</span>}
              {budget.dropped.length > 0 && <span className="context-debugger__warn">Dropped {budget.dropped.length}</span>}
            </div>
          )}

          {budget && budget.sourceBreakdown.length > 0 && (
            <div className="context-debugger__section">
              <h4>Retrieved source tokens</h4>
              <ul className="context-debugger__list">
                {budget.sourceBreakdown.map((row) => (
                  <li key={row.source}>
                    <code>{row.source}</code>
                    <span>{row.count} item{row.count === 1 ? '' : 's'} · {row.tokens} tok</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {items.length > 0 && (
            <div className="context-debugger__section">
              <h4>Included snippets</h4>
              <ul className="context-debugger__list">
                {items.slice(0, 12).map((item) => (
                  <li key={item.id}>
                    <code>{item.source}</code>
                    {item.relPath && <span className="context-debugger__path">{item.relPath}</span>}
                    <span className="context-debugger__reason" title={item.reason}>{item.reason}</span>
                    <span>{item.tokenEstimate} tok{item.truncated ? ' · truncated' : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {budget && budget.dropped.length > 0 && (
            <div className="context-debugger__section">
              <h4>Dropped</h4>
              <ul className="context-debugger__list context-debugger__list--dropped">
                {budget.dropped.slice(0, 10).map((drop, i) => (
                  <li key={`${drop.source}-${drop.relPath ?? i}`}>
                    <code>{drop.source}</code>
                    {drop.relPath && <span className="context-debugger__path">{drop.relPath}</span>}
                    <span className="context-debugger__reason">{drop.cause}: {drop.reason}</span>
                    <span>{drop.tokenEstimate} tok</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
