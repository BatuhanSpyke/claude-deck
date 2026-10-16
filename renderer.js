/* Claude Deck renderer: sidebar of sessions + tabs of split terminal panes. */
const D = window.deck;
const IS_MAC = D.platform === 'darwin';
// Shortcut labels are written Mac-style; on Windows show the Ctrl+Shift equivalents (see K in main.js)
const WIN_KEYS = { '⌘N': 'Ctrl+Shift+N', '⌘T': 'Ctrl+Shift+T', '⇧⌘S': 'Ctrl+Shift+S', '⇧⌘R': 'Ctrl+Shift+R', '⌘D': 'Ctrl+Shift+D',
  '⇧⌘D': 'Ctrl+Shift+E', '⌘W': 'Ctrl+Shift+W', '⌘B': 'Ctrl+Shift+B', '⌘P': 'Ctrl+Shift+P', '⇧⌘↵': 'Ctrl+Shift+Enter', '⌘↵': 'Ctrl+Enter', '⌘/': 'Ctrl+Shift+/', '⌘,': 'Ctrl+,' };
const kb = (k) => IS_MAC ? k : WIN_KEYS[k] || k;
const mod = (e) => IS_MAC ? e.metaKey : e.ctrlKey;  // "open in new tab" modifier
const $ = (s) => document.querySelector(s);

// ---------- persistent prefs ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('deck.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('deck.' + k, JSON.stringify(v)); } catch {} },
};

const DEFAULT_FONT = 13;
const state = {
  sessions: [],
  tabs: [],              // { id, root, focus, zoom }
  active: 0,
  filter: 'all',
  project: '',
  query: '',
  sidebar: store.get('sidebar', true),
  sideW: store.get('sideW', 290),
  fontSize: store.get('fontSize', DEFAULT_FONT),
  groups: store.get('groups', []),   // { id, name, layout }
  groupsOpen: store.get('groupsOpen', true),
  names: store.get('names', {}),     // sessionId -> your own name
};
const panes = new Map(); // key -> pane
const byPty = new Map(); // ptyId -> pane
let seq = 1;

const THEME = {
  background: '#16161a', foreground: '#e6e4df', cursor: '#d97757', cursorAccent: '#16161a',
  selectionBackground: '#4a3f3a',
  black: '#1d1d22', red: '#ef6f6c', green: '#7ec699', yellow: '#e8c06a', blue: '#6ea8fe', magenta: '#c49bf0', cyan: '#6fd3d3', white: '#d6d4cf',
  brightBlack: '#66645f', brightRed: '#ff8a87', brightGreen: '#97dcb0', brightYellow: '#f2d38a', brightBlue: '#8dbcff', brightMagenta: '#d6b4ff', brightCyan: '#8de6e6', brightWhite: '#ffffff',
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
const tildify = (p) => (p || '').startsWith(D.home) ? '~' + p.slice(D.home.length) : (p || '');
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
  return new Date(ms).toLocaleDateString();
}
const tab = () => state.tabs[state.active];
const session = (id) => state.sessions.find((s) => s.id === id);

// Esc cancels whatever drag is in progress. Captured before the terminal sees it, and only while dragging.
function escCancels(fn) {
  const h = (e) => { if (e.key !== 'Escape') return; e.preventDefault(); e.stopPropagation(); fn(); };
  addEventListener('keydown', h, true);
  return () => removeEventListener('keydown', h, true);
}

// ---------- layout tree ----------
const leaf = (key) => ({ kind: 'pane', key });
function leaves(n, out = []) { if (!n) return out; if (n.kind === 'pane') out.push(n.key); else { leaves(n.a, out); leaves(n.b, out); } return out; }
function replace(n, key, fn) {
  if (n.kind === 'pane') return n.key === key ? fn(n) : n;
  return { ...n, a: replace(n.a, key, fn), b: replace(n.b, key, fn) };
}
function remove(n, key) {
  if (n.kind === 'pane') return n.key === key ? null : n;
  const a = remove(n.a, key), b = remove(n.b, key);
  if (!a) return b; if (!b) return a;
  return { ...n, a, b };
}
function tabOf(key) { return state.tabs.findIndex((t) => leaves(t.root).includes(key)); }

// ---------- panes ----------
function makePane() {
  const key = 'p' + seq++;
  const el = document.createElement('div');
  el.className = 'pane';
  el.innerHTML = `<div class="pane-head"><span class="dot"></span><span class="ptitle"></span><span class="pdesc"></span><span class="pcwd"></span>
    <button data-a="rename" title="Rename session (${kb('⇧⌘R')})">✎</button>
    <button data-a="h" title="Split right (${kb('⌘D')})">◫</button><button data-a="v" title="Split down (${kb('⇧⌘D')})">⬓</button>
    <button data-a="zoom" title="Maximize (${kb('⇧⌘↵')})">⤢</button><button data-a="close" title="Close pane (${kb('⌘W')})">✕</button></div>
    <div class="pane-body"></div>`;
  const p = { key, el, body: el.querySelector('.pane-body'), term: null, fit: null, ptyId: null, sessionId: null, cwd: '', title: '', status: '', attn: false, missing: null };
  el.addEventListener('mousedown', () => focusPane(key, false));
  el.querySelector('.pane-head').addEventListener('click', (e) => {
    const a = e.target.dataset.a;
    if (a === 'h' || a === 'v') splitPane(key, a);
    else if (a === 'zoom') toggleZoom(key);
    else if (a === 'rename') { if (p.sessionId) renameSession(p.sessionId); }
    else if (a === 'close') closePane(key);
  });
  el.querySelector('.pane-head').addEventListener('dblclick', (e) => {
    if (e.target.dataset.a) return;
    if (p.sessionId) renameSession(p.sessionId);
  });
  el.querySelector('.pane-head').addEventListener('mousedown', (e) => paneDragStart(e, key));
  new ResizeObserver(() => fitPane(p)).observe(p.body);
  panes.set(key, p);
  renderEmpty(p);
  return p;
}

function renderEmpty(p) {
  p.body.innerHTML = '';
  const open = new Set([...panes.values()].map((x) => x.sessionId).filter(Boolean));
  const recent = state.sessions.filter((s) => !open.has(s.id) && !(s.live && s.live.pane)).slice(0, 6);
  const box = document.createElement('div');
  box.className = 'empty';
  const miss = p.missing && session(p.missing.id);
  box.innerHTML = (miss ? `<h3>“${esc(miss.title)}”</h3><div class="keys">This group session is running in another terminal${miss.live?.tty ? ' (' + esc(miss.live.tty.replace('/dev/', '')) + ')' : ''}.</div>
    <button class="primary" data-miss>Switch there or fork it here…</button><div class="keys">or start something else:</div>` : `<h3>Empty pane</h3>`) + `
    <button class="primary" data-new>New Claude session…</button>
    <div class="recent">${recent.map((s) => `<button data-id="${esc(s.id)}"><span class="dot ${s.live ? (s.live.status === 'busy' ? 'busy' : 'idle') : ''}"></span><span class="t">${esc(s.title)}</span><span class="p">${esc(base(s.cwd))} · ${ago(s.modified)}</span></button>`).join('')}</div>
    <div class="keys">Pick from the sidebar · <kbd>${kb('⌘P')}</kbd> find session · <kbd>${kb('⌘N')}</kbd> new</div>`;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.miss !== undefined) { const m = session(p.missing.id); p.missing = null; openSession(m, 'here', p.key); }
    else if (b.dataset.new !== undefined) newSession(p.key);
    else if (b.dataset.id) openSession(session(b.dataset.id), 'here', p.key);
  });
  p.body.appendChild(box);
  updatePaneHead(p);
}

function fitPane(p) {
  if (!p.term || !p.body.offsetWidth || !p.body.offsetHeight) return;
  try {
    p.fit.fit();
    if (p.ptyId != null) D.ptyResize(p.ptyId, p.term.cols, p.term.rows);
  } catch {}
}

