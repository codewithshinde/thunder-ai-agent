import type { ApprovalRequestView } from '../../../vscode/webview/messages';

interface ApprovalCardsProps {
  approvals: ApprovalRequestView[];
  onResolve: (id: string, decision: 'approved' | 'denied') => void;
}

export function ApprovalCards({ approvals, onResolve }: ApprovalCardsProps) {
  if (approvals.length === 0) return null;

  return (
    <div className="approval-cards">
      <h3 className="panel-title">Pending Approvals</h3>
      {approvals.map((req) => (
        <div key={req.id} className={`approval-card approval-card--${req.risk}`}>
          <div className="approval-card__header">
            <span className="approval-card__tool">{req.toolName}</span>
            <span className={`risk-badge risk-badge--${req.risk}`}>{req.risk}</span>
          </div>
          <p className="approval-card__reason">{req.reason}</p>
          {req.files.length > 0 && (
            <p className="approval-card__files">Files: {req.files.join(', ')}</p>
          )}
          <pre className="approval-card__preview">{req.inputPreview}</pre>
          <div className="approval-card__actions">
            <button type="button" className="btn btn--primary" onClick={() => onResolve(req.id, 'approved')}>
              Approve
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => onResolve(req.id, 'denied')}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
