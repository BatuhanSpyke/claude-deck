const { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard, nativeTheme } = require('electron');
nativeTheme.themeSource = 'dark';
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');
const { scan } = require('./sessions');
const updater = require('./updater');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

let win;
const ptys = new Map();       // ptyId -> { proc, paneKey }
let nextPty = 1;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 700, minHeight: 400,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1d1d22', symbolColor: '#9a978f', height: 40 } }),
    icon: IS_MAC ? undefined : path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#16161a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => { const st = updater.status(); if (st) win.webContents.send('update', st); });
  // Dropping a file must never navigate the window away from the app
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

// ---------- sessions ----------
function ownedPids() {
  const m = new Map();
  for (const { proc, paneKey } of ptys.values()) m.set(proc.pid, paneKey);
  return m;
}
ipcMain.handle('sessions', () => scan(ownedPids()));

// ---------- pty ----------
// node-pty starts shells through its spawn-helper binary. Zips and CI checkouts can drop its executable bit,
// and then every terminal fails with "posix_spawnp failed", so make sure it's executable.
function fixSpawnHelper() {
  if (IS_WIN) return;
  const fs = require('fs');
  const root = path.join(__dirname, 'node_modules', 'node-pty').replace('app.asar', 'app.asar.unpacked');
  for (const dir of [path.join(root, 'build', 'Release'), path.join(root, 'prebuilds', `${process.platform}-${process.arch}`)]) {
    const f = path.join(dir, 'spawn-helper');
    try { if (!(fs.statSync(f).mode & 0o111)) fs.chmodSync(f, 0o755); } catch {}
  }
}
fixSpawnHelper();
// The window can be gone while a shell is still exiting (e.g. while quitting); a throw here aborts the app
const toWin = (...a) => { try { if (win && !win.isDestroyed()) win.webContents.send(...a); } catch {} };
// Windows: prefer PowerShell 7, fall back to the built-in Windows PowerShell
function winShell() {
  const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  try { require('fs').accessSync(pwsh); return pwsh; } catch { return 'powershell.exe'; }
}
function shellCommand(cmd) {
  if (IS_WIN) {
    // -NoExit: when claude exits you're left in a shell in the same folder
    return { file: winShell(), args: cmd ? ['-NoLogo', '-NoExit', '-Command', cmd] : ['-NoLogo'] };
  }
  const sh = process.env.SHELL || '/bin/zsh';
  // Login+interactive shell so PATH (nvm, ~/.local/bin, …) matches your normal terminal.
  // When claude exits you're dropped into a shell in the same folder.
  return { file: sh, args: ['-l', '-i', '-c', cmd ? `${cmd}; exec ${sh} -l -i` : `exec ${sh} -l -i`] };
}

ipcMain.handle('pty:create', (_e, { cwd, cmd, cols, rows, paneKey }) => {
  const { file, args } = shellCommand(cmd);
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ClaudeDeck' };
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  // Don't leak Claude Code's own child-session env if Deck was started from inside a claude session
  for (const k of Object.keys(env)) if ((k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR') || k.startsWith('ELECTRON_')) delete env[k];
  let dir = cwd;
  try { require('fs').accessSync(dir); } catch { dir = os.homedir(); }
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: dir, env });
  const id = nextPty++;
  ptys.set(id, { proc, paneKey });
  proc.onData((d) => toWin('pty:data', id, d));
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    toWin('pty:exit', id, exitCode);
  });
  return { id, pid: proc.pid };
});
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.proc.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => { try { ptys.get(id)?.proc.resize(cols, rows); } catch {} });
ipcMain.on('pty:kill', (_e, id) => { try { ptys.get(id)?.proc.kill(); } catch {} });

// ---------- dialogs / misc ----------
ipcMain.handle('pickFolder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('askRunningElsewhere', async (_e, s) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: `“${s.title}” is already running in another terminal`,
    detail: `Running in ${s.live.tty || 'another app'} (pid ${s.live.pid}). Opening the same session twice makes them overwrite each other, so pick one:`,
    // Jumping to another terminal's tab only works with iTerm2 / Terminal on macOS
    buttons: IS_MAC ? ['Open a Fork Here', 'Switch to That Terminal', 'Cancel'] : ['Open a Fork Here', 'Cancel'],
    defaultId: 0, cancelId: IS_MAC ? 2 : 1,
  });
  return (IS_MAC ? ['fork', 'focus', 'cancel'] : ['fork', 'cancel'])[r.response];
});

ipcMain.handle('confirmClose', async (_e, msg) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', message: msg, buttons: ['Close', 'Cancel'], defaultId: 0, cancelId: 1 });
  return r.response === 0;
});