async function launch(p, { cwd, cmd, sessionId, title }) {
  if (p.ptyId != null) return;
  p.body.innerHTML = '';
  p.missing = null;
  p.cwd = cwd; p.sessionId = sessionId || null; p.title = title || 'New session'; p.status = '';
  const term = new Terminal({
    fontFamily: IS_MAC ? '"SF Mono", Menlo, Monaco, monospace' : '"Cascadia Mono", Consolas, monospace', fontSize: state.fontSize, lineHeight: 1.15,
    theme: THEME, scrollback: 20000, cursorBlink: true, macOptionIsMeta: false, allowProposedApi: true,
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  p.term = term; p.fit = fit;
  term.open(p.body);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Shift+Enter → newline in Claude's prompt (same as /terminal-setup in iTerm)
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey) { if (p.ptyId != null) D.ptyWrite(p.ptyId, '\x1b\r'); return false; }
    // Option+arrows → word jumps, Cmd+arrows → line start/end, Cmd+Backspace → delete line
    if (paneKey(e)) { movePane(paneKey(e)); return false; }
    if (!IS_MAC) {
      // Ctrl+C copies when there's a selection, otherwise it's the usual interrupt
      if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) { D.copy(term.getSelection()); term.clearSelection(); return false; }
      // Ctrl+V: let the browser paste event reach xterm instead of sending ^V
      if (e.ctrlKey && !e.shiftKey && e.key === 'v') return false;
      // Ctrl+Shift+…, Ctrl+Tab, Ctrl+1-9, Ctrl+=/-/0 are app shortcuts
      return !(e.ctrlKey && (e.shiftKey || e.key === 'Tab' || /^[0-9=+-]$/.test(e.key)));
    }
    if (e.metaKey && e.key === 'ArrowLeft') { D.ptyWrite(p.ptyId, '\x01'); return false; }
    if (e.metaKey && e.key === 'ArrowRight') { D.ptyWrite(p.ptyId, '\x05'); return false; }
    if (e.metaKey && e.key === 'Backspace') { D.ptyWrite(p.ptyId, '\x15'); return false; }
    if (e.metaKey && e.key === 'k') { term.clear(); return false; }
    return !e.metaKey; // let menu shortcuts through
  });
  term.onData((d) => { if (p.ptyId != null) D.ptyWrite(p.ptyId, d); });
  updatePaneHead(p);
  await new Promise((r) => setTimeout(r, 0));
  try { fit.fit(); } catch {}
  const { id } = await D.ptyCreate({ cwd, cmd, cols: term.cols || 100, rows: term.rows || 30, paneKey: p.key });
  p.ptyId = id;
  byPty.set(id, p);
  if (tab() && tab().focus === p.key) term.focus();
  saveLayout();
  renderSidebar();
}

function updatePaneHead(p) {
  const dot = p.el.querySelector('.pane-head .dot');
  dot.className = 'dot ' + (p.attn ? 'attn' : p.status === 'busy' ? 'busy' : p.status ? 'idle' : '');
  p.el.querySelector('.ptitle').textContent = p.term ? p.title : 'Empty';
  p.el.querySelector('.pdesc').textContent = p.term && p.desc ? p.desc : '';
  p.el.querySelector('.pcwd').textContent = p.cwd ? tildify(p.cwd) : '';
  p.el.querySelector('.pane-head').title = p.sessionId ? 'Double-click to rename' : '';
  p.el.classList.toggle('attn', p.attn);
}

// ---------- tabs ----------
function newTab(p = makePane()) {
  state.tabs.push({ id: 't' + seq++, root: leaf(p.key), focus: p.key, zoom: null });
  state.active = state.tabs.length - 1;
  render();
  return p;
}

function closeTab(i) {
  const t = state.tabs[i]; if (!t) return;
  for (const k of leaves(t.root)) destroyPane(k);
  state.tabs.splice(i, 1);
  if (!state.tabs.length) { newTab(); return; }
  state.active = Math.min(state.active, state.tabs.length - 1);
  render();
}

function splitPane(key, dir, p2 = makePane()) {
  const i = tabOf(key); if (i < 0) return p2;
  const t = state.tabs[i];
  t.root = replace(t.root, key, (n) => ({ kind: 'split', dir, a: n, b: leaf(p2.key), ratio: 0.5 }));
  t.focus = p2.key; t.zoom = null;
  state.active = i;
  render();
  return p2;
}

function destroyPane(key) {
  const p = panes.get(key); if (!p) return;
  if (p.ptyId != null) { D.ptyKill(p.ptyId); byPty.delete(p.ptyId); }
  p.term?.dispose();
  p.el.remove();
  panes.delete(key);
}

async function closePane(key = tab()?.focus) {
  const p = panes.get(key); if (!p) return;
  if (p.status === 'busy' && !(await D.confirmClose(`“${p.title}” is still working. Close it anyway?`))) return;
  const i = tabOf(key);
  const t = state.tabs[i];
  const ks = leaves(t.root);
  if (ks.length === 1) { closeTab(i); saveLayout(); return; }
  const idx = ks.indexOf(key);
  t.root = remove(t.root, key);
  destroyPane(key);
  if (t.zoom === key) t.zoom = null;
  const rest = leaves(t.root);
  t.focus = rest[Math.max(0, idx - 1)];
  render();
}

function focusPane(key, refocusTerm = true) {
  const i = tabOf(key); if (i < 0) return;
  const t = state.tabs[i];
  const changed = state.active !== i || t.focus !== key;
  state.active = i; t.focus = key;
  const p = panes.get(key);
  if (p.attn) { p.attn = false; updatePaneHead(p); }
  if (changed) render(false);
  if (refocusTerm) p.term?.focus();
}

function toggleZoom(key = tab()?.focus) {
  const t = tab(); if (!t) return;
  t.zoom = t.zoom === key ? null : key;
  render();
}

// ---------- rendering ----------
const views = new Map(); // tab id -> container element
function render(rebuild = true) {
  const ws = $('#workspace');
  for (const [id, el] of views) if (!state.tabs.find((t) => t.id === id)) { el.remove(); views.delete(id); }
  state.tabs.forEach((t, i) => {
    let v = views.get(t.id);
    if (!v) { v = document.createElement('div'); v.className = 'tabview'; ws.appendChild(v); views.set(t.id, v); rebuild = true; }
    if (rebuild || !v.firstChild) {
      v.replaceChildren(build(t.root));
    }
    v.classList.toggle('single', t.root.kind === 'pane');
    v.style.visibility = i === state.active ? 'visible' : 'hidden';
    v.style.zIndex = i === state.active ? 1 : 0;
    for (const k of leaves(t.root)) {
      const p = panes.get(k);
      p.el.classList.toggle('focused', k === t.focus && t.root.kind !== 'pane');
      p.el.classList.toggle('zoomed', k === t.zoom);
    }
  });
  const f = tab() && panes.get(tab().focus);
  if (f) { requestAnimationFrame(() => { fitPane(f); f.term?.focus(); }); }
  renderTabs();
  renderSidebar();
  saveLayout();
}

function build(n) {
  if (n.kind === 'pane') return panes.get(n.key).el;
  const el = document.createElement('div');
  el.className = 'split ' + n.dir;
  const a = build(n.a), b = build(n.b), d = document.createElement('div');
  d.className = 'divider';
  const wrapA = wrap(a), wrapB = wrap(b);
  wrapA.style.flex = `${n.ratio} 1 0`; wrapB.style.flex = `${1 - n.ratio} 1 0`;
  d.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect(), start = n.ratio;
    const set = (v) => { n.ratio = v; wrapA.style.flex = `${v} 1 0`; wrapB.style.flex = `${1 - v} 1 0`; };
    const move = (ev) => {
      const x = n.dir === 'h' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      set(Math.min(0.9, Math.max(0.1, x)));
    };
    const end = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); noEsc(); };
    const up = () => { end(); saveLayout(); };
    const noEsc = escCancels(() => { end(); set(start); });
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  el.append(wrapA, d, wrapB);
  return el;
}
function wrap(child) {
  const w = document.createElement('div');
  w.style.display = 'flex'; w.style.minWidth = '0'; w.style.minHeight = '0';
  w.appendChild(child);
  return w;
}

// Drag a tab sideways to change the order
function tabDragStart(e, from) {
  const sx = e.clientX;
  let dragging = false, to = from, noEsc = () => {};
  const els = () => [...$('#tabs').children];
  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - sx) < 5) return;
      dragging = true; tabDrag = { from };
      noEsc = escCancels(() => { to = from; up(); });   // Esc: back to its old spot
      document.body.classList.add('tab-dragging');
      els()[from].classList.add('dragging');
    }
    const list = els(), me = list[from];
    me.style.transform = `translateX(${ev.clientX - sx}px)`;
    // where would it land: count the other tabs whose middle is left of the mouse
    const x = ev.clientX;
    to = 0;
    list.forEach((t, j) => { if (j === from) return; const r = t.getBoundingClientRect(); if (x > r.left + r.width / 2) to++; });
    const w = me.getBoundingClientRect().width + 3;
    list.forEach((t, j) => {
      if (j === from) return;
      const shift = from < to && j > from && j <= to ? -w : from > to && j >= to && j < from ? w : 0;
      t.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };
  const up = () => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up); noEsc();
    if (!dragging) return;
    document.body.classList.remove('tab-dragging');
    tabDrag = null;
    if (to !== from) {
      const activeId = tab()?.id;
      const [t] = state.tabs.splice(from, 1);
      state.tabs.splice(to, 0, t);
      state.active = state.tabs.findIndex((x) => x.id === activeId);
      saveLayout();
    }
    renderTabs();
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

function paneStatusClass(keys) {
  const ps = keys.map((k) => panes.get(k));
  if (ps.some((p) => p.attn)) return 'attn';
  if (ps.some((p) => p.status === 'busy')) return 'busy';
  if (ps.some((p) => p.status)) return 'idle';
  return '';
}

