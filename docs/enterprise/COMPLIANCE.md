# Compliance Mapping

## SOC 2 Readiness

| Area | Current Capability | Roadmap |
|---|---|---|
| Access control | VS Code workspace trust, approval gates, local SecretStorage | Central policy distribution |
| Change audit | JSONL session logs, tool audit log, audit pack export | Signed audit archives |
| Data minimization | Micro-task routing for commit/changelog/release prompts | Per-team prompt retention policy |
| Incident review | Session summaries, timing events, errors, tool calls | SIEM forwarding |

## GDPR Considerations

Mitii does not require a Mitii-hosted cloud service. Personal data exposure depends on the selected LLM provider and the code or prompts a user chooses to send.

## Audit Trail

Audit packs are designed for compliance review. They include event timelines, model metadata, tool calls, approval state, and redaction counts without requiring reviewers to inspect source code.

