#!/usr/bin/env bash
set -euo pipefail

cd /opt/claude-plugin-list

# Load .env for GITHUB_TOKEN
set -a
source /opt/claude-plugin-list/.env
set +a

git pull --rebase --autostash
bun run update

git add lib/data/*.json
if ! git diff --cached --quiet; then
  git commit -m "chore: daily plugin sync $(date -u +%F)"
  git push
fi
