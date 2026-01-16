#!/usr/bin/env bash
set -euo pipefail

cd /opt/claude-plugin-list

# Load .env for GITHUB_TOKEN
set -a
source /opt/claude-plugin-list/.env
set +a

export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"

remote_name="$(git remote | head -n 1 || true)"
if [ -n "$remote_name" ]; then
  git pull --rebase --autostash
else
  echo "No git remote configured; skipping pull."
fi
bun run update

git add lib/data/*.json
if ! git diff --cached --quiet; then
  git commit -m "chore: daily plugin sync $(date -u +%F)"
  if [ -n "$remote_name" ]; then
    git push
  else
    echo "No git remote configured; skipping push."
  fi
fi
