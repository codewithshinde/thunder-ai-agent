import type { AgentLiveStatusView, PlanView, ThunderMode } from '../../../vscode/webview/messages';

interface PlanPanelProps {
  plan: PlanView | null;
  mode?: ThunderMode;
  loading?: boolean;
  liveStatus?: AgentLiveStatusView | null;
}

const STATUS_LABEL: Record<PlanView['steps'][number]['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  blocked_by_dependency: 'Waiting',
};

export function PlanPanel({ plan, mode = 'plan', loading = false, liveStatus = null }: PlanPanelProps) {
  const hasPlan = Boolean(plan && plan.steps.length > 0);
  const isPlanning = loading && (mode === 'plan' || mode === 'act') && !hasPlan;
  const planningLabel = liveStatus?.label?.toLowerCase().includes('plan')
    ? liveStatus.label
    : 'Building plan…';

  if (!hasPlan && !isPlanning) return null;

  if (!hasPlan && isPlanning) {
    return (
      <section className="plan-panel plan-panel--planning" aria-label="Planner" aria-busy="true">
        <div className="plan-panel__header">
          <div>
            <p className="plan-panel__eyebrow">Planner</p>
            <h2>{planningLabel}</h2>
          </div>
          <span className="plan-panel__spinner" aria-hidden="true" />
        </div>
        <ol className="plan-panel__steps plan-panel__steps--skeleton">
          {[1, 2, 3].map((step) => (
            <li key={step} className="plan-step plan-step--skeleton">
              <span className="plan-step__index">{step}</span>
              <span className="plan-step__title plan-step__title--skeleton" />
              <span className="plan-step__status">…</span>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  if (!plan) return null;

  const done = plan.steps.filter((step) => step.status === 'done').length;
  const running = plan.steps.find((step) => step.status === 'running');

  return (
    <section className="plan-panel" aria-label="Current plan">
      <div className="plan-panel__header">
        <div>
          <p className="plan-panel__eyebrow">Planner</p>
          <h2>{plan.goal}</h2>
          {running && loading && (
            <p className="plan-panel__running">Running: {running.title}</p>
          )}
        </div>
        <span className="plan-panel__progress">{done}/{plan.steps.length}</span>
      </div>
      <ol className="plan-panel__steps">
        {plan.steps.map((step, index) => (
          <li key={step.id} className={`plan-step plan-step--${step.status}`}>
            <span className="plan-step__index">{index + 1}</span>
            <span className="plan-step__title">{step.title}</span>
            <span className="plan-step__status">{STATUS_LABEL[step.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
