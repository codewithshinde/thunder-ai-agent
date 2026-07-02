---
name: environment-and-secrets
description: Safely inspect environment variable templates, missing keys, and secret setup without exposing secret values. Use for .env, env.example, missing environment variable, API key, token, and secret configuration tasks.
---

# Environment and Secrets

Secrets are operational data, not chat content. Report key names and file paths, never values.

## Steps

1. `execute_workspace_script({ script: "sync-env-files.mjs" })` — compare `.env*` files with templates and report missing keys
2. Read `.env.example`, `.env.template`, or documented config files when script output points to them.
3. Report missing keys by name only, grouped by file.
4. Guide the user to fill local `.env` files from committed examples.
5. If code changes are needed, update validation, docs, or examples without committing real credentials.

## Safety Rules

- Never print, summarize, or transform secret values.
- Never copy values from `.env` into docs, tests, logs, prompts, or generated files.
- Prefer placeholder values such as `YOUR_API_KEY_HERE`.
- If a secret is already exposed in tracked files, stop and report it as a security concern.

## Mode Rules

- Plan mode: produce a remediation checklist only.
- Act mode: update examples, validation, and docs; do not create real secrets.
