/* Self-updater: checks GitHub Releases, downloads the zip for this platform in the background,
   and swaps the app in place when you restart (or quit). Electron's built-in autoUpdater needs an
   Apple Developer ID-signed app, which we don't have, so this does it by hand. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'BatuhanSpyke/claude-deck';
const ASSET = process.platform === 'darwin' ? 'Claude-Deck-mac-arm64.zip' : 'Claude-Deck-windows-x64.zip';
const CHECK_EVERY = 4 * 60 * 60 * 1000;

let ready = null;      // { version, src } once downloaded + extracted
let busy = false;
let notify = () => {};

const newer = (a, b) => {   // is version a newer than b
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// Where the installed app lives, or null if we can't replace it ourselves
function target() {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') {
    const bundle = path.resolve(process.execPath, '../../..');
    // Opened straight from Downloads with quarantine on: macOS runs it from a read-only copy
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) return null;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch { return null; }
    return bundle;
  }
  if (process.platform === 'win32') {
    const dir = path.dirname(process.execPath);
    if (!fs.existsSync(path.join(dir, 'Claude Deck.exe'))) return null;
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { return null; }
    return dir;
  }
  return null;
}

const run = (file, args) => new Promise((res, rej) => execFile(file, args, (e) => e ? rej(e) : res()));

// Look for a newer release. With autoInstall it downloads straight away; otherwise it just reports
// 'available' and waits for download() (you said yes in the app).
let available = null;   // { version, url }
async function check({ manual = false, autoInstall = false } = {}) {
  if (busy) return { state: 'busy' };
  if (ready) return { state: 'ready', version: ready.version };
  if (!target()) return { state: 'unsupported' };
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || !newer(version, app.getVersion())) return { state: 'latest', version: app.getVersion() };
    const asset = (rel.assets || []).find((a) => a.name === ASSET);
    if (!asset) throw new Error(`${ASSET} is missing from release ${rel.tag_name}`);
    available = { version, url: asset.browser_download_url, notes: rel.html_url };
  } catch (e) {
    return manual ? { state: 'error', message: e.message } : { state: 'error' };
  }
  if (autoInstall) return download({ manual });
  notify({ state: 'available', version: available.version, notes: available.notes });
  return { state: 'available', version: available.version };
}

async function download({ manual = false } = {}) {
  if (ready) return { state: 'ready', version: ready.version };
  if (!available || busy) return { state: busy ? 'busy' : 'latest' };
  busy = true;
  const { version, url } = available;
  try {
    notify({ state: 'downloading', version });
    const dir = path.join(app.getPath('userData'), 'update');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, ASSET);
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`Download failed (${dl.status})`);
    fs.writeFileSync(zip, Buffer.from(await dl.arrayBuffer()));

    const out = path.join(dir, 'new');
    let src;
    if (process.platform === 'darwin') {
      await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
      src = path.join(out, 'Claude Deck.app');
    } else {
      await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`]);
      src = path.join(out, 'Claude Deck-win32-x64');
    }
    if (!fs.existsSync(src)) throw new Error('The downloaded update looks broken');
    fs.rmSync(zip, { force: true });
    ready = { version, src };
    notify({ state: 'ready', version });
    return { state: 'ready', version };
  } catch (e) {
    notify({ state: 'available', version, error: e.message });
    return manual ? { state: 'error', message: e.message } : { state: 'error' };
  } finally {
    busy = false;
  }
}

// Swap the new build in after this process exits (a running app can't replace itself)
function apply(relaunch) {
  if (!ready) return false;
  const dest = target(); if (!dest) return false;
  const pid = String(process.pid);
  if (process.platform === 'darwin') {
    const script = `
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
rm -rf "$3" && mv "$2" "$3"
xattr -dr com.apple.quarantine "$3" 2>/dev/null
touch "$3"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$3" 2>/dev/null
[ "$4" = 1 ] && open "$3"
exit 0`;
    spawn('/bin/sh', ['-c', script, 'updater', pid, ready.src, dest, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const ps = `
param($procId, $src, $dest, $relaunch)
while (Get-Process -Id $procId -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
Start-Sleep -Milliseconds 500
robocopy $src $dest /MIR /R:5 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($relaunch -eq '1') { Start-Process (Join-Path $dest 'Claude Deck.exe') }`;
    const file = path.join(app.getPath('userData'), 'update', 'apply.ps1');
    fs.writeFileSync(file, ps);
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file, pid, ready.src, dest, relaunch ? '1' : '0'],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  ready = null;
  return true;
}

function start(onChange, autoInstall) {
  notify = onChange;
  const tick = () => check({ autoInstall: autoInstall() });
  setTimeout(tick, 15 * 1000);
  setInterval(tick, CHECK_EVERY);
}

module.exports = { start, check, download, apply, status: () => ready ? { state: 'ready', version: ready.version } : available ? { state: 'available', version: available.version, notes: available.notes } : null, supported: () => !!target(), pending: () => ready && ready.version };
