# Bundled Mitii skills

These skill playbooks ship inside the VS Code extension and are copied into each workspace at `.mitii/skills/` on first init.

They are **not** downloaded at runtime. Refresh upstream skills with:

```bash
AGENT_SKILLS_SOURCE_DIR=/path/to/agent-skills/skills bash scripts/sync-bundled-skills.sh
```

Edit Mitii-owned skills (e.g. `audit-cleanup/`) directly in this folder, then commit and publish a new extension version.
