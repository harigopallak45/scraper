// StackandCode Maps scraper: supervisor that runs on a worker computer (Windows exe or Ubuntu).
// Reads settings.txt, installs the browser on first start, then keeps the scraper running: it restarts it after a crash
// or a planned browser recycle, and stops when data/STOP exists or the shared list is empty.
// Plain JavaScript on purpose: it is shipped as-is next to a portable Node.js, nothing to compile.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP = __dirname;
const ROOT = process.env.SCRAPER_HOME ? path.resolve(process.env.SCRAPER_HOME) : path.resolve(APP, '..');
const DATA = path.join(ROOT, 'data');
const STOP = path.join(DATA, 'STOP');
const BROWSERS = path.join(ROOT, 'browsers');
fs.mkdirSync(DATA, { recursive: true });

const say = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

// ---- settings.txt: KEY=VALUE per line, # for comments
function readSettings() {
  const file = path.join(ROOT, 'settings.txt');
  const out = {};
  if (!fs.existsSync(file)) return { file, out, missing: true };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return { file, out, missing: false };
}

const { file: settingsFile, out: settings, missing } = readSettings();
if (missing) {
  const tpl = path.join(APP, 'settings.template.txt');
  if (fs.existsSync(tpl)) fs.copyFileSync(tpl, settingsFile);
  say(`Created ${settingsFile}. Open it, paste the token you were given, save it, and start this program again.`);
  process.exit(3);
}
if (!settings.SCRAPER_TOKEN || /PASTE/i.test(settings.SCRAPER_TOKEN) || !settings.SCRAPER_API_URL) {
  say(`Open ${settingsFile} and fill in SCRAPER_API_URL and SCRAPER_TOKEN (the token you were given), then start again.`);
  process.exit(3);
}

const totalMb = Math.round(os.totalmem() / 1048576);
// About 600 MB per browser window plus ~1.8 GB for the system: 4 GB -> 3 browsers, 8 GB -> 10.
const autoWorkers = Math.min(10, Math.max(1, Math.floor((totalMb - 1800) / 600)));
const workers = Math.max(1, parseInt(settings.WORKERS || '', 10) || autoWorkers);
const machine = settings.MACHINE_NAME || os.hostname();

const env = {
  ...process.env,
  SCRAPER_API_URL: settings.SCRAPER_API_URL,
  SCRAPER_TOKEN: settings.SCRAPER_TOKEN,
  SCRAPER_MACHINE_NAME: machine,
  PC_DATA_DIR: DATA,
  LOG_DIR: path.join(DATA, 'logs'),
  PLAYWRIGHT_BROWSERS_PATH: BROWSERS,
  PC_PACE: settings.PACE || '0.85',
};
delete env.DATABASE_URL; // a worker computer never talks to the database directly
if (os.platform() === 'linux') {
  env.PC_RAM_RESERVE_MB = settings.RAM_RESERVE_MB || '500'; // dedicated machine: the system needs little
  // Servers have no screen or GPU: drawing visible windows is ~30x slower (measured on a 2-vCPU server: 160 s vs 5 s per business).
  env.PC_HEADLESS = '1';
}
if (os.platform() !== 'linux' && settings.HEADLESS) env.PC_HEADLESS = settings.HEADLESS === '1' || /^true$/i.test(settings.HEADLESS) ? '1' : '0';

// ---- first start: download the browser (about 150 MB, once)
function hasBrowser() {
  const dirs = [BROWSERS];
  // a Chromium that Playwright already installed on this Windows computer is used as well (the scraper finds it itself)
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  return dirs.some((dir) => { try { return fs.readdirSync(dir).some((d) => /^chromium-\d+$/.test(d)); } catch { return false; } });
}
if (!hasBrowser()) {
  say('First start: downloading the Chromium browser (about 150 MB, only once). Please wait...');
  const cli = path.join(APP, 'node_modules', 'playwright-core', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { env, stdio: 'inherit' });
  if (r.status !== 0 || !hasBrowser()) {
    say('The browser could not be downloaded. Check the internet connection and start again.');
    process.exit(4);
  }
  say('Browser installed.');
}

// ---- keep the scraper running
try { fs.unlinkSync(STOP); } catch { /* none */ }
let child = null;
let stopping = false;
const stopRequested = () => stopping || fs.existsSync(STOP);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    say('Stopping: finishing the businesses in progress (their data is already saved). This takes up to a minute...');
    // The scraper checks for this file, which works the same on Windows and Linux (signals are not graceful on Windows).
    try { fs.writeFileSync(STOP, 'stop\n'); } catch { /* ignore */ }
    setTimeout(() => { if (child) child.kill(); }, 120000).unref(); // last resort
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runChild = (args) => new Promise((resolve) => {
  child = spawn(process.execPath, args, { env, stdio: 'inherit', cwd: ROOT });
  child.on('exit', (c) => { child = null; resolve(c === null ? 1 : c); });
  child.on('error', () => { child = null; resolve(1); });
});
(async () => {
  say(`StackandCode scraper on "${machine}": ${workers} browsers (this computer has ${totalMb} MB RAM). Server: ${settings.SCRAPER_API_URL}`);
  say(`To stop: press Ctrl+C, or create the file ${STOP}`);
  let restarts = 0;
  while (!stopRequested()) {
    const args = [path.join(APP, 'worldwide.js'), '--hours', '0', '--workers', String(workers), '--limit', '40', '--recycle-minutes', '75'];
    if (settings.COUNTRIES) args.push('--countries', settings.COUNTRIES);
    const code = await runChild(args);
    if (stopRequested()) break;
    if (code === 5) { say('Nothing left to search: every search on the shared list is finished. Stopping.'); break; }
    if (code === 6) {
      // The app owner pressed Stop. Stay here and run the tiny --idle program, which keeps reporting "stopped" and exits
      // (code 4) as soon as the app says Start, then the scraper below starts again.
      say('Stopped from the app. Waiting for Start (this computer stays connected).');
      while (!stopRequested()) {
        const c = await runChild([path.join(APP, 'worldwide.js'), '--idle']);
        if (c === 4 || stopRequested()) break;
        await sleep(60000);
      }
      continue;
    }
    restarts++;
    say(`The scraper exited (code ${code}); restart #${restarts}.`);
    // 4 = planned browser recycle or Restart from the app: straight back; 2 = server unreachable or token refused; 6 = Stop from the app (handled above); anything else = crash
    await sleep(code === 4 ? 5000 : 60000);
  }
  say('Stopped.');
  process.exit(0);
})();
