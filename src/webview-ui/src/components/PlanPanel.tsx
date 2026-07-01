import { useState } from 'react';
import type {
  AgentLiveStatusView,
  PlanPhaseView,
  PlanStepView,
  PlanView,
  ThunderMode,
} from '../../../vscode/webview/messages';

interface PlanPanelProps {
  plan: PlanView | null;
  mode?: ThunderMode;
  loading?: boolean;
  liveStatus?: AgentLiveStatusView | null;
}

const STATUS_LABEL: Record<PlanStepView['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  blocked_by_dependency: 'Waiting',
};

const PHASE_LABEL: Record<PlanPhaseView['phase'], string> = {
  diagnostics: 'Diagnostics',
  review: 'Review',
  execute: 'Execute',
  verify: 'Verify',
};

function PlanStepRow({ step, index }: { step: PlanStepView; index: number }) {
  const [expanded, setExpanded] = useState(step.status === 'running');
  const hasDetails = Boolean(
    step.objective || step.tools?.length || step.successCriteria?.length || step.dependsOn?.length
  );

  return (
    <li className={`plan-step plan-step--${step.status}`}>
      <button
        type="button"
        className="plan-step__row"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
      >
        <span className={`plan-step__status-dot plan-step__status-dot--${step.status}`} aria-hidden="true" />
        <span className="plan-step__index">{index + 1}</span>
        <span className="plan-step__body">
          <span className="plan-step__title">{step.title}</span>
          {step.files && step.files.length > 0 && (
            <span className="plan-step__files">{step.files.join(', ')}</span>
          )}
        </span>
        <span className="plan-step__meta">
          <span className={`plan-step__risk plan-step__risk--${step.risk}`}>{step.risk}</span>
          <span className="plan-step__status">{STATUS_LABEL[step.status]}</span>
          {hasDetails && (
            <span className="plan-step__expand" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </span>
      </button>
      {expanded && hasDetails && (
        <div className="plan-step__details">
          {step.objective && <p className="plan-step__objective">{step.objective}</p>}
          {step.tools && step.tools.length > 0 && (
            <p className="plan-step__detail-line">
              <span className="plan-step__detail-label">Tools</span>
              {step.tools.join(', ')}
            </p>
          )}
          {step.successCriteria && step.successCriteria.length > 0 && (
            <ul className="plan-step__criteria">
              {step.successCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          )}
          {step.dependsOn && step.dependsOn.length > 0 && (
            <p className="plan-step__detail-line">
              <span className="plan-step__detail-label">Depends on</span>
              {step.dependsOn.join(', ')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function PlanPhaseSection({ phase }: { phase: PlanPhaseView }) {
  const [collapsed, setCollapsed] = useState(false);
  const done = phase.steps.filter((step) => step.status === 'done').length;

  return (
    <section className={`plan-phase plan-phase--${phase.phase}`}>
      <button
        type="button"
        className="plan-phase__header"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className="plan-phase__chevron" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="plan-phase__title">{phase.title}</span>
        <span className="plan-phase__badge">{PHASE_LABEL[phase.phase]}</span>
        <span className="plan-phase__progress">
          {done}/{phase.steps.length}
        </span>
      </button>
      {!collapsed && (
        <ol className="plan-panel__steps plan-panel__steps--nested">
          {phase.steps.map((step, index) => (
            <PlanStepRow key={step.id} step={step} index={index} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function PlanPanel({ plan, mode = 'plan', loading = false, liveStatus = null }: PlanPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const hasSteps = Boolean(plan && plan.steps.length > 0);
  const isPlanningSession = Boolean(plan?.status === 'planning' || (loading && !hasSteps));
  const showPanel = Boolean(plan && (hasSteps || isPlanningSession || plan.requirementAnalysis));
  const collapseLabel = collapsed ? 'Expand' : 'Collapse';
  const planningLabel = liveStatus?.label?.toLowerCase().includes('plan')
    ? liveStatus.label
    : 'Building plan…';

  if (!showPanel) return null;

  if (!plan) return null;

  const done = plan.steps.filter((step) => step.status === 'done').length;
  const running = plan.steps.find((step) => step.status === 'running');
  const phases = plan.phases?.length ? plan.phases : undefined;

  return (
    <section
      className={`plan-panel ${isPlanningSession ? 'plan-panel--planning' : ''} ${mode === 'plan' ? 'plan-panel--plan-mode' : ''}`}
      aria-label="Planner"
      aria-busy={isPlanningSession}
    >
      <button
        type="button"
        className="plan-panel__toggle plan-panel__toggle--header"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-label={`${collapseLabel} planner`}
        title={`${collapseLabel} planner`}
      >
        <span className="plan-panel__chevron" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <div className="plan-panel__header">
          <div>
            <p className="plan-panel__eyebrow">
              {isPlanningSession ? 'Planning' : plan.status === 'ready' ? 'Plan ready' : 'Planner'}
            </p>
            <h2>{plan.goal}</h2>
            {!collapsed && isPlanningSession && (
              <p className="plan-panel__running" role="status">
                <span className="plan-panel__spinner plan-panel__spinner--inline" aria-hidden="true" />
                {planningLabel}
                {liveStatus?.detail ? ` — ${liveStatus.detail}` : ''}
              </p>
            )}
            {!collapsed && running && loading && !isPlanningSession && (
              <p className="plan-panel__running">Running: {running.title}</p>
            )}
          </div>
          <span className="plan-panel__meta">
            {hasSteps && (
              <span className="plan-panel__progress">{done}/{plan.steps.length}</span>
            )}
            <span className="plan-panel__collapse-label">{collapseLabel}</span>
          </span>
        </div>
      </button>

      {!collapsed && (
        <>
          {plan.appliedSkills && plan.appliedSkills.length > 0 && (
            <div className="plan-panel__skills" aria-label="Applied planning skills">
              {plan.appliedSkills.map((skill) => (
                <span key={skill} className="plan-panel__skill-chip">
                  {skill}
                </span>
              ))}
            </div>
          )}

          {plan.requirementAnalysis && (
            <details className="plan-panel__section" open={isPlanningSession}>
              <summary className="plan-panel__section-title">Requirement analysis</summary>
              <div className="plan-panel__analysis">{plan.requirementAnalysis}</div>
            </details>
          )}

          {plan.assumptions.length > 0 && (
            <details className="plan-panel__section" open>
              <summary className="plan-panel__section-title">Assumptions</summary>
              <ul className="plan-panel__assumptions">
                {plan.assumptions.map((assumption, index) => (
                  <li key={`${index}-${assumption}`}>{assumption}</li>
                ))}
              </ul>
            </details>
          )}

          {plan.requiredApprovals && plan.requiredApprovals.length > 0 && (
            <details className="plan-panel__section" open>
              <summary className="plan-panel__section-title">Required approvals</summary>
              <ul className="plan-panel__assumptions">
                {plan.requiredApprovals.map((approval, index) => (
                  <li key={`${index}-${approval}`}>{approval}</li>
                ))}
              </ul>
            </details>
          )}

          {phases ? (
            <div className="plan-panel__phases">
              {phases.map((phase) => (
                <PlanPhaseSection key={phase.id} phase={phase} />
              ))}
            </div>
          ) : hasSteps ? (
            <ol className="plan-panel__steps">
              {plan.steps.map((step, index) => (
                <PlanStepRow key={step.id} step={step} index={index} />
              ))}
            </ol>
          ) : isPlanningSession ? (
            <ol className="plan-panel__pipeline" aria-label="Planning pipeline">
              <li className={`plan-pipeline__item ${plan.requirementAnalysis ? 'plan-pipeline__item--done' : 'plan-pipeline__item--active'}`}>
                Requirement analysis
              </li>
              <li className={`plan-pipeline__item ${planningLabel.toLowerCase().includes('discovery') ? 'plan-pipeline__item--active' : ''}`}>
                Discovery
              </li>
              <li className={`plan-pipeline__item ${planningLabel.toLowerCase().includes('creating') ? 'plan-pipeline__item--active' : ''}`}>
                Compile plan
              </li>
            </ol>
          ) : null}
        </>
      )}
    </section>
  );
}
