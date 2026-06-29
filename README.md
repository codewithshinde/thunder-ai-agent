# Mitii AI Agent

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js)](https://nodejs.org/)
[![Website](https://img.shields.io/badge/website-mitii.dev-000000)](https://mitii.dev)

Local-first AI coding agent for VS Code. Bring your own model (Ollama, vLLM, any OpenAI-compatible endpoint), keep your code on your machine, and get an agent that actually knows your repo before it starts editing files.

**Docs:** [docs.mitii.dev](https://docs.mitii.dev) · **Discord:** [discord.gg/sa8rubf6HH](https://discord.gg/sa8rubf6HH)

Built by [codewithshinde](https://github.com/codewithshinde).

---

## The problem

Most coding agents fall into one of two camps:

1. **Cloud-only** — fast models, but your source code leaves the machine and you have limited control over what the agent can touch.
2. **Local but blind** — the model runs nearby, but context is shallow: a few `@`-mentioned files, maybe a grep, then a patch that misses half the codebase.

Both approaches break down on real work. Refactors span dozens of files. Audits need dependency graphs, not just string search. Long sessions blow past context windows. And when an agent writes to disk or runs shell commands, you want guardrails — not a binary "trust everything" switch.

Mitii sits in the middle: local execution, deep repo indexing, explicit Plan/Act separation, and approval policies you can tune from "ask me about everything" to "just run it, but block `rm -rf`".

---

## How Mitii solves it

| Pain point | What Mitii does |
|------------|-------------------|
| Agent doesn't know the codebase | Background workspace index: SQLite + FTS5, symbol extraction (tree-sitter with regex fallback), PageRank repo map, optional MiniLM vectors |
| Wrong files in context | Hybrid retrieval (FTS + vectors + repo map + git diff + diagnostics), reranker trims noise (top-20 → top-8), token budgeter drops low-value chunks |
| Edits without oversight | Approval queue for writes and shell; autonomy presets from `safe` through `enterprise`; dangerous commands blocked at the policy layer |
| Plans that never get executed | Plan mode produces structured steps persisted to SQLite; Act mode runs the tool loop against that plan |
| Context runs out mid-task | Conversation compaction, auto-continue rounds, task state saved between approval pauses |
| No audit trail | JSONL session logs in `.mitii/logs/` — every tool call, approval, token usage, timing |
| Locked into one vendor's rules | Loads `AGENTS.md`, `.cursor/rules`, `.clinerules`, Continue rules, and `.mitii/rules` into context automatically |
| Need external tools | Built-in MCP preload (filesystem, memory, sequential-thinking) plus workspace `mcp.json` and VS Code settings |

---

## Features

### Context and indexing

- **Workspace scanner** respects `.gitignore` and `.mitiiignore`; auto-indexes on folder open
- **FTS5 full-text search** with ripgrep fallback for unindexed paths
- **Symbol extraction** for TypeScript, JavaScript, Python, Java, Go
- **PageRank repo map** — surfaces the files that matter structurally, not just lexically
- **Vector search** — local MiniLM embeddings via `@xenova/transformers`, hash fallback if unavailable; SQLite or LanceDB backend
- **Hybrid retriever + reranker** — merges search, vectors, mentioned files, git state, and LSP diagnostics into one context pack

### Agent workflow

- **Plan / Act / Review modes** — plan before you touch code; act with tools; review without rewriting
- **Tool loop** — `read_file`, `search`, `write_file`, `apply_patch`, `run_command`, `git_diff`, `diagnostics`, and more
- **Research subagents** — parallel read-only workers for exploration (`spawn_research_agent`)
- **Task decomposition** — multi-step plans with lifecycle tracking and step completion markers
- **Post-edit verification** — configurable lint/test commands after Act-mode runs
- **Skills catalog** — drop `SKILL.md` files in `.mitii/skills/` and invoke them via `use_skill`

### Safety and control

- **Approval modes** — `review_all`, `ask_edits`, `ask_deletes`, `ask_commands`, `auto`
- **Autonomy presets** — `safe`, `guided`, `builder`, `pilot`, `enterprise` (network disabled)
- **Untrusted workspace blocking** — writes and shell disabled unless you explicitly opt in
- **Auto-checkpoints** before approved file writes
- **Optional diff preview** in VS Code before patches land
- **Patch validation** — syntax guards before apply; refuses shell commands masquerading as source code

### Memory and persistence

- **Long-term memory** — `memory_search` / `memory_write` with FTS5 + optional vector hybrid search
- **Post-task memory extraction** — observations captured after completed work
- **Session history** — `agent_sessions` and `agent_turns` stored in SQLite; resume from the History tab
- **Plan persistence** — plans saved to `task_plans` and `.mitii/tasks/`

### MCP and integrations

Preloaded keyless MCP servers (disable with `thunder.mcp.preloadBuiltin: false`):

| Server | Purpose |
|--------|---------|
| `filesystem` | Scoped file access for the open workspace |
| `memory` | Cross-session knowledge graph |
| `sequential-thinking` | Structured reasoning helper |

Add your own via `thunder.mcp.servers`, `.mitii/mcp.json`, or `.mcp.json`. MCP tools appear as `mcp__server__tool` and still pass through Mitii's approval policy.

### UI

React sidebar webview with chat, history, settings, approval cards, subagent activity panel, plan panel, checkpoint browser, indexing status, context budget warnings, and token meter.

---

## Quick start

**Requirements:** VS Code 1.85+, Node.js 20+

```bash
git clone https://github.com/codewithshinde/thunder-ai-agent.git
cd thunder-ai-agent
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host. Open a folder, wait for indexing to finish (status bar in the Mitii sidebar), then chat.

### Connect a model

1. Open **Settings** in the Mitii sidebar (or VS Code settings under `Mitii AI Agent`)
2. Set `thunder.provider.type` to `openai-compatible`
3. Point `thunder.provider.baseUrl` at your endpoint (default: `http://localhost:11434/v1` for Ollama)
4. Set `thunder.provider.model` (default: `qwen3-coder:30b`)

Use the Echo provider for UI testing without an LLM. API keys go through VS Code SecretStorage via the settings UI.

---

## Commands

| Command | Description |
|---------|-------------|
| `Mitii: Open Chat` | Focus the Mitii sidebar |
| `Mitii: Index Workspace` | Re-scan and index the workspace |
| `Mitii: Show Settings` | Open the settings tab |
| `Mitii: Export Session Log` | Export the current session's JSONL log |
| `Mitii: Open Session Log File` | Open the log file in the editor |

---

## Configuration highlights

```json
{
  "thunder.provider.type": "openai-compatible",
  "thunder.provider.baseUrl": "http://localhost:11434/v1",
  "thunder.provider.model": "qwen3-coder:30b",
  "thunder.safety.autonomyPreset": "guided",
  "thunder.safety.approvalMode": "review_all",
  "thunder.indexing.autoIndexOnOpen": true,
  "thunder.indexing.vectorsEnabled": true,
  "thunder.agent.verifyCommands": ["npm run lint", "npm test"],
  "thunder.telemetry.sessionLogging": true
}
```

See `package.json` → `contributes.configuration` for the full schema, or the [Settings tab](src/webview-ui/src/components/SettingsPanel.tsx) in the sidebar.

### Project rules

Mitii picks up methodology files automatically:

- `AGENTS.md`, `CLAUDE.md`, `WARP.md`, `.cursorrules`
- `.mitii/rules`, `.mitii/agents`, `.mitii/checks`, `.mitii/prompts`
- `.clinerules`, `.continue/rules`, `.cursor/rules`

Commit these to your repo so every session starts with the same conventions.

---

## Architecture

```
VS Code Extension
  └─ ThunderController
       ├─ SQLite Index (FTS5, symbols, vectors, sessions, memory)
       ├─ HybridRetriever → ContextBudgeter
       ├─ ChatOrchestrator
       │    ├─ AgentLoop (tool round-trip)
       │    └─ PlanExecutor (step engine)
       ├─ ToolRuntime → ToolPolicyEngine → ApprovalQueue
       ├─ PatchApplyService / CheckpointService
       ├─ MemoryService + PostTaskMemoryWorker
       └─ McpManager
```

Data lives in `.mitii/` inside your workspace (`mitii.sqlite`, logs, checkpoints, tasks). Nothing is sent to a Mitii server — there isn't one.

---

## Troubleshooting

**`better-sqlite3` fails to load**

VS Code and Cursor ship their own Electron runtime, not your system Node:

```bash
npm run rebuild:native          # VS Code (auto-detects Electron)
THUNDER_EDITOR=cursor npm run rebuild:native   # Cursor
npm run rebuild:node            # for local vitest runs
```

**Provider errors** — check base URL and model name. Echo provider works without a running LLM.

**Indexing stuck or empty** — verify the workspace is writable, check `.gitignore` / `.mitiiignore`, run `Mitii: Index Workspace`.

**Context feels thin** — confirm indexing finished, enable vectors (`thunder.indexing.vectorsEnabled`), and check the context budget warning banner in chat.

---

## Related repositories

| Project | Repository | URL |
|---------|------------|-----|
| Documentation | [mitii-docs](https://github.com/codewithshinde/mitii-docs) | [docs.mitii.dev](https://docs.mitii.dev) |
| Website | [mitii-website](https://github.com/codewithshinde/mitii-website) | [mitii.dev](https://mitii.dev) |

Scaffold copies live in `mitii-docs/` and `mitii-website/` at the repo root for convenience. Each is intended to be its own git repository — see the README in each folder for `git init` and deploy steps.

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, testing, and pull request guidelines.

```bash
npm run watch     # extension + webview hot rebuild
npm run test      # unit tests
npm run lint      # typecheck
npm run package   # build .vsix
```

---

## Author

**codewithshinde**  
GitHub: [@codewithshinde](https://github.com/codewithshinde)  
Email: [codewithshinde@gmail.com](mailto:codewithshinde@gmail.com)

Questions, bug reports, and PRs welcome on [GitHub Issues](https://github.com/codewithshinde/thunder-ai-agent/issues).

---

## License

Mitii AI Agent is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-or-later).

If you run a modified version as a network service, AGPL requires you to make the corresponding source available to users of that service. For commercial licensing outside AGPL terms, contact codewithshinde@gmail.com.
