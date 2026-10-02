// UniBrowse config — all user-changeable settings live here.
// Stored as JSON (app config dir / config.json). To add a setting:
//   1. add a default in DEFAULTS   2. add a field in SCHEMA (the settings tab is generated from it)
//   3. read it with Config.get('section.key')  — and react in Config.onChange / apply() if needed.
const Config = (() => {
  const { invoke } = window.__TAURI__.core;

  const DEFAULTS = {
    appearance: {
      bg: '#1f1a14', panel: '#2a231b', panel2: '#362d22', line: '#4b3f30',
      text: '#eadfcc', dim: '#a89a82', accent: '#c99a3f', danger: '#c4694a',
      fontSize: 13, sidebarWidth: 220,
    },
    behavior: {
      startKind: 'files',      // kind of tab opened by Ctrl+T / ＋ / at startup
      homepage: 'https://www.google.com',
      searchEngine: 'https://www.google.com/search?q=%s',
      startPath: '',           // empty = home folder
      downloadDir: '',         // empty = OS Downloads folder
      showHidden: false,
      sidebarVisible: true,
    },
    bookmarks: [],           // [{id, kind:'web'|'files', title, url|path}] — managed from the sidebar
    shortcuts: {
      newTab: 'Ctrl+T', closeTab: 'Ctrl+W', fullscreen: 'F11',
    },
  };

  const KINDS = [['files', 'フォルダ'], ['web', 'Web'], ['app', 'アプリ取り込み']];
  const SCHEMA = [
    { title: '外観', fields: [
      { path: 'appearance.accent', label: 'アクセント色（黄土色）', type: 'color' },
      { path: 'appearance.bg', label: '背景色', type: 'color' },
      { path: 'appearance.panel', label: 'パネル色', type: 'color' },
      { path: 'appearance.panel2', label: 'パネル色（ホバー）', type: 'color' },
      { path: 'appearance.line', label: '罫線・スクロールバー色', type: 'color' },
      { path: 'appearance.text', label: '文字色', type: 'color' },
      { path: 'appearance.dim', label: '補助文字色', type: 'color' },
      { path: 'appearance.danger', label: '警告色（赤土色）', type: 'color' },
      { path: 'appearance.fontSize', label: '文字サイズ (px)', type: 'number', min: 10, max: 22 },
      { path: 'appearance.sidebarWidth', label: 'サイドバー幅 (px)', type: 'number', min: 140, max: 400 },
    ] },
    { title: '動作', fields: [
      { path: 'behavior.startKind', label: '新しいタブの種類', type: 'select', options: KINDS },
      { path: 'behavior.homepage', label: 'Webのホームページ', type: 'text' },
      { path: 'behavior.searchEngine', label: '検索エンジン（%s が検索語）', type: 'text' },
      { path: 'behavior.startPath', label: 'フォルダの開始位置（空=ホーム）', type: 'text' },
      { path: 'behavior.downloadDir', label: 'ダウンロード先（空=ダウンロードフォルダ）', type: 'text' },
      { path: 'behavior.showHidden', label: '隠しファイル（.で始まる）を表示', type: 'bool' },
      { path: 'behavior.sidebarVisible', label: 'サイドバーを表示', type: 'bool' },
    ] },
    { title: 'ショートカット', fields: [
      { path: 'shortcuts.newTab', label: '新しいタブ', type: 'text' },
      { path: 'shortcuts.closeTab', label: 'タブを閉じる', type: 'text' },
      { path: 'shortcuts.fullscreen', label: '全画面', type: 'text' },
    ] },
  ];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  let data = clone(DEFAULTS);
  const listeners = new Set();

  function merge(base, over) {   // only keys known to DEFAULTS, same type
    for (const k of Object.keys(base)) {
      if (!(k in (over || {}))) continue;
      if (Array.isArray(base[k])) { if (Array.isArray(over[k])) base[k] = over[k]; }
      else if (base[k] && typeof base[k] === 'object') merge(base[k], over[k]);
      else if (typeof over[k] === typeof base[k]) base[k] = over[k];
    }
    return base;
  }
  const walk = (path) => path.split('.');
  function get(path) { return walk(path).reduce((o, k) => o?.[k], data); }

  let timer;
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => invoke('config_save', { json: JSON.stringify(data, null, 2) })
      .catch(e => console.error('config save failed', e)), 300);
  };

  function apply() {
    const a = data.appearance, s = document.documentElement.style;
    for (const k of ['bg', 'panel', 'panel2', 'line', 'text', 'dim', 'accent', 'danger']) s.setProperty('--' + k, a[k]);
    s.setProperty('--fs', a.fontSize + 'px');
    s.setProperty('--sidebar-w', a.sidebarWidth + 'px');
    document.getElementById('sidebar')?.classList.toggle('collapsed', !data.behavior.sidebarVisible);
  }

  function set(path, value) {
    const ks = walk(path), last = ks.pop();
    ks.reduce((o, k) => o[k], data)[last] = value;
    apply(); saveSoon();
    listeners.forEach(f => f(path, value));
  }

  async function load() {
    try {
      const raw = await invoke('config_load');
      if (raw) data = merge(clone(DEFAULTS), JSON.parse(raw));
    } catch (e) { console.error('config load failed (using defaults)', e); }
    apply();
  }

  function reset() { const bm = data.bookmarks; data = clone(DEFAULTS); data.bookmarks = bm; apply(); saveSoon(); listeners.forEach(f => f('*')); }

  // "Ctrl+Shift+T" style matcher
  function matches(e, combo) {
    const parts = String(combo).split('+').map(s => s.trim().toLowerCase());
    const key = parts.pop();
    return e.ctrlKey === parts.includes('ctrl') && e.shiftKey === parts.includes('shift')
      && e.altKey === parts.includes('alt') && e.key.toLowerCase() === key;
  }

  return { DEFAULTS, SCHEMA, get, set, load, reset, apply, matches, path: () => invoke('config_path'),
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f); } };
})();
