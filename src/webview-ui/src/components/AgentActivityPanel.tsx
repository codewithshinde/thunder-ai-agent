import type { AgentActivityEntry, AgentLiveStatusView } from '../../../vscode/webview/messages';

interface AgentActivityPanelProps {
  entries: AgentActivityEntry[];
  loading: boolean;
  liveStatus?: AgentLiveStatusView | null;
  waitingForApproval?: boolean;
}

const KIND_LABEL: Record<AgentActivityEntry['kind'], string> = {
  context: 'Context',
  read: 'Read',
  budget: 'Budget',
  apply: 'Write',
  info: 'Info',
  approval: 'Approval',
  error: 'Error',
  tool: 'Tool',
  success: 'Done',
};

type ActivityPhase = 'working' | 'waiting' | 'complete' | 'error';

function resolvePhase(loading: boolean, waitingForApproval: boolean, entries: AgentActivityEntry[]): ActivityPhase {
  if (loading) return 'working';
  if (waitingForApproval) return 'waiting';
  if (entries.some((entry) => entry.kind === 'success')) return 'complete';
  if (entries.some((entry) => entry.kind === 'error')) return 'error';
  return 'complete';
}

export function AgentActivityPanel({ entries, loading, liveStatus, waitingForApproval = false }: AgentActivityPanelProps) {
  const visible = entries.slice(-12);
  const latest = entries[entries.length - 1];
  const phase = resolvePhase(loading, waitingForApproval, entries);
  const completionEntry = [...entries].reverse().find((entry) => entry.kind === 'success' || entry.kind === 'error');
  const statusLabel = loading
    ? liveStatus?.label ?? 'Working through steps'
    : waitingForApproval
      ? 'Waiting for your approval'
      : phase === 'error'
        ? 'Completed with issues'
        : 'All done';
  const progressLabel = liveStatus?.stepCurrent && liveStatus.stepTotal
    ? `${liveStatus.stepCurrent}/${liveStatus.stepTotal}`
    : undefined;
  const summaryDetail = !loading && !waitingForApproval && completionEntry?.detail
    ? completionEntry.detail
    : latest?.detail
      ? summarizeDetail(latest.detail)
      : liveStatus?.detail;

  if (entries.length === 0 && !loading && !waitingForApproval) return null;

  return (
    <details
      className={`assistant-thinking assistant-thinking--${phase}`}
      open={phase === 'complete' || phase === 'error'}
      aria-label="Agent activity"
    >
      <summary className="assistant-thinking__summary">
        <span
          className={`message-working__pulse message-working__pulse--${phase}`}
          aria-hidden="true"
        />
        <span className="assistant-thinking__summary-main">
          <span className="assistant-thinking__status-line">
            {statusLabel}
            {progressLabel ? ` · ${progressLabel}` : ''}
          </span>
          <span className="assistant-thinking__latest">
            {phase === 'complete' || phase === 'error'
              ? completionEntry?.message ?? latest?.message ?? 'Turn finished'
              : latest
                ? latest.message
                : liveStatus?.detail ?? 'Preparing activity'}
            {summaryDetail && phase !== 'working' ? ` · ${summarizeDetail(summaryDetail)}` : ''}
            {summaryDetail && phase === 'working' && latest?.detail ? ` · ${summarizeDetail(latest.detail)}` : ''}
            {!summaryDetail && phase === 'working' && liveStatus?.detail ? ` · ${liveStatus.detail}` : ''}
          </span>
        </span>
        {entries.length > 1 && <span className="assistant-thinking__count">{entries.length}</span>}
      </summary>
      {phase === 'complete' && completionEntry?.detail && (
        <div className="assistant-thinking__summary-block" role="status">
          {completionEntry.detail.split('\n').map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}
      <ol className="assistant-thinking__list">
        {visible.map((entry, index) => {
          const isLatest = index === visible.length - 1;
          return (
            <li
              key={entry.id}
              className={`assistant-thinking__item assistant-thinking__item--${entry.kind} ${
                isLatest && loading ? 'assistant-thinking__item--active' : ''
              }`}
            >
              <span className="assistant-thinking__kind">{KIND_LABEL[entry.kind]}</span>
              <span className="assistant-thinking__message">{entry.message}</span>
              {entry.detail && entry.kind !== 'success' && (
                <span className="assistant-thinking__detail">{summarizeDetail(entry.detail)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function summarizeDetail(detail: string): string {
  const firstLine = detail.split('\n').find(Boolean) ?? detail;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}...` : firstLine;
}
