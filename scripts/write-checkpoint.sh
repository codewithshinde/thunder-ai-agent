#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

STDIN_TEXT=""
if [[ ! -t 0 ]]; then
  STDIN_TEXT="$(cat)"
fi

export THUNDER_CHECKPOINT_TEXT="${THUNDER_CHECKPOINT_TEXT:-${THUNDER_PLAN:-$STDIN_TEXT}}"
export THUNDER_CHECKPOINT_FINDINGS="${THUNDER_FINDINGS:-}"

node <<'NODE'
const { writeFileSync } = require('fs');
const { execSync } = require('child_process');

function git(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const checkpoint = {
  version: 1,
  savedAt: new Date().toISOString(),
  cwd: process.cwd(),
  branch: git('git branch --show-current'),
  commit: git('git rev-parse --short HEAD'),
  gitStatus: git('git status --short'),
  plan: process.env.THUNDER_CHECKPOINT_TEXT || '',
  findings: process.env.THUNDER_CHECKPOINT_FINDINGS || '',
};

writeFileSync('.mitii-state.json', `${JSON.stringify(checkpoint, null, 2)}\n`);
console.log('Wrote .mitii-state.json');
NODE
