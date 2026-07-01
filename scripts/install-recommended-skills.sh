#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cat <<'EOF'
install-recommended-skills.sh is deprecated.

Mitii now ships bundled skills inside the VS Code extension and copies them
into .mitii/skills/ on workspace init. To refresh the committed bundle for
maintainers, run:

  npm run skills:sync-bundled

Or:

  AGENT_SKILLS_SOURCE_DIR=/path/to/agent-skills/skills bash scripts/sync-bundled-skills.sh
EOF

exit 0
