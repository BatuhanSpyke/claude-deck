/* Fun stats, computed in a worker thread so terminals never stutter.
   Reads Claude Code's local session logs (~/.claude/projects/<project>/<session>.jsonl) and keeps only
   counts: no prompt or reply text is stored or shown. Logs only ever grow, so each file's byte offset
   is cached and later runs read just the new part. */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(workerData.home, '.claude', 'projects');
const CACHE = workerData.cacheFile;
// Bumping VERSION throws the cache away. Claude Code deletes old session files (cleanupPeriodDays, 30 days by
// default) and the counts of deleted sessions live only in this cache, so bump it only when you must.
const VERSION = 4;

// Public API list prices, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-16):
// [input, 5m cache write, 1h cache write, cache read, output]. Only for an "if this were billed per token" estimate;
// subscription plans aren't billed this way. Unknown models are left out of the estimate.
const PRICES = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50], 'claude-mythos-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50], 'claude-mythos-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20], 'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25], 'claude-opus-4-7': [5, 6.25, 10, 0.5, 25], 'claude-opus-4-6': [5, 6.25, 10, 0.5, 25],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10], 'claude-sonnet-5': [2, 2.5, 4, 0.2, 10], 'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5], 'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
};
const HAIKU_55_LONG = [0.5, 0.625, 1, 0.05, 2.5];   // prompts over 100k tokens
function priceOf(model, u) {
  const id = (model || '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  let p = PRICES[id]; if (!p) return null;
  const i = u.input_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0, o = u.output_tokens || 0;
  if (id === 'claude-haiku-5-5' && i + cw + cr > 100000) p = HAIKU_55_LONG;
  const c = u.cache_creation || {};
  const w1h = c.ephemeral_1h_input_tokens ?? 0, w5m = c.ephemeral_5m_input_tokens ?? (cw - w1h);
  const usd = (i * p[0] + w5m * p[1] + w1h * p[2] + cr * p[3] + o * p[4]) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd;   // fast mode is billed at 2x
}

// Per-file running totals. Everything is additive, so new lines just add on.
const blank = () => ({
  offset: 0, size: 0, cwd: '', first: 0, last: 0,
  prompts: 0, replies: 0, tools: {}, models: {}, out: 0, inTok: 0, cacheWrite: 0, cacheRead: 0,
  modelTok: {},                         // model -> all tokens
  usd: 0, modelUsd: {}, usdDays: {}, unpriced: 0,   // API-price estimate
  hours: Array(24).fill(0), days: {},   // days: 'YYYY-MM-DD' -> prompts
  tokDays: {},                          // 'YYYY-MM-DD' -> all tokens
  lastMsg: '',
});

function load() {
  try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.v === VERSION) return c.files; } catch {}
  return {};
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function addLine(f, line) {
  // Cheap checks first: most lines (attachments, snapshots, tool output) are skipped without parsing
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
  if (line.includes('"tool_result"') && !line.includes('"type":"assistant"')) return;   // tool output, often huge
  let d; try { d = JSON.parse(line); } catch { return; }
  if (d.type !== 'user' && d.type !== 'assistant') return;
  if (d.isSidechain || d.isMeta || d.isCompactSummary) return;
  const t = d.timestamp ? Date.parse(d.timestamp) : 0;
  if (t) { if (!f.first || t < f.first) f.first = t; if (t > f.last) f.last = t; }
  if (!f.cwd && d.cwd) f.cwd = d.cwd;
  const m = d.message; if (!m) return;
  if (d.type === 'user') {
    // a prompt you typed, not a tool result
    if (Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')) return;
    f.prompts++;
    if (t) { const dt = new Date(t); f.hours[dt.getHours()]++; const k = localDay(dt); f.days[k] = (f.days[k] || 0) + 1; }
    return;
  }
  for (const c of m.content || []) if (c.type === 'tool_use' && c.name) f.tools[c.name] = (f.tools[c.name] || 0) + 1;
  // one reply is written as several lines (one per content block) sharing the same message id and usage
  if (m.id && m.id === f.lastMsg) return;
  f.lastMsg = m.id || '';
  f.replies++;
  if (m.model && !m.model.startsWith('<')) f.models[m.model] = (f.models[m.model] || 0) + 1;
  const u = m.usage || {};
  const o = u.output_tokens || 0, i = u.input_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  f.out += o; f.inTok += i; f.cacheWrite += cw; f.cacheRead += cr;
  const all = o + i + cw + cr;
  if (m.model && !m.model.startsWith('<')) f.modelTok[m.model] = (f.modelTok[m.model] || 0) + all;
  if (t) { const k = localDay(new Date(t)); f.tokDays[k] = (f.tokDays[k] || 0) + all; }
  const usd = priceOf(m.model, u);
  if (usd == null) { f.unpriced += all; return; }
  f.usd += usd;
  f.modelUsd[m.model] = (f.modelUsd[m.model] || 0) + usd;
  if (t) { const k = localDay(new Date(t)); f.usdDays[k] = (f.usdDays[k] || 0) + usd; }
}

// Read from `start` to the end in chunks; only complete lines count (a half-written last line waits)
function readFrom(file, f, start) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let pos = start, rest = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const text = rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      rest = lines.pop();
      for (const l of lines) if (l) addLine(f, l);
    }
    f.offset = pos - Buffer.byteLength(rest);
  } finally { fs.closeSync(fd); }
}

