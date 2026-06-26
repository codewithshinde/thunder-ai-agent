import type { PlanView } from '../../../vscode/webview/messages';

interface PlanPanelProps {
  plan: PlanView | null;
}

export function PlanPanel({ plan }: PlanPanelProps) {
  if (!plan) return null;

  return (
    <div className="plan-panel">
      <h3 className="panel-title">Plan</h3>
      <p className="plan-goal">{plan.goal}</p>
      {plan.assumptions.length > 0 && (
        <ul className="plan-assumptions">
          {plan.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      <ol className="plan-steps">
        {plan.steps.map((step) => (
          <li key={step.id} className={`plan-step plan-step--${step.status}`}>
            <span className={`step-status step-status--${step.status}`}>{step.status}</span>
            <span className="step-title">{step.title}</span>
            <span className={`risk-badge risk-badge--${step.risk}`}>{step.risk}</span>
            {step.files && step.files.length > 0 && (
              <span className="step-files">{step.files.join(', ')}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
