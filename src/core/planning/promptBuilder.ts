import type { ContextPack } from '../context/types';
import type { ChatMessage } from '../llm/types';
import type { ThunderMode } from '../ThunderSession';
import type { ThunderPlan } from './PlanActEngine';
import { AGENT_NAME } from '../../shared/brand';
import { CHAT_HISTORY_GUIDANCE, STATE_MACHINE_GUIDANCE } from '../agent/taskStatePrompt';
import { buildAuditBootstrapBlock } from '../agent/auditRouting';

const TOOL_GUIDANCE = `
TOOLS: You have tools to read files, search code, run commands, write files, and manage memory.
- Use read_file/read_files/search/search_batch/list_files to gather information before editing.
- Tools named mcp__server__tool come from configured MCP servers. Treat them as external tools; inspect their names and arguments carefully.
- Batch independent reads and searches in ONE turn (read_files, search_batch).
- For audit/cleanup: use execute_workspace_script (audit-dependencies.mjs, audit-dead-code.sh) — NEVER spawn_research_agent for unused deps/imports/files.
- For unused exports/dead code: trust automated AST tools only (knip via audit-dead-code.sh, or npx knip / npx ts-prune). Do NOT manually grep for unused exports as the source of truth.
- Prefer execute_workspace_script for known repo scripts (knip, depcheck, safe lint, checkpoint read/write). Search with search_script_catalog first if needed.
- Prefer apply_patch for targeted logical blocks; use write_file for new files or full rewrites.
- Never put shell commands such as git checkout, npm install, yarn build, or rm into write_file content. Use run_command for commands and write_file/apply_patch only for actual file contents.
- Safe patching: in TSX/JSX, never replace isolated single lines inside a component. Patch the whole import block, whole object, whole hook block, or whole component/function block. Before patching, mentally verify brackets {}, parens (), tags <>, and required adjacent React props stay balanced.
- Use run_command only for read-only inspection or project verification. During audit/cleanup tasks, use execute_workspace_script instead of hand-written shell.
- Use use_skill to load a specific workspace skill playbook when the task matches one.
- Use memory_search only as a fallback when chat history lacks needed facts.
- Use save_task_state or memory_write to persist progress BEFORE pausing for approval (required).
- Use ask_question when a key decision is ambiguous — provide 2-5 options to reduce wrong-direction work.
- Use fetch_web for external docs, API references, or debugging when local context is insufficient.
- Use mark_step_complete when finishing a plan step; use propose_plan_mutation if you hit a major roadblock.
- In Act mode, you may call write_file/apply_patch/run_command tools directly.
- If a tool returns "awaiting approval", stop and inform the user.
- NEVER say "I will search…" without calling tools in the same turn.`;

const AUDIT_GUIDANCE = `
AUDIT / CLEANUP MODE — AST-FIRST (avoid tunnel vision and manual grep):
1. **First turn**: execute_workspace_script("audit-dependencies.mjs") — depcheck scans ALL npm deps via AST in ~0.5s.
2. **Second turn**: execute_workspace_script("audit-dead-code.sh") — knip finds unused files/exports/deps in one pass.
3. read_file package.json only if scripts fail.
4. NEVER use manual grep/search as the source of truth for unused exports. Use knip or ts-prune output.
5. NEVER spawn_research_agent to grep each dependency (64 deps × 3s inference = 108s+).
6. NEVER run search per-package — regex misses comments; AST scripts do not.
7. Report with confidence: high (safe to remove), medium (likely unused), low (needs review).
8. In Plan/Review mode: report only — do NOT delete until user confirms.
9. Run compile/lint/build only in the final Verify phase. If final TypeScript errors are unrelated to touched files, log them as remaining issues and do not restart cleanup or pivot to unrelated fixes.`;

const PLANNING_DISCOVERY_GUIDANCE = `
READ-ONLY PLANNING DISCOVERY TOOLS:
- Use read_file/read_files/search/search_batch/list_files/repo_map/retrieve_context to inspect the codebase.
- Use diagnostics, git_diff, memory_search, and search_script_catalog when relevant.
- For audit/cleanup: execute_workspace_script (audit-dependencies.mjs, audit-dead-code.sh) — NOT spawn_research_agent.
- For unused exports/dead code: use knip/ts-prune through audit-dead-code.sh or read-only npx commands; do NOT manually grep.
- Use run_command only for read-only inspection commands such as rg, find, git status, npx depcheck, npx knip, lint/test/typecheck checks.
- Do NOT call write_file, apply_patch, memory_write, or save_task_state during planning discovery.`;

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
4. **Fix** — fix validation errors only when they are caused by your touched files or current task. Log unrelated pre-existing TypeScript errors without derailing the plan.

You may also output files in this format when tools are unavailable:

