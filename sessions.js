// Reads Claude Code sessions from ~/.claude (transcripts + live session registry).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const IS_WIN = process.platform === 'win32';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const LIVE = path.join(HOME, '.claude', 'sessions');

const PREFIXES = [
  ['ai', '{"type":"ai-title"'],
  ['custom', '{"type":"custom-title"'],
  ['last', '{"type":"last-prompt"'],
  ['msg', '{"parentUuid"'],
];

// path -> { offset, title, customTitle, lastPrompt, cwd, branch }
const cache = new Map();

function scanFile(file, size, st) {
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 4 << 20;
    let pos = st.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        if (nl === -1) break;
        handleLine(data, start, nl, st);
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    st.offset = pos - carry.length; // leave a partial last line for next time
  } finally {
    fs.closeSync(fd);
  }
}

function handleLine(buf, s, e, st) {
  for (const [kind, p] of PREFIXES) {
    if (kind === 'msg' && st.cwd) continue;
    if (e - s < p.length || buf.toString('utf8', s, s + p.length) !== p) continue;
    try {
      const o = JSON.parse(buf.toString('utf8', s, e));
      if (kind === 'ai') st.title = o.aiTitle || st.title;
      else if (kind === 'custom') st.customTitle = o.customTitle || st.customTitle;
      else if (kind === 'last') st.lastPrompt = o.lastPrompt || st.lastPrompt;
      else { st.cwd = o.cwd || ''; st.branch = o.gitBranch || ''; }
    } catch {}
    return;
  }
}

// Windows has no ps; asking WMI takes ~0.5s, so refresh it in the background and use the last result
let winProcs = new Map(), winBusy = false;
function refreshWinProcs() {
  if (winBusy) return;
  winBusy = true;
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 16 << 20 }, (err, out) => {
    winBusy = false;
    if (err) return;
    const t = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) t.set(+m[1], { ppid: +m[2], tty: '', comm: m[3] });
    }
    winProcs = t;
  });
}

function processTable() {
  if (IS_WIN) { refreshWinProcs(); return winProcs; }
  // pid -> { ppid, tty, comm }
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8' });
  const t = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) t.set(+m[1], { ppid: +m[2], tty: m[3], comm: m[4] });
  }
  return t;
}

// ownedPids: Map<shellPid, paneKey> for ptys this app spawned
function scan(ownedPids = new Map()) {
  const sessions = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch {}
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      let st = cache.get(file) || { offset: 0, title: '', customTitle: '', lastPrompt: '', cwd: '', branch: '' };
      if (stat.size < st.offset) st = { offset: 0, title: '', customTitle: '', lastPrompt: '', cwd: '', branch: '' };
      if (stat.size > st.offset) { try { scanFile(file, stat.size, st); } catch {} }
      cache.set(file, st);
      const title = st.customTitle || st.title || st.lastPrompt;
      if (!title) continue;
      const id = f.slice(0, -6);
      sessions.set(id, {
        id, title, lastPrompt: st.lastPrompt, cwd: st.cwd, branch: st.branch,
        modified: stat.mtimeMs, transcript: file, live: null,
      });
    }
  }

  // Live sessions
  let liveFiles = [];
  try { liveFiles = fs.readdirSync(LIVE).filter((f) => f.endsWith('.json')); } catch {}
  if (liveFiles.length) {
    let procs = new Map();
    try { procs = processTable(); } catch {}
    for (const f of liveFiles) {
      let o;
      try { o = JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8')); } catch { continue; }
      const p = procs.get(o.pid);
      // claude.exe (native install) or node.exe (npm install) on Windows
      if (!p || !(IS_WIN ? /^(claude|node)\.exe$/i : /claude$/).test(p.comm)) continue;
      // Is this claude process a descendant of one of our ptys?
      let pane = null;
      for (let cur = o.pid, i = 0; cur > 1 && i < 30; i++) {
        if (ownedPids.has(cur)) { pane = ownedPids.get(cur); break; }
        const q = procs.get(cur);
        if (!q) break;
        cur = q.ppid;
      }
      const live = { pid: o.pid, tty: !p.tty || p.tty === '??' ? '' : '/dev/' + p.tty, status: o.status || '', pane };
      const s = sessions.get(o.sessionId);
      if (s) s.live = live;
      else sessions.set(o.sessionId, {
        id: o.sessionId, title: o.name || 'New session', lastPrompt: '', cwd: o.cwd || '', branch: '',
        modified: o.updatedAt || Date.now(), transcript: null, live,
      });
    }
  }
  return [...sessions.values()].sort((a, b) => b.modified - a.modified);
}

module.exports = { scan };
