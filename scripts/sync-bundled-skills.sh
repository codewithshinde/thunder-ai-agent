#!/usr/bin/env bash
# Maintainer utility: refresh bundled-skills/ from a local checkout (no runtime git pull in the extension).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${MITII_BUNDLED_SKILLS_DIR:-$ROOT_DIR/bundled-skills}"
SOURCE_DIR="${AGENT_SKILLS_SOURCE_DIR:-}"

usage() {
  cat <<'EOF'
Sync bundled skills committed with the VS Code extension.

Usage:
  AGENT_SKILLS_SOURCE_DIR=/path/to/agent-skills/skills bash scripts/sync-bundled-skills.sh
  bash scripts/sync-bundled-skills.sh /path/to/agent-skills/skills

Copies the seven Tier-1 SKILL.md folders from addyosmani/agent-skills into bundled-skills/.
Mitii-owned skills (e.g. audit-cleanup) live in bundled-skills/ and are not overwritten.
Does not run at extension runtime — commit the result and ship it in the VSIX.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  SOURCE_DIR="$1"
fi

if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
  echo "Set AGENT_SKILLS_SOURCE_DIR or pass the agent-skills/skills directory." >&2
  usage >&2
  exit 1
fi

SKILLS=(
  planning-and-task-breakdown
  debugging-and-error-recovery
  performance-optimization
  test-driven-development
  code-review-and-quality
  git-workflow-and-versioning
  using-agent-skills
)

mkdir -p "$DEST_DIR"

for skill in "${SKILLS[@]}"; do
  src="$SOURCE_DIR/$skill"
  if [[ ! -f "$src/SKILL.md" ]]; then
    echo "Missing $src/SKILL.md" >&2
    exit 1
  fi
  rm -rf "$DEST_DIR/$skill"
  cp -R "$src" "$DEST_DIR/$skill"
  echo "Synced $skill"
done

echo "Done. bundled-skills now contains $(find "$DEST_DIR" -name SKILL.md | wc -l | tr -d ' ') skill(s)."
