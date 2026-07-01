import type { ToolDefinition } from '../llm/toolTypes';
import { routeAskIntent } from '../modes/ask/AskIntentRouter';

/** Read-only tools exposed to the model in Ask mode. */
export const ASK_ALLOWED_TOOLS = new Set([
  'read_file',
  'read_files',
  'list_files',
  'search',
  'search_batch',
  'repo_map',
  'retrieve_context',
  'git_diff',
  'diagnostics',
  'memory_search',
  'run_command',
  'execute_workspace_script',
  'search_script_catalog',
  'use_skill',
  'fetch_web',
  'ask_question',
  'spawn_research_agent',
  'project_catalog',
  'analyze_change_impact',
]);

const GROUNDING_TOOLS = new Set([
  'read_file',
  'read_files',
  'search',
  'search_batch',
  'retrieve_context',
  'repo_map',
  'list_files',
  'git_diff',
  'diagnostics',
  'execute_workspace_script',
  'spawn_research_agent',
  'project_catalog',
  'analyze_change_impact',
]);

export function filterAskModeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (ASK_ALLOWED_TOOLS.has(name)) return true;
    return name.startsWith('mcp__');
  });
}

export function isAskAllowedTool(toolName: string): boolean {
  return ASK_ALLOWED_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

/** Whether the answer should be grounded in codebase reads/searches before finishing. */
export function needsAskGrounding(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay)\b/i.test(text) && text.length < 48) return false;
  if (routeAskIntent(text).intent === 'general_knowledge') return false;
  return true;
}

export function isGeneralKnowledgeQuestion(text: string): boolean {
  const hasCodebaseRef =
    /\b(codebase|project|repo|repository|this file|our app|our code|workspace)\b/i.test(text) ||
    /\b(src\/|\.tsx?|\.jsx?|\.py|\.go|\.rs|\.mdx?)\b/i.test(text) ||
    /@[\w./-]+/.test(text);

  if (hasCodebaseRef) return false;

  return /^(what is|what are|explain the concept|define|difference between)\b/i.test(text);
}

/** Enable read-only research subagents for broad Ask-mode exploration. */
export function shouldEnableAskSubagents(userMessage: string): boolean {
  if (!needsAskGrounding(userMessage)) return false;
  const text = userMessage.trim();
  const route = routeAskIntent(text);
  if (route.shouldUseSubagents) return true;
  return (
    text.length > 120 ||
    /\b(how does|how do|architecture|across|entire|whole codebase|all files|map out|overview|trace|flow)\b/i.test(text)
  );
}

export function isGroundingToolCall(toolName: string): boolean {
  return GROUNDING_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

export const ASK_SYNTHESIS_NUDGE = `You have finished read-only exploration for this Ask-mode turn.

Provide your complete final answer NOW in plain text:
- Answer the user's question directly with citations (\`path:line\`) from files you read or tools you ran.
- Do NOT call any more tools in this turn.
- If something could not be verified, say so explicitly.`;

export const NO_TOOLS_ASK_NUDGE = `You answered without reading or searching the codebase. For Ask mode you MUST ground factual claims in tools first.

In this turn, call at least one of:
- read_file / read_files — inspect specific files
- search / search_batch — find symbols, routes, or patterns
- retrieve_context — widen context for the question

Then answer with:
1. A grounded overview
2. A structured explanation with \`path:line\` citations from files you actually read
3. Key files and responsibilities when this is a codebase question
4. An explicit "What I could not verify" section for anything you could not verify

Do NOT guess file contents or APIs. If the user wants edits, say to switch to Agent mode.`;
