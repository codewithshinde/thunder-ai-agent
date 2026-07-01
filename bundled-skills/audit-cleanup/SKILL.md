---
name: audit-cleanup
description: Find unused imports, npm dependencies, and orphan source files. Use for cleanup, depcheck, dead code, or bundle-size audits.
---

# Audit / cleanup — script-first

## Why scripts, not subagents

Checking 64 dependencies via `spawn_research_agent` + `search` causes ~20 LLM rounds × 3s = **108s+**.
Scripts use AST parsing and finish in **~3s**.

## Steps

1. `execute_workspace_script({ script: "audit-dependencies.mjs" })` — depcheck, all deps at once
2. `execute_workspace_script({ script: "audit-dead-code.sh" })` — knip: unused files, deps, exports
3. read_file `package.json` only if scripts are unavailable
4. Classify: **high** (safe), **medium** (likely), **low** (review)
5. Plan mode: report only. Act mode: remove after user confirms

## Do NOT

- spawn_research_agent to grep each dependency
- search package-by-package through 18 prod + 46 dev deps
- re-run depcheck after script output is in chat history
