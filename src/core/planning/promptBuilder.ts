import type { ContextPack } from '../context/types';
import type { ChatMessage } from '../llm/types';
import type { ThunderMode } from '../ThunderSession';
import type { ThunderPlan } from './PlanActEngine';

const TOOL_GUIDANCE = `
TOOLS: You have tools to read files, search code, run commands, write files, and manage memory.
- Use read_file/read_files/search/search_batch/list_files to gather information before editing.
- Batch independent reads and searches in ONE turn (read_files, search_batch, parallel spawn_research_agent).
- Use spawn_research_agent to delegate focused research (unused deps, orphan files, static assets) — spawn multiple for parallel analysis.
- Prefer apply_patch for small targeted changes; use write_file for new files or full rewrites.
- Use run_command for depcheck, npm ls, ripgrep, tests, lint, or build after changes.
- Use memory_search for past decisions; memory_write to save important facts.
- In Act mode, you may call write_file/apply_patch/run_command tools directly.
- If a tool returns "awaiting approval", stop and inform the user.
- NEVER say "I will search…" without calling tools in the same turn.`;

const AUDIT_GUIDANCE = `
AUDIT / CLEANUP MODE:
1. Read package.json first, then map src/ with list_files(recursive:true).
2. Spawn parallel research subagents for: (a) unused npm deps, (b) unused source files, (c) unused static assets.
3. Cross-check with search_batch / run_command (depcheck, rg) before recommending removal.
4. Report with confidence: high (safe to remove), medium (likely unused), low (needs review).
5. In Plan/Review mode: report only — do NOT delete files or edit package.json until user confirms.`;

export function buildSystemPrompt(mode: ThunderMode, toolsEnabled = false, auditMode = false): string {
  const modeInstructions: Record<ThunderMode, string> = {
    plan: `You are in PLAN mode. Analyze the codebase and give a direct answer.
- Start with a 1-2 sentence summary of your recommendation.
- Use bullet points for steps. Be specific with file paths from context.
- Do NOT write files — propose what to change and where.
- For complex tasks, output a JSON plan block (see format below).`,
    act: `You are in ACT mode. Implement changes using tools and/or CODE_EDIT_BLOCK format.

Preferred workflow:
1. read_file / search / retrieve_context to understand the code
2. apply_patch or write_file to make changes
3. diagnostics / run_command to verify

You may also output files in this format when tools are unavailable:

\`\`\`tsx|CODE_EDIT_BLOCK|relative/path/to/file.tsx
// complete file contents
\`\`\`

Rules:
- Use correct relative paths from context.
- Fix syntax, imports, and type errors proactively.
- Prefer apply_patch for small edits; write_file for new files or full rewrites.`,
    review: `You are in REVIEW mode. Inspect code in context.
- Start with a brief verdict (1 sentence).
- List issues as bullets with file:line references when possible.
- Do not invent files. Do not output file rewrites.`,
  };

  const planFormat = `
For multi-step tasks in Plan mode, include:
\`\`\`json
{
  "goal": "what to accomplish",
  "assumptions": ["..."],
  "steps": [
    { "id": "step-1", "title": "...", "status": "pending", "files": ["path"], "risk": "low" }
  ],
  "requiredApprovals": []
}
\`\`\``;

  return `You are Thunder, a local-first VS Code coding agent with codebase context injected below.

${modeInstructions[mode]}
${toolsEnabled ? TOOL_GUIDANCE : ''}
${toolsEnabled && auditMode ? AUDIT_GUIDANCE : ''}
${mode === 'plan' ? planFormat : ''}

RULES:
- The user's message includes a ## Codebase Context section with real project files. READ IT and answer from it.
- Focus on files and topics the user asked about. Do NOT pivot to unrelated open tabs or linter diagnostics unless the user asked to fix errors.
- NEVER ask the user to paste README, package.json, or source files — they are already in context.
- NEVER say context is "truncated" or "not fully visible" if file content appears in context — use what is provided.
- If a file path and content appear in context, analyze and discuss that code directly.
- If context says a file was not found, report that and suggest the closest matching path if any.
- Do not invent generic boilerplate unless those exact files are in context.
- Cite file paths when referencing code.
- Keep prose concise. Avoid filler, repetition, and long preambles.`;
}

export function buildPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  userMessage: string,
  recentMessages: ChatMessage[] = [],
  toolsEnabled = false,
  auditMode = false
): ChatMessage[] {
  const contextBlock = contextPack.formatted
    ? contextPack.formatted
    : '(no workspace context — user may need to index workspace)';

  const userContent = `## Codebase Context

${contextBlock}

---

## User request

${userMessage}

Answer using the codebase context above. Be direct and specific.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(mode, toolsEnabled, auditMode) },
  ];

  for (const msg of recentMessages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: userContent });
  return messages;
}

export function buildPlanGenerationPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  userMessage: string
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  return [
    {
      role: 'system',
      content: `You are a task planner. Break the user's request into 2-8 concrete steps.
Output ONLY a JSON code block with this structure:
\`\`\`json
{
  "goal": "...",
  "assumptions": ["..."],
  "steps": [
    { "id": "step-1", "title": "...", "status": "pending", "files": ["path"], "risk": "low|medium|high" }
  ],
  "requiredApprovals": []
}
\`\`\`
Mode: ${mode}. Be specific with file paths from context.`,
    },
    {
      role: 'user',
      content: `## Context\n${contextBlock}\n\n## Task\n${userMessage}\n\nGenerate the plan JSON.`,
    },
  ];
}

export function buildStepPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  plan: ThunderPlan,
  step: ThunderPlan['steps'][number]
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  const completed = plan.steps.filter((s) => s.status === 'done').map((s) => s.title);
  const pending = plan.steps.filter((s) => s.status !== 'done').map((s) => s.title);

  return [
    {
      role: 'system',
      content: buildSystemPrompt(mode, true),
    },
    {
      role: 'user',
      content: `## Goal\n${plan.goal}

## Completed steps
${completed.length ? completed.map((s) => `- ${s}`).join('\n') : '(none)'}

## Remaining steps
${pending.map((s) => `- ${s}`).join('\n')}

## Current step (execute NOW)
**${step.title}**${step.files?.length ? `\nFiles: ${step.files.join(', ')}` : ''}
Risk: ${step.risk}

## Codebase Context
${contextBlock}

Execute this step completely using tools. When done, summarize what you changed.`,
    },
  ];
}
