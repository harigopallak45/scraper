#!/usr/bin/env bash
# Installs the StackandCode scraper on Ubuntu 22.04 / 24.04 as a service that starts at boot and restarts itself.
#
#   (from the cloned repository)
#   sudo bash install-ubuntu.sh --token scr_xxxxxxxx [--url https://client.truewilly.com] [--name my-server] [--countries "United Kingdom,Australia"]
#
# Needs: root, internet, ~2 GB free disk. 4 GB RAM is enough for 3 browsers (a 2 GB swap file is added if there is no swap).
set -euo pipefail

URL="https://client.truewilly.com"; TOKEN=""; NAME="$(hostname)"; COUNTRIES=""; SWAP_GB=3
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --countries) COUNTRIES="$2"; shift 2;;
    --swap-gb) SWAP_GB="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[[ "$TOKEN" =~ ^scr_[0-9a-f]{48}$ ]] || { echo "Give the token made for this server: --token scr_..."; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/stackandcode-scraper

echo "== 1/6 system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl

echo "== 2/6 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -   # official NodeSource installer
  apt-get install -y nodejs
fi
node -v

echo "== 3/6 swap (small servers only)"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_TOTAL_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 6000 ] && [ "$SWAP_TOTAL_MB" -lt $(( SWAP_GB * 1024 - 256 )) ]; then   # skip when the machine already has about that much swap
  CUR_MB=0
  [ -f /swapfile ] && CUR_MB=$(( $(stat -c %s /swapfile) / 1048576 ))
  WANT_MB=$(( SWAP_GB * 1024 ))
  if [ "$CUR_MB" -lt "$WANT_MB" ]; then
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile
    fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "${SWAP_GB} GB swap in place."
  else
    echo "Swap already ${CUR_MB} MB."
  fi
  # prefer RAM; use swap only when needed
  echo 'vm.swappiness=20' > /etc/sysctl.d/99-stackandcode.conf && sysctl -q -p /etc/sysctl.d/99-stackandcode.conf || true
fi

echo "== 4/6 program files"
id scraper >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin scraper
mkdir -p "$DEST"
cp -a "$SRC/app" "$DEST/"
echo "   installing the browser library (npm)"
( cd "$DEST/app" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
mkdir -p "$DEST/data" "$DEST/browsers"
{
  echo "SCRAPER_API_URL=$URL"
  echo "SCRAPER_TOKEN=$TOKEN"
  echo "MACHINE_NAME=$NAME"
  [ -n "$COUNTRIES" ] && echo "COUNTRIES=$COUNTRIES"
} > "$DEST/settings.txt"
chmod 600 "$DEST/settings.txt"
chown -R scraper:scraper "$DEST"

echo "== 5/6 browser and its system libraries (about 300 MB)"
PLAYWRIGHT_BROWSERS_PATH="$DEST/browsers" node "$DEST/app/node_modules/playwright-core/cli.js" install --with-deps chromium
chown -R scraper:scraper "$DEST"

echo "== 6/6 service"
cp "$SRC/stackandcode-scraper.service" /etc/systemd/system/stackandcode-scraper.service
systemctl daemon-reload
systemctl enable --now stackandcode-scraper

echo
echo "Installed and running. Watch it:   journalctl -u stackandcode-scraper -f"
echo "Stop it gracefully:                sudo systemctl stop stackandcode-scraper"
echo "Start again:                       sudo systemctl start stackandcode-scraper"
echo "Settings (token, countries):       $DEST/settings.txt   (then: sudo systemctl restart stackandcode-scraper)"
