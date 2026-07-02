---
name: code-smells-and-tech-debt
description: Find and classify console logs, inline styles, missing type annotations, and targeted lint issues. Use for tech-debt cleanup, lint hygiene, console.log removal, style cleanup, and missing TypeScript types.
---

# Code Smells and Tech Debt

Use deterministic scripts first, then inspect only the files that matter. Do not run broad manual grep before the scripts have summarized the workspace.

## Steps

1. `execute_workspace_script({ script: "find-console-logs.sh" })` — report committed debugging logs and risky console usage
2. `execute_workspace_script({ script: "find-inline-styles.sh" })` — report inline style usage that may violate UI conventions
3. `execute_workspace_script({ script: "check-missing-types.sh" })` — report missing annotations and weak typing hotspots
4. `execute_workspace_script({ script: "safe-lint-target.sh", args: ["<relative-file>"] })` — run targeted lint/type checks only after choosing touched files
5. Classify findings:
   - **fix now**: unsafe logs, obvious type holes, lint errors in touched files
   - **defer**: broad refactors, generated files, low-risk style cleanup outside scope
   - **ignore**: intentional diagnostics, examples, tests where console output is asserted

## Mode Rules

- Plan mode: report findings, risk, and proposed fix order only.
- Act mode: make scoped fixes after the task explicitly asks for cleanup or after the user approves the finding list.
- Keep behavioral changes separate from mechanical cleanup unless the cleanup is required to fix the bug.

## Do NOT

- edit generated files or vendored code
- convert every inline style during an unrelated task
- rerun the same script when its fresh output is already present in chat history