let tabDrag = null;   // while reordering tabs, skip re-renders so the dragged tab stays under the mouse
function renderTabs() {
  if (tabDrag) return;
  const el = $('#tabs');
  el.replaceChildren(...state.tabs.map((t, i) => {
    const ks = leaves(t.root);
    const f = panes.get(t.focus);
    const d = document.createElement('div');
    d.className = 'tab' + (i === state.active ? ' active' : '');
    const g = groupOf(t);
    const label = g ? g.name : f && f.term ? f.title : 'New tab';
    d.innerHTML = `${g ? '<span class="gicon">▦</span>' : ''}<span class="dot ${paneStatusClass(ks)}"></span><span class="label">${esc(label)}</span>${ks.length > 1 ? `<span class="num">${ks.length}</span>` : ''}<button class="x" title="Close tab">✕</button>`;
    d.title = ks.map((k) => panes.get(k).title || 'Empty').join('\n');
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.classList.contains('x')) return;
      // Tabs are re-rendered on click, so detect the double-click from the click count
      if (e.detail === 2) { e.preventDefault(); if (g) saveTabAsGroup(i); else { const fp = panes.get(t.focus); if (fp?.sessionId) renameSession(fp.sessionId); } return; }
      if (state.active !== i) { state.active = i; render(false); }
      tabDragStart(e, i);
    });
    d.querySelector('.x').addEventListener('click', () => closeTab(i));
    d.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(i); });
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(i); });
    return d;
  }));
}

// ---------- sidebar ----------
function applySidebar() {
  $('#app').classList.toggle('collapsed', !state.sidebar);
  document.documentElement.style.setProperty('--side-w', state.sideW + 'px');
  store.set('sidebar', state.sidebar);
  requestAnimationFrame(() => panes.forEach(fitPane));
}

function matches(s, q) {
  if (!q) return true;
  return [s.title, s.desc, s.lastPrompt, s.cwd, s.branch, s.id].some((x) => (x || '').toLowerCase().includes(q));
}

function rowHTML(s, extraClass = '') {
  const st = s.live ? (s.live.status === 'busy' ? 'busy' : 'idle') : '';
  const p = s.live?.pane && panes.get(s.live.pane);
  const where = s.live && !s.live.pane ? (s.live.tty ? ' · ' + s.live.tty.replace('/dev/', '') : ' · other app') : '';
  return `<div class="row ${extraClass}" data-id="${esc(s.id)}">
    <span class="dot ${p && p.attn ? 'attn' : st}"></span>
    <div class="main"><div class="title">${esc(s.title)}</div>${s.name && s.desc ? `<div class="desc">${esc(s.desc)}</div>` : ''}
    <div class="meta">${esc(base(s.cwd))}${s.branch && s.branch !== 'HEAD' ? ' · ' + esc(s.branch) : ''} · ${ago(s.modified)}${where}</div></div>
    <div class="actions"><button data-a="h" title="Open in split">◫</button><button data-a="tab" title="Open in new tab">＋</button><button data-a="more" title="More">⋯</button></div>
  </div>`;
}

function renderSidebar() {
  // project dropdown
  const sel = $('#projectFilter');
  const projects = [...new Set(state.sessions.map((s) => base(s.cwd)))].sort((a, b) => a.localeCompare(b));
  const want = ['', ...projects].join('\n');
  if (sel.dataset.v !== want) {
    sel.innerHTML = `<option value="">All projects</option>` + projects.map((p) => `<option>${esc(p)}</option>`).join('');
    sel.value = state.project; sel.dataset.v = want;
  }
  const q = state.query.toLowerCase();
  const list = state.sessions.filter((s) => matches(s, q)
    && (!state.project || base(s.cwd) === state.project)
    && (state.filter !== 'running' || s.live));
  const focusedId = tab() && panes.get(tab().focus)?.sessionId;
  const here = list.filter((s) => s.live?.pane);
  const elsewhere = list.filter((s) => s.live && !s.live.pane);
  const rest = list.filter((s) => !s.live);
  let html = '';
  const gq = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q) || groupSessions(g).some((n) => matches({ title: n.title, cwd: n.cwd, id: n.sessionId }, q)));
  html += `<div class="group gh" data-toggle-groups>${state.groupsOpen ? '▾' : '▸'} Groups <span class="gcount">${state.groups.length || ''}</span>
    <button class="gadd" data-save-group title="Save current tab as a group (${kb('⇧⌘S')})">＋</button></div>`;
  if (state.groupsOpen) {
    if (!state.groups.length) html += `<div class="ghint">Arrange sessions in a tab, then ＋ to save it as a group.</div>`;
    html += gq.map((g) => {
      const ns = groupSessions(g);
      const t = state.tabs.find((x) => x.groupId === g.id);
      const st = t ? paneStatusClass(leaves(t.root)) || 'idle' : '';
      const dirs = [...new Set(ns.map((n) => base(n.cwd)))];
      return `<div class="row grow ${t && tab() === t ? 'current' : ''}" data-group="${esc(g.id)}"><span class="dot ${st}"></span>
        <div class="main"><div class="title">▦ ${esc(g.name)}</div><div class="meta">${ns.length} session${ns.length === 1 ? '' : 's'} · ${esc(dirs.join(', ') || 'empty')}</div></div>
        <div class="actions"><button data-a="more" title="More">⋯</button></div></div>`;
    }).join('');
  }
  const group = (name, arr) => { if (arr.length) html += `<div class="group">${name}</div>` + arr.map((s) => rowHTML(s, s.id === focusedId ? 'current' : '')).join(''); };
  group('Open here', here);
  group('Running in other terminals', elsewhere);
  group('Recent', rest);
  if (!html) html = `<div class="group">No sessions</div>`;
  const listEl = $('#list');
  const scroll = listEl.scrollTop;
  listEl.innerHTML = html;
  listEl.scrollTop = scroll;
}

$('#list').addEventListener('click', (e) => {
  if (e.target.closest('[data-save-group]')) return saveTabAsGroup();
  if (e.target.closest('[data-toggle-groups]')) { state.groupsOpen = !state.groupsOpen; store.set('groupsOpen', state.groupsOpen); return renderSidebar(); }
  const grow = e.target.closest('[data-group]');
  if (grow) { const g = state.groups.find((x) => x.id === grow.dataset.group); if (e.target.closest('button')) groupMenu(g); else openGroup(g); return; }
  const row = e.target.closest('.row'); if (!row) return;
  const s = session(row.dataset.id); if (!s) return;
  const a = e.target.closest('button')?.dataset.a;
  if (a === 'more') return sessionMenu(s);
  openSession(s, a === 'tab' || mod(e) ? 'tab' : a === 'h' ? 'split' : 'auto');
});
$('#list').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  const grow = e.target.closest('[data-group]');
  if (grow) {
    const g = state.groups.find((x) => x.id === grow.dataset.group);
    return ask('Rename group', g.name).then((n) => { if (n) { g.name = n; saveLayout(); render(false); } });
  }
  const row = e.target.closest('.row');
  if (row) renameSession(row.dataset.id);
});
$('#list').addEventListener('contextmenu', (e) => {
  const grow = e.target.closest('[data-group]');
  if (grow) { e.preventDefault(); return groupMenu(state.groups.find((x) => x.id === grow.dataset.group)); }
  const row = e.target.closest('.row'); if (!row) return;
  e.preventDefault();
  const s = session(row.dataset.id); if (s) sessionMenu(s);
});

async function sessionMenu(s) {
  const items = [
    { id: 'auto', label: s.live?.pane ? 'Go to Pane' : 'Open' },
    { id: 'rename', label: s.name ? `Rename “${s.name}”…` : 'Name This Session…' },
    { type: 'separator' },
    { id: 'tab', label: 'Open in New Tab' },
    { id: 'h', label: 'Open in Split Right' },
    { id: 'v', label: 'Open in Split Down' },
    { type: 'separator' },
    { id: 'fork', label: 'Fork into New Tab (branch the conversation)' },
    { id: 'new', label: `New Session in “${base(s.cwd)}”` },
    { type: 'separator' },
    { id: 'copyCmd', label: 'Copy Resume Command' },
    { id: 'copyId', label: 'Copy Session ID' },
    { id: 'reveal', label: 'Show Folder in Finder' },
  ];
  if (s.transcript) items.push({ id: 'transcript', label: 'Show Transcript File' });
  if (state.groups.length) {
    items.push({ type: 'separator' });
    for (const g of state.groups) items.push({ id: 'grp:' + g.id, label: `Add to Group “${g.name}”` });
  }
  items.push({ id: 'newgrp', label: 'Add to New Group…' });
  const c = await D.menu(items);
  if (!c) return;
  if (c.startsWith('grp:')) return addToGroup(state.groups.find((g) => g.id === c.slice(4)), s);
  if (c === 'newgrp') { const name = await ask('New group name', base(s.cwd)); if (!name) return; const g = { id: 'g' + Date.now(), name, layout: null }; state.groups.push(g); return addToGroup(g, s); }
  if (c === 'rename') renameSession(s.id);
  else if (c === 'auto' || c === 'tab') openSession(s, c);
  else if (c === 'h' || c === 'v') openSession(s, c);
  else if (c === 'fork') launchInto('tab', { cwd: s.cwd, cmd: `claude --resume ${s.id} --fork-session`, title: s.title + ' (fork)' });
  else if (c === 'new') launchInto('auto', { cwd: s.cwd, cmd: 'claude', title: 'New session' });
  else if (c === 'copyCmd') D.copy(IS_MAC ? `cd ${shq(s.cwd)} && claude --resume ${s.id}` : `cd "${s.cwd}"; claude --resume ${s.id}`);
  else if (c === 'copyId') D.copy(s.id);
  else if (c === 'reveal') D.reveal(s.cwd);
  else if (c === 'transcript') D.reveal(s.transcript);
}

