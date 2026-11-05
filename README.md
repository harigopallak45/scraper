# scraper

Ubuntu worker for the StackandCode Google Maps scraper. It installs as a service that starts at boot, restarts itself
after a crash, and shares one work list with the other scraper computers, so no two of them repeat a search.

The worker holds only a **token** (one per computer, switched off from the owner's side at any time). It has no database
password and nothing secret is stored in this repository.

## Install (Ubuntu 22.04 / 24.04, run as root)

```bash
apt-get update && apt-get install -y git
git clone https://github.com/harigopallak45/scraper.git
cd scraper
bash install-ubuntu.sh --token scr_PASTE_THE_TOKEN --name ubuntu-vm
```

Optional: `--countries "Australia,New Zealand"` (default: all), `--swap-gb 3`, `--url https://client.truewilly.com`.

It installs Node.js 22, the Playwright browser and its system libraries (about 300 MB), a swap file only if the machine
is small and has too little swap, and the `stackandcode-scraper` service.

## Day to day

```bash
journalctl -u stackandcode-scraper -f        # watch it
sudo systemctl stop stackandcode-scraper     # finish the businesses in progress, then stop
sudo systemctl start stackandcode-scraper
sudo nano /opt/stackandcode-scraper/settings.txt && sudo systemctl restart stackandcode-scraper   # token, countries, WORKERS
```

Update to the latest version: `cd scraper && git pull && sudo bash install-ubuntu.sh --token <same token> --name <same name>`.

## Sizing

Browsers run headless. About 600 MB of RAM per browser plus 1.8 GB for the system: 4 GB runs 2 to 3 browsers, 8 GB about 10.
Set `WORKERS=n` in `settings.txt` to choose. On 2 vCPUs the scraper holds browsers back when the CPU is full, which is normal.
It backs off by itself if Google shows a captcha.

## Files

| File | What |
|---|---|
| `install-ubuntu.sh` | one-step installer (needs root) |
| `stackandcode-scraper.service` | systemd unit |
| `app/run.js` | supervisor: reads `settings.txt`, installs the browser, restarts the scraper |
| `app/worldwide.js` | the scraper (one bundled file) |
| `app/settings.template.txt` | the settings the installer writes |
