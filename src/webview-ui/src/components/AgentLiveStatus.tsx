import type { AgentLiveStatusView } from '../../../vscode/webview/messages';

interface AgentLiveStatusProps {
  status: AgentLiveStatusView | null;
  loading: boolean;
}

export function AgentLiveStatus({ status, loading }: AgentLiveStatusProps) {
  if (!loading && !status?.label) return null;

  const label = status?.label ?? 'Working…';
  const detail = status?.detail;
  const step = status?.stepCurrent && status?.stepTotal
    ? `Step ${status.stepCurrent}/${status.stepTotal}`
    : null;

  return (
    <div className="agent-live-status" role="status" aria-live="polite">
      <span className="agent-live-status__pulse" aria-hidden="true" />
      <div className="agent-live-status__text">
        <span className="agent-live-status__label">{label}</span>
        {step && <span className="agent-live-status__step">{step}</span>}
        {detail && <span className="agent-live-status__detail">{detail}</span>}
      </div>
    </div>
  );
}