function run() {
  const cache = load(), files = {};
  let scanned = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch {}
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const file = path.join(ROOT, dir, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      let f = cache[file];
      if (!f || st.size < f.offset) f = blank();   // new, or rewritten: start over
      if (st.size > f.offset) { scanned += st.size - f.offset; readFrom(file, f, f.offset); }
      f.size = st.size;
      files[file] = f;
    }
  }
  // Sessions Claude Code has since cleaned up: keep their counts so all-time stats don't shrink
  for (const [file, f] of Object.entries(cache)) if (!files[file] && !fs.existsSync(file)) files[file] = { ...f, gone: true };
  try { fs.writeFileSync(CACHE, JSON.stringify({ v: VERSION, files })); } catch {}
  return summarize(files, scanned);
}

function summarize(files, scanned) {
  const s = { sessions: 0, prompts: 0, replies: 0, out: 0, inTok: 0, cacheWrite: 0, cacheRead: 0, tools: {}, models: {}, modelTok: {}, projects: {}, projectTok: {}, tokDays: {}, usd: 0, modelUsd: {}, projectUsd: {}, usdDays: {}, unpriced: 0,
    hours: Array(24).fill(0), weekdays: Array(7).fill(0), days: {}, longest: null, first: 0, scannedBytes: scanned };
  for (const f of Object.values(files)) {
    if (!f.prompts && !f.replies) continue;
    s.sessions++;
    s.prompts += f.prompts; s.replies += f.replies; s.out += f.out; s.inTok += f.inTok; s.cacheWrite += f.cacheWrite; s.cacheRead += f.cacheRead;
    for (const [k, v] of Object.entries(f.modelTok)) s.modelTok[k] = (s.modelTok[k] || 0) + v;
    for (const [k, v] of Object.entries(f.tokDays)) s.tokDays[k] = (s.tokDays[k] || 0) + v;
    s.usd += f.usd || 0; s.unpriced += f.unpriced || 0;
    for (const [k, v] of Object.entries(f.modelUsd || {})) s.modelUsd[k] = (s.modelUsd[k] || 0) + v;
    for (const [k, v] of Object.entries(f.usdDays || {})) s.usdDays[k] = (s.usdDays[k] || 0) + v;
    if (f.usd) s.projectUsd[f.cwd || '?'] = (s.projectUsd[f.cwd || '?'] || 0) + f.usd;
    for (const [k, v] of Object.entries(f.tools)) s.tools[k] = (s.tools[k] || 0) + v;
    for (const [k, v] of Object.entries(f.models)) s.models[k] = (s.models[k] || 0) + v;
    const p = f.cwd || '?';
    s.projects[p] = (s.projects[p] || 0) + f.prompts;
    s.projectTok[p] = (s.projectTok[p] || 0) + f.out + f.inTok + f.cacheWrite + f.cacheRead;
    f.hours.forEach((v, i) => { s.hours[i] += v; });
    for (const [k, v] of Object.entries(f.days)) {
      s.days[k] = (s.days[k] || 0) + v;
      const [y, mo, d] = k.split('-').map(Number);
      s.weekdays[new Date(y, mo - 1, d).getDay()] += v;
    }
    if (f.first && (!s.first || f.first < s.first)) s.first = f.first;
    if (!s.longest || f.prompts > s.longest.prompts) s.longest = { prompts: f.prompts, cwd: f.cwd, ms: f.last - f.first };
  }
  // streaks over days with at least one prompt
  const dayKeys = Object.keys(s.days).sort();
  let best = 0, run = 0, prev = null;
  for (const k of dayKeys) {
    const d = new Date(k + 'T12:00:00');
    run = prev && Math.round((d - prev) / 864e5) === 1 ? run + 1 : 1;
    best = Math.max(best, run); prev = d;
  }
  let current = 0;
  for (let d = new Date(); ; d.setDate(d.getDate() - 1)) {
    if (s.days[localDay(d)]) current++;
    else if (current || localDay(d) !== localDay(new Date())) break;   // today may not have started yet
  }
  s.streak = { best, current };
  s.activeDays = dayKeys.length;
  const busiest = dayKeys.reduce((b, k) => (!b || s.days[k] > s.days[b] ? k : b), null);
  s.busiestDay = busiest ? { day: busiest, prompts: s.days[busiest] } : null;
  s.last30 = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = localDay(d); s.last30.push({ day: k, prompts: s.days[k] || 0, tokens: s.tokDays[k] || 0, usd: s.usdDays[k] || 0 }); }
  s.usd30 = s.last30.reduce((a, d) => a + d.usd, 0);
  delete s.usdDays;
  const tk = Object.keys(s.tokDays);
  const bigTok = tk.reduce((b, k) => (!b || s.tokDays[k] > s.tokDays[b] ? k : b), null);
  s.biggestTokDay = bigTok ? { day: bigTok, tokens: s.tokDays[bigTok] } : null;
  delete s.tokDays;
  delete s.days;
  return s;
}

try { parentPort.postMessage({ ok: true, stats: run() }); }
catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
