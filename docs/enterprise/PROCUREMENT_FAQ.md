# Procurement FAQ

## Deployment Model

Mitii is a VS Code extension with local workspace storage. There is no required Mitii server.

## Supported Platforms

Mitii targets macOS, Linux, and Windows. CI runs `npm test` on `ubuntu-latest`, `macos-latest`, and `windows-latest`.

## Offline And Local Models

Mitii supports OpenAI-compatible localhost providers such as Ollama and LM Studio. Set `thunder.enterprise.localProvidersOnly` to enforce local-only usage.

## Controls Procurement Teams Ask For

| Control | Setting or command |
|---|---|
| Disable session logging | `thunder.telemetry.sessionLogging` |
| Disable verbose diagnostics | `thunder.telemetry.debugMetrics` |
| Require approval for writes | `thunder.safety.requireApprovalForWrites` |
| Require approval for shell | `thunder.safety.requireApprovalForShell` |
| Local providers only | `thunder.enterprise.localProvidersOnly` |
| Strip file contents from audit packs | `thunder.enterprise.stripFileContentsFromAuditPacks` |
| Export review evidence | `Mitii: Export Audit Pack` |

## License

Mitii is licensed under AGPL-3.0-or-later. Commercial licensing questions should use the project contact in the README.

