#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

if [[ ! -f .mitii-state.json ]]; then
  echo "No .mitii-state.json checkpoint found in $ROOT" >&2
  exit 1
fi

node <<'NODE'
const { readFileSync } = require('fs');

const checkpoint = JSON.parse(readFileSync('.mitii-state.json', 'utf8'));
console.log(`Saved: ${checkpoint.savedAt}`);
console.log(`Branch: ${checkpoint.branch || '(unknown)'}`);
console.log(`Commit: ${checkpoint.commit || '(unknown)'}`);
console.log('');
console.log('Plan:');
console.log(checkpoint.plan || '(empty)');
if (checkpoint.findings) {
  console.log('');
  console.log('Findings:');
  console.log(checkpoint.findings);
}
if (checkpoint.gitStatus) {
  console.log('');
  console.log('Git status at checkpoint:');
  console.log(checkpoint.gitStatus);
}
NODE
