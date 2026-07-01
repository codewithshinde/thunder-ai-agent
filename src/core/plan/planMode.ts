import type { ToolDefinition } from '../llm/toolTypes';
import { PLANNING_DISCOVERY_TOOLS } from '../tools/planTools';
import { routePlanIntent } from './PlanIntentRouter';

export const PLAN_ALLOWED_TOOLS = new Set([
  ...PLANNING_DISCOVERY_TOOLS,
  'execute_workspace_script',
  'project_catalog',
  'analyze_change_impact',
]);

const PLAN_GROUNDING_TOOLS = new Set([
  ...PLANNING_DISCOVERY_TOOLS,
  'project_catalog',
  'analyze_change_impact',
]);

export function filterPlanModeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => isPlanAllowedTool(tool.function.name));
}

export function isPlanAllowedTool(toolName: string): boolean {
  return PLAN_ALLOWED_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

export function needsPlanGrounding(userMessage: string): boolean {
  return routePlanIntent(userMessage).groundingRequired;
}

export function isPlanGroundingToolCall(toolName: string): boolean {
  return PLAN_GROUNDING_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

export const PLAN_SYNTHESIS_NUDGE = `Read-only discovery for this Plan-mode turn is complete.

Output a concise DISCOVERY_SUMMARY NOW in plain text:
- Key facts, relevant file paths, risks, and verification commands.
- Note which planning skill workflows apply (dependency graph, vertical slices, acceptance criteria).
- Do NOT call any more tools in this turn.
- The orchestrator will compile the structured plan from your summary.`;

export const NO_TOOLS_PLAN_NUDGE = `You are in Plan mode and answered without reading or searching the codebase. Plan mode MUST be grounded before compiling steps.

In this turn, call at least one read-only discovery tool:
- use_skill — load planning-and-task-breakdown or using-agent-skills when playbooks are not pre-loaded
- read_file / read_files — inspect specific files
- search / search_batch — find symbols, routes, or patterns
- retrieve_context / repo_map / project_catalog — widen project context
- diagnostics / git_diff — inspect current problems or changes when relevant

Then produce a concrete plan with goal, assumptions, files, steps, risks, and verification. Do NOT write files in Plan mode.`;