\`\`\`tsx|CODE_EDIT_BLOCK|relative/path/to/file.tsx
// complete file contents
\`\`\`

Rules:
- Use correct relative paths from context.
- Fix syntax, imports, and type errors proactively.
- Prefer apply_patch for complete logical blocks; write_file for new files or full rewrites.
- Never write a shell command into a source file. If the fix is to restore from git or run a package command, use run_command.
- In TSX/JSX, never patch isolated single component lines. Patch the full import block, object, hook block, or component/function block.
- After completing edits, always finish with a concise Markdown summary containing: what changed, verification run, and any remaining issues.`,
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

  return `You are ${AGENT_NAME}, a local-first VS Code coding agent with codebase context injected below.

${modeInstructions[mode]}
${toolsEnabled ? TOOL_GUIDANCE : ''}
${toolsEnabled && auditMode ? AUDIT_GUIDANCE : ''}
${toolsEnabled && isContinuation ? '\nCONTINUATION TURN: Resume the existing state machine. Read Task progress, approved tool outputs, and recent conversation first. Continue from the pending EXECUTE/VERIFY step. Do NOT re-run audit-dependencies, audit-dead-code, list_files, or memory_search before using the approval context.' : ''}
${mode === 'plan' ? planFormat : ''}

RULES:
- The user's message may include a <user_explicit_context> block with files/folders they pinned. Treat that as highest priority — focus there first before wider codebase context.
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
  isContinuation = false,
  explicitContextBlock?: string
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

  const auditBootstrap =
    auditMode && mode === 'act' && !isContinuation
      ? `\n\n${buildAuditBootstrapBlock()}\n`
      : '';

  const explicitBlock = explicitContextBlock?.trim()
    ? `${explicitContextBlock.trim()}\n\n---\n\n`
    : '';

  const userContent = `${explicitBlock}## Codebase Context

${contextBlock}
${taskProgress}${continuationNote}${auditBootstrap}
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
    ? 'Audit/cleanup: Phase 1 MUST use execute_workspace_script (audit-dependencies.mjs, audit-dead-code.sh) — read-only AST scans. Unused exports MUST come from knip/ts-prune, not manual grep. Phase 3 Execute creates configs and edits package.json. Do NOT assign file writes to diagnostics phase.'
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

/** Isolated plan compilation — receives only goal, repo map, and script catalog. No raw file reads. */
export function buildIsolatedPlanPrompt(
  mode: ThunderMode,
  contextPack: ContextPack,
  userMessage: string,
  requirementAnalysis?: string,
  task?: { kind: string; complexity: string }
): ChatMessage[] {
  const repoMapItem = contextPack.items.find((i) => i.source === 'repo-map' || i.reason.includes('repo'));
  const repoMapBlock = repoMapItem?.content ?? '(repo map unavailable — use retrieve_context after execution begins)';
  const analysisBlock = requirementAnalysis ? `\n\n## Requirement analysis\n${requirementAnalysis}` : '';
  const isAudit = task?.kind === 'audit';

  return [
    {
      role: 'system',
      content: `You are an isolated plan compiler. You MUST NOT read raw source files — you receive only:
1. The user's goal
2. A compressed repo_map
3. Requirement analysis (if any)

Output a strict JSON DAG plan with dependsOn edges. Each step must declare:
- id, title, objective, tools (array), successCriteria, files, risk, phase
- dependsOn: array of step ids that must complete first (empty for root steps)
- optional tool + args for script-driven steps

${isAudit ? 'Audit tasks need 8+ granular steps across diagnostics/review/execute/verify phases. Diagnostics must run knip or ts-prune for unused exports.' : 'Use 2-8 steps based on complexity.'}

Output ONLY a JSON code block:
\`\`\`json
{
  "goal": "...",
  "assumptions": ["..."],
  "steps": [
    {
      "id": "step_1",
      "title": "...",
      "objective": "...",
      "tools": ["execute_workspace_script"],
      "dependsOn": [],
      "successCriteria": ["..."],
      "files": ["path"],
      "risk": "low",
      "phase": "diagnostics"
    },
    {
      "id": "step_2",
      "title": "...",
      "dependsOn": ["step_1"],
      "phase": "execute",
      "risk": "medium"
    }
  ],
  "requiredApprovals": []
}
\`\`\`
Mode: ${mode}.`,
    },
    {
      role: 'user',
      content: `## Repo map (compressed)\n${repoMapBlock}${analysisBlock}\n\n## Task\n${userMessage}\n\nCompile the DAG plan JSON.`,
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
3. Fix errors only when they are caused by the files you modified or the current task.
4. If TypeScript reports unrelated/pre-existing errors, log them under remaining issues and do not restart or pivot away from the cleanup plan.
5. Summarize: what was done, test results, any remaining issues.

Do NOT skip verification — call tools now.`,
    },
  ];
}
