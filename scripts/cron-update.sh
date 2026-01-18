#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/opt/claude-plugin-list"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/update.log"
TAIL_LOG="$LOG_DIR/update.tail.log"
STATUS_FILE="$LOG_DIR/run-status.json"
MAX_LOG_BYTES=$((5 * 1024 * 1024))
MAX_LOG_BACKUPS=5

export HOME="${HOME:-/root}"

mkdir -p "$LOG_DIR"

file_size() {
  if [ ! -f "$1" ]; then
    echo 0
    return
  fi

  if command -v stat >/dev/null 2>&1; then
    if stat -c%s "$1" >/dev/null 2>&1; then
      stat -c%s "$1"
      return
    fi
    if stat -f%z "$1" >/dev/null 2>&1; then
      stat -f%z "$1"
      return
    fi
  fi

  wc -c < "$1" | tr -d " "
}

rotate_logs() {
  local size
  size="$(file_size "$LOG_FILE")"
  if [ "$size" -lt "$MAX_LOG_BYTES" ]; then
    return
  fi

  for ((i=MAX_LOG_BACKUPS; i>=1; i--)); do
    if [ -f "${LOG_FILE}.${i}" ]; then
      if [ "$i" -eq "$MAX_LOG_BACKUPS" ]; then
        rm -f "${LOG_FILE}.${i}"
      else
        mv "${LOG_FILE}.${i}" "${LOG_FILE}.$((i + 1))"
      fi
    fi
  done

  mv "$LOG_FILE" "${LOG_FILE}.1"
}

rotate_logs

exec > >(tee -a "$LOG_FILE") 2>&1

if [ "${FORCE_RUN:-false}" != "true" ]; then
  la_hour="$(TZ=America/Los_Angeles date +%H)"
  if [ "$la_hour" != "02" ]; then
    echo "Skipping run: America/Los_Angeles hour is $la_hour (set FORCE_RUN=true to override)."
    exit 0
  fi
fi

start_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
start_epoch=$(date -u +%s)

cd "$REPO_DIR"

# Load .env for GITHUB_TOKEN
set -a
source "$REPO_DIR/.env"
set +a

export PATH="/usr/local/bin:/usr/bin:/bin:${BUN_INSTALL:-$HOME/.bun}/bin:${PATH:-}"

remote_name="$(git remote | head -n 1 || true)"
if [ -n "$remote_name" ]; then
  git pull --rebase --autostash
else
  echo "No git remote configured; skipping pull."
fi

status="success"
error_message=""
if ! bun run update; then
  status="failure"
  error_message="bun run update failed"
fi

git_pushed="false"
git_commit=""

use_gh_auth=false
if command -v gh >/dev/null 2>&1; then
  if gh auth status -h github.com >/dev/null 2>&1; then
    use_gh_auth=true
  fi
fi

use_token_push=false
if [ "$use_gh_auth" = "false" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  use_token_push=true
fi

if [ "$status" = "success" ]; then
  git add lib/data/marketplaces.json lib/data/plugins.json lib/data/plugins-with-metadata.json lib/data/metadata.json lib/data/stats-history.json
  if ! git diff --cached --quiet; then
    git commit -m "chore: daily plugin sync $(date -u +%F)"
    git_commit="$(git rev-parse HEAD)"
    if [ -n "$remote_name" ]; then
      if [ "$use_gh_auth" = "true" ]; then
        echo "Using gh auth for git push."
        if GIT_TERMINAL_PROMPT=0 git push; then
          git_pushed="true"
        else
          status="failure"
          error_message="git push failed"
        fi
      elif [ "$use_token_push" = "true" ]; then
        echo "Using GITHUB_TOKEN for git push."
        if GIT_ASKPASS="$REPO_DIR/scripts/git-askpass.sh" GIT_TERMINAL_PROMPT=0 git push; then
          git_pushed="true"
        else
          status="failure"
          error_message="git push failed"
        fi
      else
        echo "Using default git auth for git push."
        if GIT_TERMINAL_PROMPT=0 git push; then
          git_pushed="true"
        else
          status="failure"
          error_message="git push failed"
        fi
      fi
    else
      echo "No git remote configured; skipping push."
    fi
  fi
else
  echo "Update failed; skipping git commit/push."
fi

end_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
end_epoch=$(date -u +%s)
duration=$((end_epoch - start_epoch))

export STATUS_FILE
export END_TS="$end_ts"
export STATUS="$status"
export DURATION="$duration"
export GIT_PUSHED="$git_pushed"
export GIT_COMMIT="$git_commit"
export ERROR_MESSAGE="$error_message"

python3 - <<'PY'
import json
import os

data = {
    "lastRun": os.environ["END_TS"],
    "status": os.environ["STATUS"],
    "durationSeconds": int(os.environ["DURATION"]),
    "gitPushed": os.environ["GIT_PUSHED"].lower() == "true",
    "gitCommit": os.environ.get("GIT_COMMIT") or None,
    "error": os.environ.get("ERROR_MESSAGE") or None,
    "logUrl": "/logs/update.log",
    "logTailUrl": "/logs/update.tail.log",
}

with open(os.environ["STATUS_FILE"], "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

tail -n 400 "$LOG_FILE" > "$TAIL_LOG" || true
