import type { ContextPack } from '../context/types';
import type { ChatMessage } from '../llm/types';
import type { ThunderMode } from '../ThunderSession';
import type { ThunderPlan } from './PlanActEngine';
import { CHAT_HISTORY_GUIDANCE, STATE_MACHINE_GUIDANCE } from '../agent/taskStatePrompt';

const TOOL_GUIDANCE = `
TOOLS: You have tools to read files, search code, run commands, write files, and manage memory.
- Use read_file/read_files/search/search_batch/list_files to gather information before editing.
- Tools named mcp__server__tool come from configured MCP servers. Treat them as external tools; inspect their names and arguments carefully.
- Batch independent reads and searches in ONE turn (read_files, search_batch, parallel spawn_research_agent).
- For large target file arrays, split into chunks of 5-10 files and spawn multiple research agents in one turn.
- Use spawn_research_agent to delegate focused research (unused deps, orphan files, static assets) — spawn multiple for parallel analysis and pass persona_instructions when a specialized reviewer helps.
- Prefer execute_workspace_script for known repo scripts (knip, depcheck, safe lint, checkpoint read/write). Search with search_script_catalog first if needed.
- Prefer apply_patch for small targeted changes; use write_file for new files or full rewrites.
- Use run_command only for read-only inspection or project verification. During audit/cleanup tasks, use execute_workspace_script instead of hand-written shell.
- Use use_skill to load a specific workspace skill playbook when the task matches one.
- Use memory_search only as a fallback when chat history lacks needed facts.
- Use save_task_state or memory_write to persist progress BEFORE pausing for approval (required).
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

const PLANNING_DISCOVERY_GUIDANCE = `
READ-ONLY PLANNING DISCOVERY TOOLS:
- Use read_file/read_files/search/search_batch/list_files/repo_map/retrieve_context to inspect the codebase.
- Use diagnostics, git_diff, memory_search, and search_script_catalog when relevant.
- Use spawn_research_agent for parallel read-only research on independent questions.
- Use run_command only for read-only inspection commands such as rg, find, git status, depcheck, lint/test/typecheck checks.
- Do NOT call write_file, apply_patch, memory_write, save_task_state, or execute_workspace_script during planning discovery.`;

export function buildSystemPrompt(
  mode: ThunderMode,
  toolsEnabled = false,
  auditMode = false,
  isContinuation = false
): string {
  const modeInstructions: Record<ThunderMode, string> = {
    plan: `You are in PLAN mode. Analyze the codebase and give a direct answer.
- Start with a 1-2 sentence summary of your recommendation.
- Use bullet points for steps. Be specific with file paths from context.
- Do NOT write files — propose what to change and where.
- For complex tasks, output a JSON plan block (see format below).`,
    act: `You are in ACT mode. Implement changes using tools and/or CODE_EDIT_BLOCK format.

${STATE_MACHINE_GUIDANCE}
${CHAT_HISTORY_GUIDANCE}

Systematic workflow — follow this order:
1. **Analyze** — read_file / list_files / depcheck / eslint (once each) to understand the codebase
2. **Execute** — apply_patch or write_file to make changes; update package.json for deps
3. **Verify** — diagnostics / run_command (lint, test, build) after changes
4. **Fix** — if validation reports errors, fix them before moving on

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
${toolsEnabled && isContinuation ? '\nCONTINUATION TURN: Read recent conversation messages first. Do NOT call memory_search before checking chat history and task progress.' : ''}
${mode === 'plan' ? planFormat : ''}