// ---------- opening sessions ----------
// mode: 'auto' | 'tab' | 'split' | 'h' | 'v' | 'here'
function targetPane(mode, hereKey) {
  const t = tab();
  const f = t && panes.get(t.focus);
  if (mode === 'here' && hereKey) return panes.get(hereKey);
  if (mode === 'tab' || !f) return newTab();
  if (mode === 'h' || mode === 'v') return splitPane(f.key, mode);
  if (!f.term) return f; // empty focused pane → use it
  if (mode === 'auto' && leaves(t.root).length >= 4) return newTab();
  const r = f.body.getBoundingClientRect();
  return splitPane(f.key, r.width / 2 > r.height * 1.1 ? 'h' : 'v');
}

function launchInto(mode, opts, hereKey) {
  const p = targetPane(mode, hereKey);
  launch(p, opts);
  return p;
}

async function openSession(s, mode = 'auto', hereKey) {
  if (!s) return;
  // Already open in one of our panes → just go there
  const mine = [...panes.values()].find((p) => p.sessionId === s.id && p.ptyId != null) || (s.live?.pane && panes.get(s.live.pane));
  if (mine) return focusPane(mine.key);
  let cmd = `claude --resume ${s.id}`, title = s.title;
  if (s.live && !s.live.pane) {
    const r = await D.askRunningElsewhere(s);
    if (r === 'cancel') return;
    if (r === 'focus') {
      if (!s.live.tty || !(await D.focusExternal(s.live.tty))) alert('Could not find that terminal tab (it may be in an app other than iTerm2 / Terminal).');
      return;
    }
    cmd += ' --fork-session'; title += ' (fork)';
  }
  launchInto(mode, { cwd: s.cwd || D.home, cmd, sessionId: s.id, title }, hereKey);
}

async function newSession(hereKey) {
  const f = tab() && panes.get(tab().focus);
  const dir = await D.pickFolder(f?.cwd || D.home);
  if (!dir) return;
  launchInto(hereKey ? 'here' : 'auto', { cwd: dir, cmd: 'claude', title: 'New session' }, hereKey);
}

// ---------- palette (⌘P) ----------
let palSel = 0, palItems = [];
function openPalette() {
  $('#palette').classList.remove('hidden');
  $('#paletteInput').value = '';
  palSel = 0; renderPalette();
  $('#paletteInput').focus();
}
function closePalette() { $('#palette').classList.add('hidden'); tab() && panes.get(tab().focus)?.term?.focus(); }
function renderPalette() {
  const q = $('#paletteInput').value.toLowerCase();
  palItems = state.sessions.filter((s) => matches(s, q)).slice(0, 40);
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  $('#paletteList').innerHTML = palItems.map((s, i) => rowHTML(s, i === palSel ? 'sel' : '')).join('');
  $('#paletteList .sel')?.scrollIntoView({ block: 'nearest' });
}
$('#paletteInput').addEventListener('input', () => { palSel = 0; renderPalette(); });
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Escape') closePalette();
  else if (e.key === 'Enter') { const s = palItems[palSel]; closePalette(); if (s) openSession(s, mod(e) ? 'tab' : 'auto'); }
});
$('#paletteList').addEventListener('click', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  closePalette(); openSession(session(row.dataset.id), mod(e) ? 'tab' : 'auto');
});
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

// ---------- pty events ----------
D.onPtyData((id, d) => byPty.get(id)?.term.write(d));
D.onPtyExit((id) => {
  if (quitting) return;
  const p = byPty.get(id); if (!p) return;
  byPty.delete(id); p.ptyId = null;
  closePane(p.key);
});

// ---------- session names ----------
// Your name becomes the title; Claude's auto title stays as the description.
function applyNames(list) {
  for (const s of list) {
    s.desc = s.title;
    const n = state.names[s.id];
    if (n) { s.name = n; s.title = n; }
  }
  return list;
}
async function loadSessions() { state.sessions = applyNames(await D.sessions()); }

async function renameSession(id) {
  const s = session(id);
  const p = [...panes.values()].find((x) => x.sessionId === id);
  if (!s && !p) return;
  const cur = state.names[id] || '';
  const name = await ask(`Name this session${s?.desc ? ` — “${s.desc}”` : ''}`, cur || '');
  if (name === null) return;
  if (name) state.names[id] = name; else delete state.names[id];   // empty → back to Claude's title
  store.set('names', state.names);
  try { await loadSessions(); } catch {}
  for (const x of panes.values()) {
    if (x.sessionId !== id) continue;
    const ss = session(id);
    if (ss) x.title = ss.title;
    x.desc = ss?.name ? ss.desc : '';
    updatePaneHead(x);
  }
  renderTabs(); renderSidebar(); saveLayout();
}
function renameFocused() {
  const p = tab() && panes.get(tab().focus);
  if (p?.sessionId) renameSession(p.sessionId);
}

// ---------- session polling ----------
async function refresh() {
  try { await loadSessions(); } catch { return; }
  for (const p of panes.values()) {
    const s = state.sessions.find((x) => x.live?.pane === p.key);
    const prev = p.status;
    if (s) {
      p.sessionId = s.id; p.title = s.title; p.desc = s.name ? s.desc : ''; p.status = s.live.status || 'idle';
      if (s.cwd) p.cwd = s.cwd;
    } else if (p.term) p.status = '';
    // Finished working while you weren't looking → highlight
    const visible = tab() && tab().focus === p.key && document.hasFocus();
    if (prev === 'busy' && p.status && p.status !== 'busy' && !visible) p.attn = true;
    updatePaneHead(p);
    if (!p.term && !p.body.querySelector('.recent button:hover')) renderEmpty(p);
  }
  renderTabs();
  renderSidebar();
  saveLayout();
}

// ---------- layout persistence ----------
function serialize(n) {
  if (n.kind === 'pane') { const p = panes.get(n.key); const m = p.missing; return { kind: 'pane', sessionId: p.sessionId || m?.id || null, cwd: p.cwd || m?.cwd || '', title: p.term ? p.title : m?.title || '' }; }
  return { kind: 'split', dir: n.dir, ratio: n.ratio, a: serialize(n.a), b: serialize(n.b) };
}
let restoring = true;
let quitting = false;
D.onQuitting(() => { quitting = true; });
function saveLayout() {
  if (restoring || quitting) return;
  // Tabs that belong to a group keep the group up to date (new panes, /clear'd sessions, resizes…)
  for (const t of state.tabs) { const g = groupOf(t); if (g) g.layout = serialize(t.root); }
  store.set('groups', state.groups);
  store.set('layout', { active: state.active, tabs: state.tabs.map((t) => ({ groupId: t.groupId || null, root: serialize(t.root) })) });
}
// Build panes from a saved tree; each pane resumes its own conversation in its own folder.
function buildSaved(tree) {
  const pending = [];
  const rebuild = (n) => {
    if (n.kind === 'pane') { const p = makePane(); if (n.sessionId) pending.push([p, n]); return leaf(p.key); }
    return { kind: 'split', dir: n.dir, ratio: n.ratio, a: rebuild(n.a), b: rebuild(n.b) };
  };
  return { root: rebuild(tree), pending };
}
function resumePending(pending) {
  for (const [p, n] of pending) {
    const s = session(n.sessionId);
    if (s?.live?.pane && panes.get(s.live.pane)) continue;  // already open in this window
    if (s?.live && !s.live.pane) { p.missing = { id: n.sessionId, cwd: n.cwd, title: n.title }; renderEmpty(p); continue; }
    launch(p, { cwd: n.cwd || s?.cwd || D.home, cmd: `claude --resume ${n.sessionId}`, sessionId: n.sessionId, title: s?.title || n.title });
  }
}
function restoreLayout() {
  const saved = store.get('layout', null);
  const all = [];
  for (const r of saved?.tabs || []) {
    const { root, pending } = buildSaved(r.root || r);
    state.tabs.push({ id: 't' + seq++, root, focus: leaves(root)[0], zoom: null, groupId: state.groups.some((g) => g.id === r.groupId) ? r.groupId : null });
    all.push(...pending);
  }
  if (!state.tabs.length) newTab();
  state.active = Math.min(saved?.active || 0, state.tabs.length - 1);
  render();
  resumePending(all);
  restoring = false;
  saveLayout();
}

