import type { SubagentStatusView } from '../../../vscode/webview/messages';
import { IconChevronDown } from './Icons';

interface SubagentStatusPanelProps {
  subagents: SubagentStatusView[];
  loading: boolean;
}

const STATUS_LABEL: Record<SubagentStatusView['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Error',
};

function SubagentStatusRow({ run }: { run: SubagentStatusView }) {
  const elapsed = run.finishedAt
    ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
    : run.status === 'running'
      ? '…'
      : '';

  return (
    <li className={`subagent-row subagent-row--${run.status}`}>
      <div className="subagent-row__header">
        <span className="subagent-row__status">{STATUS_LABEL[run.status]}</span>
        <span className="subagent-row__time">{elapsed}</span>
      </div>
      <p className="subagent-row__task" title={run.task}>
        {run.task.slice(0, 120)}{run.task.length > 120 ? '…' : ''}
      </p>
      {run.focus && <p className="subagent-row__focus">Focus: {run.focus.slice(0, 80)}</p>}
      {run.summary && <p className="subagent-row__summary">{run.summary}</p>}
      {run.error && <p className="subagent-row__error">{run.error}</p>}
    </li>
  );
}

export function SubagentStatusPanel({ subagents, loading }: SubagentStatusPanelProps) {
  const active = subagents.filter((s) => s.status === 'running' || s.status === 'queued');
  if (subagents.length === 0 && !loading) return null;

  return (
    <details className="subagent-panel" open={active.length > 0}>
      <summary className="subagent-panel__summary">
        <span>
          Subagents
          {active.length > 0 ? ` · ${active.length} active` : ''}
        </span>
        <span className="subagent-panel__count">{subagents.length}</span>
        <IconChevronDown className="subagent-panel__chevron" width={14} height={14} />
      </summary>
      <ul className="subagent-panel__list">
        {subagents.map((run) => (
          <SubagentStatusRow key={run.id} run={run} />
        ))}
      </ul>
    </details>
  );
}