RULES:
- The user's message includes a ## Codebase Context section with real project files. READ IT and answer from it.
- If ## Codebase Context includes a repo_map/workspace overview, use that provided map first. Do NOT repeatedly call list_files for the same structure unless the map is absent or demonstrably stale.
- Project rule files in context (AGENTS.md, CLAUDE.md, .thunder/rules, .clinerules, .continue/rules, etc.) are operating instructions for this workspace. Follow them unless they conflict with explicit user instructions or safety policy.
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
  auditMode = false,
  taskStateBlock?: string,
  isContinuation = false
): ChatMessage[] {
  const contextBlock = contextPack.formatted
    ? contextPack.formatted
    : '(no workspace context — user may need to index workspace)';

  const taskProgress = taskStateBlock
    ? `\n\n## Task progress\n\n${taskStateBlock}\n`
    : '';

  const continuationNote = isContinuation
    ? `\n\n## Continuation\nThis turn resumes after user approval. Read **Recent conversation** above for tool outputs. Do NOT re-run depcheck/eslint/list_files already marked complete in Task progress. Proceed to Execute phase.\n`
    : '';

  const userContent = `## Codebase Context

${contextBlock}
${taskProgress}${continuationNote}
---

## User request

${userMessage}

Answer using the codebase context and recent conversation above. Be direct and specific.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(mode, toolsEnabled, auditMode, isContinuation) },
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
  userMessage: string,
  requirementAnalysis?: string,
  planningDiscovery?: string,
  task?: { kind: string; complexity: string }
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  const analysisBlock = requirementAnalysis
    ? `\n\n## Requirement analysis\n${requirementAnalysis}`
    : '';
  const discoveryBlock = planningDiscovery
    ? `\n\n## Tool-assisted planning discovery\n${planningDiscovery}`
    : '';
  const isAudit = task?.kind === 'audit';
  const highComplexity = task?.complexity === 'high';
  const stepGuidance = isAudit
    ? 'Audit/cleanup tasks need 8-15 granular steps. Include separate diagnostics for dependencies, source files, static assets, import/export references, review/cross-check, execution batches, and verification.'
    : highComplexity
      ? 'High-complexity tasks need 8-12 granular steps when that improves execution quality. Simpler high-confidence changes may use fewer.'
      : 'Use 2-6 steps for simple tasks and 4-8 steps for medium tasks.';
  const auditGuidance = isAudit ? `\n\n${AUDIT_GUIDANCE}` : '';

  return [
    {
      role: 'system',
      content: `You are a task planner for a coding agent. Break the user's request into rigid execution phases.

Process:
1. Understand the goal and constraints from context and analysis.
2. Output phases in this exact order when relevant: Phase 1 Diagnostics, Phase 2 Review, Phase 3 Execute, Phase 4 Verify.
3. Phase 1 and Phase 2 are read-only. Phase 3 is the first phase where write_file/apply_patch/package edits are allowed.
4. Include a final verification phase if tests or lint are relevant.
5. Be specific with file paths from context and tool-assisted discovery.
6. Every step must include objective, tools, successCriteria, files, and risk.
7. ${stepGuidance}${auditGuidance}

Output ONLY a JSON code block with a phases JSON array. Do not output prose:
\`\`\`json
{
  "goal": "...",
  "assumptions": ["..."],
  "phases": [
    {
      "id": "phase-1",
      "title": "Phase 1: Diagnostics",
      "phase": "diagnostics",
      "objective": "read-only discovery",
      "steps": [
        {
          "id": "step-1",
          "title": "...",
          "objective": "specific outcome for this step",
          "tools": ["read_file", "search_batch"],
          "successCriteria": ["observable completion condition"],
          "files": ["path"],
          "risk": "low|medium|high"
        }
      ]
    },
    {
      "id": "phase-2",
      "title": "Phase 2: Review",
      "phase": "review",
      "objective": "cross-check findings and decide edits",
      "steps": [
        { "id": "step-2", "title": "...", "objective": "...", "tools": ["..."], "successCriteria": ["..."], "files": ["path"], "risk": "low|medium|high" }
      ]
    },
    {
      "id": "phase-3",
      "title": "Phase 3: Execute",
      "phase": "execute",
      "objective": "make approved code changes",
      "steps": [
        { "id": "step-3", "title": "...", "objective": "...", "tools": ["..."], "successCriteria": ["..."], "files": ["path"], "risk": "low|medium|high" }
      ]
    },
    {
      "id": "phase-4",
      "title": "Phase 4: Verify",
      "phase": "verify",
      "objective": "validate and fix remaining errors",
      "steps": [
        { "id": "step-4", "title": "...", "objective": "...", "tools": ["..."], "successCriteria": ["..."], "files": ["path"], "risk": "low|medium|high" }
      ]
    }
  ],
  "requiredApprovals": []
}
\`\`\`
Mode: ${mode}.`,
    },
    {
      role: 'user',
      content: `## Context\n${contextBlock}${analysisBlock}${discoveryBlock}\n\n## Task\n${userMessage}\n\nGenerate the plan JSON.`,
    },
  ];
}

export function buildPlanningDiscoveryPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  userMessage: string,
  analysis: { kind: string; complexity: string; summary: string }
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  const auditGuidance = analysis.kind === 'audit' ? `\n\n${AUDIT_GUIDANCE}` : '';

  return [
    {
      role: 'system',
      content: `You are doing read-only discovery before a plan is generated.

${PLANNING_DISCOVERY_GUIDANCE}${auditGuidance}

Rules:
- You are in ${mode.toUpperCase()} mode discovery. Do NOT write files, patch files, or edit package manifests.
- Use tools to fill gaps in the provided context before planning.
- Prefer batched reads/searches and parallel research subagents when useful.
- For audit/cleanup tasks, inspect package manifests and repo shape before finalizing findings.
- Finish with a concise "DISCOVERY_SUMMARY" containing facts, relevant files, risks, and verification commands.`,
    },
    {
      role: 'user',
      content: `Task kind: ${analysis.kind} (${analysis.complexity})
${analysis.summary}

## Codebase Context
${contextBlock}

## User request
${userMessage}

Run read-only discovery for planning, then output DISCOVERY_SUMMARY.`,
    },
  ];
}

