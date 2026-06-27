import type { ApprovalRequestView } from '../../../vscode/webview/messages';

interface ApprovalCardsProps {
  approvals: ApprovalRequestView[];
  onResolve: (id: string, decision: 'approved' | 'denied', selectedOption?: string) => void;
  onApproveAll: () => void;
}

export function ApprovalCards({ approvals, onResolve, onApproveAll }: ApprovalCardsProps) {
  if (approvals.length === 0) return null;

  const questions = approvals.filter((req) => req.kind === 'question' || req.toolName === 'ask_question');
  const standard = approvals.filter((req) => req.kind !== 'question' && req.toolName !== 'ask_question');

  return (
    <div className="approval-panel">
      {questions.map((req) => (
        <article key={req.id} className="approval-card approval-card--low">
          <div className="approval-card__body">
            <div className="approval-card__header">
              <span className="approval-card__tool">Clarifying question</span>
            </div>
            <p className="approval-card__summary">{req.question ?? req.inputPreview}</p>
            <div className="approval-card__actions approval-card__actions--stack">
              {(req.options ?? []).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="btn btn--primary btn--small"
                  onClick={() => onResolve(req.id, 'approved', option)}
                >
                  {option}
                </button>
              ))}
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => onResolve(req.id, 'denied')}
              >
                Skip
              </button>
            </div>
          </div>
        </article>
      ))}

      {standard.length > 0 && (
        <>
          <div className="approval-panel__header">
            <div>
              <h3 className="approval-panel__title">Permission required</h3>
              <p className="approval-panel__subtitle">
                {standard.length} action{standard.length > 1 ? 's' : ''} waiting for your approval
              </p>
            </div>
            {standard.length > 1 && (
              <button type="button" className="btn btn--primary btn--small" onClick={onApproveAll}>
                Approve all
              </button>
            )}
          </div>

          <div className="approval-panel__list">
            {standard.map((req) => (
              <article key={req.id} className={`approval-card approval-card--${req.risk}`}>
                <div className="approval-card__icon" aria-hidden="true">
                  {req.toolName === 'write_file' ? '✎' : req.toolName === 'fetch_web' ? '🌐' : '⚙'}
                </div>
                <div className="approval-card__body">
                  <div className="approval-card__header">
                    <span className="approval-card__tool">{formatToolLabel(req.toolName)}</span>
                    <span className={`risk-badge risk-badge--${req.risk}`}>{req.risk}</span>
                  </div>
                  {req.files.length > 0 && (
                    <code className="approval-card__path">{req.files[0]}</code>
                  )}
                  <p className="approval-card__summary">{req.inputPreview}</p>
                  {req.contentLength != null && req.contentLength > 0 && (
                    <p className="approval-card__meta">
                      {req.contentLength.toLocaleString()} characters will be written
                    </p>
                  )}
                  <p className="approval-card__reason">{req.reason}</p>
                </div>
                <div className="approval-card__actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--small"
                    onClick={() => onResolve(req.id, 'approved')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => onResolve(req.id, 'denied')}
                  >
                    Deny
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function formatToolLabel(toolName: string): string {
  if (toolName === 'write_file') return 'Write file';
  if (toolName === 'apply_patch') return 'Apply patch';
  if (toolName === 'run_command') return 'Run command';
  if (toolName === 'fetch_web') return 'Fetch web';
  return toolName;
}
