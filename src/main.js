// UniBrowse frontend — no bundler, uses window.__TAURI__ (withGlobalTauri).
const { invoke } = window.__TAURI__.core;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
let uid = 0;
const nextId = () => ++uid;

/** node = {t:'pane', id, kind:'web'|'files'|'app', ...} | {t:'split', dir:'h'|'v', a, b, ratio} */
const state = { tabs: [], active: null };
const $ = (s, el = document) => el.querySelector(s);
const workspace = $('#workspace');
const native = new Map(); // pane.id -> {created:boolean}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k.startsWith('data-')) e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const k of kids) e.append(k);
  return e;
}

// ------------------------------------------------------------------
// Icons — single-colour inline SVG (stroke = currentColor)
// ------------------------------------------------------------------
const ICONS = {
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  'split-h': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
  'split-v': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  reload: '<path d="M20 5v5h-5"/><path d="M19.5 10A8 8 0 1 0 20 13"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>',
  drive: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M5.5 14L8 5h8l2.5 9"/><circle cx="7.5" cy="17" r=".6"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 9"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  archive: '<path d="M6 3h12v18H6z"/><path d="M12 3v4M12 9v2M12 13v2"/>',
  text: '<path d="M6 3h8l5 5v13H6z"/><path d="M9 13h7M9 17h7"/>',
};
const FILE_ICON = {
  image: 'png jpg jpeg gif webp bmp svg ico',
  code: 'js ts jsx tsx rs py html css json java c cpp h cs go php sh ps1 toml yaml yml xml',
  archive: 'zip rar 7z tar gz',
  text: 'txt md log csv pdf doc docx',
};
function icon(name) {
  const s = el('span', { class: 'ico' });
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return s;
}
function fileIcon(e) {
  if (e.is_dir) return 'folder';
  const ext = (e.name.split('.').pop() || '').toLowerCase();
  return Object.keys(FILE_ICON).find(k => FILE_ICON[k].split(' ').includes(ext)) || 'file';
}
document.querySelectorAll('[data-icon]').forEach(s => s.replaceWith(icon(s.dataset.icon)));

// ------------------------------------------------------------------
// Tree helpers
// ------------------------------------------------------------------
function* panes(node) {
  if (!node) return;
  if (node.t === 'pane') yield node;
  else { yield* panes(node.a); yield* panes(node.b); }
}
function replaceNode(tab, target, replacement) {
  if (tab.root === target) { tab.root = replacement; return; }
  (function walk(n) {
    if (!n || n.t !== 'split') return;
    if (n.a === target) n.a = replacement;
    else if (n.b === target) n.b = replacement;
    else { walk(n.a); walk(n.b); }
  })(tab.root);
}
const activeTab = () => state.tabs.find(t => t.id === state.active);
const selectedPane = (tab) => [...panes(tab.root)].find(p => p.id === tab.selected);

async function homeDir() { return invoke('home_dir'); }

async function makePane(kind, from) {
  const p = { t: 'pane', id: nextId(), kind };
  if (kind === 'web') p.url = from?.url || Config.get('behavior.homepage');
  if (kind === 'files') p.path = from?.path || Config.get('behavior.startPath') || await homeDir();
  if (kind === 'app') p.hwnd = null;
  if (from?.saveFor) { p.saveFor = from.saveFor; p.saveName = from.saveName; } // "choose save folder" pane
  return p;
}

// ------------------------------------------------------------------
// Tabs
// ------------------------------------------------------------------
async function newTab(kind = Config.get('behavior.startKind'), from, bookmarkId) {
  const pane = await makePane(kind, from);
  const tab = { id: nextId(), title: 'タブ', root: pane, selected: pane.id, bookmarkId };
  state.tabs.push(tab);
  state.active = tab.id;
  render();
}

function closeTab(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  for (const p of panes(state.tabs[i].root)) disposePane(p);
  state.tabs.splice(i, 1);
  if (!state.tabs.length) { newTab(); return; }
  if (state.active === id) state.active = state.tabs[Math.max(0, i - 1)].id;
  render();
}