// ---------- groups ----------
function groupOf(t) { return t?.groupId ? state.groups.find((g) => g.id === t.groupId) : null; }
function groupSessions(g) { const out = []; const walk = (n) => { if (!n) return; if (n.kind === 'pane') { if (n.sessionId) out.push(n); } else { walk(n.a); walk(n.b); } }; walk(g.layout); return out; }

function openGroup(g) {
  if (!g) return;
  const i = state.tabs.findIndex((t) => t.groupId === g.id);
  if (i >= 0) { state.active = i; return render(false); }
  if (!g.layout) { const p = newTab(); tab().groupId = g.id; render(); return p; }
  const { root, pending } = buildSaved(g.layout);
  // Reuse the current tab if it's a lone empty pane
  const t = tab();
  if (t && !t.groupId && t.root.kind === 'pane' && !panes.get(t.root.key).term) closeTabSilently(state.active);
  state.tabs.push({ id: 't' + seq++, root, focus: leaves(root)[0], zoom: null, groupId: g.id });
  state.active = state.tabs.length - 1;
  render();
  resumePending(pending);
}
function closeTabSilently(i) { for (const k of leaves(state.tabs[i].root)) destroyPane(k); state.tabs.splice(i, 1); }

async function saveTabAsGroup(i = state.active) {
  const t = state.tabs[i]; if (!t) return;
  const g0 = groupOf(t);
  const first = panes.get(leaves(t.root)[0]);
  const name = await ask(g0 ? 'Rename group' : 'Save this tab as a group', g0 ? g0.name : base(first?.cwd) || 'My group');
  if (!name) return;
  if (g0) g0.name = name;
  else { const g = { id: 'g' + Date.now(), name, layout: serialize(t.root) }; state.groups.push(g); t.groupId = g.id; }
  state.groupsOpen = true; store.set('groupsOpen', true);
  render(false); saveLayout();
}

function addToGroup(g, s) {
  if (!g || !s) return;
  const t = state.tabs.find((x) => x.groupId === g.id);
  if (t) {   // group is open → put the session in a new split of its tab
    state.active = state.tabs.indexOf(t);
    render(false);
    openSession(s, 'split');
  } else {
    const node = { kind: 'pane', sessionId: s.id, cwd: s.cwd, title: s.title };
    g.layout = g.layout ? { kind: 'split', dir: 'h', ratio: 0.5, a: g.layout, b: node } : node;
  }
  saveLayout(); renderSidebar();
}

async function groupMenu(g) {
  if (!g) return;
  const open = state.tabs.some((t) => t.groupId === g.id);
  const c = await D.menu([
    { id: 'open', label: open ? 'Go to Group' : 'Open Group (resume all sessions)' },
    { id: 'rename', label: 'Rename…' },
    ...(open ? [{ id: 'close', label: 'Close Group Tab (keeps the group)' }] : []),
    { type: 'separator' },
    { id: 'delete', label: 'Delete Group' },
  ]);
  if (c === 'open') openGroup(g);
  else if (c === 'rename') { const n = await ask('Rename group', g.name); if (n) { g.name = n; saveLayout(); render(false); } }
  else if (c === 'close') closeTab(state.tabs.findIndex((t) => t.groupId === g.id));
  else if (c === 'delete' && await D.confirmClose(`Delete group “${g.name}”? Sessions themselves are kept.`)) {
    state.groups = state.groups.filter((x) => x !== g);
    for (const t of state.tabs) if (t.groupId === g.id) t.groupId = null;
    saveLayout(); render(false);
  }
}

async function tabMenu(i) {
  const t = state.tabs[i]; const g = groupOf(t);
  const c = await D.menu([
    { id: 'save', label: g ? 'Rename Group…' : 'Save Tab as Group…' },
    ...(g ? [{ id: 'detach', label: 'Detach from Group' }] : []),
    { type: 'separator' },
    { id: 'close', label: g ? 'Close Tab (group is kept)' : 'Close Tab' },
  ]);
  if (c === 'save') saveTabAsGroup(i);
  else if (c === 'detach') { t.groupId = null; saveLayout(); render(false); }
  else if (c === 'close') closeTab(i);
}

// Small text-input modal (window.prompt doesn't exist in Electron)
function ask(title, value = '') {
  return new Promise((resolve) => {
    const m = $('#modal'), inp = $('#modalInput');
    $('#modalTitle').textContent = title; inp.value = value;
    m.classList.remove('hidden'); inp.focus(); inp.select();
    const done = (v) => { m.classList.add('hidden'); inp.onkeydown = null; m.onmousedown = null; resolve(v); tab() && panes.get(tab().focus)?.term?.focus(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); else if (e.key === 'Escape') done(null); };
    m.onmousedown = (e) => { if (e.target === m) done(null); };
  });
}

