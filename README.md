# Claude Plugin List

Static viewer + daily stats for Claude Code plugins. The site loads `index.html` by default and reads its data from `lib/data/plugins-with-metadata.json`.

## Quick start

- Open `index.html` in a browser.
- Optional stats page: `stats.html`.

If you prefer a local server:
```bash
python3 -m http.server 8080
```

## Update data

### Requirements
- Bun
- GitHub token with public repo read access

### Setup
```bash
cp .env.example .env
# Add GITHUB_TOKEN=... to .env
bun install
```

### Run a full update
```bash
bun run update
```

This runs the GitHub search + validation pipeline, then updates:
- `lib/data/plugins-with-metadata.json`
- `lib/data/marketplaces.json`
- `lib/data/plugins.json`
- `lib/data/metadata.json`
- `lib/data/stats-history.json`

To update metadata/stats without re-running GitHub search:
```bash
bun run update:skip-search
```

## Daily cron (example)

```bash
0 2 * * * cd /path/to/claude-plugin-list && bun run update >> /path/to/claude-plugin-list/update.log 2>&1
```

## Ubuntu cron (2am Pacific) with .env + git push

This example assumes the repo lives at `/opt/claude-plugin-list` and you want
the job to pull updates, regenerate data, commit, and push once per day.

### One-time setup

```bash
# As a user with access to /opt
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
cd /opt
git clone <YOUR_REMOTE_URL> claude-plugin-list
cd /opt/claude-plugin-list

# Use your existing token (.env is gitignored)
cp /path/to/your/.env /opt/claude-plugin-list/.env

# Install dependencies
bun install

# Optional: ensure bun is available in PATH for cron
which bun
```

### Cron script

Create `scripts/cron-update.sh`:
```bash
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
```

Make it executable:
```bash
chmod +x /opt/claude-plugin-list/scripts/cron-update.sh
```

### Crontab entry (2am Pacific)

```bash
crontab -e
```

Add:
```bash
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin
CRON_TZ=America/Los_Angeles
0 2 * * * /opt/claude-plugin-list/scripts/cron-update.sh >> /opt/claude-plugin-list/update.log 2>&1
```

### Test run now

```bash
/opt/claude-plugin-list/scripts/cron-update.sh
```

## Data files

- `lib/data/plugins-with-metadata.json`: viewer data for `index.html`
- `lib/data/metadata.json`: last update timestamp + counts
- `lib/data/stats-history.json`: daily historical counts

## Acknowledgements

Search logic adapted from the claudemarketplaces.com project.

## License

MIT