// ---- Bookmarks (stored in config.json; each opens at most one tab, Arc-style) ----
const bookmarks = () => Config.get('bookmarks');
function openBookmark(b) {
  const t = state.tabs.find(t => t.bookmarkId === b.id);
  if (t) { state.active = t.id; render(); }
  else newTab(b.kind, b.kind === 'web' ? { url: b.url } : { path: b.path }, b.id);
}
function removeBookmark(b) {
  state.tabs.forEach(t => { if (t.bookmarkId === b.id) t.bookmarkId = undefined; });
  Config.set('bookmarks', bookmarks().filter(x => x.id !== b.id));
  renderTabs();
}
function toggleBookmark() {
  const tab = activeTab(), p = tab && selectedPane(tab);
  if (!p || (p.kind !== 'web' && p.kind !== 'files')) return;
  const key = p.kind === 'web' ? 'url' : 'path';
  const old = bookmarks().find(b => b.kind === p.kind && b[key] === p[key]);
  if (old) { removeBookmark(old); return; }
  const title = p.kind === 'web' ? (() => { try { return new URL(p.url).hostname; } catch { return p.url; } })()
    : p.path.split(/[\\/]/).filter(Boolean).pop() || p.path;
  const b = { id: Date.now().toString(36), kind: p.kind, title, [key]: p[key] };
  Config.set('bookmarks', [...bookmarks(), b]);
  tab.bookmarkId = b.id;
  renderTabs();
}
function showMenu(x, y, items) {
  document.querySelector('.ctxmenu')?.remove();
  const m = el('div', { class: 'ctxmenu' }, ...items.map(([label, fn]) =>
    el('div', { textContent: label, onclick: () => { m.remove(); fn(); } })));
  m.style.left = x + 'px'; m.style.top = y + 'px';
  document.body.append(m);
  const close = (e) => { if (m.contains(e.target)) return; m.remove(); window.removeEventListener('pointerdown', close, true); };
  setTimeout(() => window.addEventListener('pointerdown', close, true));
}
function renameBookmark(b, titleEl) {
  const input = el('input', { class: 'title-edit', value: b.title, spellcheck: false });
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== b.title)
      Config.set('bookmarks', bookmarks().map(x => x.id === b.id ? { ...x, title: v } : x));
    renderTabs();
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  titleEl.replaceWith(input);
  input.focus(); input.select();
}
function renderBookmarks() {
  const box = $('#bookmarks'), list = bookmarks();
  box.hidden = $('#side-sep').hidden = !list.length;
  box.replaceChildren(...list.map(b => {
    const t = state.tabs.find(t => t.bookmarkId === b.id);
    const row = el('div', { class: 'tab bm' + (t ? ' open' : '') + (t && t.id === state.active ? ' active' : ''),
      title: (b.url || b.path) + '\n右クリックでブックマークを削除', onclick: () => openBookmark(b),
      oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [
        ['名前を変更', () => renameBookmark(b, row.querySelector('.title'))],
        ['ブックマークを削除', () => removeBookmark(b)]]); } },
      el('span', { class: 'icons' }, icon(b.kind === 'web' ? 'globe' : 'folder')),
      el('span', { class: 'title', textContent: b.title }),
      el('span', { class: 'x', title: '閉じる（ブックマークは残り、次は初期状態で開きます）',
        onclick: (e) => { e.stopPropagation(); if (t) closeTab(t.id); } }, icon('close')));
    return row;
  }));
}

