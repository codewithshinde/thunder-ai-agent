# Thunder AI Agent

Local-first VS Code AI coding agent with precise repo context, hybrid retrieval, and safe Plan/Act workflow.

## Features

- React + Vite sidebar webview with chat UI
- OpenAI-compatible provider support (plus Echo provider for testing)
- SQLite + FTS5 indexing with workspace scanner
- Symbol extraction (TS/JS/Python/Java/Go)
- Repo map with ranking
- Hybrid context retrieval and budgeter
- Plan / Act / Review modes
- Tool runtime with policy engine and approval queue
- Patch apply with validation
- Checkpoints and rollback
- Local memory summaries

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
- `thunder.provider.model` — e.g. `llama3`

Store API keys via the settings UI (uses VS Code SecretStorage).

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
  → ToolRuntime → ToolPolicyEngine → ApprovalQueue
```

## Troubleshooting

**SQLite errors**: Ensure the workspace is writable. Thunder stores data in `.thunder/thunder.sqlite`.

**Provider errors**: Verify base URL and model name. Use Echo provider for UI testing without an LLM.

**Indexing issues**: Check `.gitignore` / `.thunderignore`. Run `Thunder: Index Workspace` manually.

## License

MIT
