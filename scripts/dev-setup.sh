#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

editor="${THUNDER_EDITOR:-vscode}"

echo "Installing dependencies..."
npm install

echo "Compiling extension and webview..."
npm run compile

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Rebuilding native modules for ${editor}..."
  THUNDER_EDITOR="${editor}" npm run rebuild:native
else
  cat <<'NOTE'
Skipping Electron native rebuild auto-detection on this OS.
Set THUNDER_ELECTRON_VERSION for your editor, then run:
  THUNDER_ELECTRON_VERSION=<electron-version> npm run rebuild:native
NOTE
fi

echo "Rebuilding native modules for local Node tests..."
npm run rebuild:node

echo "Setup complete. Press F5 in VS Code to launch the Extension Development Host."
