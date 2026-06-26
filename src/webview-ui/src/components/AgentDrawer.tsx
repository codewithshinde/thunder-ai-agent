import type { AgentActivityEntry, PlanView, ContextItemView, ContextBudgetView } from '../../../vscode/webview/messages';
import { AgentActivityPanel } from './AgentActivityPanel';
import { PlanPanel } from './PlanPanel';
import { ContextPreview } from './ContextPreview';
import { SubagentStatusPanel } from './SubagentStatusPanel';
import type { SubagentStatusView } from '../../../vscode/webview/messages';

interface AgentDrawerProps {
  loading: boolean;
  plan: PlanView | null;
  agentActivity: AgentActivityEntry[];
  subagents: SubagentStatusView[];
  contextPreview: ContextItemView[];
  contextTokenEstimate: number;
  contextBudget: ContextBudgetView | null;
  showContextPreview: boolean;
  onToggleContext: () => void;
}

export function AgentDrawer({
  loading,
  plan,
  agentActivity,
  subagents,
  contextPreview,
  contextTokenEstimate,
  contextBudget,
  showContextPreview,
  onToggleContext,
}: AgentDrawerProps) {
  const hasPlan = Boolean(plan);
  const hasActivity = agentActivity.length > 0 || loading;
  const hasContext = contextPreview.length > 0;

  const hasSubagents = subagents.length > 0;

  if (!hasPlan && !hasActivity && !hasContext && !hasSubagents) return null;

  return (
    <div className="agent-drawer">
      <PlanPanel plan={plan} loading={loading} />
      <SubagentStatusPanel subagents={subagents} loading={loading} />
      <AgentActivityPanel entries={agentActivity} loading={loading} compact />
      <ContextPreview
        items={contextPreview}
        totalTokens={contextTokenEstimate}
        budget={contextBudget}
        visible={showContextPreview}
        onToggle={onToggleContext}
      />
    </div>
  );
}
