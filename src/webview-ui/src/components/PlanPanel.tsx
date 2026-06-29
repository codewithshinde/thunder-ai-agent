import { useState } from 'react';
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
  const [collapsed, setCollapsed] = useState(false);
  const hasPlan = Boolean(plan && plan.steps.length > 0);
  const isPlanning = loading && (mode === 'plan' || mode === 'agent') && !hasPlan;
  const planningLabel = liveStatus?.label?.toLowerCase().includes('plan')
    ? liveStatus.label
    : 'Building plan…';

  if (!hasPlan && !isPlanning) return null;

  if (!hasPlan && isPlanning) {
    return (
      <section className="plan-panel plan-panel--planning" aria-label="Planner" aria-busy="true">
        <button
          type="button"
          className="plan-panel__toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <span className="plan-panel__chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="plan-panel__loading-bar" role="status">
            <span className="plan-panel__spinner" aria-hidden="true" />
            <span className="plan-panel__loading-label">{planningLabel}</span>
            {!collapsed && liveStatus?.detail && (
              <span className="plan-panel__loading-detail">{liveStatus.detail}</span>
            )}
          </span>
        </button>
      </section>
    );
  }

  if (!plan) return null;

  const done = plan.steps.filter((step) => step.status === 'done').length;
  const running = plan.steps.find((step) => step.status === 'running');

  return (
    <section className="plan-panel" aria-label="Current plan">
      <button
        type="button"
        className="plan-panel__toggle plan-panel__toggle--header"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className="plan-panel__chevron" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <div className="plan-panel__header">
          <div>
            <p className="plan-panel__eyebrow">Planner</p>
            <h2>{plan.goal}</h2>
            {!collapsed && running && loading && (
              <p className="plan-panel__running">Running: {running.title}</p>
            )}
          </div>
          <span className="plan-panel__progress">{done}/{plan.steps.length}</span>
        </div>
      </button>

      {!collapsed && (
        <>
          {plan.assumptions.length > 0 && (
            <ul className="plan-panel__assumptions" aria-label="Plan assumptions">
              {plan.assumptions.map((assumption, index) => (
                <li key={`${index}-${assumption}`}>{assumption}</li>
              ))}
            </ul>
          )}
          <ol className="plan-panel__steps">
            {plan.steps.map((step, index) => (
              <li key={step.id} className={`plan-step plan-step--${step.status}`}>
                <span className="plan-step__index">{index + 1}</span>
                <span className="plan-step__body">
                  <span className="plan-step__title">{step.title}</span>
                  {step.files && step.files.length > 0 && (
                    <span className="plan-step__files">{step.files.join(', ')}</span>
                  )}
                </span>
                <span className="plan-step__status">{STATUS_LABEL[step.status]}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
