# Thunder AI Agent

Local-first VS Code AI coding agent with precise repo context, hybrid retrieval, and safe Plan/Act workflow.

## Features

- React + Vite sidebar webview with chat UI
- OpenAI-compatible provider support (plus Echo provider for testing)
- **Agentic tool loop** — LLM calls `read_file`, `search`, `write_file`, `apply_patch`, `run_command`, etc.
- **Task decomposition** — complex tasks split into steps with lifecycle tracking
- **Multi-turn context** — conversation history + compaction in prompts
- SQLite + FTS5 indexing with workspace scanner + **ripgrep fallback**
- Symbol extraction (TS/JS/Python/Java/Go)
- Repo map with ranking
- Hybrid context retrieval and budgeter
- Plan / Act / Review modes with **plan persistence** (`task_plans` table)
- Tool runtime with policy engine, **autonomy presets**, and approval queue
- **VS Code diff preview** before writes/patches
- **Auto-checkpoints** before approved writes
- Patch apply with validation
- **Long-term memory** — `memory_search` / `memory_write` tools + post-task extraction
- **Passive memory injection** — claude-mem style hook-based + automatic context injection
- **Subagent status UI** — parallel research worker cards (Cline `SubagentStatusRow` pattern)
- **LLM compaction + auto-continue** — long audit sessions stay within context budget
- **Post-edit lint loop** — Aider-style validation reflection after writes
- **PageRank repo map** — Aider-style symbol graph ranking
- **Validate-and-fix on apply** — Plandex-style syntax guards before patch apply
- **Optional vector search** — SQLite hash embeddings (LanceDB pluggable later)
- **MCP tools** — stdio MCP servers from VS Code settings, `.thunder/mcp.json`, or `.mcp.json`
- **Project rules loader** — imports `AGENTS.md`, `CLAUDE.md`, `.thunder/rules`, `.clinerules`, Continue rules, and Cursor rules into context
- **Session persistence** — `agent_sessions` + `agent_turns` in SQLite
- Memory & checkpoint panels in chat UI

## Requirements

- VS Code 1.85+
- Node.js 20+

## Setup

```bash
cd thunder-ai-agent
npm install
npm run compile
```

Press F5 in VS Code to launch the Extension Development Host.

## Commands

| Command | Description |
|---------|-------------|
| `Thunder: Open Chat` | Focus the Thunder sidebar |
| `Thunder: Index Workspace` | Scan and index the workspace |
| `Thunder: Show Settings` | Open settings tab |

## Configuration

Set `thunder.provider.type` to `openai-compatible` and configure:

- `thunder.provider.baseUrl` — e.g. `http://localhost:11434/v1`
- `thunder.provider.model` — e.g. `qwen3-coder:30b`

Store API keys via the settings UI (uses VS Code SecretStorage).

### MCP servers

Thunder preloads **free, keyless** official MCP servers on startup (like a built-in marketplace):

| Server | Package | Notes |
|--------|---------|-------|
| `filesystem` | `@modelcontextprotocol/server-filesystem` | Scoped to the open workspace root |
| `memory` | `@modelcontextprotocol/server-memory` | Persistent knowledge graph across sessions |
| `sequential-thinking` | `@modelcontextprotocol/server-sequential-thinking` | Structured reasoning helper |

Disable all built-ins with `"thunder.mcp.preloadBuiltin": false`, or override a single server by reusing its name in settings or workspace config.

Thunder also loads stdio MCP servers from VS Code settings:

```json
"thunder.mcp.servers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  }
}
```

You can also commit workspace-local MCP config in `.thunder/mcp.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

For bulk startup, add every server under `mcpServers`; Thunder auto-loads all
enabled entries when the extension initializes or settings reload. Startup is
parallelized and capped by `thunder.mcp.maxConcurrentStartup`:

```json
{
  "thunder.mcp.maxConcurrentStartup": 4,
  "thunder.mcp.servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

MCP tools are exposed to the model as `mcp__server__tool` and still flow through Thunder's approval policy.

### Project rules

Thunder automatically reads methodology/rule files and injects them as budgeted context:

- `AGENTS.md`, `CLAUDE.md`, `WARP.md`, `.cursorrules`
- `.thunder/rules`, `.thunder/agents`, `.thunder/checks`, `.thunder/prompts`
- `.clinerules`
- `.continue/rules`, `.continue/agents`, `.continue/checks`, `.continue/prompts`
- `.cursor/rules`

## Development

```bash
npm run watch     # Watch extension + webview
npm run test      # Run unit tests
npm run lint      # Typecheck
npm run package   # Build VSIX
```

## Architecture

```
VS Code Extension → ThunderController → SQLite Index
  → HybridRetriever → ContextBudgeter → ChatOrchestrator
  → AgentLoop (tool round-trip) → PlanExecutor (step engine)
  → ToolRuntime → ToolPolicyEngine → ApprovalQueue → DiffPreview / Checkpoints
  → MemoryExtractor → MemoryService
```

## Troubleshooting

**SQLite / native module errors**: VS Code and Cursor use Electron, not system Node. After `npm install`, run:

```bash
npm run rebuild:native          # VS Code (auto-detects Electron version)
# or for Cursor:
THUNDER_EDITOR=cursor npm run rebuild:native
```

Before running tests, rebuild for local Node if needed: `npm run rebuild:node`

**SQLite errors**: Ensure the workspace is writable. Thunder stores data in `.thunder/thunder.sqlite`.

**Provider errors**: Verify base URL and model name. Use Echo provider for UI testing without an LLM.

**Indexing issues**: Check `.gitignore` / `.thunderignore`. Run `Thunder: Index Workspace` manually.

## License

MIT
