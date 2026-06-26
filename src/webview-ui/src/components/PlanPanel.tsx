import type { PlanView } from '../../../vscode/webview/messages';
import { IconChevronDown } from './Icons';

interface PlanPanelProps {
  plan: PlanView | null;
  loading?: boolean;
}

export function PlanPanel({ plan, loading }: PlanPanelProps) {
  if (!plan) return null;

  const runningStep = plan.steps.find((s) => s.status === 'running');
  const doneCount = plan.steps.filter((s) => s.status === 'done').length;
  const summary = runningStep
    ? `Step ${doneCount + 1}/${plan.steps.length}: ${runningStep.title}`
    : `${doneCount}/${plan.steps.length} steps done`;

  return (
    <details className="plan-drawer" open={Boolean(loading && runningStep)}>
      <summary className="plan-drawer__summary">
        <span>Plan · {summary}</span>
        <IconChevronDown className="plan-drawer__chevron" width={14} height={14} />
      </summary>
      <div className="plan-panel">
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
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