ipcMain.handle('focusExternal', (_e, tty) => new Promise((resolve) => {
  if (!IS_MAC) return resolve(false);
  const script = `
on run argv
  set t to item 1 of argv
  if application "iTerm2" is running then
    tell application "iTerm2"
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in sessions of tb
            if tty of s is t then
              select w
              tell tb to select
              tell s to select
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
  end if
  if application "Terminal" is running then
    tell application "Terminal"
      repeat with w in windows
        repeat with tb in tabs of w
          if tty of tb is t then
            set selected of tb to true
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end tell
  end if
  return "no"
end run`;
  execFile('/usr/bin/osascript', ['-e', script, tty], (err, out) => resolve(!err && out.trim() === 'ok'));
}));

// Native context menu: items = [{id,label}|{type:'separator'}], resolves to chosen id or null
ipcMain.handle('menu', (_e, items) => new Promise((resolve) => {
  const m = Menu.buildFromTemplate(items.map((it) => it.type === 'separator' ? it : { label: it.label, click: () => resolve(it.id) }));
  m.popup({ window: win, callback: () => setTimeout(() => resolve(null), 100) });
}));

ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('copy', (_e, text) => clipboard.writeText(text));

// ---------- settings / updates ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { autoUpdate: null };   // null = not chosen yet: ask when a release comes out
function loadSettings() { try { Object.assign(settings, JSON.parse(require('fs').readFileSync(settingsFile(), 'utf8'))); } catch {} }
function saveSettings() { try { require('fs').writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {} }

function setSetting(k, v) {
  settings[k] = v; saveSettings(); buildMenu();
  if (win) win.webContents.send('settings', settings);
  if (k === 'autoUpdate' && v) updater.download();   // turned on while a release is waiting
}
ipcMain.handle('settings:get', () => ({ ...settings, version: app.getVersion(), canUpdate: updater.supported(), packaged: app.isPackaged }));
ipcMain.on('settings:set', (_e, k, v) => setSetting(k, v));
ipcMain.handle('update:check', () => updater.check({ manual: true, autoInstall: !!settings.autoUpdate }));
ipcMain.on('update:download', () => updater.download());
ipcMain.on('openReleases', () => shell.openExternal('https://github.com/BatuhanSpyke/claude-deck/releases/latest'));

async function checkForUpdates() {
  const r = await updater.check({ manual: true, autoInstall: !!settings.autoUpdate });
  if (r.state === 'available') return;   // the app shows its own "new release" card
  const msg = {
    latest: [`You're up to date`, `Claude Deck ${app.getVersion()} is the latest version.`],
    ready: [`Claude Deck ${r.version} is ready`, 'Restart to install it. Your tabs reopen and sessions resume where they were.'],
    busy: ['Already checking for updates…', ''],
    unsupported: [`Can't update this copy automatically`, app.isPackaged
      ? 'Move Claude Deck into your Applications folder (or a folder you can write to) and open it from there.'
      : 'Updates only work in the packaged app, not when running from source.'],
    error: [`Couldn't check for updates`, r.message || ''],
  }[r.state];
  const buttons = r.state === 'ready' ? ['Restart Now', 'Later'] : ['OK'];
  const { response } = await dialog.showMessageBox(win, { type: r.state === 'error' ? 'warning' : 'info', message: msg[0], detail: msg[1], buttons, defaultId: 0, cancelId: buttons.length - 1 });
  if (r.state === 'ready' && response === 0) restartToUpdate();
}
function restartToUpdate() { if (updater.apply(true)) app.quit(); }
ipcMain.on('update:restart', () => restartToUpdate());

// ---------- menu ----------
function send(cmd, ...a) { win && win.webContents.send('cmd', cmd, ...a); }
// Shortcuts: ⌘ on macOS. On Windows plain Ctrl+letter belongs to the terminal (Ctrl+C, Ctrl+D, Ctrl+W…),
// so app shortcuts use Ctrl+Shift, like Windows Terminal. Keep in sync with KEYS in renderer.js.
const K = IS_MAC ? {
  newSession: 'Cmd+N', newTab: 'Cmd+T', saveGroup: 'Cmd+Shift+S', rename: 'Cmd+Shift+R',
  splitH: 'Cmd+D', splitV: 'Cmd+Shift+D', closePane: 'Cmd+W', closeTab: 'Cmd+Shift+W',
  sidebar: 'Cmd+B', find: 'Cmd+P', nextTab: 'Cmd+Shift+]', prevTab: 'Cmd+Shift+[',
  nextPane: 'Cmd+]', prevPane: 'Cmd+[', zoom: 'Cmd+Shift+Enter', tab: 'Cmd+', shortcuts: 'Cmd+/',
} : {
  newSession: 'Ctrl+Shift+N', newTab: 'Ctrl+Shift+T', saveGroup: 'Ctrl+Shift+S', rename: 'Ctrl+Shift+R',
  splitH: 'Ctrl+Shift+D', splitV: 'Ctrl+Shift+E', closePane: 'Ctrl+Shift+W', closeTab: 'Ctrl+Shift+Q',
  sidebar: 'Ctrl+Shift+B', find: 'Ctrl+Shift+P', nextTab: 'Ctrl+Tab', prevTab: 'Ctrl+Shift+Tab',
  nextPane: 'Ctrl+Shift+]', prevPane: 'Ctrl+Shift+[', zoom: 'Ctrl+Shift+Enter', tab: 'Ctrl+', shortcuts: 'Ctrl+Shift+/',
};
function buildMenu() {
  const tabs = Array.from({ length: 9 }, (_, i) => ({ label: `Tab ${i + 1}`, accelerator: `${K.tab}${i + 1}`, click: () => send('tab', i), visible: false }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
    { label: 'Shell', submenu: [
      { label: 'New Claude Session…', accelerator: K.newSession, click: () => send('newSession') },
      { label: 'New Tab', accelerator: K.newTab, click: () => send('newTab') },
      { label: 'Save Tab as Group…', accelerator: K.saveGroup, click: () => send('saveGroup') },
      { label: 'Rename Session…', accelerator: K.rename, click: () => send('renameSession') },
      { type: 'separator' },
      { label: 'Split Right', accelerator: K.splitH, click: () => send('split', 'h') },
      { label: 'Split Down', accelerator: K.splitV, click: () => send('split', 'v') },
      { type: 'separator' },
      { label: 'Close Pane', accelerator: K.closePane, click: () => send('closePane') },
      { label: 'Close Tab', accelerator: K.closeTab, click: () => send('closeTab') },
    ] },
    // Windows: Ctrl+C / Ctrl+V stay with the terminal (renderer copies a selection on Ctrl+C itself)
    IS_MAC ? { role: 'editMenu' } : { label: 'Edit', submenu: [
      { label: 'Copy', accelerator: 'Ctrl+Shift+C', click: () => send('copy') },
      { label: 'Paste', accelerator: 'Ctrl+Shift+V', role: 'paste' },
      { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { label: 'Toggle Sidebar', accelerator: K.sidebar, click: () => send('toggleSidebar') },
      { label: 'Find Session', accelerator: K.find, click: () => send('findSession') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: K.nextTab, click: () => send('tabStep', 1) },
      { label: 'Previous Tab', accelerator: K.prevTab, click: () => send('tabStep', -1) },
      { label: 'Next Pane', accelerator: K.nextPane, click: () => send('paneStep', 1) },
      { label: 'Previous Pane', accelerator: K.prevPane, click: () => send('paneStep', -1) },
      { label: 'Maximize Pane', accelerator: K.zoom, click: () => send('zoomPane') },
      ...tabs,
      { type: 'separator' },
      { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: () => send('font', 1) },
      { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: () => send('font', -1) },
      { label: 'Reset Text Size', accelerator: 'CmdOrCtrl+0', click: () => send('font', 0) },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Keyboard Shortcuts', accelerator: K.shortcuts, click: () => send('shortcuts') },
      { type: 'separator' },
      { label: 'Check for Updates…', click: () => checkForUpdates() },
      { label: 'Install Updates Automatically', type: 'checkbox', checked: !!settings.autoUpdate, click: (it) => setSetting('autoUpdate', it.checked) },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      { label: `Version ${app.getVersion()}`, enabled: false },
    ] },
  ]));
}

app.setName('Claude Deck');
// For testing a second copy without touching your real layout/groups
if (process.env.DECK_USERDATA) app.setPath('userData', process.env.DECK_USERDATA);
app.whenReady().then(() => {
  loadSettings(); buildMenu(); createWindow();
  updater.start((info) => toWin('update', info), () => !!settings.autoUpdate);
});
app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => app.quit());
// Quit only after every shell has exited. If node-pty reports an exit while Node is already being torn
// down, it calls into JS that no longer exists and the app aborts ("quit unexpectedly").
let quitting = false;
app.on('before-quit', (e) => {
  if (!quitting) updater.apply(false);   // downloaded (auto, or you said Install) but not restarted yet: install on the way out
  if (!ptys.size) return;
  e.preventDefault();
  if (quitting) return;
  quitting = true;
  for (const { proc } of ptys.values()) { try { proc.kill(); } catch {} }
  const t0 = Date.now();
  let forced = false;
  const wait = setInterval(() => {
    if (!forced && Date.now() - t0 > 1500) {   // something ignored SIGHUP
      forced = true;
      for (const { proc } of ptys.values()) { try { proc.kill('SIGKILL'); } catch {} }
    }
    if (ptys.size && Date.now() - t0 < 4000) return;
    clearInterval(wait);
    ptys.clear();
    setTimeout(() => app.quit(), 150);   // let the last exit callbacks run first
  }, 50);
});
