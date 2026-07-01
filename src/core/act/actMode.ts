import type { ToolDefinition } from '../llm/toolTypes';
import { filterDirectAgentTools } from '../tools/toolAliases';

/** Tools that should never be exposed to a direct Act loop. */
export const ACT_DIRECT_EXCLUDED_TOOLS = new Set([
  'mark_step_complete',
  'propose_plan_mutation',
  // Prefer Mitii's native write/patch tools in Act mode. They have workspace
  // validation, approvals, diff preview, post-write validation, and stronger
  // schemas than the generic MCP filesystem mutators.
  'mcp__filesystem__create_directory',
  'mcp__filesystem__move_file',
  'mcp__filesystem__write_file',
  'mcp__filesystem__edit_file',
]);

export function filterActModeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return filterDirectAgentTools(tools).filter((tool) => !ACT_DIRECT_EXCLUDED_TOOLS.has(tool.function.name));
}
