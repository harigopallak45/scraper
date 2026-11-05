#!/usr/bin/env bash
# Updates an installed worker to the latest version from GitHub and restarts it. Keeps the token and settings.
#   sudo bash update-ubuntu.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/stackandcode-scraper
[ -d "$DEST/app" ] || { echo "Not installed yet: run install-ubuntu.sh first."; exit 1; }
git -C "$SRC" pull --ff-only
cp "$SRC/app/worldwide.js" "$SRC/app/run.js" "$SRC/app/package.json" "$DEST/app/"
( cd "$DEST/app" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
chown -R scraper:scraper "$DEST"
systemctl restart stackandcode-scraper
echo "Updated and restarted. Watch it:  journalctl -u stackandcode-scraper -f"