// ---------- commands / UI wiring ----------
function setFont(delta) {
  state.fontSize = delta === 0 ? DEFAULT_FONT : Math.min(24, Math.max(9, state.fontSize + delta));
  store.set('fontSize', state.fontSize);
  for (const p of panes.values()) if (p.term) { p.term.options.fontSize = state.fontSize; fitPane(p); }
}
// Option+arrows move between panes (fn+arrows too — on a Mac they arrive as Home/End/PageUp/PageDown)
const FN_ARROWS = { Home: 'left', End: 'right', PageUp: 'up', PageDown: 'down' };
const OPT_ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
function paneKey(e) {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.altKey) return OPT_ARROWS[e.key] || null;
  return IS_MAC ? FN_ARROWS[e.key] || null : null;  // Home/End are real keys on Windows
}
function movePane(dir) {
  const t = tab(); if (!t) return;
  const ks = leaves(t.root);
  if (t.zoom) {   // zoomed: walk panes in order and keep the zoom on the new one
    const n = ks[(ks.indexOf(t.focus) + (dir === 'left' || dir === 'up' ? -1 : 1) + ks.length) % ks.length];
    t.zoom = n; focusPane(n); render(false); return;
  }
  const cur = panes.get(t.focus).el.getBoundingClientRect();
  const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
  let best = null, bestScore = Infinity;
  for (const k of ks) {
    if (k === t.focus) continue;
    const r = panes.get(k).el.getBoundingClientRect();
    let gap, off;
    if (dir === 'left') { if (r.right > cur.left + 4) continue; gap = cur.left - r.right; off = Math.max(0, Math.max(r.top, cur.top) - Math.min(r.bottom, cur.bottom)) ? Math.abs(r.top + r.height / 2 - cy) : 0; }
    else if (dir === 'right') { if (r.left < cur.right - 4) continue; gap = r.left - cur.right; off = Math.max(0, Math.max(r.top, cur.top) - Math.min(r.bottom, cur.bottom)) ? Math.abs(r.top + r.height / 2 - cy) : 0; }
    else if (dir === 'up') { if (r.bottom > cur.top + 4) continue; gap = cur.top - r.bottom; off = Math.max(0, Math.max(r.left, cur.left) - Math.min(r.right, cur.right)) ? Math.abs(r.left + r.width / 2 - cx) : 0; }
    else { if (r.top < cur.bottom - 4) continue; gap = r.top - cur.bottom; off = Math.max(0, Math.max(r.left, cur.left) - Math.min(r.right, cur.right)) ? Math.abs(r.left + r.width / 2 - cx) : 0; }
    // prefer panes that overlap on the other axis, then the closest one (nearer the cursor row/column)
    const along = dir === 'left' || dir === 'right' ? Math.abs(r.top + r.height / 2 - cy) : Math.abs(r.left + r.width / 2 - cx);
    const score = gap + off * 1000 + along * 0.01;
    if (score < bestScore) { bestScore = score; best = k; }
  }
  if (best) return focusPane(best);
  // nothing further left/right → previous/next tab
  if ((dir === 'left' || dir === 'right') && state.tabs.length > 1) {
    state.active = (state.active + (dir === 'left' ? -1 : 1) + state.tabs.length) % state.tabs.length;
    render(false);
  }
}
// Also works when focus isn't inside a terminal (e.g. on an empty pane)
document.addEventListener('keydown', (e) => {
  const dir = paneKey(e); if (!dir) return;
  if (e.target.closest?.('.xterm') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  e.preventDefault(); movePane(dir);
});

function stepPane(d) {
  const t = tab(); if (!t) return;
  const ks = leaves(t.root);
  focusPane(ks[(ks.indexOf(t.focus) + d + ks.length) % ks.length]);
}

D.onCmd((cmd, a) => {
  switch (cmd) {
    case 'copy': { const t = tab() && panes.get(tab().focus)?.term; if (t?.hasSelection()) D.copy(t.getSelection()); break; }
    case 'newSession': newSession(); break;
    case 'newTab': newTab(); break;
    case 'saveGroup': saveTabAsGroup(); break;
    case 'renameSession': renameFocused(); break;
    case 'split': if (tab()) splitPane(tab().focus, a); break;
    case 'closePane': closePane(); break;
    case 'closeTab': closeTab(state.active); break;
    case 'toggleSidebar': state.sidebar = !state.sidebar; applySidebar(); break;
    case 'findSession': openPalette(); break;
    case 'tab': if (state.tabs[a]) { state.active = a; render(false); } break;
    case 'tabStep': state.active = (state.active + a + state.tabs.length) % state.tabs.length; render(false); break;
    case 'paneStep': stepPane(a); break;
    case 'zoomPane': toggleZoom(); break;
    case 'font': setFont(a); break;
    case 'shortcuts': toggleShortcuts(); break;
    case 'settings': toggleSettings(); break;
    case 'stats': toggleStats(); break;
  }
});

$('#sideToggle').addEventListener('click', () => { state.sidebar = !state.sidebar; applySidebar(); });
$('#addTab').addEventListener('click', () => newTab());
$('#helpBtn').addEventListener('click', () => toggleShortcuts());
// ---------- updates (checked/downloaded by the main process, see updater.js) ----------
let upd = null, prefs = { autoUpdate: null };
const updDismissed = () => store.get('updateDismissed', '');
function showUpdateCard(show) {
  const c = $('#updateCard');
  if (!show) { c.classList.add('hidden'); return; }
  $('#ucVersion').textContent = upd.version;
  $('#ucCurrent').textContent = prefs.version || '';
  $('#ucAuto').checked = !!prefs.autoUpdate;
  $('#ucError').classList.toggle('hidden', !upd.error);
  $('#ucError').textContent = upd.error ? `Download failed: ${upd.error}` : '';
  c.classList.remove('hidden');
}
function renderUpdate() {
  const b = $('#updateBtn'), st = upd?.state;
  b.classList.toggle('hidden', !st);
  b.classList.toggle('downloading', st === 'downloading');
  b.classList.toggle('available', st === 'available');
  b.textContent = st === 'ready' ? `Update ${upd.version} · Restart` : st === 'downloading' ? `Downloading ${upd.version}…` : st === 'available' ? `Update ${upd.version} available` : '';
  b.title = st === 'ready' ? 'Restart to install the update. Your tabs reopen and sessions resume.' : '';
  if (st !== 'available') showUpdateCard(false);
  renderSettingsStatus();
}
D.onUpdate((info) => {
  upd = info;
  renderUpdate();
  // a new release: ask once per version (or again if the download failed)
  if (info.state === 'available' && (info.error || updDismissed() !== info.version)) showUpdateCard(true);
});
$('#updateBtn').addEventListener('click', async () => {
  const st = upd?.state;
  if (st === 'available') return showUpdateCard(true);
  if (st !== 'ready') return;
  const busy = [...panes.values()].filter((p) => p.status === 'busy');
  if (busy.length && !(await D.confirmClose(`${busy.length === 1 ? `“${busy[0].title}” is` : `${busy.length} sessions are`} still working. Restart anyway? Sessions resume after the restart, but the current reply is interrupted.`))) return;
  saveLayout();
  D.updateRestart();
});
$('#ucInstall').addEventListener('click', () => {
  if ($('#ucAuto').checked) D.setSetting('autoUpdate', true);   // also starts the download
  else D.updateDownload();
  showUpdateCard(false);
});
$('#ucLater').addEventListener('click', () => {
  if ($('#ucAuto').checked) D.setSetting('autoUpdate', true);
  store.set('updateDismissed', upd.version);
  showUpdateCard(false);
});
$('#ucNotes').addEventListener('click', (e) => { e.preventDefault(); D.openReleases(); });

// ---------- fun stats (computed locally by stats-worker.js; only counts, never your text) ----------
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString();
const usd = (n) => n >= 1000 ? '$' + Math.round(n).toLocaleString() : n >= 10 ? '$' + n.toFixed(0) : '$' + n.toFixed(2);
const toolName = (t) => { const m = /^mcp__(.+?)__(.+)$/.exec(t); return m ? `${m[2]} (${m[1]})` : t; };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
function barChart(values, tipOf, axis) {
  const max = Math.max(1, ...values);
  return `<div class="st-bars">${values.map((v, i) => `<i class="${v ? '' : 'zero'}" style="height:${v ? Math.max(3, (v / max) * 100) : 0}%" data-tip="${esc(tipOf(i, v))}"></i>`).join('')}</div>
    <div class="st-axis">${axis.map((a) => `<span>${esc(a)}</span>`).join('')}</div>`;
}
function rankList(entries, label, unit, show = fmt) {
  const max = Math.max(1e-9, ...entries.map((e) => e[1]));
  return `<div class="st-list">${entries.map(([k, v]) => `<div class="st-row" data-tip="${esc(label(k))}: ${unit === '$' ? usd(v) : v.toLocaleString() + ' ' + unit}"><span class="n">${esc(label(k))}</span><span class="v">${show(v)}</span><span class="track"><i style="width:${(v / max) * 100}%"></i></span></div>`).join('')}</div>`;
}
function renderStats(r) {
  const body = $('#stBody');
  if (!r?.ok) { body.innerHTML = `<div class="st-loading">Couldn't read your sessions${r?.error ? ': ' + esc(r.error) : ''}.</div>`; return; }
  const s = r.stats;
  if (!s.sessions) { body.innerHTML = `<div class="st-loading">No Claude Code sessions yet. Start one and come back!</div>`; return; }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const tools = Object.values(s.tools).reduce((a, b) => a + b, 0);
  const words = s.out * 0.75, novels = words / 90000;
  const totalTok = s.out + s.inTok + s.cacheWrite + s.cacheRead;
  const cachePct = totalTok ? (s.cacheRead / totalTok) * 100 : 0;
  const tokSplit = [['Re-read from cache', s.cacheRead], ['Saved to cache', s.cacheWrite], ['Written by Claude', s.out], ['Fresh input', s.inTok]];
  const peak = s.hours.indexOf(Math.max(...s.hours));
  const persona = peak < 7 ? '🌙 Night shift' : peak < 11 ? '🌅 Early bird' : peak < 17 ? '☀️ Day builder' : peak < 21 ? '🌆 Evening hacker' : '🦉 Night owl';
  const work = s.hours.map((v, h) => [h, v]).filter(([h]) => h >= 9 && h <= 17);
  const dip = work.length ? work.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  const topDow = s.weekdays.indexOf(Math.max(...s.weekdays));
  const models = top(s.models, 4), modelTotal = Object.values(s.models).reduce((a, b) => a + b, 0) || 1;
  const since = s.first ? new Date(s.first).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  $('#stSub').textContent = `${since ? 'Since ' + since + ' · ' : ''}counted on this computer from ~/.claude, nothing is sent anywhere`;
  const facts = [
    s.busiestDay && `Busiest day: <b>${new Date(s.busiestDay.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b> with <b>${s.busiestDay.prompts}</b> prompts.`,
    s.longest && `Longest session: <b>${s.longest.prompts}</b> prompts in <b>${esc(base(s.longest.cwd))}</b>${s.longest.ms > 864e5 ? `, kept going for <b>${Math.round(s.longest.ms / 864e5)} days</b>` : ''}.`,
    `Favourite day of the week: <b>${DOW[topDow]}</b>.`,
    dip && dip[1] < Math.max(...s.hours) * 0.4 && `Quietest working hour: <b>${hourLabel(dip[0])}</b>. Lunch? 🥪`,
    s.biggestTokDay && `Hungriest day: <b>${new Date(s.biggestTokDay.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b> with <b>${fmt(s.biggestTokDay.tokens)}</b> tokens.`,
    s.prompts && `Each prompt you sent averaged <b>${fmt(Math.round(totalTok / s.prompts))}</b> tokens of work${s.usd ? ` (about <b>${usd(s.usd / s.prompts)}</b> at API prices)` : ''}.`,
    s.unpriced && `${fmt(s.unpriced)} tokens from models without a known price are left out of the dollar estimate.`,
    `Claude averaged <b>${(s.replies / Math.max(1, s.prompts)).toFixed(1)}</b> steps for every prompt you sent.`,
  ].filter(Boolean);
  body.innerHTML = `
    <div class="st-tiles">
      <div class="st-tile"><b>${fmt(s.prompts)}</b><span>prompts you sent</span><small>in ${s.sessions} sessions</small></div>
      <div class="st-tile"><b>${fmt(s.replies)}</b><span>steps Claude took</span><small>${fmt(tools)} tool calls</small></div>
      <div class="st-tile"><b>${fmt(totalTok)}</b><span>tokens spent</span><small>${cachePct >= 1 ? Math.round(cachePct) + '% re-read from cache' : fmt(s.out) + ' written by Claude'}</small></div>
      ${s.usd ? `<div class="st-tile" data-tip="Estimate: what these tokens would cost at public API prices. Plans like Pro/Max aren't billed per token."><b>${usd(s.usd)}</b><span>at API prices</span><small>${usd(s.usd30)} in the last 30 days</small></div>` : ''}
      <div class="st-tile"><b>${fmt(Math.round(words))}</b><span>words Claude wrote</span><small>≈ ${novels >= 1 ? Math.round(novels).toLocaleString() + ' novels' : Math.round(novels * 100) + '% of a novel'}</small></div>
      <div class="st-tile"><b>${s.streak.current}<span style="display:inline;font-size:13px"> day${s.streak.current === 1 ? '' : 's'}</span></b><span>current streak</span><small>best ${s.streak.best} days</small></div>
      <div class="st-tile"><b>${s.activeDays}</b><span>days with Claude</span><small>since ${since || 'the start'}</small></div>
      <div class="st-tile"><b style="font-size:16px;line-height:1.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${persona}</b><span>you peak at ${hourLabel(peak)}</span><small>busiest hour of the day</small></div>
    </div>
    <div class="st-sec"><h4>Last 30 days</h4><div class="cap">Prompts per day</div>
      ${barChart(s.last30.map((d) => d.prompts), (i, v) => `${new Date(s.last30[i].day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${v} prompt${v === 1 ? '' : 's'}`,
        [new Date(s.last30[0].day + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), 'today'])}</div>
    <div class="st-sec"><h4>Tokens, last 30 days</h4><div class="cap">Everything Claude read and wrote per day</div>
      ${barChart(s.last30.map((d) => d.tokens), (i, v) => `${new Date(s.last30[i].day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${v.toLocaleString()} tokens`,
        [new Date(s.last30[0].day + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), 'today'])}</div>
    <div class="st-cols st-sec">
      <div><h4>Where the tokens went</h4><div class="cap">Re-reading from cache is much cheaper than fresh input</div>${rankList(tokSplit.filter((e) => e[1]), (k) => k, 'tokens')}</div>
      <div><h4>Tokens by model</h4><div class="cap">All tokens each model handled</div>${rankList(top(s.modelTok || {}, 4), (k) => k.replace(/^claude-/, ''), 'tokens')}</div>
    </div>
    ${s.usd ? `<div class="st-sec"><h4>API price equivalent, last 30 days</h4><div class="cap">What each day would have cost at public per-token API prices. An estimate, not your bill: Pro/Max plans aren't charged per token.</div>
      ${barChart(s.last30.map((d) => d.usd), (i, v) => `${new Date(s.last30[i].day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${usd(v)}`,
        [new Date(s.last30[0].day + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), 'today'])}</div>
    <div class="st-cols st-sec">
      <div><h4>Price by model</h4><div class="cap">All time, at API prices</div>${rankList(top(s.modelUsd || {}, 4), (k) => k.replace(/^claude-/, ''), '$', usd)}</div>
      <div><h4>Priciest projects</h4><div class="cap">All time, at API prices</div>${rankList(top(s.projectUsd || {}, 5), base, '$', usd)}</div>
    </div>` : ''}
    <div class="st-sec"><h4>Time of day</h4><div class="cap">Prompts by hour, all time</div>
      ${barChart(s.hours, (h, v) => `${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${v.toLocaleString()} prompt${v === 1 ? '' : 's'}`, ['00:00', '06:00', '12:00', '18:00', '23:00'])}</div>
    <div class="st-cols st-sec">
      <div><h4>Top projects</h4><div class="cap">By prompts</div>${rankList(top(s.projects, 5), base, 'prompts')}</div>
      <div><h4>Hungriest projects</h4><div class="cap">By tokens</div>${rankList(top(s.projectTok || {}, 5), base, 'tokens')}</div>
      <div><h4>Favourite tools</h4><div class="cap">What Claude used most</div>${rankList(top(s.tools, 6), toolName, 'calls')}</div>
    </div>
    <div class="st-sec"><h4>Models</h4><div class="cap">Share of Claude's steps</div>
      ${rankList(models.map(([k, v]) => [k, v]), (k) => `${k.replace(/^claude-/, '')} · ${Math.round((s.models[k] / modelTotal) * 100)}%`, 'steps')}</div>
    <ul class="st-facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>
    <div class="st-foot">Updated in ${(r.ms / 1000).toFixed(1)}s · only counts are kept, never the text of your sessions${s.usd ? ' · dollar figures use Anthropic\'s public API prices (checked Oct 2026)' : ''}</div>`;
}
async function toggleStats(show = $('#stats').classList.contains('hidden')) {
  const m = $('#stats');
  if (!show) { m.classList.add('hidden'); $('#stTip').classList.add('hidden'); tab() && panes.get(tab().focus)?.term?.focus(); return; }
  m.classList.remove('hidden'); m.tabIndex = -1; m.focus();
  if (!$('#stBody .st-tiles')) $('#stBody').innerHTML = '<div class="st-loading">Counting… (the first time reads all your sessions, after that only what\'s new)</div>';
  renderStats(await D.stats());
}
$('#statsBtn').addEventListener('click', () => toggleStats());
$('#stClose').addEventListener('click', () => toggleStats(false));
$('#stats').addEventListener('mousedown', (e) => { if (e.target.id === 'stats') toggleStats(false); });
$('#stats').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggleStats(false); } });
// hover readout for bars and rows
$('#stats').addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]'), tip = $('#stTip');
  if (!el) { tip.classList.add('hidden'); return; }
  tip.textContent = el.dataset.tip; tip.classList.remove('hidden');
  const w = tip.offsetWidth;
  tip.style.left = Math.min(innerWidth - w - 8, e.clientX + 12) + 'px'; tip.style.top = e.clientY - 34 + 'px';
});
$('#stats').addEventListener('mouseleave', () => $('#stTip').classList.add('hidden'));

