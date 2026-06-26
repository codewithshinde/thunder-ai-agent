import { useState } from 'react';
import type { AgentActivityEntry } from '../../../vscode/webview/messages';
import { IconChevronDown } from './Icons';

interface AgentActivityPanelProps {
  entries: AgentActivityEntry[];
  loading: boolean;
  compact?: boolean;
}

const KIND_LABEL: Record<AgentActivityEntry['kind'], string> = {
  context: 'Context',
  read: 'Read',
  budget: 'Budget',
  apply: 'Apply',
  info: 'Info',
  approval: 'Approval',
  error: 'Error',
  tool: 'Tool',
};

export function AgentActivityPanel({ entries, loading, compact }: AgentActivityPanelProps) {
  const [open, setOpen] = useState(false);
  const visible = compact ? entries.slice(-6) : entries;
  const latest = entries[entries.length - 1];

  if (entries.length === 0 && !loading) return null;

  return (
    <details className="activity-drawer" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="activity-drawer__summary">
        <span>
          {loading && latest
            ? `${KIND_LABEL[latest.kind]}: ${latest.message}`
            : `Activity${loading ? ' · running' : ''}`}
        </span>
        <span className="activity-drawer__count">{entries.length}</span>
        <IconChevronDown className="activity-drawer__chevron" width={14} height={14} />
      </summary>
      <ol className="agent-activity__list">
        {visible.map((entry) => (
          <li key={entry.id} className={`agent-activity__item agent-activity__item--${entry.kind}`}>
            <span className="agent-activity__kind">{KIND_LABEL[entry.kind]}</span>
            <span className="agent-activity__message">{entry.message}</span>
            {entry.detail && !compact && <pre className="agent-activity__detail">{entry.detail}</pre>}
          </li>
        ))}
      </ol>
    </details>
  );
}
