# Security And Data Flow

Mitii is local-first. Workspace indexes, memory, plans, checkpoints, and JSONL session logs are stored under the workspace `.mitii/` directory.

## What Leaves The Machine

Only prompt data sent to the configured LLM provider leaves the machine. The provider boundary is controlled by `thunder.provider.*`. Enterprises can enable `thunder.enterprise.localProvidersOnly` to require Echo or a localhost OpenAI-compatible endpoint.

## Secrets

API keys are stored in VS Code SecretStorage. Logs and audit packs redact keys named like API keys, tokens, passwords, and secrets. Audit packs can additionally strip tool output and file content with `thunder.enterprise.stripFileContentsFromAuditPacks`.

## MCP Risk Model

MCP tools are routed through Mitii tool policy. File writes and mutating shell commands require approval according to `thunder.safety.approvalMode` and `thunder.safety.requireApprovalForWrites`.

## Auditability

Use `Mitii: Export Audit Pack` to produce a zip containing `session.jsonl`, `summary.md`, `manifest.json`, `tool-audit.json`, `approvals.json`, and `redaction-report.json`.