// ---------- settings ----------
function renderSettingsStatus(msg) {
  const el = $('#setStatus'); if (!el) return;
  $('#setAuto').checked = !!prefs.autoUpdate;
  $('#setVersion').textContent = prefs.version || '';
  const st = upd?.state;
  el.textContent = msg || (!prefs.canUpdate ? (prefs.packaged === false ? 'Updates only work in the installed app.' : "This copy can't update itself. Move Claude Deck to your Applications folder.")
    : st === 'ready' ? `${upd.version} is downloaded. Restart Claude Deck to install it.`
    : st === 'downloading' ? `Downloading ${upd.version}…`
    : st === 'available' ? `${upd.version} is available.`
    : prefs.autoUpdate ? 'On: new releases install by themselves.' : "Off: you'll be asked when a new release comes out.");
}
async function toggleSettings(show = $('#settings').classList.contains('hidden')) {
  const m = $('#settings');
  if (!show) { m.classList.add('hidden'); tab() && panes.get(tab().focus)?.term?.focus(); return; }
  prefs = await D.getSettings();
  renderSettingsStatus();
  m.classList.remove('hidden');
  m.tabIndex = -1; m.focus();
}
$('#settingsBtn').addEventListener('click', () => toggleSettings());
$('#setClose').addEventListener('click', () => toggleSettings(false));
$('#settings').addEventListener('mousedown', (e) => { if (e.target.id === 'settings') toggleSettings(false); });
$('#settings').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggleSettings(false); } });
$('#setAuto').addEventListener('change', (e) => D.setSetting('autoUpdate', e.target.checked));
$('#setCheck').addEventListener('click', async () => {
  const b = $('#setCheck'); b.disabled = true; renderSettingsStatus('Checking…');
  const r = await D.updateCheck();
  b.disabled = false;
  if (r.state === 'latest') renderSettingsStatus(`You're up to date.`);
  else if (r.state === 'error') renderSettingsStatus(`Couldn't check: ${r.message || 'no connection'}`);
  else renderSettingsStatus();
  if (r.state === 'available') { upd = { state: 'available', version: r.version }; renderUpdate(); showUpdateCard(true); }
});
D.onSettings((s) => { prefs = { ...prefs, ...s }; renderSettingsStatus(); });
D.getSettings().then((s) => { prefs = s; });
$('#newBtn').addEventListener('click', () => newSession());
$('#search').addEventListener('input', (e) => { state.query = e.target.value; renderSidebar(); });
$('#projectFilter').addEventListener('change', (e) => { state.project = e.target.value; renderSidebar(); });
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === c));
  state.filter = c.dataset.filter; renderSidebar();
}));
$('#resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const start = state.sideW;
  const move = (ev) => { state.sideW = Math.min(520, Math.max(200, ev.clientX)); applySidebar(); };
  const end = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); noEsc(); };
  const up = () => { end(); store.set('sideW', state.sideW); };
  const noEsc = escCancels(() => { end(); state.sideW = start; applySidebar(); });
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});
// ---------- drag panes to rearrange (by the pane's title bar) ----------
// Drop on an edge of another pane → split there; middle → swap the two; on a tab → move the pane into that tab.
function dropZone(r, x, y) {
  const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
  const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (edge > 0.25) return 'swap';
  return edge === fx ? 'left' : edge === 1 - fx ? 'right' : edge === fy ? 'top' : 'bottom';
}
function zoneRect(r, z) {
  if (z === 'left') return { left: r.left, top: r.top, width: r.width / 2, height: r.height };
  if (z === 'right') return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
  if (z === 'top') return { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
  if (z === 'bottom') return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
function paneDragStart(e, key) {
  if (e.button !== 0 || e.target.closest('button')) return;
  const t = tab(); if (!t || t.zoom) return;
  const sx = e.clientX, sy = e.clientY;
  let dragging = false, ghost, hint, target = null, noEsc = () => {};
  const tabEls = () => [...$('#tabs').children];
  const clear = () => { tabEls().forEach((x) => x.classList.remove('drop-target')); $('#tabbar').classList.remove('drop-newtab'); if (hint) hint.style.display = 'none'; };
  const move = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      dragging = true;
      noEsc = escCancels(end);   // Esc: put it back where it was
      const p = panes.get(key);
      document.body.classList.add('pane-dragging'); p.el.classList.add('drag-src');
      ghost = document.createElement('div'); ghost.id = 'dragGhost'; ghost.textContent = p.term ? p.title : 'Empty pane';
      ghost.insertAdjacentHTML('beforeend', '<small>esc to cancel</small>');
      hint = document.createElement('div'); hint.id = 'dropHint';
      document.body.append(hint, ghost);
    }
    ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 10 + 'px';
    clear(); target = null;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const tabEl = under?.closest('.tab');
    if (tabEl) {
      const i = tabEls().indexOf(tabEl);
      if (i >= 0 && i !== state.active) { tabEl.classList.add('drop-target'); target = { tab: i }; }
      return;
    }
    // anywhere else on the tab bar: make it its own tab
    if (under?.closest('#tabbar')) {
      if (leaves(tab().root).length > 1) { $('#tabbar').classList.add('drop-newtab'); target = { newTab: true }; }
      return;
    }
    const p = paneAt(under || document.body);
    if (!p || p.key === key || tabOf(p.key) !== state.active) return;
    const r = p.el.getBoundingClientRect(), z = dropZone(r, ev.clientX, ev.clientY), zr = zoneRect(r, z);
    Object.assign(hint.style, { display: 'block', left: zr.left + 'px', top: zr.top + 'px', width: zr.width + 'px', height: zr.height + 'px' });
    target = { key: p.key, zone: z };
  };
  const end = () => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up); noEsc();
    if (!dragging) return false;
    document.body.classList.remove('pane-dragging'); panes.get(key)?.el.classList.remove('drag-src');
    ghost.remove(); hint.remove(); clear();
    return true;
  };
  const up = () => { if (end() && target) dropPane(key, target); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}