export function buildRequirementAnalysisPrompt(
  contextPack: ContextPack,
  userMessage: string,
  analysis: { kind: string; complexity: string; summary: string }
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  return [
    {
      role: 'system',
      content: `You are a requirements analyst for a coding agent. Before any code changes, analyze the user's request.

Output a concise analysis (bullet points, max 12 lines):
1. **Goal** — what the user wants accomplished
2. **Scope** — files/areas likely involved (from context)
3. **Constraints** — mode, risks, dependencies to watch
4. **Success criteria** — how to verify the work is done (tests, lint, behavior)
5. **Approach** — high-level strategy (2-4 bullets)

Be specific. Use file paths from context. Do NOT write code.`,
    },
    {
      role: 'user',
      content: `Task kind: ${analysis.kind} (${analysis.complexity} complexity)
${analysis.summary}

## Codebase Context
${contextBlock}

## User request
${userMessage}

Analyze requirements:`,
    },
  ];
}

export function buildStepPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  plan: ThunderPlan,
  step: ThunderPlan['steps'][number],
  priorSummaries: string[] = []
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  const completed = plan.steps.filter((s) => s.status === 'done').map((s) => s.title);
  const pending = plan.steps.filter((s) => s.status !== 'done').map((s) => s.title);
  const phase = step.phase ? `\nPhase lock: ${step.phase}` : '';
  const objective = step.objective ? `\nObjective: ${step.objective}` : '';
  const tools = step.tools?.length ? `\nExpected tools: ${step.tools.join(', ')}` : '';
  const successCriteria = step.successCriteria?.length
    ? `\nSuccess criteria:\n${step.successCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
    : '';

  const priorBlock =
    priorSummaries.length > 0
      ? `\n## Work completed so far\n${priorSummaries.map((s) => `- ${s}`).join('\n')}\n`
      : '';

  return [
    {
      role: 'system',
      content: buildSystemPrompt(mode, true),
    },
    {
      role: 'user',
      content: `## Goal\n${plan.goal}
${priorBlock}
## Completed steps
${completed.length ? completed.map((s) => `- ${s}`).join('\n') : '(none)'}

## Remaining steps
${pending.map((s) => `- ${s}`).join('\n')}

## Current step (execute NOW)
**${step.title}**${objective}${step.files?.length ? `\nFiles: ${step.files.join(', ')}` : ''}${tools}${successCriteria}${phase}
Risk: ${step.risk}

## Codebase Context
${contextBlock}

Execute this step completely using tools. Fix any errors you introduce. When done, summarize what you changed.`,
    },
  ];
}

export function buildStepRetryPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  plan: ThunderPlan,
  step: ThunderPlan['steps'][number],
  priorSummaries: string[],
  validationErrors: string[]
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  const objective = step.objective ? `\nObjective: ${step.objective}` : '';
  const successCriteria = step.successCriteria?.length
    ? `\nSuccess criteria:\n${step.successCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
    : '';

  return [
    {
      role: 'system',
      content: buildSystemPrompt(mode, true),
    },
    {
      role: 'user',
      content: `## Goal\n${plan.goal}

## Work completed so far
${priorSummaries.map((s) => `- ${s}`).join('\n')}

## RETRY — fix validation errors from previous attempt
**${step.title}**${objective}${step.files?.length ? `\nFiles: ${step.files.join(', ')}` : ''}${successCriteria}
${step.phase ? `Phase lock: ${step.phase}\n` : ''}

### Errors to fix
${validationErrors.join('\n\n')}

## Codebase Context
${contextBlock}

Fix ALL validation errors. Use read_file to inspect current state, then apply_patch or write_file. Run diagnostics after fixing.`,
    },
  ];
}

export function buildFinalValidationPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  plan: ThunderPlan,
  stepSummaries: string[],
  touchedFiles: string[],
  existingErrors: string[]
): ChatMessage[] {
  const contextBlock = contextPack.formatted ?? '(no context)';
  const errorBlock =
    existingErrors.length > 0
      ? `\n\n## Known errors (fix these)\n${existingErrors.join('\n\n')}`
      : '';

  return [
    {
      role: 'system',
      content: buildSystemPrompt(mode, true),
    },
    {
      role: 'user',
      content: `## Goal\n${plan.goal}

## Completed work
${stepSummaries.map((s) => `- ${s}`).join('\n')}

## Files modified
${touchedFiles.length ? touchedFiles.map((f) => `- ${f}`).join('\n') : '(none tracked)'}
${errorBlock}

## Codebase Context
${contextBlock}

## Final validation (execute NOW)
1. Run diagnostics on all modified files (use diagnostics tool).
2. Run relevant tests/lint/build (run_command) if applicable.
3. Fix any remaining errors with apply_patch/write_file.
4. Summarize: what was done, test results, any remaining issues.

Do NOT skip verification — call tools now.`,
    },
  ];
}