function renderTabs() {
  renderBookmarks();
  const box = $('#tabs');
  box.replaceChildren();
  state.tabs.forEach((t, i) => {
    if (t.bookmarkId) return; // shown in the bookmark section
    const list = [...panes(t.root)];
    const icons = list.map(p => icon({ web: 'globe', files: 'folder', app: 'window', settings: 'settings' }[p.kind]));
    const tabEl = el('div', { class: 'tab' + (t.id === state.active ? ' active' : ''),
      title: tabTitle(t, i),
      onclick: () => { state.active = t.id; render(); } },
      el('span', { class: 'icons' }, ...icons),
      el('span', { class: 'title', textContent: tabTitle(t, i) }),
      el('span', { class: 'x', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon('close')));
    box.append(tabEl);
  });
}

// Label for the vertical tab: describes the selected (or first) pane.
function tabTitle(t, i) {
  const list = [...panes(t.root)];
  const p = list.find(x => x.id === t.selected) || list[0];
  if (!p) return `タブ ${i + 1}`;
  let s = '';
  if (p.kind === 'web') { try { s = new URL(p.url).hostname; } catch { s = p.url; } }
  else if (p.kind === 'files') s = p.path.split(/[\\/]/).filter(Boolean).pop() || p.path;
  else if (p.kind === 'settings') s = '設定';
  else s = p.hwnd ? '取り込み中' : 'アプリ取り込み';
  return list.length > 1 ? `${s} (+${list.length - 1})` : s;
}

// ------------------------------------------------------------------
// Pane lifecycle
// ------------------------------------------------------------------
function disposePane(p) {
  if (p.saveFor) invoke('download_decide', { id: p.saveFor, choice: 'cancel', dir: null }).catch(() => {});
  if (p.kind === 'web' && native.get(p.id)?.created) invoke('web_close', { label: 'web' + p.id });
  if (p.kind === 'app' && p.hwnd) invoke('embed_release', { hwnd: p.hwnd }).catch(() => {});
  native.delete(p.id);
}

async function splitSelected(dir, kind, from) {
  const tab = activeTab();
  const sel = selectedPane(tab);
  const np = await makePane(kind || sel.kind, kind ? from : sel);
  replaceNode(tab, sel, { t: 'split', dir, a: sel, b: np, ratio: 0.5 });
  tab.selected = np.id;
  render();
}

function closeSelected(target) {
  const tab = (target && state.tabs.find(t => [...panes(t.root)].includes(target))) || activeTab();
  const sel = target || selectedPane(tab);
  if (!sel) return;
  disposePane(sel);
  // find parent split and collapse it
  let parent = null;
  (function walk(n) {
    if (!n || n.t !== 'split') return;
    if (n.a === sel || n.b === sel) parent = n; else { walk(n.a); walk(n.b); }
  })(tab.root);
  if (!parent) { closeTab(tab.id); return; }
  const sibling = parent.a === sel ? parent.b : parent.a;
  replaceNode(tab, parent, sibling);
  tab.selected = [...panes(sibling)][0].id;
  render();
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function render() {
  renderTabs();
  workspace.replaceChildren();
  const tab = activeTab();
  if (!tab) return;
  const view = el('div', { class: 'tabview' });
  view.append(renderNode(tab, tab.root));
  workspace.append(view);
  requestAnimationFrame(syncNative);
}

function renderNode(tab, n) {
  if (n.t === 'pane') return renderPane(tab, n);
  const box = el('div', { class: 'split ' + n.dir });
  const a = el('div', { class: 'node' }, renderNode(tab, n.a));
  const b = el('div', { class: 'node' }, renderNode(tab, n.b));
  const g = el('div', { class: 'gutter' });
  const apply = () => { a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0`; };
  apply();
  g.addEventListener('pointerdown', (e) => {
    g.setPointerCapture(e.pointerId);
    const rect = box.getBoundingClientRect();
    const move = (ev) => {
      const r = n.dir === 'h' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      n.ratio = Math.min(0.9, Math.max(0.1, r));
      apply();
      syncNative();
    };
    const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
  box.append(a, g, b);
  return box;
}

function renderPane(tab, p) {
  const box = el('div', { class: 'pane' + (tab.selected === p.id ? ' selected' : '') });
  box.addEventListener('pointerdown', () => {
    if (tab.selected === p.id) return;
    tab.selected = p.id;
    document.querySelectorAll('.pane.selected').forEach(x => x.classList.remove('selected'));
    box.classList.add('selected');
    renderTabs();
  }, true);
  const bar = el('div', { class: 'pane-bar' });
  const body = el('div', { class: 'pane-body' });
  box.append(bar, body);
  if (p.kind === 'web') buildWeb(p, bar, body);
  if (p.kind === 'files') buildFiles(p, bar, body);
  if (p.kind === 'app') buildApp(p, bar, body);
  if (p.kind === 'settings') buildSettings(p, bar, body);
  bar.append(el('button', { class: 'pane-x', title: 'このタブを閉じる',
    onclick: (e) => { e.stopPropagation(); closeSelected(p); } }, icon('close')));
  return box;
}

// ---------------- Web ----------------
function normalizeUrl(s) {
  s = s.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (!/\s/.test(s) && /\.[a-z]{2,}/i.test(s)) return 'https://' + s;
  return Config.get('behavior.searchEngine').replace('%s', encodeURIComponent(s));
}
function buildWeb(p, bar, body) {
  const input = el('input', { value: p.url, spellcheck: false });
  const go = () => {
    p.url = normalizeUrl(input.value);
    input.value = p.url;
    renderTabs();
    if (native.get(p.id)?.created) invoke('web_navigate', { label: 'web' + p.id, url: p.url });
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const act = (a) => () => invoke('web_action', { label: 'web' + p.id, action: a });
  bar.append(el('button', { title: '戻る', onclick: act('back') }, icon('back')),
    el('button', { title: '進む', onclick: act('forward') }, icon('forward')),
    el('button', { title: '再読込', onclick: act('reload') }, icon('reload')), input);
  body.append(el('div', { class: 'placeholder', 'data-pane': p.id }));
}

// ---------------- Files ----------------
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
  : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB';
const fmtDate = (s) => s ? new Date(s * 1000).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';

function buildFiles(p, bar, body) {
  const input = el('input', { value: p.path, spellcheck: false });
  let selectedDir = null; // single-clicked sub-folder (used as the save target in save mode)
  const saveLabel = el('span', { class: 'lbl2' });
  const updSave = () => { saveLabel.textContent = `「${p.saveName}」の保存先: ${selectedDir || p.path}`; };
  const load = async (path) => {
    try {
      const list = await invoke('list_dir', { path });
      p.path = path; input.value = path; selectedDir = null; if (p.saveFor) updSave(); renderTabs();
      const table = el('table', { class: 'filelist' });
      for (const e of list) {
        if (!Config.get('behavior.showHidden') && e.name.startsWith('.')) continue;
        const tr = el('tr', { class: e.is_dir ? 'dir' : '' },
          el('td', { class: 'name' }, icon(fileIcon(e)), e.name),
          el('td', { class: 'size', textContent: e.is_dir ? '' : fmtSize(e.size) }),
          el('td', { class: 'mod', textContent: fmtDate(e.modified) }));
        if (p.saveFor) tr.addEventListener('click', () => {
          table.querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel'));
          selectedDir = e.is_dir ? e.path : null;
          if (e.is_dir) tr.classList.add('sel');
          updSave();
        });
        tr.addEventListener('dblclick', () => e.is_dir ? load(e.path) : invoke('open_path', { path: e.path }));
        table.append(tr);
      }
      body.replaceChildren(list.length ? table : el('div', { class: 'msg', textContent: '（空のフォルダ）' }));
    } catch (err) {
      body.replaceChildren(el('div', { class: 'msg err', textContent: String(err) }));
    }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') load(input.value); });
  bar.append(
    el('button', { title: '上のフォルダ', onclick: async () => {
      const up = await invoke('parent_dir', { path: p.path });
      if (up) load(up); } }, icon('up')),
    el('button', { title: 'ホーム', onclick: async () => load(await homeDir()) }, icon('home')),
    el('button', { title: 'ドライブ', onclick: async () => {
      const d = await invoke('list_drives');
      body.replaceChildren(el('div', { class: 'winlist' },
        ...d.map(x => el('button', { textContent: x, onclick: () => load(x) })))); } }, icon('drive')),
    input);
  if (p.saveFor) {
    const finish = async (choice, dir) => {
      const id = p.saveFor; p.saveFor = null; // disposePane must not cancel it afterwards
      await invoke('download_decide', { id, choice, dir });
      if (choice === 'folder') notice('ダウンロード中: ' + p.saveName);
      closeSelected(p);
    };
    updSave();
    bar.append(el('div', { class: 'save-row' }, saveLabel,
      el('button', { class: 'primary', textContent: '保存', onclick: () => finish('folder', selectedDir || p.path) }),
      el('button', { textContent: 'キャンセル', onclick: () => finish('cancel', null) })));
  }
  load(p.path);
}

// ---------------- Settings (generated from Config.SCHEMA) ----------------
function buildSettings(p, bar, body) {
  const render = () => {
    const root = el('div', { class: 'settings' });
    for (const sec of Config.SCHEMA) {
      root.append(el('h2', { textContent: sec.title }));
      for (const f of sec.fields) {
        const v = Config.get(f.path);
        let input;
        if (f.type === 'select') {
          input = el('select', {}, ...f.options.map(([val, lbl]) => el('option', { value: val, textContent: lbl, selected: val === v })));
          input.addEventListener('change', () => Config.set(f.path, input.value));
        } else if (f.type === 'bool') {
          input = el('input', { type: 'checkbox', checked: v });
          input.addEventListener('change', () => Config.set(f.path, input.checked));
        } else if (f.type === 'number') {
          input = el('input', { type: 'number', value: v, min: f.min, max: f.max });
          input.addEventListener('change', () => {
            const n = Math.min(f.max, Math.max(f.min, Number(input.value) || v));
            input.value = n; Config.set(f.path, n); });
        } else {
          input = el('input', { type: f.type === 'color' ? 'color' : 'text', value: v, spellcheck: false });
          input.addEventListener(f.type === 'color' ? 'input' : 'change', () => Config.set(f.path, input.value));
        }
        root.append(el('div', { class: 'setting' }, el('label', { textContent: f.label }), input));
      }
    }
    body.replaceChildren(root);
  };
  bar.append(el('span', { class: 'pane-title', textContent: '設定（変更は自動で保存されます）' }),
    el('button', { textContent: '設定ファイルを開く', onclick: async () =>
      invoke('open_path', { path: await Config.path() }).catch(err => alert(err)) }),
    el('button', { textContent: '初期値に戻す', onclick: () => { if (confirm('すべての設定を初期値に戻しますか？')) { Config.reset(); render(); } } }));
  render();
}

// ---------------- App (embedded foreign window) ----------------
function buildApp(p, bar, body) {
  if (p.hwnd) {
    bar.append(el('span', { textContent: '取り込み中', class: 'msg' }),
      el('button', { textContent: '取り出す', onclick: async () => {
        await invoke('embed_release', { hwnd: p.hwnd }).catch(() => {});
        p.hwnd = null; native.delete(p.id); render(); } }));
    body.append(el('div', { class: 'placeholder', 'data-pane': p.id }));
    return;
  }
  const listBox = el('div', { class: 'winlist' });
  const refresh = async () => {
    const wins = await invoke('list_windows');
    listBox.replaceChildren(
      el('div', { class: 'msg', textContent: '取り込むウィンドウを選択（Windowsのみ）' }),
      ...wins.map(w => el('button', { textContent: w.title, onclick: () => { p.hwnd = w.hwnd; native.set(p.id, { created: false }); render(); } })));
  };
  bar.append(el('button', { textContent: '一覧を更新', onclick: refresh }));
  body.append(listBox);
  refresh().catch(err => listBox.replaceChildren(el('div', { class: 'msg err', textContent: String(err) })));
}

// ------------------------------------------------------------------
// Native (webview / embedded window) position sync
// ------------------------------------------------------------------
let syncing = false;
let modalOpen = false; // native webviews/windows sit above the page, so hide them while a dialog is shown
function hideAllNative() {
  for (const t of state.tabs) for (const p of panes(t.root)) {
    if (!native.get(p.id)?.created) continue;
    if (p.kind === 'web') invoke('web_visible', { label: 'web' + p.id, visible: false });
    if (p.kind === 'app' && p.hwnd) invoke('embed_visible', { hwnd: p.hwnd, visible: false });
  }
}
async function syncNative() {
  if (modalOpen) { hideAllNative(); return; }
  if (syncing) return; syncing = true;
  try {
    const tab = activeTab();
    const visibleIds = new Set();
    const dpr = window.devicePixelRatio || 1;
    for (const ph of document.querySelectorAll('.placeholder[data-pane]')) {
      const id = Number(ph.dataset.pane);
      const p = [...panes(tab.root)].find(x => x.id === id);
      if (!p) continue;
      visibleIds.add(id);
      const r = ph.getBoundingClientRect();
      if (p.kind === 'web') {
        const label = 'web' + id;
        if (!native.get(id)?.created) {
          native.set(id, { created: true });
          await invoke('web_open', { label, url: p.url, x: r.left, y: r.top, w: r.width, h: r.height })
            .catch(err => { native.set(id, { created: false }); console.error(err); });
        } else {
          await invoke('web_bounds', { label, x: r.left, y: r.top, w: r.width, h: r.height });
          await invoke('web_visible', { label, visible: true });
        }
      } else if (p.kind === 'app' && p.hwnd) {
        const args = { hwnd: p.hwnd, x: Math.round(r.left * dpr), y: Math.round(r.top * dpr),
          w: Math.round(r.width * dpr), h: Math.round(r.height * dpr) };
        if (!native.get(id)?.created) {
          native.set(id, { created: true });
          await invoke('embed_window', args).catch(err => { native.set(id, { created: false }); alert(err); });
        } else {
          await invoke('embed_bounds', args);
          await invoke('embed_visible', { hwnd: p.hwnd, visible: true });
        }
      }
    }
    // hide everything that belongs to non-visible tabs
    for (const t of state.tabs) for (const p of panes(t.root)) {
      if (visibleIds.has(p.id) || !native.get(p.id)?.created) continue;
      if (p.kind === 'web') invoke('web_visible', { label: 'web' + p.id, visible: false });
      if (p.kind === 'app' && p.hwnd) invoke('embed_visible', { hwnd: p.hwnd, visible: false });
    }
  } finally { syncing = false; }
}

new ResizeObserver(() => syncNative()).observe(workspace);
window.addEventListener('resize', () => syncNative());

// ------------------------------------------------------------------
// Toolbar & shortcuts
// ------------------------------------------------------------------
// Downloads started by web panes are saved by the Rust side (on_download); we only report them here.
let noticeTimer;
function notice(text, onclick) {
  const d = $('#drag');
  d.textContent = text; d.classList.add('notice'); d.onclick = onclick || null;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { d.textContent = 'UniBrowse'; d.classList.remove('notice'); d.onclick = null; }, 8000);
}
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const dlQueue = []; let dlBusy = false;
function nextDownload() {
  if (dlBusy || !dlQueue.length) return;
  dlBusy = true;
  showDownloadDialog(dlQueue.shift(), () => { dlBusy = false; nextDownload(); });
}
async function showDownloadDialog(d, done) {
  modalOpen = true; hideAllNative();
  const dir = await invoke('default_download_dir').catch(() => '');
  let overlay;
  const close = () => { window.removeEventListener('keydown', onKey, true); overlay.remove(); modalOpen = false; syncNative(); done(); };
  const decide = (choice) => invoke('download_decide', { id: d.id, choice, dir: null });
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); decide('cancel'); close(); } };
  overlay = el('div', { class: 'overlay' }, el('div', { class: 'dialog' },
    el('h3', { textContent: 'ダウンロード' }),
    el('div', { class: 'dl-name', textContent: d.name }),
    el('div', { class: 'dl-sub', textContent: d.url }),
    el('div', { class: 'dl-sub', textContent: '「ダウンロードに保存」の保存先: ' + dir }),
    el('div', { class: 'dl-actions' },
      el('button', { class: 'primary', textContent: 'ダウンロードに保存', onclick: () => {
        decide('downloads'); notice('ダウンロード中: ' + d.name); close(); } }),
      el('button', { textContent: '選択して保存', onclick: async () => { close(); await openSavePane(d); } }),
      el('button', { textContent: 'キャンセル', onclick: () => { decide('cancel'); close(); } }))));
  window.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}
// "Choose where to save": split the page that started the download and open a folder pane in save mode.
async function openSavePane(d) {
  const wid = Number(String(d.label || '').replace('web', ''));
  const tab = state.tabs.find(t => [...panes(t.root)].some(p => p.id === wid)) || activeTab();
  state.active = tab.id;
  if ([...panes(tab.root)].some(p => p.id === wid)) tab.selected = wid;
  const start = await invoke('default_download_dir').catch(() => '');
  await splitSelected('h', 'files', { path: start || undefined, saveFor: d.id, saveName: d.name });
}
window.__TAURI__.event.listen('download', ({ payload: d }) => {
  if (d.state === 'requested') { dlQueue.push(d); nextDownload(); }
  else if (d.state === 'finished') notice('ダウンロード完了: ' + baseName(d.path) + '（クリックでフォルダを開く）',
    () => invoke('open_path', { path: d.path.replace(/[\\/][^\\/]*$/, '') }).catch(() => {}));
  else if (d.state === 'cancelled') notice('ダウンロードをキャンセルしました: ' + d.name);
  else if (d.state === 'failed') notice('ダウンロードに失敗しました: ' + d.name);
});
const appWin = window.__TAURI__.window.getCurrentWindow();
const toggleFull = async () => appWin.setFullscreen(!(await appWin.isFullscreen()));
$('#win-full').addEventListener('click', toggleFull);
window.addEventListener('keydown', (e) => { if (Config.matches(e, Config.get('shortcuts.fullscreen'))) { e.preventDefault(); toggleFull(); } });
$('#win-min').addEventListener('click', () => appWin.minimize());
$('#win-max').addEventListener('click', () => appWin.toggleMaximize());
$('#win-close').addEventListener('click', () => appWin.close());
$('#new-tab').addEventListener('click', () => newTab());
$('#collapse').addEventListener('click', () => {
  Config.set('behavior.sidebarVisible', $('#sidebar').classList.contains('collapsed'));
  requestAnimationFrame(syncNative); // pane positions shift when the sidebar resizes
});
$('#split-h').addEventListener('click', () => splitSelected('h'));
$('#split-v').addEventListener('click', () => splitSelected('v'));
$('#bookmark-btn').addEventListener('click', toggleBookmark);
$('#open-settings').addEventListener('click', () => {
  const t = state.tabs.find(t => [...panes(t.root)].some(p => p.kind === 'settings'));
  if (t) { state.active = t.id; render(); } else newTab('settings');
});
$('#close-pane').addEventListener('click', () => closeSelected());
document.querySelectorAll('[data-add]').forEach(b =>
  b.addEventListener('click', () => newTab(b.dataset.add)));
window.addEventListener('keydown', (e) => {
  if (Config.matches(e, Config.get('shortcuts.newTab'))) { e.preventDefault(); newTab(); }
  if (Config.matches(e, Config.get('shortcuts.closeTab'))) { e.preventDefault(); closeTab(state.active); }
});

Config.load().then(() => newTab());