function dropPane(key, target) {
  const from = tabOf(key); if (from < 0) return;
  const t = state.tabs[from];
  if (target.newTab) {   // pull it out into a tab of its own, right after this one
    if (leaves(t.root).length < 2) return;
    t.root = remove(t.root, key);
    if (t.focus === key) t.focus = leaves(t.root)[0];
    if (t.zoom === key) t.zoom = null;
    state.tabs.splice(from + 1, 0, { id: 't' + seq++, root: leaf(key), focus: key, zoom: null });
    state.active = from + 1;
    render();
    return;
  }
  if (target.tab != null) {   // move into another tab, split beside its focused pane
    const dest = state.tabs[target.tab];
    if (leaves(t.root).length === 1) state.tabs.splice(from, 1);
    else { t.root = remove(t.root, key); if (t.focus === key) t.focus = leaves(t.root)[0]; }
    const dk = dest.focus;
    const r = panes.get(dk).el.getBoundingClientRect();
    dest.root = replace(dest.root, dk, (n) => ({ kind: 'split', dir: r.width / 2 > r.height * 1.1 ? 'h' : 'v', a: n, b: leaf(key), ratio: 0.5 }));
    dest.focus = key; dest.zoom = null;
    state.active = state.tabs.indexOf(dest);
    render();
    return;
  }
  const other = target.key;
  if (target.zone === 'swap') {
    const sw = (n) => n.kind === 'pane' ? (n.key === key ? leaf(other) : n.key === other ? leaf(key) : n) : { ...n, a: sw(n.a), b: sw(n.b) };
    t.root = sw(t.root);
  } else {
    const before = target.zone === 'left' || target.zone === 'top';
    t.root = remove(t.root, key);
    t.root = replace(t.root, other, (n) => ({ kind: 'split', dir: target.zone === 'left' || target.zone === 'right' ? 'h' : 'v',
      a: before ? leaf(key) : n, b: before ? n : leaf(key), ratio: 0.5 }));
  }
  t.focus = key;
  render();
}

// ---------- keyboard shortcuts window ----------
const SHORTCUTS = [
  ['Sessions', [
    ['New Claude session', '⌘N', 'Ctrl+Shift+N'], ['Find session', '⌘P', 'Ctrl+Shift+P'],
    ['Rename session', '⇧⌘R', 'Ctrl+Shift+R'], ['Save tab as group', '⇧⌘S', 'Ctrl+Shift+S'], ['Toggle sidebar', '⌘B', 'Ctrl+Shift+B']]],
  ['Panes', [
    ['Split right (side by side)', '⌘D', 'Ctrl+Shift+D'], ['Split down (stacked)', '⇧⌘D', 'Ctrl+Shift+E'],
    ['Move between panes', '⌥ ←→↑↓', 'Alt ←→↑↓'], ['Next / previous pane', '⌘] / ⌘[', 'Ctrl+Shift+] / ['],
    ['Maximize pane', '⇧⌘↵', 'Ctrl+Shift+Enter'], ['Close pane', '⌘W', 'Ctrl+Shift+W']]],
  ['Tabs', [
    ['New tab', '⌘T', 'Ctrl+Shift+T'], ['Next / previous tab', '⇧⌘] / ⇧⌘[', 'Ctrl+Tab / Ctrl+Shift+Tab'],
    ['Go to tab 1–9', '⌘1–9', 'Ctrl+1–9'], ['Close tab', '⇧⌘W', 'Ctrl+Shift+Q']]],
  ['Text', [
    ['Bigger / smaller / reset text', '⌘= / ⌘- / ⌘0', 'Ctrl+= / Ctrl+- / Ctrl+0'],
    ['Copy / paste', '⌘C / ⌘V', 'Ctrl+Shift+C / Ctrl+Shift+V']]],
  ['App', [['Settings', '⌘,', 'Ctrl+,'], ['This window', '⌘/', 'Ctrl+Shift+/']]],
];
function toggleShortcuts(show = $('#shortcuts').classList.contains('hidden')) {
  const m = $('#shortcuts');
  if (!show) { m.classList.add('hidden'); tab() && panes.get(tab().focus)?.term?.focus(); return; }
  $('#scList').innerHTML = SHORTCUTS.map(([h, rows]) => `<h4>${h}</h4>` + rows.map(([label, mac, win]) =>
    `<div class="sc"><span>${esc(label)}</span><span>${(IS_MAC ? mac : win).split(' / ').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</span></div>`).join('')).join('');
  m.classList.remove('hidden');
  m.tabIndex = -1; m.focus();
}
$('#shortcuts').addEventListener('mousedown', (e) => { if (e.target.id === 'shortcuts') toggleShortcuts(false); });
$('#scClose').addEventListener('click', () => toggleShortcuts(false));
$('#shortcuts').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggleShortcuts(false); } });

// ---------- drag & drop files into a pane (types the escaped path, like iTerm) ----------
const shellQuote = (s) => s.replace(/([^A-Za-z0-9_\-.,:\/@%+=])/g, '\\$1');
const paneAt = (target) => { const el = target.closest?.('.pane'); return el && [...panes.values()].find((p) => p.el === el); };
let dropEl = null;
const setDrop = (el) => { if (dropEl === el) return; dropEl?.classList.remove('dropping'); dropEl = el; el?.classList.add('dropping'); };
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  const p = paneAt(e.target);
  e.dataTransfer.dropEffect = p?.ptyId != null ? 'copy' : 'none';
  setDrop(p?.ptyId != null ? p.el : null);
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) setDrop(null); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); setDrop(null);
  const p = paneAt(e.target); if (!p || p.ptyId == null) return;
  const files = [...e.dataTransfer.files].map((f) => D.filePath(f)).filter(Boolean);
  const text = files.length ? files.map(shellQuote).join(' ') + ' ' : e.dataTransfer.getData('text/plain');
  if (!text) return;
  focusPane(p.key);
  D.ptyWrite(p.ptyId, text);
});
window.addEventListener('focus', () => { const p = tab() && panes.get(tab().focus); if (p?.attn) { p.attn = false; updatePaneHead(p); renderTabs(); } });

document.body.classList.add(IS_MAC ? 'mac' : 'win');
if (!IS_MAC) for (const el of document.querySelectorAll('[title],[placeholder]')) for (const a of ['title', 'placeholder'])
  if (el.getAttribute(a)) el.setAttribute(a, el.getAttribute(a).replace(/⇧?⌘[A-Z↵\/,]/g, kb));

(async () => {
  applySidebar();
  try { await loadSessions(); } catch {}
  const r = await D.takeRestore();
  if (r?.layout) { store.set('layout', r.layout); }
  if (r?.groups) { store.set('groups', r.groups); state.groups = r.groups; }
  restoreLayout();
  setInterval(refresh, 2000);
})();
