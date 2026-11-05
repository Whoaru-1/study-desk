/* 学习资料工作台 · 应用层 */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const LS_KEY = 'studydesk.v2';
  const LEGACY_KEYS = ['studydesk.v1'];
  const PALETTE = ['#0a84ff', '#5856d6', '#af52de', '#ff375f', '#ff9500', '#30b0c7', '#2fbf5c', '#5ac8fa', '#ff6482', '#8e8e93'];
  const TYPE_COLOR = { pdf: '#ff3b30', md: '#5856d6', docx: '#0a84ff', pptx: '#ff9500', note: '#e0a300', url: '#2fbf5c' };
  const PRI = { high: '高优先', mid: '中优先', low: '低优先' };
  const STATUS = {
    synced: { label: '已备份', cls: 'ok' },
    pending: { label: '待备份', cls: 'pending' },
    local: { label: '仅本机', cls: 'err' }
  };
  const TEXT_EXT = ['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'js', 'css', 'rtf'];

  let state = null;
  let running = false;
  let progress = 0;
  let searchTimer = null;

  /* ---------------- 基础工具 ---------------- */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function colorFor(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
    return PALETTE[h % PALETTE.length];
  }

  function fmtDate(iso) {
    if (!iso) return '从未';
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 86400000;
    if (diff < 0.8) return '今天';
    if (diff < 1.8) return '昨天';
    if (diff < 30) return Math.floor(diff) + ' 天前';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function fmtSize(bytes) {
    const b = bytes || 0;
    if (b < 1024) return (b || 0) + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  function stripMarkup(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`/g, '')
      .replace(/^\s*[-+*]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function shortTitle(t) {
    return String(t).replace(/^第\s*\d+\s*章\s*·\s*/, '').replace(/（.*?）/g, '').trim();
  }

  function daysSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 999; }

  function relTime(iso) {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return fmtDate(iso);
  }

  function toast(msg, icon) {
    const root = $('#toastRoot');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (icon === 'check'
      ? '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.2v4.4M12 15.6v.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>')
      + '<span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 2300);
  }

  /* ---------------- 本地能力（仅 npm start 时可用） ---------------- */
  async function apiHealth() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.local ? d : null;
    } catch (e) { return null; }
  }

  async function apiUpload(file) {
    const r = await fetch('/api/files?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    if (!r.ok) throw new Error('上传失败 HTTP ' + r.status);
    return r.json();
  }

  async function apiPost(path, payload) {
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      return await r.json();
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function isLocalOrigin() {
    const h = location.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  }

  /* 需要先提取正文才能分析的文件类型 */
  const EXTRACT_TYPES = ['pdf', 'docx', 'pptx'];

  async function apiExtract(rel) {
    if (!rel) return null;
    try {
      const r = await fetch('/api/extract?rel=' + encodeURIComponent(rel), { cache: 'no-store' });
      const d = await r.json();
      return d || null;
    } catch (e) { return null; }
  }

  async function probeLocal() {
    /* 非本机地址（GitHub Pages / file://）直接跳过，避免多余的 404 请求 */
    if (!isLocalOrigin()) {
      state.localMode = false;
      state.vault = '';
      updateChrome();
      return;
    }
    const h = await apiHealth();
    state.localMode = !!h;
    state.vault = h && h.vault ? h.vault : '';
    updateChrome();
  }

  /* ---------------- 状态 ---------------- */
  function defaultState() {
    return {
      docs: [],
      tags: [],
      adopted: [],
      analysis: null,
      view: 'overview',
      query: '',
      activeTags: [],
      libraryMode: 'folder',
      folderRule: 'all',
      closedFolders: [],
      sort: 'recent',
      topicsTab: 'topics',
      conceptFilter: 'all',
      graphMode: 'concept',
      graphCoreOnly: false,
      graphFocus: null,
      graphSeed: 0,
      analysisTab: 'summary',
      privacy: false,
      autoBackup: true,
      localMode: false,
      vault: ''
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const base = defaultState();
      const merged = Object.assign(base, s, { docs: Array.isArray(s.docs) ? s.docs : base.docs });
      state = merged;
      normalizeTags();
      return merged;
    } catch (e) {
      return defaultState();
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 存储已满时忽略 */ }
      updateStorageText();
    }, 120);
  }

  function recompute() {
    state.analysis = window.Engine.analyze(state.docs, state.tags);
    save();
  }

  function ensureAnalysis() {
    /* 旧版本存档没有 concepts 字段，加载时补算一次 */
    if (!state.analysis || !state.analysis.insights || !state.analysis.concepts) recompute();
    return state.analysis;
  }

  function docById(id) { return state.docs.filter((d) => d.id === id)[0]; }

  /* ---------------- 标签：注册表 / 配色 / 渲染 ---------------- */
  const TAG_COLORS = ['#0a84ff', '#5856d6', '#af52de', '#ff375f', '#ff9500', '#30b0c7', '#2fbf5c', '#5ac8fa', '#ff6482', '#c9a227', '#8e8e93', '#00a3a3'];
  const UNTAGGED = '未归类';
  const tagId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  function cleanTagName(v) {
    return String(v == null ? '' : v)
      .replace(/[,，、#＃]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
  }

  function tagList() {
    if (!Array.isArray(state.tags)) state.tags = [];
    return state.tags;
  }

  function tagByName(name) {
    return tagList().filter((t) => t.name === name)[0] || null;
  }

  function tagById(id) {
    return tagList().filter((t) => t.id === id)[0] || null;
  }

  /* ---------------- 标签层级：主标签 / 次标签 ----------------
     数据结构：主标签 parentId = null；次标签 parentId 指向主标签 id。
     最多两级（主 → 次），名称全局唯一，因为资料按名称引用标签。 */
  function tagParent(t) {
    if (!t || !t.parentId) return null;
    const p = tagById(t.parentId);
    return p && !p.parentId ? p : null;
  }

  function isSubTag(t) { return !!tagParent(t); }

  function mainTags() {
    return tagList().filter(function (t) { return !t.parentId; });
  }

  function subTagsOf(mainId) {
    return tagList().filter(function (t) { return t.parentId === mainId; });
  }

  function tagPath(t) {
    const p = tagParent(t);
    return p ? p.name + ' / ' + t.name : t.name;
  }

  /* 主标签 + 其次标签，按文件夹资料量排序 */
  function tagTree() {
    const arr = mainTags().map(function (m) {
      const subs = subTagsOf(m.id).sort(function (x, y) {
        return tagUsage(y.name) - tagUsage(x.name) || x.name.localeCompare(y.name, 'zh-Hans-CN');
      });
      return { main: m, subs: subs, count: folderUsage(m) };
    });
    arr.sort(function (a, b) {
      return b.count - a.count || a.main.name.localeCompare(b.main.name, 'zh-Hans-CN');
    });
    return arr;
  }

  /* 文件夹折叠状态按标签 id 记，改名后不会失联 */
  function isFolderClosed(id) {
    return (state.closedFolders || []).indexOf(id) >= 0;
  }

  function shade(hex, k) {
    const n = parseInt(String(hex || '#8e8e93').replace('#', ''), 16);
    const r = Math.round(((n >> 16) & 255) * (1 - k));
    const g = Math.round(((n >> 8) & 255) * (1 - k));
    const b = Math.round((n & 255) * (1 - k));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /* 新标签取当前使用次数最少的颜色，避免整库撞色 */
  function pickTagColor() {
    const used = {};
    tagList().forEach((t) => { used[t.color] = (used[t.color] || 0) + 1; });
    let best = TAG_COLORS[0], bestN = Infinity;
    TAG_COLORS.forEach(function (c) {
      const n = used[c] || 0;
      if (n < bestN) { bestN = n; best = c; }
    });
    return best;
  }

  function tagColor(name) {
    const t = tagByName(name);
    return t ? t.color : colorFor(name);
  }

  function tagUsage(name) {
    return state.docs.filter((d) => (d.tags || []).indexOf(name) >= 0).length;
  }

  /* 文件夹口径：主标签的文件夹包含其所有次标签下的资料 */
  function folderUsage(tag) {
    if (!tag) return 0;
    if (tag.parentId) return tagUsage(tag.name);
    const subs = subTagsOf(tag.id).map(function (s) { return s.name; });
    if (!subs.length) return tagUsage(tag.name);
    return state.docs.filter(function (d) {
      const tags = d.tags || [];
      return tags.indexOf(tag.name) >= 0 || tags.some(function (x) { return subs.indexOf(x) >= 0; });
    }).length;
  }

  function ensureTag(name, color, parentId) {
    const clean = cleanTagName(name);
    if (!clean) return null;
    let t = tagByName(clean);
    if (!t) {
      t = {
        id: tagId(), name: clean, color: color || pickTagColor(), parentId: parentId || null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      tagList().push(t);
    }
    return t;
  }

  /* 迁移 / 自愈：补登记、去重、清理非法名称与颜色，并修复层级 */
  function normalizeTags() {
    if (!Array.isArray(state.tags)) state.tags = [];
    if (!Array.isArray(state.closedFolders)) state.closedFolders = [];
    if (!Array.isArray(state.activeTags)) state.activeTags = [];
    if (state.libraryMode !== 'list') state.libraryMode = 'folder';
    if (state.folderRule !== 'primary') state.folderRule = 'all';

    const seen = {};
    const list = [];
    state.tags.forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      const name = cleanTagName(t.name);
      if (!name || seen[name]) return;
      seen[name] = 1;
      list.push({
        id: t.id || tagId(),
        name: name,
        color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '',
        parentId: typeof t.parentId === 'string' && t.parentId ? t.parentId : null,
        createdAt: t.createdAt || new Date().toISOString(),
        updatedAt: t.updatedAt || t.createdAt || new Date().toISOString()
      });
    });
    state.tags = list;

    /* 层级自愈：父级必须存在、必须是主标签；出现三级时把中间层提为主标签 */
    const byId = {};
    list.forEach(function (t) { byId[t.id] = t; });
    list.forEach(function (t) {
      if (!t.parentId) return;
      const p = byId[t.parentId];
      if (!p || p === t) { t.parentId = null; return; }
      if (p.parentId) p.parentId = null;
    });

    state.docs.forEach(function (d) {
      const out = [];
      (d.tags || []).forEach(function (raw) {
        const name = cleanTagName(raw);
        if (name && out.indexOf(name) < 0) out.push(name);
      });
      d.tags = out;
    });

    state.tags.forEach(function (t) { if (!t.color) t.color = pickTagColor(); });
    state.docs.forEach(function (d) { d.tags.forEach(function (n) { ensureTag(n); }); });
    state.activeTags = state.activeTags.filter(function (n) { return n === UNTAGGED || !!tagByName(n); });

    /* 旧版折叠状态按名称保存，这里换成标签 id */
    state.closedFolders = state.closedFolders.map(function (k) {
      const old = tagByName(k);
      return old ? old.id : k;
    }).filter(function (k) { return !!byId[k]; });
  }

  function tagChip(name, opt) {
    opt = opt || {};
    const isAll = name === '全部';
    const isUn = name === UNTAGGED || isAll;
    const c = isUn ? '#8e8e93' : tagColor(name);
    const fg = shade(c, opt.on ? 0.04 : 0.14);
    let style = 'background:' + hexA(c, opt.on ? 0.20 : 0.11) + ';color:' + fg;
    if (opt.on) style += ';box-shadow:inset 0 0 0 1px ' + hexA(c, 0.32);
    const inner = (opt.dot === false ? '' : '<i class="tg-dot" style="background:' + c + '"></i>') +
      '<span>' + esc(name) + '</span>' +
      (opt.count != null ? '<em>' + opt.count + '</em>' : '');
    /* 次标签统一带一个层级记号，筛选条、资料行、主题卡都一致 */
    const tagObj = isUn ? null : tagByName(name);
    const cls = 'tag tg' + (opt.on ? ' on' : '') + (tagObj && tagObj.parentId ? ' tg-sub' : '') +
      (opt.cls ? ' ' + opt.cls : '');
    if (opt.act) {
      const dataAttr = opt.act === 'topic'
        ? ' data-topic="' + esc(name) + '"'
        : (isAll ? ' data-tag=""' : ' data-tag="' + esc(name) + '"');
      return '<button class="' + cls + '" data-act="' + opt.act + '"' + dataAttr +
        (opt.id ? ' data-id="' + opt.id + '"' : '') +
        ' style="' + style + (opt.style ? ';' + opt.style : '') + '">' + inner + '</button>';
    }
    return '<span class="' + cls + '" style="' + style + '">' + inner + '</span>';
  }

  /* ---------------- 图表 ---------------- */
  function donut(segs, total, centerLabel) {
    const R = 52, C = 2 * Math.PI * R;
    let off = 0;
    const rings = segs.map((s) => {
      const len = total ? (s.value / total) * C : 0;
      const dash = Math.max(len - 4, 0.5) + ' ' + C;
      const el = '<circle cx="66" cy="66" r="' + R + '" fill="none" stroke="' + s.color +
        '" stroke-width="13" stroke-dasharray="' + dash + '" stroke-dashoffset="' + (-off) +
        '" stroke-linecap="round"/>';
      off += len;
      return el;
    }).join('');
    return '<div class="donut"><svg viewBox="0 0 132 132">' +
      '<circle cx="66" cy="66" r="52" fill="none" stroke="rgba(120,120,128,.10)" stroke-width="13"/>' +
      rings + '</svg><div class="donut-center"><b>' + total + '</b><small>' + esc(centerLabel) + '</small></div></div>';
  }

  function ring(pct, color) {
    const C = 2 * Math.PI * 18;
    const dash = (C * pct) / 100;
    return '<div class="ring"><svg viewBox="0 0 44 44">' +
      '<circle cx="22" cy="22" r="18" fill="none" stroke="rgba(120,120,128,.13)" stroke-width="3.6"/>' +
      '<circle cx="22" cy="22" r="18" fill="none" stroke="' + color + '" stroke-width="3.6" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash + ' ' + C + '"/></svg><b>' + pct + '%</b></div>';
  }

  function docRow(d, opt) {
    opt = opt || {};
    const meta = window.TYPE_META[d.type] || window.TYPE_META.note;
    const st = STATUS[(d.backup && d.backup.state) || 'local'] || STATUS.local;
    const ins = state.analysis && state.analysis.insights[d.id];
    const q = state.query.trim();
    let snippet = '';
    if (q && d.content) {
      const idx = d.content.toLowerCase().indexOf(q.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 34);
        snippet = '<div class="doc-snippet">…' + esc(d.content.slice(start, idx)) +
          '<mark>' + esc(d.content.substr(idx, q.length)) + '</mark>' +
          esc(d.content.slice(idx + q.length, idx + q.length + 46)) + '…</div>';
      }
    }
    const tagLine = buildDocTags(d, opt);
    /* 摘要直接落在资料卡上：导入后即刻可见，不用点进详情 */
    const summary = ins && !ins.needsText && ins.tldr
      ? '<span class="doc-sum">' + esc(ins.tldr) + '</span>'
      : '';

    return '<button class="doc" data-act="doc" data-id="' + d.id + '"' +
      (d.tags && d.tags.length ? ' title="标签：' + esc(d.tags.join('、')) + '"' : '') + '>' +
      '<span class="doc-ico" style="background:' + meta.color + ';color:#fff">' +
      (opt.showType === false ? '' : meta.short) + '</span>' +
      '<span class="doc-main">' +
        '<span class="doc-title">' + esc(d.title) + '</span>' +
        '<span class="doc-meta"><span>' + meta.label + '</span><i></i><span>' + fmtDate(d.updatedAt) + '</span>' +
        (ins ? '<i></i><span>重要度 ' + ins.importance + '</span>' : '') +
        '</span>' +
        summary +
        snippet +
        tagLine +
      '</span>' +
      '<span class="doc-right">' +
        (opt.hideStatus ? '' : '<span class="status ' + st.cls + '"><i></i>' + st.label + '</span>') +
        '<svg class="chev" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</span></button>';
  }

  /* 资料行里的标签：文件夹模式下弱化当前文件夹标签，并提示多标签归属 */
  function buildDocTags(d, opt) {
    opt = opt || {};
    const tags = d.tags || [];
    if (opt.folderTag) {
      const others = tags.filter((t) => t !== opt.folderTag && t !== UNTAGGED);
      if (!others.length) return '';
      const ft = tagByName(opt.folderTag);
      const parentName = ft && ft.parentId ? ((tagById(ft.parentId) || {}).name || '') : '';
      const onlyParent = parentName && others.length === 1 && others[0] === parentName;
      const note = onlyParent
        ? '所属主标签'
        : (state.folderRule === 'primary' ? '另有 ' + others.length + ' 个标签' : '同属 ' + tags.length + ' 个文件夹');
      return '<span class="doc-tags">' +
        others.slice(0, 2).map((t) => tagChip(t)).join('') +
        (others.length > 2 ? '<span class="tag n">+' + (others.length - 2) + '</span>' : '') +
        '<span class="doc-multi">' + note + '</span></span>';
    }
    if (!tags.length) return '<span class="doc-tags"><span class="tag n">未打标签</span></span>';
    return '<span class="doc-tags">' +
      tags.slice(0, 4).map((t) => tagChip(t)).join('') +
      (tags.length > 4 ? '<span class="tag n">+' + (tags.length - 4) + '</span>' : '') + '</span>';
  }

  function emptyLibrary() {
    return '<div class="card reveal" style="padding:0">' +
      '<div class="empty" style="padding:64px 24px 56px">' +
        '<svg viewBox="0 0 24 24" fill="none" style="width:44px;height:44px"><path d="M4 7.5C4 6.1 5.1 5 6.5 5h3.2c.7 0 1.4.3 1.9.8l.9.9c.3.3.7.5 1.1.5h4c1.4 0 2.5 1.1 2.5 2.5v7.2c0 1.4-1.1 2.6-2.5 2.6h-10C5.1 19.5 4 18.3 4 16.9V7.5Z" stroke="currentColor" stroke-width="1.5"/></svg>' +
        '<b style="font-size:15px;color:var(--label)">资料库还是空的</b>' +
        '<p style="margin-top:6px">导入第一份资料，学习 Agent 会自动提炼主题、识别缺口并给出复习安排。</p>' +
        '<div style="display:flex;gap:8px;justify-content:center;margin-top:18px">' +
          '<button class="btn btn-primary" data-act="import-open" style="justify-content:center">导入资料</button>' +
          (state.localMode ? '<button class="btn btn-ghost" data-act="open-folder">打开资料文件夹</button>' : '') +
        '</div>' +
        (state.localMode
          ? '<p style="margin-top:14px;font-size:11.5px;color:var(--label-3)">原件会存入 ' + esc(state.vault) + '，导入后可在访达中直接打开</p>'
          : '<p style="margin-top:14px;font-size:11.5px;color:var(--label-3)">用 <b>npm start</b> 本地运行后，可把原件存入访达目录并直接打开</p>') +
      '</div></div>';
  }

  /* ---------------- 视图：总览 ---------------- */
  function viewOverview() {
    if (!state.docs.length) return emptyLibrary();
    const a = ensureAnalysis();
    const s = a.stats;
    const total = state.docs.length || 1;
    const recentCount = state.docs.filter((d) => (Date.now() - new Date(d.createdAt).getTime()) / 86400000 < 7).length;
    const backupPct = Math.round((s.backedUp / total) * 100);

    const typeSegs = Object.keys(s.typeDist).map((k) => ({
      name: (window.TYPE_META[k] || { label: k }).label,
      value: s.typeDist[k],
      color: TYPE_COLOR[k] || colorFor(k)
    })).sort((x, y) => y.value - x.value);

    const tagSegs = (a.coreTopics && a.coreTopics.length ? a.coreTopics : a.topics).slice(0, 6);
    const maxTag = Math.max.apply(null, tagSegs.map((t) => t.count).concat([1]));

    const recent = state.docs.slice().sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt)).slice(0, 5);
    const topGaps = a.gaps.slice(0, 2);
    const topSug = a.suggestions[0];
    const adopted = state.adopted.map((id) => a.suggestions.filter((x) => x.id === id)[0]).filter(Boolean);

    return '<div class="stats">' +
        statCard('资料总数', state.docs.length, '篇', '本周新增 ' + recentCount + ' 篇', '#0a84ff', 'M5 6h5v14H5zM11 6h4v14h-4z') +
        statCard('主题标签', s.tagCount, '个', s.coreCount + ' 个核心 · ' + s.tailCount + ' 个长尾', '#5856d6', 'm12 3 8 4.5-8 4.5-8-4.5L12 3Z') +
        statCard('备份完整度', backupPct, '%', s.unsynced ? s.unsynced + ' 篇待备份' : '全部已备份', '#2fbf5c', 'M7 18.5h9.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 7.2 10.6 4 4 0 0 0 7 18.5Z') +
        statCard('主题覆盖度', s.avgCoverage, '%', '按资料密度与类型加权', '#ff9500', 'M4 19V9m5 10V5m5 14v-7m5 7V8') +
      '</div>' +

      '<div class="two-col">' +
        '<div class="card reveal">' +
          '<div class="card-head"><div class="card-title"><span class="dot"></span>资料类型分布</div>' +
            '<span class="card-sub">共 ' + state.docs.length + ' 篇</span></div>' +
          '<div class="donut-wrap">' + donut(typeSegs, state.docs.length, '篇资料') +
            '<div class="legend">' + typeSegs.map((t) =>
              '<div class="legend-row"><i style="background:' + t.color + '"></i><span>' + esc(t.name) + '</span>' +
              '<b>' + t.value + '</b><em>' + Math.round((t.value / total) * 100) + '%</em></div>').join('') +
            '</div></div>' +
        '</div>' +
        '<div class="card reveal">' +
          '<div class="card-head"><div class="card-title"><span class="dot" style="background:#5856d6"></span>主题资料分布</div>' +
            '<button class="link-btn" data-act="view" data-v="topics">全部主题</button></div>' +
          '<div class="bars">' + tagSegs.map((t, i) =>
            '<div class="bar-row"><div class="bar-top"><span><i class="t-dot" style="background:' + tagColor(t.name) + '"></i>' + esc(t.name) + '</span><b>' + t.count + ' 篇</b></div>' +
            '<div class="bar-track"><div class="bar-fill" data-w="' + Math.round((t.count / maxTag) * 100) +
            '" style="background:' + tagColor(t.name) + ';opacity:' + (1 - i * 0.06) + '"></div></div></div>').join('') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="two-col">' +
        '<div class="card reveal">' +
          '<div class="card-head"><div class="card-title"><span class="dot"></span>最近更新</div>' +
            '<button class="link-btn" data-act="view" data-v="library">资料库</button></div>' +
          '<div class="doc-list">' + recent.map((d) => docRow(d)).join('') + '</div>' +
        '</div>' +
        '<div class="card reveal" style="background:linear-gradient(150deg,#fff,#fbfaff 55%,#f4f8ff)">' +
          '<div class="card-head"><div class="card-title">' +
            '<svg viewBox="0 0 24 24" fill="none" style="width:15px;height:15px;color:#5856d6"><path d="M12 3.5l1.6 4.3 4.4 1.6-4.4 1.6L12 15.3l-1.6-4.3L6 9.4l4.4-1.6L12 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
            '智能洞察</div><span class="card-sub">' + relTime(a.generatedAt) + '更新</span></div>' +
          '<div style="display:flex;flex-direction:column;gap:9px">' +
            topGaps.map((g) => '<div class="gap" style="padding:11px 12px">' +
              '<span class="gap-ico" style="background:' + toneBg(g.tone) + ';color:' + toneFg(g.tone) + '">' + g.icon + '</span>' +
              '<span class="gap-body"><span class="gap-title">' + esc(g.title) + '</span>' +
              '<span class="gap-desc" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + esc(g.desc) + '</span></span></div>').join('') +
            (topSug ? '<div class="insight-sug"><span class="mini-label">建议</span>' +
              '<p>' + esc(topSug.title) + '</p></div>' : '') +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:14px">' +
            '<button class="btn btn-primary btn-sm" data-act="view" data-v="analysis" style="flex:1;justify-content:center">查看完整分析</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="run-analysis" style="flex:0 0 auto">重新分析</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      (adopted.length
        ? '<div class="section-title"><h2>已采纳的方案</h2><span>' + adopted.length + ' 项进行中</span></div>' +
          '<div class="card reveal"><div class="doc-list">' + adopted.map((sg) =>
            '<div class="doc" style="cursor:default"><span class="doc-ico" style="background:' + toneColor(sg.kindTone) + '">✓</span>' +
            '<span class="doc-main"><span class="doc-title">' + esc(sg.title) + '</span>' +
            '<span class="doc-meta"><span>' + esc(sg.kind) + '</span><i></i><span>' + esc(sg.estimated) + '</span></span></span>' +
            '<span class="doc-right"><button class="link-btn" data-act="adopt" data-id="' + sg.id + '">撤销</button></span></div>').join('') +
          '</div></div>'
        : '');
  }

  function statCard(label, value, unit, foot, color, path) {
    return '<div class="stat reveal"><div class="stat-top">' +
      '<span class="stat-label">' + label + '</span>' +
      '<span class="stat-ico" style="background:' + hexA(color, 0.10) + ';color:' + color + '">' +
      '<svg viewBox="0 0 24 24" fill="none"><path d="' + path + '" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
      '</div><div class="stat-value">' + value + '<small>' + unit + '</small></div>' +
      '<div class="stat-foot">' + esc(foot) + '</div></div>';
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function toneColor(tone) {
    return { blue: '#0a84ff', purple: '#5856d6', green: '#2fbf5c', orange: '#ff9500' }[tone] || '#8e8e93';
  }
  function toneBg(tone) {
    return { blue: 'rgba(10,132,255,.10)', purple: 'rgba(88,86,214,.10)', green: 'rgba(47,191,92,.11)', orange: 'rgba(255,149,0,.12)', red: 'rgba(255,59,48,.10)', gray: 'rgba(120,120,128,.12)' }[tone] || 'rgba(120,120,128,.12)';
  }
  function toneFg(tone) {
    return { blue: '#0b6fd6', purple: '#4a48bf', green: '#1f8a45', orange: '#a86500', red: '#c3271e', gray: '#6e6e73' }[tone] || '#6e6e73';
  }

  /* ---------------- 视图：资料库 ---------------- */
  function filteredDocs() {
    const q = state.query.trim().toLowerCase();
    let list = state.docs.slice();
    if (state.activeTags.length) {
      list = list.filter(function (d) {
        const tags = d.tags || [];
        return state.activeTags.some(function (name) {
          if (name === UNTAGGED) return !tags.length;
          if (tags.indexOf(name) >= 0) return true;
          /* 选中主标签时，挂在其次标签下的资料同样命中 */
          const main = tagByName(name);
          if (main && !main.parentId) {
            return subTagsOf(main.id).some(function (s) { return tags.indexOf(s.name) >= 0; });
          }
          return false;
        });
      });
    }
    if (q) {
      list = list.filter((d) =>
        d.title.toLowerCase().indexOf(q) >= 0 ||
        (d.content || '').toLowerCase().indexOf(q) >= 0 ||
        (d.tags || []).join(' ').toLowerCase().indexOf(q) >= 0);
    }
    const a = state.analysis;
    if (state.sort === 'recent') list.sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
    else if (state.sort === 'importance') list.sort((x, y) => ((a.insights[y.id] || {}).importance || 0) - ((a.insights[x.id] || {}).importance || 0));
    else list.sort((x, y) => x.title.localeCompare(y.title, 'zh-Hans-CN'));
    return list;
  }

  /* ---------------- 文件夹映射 ----------------
     主标签 → 资料库里的主文件夹；次标签 → 该主文件夹下的子文件夹。
     资料带次标签时自动归入「主 / 次」子文件夹，即使没显式打主标签。 */
  function docInMain(d, main) {
    const tags = d.tags || [];
    const subs = subTagsOf(main.id).map(function (s) { return s.name; });
    if (state.folderRule === 'primary') {
      const first = tags[0];
      if (!first) return false;
      return first === main.name || subs.indexOf(first) >= 0;
    }
    return tags.indexOf(main.name) >= 0 || tags.some(function (t) { return subs.indexOf(t) >= 0; });
  }

  function docsInMain(main) {
    return filteredDocs().filter(function (d) { return docInMain(d, main); });
  }

  function docsInSub(sub) {
    return filteredDocs().filter(function (d) {
      const tags = d.tags || [];
      return state.folderRule === 'primary' ? tags[0] === sub.name : tags.indexOf(sub.name) >= 0;
    });
  }

  /* 主文件夹根层的资料：只打了主标签、没落到任何次文件夹里的那些 */
  function docsInMainRoot(main) {
    const inSub = {};
    subTagsOf(main.id).forEach(function (s) {
      docsInSub(s).forEach(function (d) { inSub[d.id] = 1; });
    });
    return docsInMain(main).filter(function (d) { return !inSub[d.id]; });
  }

  function folderDocs(tagName) {
    const primaryOnly = state.folderRule === 'primary';
    return filteredDocs().filter(function (d) {
      const tags = d.tags || [];
      if (tagName === UNTAGGED) return !tags.length;
      if (primaryOnly) return tags[0] === tagName;
      return tags.indexOf(tagName) >= 0;
    });
  }

  const FOLDER_ICO = '<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 7.6c0-.9.7-1.6 1.6-1.6h3.1c.5 0 .9.2 1.2.6l.8.9c.3.3.7.5 1.1.5h5.6c.9 0 1.6.7 1.6 1.6v7.8c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const CHEV = '<svg class="folder-chev" viewBox="0 0 24 24" fill="none"><path d="m8 10 4 4 4-4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* 未归类这类伪文件夹 */
  function folderCard(tag, docs) {
    const c = tag.name === UNTAGGED ? '#8e8e93' : tag.color;
    const closed = tag.id ? isFolderClosed(tag.id) : (state.closedFolders || []).indexOf(tag.name) >= 0;
    const empty = !docs.length;

    return '<section class="folder' + (empty ? ' is-empty' : '') + (closed ? ' is-closed' : '') + '">' +
        '<div class="folder-head">' +
          '<button class="folder-toggle" data-act="toggle-folder" data-id="' + (tag.id || 'untagged') + '" aria-expanded="' + (!closed) + '">' +
            '<span class="folder-ico" style="background:' + hexA(c, 0.14) + ';color:' + shade(c, 0.08) + '">' + FOLDER_ICO + '</span>' +
            '<span class="folder-name">' + esc(tag.name) + '</span>' +
            '<span class="folder-count">' + docs.length + '</span>' +
            (empty ? '<span class="folder-empty">空</span>' : '') +
            (empty ? '' : CHEV) +
          '</button>' +
          '<span class="folder-acts">' +
            (empty ? '' : '<button class="link-btn" data-act="open-tag-library" data-tag="' + esc(tag.name) + '">只看此标签</button>') +
            (tag.id ? '<button class="link-btn" data-act="tag-edit" data-id="' + tag.id + '">设置</button>' : '') +
          '</span>' +
        '</div>' +
        (empty ? '' : '<div class="folder-body"><div class="doc-list">' +
          docs.map(function (d) { return docRow(d, { folderTag: tag.name, hideStatus: true }); }).join('') +
        '</div></div>') +
      '</section>';
  }

  /* 次文件夹：嵌套在主文件夹内部 */
  function subFolderCard(sub, docs, totalSubs) {
    const closed = isFolderClosed(sub.id);
    const empty = !docs.length;
    return '<section class="subfolder' + (empty ? ' is-empty' : '') + (closed ? ' is-closed' : '') + '">' +
        '<div class="subfolder-head">' +
          '<button class="subfolder-toggle" data-act="toggle-folder" data-id="' + sub.id + '" aria-expanded="' + (!closed) + '">' +
            '<span class="subfolder-line"></span>' +
            '<span class="subfolder-ico" style="background:' + hexA(sub.color, 0.14) + ';color:' + shade(sub.color, 0.1) + '">' +
              '<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 7.6c0-.9.7-1.6 1.6-1.6h3.1c.5 0 .9.2 1.2.6l.8.9c.3.3.7.5 1.1.5h5.6c.9 0 1.6.7 1.6 1.6v7.8c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
            '</span>' +
            '<span class="subfolder-name">' + esc(sub.name) + '</span>' +
            '<span class="folder-count">' + docs.length + '</span>' +
            (empty ? '<span class="folder-empty">空</span>' : CHEV) +
          '</button>' +
          '<span class="folder-acts">' +
            (empty ? '' : '<button class="link-btn" data-act="open-tag-library" data-tag="' + esc(sub.name) + '">只看此标签</button>') +
            '<button class="link-btn" data-act="tag-edit" data-id="' + sub.id + '">设置</button>' +
          '</span>' +
        '</div>' +
        (empty ? '' : '<div class="subfolder-body doc-list">' +
          docs.map(function (d) { return docRow(d, { folderTag: sub.name, hideStatus: true }); }).join('') +
        '</div>') +
      '</section>';
  }

  /* 主文件夹：头部 + 子文件夹列表 + 根层资料
     onlySubs：筛选时只渲染被选中的子文件夹 */
  function mainFolderCard(main, onlySubs) {
    const allSubs = subTagsOf(main.id).sort(function (x, y) {
      return docsInSub(y).length - docsInSub(x).length || x.name.localeCompare(y.name, 'zh-Hans-CN');
    });
    const subs = onlySubs ? allSubs.filter(function (s) { return onlySubs.indexOf(s.id) >= 0; }) : allSubs;
    const docs = docsInMain(main);
    const rootDocs = docsInMainRoot(main);
    const closed = isFolderClosed(main.id);
    const empty = !docs.length && !subs.length;
    const rootLabel = subs.length ? '未归入次标签' : '';

    return '<section class="folder folder-main' + (empty ? ' is-empty' : '') + (closed ? ' is-closed' : '') + '">' +
        '<div class="folder-head">' +
          '<button class="folder-toggle" data-act="toggle-folder" data-id="' + main.id + '" aria-expanded="' + (!closed) + '">' +
            '<span class="folder-ico" style="background:' + hexA(main.color, 0.14) + ';color:' + shade(main.color, 0.08) + '">' + FOLDER_ICO + '</span>' +
            '<span class="folder-name">' + esc(main.name) + '</span>' +
            '<span class="folder-count">' + docs.length + '</span>' +
            (subs.length ? '<span class="folder-badge">' + subs.length + ' 个次标签</span>' : '') +
            (empty ? '<span class="folder-empty">空</span>' : '') +
            (empty ? '' : CHEV) +
          '</button>' +
          '<span class="folder-acts">' +
            (docs.length ? '<button class="link-btn" data-act="open-tag-library" data-tag="' + esc(main.name) + '">只看此标签</button>' : '') +
            '<button class="link-btn" data-act="tag-new-sub" data-parent="' + main.id + '">＋ 次标签</button>' +
            '<button class="link-btn" data-act="tag-edit" data-id="' + main.id + '">设置</button>' +
          '</span>' +
        '</div>' +
        (empty ? '' : '<div class="folder-body">' +
          subs.map(function (s) { return subFolderCard(s, docsInSub(s), subs.length); }).join('') +
          (rootDocs.length
            ? (subs.length
              ? '<div class="root-group"><span class="root-label">' + rootLabel + ' · ' + rootDocs.length + ' 篇</span>' +
                '<div class="doc-list">' + rootDocs.map(function (d) { return docRow(d, { folderTag: main.name, hideStatus: true }); }).join('') + '</div></div>'
              : '<div class="doc-list">' + rootDocs.map(function (d) { return docRow(d, { folderTag: main.name, hideStatus: true }); }).join('') + '</div>')
            : '') +
        '</div>') +
      '</section>';
  }

  function viewLibrary() {
    ensureAnalysis();
    const list = filteredDocs();
    const mode = state.libraryMode === 'list' ? 'list' : 'folder';
    const tree = tagTree();
    const totalDocs = state.docs.length;

    const sortSeg = '<div class="segmented" data-seg="sort">' +
        '<span class="seg-ind"></span>' +
        ['recent:最近更新', 'importance:重要度', 'title:标题'].map(function (x) {
          const k = x.split(':');
          return '<button data-act="sort" data-sort="' + k[0] + '" class="' + (state.sort === k[0] ? 'active' : '') + '">' + k[1] + '</button>';
        }).join('') +
      '</div>';

    const head = '<div class="seg-row">' +
        '<div class="kit-row">' +
          '<div class="segmented" data-seg="mode">' +
            '<span class="seg-ind"></span>' +
            ['folder:文件夹', 'list:列表'].map(function (x) {
              const k = x.split(':');
              return '<button data-act="library-mode" data-mode="' + k[0] + '" class="' + (mode === k[0] ? 'active' : '') + '">' + k[1] + '</button>';
            }).join('') +
          '</div>' +
          sortSeg +
        '</div>' +
        '<div class="kit-row">' +
          '<span class="count-label">' + (list.length === totalDocs ? '共 ' + totalDocs + ' 篇' : '筛选出 ' + list.length + ' / ' + totalDocs + ' 篇') + '</span>' +
          '<button class="btn btn-sm btn-ghost" data-act="tag-new">新建标签</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="import-open">导入资料</button>' +
        '</div>' +
      '</div>' +
      '<div class="filter-scroll">' +
        tagChip('全部', { on: !state.activeTags.length, act: 'filter-tag', cls: 'tg-all' }) +
        (state.activeTags.indexOf(UNTAGGED) >= 0
          ? tagChip(UNTAGGED, { on: true, act: 'filter-tag', cls: 'tg-un' })
          : '') +
        tree.map(function (node) {
          return tagChip(node.main.name, { on: state.activeTags.indexOf(node.main.name) >= 0, act: 'filter-tag', count: folderUsage(node.main) }) +
            node.subs.map(function (s) {
              return tagChip(s.name, {
                on: state.activeTags.indexOf(s.name) >= 0, act: 'filter-tag',
                count: tagUsage(s.name)
              });
            }).join('');
        }).join('') +
      '</div>';

    if (!totalDocs) {
      return head + emptyLibrary();
    }

    let body = '';
    if (mode === 'list') {
      body = '<div class="card reveal" style="padding:8px 10px">' +
        (list.length ? '<div class="doc-list">' + list.map(function (d) { return docRow(d); }).join('') + '</div>'
          : '<div class="empty"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7.5C4 6.1 5.1 5 6.5 5h3.2c.7 0 1.4.3 1.9.8l.9.9c.3.3.7.5 1.1.5h4c1.4 0 2.5 1.1 2.5 2.5v7.2c0 1.4-1.1 2.6-2.5 2.6h-10C5.1 19.5 4 18.3 4 16.9V7.5Z" stroke="currentColor" stroke-width="1.6"/></svg>' +
            '<b>' + (state.query ? '没有匹配的资料' : '这个筛选下还没有资料') + '</b>' +
            '<p>' + (state.query ? '换个关键词，或清除筛选条件' : '导入你的第一份资料开始建立知识库') + '</p></div>') +
      '</div>';
    } else {
      const untaggedDocs = folderDocs(UNTAGGED);
      /* 有筛选时只保留命中的主标签及其子文件夹，避免出现无关文件夹 */
      let view = tree;
      if (state.activeTags.length) {
        const selMain = {};
        const selSub = {};
        state.activeTags.forEach(function (name) {
          const t = tagByName(name);
          if (!t) return;
          if (t.parentId) selSub[t.id] = 1; else selMain[t.id] = 1;
        });
        view = tree
          .filter(function (n) { return selMain[n.main.id] || n.subs.some(function (s) { return selSub[s.id]; }); })
          .map(function (n) {
            if (selMain[n.main.id]) return { main: n.main, subs: n.subs, filtered: false };
            return { main: n.main, subs: n.subs.filter(function (s) { return selSub[s.id]; }), filtered: true };
          });
      }
      const filled = view.filter(function (n) { return docsInMain(n.main).length > 0 || n.subs.length > 0; });
      const empty = view.filter(function (n) { return docsInMain(n.main).length === 0 && !n.subs.length; });
      const cards = filled.map(function (n) {
        return mainFolderCard(n.main, n.filtered ? n.subs.map(function (s) { return s.id; }) : null);
      }).join('') +
        (untaggedDocs.length ? folderCard({ name: UNTAGGED, color: '#8e8e93', id: null }, untaggedDocs) : '');

      body =
        '<div class="folder-rule reveal">' +
          '<span class="fr-label">多标签资料</span>' +
          '<div class="segmented mini" data-seg="rule">' +
            '<span class="seg-ind"></span>' +
            '<button data-act="folder-rule" data-rule="all" class="' + (state.folderRule === 'all' ? 'active' : '') + '">出现在每个文件夹</button>' +
            '<button data-act="folder-rule" data-rule="primary" class="' + (state.folderRule === 'primary' ? 'active' : '') + '">只归入第一个标签</button>' +
          '</div>' +
          '<span class="fr-hint">主标签 = 文件夹，次标签 = 其中的子文件夹；副本仅存在于视图中，不复制文件</span>' +
        '</div>' +
        (cards ? '<div class="folder-list">' + cards + '</div>'
          : '<div class="card reveal"><div class="empty"><b>' + (state.query ? '没有匹配的资料' : '还没有可归类的资料') + '</b>' +
            '<p>' + (state.query ? '换个关键词，或清除筛选条件' : '导入资料并打上标签后，这里会自动为每个主标签生成文件夹') + '</p></div></div>') +
        (empty.length ? '<div class="empty-folders reveal"><span class="ef-label">空文件夹</span>' +
          empty.map(function (n) { return tagChip(n.main.name, { act: 'tag-edit', id: n.main.id, count: 0 }); }).join('') +
          '<span class="ef-note">主标签尚未被使用</span></div>' : '');
    }

    return head + body +
      '<div class="dropzone" data-act="import-open" style="margin-top:14px">' +
        '<b>把文件拖到这里，或点击导入</b>' +
        '<span>支持 Markdown / 文本 / Word / PDF / PPT · 内容仅保存在本机</span>' +
      '</div>';
  }

  /* ---------------- 视图：知识主题 / 关键概念 ---------------- */
  function viewTopics() {
    if (!state.docs.length) return emptyLibrary();
    const a = ensureAnalysis();
    const tab = state.topicsTab === 'concepts' ? 'concepts' : 'topics';
    const concepts = a.concepts || [];
    const coreN = concepts.filter(function (c) { return c.band === 'core'; }).length;

    const head = '<div class="seg-row" style="margin-bottom:14px">' +
        '<div class="segmented" data-seg="topicsTab"><span class="seg-ind"></span>' +
          [['topics', '主题结构'], ['concepts', '关键概念']].map(function (x) {
            return '<button data-act="topics-tab" data-tab="' + x[0] + '" class="' + (tab === x[0] ? 'active' : '') + '">' + x[1] + '</button>';
          }).join('') +
        '</div>' +
        '<span class="count-label">' + (tab === 'concepts'
          ? concepts.length + ' 个概念 · ' + coreN + ' 个核心 · ' + (a.conceptEdges || []).length + ' 条共现'
          : (a.coreTopics || []).length + ' 个核心主题 · ' + (a.tailTopics || []).length + ' 个长尾标签') + '</span>' +
      '</div>';

    return head + (tab === 'concepts' ? viewConcepts(a) : topicsBody(a));
  }

  function topicsBody(a) {
    const core = a.coreTopics || a.topics.filter((t) => t.name !== '未归类' && t.count >= 2);
    const tail = a.tailTopics || a.topics.filter((t) => t.name !== '未归类' && t.count === 1);
    const untagged = a.topics.filter((t) => t.name === '未归类')[0];
    const maxKw = Math.max.apply(null, a.keywords.map((k) => k.df).concat([1]));

    return '<div class="card reveal" style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:200px">' +
          '<div class="card-title" style="margin-bottom:6px">主题结构</div>' +
          '<p style="margin:0;font-size:12.5px;color:var(--label-2);line-height:1.65">按标签聚合出 <b>' + core.length + '</b> 个核心主题与 <b>' + tail.length + '</b> 个长尾标签，平均覆盖度 <b>' + a.stats.avgCoverage + '%</b>。覆盖度由资料数量、类型多样性与最近复习情况加权，低于 40% 的主题会在分析页标为薄弱环节。</p>' +
        '</div>' +
        '<div class="kit-row" style="gap:18px">' +
          '<div class="stat-inline"><b>' + core.length + '</b><span>核心主题</span></div>' +
          '<div class="stat-inline"><b>' + a.stats.avgCoverage + '%</b><span>平均覆盖</span></div>' +
          '<div class="stat-inline"><b>' + tail.length + '</b><span>长尾标签</span></div>' +
          '<div class="stat-inline"><b>' + (untagged ? untagged.count : 0) + '</b><span>未归类</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="section-title"><h2>核心主题</h2><span>点击查看该主题下的资料</span></div>' +
      '<div class="topic-grid">' + core.map(function (t, i) {
        const tg = tagByName(t.name);
        const pn = tg && tg.parentId ? ((tagById(tg.parentId) || {}).name || '') : '';
        return '<div class="topic reveal" data-act="topic" data-topic="' + esc(t.name) + '" style="animation-delay:' + Math.min(i * 26, 260) + 'ms">' +
          '<div class="topic-head"><div><div class="topic-name"><i class="t-dot" style="background:' + tagColor(t.name) + '"></i>' + esc(t.name) +
            (pn ? '<em class="topic-parent">' + esc(pn) + '</em>' : '') + '</div>' +
          '<div class="topic-sub">' + t.count + ' 篇资料 · ' + (t.coverage >= 70 ? '结构完整' : t.coverage >= 40 ? '尚可扩展' : '较薄弱') + '</div></div>' +
          ring(t.coverage, tagColor(t.name)) + '</div>' +
          '<div class="kw-cloud">' + t.keywords.slice(0, 4).map((k) => '<span class="kw">' + esc(k) + '</span>').join('') + '</div>' +
        '</div>';
      }).join('') +
      '</div>' +

      (untagged ? '<div class="card reveal" style="margin-top:14px;display:flex;align-items:center;gap:12px">' +
        '<span class="gap-ico" style="background:rgba(255,59,48,.10);color:#c3271e">!</span>' +
        '<div style="flex:1"><div class="gap-title">' + untagged.count + ' 篇资料未归类</div>' +
        '<div class="gap-desc">这些资料不会进入主题网络，也不会被主题覆盖度统计。</div></div>' +
        '<button class="btn btn-sm" data-act="filter-untagged">去整理</button></div>' : '') +

      (tail.length ? '<div class="section-title"><h2>长尾标签</h2><span>' + tail.length + ' 个标签只有 1 篇资料</span></div>' +
        '<div class="card reveal"><div class="kw-cloud" style="gap:7px">' +
          tail.map((t) => tagChip(t.name, { act: 'topic', count: t.count, style: 'padding:4px 9px;font-size:11.5px' })).join('') +
        '</div><p class="hint" style="margin-top:10px">长尾标签过多通常意味着标签切分过细，可在「智能分析 · 建议方案」中查看整理方案。</p></div>' : '') +

      '<div class="section-title"><h2>关键词热度</h2><span>全库 ' + a.keywords.length + ' 个高频概念</span></div>' +
      '<div class="card reveal"><div class="kw-cloud" style="gap:7px">' +
        a.keywords.map((k) => {
          const w = 1 + (k.df / maxKw) * 0.55;
          return '<span class="kw ' + (k.df >= 3 ? 'hot' : '') + '" style="font-size:' + (11 * w).toFixed(1) +
            'px;padding:' + (2 + w) + 'px ' + (7 + w * 2) + 'px" title="出现在 ' + k.df + ' 篇资料中">' + esc(k.term) + '</span>';
        }).join('') +
      '</div></div>';
  }

  /* ---------------- 视图：关键概念 ---------------- */
  function viewConcepts(a) {
    const all = a.concepts || [];
    if (!all.length) {
      return '<div class="card reveal"><div class="empty">' +
        '<b>还没有可提取的概念</b><p>等资料解析出正文后，这里会自动列出关键概念与核心词汇</p>' +
        '<button class="btn btn-sm btn-ghost" data-act="view" data-v="library" style="margin-top:12px">去资料库看看</button></div></div>';
    }
    const filter = state.conceptFilter === 'core' ? 'core' : state.conceptFilter === 'support' ? 'support' : 'all';
    const list = filter === 'all' ? all : all.filter(function (c) { return c.band === filter; });
    const coreN = all.filter(function (c) { return c.band === 'core'; }).length;
    const hits = all.reduce(function (s, c) { return s + c.hits; }, 0);
    const docSet = {};
    all.forEach(function (c) { c.docs.forEach(function (id) { docSet[id] = 1; }); });
    const maxTotal = Math.max.apply(null, all.map(function (c) { return c.total; }).concat([1]));

    const statHtml = function (v, label) {
      return '<div class="stat-inline"><b>' + v + '</b><span>' + label + '</span></div>';
    };

    const hero = '<div class="card concept-hero reveal">' +
        '<div class="tag-hero-main">' +
          '<div class="card-title" style="margin-bottom:6px">关键概念与核心词汇</div>' +
          '<p class="tag-hero-desc">从标题、标签与正文中抽取：先用学科词表最长匹配命中术语，再用 2—6 字 n-gram 统计高频短语，' +
            '按 <b>词频 × 区分度（IDF）× 长度权重 × 位置加权</b> 打分，剔除碎片与泛化词后分级。每个概念都保留原文出处，点击即可定位。</p>' +
        '</div>' +
        '<div class="kit-row tag-hero-stats">' +
          statHtml(all.length, '概念总数') + statHtml(coreN, '核心概念') +
          statHtml(Object.keys(docSet).length, '覆盖资料') + statHtml((a.conceptEdges || []).length, '共现关系') +
        '</div>' +
        '<div class="kit-row tag-hero-acts">' +
          '<button class="btn btn-sm btn-ghost" data-act="concept-rules">判定规则</button>' +
          '<button class="btn btn-sm btn-primary" data-act="goto-graph" data-mode="concept">在知识图谱中查看</button>' +
        '</div>' +
      '</div>';

    const filters = '<div class="seg-row" style="margin:2px 0 12px">' +
        '<div class="segmented mini" data-seg="cfilter"><span class="seg-ind"></span>' +
          [['all', '全部 ' + all.length], ['core', '核心 ' + coreN], ['support', '支撑 ' + (all.length - coreN)]].map(function (x) {
            return '<button data-act="concept-filter" data-f="' + x[0] + '" class="' + (filter === x[0] ? 'active' : '') + '">' + x[1] + '</button>';
          }).join('') +
        '</div>' +
        '<span class="count-label">共出现 ' + hits + ' 次 · 按综合强度排序 · 点击查看判定依据与原文出处</span>' +
      '</div>';

    return hero + filters +
      '<div class="card concept-table reveal">' + list.map(function (c, i) { return conceptRow(c, i, maxTotal); }).join('') + '</div>' +
      '<p class="hint" style="margin-top:10px">概念强度 = (1 + ln 词频) × IDF × 长度权重 × 来源权重 × 位置权重；同一概念在多篇资料中反复出现会累加。</p>';
  }

  function conceptRow(c, i, maxTotal) {
    const pct = Math.round((c.total / maxTotal) * 100);
    const color = c.topic ? tagColor(c.topic) : '#8e8e93';
    return '<button class="concept-row reveal" data-act="concept" data-term="' + esc(c.term) + '" style="animation-delay:' + Math.min(i * 14, 160) + 'ms">' +
        '<span class="concept-rank">' + (i + 1) + '</span>' +
        '<span class="concept-main">' +
          '<span class="concept-name">' + esc(c.term) +
            '<em class="cband ' + (c.band === 'core' ? 'core' : '') + '">' + (c.band === 'core' ? '核心' : '支撑') + '</em>' +
            '<em class="ckind">' + (c.kind === 'term' ? '术语' : '短语') + '</em>' +
            (c.topic ? '<em class="ctopic"><i class="t-dot" style="background:' + color + '"></i>' + esc(c.topic) + '</em>' : '') +
          '</span>' +
          '<span class="concept-sub">' + c.df + ' 篇资料 · 共 ' + c.hits + ' 次 · 强度 ' + c.total + '</span>' +
          '<span class="concept-bar"><i style="width:' + Math.max(4, pct) + '%;background:' + color + '"></i></span>' +
          (c.co.length ? '<span class="concept-co">' + c.co.slice(0, 3).map(function (x) {
            return '<span class="co-chip">' + esc(x.term) + '</span>';
          }).join('') + '</span>' : '') +
        '</span>' +
        '<span class="concept-side">' + (c.co.length ? c.co.length + ' 个关联' : '暂无关联') +
          '<svg class="chev" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</span>' +
      '</button>';
  }

  /* 概念详情：判定依据 + 原文对应 + 关联概念 */
  function openConcept(term) {
    const a = ensureAnalysis();
    const all = a.concepts || [];
    const c = all.filter(function (x) { return x.term === term; })[0];
    if (!c) { toast('这个概念已不在当前分析结果中，请重新分析'); return; }
    const rank = all.indexOf(c) + 1;
    const docs = c.docs.map(docById).filter(Boolean);
    const topRow = c.byDoc.slice().sort(function (x, y) { return y.score - x.score; })[0];
    const detail = topRow && a.insights[topRow.docId]
      ? (a.insights[topRow.docId].concepts || []).filter(function (x) { return x.term === term; })[0]
      : null;
    const color = c.topic ? tagColor(c.topic) : '#8e8e93';

    const ev = [];
    ev.push(['抽取方式', c.kind === 'term'
      ? '命中学科词表（最长匹配优先，分值 ×1.9）'
      : '2—6 字 n-gram 统计，未被更长词组覆盖的候选短语']);
    ev.push(['出现情况', '全库 ' + c.hits + ' 次，覆盖 ' + c.df + ' 篇资料']);
    ev.push(['区分度 IDF', c.idf + (c.idf >= 1.2 ? ' · 较独有，集中在少数资料' : ' · 较常见，属基础词汇')]);
    ev.push(['综合强度', c.total + ' · 全库排名 #' + rank]);
    if (detail) {
      const pos = ['×' + detail.posW];
      if (detail.inTitle) pos.push('命中标题');
      if (detail.inTags) pos.push('命中标签');
      if (detail.contexts[0] && detail.contexts[0].at < 200) pos.push('出现在开头');
      ev.push(['位置加权', pos.join(' · ')]);
    }
    ev.push(['分级', c.band === 'core' ? '核心概念（综合强度前 35%）' : '支撑概念（补足上下文与细节）']);

    const contexts = c.contexts.slice(0, 4).map(function (ctx) {
      const d = docById(ctx.docId);
      if (!d) return '';
      return '<button class="ctx" data-act="concept-jump" data-doc="' + d.id + '" data-term="' + esc(term) + '">' +
          '<span class="ctx-doc">' + esc(shortTitle(d.title)) + '</span>' +
          '<span class="ctx-text">' + esc(ctx.before) + '<mark>' + esc(term) + '</mark>' + esc(ctx.after) + '</span>' +
          '<span class="ctx-go">定位原文 ↗</span>' +
        '</button>';
    }).join('');

    const body =
      '<div class="concept-headline">' +
        '<span class="concept-dot" style="background:' + color + '"></span>' +
        '<div class="concept-hl-main"><b>' + esc(c.term) + '</b>' +
          '<span>' + (c.kind === 'term' ? '学科术语' : '高频短语') + ' · ' + (c.band === 'core' ? '核心概念' : '支撑概念') +
          ' · 强度 ' + c.total + '</span></div>' +
        '<span class="cband ' + (c.band === 'core' ? 'core' : '') + '">' + (c.band === 'core' ? '核心' : '支撑') + '</span>' +
      '</div>' +

      '<div class="sheet-section-title">判定依据</div>' +
      '<div class="evidence">' + ev.map(function (x) {
        return '<div class="ev-row"><span>' + x[0] + '</span><b>' + esc(x[1]) + '</b></div>';
      }).join('') + '</div>' +

      '<div class="sheet-section-title">原文对应 · ' + c.df + ' 篇资料</div>' +
      (contexts || '<p class="hint" style="margin:0">这些资料里没有保留可定位的原文片段</p>') +
      (c.df > 1 ? '<div class="doc-row-inline">' + docs.slice(0, 6).map(function (d) {
        return '<button class="doc-pill" data-act="doc" data-id="' + d.id + '">' + esc(shortTitle(d.title)) + '</button>';
      }).join('') + '</div>' : '') +

      (c.co.length ? '<div class="sheet-section-title">关联概念 · 共现</div>' +
        '<div class="kw-cloud">' + c.co.map(function (x) {
          return '<button class="kw co-link" data-act="concept" data-term="' + esc(x.term) + '" title="共现权重 ' + x.w + '">' +
            esc(x.term) + '<em>' + x.w + '</em></button>';
        }).join('') + '</div>' +
        '<p class="hint" style="margin-top:6px">两个概念在同一篇资料里一起出现即建立关联，权重带核心概念加成</p>' : '') +

      (c.topics.length ? '<div class="sheet-section-title">所属主题</div>' +
        '<div class="kw-cloud">' + c.topics.map(function (t) {
          return tagChip(t, { act: 'topic', count: tagUsage(t) });
        }).join('') + '</div>' : '');

    openSheet({
      eyebrow: '关键概念',
      title: esc(term),
      meta: '<span>' + c.df + ' 篇资料</span><span>·</span><span>共 ' + c.hits + ' 次</span><span>·</span><span>强度 ' + c.total + '</span>',
      body: body,
      footer: '<button class="btn btn-sm" data-act="concept-rules">判定规则</button>' +
        '<div class="group">' +
          '<button class="btn btn-sm" data-act="goto-graph" data-mode="concept" data-term="' + esc(term) + '">在知识图谱中查看</button>' +
          '<button class="btn btn-sm btn-primary" data-act="close-sheet">完成</button>' +
        '</div>'
    });
  }

  /* 判定规则说明（概念视图与资料详情共用） */
  function openConceptRules() {
    openSheet({
      eyebrow: '概念提取',
      title: '关键概念是怎么提取的',
      meta: '<span>纯本地规则</span><span>·</span><span>不调用模型接口</span>',
      body:
        '<ol class="rule-steps">' +
          '<li><b>切分候选</b><span>先用学科词表（经济增长、菲利普斯曲线、IS-LM…）做最长匹配，命中即锁定为术语；对剩余文本切 2—6 字 n-gram，得到短语候选。</span></li>' +
          '<li><b>过滤噪声</b><span>去掉停用字组合、格式类词（习题 / 笔记 / 讲义）与泛化词（分析 / 影响 / 问题）；若某个词几乎总被更长的词组覆盖，判为碎片并剔除。</span></li>' +
          '<li><b>四项打分</b><span>综合强度 = (1 + ln 词频) × IDF × 长度权重 × 来源权重（术语 ×1.9），其中 IDF = ln(1 + 资料总数 / 含该词的资料数)。</span></li>' +
          '<li><b>位置加权</b><span>出现在标题 ×1.16、标签 ×1.10、正文开头（前 20% 或前 200 字）×1.06，最多叠加到 ×1.32。</span></li>' +
          '<li><b>分级</b><span>按全库综合强度排序，前 35%（至少 3 个）记为核心概念；其余为支撑概念，仍在概念页可查。</span></li>' +
          '<li><b>对应原文</b><span>每个概念保留最多 4 处上下文（前 26 字 + 概念 + 后 34 字），点击即可跳到原文并高亮该词。</span></li>' +
        '</ol>' +
        '<div class="evidence" style="margin-top:14px">' +
          '<div class="ev-row"><span>为什么不用分词库</span><b>零依赖：词表 + n-gram + 统计量即可解释每个结果的来源</b></div>' +
          '<div class="ev-row"><span>与标签的区别</span><b>标签由你定义（主题归属），概念由文本自动提取（内容证据）</b></div>' +
        '</div>',
      footer: '<span class="card-sub">概念与知识图谱共用同一份抽取结果</span>' +
        '<button class="btn btn-sm btn-primary" data-act="close-sheet">知道了</button>'
    });
  }

  /* 视图：标签管理 */
  function viewTags() {
    const tree = tagTree();
    const all = tagList();
    const used = all.filter(function (t) { return tagUsage(t.name) > 0; });
    const unused = all.filter(function (t) { return tagUsage(t.name) === 0; });
    const mainCount = tree.length;
    const subCount = all.length - mainCount;
    const maxUse = Math.max.apply(null, tree.map(function (n) { return n.count; }).concat([1]));

    if (!all.length) {
      return '<div class="card reveal" style="padding:0">' +
        '<div class="empty" style="padding:62px 24px 56px">' +
          '<svg viewBox="0 0 24 24" fill="none" style="width:42px;height:42px"><path d="M4.5 10.2V5.1c0-.4.3-.6.6-.6h5.1c.3 0 .5.1.7.3l8.4 8.4c.4.4.4 1 0 1.4l-5.1 5.1c-.4.4-1 .4-1.4 0L4.8 11c-.2-.2-.3-.4-.3-.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8.2" cy="8.2" r="1.3" fill="currentColor"/></svg>' +
          '<b style="font-size:15px;color:var(--label)">还没有标签</b>' +
          '<p style="margin-top:6px">主标签会生成资料库文件夹，次标签生成其中的子文件夹；给标签配色，全站胶囊同步换色。</p>' +
          '<div style="display:flex;gap:8px;justify-content:center;margin-top:18px">' +
            '<button class="btn btn-primary" data-act="tag-new" style="justify-content:center">新建主标签</button>' +
            (state.docs.length ? '<button class="btn btn-ghost" data-act="view" data-v="library">去整理资料</button>' : '<button class="btn btn-ghost" data-act="import-open">导入资料</button>') +
          '</div>' +
        '</div></div>';
    }

    function tagRowHtml(t, opt) {
      opt = opt || {};
      const n = tagUsage(t.name);
      const folderN = t.parentId ? n : folderUsage(t);
      const subs = t.parentId ? [] : subTagsOf(t.id);
      const pct = Math.round((folderN / maxUse) * 100);
      const subLine = t.parentId
        ? '次标签 · 归属「' + esc(opt.parentName || '—') + '」 · ' + n + ' 篇资料'
        : n + ' 篇资料' + (subs.length ? ' · ' + subs.length + ' 个次标签' : '') + (n || subs.length ? ' · 主文件夹已生成' : ' · 空文件夹') + ' · 修改于 ' + fmtDate(t.updatedAt);

      return '<div class="tag-row' + (opt.sub ? ' is-sub' : '') + ' reveal" data-act="tag-edit" data-id="' + t.id + '"' +
          ' style="animation-delay:' + Math.min((opt.delay || 0) * 16, 180) + 'ms">' +
          (opt.sub ? '<span class="sub-rail"></span>' : '') +
          '<span class="tag-swatch" style="background:' + t.color + ';box-shadow:0 0 0 4px ' + hexA(t.color, 0.13) + '"></span>' +
          '<span class="tag-row-main">' +
            '<span class="tag-row-name">' + esc(t.name) +
              (t.parentId ? '<em class="tag-row-badge badge-sub">次</em>' : (subs.length ? '<em class="tag-row-badge badge-main">主</em>' : '')) +
              (n === 0 && !subs.length ? '<em class="tag-row-badge">未使用</em>' : '') +
            '</span>' +
            '<span class="tag-row-sub">' + subLine + '</span>' +
            '<span class="tag-bar"><i style="width:' + Math.max(pct, folderN ? 4 : 0) + '%;background:' + t.color + '"></i></span>' +
          '</span>' +
          '<span class="tag-row-side">' +
            (n ? '<button class="link-btn" data-act="open-tag-library" data-tag="' + esc(t.name) + '">查看</button>' : '') +
            (t.parentId ? '' : '<button class="link-btn sub-add" data-act="tag-new-sub" data-parent="' + t.id + '">＋ 次标签</button>') +
            '<button class="tag-swatch-btn" data-act="tag-edit" data-id="' + t.id + '" aria-label="编辑标签">' +
              '<svg viewBox="0 0 24 24" fill="none"><path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m13.5 6.5 3 3" stroke="currentColor" stroke-width="1.6"/></svg>' +
            '</button>' +
          '</span>' +
        '</div>';
    }

    const rows = tree.map(function (node, i) {
      return tagRowHtml(node.main, { delay: i }) +
        node.subs.map(function (s) { return tagRowHtml(s, { sub: true, delay: i, parentName: node.main.name }); }).join('');
    }).join('');

    return '<div class="card tag-hero reveal">' +
        '<div class="tag-hero-main">' +
          '<div class="card-title" style="margin-bottom:6px">标签中心</div>' +
          '<p class="tag-hero-desc">两级结构：<b>主标签</b>对应资料库里的一个文件夹，<b>次标签</b>是它下面的子文件夹。颜色会同步到资料行、文件夹、主题卡与关联图；改名或删除时，文件夹与子文件夹一并跟随。</p>' +
        '</div>' +
        '<div class="kit-row tag-hero-stats">' +
          '<div class="stat-inline"><b>' + mainCount + '</b><span>主标签</span></div>' +
          '<div class="stat-inline"><b>' + subCount + '</b><span>次标签</span></div>' +
          '<div class="stat-inline"><b>' + used.length + '</b><span>使用中</span></div>' +
          '<div class="stat-inline"><b>' + unused.length + '</b><span>未使用</span></div>' +
        '</div>' +
        '<div class="kit-row tag-hero-acts">' +
          '<button class="btn btn-sm btn-primary" data-act="tag-new">新建主标签</button>' +
          (unused.length ? '<button class="btn btn-sm btn-ghost" data-act="cleanup-tags">清理 ' + unused.length + ' 个未使用标签</button>' : '') +
        '</div>' +
      '</div>' +

      '<div class="section-title"><h2>全部标签</h2><span>点击任意标签可改名、换色、换层级或删除</span></div>' +
      '<div class="card tag-table reveal">' + rows + '</div>' +

      '<div class="card tag-rules reveal">' +
        '<div class="card-title">归类规则</div>' +
        '<ul class="rule-list">' +
          '<li><b>两层结构</b>：主标签（<code>parentId = null</code>）→ 次标签（<code>parentId</code> 指向主标签）。次标签下不能再挂标签。</li>' +
          '<li><b>文件夹映射</b>：主标签 → <code>资料库/主标签</code>；次标签 → <code>资料库/主标签/次标签</code>。给资料只打次标签时，也会自动出现在对应主文件夹里。</li>' +
          '<li><b>主文件夹根层</b>：只打了主标签、没有打任何次标签的资料，显示在「未归入次标签」分组。</li>' +
          '<li><b>多标签资料</b>：默认同时出现在每个所属标签的文件夹中（只是视图复用，不复制文件）；切换为「只归入第一个标签」后，按其标签列表第一项归档。</li>' +
          '<li><b>重命名</b>：主标签改名 → 文件夹改名，所有次标签的归属与资料不变；次标签改名 → 只改子文件夹名。</li>' +
          '<li><b>删除</b>：次标签只解除关联；删除主标签时可选择「把次标签升为主标签」或「连带删除次标签」，资料本身始终保留。</li>' +
        '</ul>' +
      '</div>';
  }

  /* ---------------- 视图：智能分析 ---------------- */
  function viewAnalysis() {
    if (!state.docs.length) return emptyLibrary();
    const a = ensureAnalysis();
    const tab = state.analysisTab;
    const tabs = [['summary', '智能总结'], ['gaps', '知识缺口'], ['graph', '知识图谱'], ['suggest', '建议方案']];

    return '<div class="agent-bar reveal">' +
        '<div class="agent-avatar ' + (running ? 'working' : '') + '">' +
          '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8L12 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17.6 15.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
        '</div>' +
        '<div class="agent-copy">' +
          '<b>学习资料分析 Agent</b>' +
          '<span id="agentStatus">' + (running ? '正在读取资料…' : '已分析 ' + a.docCount + ' 篇资料 · ' + relTime(a.generatedAt) + ' · 全部在本地完成') + '</span>' +
          (running ? '<div class="progress" id="agentProgress"><i style="width:' + progress + '%"></i></div>' : '') +
        '</div>' +
        '<div class="agent-actions">' +
          '<button class="btn btn-sm btn-ghost" data-act="export-md">导出总结</button>' +
          '<button class="btn btn-primary btn-sm" data-act="run-analysis">' + (running ? '分析中…' : '运行分析') + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="seg-row" style="margin-top:16px">' +
        '<div class="segmented" data-seg="tab"><span class="seg-ind"></span>' +
          tabs.map((t) => '<button data-act="tab" data-tab="' + t[0] + '" class="' + (tab === t[0] ? 'active' : '') + '">' + t[1] + '</button>').join('') +
        '</div>' +
        '<span class="count-label">' + tabHint(tab, a) + '</span>' +
      '</div>' +

      (tab === 'summary' ? analysisSummary(a)
        : tab === 'gaps' ? analysisGaps(a)
        : tab === 'graph' ? analysisGraph(a)
        : analysisSuggest(a));
  }

  function tabHint(tab, a) {
    if (tab === 'summary') return a.docCount + ' 篇 · 按重要度排序';
    if (tab === 'gaps') return a.gaps.length + ' 项待补强';
    if (tab === 'graph') return state.graphMode === 'doc'
      ? a.edges.length + ' 条资料关联'
      : (a.conceptEdges || []).length + ' 条概念共现';
    return a.suggestions.length + ' 条可采纳建议';
  }

  function analysisSummary(a) {
    const docs = state.docs.slice().sort((x, y) => a.insights[y.id].importance - a.insights[x.id].importance);
    return '<div class="sum-grid">' + docs.map((d, i) => {
      const ins = a.insights[d.id];
      const relCount = a.edges.filter((e) => e.source === d.id || e.target === d.id).length;
      const themeTag = (d.tags && d.tags[0]) || null;
      return '<div class="sum-card reveal" data-act="doc" data-id="' + d.id + '" data-original="1" role="button" tabindex="0" aria-label="查看《' + esc(shortTitle(d.title)) + '》详情" style="animation-delay:' + Math.min(i * 20, 200) + 'ms">' +
        '<div class="sum-head"><div style="min-width:0">' +
          '<div class="sum-title">' + esc(shortTitle(d.title)) + '</div>' +
          '<div class="doc-meta" style="margin-top:4px"><span>' + (window.TYPE_META[d.type] || {}).label + '</span><i></i><span>' + (themeTag ? '<i class="t-dot" style="background:' + tagColor(themeTag) + '"></i>' : '') + esc(ins.theme) + '</span><i></i><span>' + relCount + ' 条关联</span></div>' +
        '</div>' +
        '<span class="imp-badge" style="color:' + (ins.importance > 70 ? '#c3271e' : ins.importance > 45 ? '#a86500' : '#6e6e73') + ';background:' + (ins.importance > 70 ? 'rgba(255,59,48,.10)' : ins.importance > 45 ? 'rgba(255,149,0,.12)' : 'rgba(120,120,128,.12)') + '">' + ins.importance + '</span>' +
        '</div>' +
        '<p class="sum-tldr">' + esc(ins.tldr) + '</p>' +
        '<ul class="points">' + ins.points.slice(0, 3).map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
        '<div class="kw-cloud">' + ins.keywords.slice(0, 5).map((k) =>
          '<button class="kw" data-act="concept" data-term="' + esc(k) + '" title="查看概念详情">' + esc(k) + '</button>').join('') + '</div>' +
        '<div class="sum-foot"><span class="card-sub">' + ins.charCount + ' 字 · 更新于 ' + fmtDate(d.updatedAt) + '</span>' +
          '<button class="adopt-btn" data-act="doc" data-id="' + d.id + '" data-original="1">回溯原文</button></div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function analysisGaps(a) {
    if (!a.gaps.length) {
      return '<div class="empty"><b>暂未发现明显缺口</b><p>资料结构比较完整，继续保持复习节奏</p></div>';
    }
    return '<div class="card reveal"><div class="gap-list">' + a.gaps.map((g) =>
      '<div class="gap">' +
        '<span class="gap-ico" style="background:' + toneBg(g.tone) + ';color:' + toneFg(g.tone) + '">' + g.icon + '</span>' +
        '<div class="gap-body">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="gap-title">' + esc(g.title) + '</span>' +
          '<span class="pri ' + (g.sev === 'high' ? 'high' : g.sev === 'mid' ? 'mid' : 'low') + '">' + (g.sev === 'high' ? '优先处理' : g.sev === 'mid' ? '建议处理' : '可延后') + '</span></div>' +
          '<div class="gap-desc">' + esc(g.desc) + '</div>' +
          '<div class="gap-fix"><b>做法</b><span>' + esc(g.fix) + '</span></div>' +
          (g.docIds.length ? '<div class="sug-docs" style="margin-top:7px">' + g.docIds.slice(0, 3).map((id) => {
            const d = docById(id);
            return d ? '<button class="doc-pill" data-act="doc" data-id="' + id + '">' + esc(shortTitle(d.title)) + '</button>' : '';
          }).join('') + '</div>' : '') +
        '</div>' +
      '</div>').join('') + '</div></div>';
  }

  /* ---------------- 知识图谱 ---------------- */
  function analysisGraph(a) {
    const mode = state.graphMode === 'doc' ? 'doc' : 'concept';
    const coreN = (a.concepts || []).filter(function (c) { return c.band === 'core'; }).length;
    const bar = '<div class="graph-bar reveal">' +
        '<div class="segmented mini" data-seg="graphMode"><span class="seg-ind"></span>' +
          '<button data-act="graph-mode" data-mode="concept" class="' + (mode === 'concept' ? 'active' : '') + '">概念图谱</button>' +
          '<button data-act="graph-mode" data-mode="doc" class="' + (mode === 'doc' ? 'active' : '') + '">资料图谱</button>' +
        '</div>' +
        '<span class="graph-hint">' + (mode === 'concept'
          ? '节点 = 概念，连线 = 同一篇资料中共现'
          : '节点 = 资料，连线 = 共享概念或主题') + '</span>' +
        '<div class="kit-row">' +
          (mode === 'concept'
            ? '<button class="btn btn-sm btn-ghost" data-act="graph-core">' + (state.graphCoreOnly ? '显示全部概念' : '只看核心 ' + coreN + ' 个') + '</button>'
            : '') +
          '<button class="btn btn-sm btn-ghost" data-act="graph-relayout">重新布局</button>' +
        '</div>' +
      '</div>';
    return bar + (mode === 'doc' ? docGraph(a) : conceptGraph(a));
  }

  /* 概念图谱：节点=概念，边=共现，颜色=主标签，大小=综合强度 */
  function conceptGraph(a) {
    const narrow = window.innerWidth < 720;
    const W = narrow ? 430 : 760, H = narrow ? 560 : 470;
    let pool = (a.concepts || []).filter(function (c) {
      return state.graphCoreOnly ? c.band === 'core' : (c.band === 'core' || c.df >= 2);
    }).slice(0, narrow ? 18 : 30);
    /* 资料少时上面会筛得过狠，退回按强度取前若干个 */
    if (pool.length < 6 && !state.graphCoreOnly) pool = (a.concepts || []).slice(0, narrow ? 10 : 14);

    if (pool.length < 2) {
      return '<div class="card reveal"><div class="empty"><b>概念太少，画不出图谱</b>' +
        '<p>至少需要 2 个概念。多导入几篇同主题的资料，或关闭「只看核心概念」</p></div></div>';
    }

    const terms = {};
    pool.forEach(function (c) { terms[c.term] = 1; });
    let edges = (a.conceptEdges || []).filter(function (e) { return terms[e.a] && terms[e.b]; });
    /* 每个节点最多保留 3 条最强边，避免毛线球 */
    const byNode = {};
    edges.forEach(function (e) {
      (byNode[e.a] = byNode[e.a] || []).push(e);
      (byNode[e.b] = byNode[e.b] || []).push(e);
    });
    const keep = [];
    Object.keys(byNode).forEach(function (k) {
      byNode[k].sort(function (x, y) { return y.w - x.w; }).slice(0, 3).forEach(function (e) { keep.push(e); });
    });
    edges = keep.filter(function (e, i) { return keep.indexOf(e) === i; });

    const maxTotal = Math.max.apply(null, pool.map(function (c) { return c.total; }).concat([1]));
    const nodes = pool.map(function (c) {
      return {
        id: c.term,
        label: Engine.trimTo(c.term, narrow ? 6 : 8),
        importance: c.total,
        r: clamp(9 + (c.total / maxTotal) * 13, 9, narrow ? 19 : 24),
        color: c.topic ? tagColor(c.topic) : '#8e8e93',
        kind: 'concept',
        tip: c.term + ' · ' + c.df + ' 篇 · ' + c.hits + ' 次',
        focus: state.graphFocus === c.term
      };
    });
    layoutGraph(nodes, edges, W, H);

    const byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    const maxW = Math.max.apply(null, edges.map(function (e) { return e.w; }).concat([1]));

    const edgeSvg = edges.map(function (e) {
      const s = byId[e.a], t = byId[e.b];
      if (!s || !t) return '';
      const w = clamp(0.8 + (e.w / maxW) * 2.4, 0.8, 3.4);
      return '<line class="gedge" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" x1="' + s.x.toFixed(1) + '" y1="' + s.y.toFixed(1) +
        '" x2="' + t.x.toFixed(1) + '" y2="' + t.y.toFixed(1) + '" stroke="#8a8a92" stroke-opacity="' +
        clamp(0.16 + (e.w / maxW) * 0.4, 0.16, 0.55).toFixed(2) + '" stroke-width="' + w.toFixed(1) + '" stroke-linecap="round"/>';
    }).join('');

    const nodeSvg = nodes.map(function (n) {
      return '<g class="gnode' + (n.focus ? ' focus' : '') + '" data-id="' + esc(n.id) + '" data-kind="concept" data-label="' + esc(n.tip) + '"' +
        ' transform="translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')">' +
        (n.focus ? '<circle class="halo" r="' + (n.r + 7).toFixed(1) + '" fill="none" stroke="' + n.color + '" stroke-width="2" stroke-opacity=".45"/>' : '') +
        '<circle r="' + n.r.toFixed(1) + '" fill="' + n.color + '" fill-opacity=".92" stroke="#fff" stroke-width="2.5"/>' +
        '<text class="' + (n.showLabel ? 'show' : '') + '" x="' + (n.lx - n.x).toFixed(1) + '" y="' + (n.ly - n.y).toFixed(1) +
        '" text-anchor="middle">' + esc(n.label) + '</text>' +
      '</g>';
    }).join('');

    const degree = {};
    edges.forEach(function (e) {
      degree[e.a] = (degree[e.a] || 0) + e.w;
      degree[e.b] = (degree[e.b] || 0) + e.w;
    });
    const hubs = nodes.slice().sort(function (x, y) { return (degree[y.id] || 0) - (degree[x.id] || 0); }).slice(0, 3);
    const pairs = edges.slice().sort(function (x, y) { return y.w - x.w; }).slice(0, 3);

    return '<div class="graph-wrap reveal">' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" id="graphSvg">' +
          '<g>' + edgeSvg + '</g><g>' + nodeSvg + '</g>' +
        '</svg>' +
        '<div class="graph-tip" id="graphTip"></div>' +
        '<div class="graph-legend">' +
          '<span><i style="background:#0a84ff"></i>节点大小 = 综合强度</span>' +
          '<span><i style="background:#8a8a92"></i>连线 = 同篇共现（越粗越强）</span>' +
          '<span><i style="background:#5856d6"></i>节点颜色 = 所属主标签</span>' +
          '<span><i style="background:#ff9500"></i>点击节点查看判定依据</span>' +
        '</div>' +
      '</div>' +
      '<div class="grid" style="grid-template-columns:repeat(2,1fr);margin-top:14px">' +
        '<div class="card"><div class="card-title" style="margin-bottom:10px">最强共现关系</div>' +
          (pairs.length ? pairs.map(function (e) {
            return '<div class="rel" data-act="concept" data-term="' + esc(e.a) + '">' +
              '<span class="rel-ico" style="background:' + (byId[e.a] || {}).color + '">↔</span>' +
              '<span class="rel-t">' + esc(e.a) + ' ↔ ' + esc(e.b) + '</span>' +
              '<span class="rel-w">权重 ' + e.w + '</span></div>';
          }).join('') : '<p class="hint" style="margin:0">还没有共现关系，多导入几篇同主题资料</p>') +
        '</div>' +
        '<div class="card"><div class="card-title" style="margin-bottom:10px">枢纽概念</div>' +
          hubs.map(function (n) {
            const c = (a.concepts || []).filter(function (x) { return x.term === n.id; })[0] || {};
            return '<div class="rel" data-act="concept" data-term="' + esc(n.id) + '">' +
              '<span class="rel-ico" style="background:' + n.color + '">◎</span>' +
              '<span class="rel-t">' + esc(n.id) + '</span>' +
              '<span class="rel-w">' + (c.df || 0) + ' 篇 · 连接 ' + Math.round(degree[n.id] || 0) + '</span></div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function docGraph(a) {
    const narrow = window.innerWidth < 720;
    const W = narrow ? 430 : 760, H = narrow ? 560 : 430;
    const nodes = state.docs.map((d) => ({
      id: d.id,
      label: Engine.trimTo(shortTitle(d.title), narrow ? 7 : 10),
      full: d.title,
      r: 9 + (a.insights[d.id].importance / 100) * 13,
      color: (d.tags && d.tags[0]) ? tagColor(d.tags[0]) : colorFor(d.type)
    }));
    const edges = a.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight, shared: e.shared }));
    layoutGraph(nodes, edges, W, H);

    const byId = {};
    nodes.forEach((n) => { byId[n.id] = n; });

    const edgeSvg = edges.map((e) => {
      const s = byId[e.source], t = byId[e.target];
      if (!s || !t) return '';
      const w = clamp(0.9 + e.weight * 0.28, 1, 3.4);
      return '<line class="gedge" data-a="' + e.source + '" data-b="' + e.target + '" x1="' + s.x.toFixed(1) + '" y1="' + s.y.toFixed(1) +
        '" x2="' + t.x.toFixed(1) + '" y2="' + t.y.toFixed(1) + '" stroke="#8a8a92" stroke-opacity="' +
        clamp(0.18 + e.weight * 0.06, 0.18, 0.5).toFixed(2) + '" stroke-width="' + w.toFixed(1) + '" stroke-linecap="round"/>';
    }).join('');

    const nodeSvg = nodes.map((n) =>
      '<g class="gnode" data-id="' + n.id + '" data-kind="doc" data-label="' + esc(n.full || n.label) + '"' +
        ' transform="translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')">' +
        '<circle r="' + n.r.toFixed(1) + '" fill="' + n.color + '" fill-opacity=".92" stroke="#fff" stroke-width="2.5"/>' +
        '<text class="' + (n.showLabel ? 'show' : '') + '" x="' + (n.lx - n.x).toFixed(1) + '" y="' + (n.ly - n.y).toFixed(1) +
        '" text-anchor="middle">' + esc(n.label) + '</text>' +
      '</g>').join('');

    return '<div class="graph-wrap reveal">' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" id="graphSvg">' +
          '<g>' + edgeSvg + '</g><g>' + nodeSvg + '</g>' +
        '</svg>' +
        '<div class="graph-tip" id="graphTip"></div>' +
        '<div class="graph-legend">' +
          '<span><i style="background:#0a84ff"></i>节点大小 = 重要度</span>' +
          '<span><i style="background:#8a8a92"></i>连线 = 共享概念或主题</span>' +
          '<span><i style="background:#5856d6"></i>节点颜色 = 主标签</span>' +
        '</div>' +
      '</div>' +
      '<div class="grid" style="grid-template-columns:repeat(2,1fr);margin-top:14px">' +
        '<div class="card"><div class="card-title" style="margin-bottom:10px">关联最紧密的资料对</div>' +
          (a.edges.length ? '' : '<p class="hint" style="margin:0">还没有资料对共享概念，导入同一主题的多篇资料后这里会建立连线</p>') +
          a.edges.slice().sort((x, y) => y.weight - x.weight).slice(0, 3).map((e) => {
            const s = docById(e.source), t = docById(e.target);
            if (!s || !t) return '';
            return '<div class="rel" data-act="doc" data-id="' + e.source + '"><span class="rel-ico" style="background:' + (((s.tags || [])[0]) ? tagColor(s.tags[0]) : colorFor(s.type)) + '">↗</span>' +
              '<span class="rel-t">' + esc(shortTitle(s.title)) + ' ↔ ' + esc(shortTitle(t.title)) + '</span>' +
              '<span class="rel-w">' + e.shared.slice(0, 2).join('·') + '</span></div>';
          }).join('') +
        '</div>' +
        '<div class="card"><div class="card-title" style="margin-bottom:10px">跨主题桥梁</div>' +
          nodes.slice().sort((x, y) => (a.degree[y.id] || 0) - (a.degree[x.id] || 0)).slice(0, 3).map((n) => {
            const d = docById(n.id);
            return '<div class="rel" data-act="doc" data-id="' + n.id + '"><span class="rel-ico" style="background:' + n.color + '">◎</span>' +
              '<span class="rel-t">' + esc(shortTitle(d.title)) + '</span>' +
              '<span class="rel-w">' + Math.round((a.degree[n.id] || 0) * 10) / 10 + ' 权重</span></div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function layoutGraph(nodes, edges, W, H) {
    const pad = 68;
    const seed = state.graphSeed || 0;
    nodes.forEach((n, i) => {
      const ang = i * 2.399963229 + seed * 0.83;
      const rad = Math.sqrt((i + 0.6) / nodes.length) * Math.min(W, H) * 0.46;
      n.x = W / 2 + Math.cos(ang) * rad * 1.18;
      n.y = H / 2 + Math.sin(ang) * rad * 0.92;
      n.vx = 0; n.vy = 0;
      n.side = i % 2 === 0 ? 1 : -1;
    });
    const idx = {};
    nodes.forEach((n, i) => { idx[n.id] = i; });
    /* 小图收紧一点：斥力更弱、向心力更强，避免几个节点被推到画布边缘 */
    const compact = nodes.length <= 14;
    const repK = compact ? 10000 : 14000;
    const pullK = compact ? 0.0052 : 0.0028;

    for (let it = 0; it < 520; it++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
          const d = Math.sqrt(d2);
          const rep = repK / d2;
          const ux = dx / d, uy = dy / d;
          a.vx -= ux * rep; a.vy -= uy * rep;
          b.vx += ux * rep; b.vy += uy * rep;
        }
      }
      edges.forEach((e) => {
        const a = nodes[idx[e.source]], b = nodes[idx[e.target]];
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const target = (compact ? 92 : 104) + 46 / (1 + e.weight * 0.25);
        const f = (d - target) * 0.022;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      });
      nodes.forEach((n) => {
        n.vx += (W / 2 - n.x) * pullK;
        n.vy += (H / 2 - n.y) * pullK;
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(pad, Math.min(W - pad, n.x));
        n.y = Math.max(pad + 6, Math.min(H - pad - 6, n.y));
      });
    }
    placeLabels(nodes, W, H);
  }

  /* 标签贪心放置：优先重要度高的节点，位置冲突则隐藏标签（悬停时显示） */
  function placeLabels(nodes, W, H) {
    const boxes = [];
    nodes.slice().sort((a, b) => b.importance - a.importance).forEach(function (n) {
      const w = Math.min(n.label.length, 11) * 8.6 + 10;
      const h = 13;
      const spots = [
        { x: n.x, y: n.y + n.r + 12, side: 1 },
        { x: n.x, y: n.y - n.r - 7, side: -1 },
        { x: n.x, y: n.y + n.r + 25, side: 1 }
      ];
      for (const sp of spots) {
        const box = { x1: sp.x - w / 2, y1: sp.y - h + 2, x2: sp.x + w / 2, y2: sp.y + 2 };
        if (box.x1 < 4 || box.x2 > W - 4) continue;
        const overlapLabel = boxes.some(function (b) { return !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2); });
        const overlapNode = nodes.some(function (o) {
          return o !== n && Math.abs(o.x - sp.x) < o.r + w / 2 * 0.7 && Math.abs(o.y - sp.y) < o.r + 6;
        });
        if (overlapLabel || overlapNode) continue;
        n.lx = sp.x; n.ly = sp.y; n.side = sp.side; n.showLabel = true;
        boxes.push(box);
        return;
      }
      n.showLabel = false;
      n.lx = n.x; n.ly = n.y + n.r + 12;
    });
  }

  function analysisSuggest(a) {
    return '<div class="sug-grid">' + a.suggestions.map((sg, i) => {
      const adopted = state.adopted.indexOf(sg.id) >= 0;
      const docs = sg.docIds.map(docById).filter(Boolean);
      return '<div class="sug' + (adopted ? ' adopted' : '') + ' reveal" style="animation-delay:' + Math.min(i * 40, 200) + 'ms">' +
        '<div class="sug-head">' +
          '<span class="sug-kind" style="background:' + toneBg(sg.kindTone) + ';color:' + toneFg(sg.kindTone) + '">' + esc(sg.kind) + '</span>' +
          '<div class="sug-title">' + esc(sg.title) + '</div>' +
          '<span class="pri ' + sg.priority + '">' + PRI[sg.priority] + '</span>' +
        '</div>' +
        '<div class="sug-block"><h5>依据</h5><p>' + esc(sg.basis) + '</p></div>' +
        '<div class="sug-block"><h5>适用场景</h5><p>' + esc(sg.scenario) + '</p></div>' +
        '<div class="sug-block"><h5>执行步骤</h5><ol class="steps">' + sg.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol></div>' +
        '<div class="sug-foot">' +
          '<div class="sug-docs">' + docs.slice(0, 3).map((d) => '<button class="doc-pill" data-act="doc" data-id="' + d.id + '">' + esc(shortTitle(d.title)) + '</button>').join('') +
            (docs.length > 3 ? '<span class="doc-pill">+' + (docs.length - 3) + ' 篇</span>' : '') + '</div>' +
          '<button class="adopt-btn ' + (adopted ? 'on' : '') + '" data-act="adopt" data-id="' + sg.id + '">' +
            (adopted ? '✓ 已采纳' : '采纳') + '</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  /* ---------------- 视图：备份 ---------------- */
  function viewBackup() {
    const a = ensureAnalysis();
    const total = state.docs.length;
    const synced = state.docs.filter((d) => d.backup && d.backup.state === 'synced').length;
    const pending = total - synced;
    const pct = Math.round((synced / Math.max(1, total)) * 100);
    const C = 2 * Math.PI * 34;
    const last = state.docs.reduce((m, d) => {
      if (!d.backup || !d.backup.at) return m;
      return !m || new Date(d.backup.at) > new Date(m) ? d.backup.at : m;
    }, null);

    return '<div class="backup-hero reveal">' +
        '<div class="backup-ring"><svg viewBox="0 0 86 86">' +
          '<circle cx="43" cy="43" r="34" fill="none" stroke="rgba(120,120,128,.13)" stroke-width="7"/>' +
          '<circle cx="43" cy="43" r="34" fill="none" stroke="#2fbf5c" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + (C * pct / 100) + ' ' + C + '"/></svg>' +
          '<div><b>' + pct + '%</b><small>已备份</small></div></div>' +
        '<div class="backup-copy"><b>' + (pending ? pending + ' 篇资料待备份' : '全部资料已安全备份') + '</b>' +
          '<p>' + synced + ' / ' + total + ' 篇已同步至备份区' + (last ? ' · 最近一次 ' + fmtDate(last) : '') + '。备份文件保存在本机，可随时导出为 JSON 存档。</p>' +
          '<div class="privacy-row" style="margin-top:9px;max-width:220px"><span style="color:var(--label-2);font-size:12px">自动备份</span>' +
            '<button class="switch" role="switch" aria-checked="' + (state.autoBackup ? 'true' : 'false') + '" data-act="toggle-auto"><i></i></button></div>' +
        '</div>' +
        '<div class="backup-actions">' +
          '<button class="btn btn-primary" data-act="backup-all" ' + (pending ? '' : 'disabled') + '>立即备份' + (pending ? '（' + pending + '）' : '') + '</button>' +
          '<button class="btn btn-ghost" data-act="export-json">导出存档</button>' +
        '</div>' +
      '</div>' +

      (running || (state._backupProgress != null)
        ? '<div class="card" style="margin-top:14px"><div class="card-title" style="margin-bottom:8px">正在备份…</div>' +
          '<div class="progress" id="backupProgress"><i style="width:' + (state._backupProgress || 0) + '%"></i></div></div>' : '') +

      '<div class="section-title"><h2>备份明细</h2><span>按最近更新排序</span></div>' +
      '<div class="card reveal" style="padding:8px 10px"><div class="doc-list">' +
        state.docs.slice().sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt)).map((d) => {
          const st = STATUS[(d.backup && d.backup.state) || 'local'] || STATUS.local;
          return '<div class="doc" data-act="doc" data-id="' + d.id + '">' +
            '<span class="doc-ico" style="background:' + (window.TYPE_META[d.type] || {}).color + '">' + (window.TYPE_META[d.type] || {}).short + '</span>' +
            '<span class="doc-main"><span class="doc-title">' + esc(d.title) + '</span>' +
            '<span class="doc-meta"><span class="status ' + st.cls + '"><i></i>' + st.label + '</span><i></i>' +
            '<span>' + (d.backup && d.backup.at ? fmtDate(d.backup.at) : '尚未备份') + '</span><i></i>' +
            '<span>' + fmtSize(d.size) + '</span></span></span>' +
            '<span class="doc-right">' +
              (st.cls === 'ok' ? '' : '<button class="btn btn-sm" data-act="backup" data-id="' + d.id + '">备份</button>') +
            '</span></div>';
        }).join('') +
      '</div></div>' +

      '<div class="two-col" style="margin-top:16px">' +
        '<div class="card reveal"><div class="card-title" style="margin-bottom:8px">数据与隐私</div>' +
          '<div class="gap" style="background:rgba(47,191,92,.05);border-color:rgba(47,191,92,.18)">' +
            '<span class="gap-ico" style="background:rgba(47,191,92,.12);color:#1f8a45">✓</span>' +
            '<span class="gap-body"><span class="gap-title">全流程本地处理</span>' +
            '<span class="gap-desc">资料正文与生成的总结仅写入浏览器 localStorage，分析引擎在页面内运行，不发送任何网络请求。</span></span></div>' +
          '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
            '<button class="btn btn-sm btn-ghost" data-act="export-json">导出 JSON 存档</button>' +
            (state.localMode ? '<button class="btn btn-sm btn-ghost" data-act="open-folder">打开资料文件夹</button>' : '') +
            '<button class="btn btn-sm btn-ghost" style="color:#c3271e" data-act="clear-data">清空本机数据</button>' +
          '</div>' +
        '</div>' +
        '<div class="card reveal"><div class="card-title" style="margin-bottom:10px">备份状态分布</div>' +
          '<div class="bars">' +
            ['synced:已备份:#2fbf5c', 'pending:待备份:#ff9500', 'local:仅本机:#ff3b30'].map((row) => {
              const p = row.split(':');
              const n = state.docs.filter((d) => ((d.backup && d.backup.state) || 'local') === p[0]).length;
              return '<div class="bar-row"><div class="bar-top"><span>' + p[1] + '</span><b>' + n + ' 篇</b></div>' +
                '<div class="bar-track"><div class="bar-fill" data-w="' + Math.round((n / Math.max(1, total)) * 100) + '" style="background:' + p[2] + '"></div></div></div>';
            }).join('') +
          '</div>' +
          '<p class="hint" style="margin-top:12px">建议保持「已备份」占比 100%。导出 JSON 后可存放到你自己的加密磁盘或密码管理器中。</p>' +
        '</div>' +
      '</div>';
  }

  /* ---------------- 渲染主流程 ---------------- */
  const VIEWS = {
    overview: { title: '总览', sub: '你的学习资料索引与洞察', render: viewOverview },
    library: { title: '资料库', sub: '', render: viewLibrary },
    topics: { title: '知识主题', sub: '按标签聚合的主题覆盖度', render: viewTopics },
    tags: { title: '标签', sub: '统一管理标签、配色与文件夹归类', render: viewTags },
    analysis: { title: '智能分析', sub: '本地引擎生成 · 结论可回溯到原文', render: viewAnalysis },
    backup: { title: '备份', sub: '本机资料的备份与安全', render: viewBackup }
  };

  function render() {
    ensureAnalysis();
    const v = VIEWS[state.view] || VIEWS.overview;
    $('#viewTitle').textContent = v.title;
    const mains = mainTags().length;
    $('#viewSub').textContent = state.view === 'library'
      ? '共 ' + state.docs.length + ' 篇 · ' + mains + ' 个主标签 · ' + (tagList().length - mains) + ' 个次标签'
      : (state.view === 'tags'
        ? mains + ' 个主标签 · ' + (tagList().length - mains) + ' 个次标签 · 颜色与文件夹统一管理'
        : (state.view === 'topics' && state.topicsTab === 'concepts'
          ? '从正文自动抽取的关键概念与核心词汇 · 可回溯原文'
          : v.sub));
    $('#content').innerHTML = v.render();
    updateChrome();
    afterRender();
  }

  function updateChrome() {
    $$('.nav-item, .tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-view') === state.view);
    });
    const n = $('#navDocCount');
    if (n) n.textContent = state.docs.length;
    const tn = $('#navTagCount');
    if (tn) tn.textContent = tagList().length;
    const dot = $('#navInsightDot');
    if (dot) dot.hidden = !(state.analysis && state.analysis.gaps.some((g) => g.sev === 'high'));
    const ss = $('#sideStatus');
    if (ss) {
      const a = state.analysis;
      if (!state.docs.length || !a) {
        ss.style.display = 'none';
      } else {
        const total = state.docs.length;
        const fresh = state.docs.filter((d) => daysSince(d.lastReviewed || d.updatedAt) <= 30).length;
        const rows = [
          { label: '备份完整', value: Math.round((a.stats.backedUp / total) * 100), color: '#2fbf5c' },
          { label: '主题覆盖', value: a.stats.avgCoverage, color: '#0a84ff' },
          { label: '复习新鲜度', value: Math.round((fresh / total) * 100), color: '#ff9500' }
        ];
        ss.style.display = '';
        ss.innerHTML = '<div class="ss-head"><span>资料健康度</span><span>' + total + ' 篇</span></div>' +
          rows.map((r) => '<div class="ss-row"><div class="ss-top"><span>' + r.label + '</span><b>' + r.value + '%</b></div>' +
            '<div class="ss-track"><div class="ss-fill" data-w="' + r.value + '" style="background:' + r.color + '"></div></div></div>').join('') +
          '<div class="ss-note">' + (a.stats.unsynced ? a.stats.unsynced + ' 篇待备份 · ' : '') + a.gaps.length + ' 项待补强</div>';
        requestAnimationFrame(() => {
          $$('.ss-fill[data-w]').forEach((el) => { el.style.width = el.getAttribute('data-w') + '%'; });
        });
      }
    }
    document.body.classList.toggle('privacy', !!state.privacy);
    const sw = $('#privacySwitch');
    if (sw) sw.setAttribute('aria-checked', state.privacy ? 'true' : 'false');
    updateStorageText();
  }

  function updateStorageText() {
    const el = $('#storageText');
    if (!el) return;
    try {
      const bytes = new Blob([JSON.stringify(state)]).size;
      el.textContent = '本地存储 · ' + (bytes / 1024).toFixed(1) + ' KB';
    } catch (e) {
      el.textContent = '本地存储';
    }
  }

  function afterRender() {
    requestAnimationFrame(() => {
      $$('.bar-fill[data-w]').forEach((el) => {
        el.style.width = el.getAttribute('data-w') + '%';
      });
    });
    $$('.segmented').forEach((seg) => {
      const active = seg.querySelector('button.active');
      const ind = seg.querySelector('.seg-ind');
      if (!active || !ind) return;
      ind.style.width = active.offsetWidth + 'px';
      ind.style.transform = 'translateX(' + (active.offsetLeft - 3) + 'px)';
    });
    bindGraph();
    // 逐项入场的轻微错峰
    $$('.reveal').forEach((el, i) => {
      if (el.style.animationDelay) return;
      if (i < 14) el.style.animationDelay = (i * 18) + 'ms';
    });
  }

  /* ---------------- 关联图交互 ---------------- */
  function bindGraph() {
    const svg = $('#graphSvg');
    if (!svg) return;
    const tip = $('#graphTip');
    const wrap = svg.parentElement;
    const nodes = $$('.gnode', svg);
    const edges = $$('.gedge', svg);

    function clear() {
      nodes.forEach((n) => n.classList.remove('dim'));
      edges.forEach((e) => { e.setAttribute('stroke-opacity', e.getAttribute('data-op') || '0.16'); });
      if (tip) tip.classList.remove('on');
    }

    nodes.forEach((g) => {
      const id = g.getAttribute('data-id');
      const kind = g.getAttribute('data-kind') || 'doc';
      const tipText = g.getAttribute('data-label') || ((docById(id) || {}).title || id);
      g.addEventListener('mouseenter', function (e) {
        const rel = {};
        edges.forEach((line) => {
          const a = line.getAttribute('data-a'), b = line.getAttribute('data-b');
          if (a === id || b === id) { rel[a === id ? b : a] = true; line.setAttribute('stroke-opacity', '0.55'); }
        });
        nodes.forEach((n) => {
          const nid = n.getAttribute('data-id');
          if (nid !== id && !rel[nid]) n.classList.add('dim');
        });
        if (tip) {
          const r = wrap.getBoundingClientRect();
          tip.textContent = tipText;
          tip.style.left = (e.clientX - r.left) + 'px';
          tip.style.top = (e.clientY - r.top) + 'px';
          tip.classList.add('on');
        }
      });
      g.addEventListener('mousemove', function (e) {
        if (!tip) return;
        const r = wrap.getBoundingClientRect();
        tip.style.left = (e.clientX - r.left) + 'px';
        tip.style.top = (e.clientY - r.top) + 'px';
      });
      g.addEventListener('mouseleave', clear);
      g.addEventListener('click', function () {
        if (kind === 'concept') openConcept(id); else openDoc(id);
      });
    });
    edges.forEach((e) => e.setAttribute('data-op', e.getAttribute('stroke-opacity')));
  }

  /* ---------------- 面板（Sheet） ---------------- */
  let sheetCloseTimer = null;

  function openSheet(parts, opts) {
    clearTimeout(sheetCloseTimer);
    pickerApi = null;
    const root = $('#sheetRoot');
    root.innerHTML =
      '<div class="sheet-backdrop" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true">' +
        '<div class="sheet-grabber"></div>' +
        '<div class="sheet-head">' +
          '<div class="sheet-head-main">' +
            '<div class="sheet-eyebrow">' + (parts.eyebrow || '') + '</div>' +
            '<div class="sheet-title">' + (parts.title || '') + '</div>' +
            (parts.meta ? '<div class="sheet-meta">' + parts.meta + '</div>' : '') +
          '</div>' +
          '<button class="icon-btn" data-act="close-sheet" aria-label="关闭">' +
            '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="sheet-body">' + (parts.body || '') + '</div>' +
        (parts.footer ? '<div class="sheet-foot">' + parts.footer + '</div>' : '') +
      '</div>';
    root.classList.add('open');
    root.classList.remove('closing');
    root.setAttribute('aria-hidden', 'false');
    if (opts && opts.mount) opts.mount(root);
    bindSheetDrag(root);
    return root;
  }

  function bindSheetDrag(root) {
    const grab = root.querySelector('.sheet-grabber');
    const sheet = root.querySelector('.sheet');
    if (!grab || !sheet) return;
    let startY = 0, dy = 0, dragging = false;
    grab.addEventListener('pointerdown', function (e) {
      dragging = true; startY = e.clientY; dy = 0;
      sheet.style.transition = 'none';
      if (grab.setPointerCapture) grab.setPointerCapture(e.pointerId);
    });
    grab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = 'translateY(' + dy + 'px)';
    });
    const end = function () {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = 'transform .3s cubic-bezier(.32,.72,0,1)';
      if (dy > 96) {
        sheet.style.transform = 'translateY(100%)';
        setTimeout(closeSheet, 160);
      } else {
        sheet.style.transform = '';
      }
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  }

  function closeSheet() {
    const root = $('#sheetRoot');
    if (!root.classList.contains('open')) return;
    root.classList.add('closing');
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(() => {
      root.classList.remove('open', 'closing');
      root.innerHTML = '';
      root.setAttribute('aria-hidden', 'true');
    }, 240);
  }

  /* ---------------- 资料详情：标签选择器 ---------------- */
  let pickerApi = null;
  let sheetDocId = null;

  /* 在原文区域里定位并高亮某个概念 */
  function jumpToTerm(term) {
    const root = $('#sheetRoot');
    const el = $('#originalText', root);
    if (!el) return false;
    const target = String(term || '').toLowerCase();
    const marks = Array.prototype.slice.call(el.querySelectorAll('mark'));
    const hit = marks.filter(function (m) {
      return String(m.getAttribute('data-term') || m.textContent || '').toLowerCase() === target;
    })[0];
    if (!hit) { toast('原文里没有找到「' + term + '」'); return false; }
    hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    hit.classList.add('flash');
    setTimeout(function () { hit.classList.remove('flash'); }, 1800);
    return true;
  }

  function docTagChipsHtml(d) {
    if (!d || !d.tags || !d.tags.length) return '<span class="muted" style="font-size:12px">还没有标签</span>';
    return d.tags.map(function (t) {
      const c = tagColor(t);
      const tag = tagByName(t);
      const parent = tag && tag.parentId ? ((tagById(tag.parentId) || {}).name || '') : '';
      return '<span class="chip tg-chip' + (parent ? ' is-sub' : '') + '" title="' + esc(parent ? parent + ' / ' + t : t) + '"' +
        ' style="background:' + hexA(c, 0.11) + ';color:' + shade(c, 0.14) + '">' +
        '<i class="tg-dot" style="background:' + c + '"></i>' + esc(t) +
        '<button data-act="tag-remove" data-id="' + d.id + '" data-tag="' + esc(t) + '" aria-label="移除标签" style="color:' + shade(c, 0.14) + '">×</button></span>';
    }).join('');
  }

  function tagUsageMap() {
    const map = {};
    state.docs.forEach(function (d) {
      (d.tags || []).forEach(function (t) { map[t] = (map[t] || 0) + 1; });
    });
    return map;
  }

  /* 选择器列表：已用标签按使用量排序，输入时实时过滤，并给出「创建」项 */
  function tagPickerHtml(d, rawQuery) {
    if (!d) return '';
    const inputName = cleanTagName(rawQuery);
    const q = inputName.toLowerCase();
    const own = d.tags || [];
    const uses = tagUsageMap();
    /* 主标签在前、其次标签紧随其后，便于看出层级 */
    const list = [];
    mainTags().map(function (m) { return { t: m, n: folderUsage(m) }; })
      .sort(function (a, b) { return b.n - a.n || a.t.name.localeCompare(b.t.name, 'zh-Hans-CN'); })
      .forEach(function (node) {
        list.push(node.t);
        subTagsOf(node.t.id).slice()
          .sort(function (x, y) { return (uses[y.name] || 0) - (uses[x.name] || 0) || x.name.localeCompare(y.name, 'zh-Hans-CN'); })
          .forEach(function (s) { list.push(s); });
      });
    const avail = list.filter(function (t) {
      return own.indexOf(t.name) < 0 && (!q || t.name.toLowerCase().indexOf(q) >= 0);
    });

    let html = '<div class="tp-head"><span>已有标签</span><span>' + list.length + '</span></div>';

    if (avail.length) {
      html += avail.slice(0, 40).map(function (t) {
        const parent = t.parentId ? (tagById(t.parentId) || {}).name : '';
        return '<button type="button" class="tp-item' + (t.parentId ? ' is-sub' : '') + '" data-act="tag-pick" data-id="' + d.id + '" data-tag="' + esc(t.name) + '">' +
          '<i class="tg-dot" style="background:' + t.color + '"></i>' +
          '<span class="tp-name">' + esc(t.name) + '</span>' +
          (parent ? '<span class="tp-parent">' + esc(parent) + '</span>' : '') +
          '<span class="tp-use">' + (uses[t.name] || 0) + ' 篇</span></button>';
      }).join('');
    } else if (!list.length) {
      html += '<div class="tp-empty">还没有标签，输入名称回车即可创建</div>';
    } else if (!q) {
      html += '<div class="tp-empty">所有标签都加在这份资料上了</div>';
    }

    const exist = list.filter(function (t) { return t.name === inputName; })[0];
    if (inputName && !exist) {
      html += '<button type="button" class="tp-item tp-create" data-act="tag-pick" data-id="' + d.id + '" data-tag="' + esc(inputName) + '">' +
        '<span class="tp-plus">＋</span>' +
        '<span class="tp-name">创建「' + esc(inputName) + '」</span>' +
        '<i class="tg-dot" style="background:' + pickTagColor() + '"></i></button>';

      /* 这份资料已有主标签时，顺手给出「作为其次标签创建」的入口 */
      const ownTags = own.map(function (n) { return tagByName(n); }).filter(Boolean);
      const docMain = ownTags.filter(function (t) { return !t.parentId; })[0] ||
        (ownTags.filter(function (t) { return t.parentId; })[0] ? tagById(ownTags.filter(function (t) { return t.parentId; })[0].parentId) : null);
      if (docMain) {
        html += '<button type="button" class="tp-item tp-create" data-act="tag-pick-sub" data-id="' + d.id +
          '" data-parent="' + docMain.id + '" data-tag="' + esc(inputName) + '">' +
          '<span class="tp-plus">＋</span>' +
          '<span class="tp-name">在「' + esc(docMain.name) + '」下创建次标签</span>' +
          '<i class="tg-dot" style="background:' + docMain.color + '"></i></button>';
      }
    }
    return html;
  }

  function movePickerActive(panel, step) {
    const items = Array.prototype.slice.call(panel.querySelectorAll('.tp-item'));
    if (!items.length) return;
    let i = -1;
    items.forEach(function (el, k) { if (el.classList.contains('active')) i = k; });
    i = i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
    items.forEach(function (el) { el.classList.remove('active'); });
    items[i].classList.add('active');
    if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }

  function mountTagPicker(root, docId) {
    const input = $('#tagAddInput', root);
    const panel = $('#tagPicker', root);
    const field = $('#tagField', root);
    if (!input || !panel) return;

    const open = function () {
      const d = docById(docId);
      if (!d) return;
      panel.hidden = false;
      panel.innerHTML = tagPickerHtml(d, input.value);
      input.setAttribute('aria-expanded', 'true');
      if (field) field.classList.add('picking');
      /* 列表超出可视区域时把面板推上来，避免被面板底部裁掉 */
      const body = panel.closest('.sheet-body');
      if (body) {
        requestAnimationFrame(function () {
          const pr = panel.getBoundingClientRect();
          const br = body.getBoundingClientRect();
          if (pr.bottom > br.bottom - 6) body.scrollTop += pr.bottom - br.bottom + 14;
        });
      }
    };
    const close = function () {
      panel.hidden = true;
      panel.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      if (field) field.classList.remove('picking');
    };

    pickerApi = { open: open, close: close, toggle: function () { if (panel.hidden) open(); else close(); } };

    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('input', function () {
      if (panel.hidden) open();
      else panel.innerHTML = tagPickerHtml(docById(docId), input.value);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        /* 先收起选择器；选择器已收起时才让 Esc 去关面板 */
        if (!panel.hidden) { e.stopPropagation(); close(); input.blur(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (panel.hidden) open();
        movePickerActive(panel, e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const active = panel.querySelector('.tp-item.active');
      if (active) { active.click(); return; }
      const name = cleanTagName(input.value);
      if (!name) return;
      if (addTag(docId, name)) { input.value = ''; open(); }
    });
    /* 点选列表时保持输入框焦点，避免先 blur 再 click 丢失事件 */
    panel.addEventListener('mousedown', function (e) {
      if (e.target.closest('.tp-item')) e.preventDefault();
    });
    input.addEventListener('blur', function () {
      setTimeout(function () {
        if (!panel.contains(document.activeElement)) close();
      }, 140);
    });
  }

  /* 标签增删后就地刷新胶囊与列表，避免整块面板重绘丢失滚动位置 */
  function refreshDocTags(id) {
    const root = $('#sheetRoot');
    if (!root || !root.classList.contains('open')) return;
    const d = docById(id);
    if (!d) return;
    const chips = $('#docTagChips', root);
    if (chips) chips.innerHTML = docTagChipsHtml(d);
    const panel = $('#tagPicker', root);
    const input = $('#tagAddInput', root);
    if (panel && input && !panel.hidden) panel.innerHTML = tagPickerHtml(d, input.value);
  }

  function openDoc(id, opts) {
    opts = opts || {};
    const d = docById(id);
    if (!d) return;
    const a = ensureAnalysis();
    const ins = a.insights[id];
    const meta = window.TYPE_META[d.type] || window.TYPE_META.note;
    const st = STATUS[(d.backup && d.backup.state) || 'local'] || STATUS.local;

    const rel = a.edges.filter((e) => e.source === id || e.target === id)
      .sort((x, y) => y.weight - x.weight).slice(0, 4)
      .map((e) => ({ d: docById(e.source === id ? e.target : e.source), w: e.weight, shared: e.shared }))
      .filter((x) => x.d);

    const canExtract = !!(d.fileRel && state.localMode && EXTRACT_TYPES.indexOf(d.type) >= 0);
    const missingText = !!ins.needsText;

    const summaryHtml =
      '<div class="sheet-section-title" style="justify-content:space-between;gap:10px">智能摘要' +
        (canExtract
          ? '<button class="link-btn" data-act="reextract" data-id="' + d.id + '">' +
            (missingText ? '提取正文' : '重新提取正文') + '</button>'
          : '') +
      '</div>' +
      (missingText
        ? '<div class="sum-empty">' +
            '<b>还没有可分析的正文</b>' +
            '<p>' + (canExtract
              ? '原件已存入资料文件夹，点上面的「提取正文」，解析出的文字会自动生成摘要与关键词。'
              : 'PDF / Word / PPT 需要本地解析：用 npm start 打开工作台后，再回来提取。') + '</p>' +
          '</div>'
        : '<p class="sum-tldr" style="margin:0 0 8px">' + esc(ins.tldr) + '</p>' +
          (ins.points.length ? '<ul class="points">' + ins.points.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' : '') +
          '<div class="sum-src">正文 ' + Number(ins.charCount || 0).toLocaleString() + ' 字' +
            (d.pages ? ' · ' + d.pages + ' 页' : '') +
            (d.extractedAt ? ' · 导入时已解析' : '') + '</div>');

    const concepts = ins.concepts || [];
    const keywordHtml = concepts.length
      ? '<div class="sheet-section-title" style="justify-content:space-between;gap:10px">关键概念' +
          '<button class="link-btn" data-act="concept-rules">判定规则</button></div>' +
        '<div class="kw-cloud concept-chips">' + concepts.map(function (c, i) {
          return '<button class="kw concept-chip' + (i === 0 ? ' hot' : '') + '" data-act="concept-jump" data-doc="' + d.id +
            '" data-term="' + esc(c.term) + '" title="出现 ' + c.freq + ' 次 · 强度 ' + c.score + ' · 点击定位原文">' +
            esc(c.term) + '<em>' + c.freq + '</em></button>';
        }).join('') + '</div>' +
        '<div class="hint">点概念可跳到原文；点「判定规则」看它为什么被选中</div>'
      : (ins.keywords.length
        ? '<div class="sheet-section-title">关键词</div>' +
          '<div class="kw-cloud">' + ins.keywords.map((k) => '<span class="kw hot">' + esc(k) + '</span>').join('') + '</div>'
        : '');

    const tagHtml =
      '<div class="sheet-section-title" style="justify-content:space-between;gap:10px">标签' +
        '<button class="link-btn" data-act="tag-manager">管理全部标签</button></div>' +
      '<div class="chips-edit" id="docTagChips">' + docTagChipsHtml(d) + '</div>' +
      '<div class="tag-add-row">' +
        '<div class="tag-field" id="tagField">' +
          '<input class="input" id="tagAddInput" data-id="' + d.id + '" placeholder="输入或点击选择已有标签"' +
            ' autocomplete="off" role="combobox" aria-expanded="false" aria-controls="tagPicker" aria-autocomplete="list">' +
          '<button type="button" class="tag-picker-btn" data-act="tag-toggle" data-id="' + d.id + '" aria-label="选择已有标签" tabindex="-1">' +
            '<svg viewBox="0 0 24 24" fill="none"><path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="tag-picker" id="tagPicker" role="listbox" hidden></div>' +
        '<div class="hint" id="tagHint">点开可选已有标签；输入新名称回车会自动创建并分配颜色</div>' +
      '</div>' +

      (rel.length ? '<div class="sheet-section-title">关联资料</div><div class="rel-list">' +
        rel.map((r) => '<button class="rel" data-act="doc" data-id="' + r.d.id + '">' +
          '<span class="rel-ico" style="background:' + (window.TYPE_META[r.d.type] || {}).color + '">↗</span>' +
          '<span class="rel-t">' + esc(r.d.title) + '</span>' +
          '<span class="rel-w">' + esc((r.shared || []).slice(0, 2).join('·')) + '</span></button>').join('') +
        '</div>' : '') +

      (d.fileRel ? '<div class="sheet-section-title">原始文件</div>' +
        '<div class="file-card">' +
          '<span class="file-ico" style="background:' + (window.TYPE_META[d.type] || {}).color + '">' + (window.TYPE_META[d.type] || {}).short + '</span>' +
          '<span class="file-main"><b>' + esc(d.fileName || d.title) + '</b>' +
          '<span>' + (state.localMode ? esc(state.vault || '资料文件夹') : '浏览器模式 · 无法访问本机文件') + '</span></span>' +
          '<span class="file-acts">' +
            '<button class="btn btn-sm" data-act="reveal" data-id="' + d.id + '">在访达中显示</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="open-file" data-id="' + d.id + '">打开</button>' +
          '</span>' +
        '</div>' : '') +

      '<div class="sheet-section-title">原始文档</div>' +
      '<div class="original" id="originalText">' +
        (d.content ? Engine.highlight(d.content, ins.keywords) : '（暂无正文）') + '</div>';
    const body =
      '<div class="kv">' +
        '<div><span>类型</span><b>' + meta.label + ' · ' + fmtSize(d.size) + '</b></div>' +
        '<div><span>重要度</span><b>' + ins.importance + ' / 100</b></div>' +
        '<div><span>最近复习</span><b>' + fmtDate(d.lastReviewed) + '</b></div>' +
        '<div><span>备份状态</span><b>' + st.label + (d.backup && d.backup.at ? ' · ' + fmtDate(d.backup.at) : '') + '</b></div>' +
      '</div>' +
      summaryHtml + keywordHtml + tagHtml;

    sheetDocId = d.id;
    openSheet({
      eyebrow: '资料详情',
      title: esc(d.title),
      meta: '<span>' + meta.label + '</span><span>·</span><span>加入于 ' + fmtDate(d.createdAt) + '</span><span>·</span>' +
        '<span class="status ' + st.cls + '"><i></i>' + st.label + '</span>',
      body: body,
      footer: '<button class="btn btn-sm" style="color:#c3271e" data-act="delete-doc" data-id="' + d.id + '">删除资料</button>' +
        '<div class="group">' +
          (d.fileRel && state.localMode
            ? '<button class="btn btn-sm" data-act="reveal" data-id="' + d.id + '">在访达中显示</button>'
            : '<button class="btn btn-sm" data-act="goto-original">查看原文</button>') +
          '<button class="btn btn-sm" data-act="backup" data-id="' + d.id + '">' + (st.cls === 'ok' ? '重新备份' : '立即备份') + '</button>' +
          '<button class="btn btn-sm btn-primary" data-act="close-sheet">完成</button>' +
        '</div>'
    }, {
      mount: function (root) {
        mountTagPicker(root, d.id);
        if (opts.original) {
          const el = $('#originalText', root);
          if (el) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 240);
        }
        /* 从概念详情跳进来：定位到该术语并高亮 */
        if (opts.focusTerm) {
          setTimeout(function () { jumpToTerm(opts.focusTerm); }, 420);
        }
        /* 老资料首次打开时自动补解析一次，省得逐篇点按钮 */
        if (canExtract && missingText && !d.extractTried) {
          d.extractTried = true;
          save();
          setTimeout(function () { reextractDoc(d.id, true); }, 420);
        }
      }
    });
  }

  function openTopic(name) {
    const a = ensureAnalysis();
    const t = a.topics.filter((x) => x.name === name)[0];
    if (!t) return;
    const docs = t.docIds.map(docById).filter(Boolean);
    openSheet({
      eyebrow: '知识主题',
      title: esc(name),
      meta: '<span>' + t.count + ' 篇资料</span><span>·</span><span>覆盖度 ' + t.coverage + '%</span>',
      body:
        '<div class="kv" style="grid-template-columns:1fr 1fr">' +
          '<div><span>覆盖度</span><b>' + t.coverage + '%</b></div>' +
          '<div><span>关键概念</span><b>' + esc(t.keywords.slice(0, 3).join('、')) + '</b></div>' +
        '</div>' +
        '<div class="sheet-section-title">主题下的资料</div>' +
        '<div class="doc-list">' + docs.map((d) => docRow(d, { hideStatus: true })).join('') + '</div>',
      footer: '<span class="card-sub">主题覆盖度由资料数量、类型多样性与复习新鲜度加权</span>' +
        '<button class="btn btn-sm btn-primary" data-act="close-sheet">完成</button>'
    });
  }

  function openImport() {
    const a = ensureAnalysis();
    const suggestions = a.topics.filter((t) => t.name !== '未归类').slice(0, 5).map((t) => t.name);
    openSheet({
      eyebrow: '导入资料',
      title: '把资料收进知识库',
      meta: '<span>本地解析</span><span>·</span><span>支持 Markdown / 文本 / Word / PDF / PPT</span>' +
        (state.localMode ? '<span>·</span><span>原件存入 ' + esc(state.vault) + '</span>' : ''),
      body:
        '<div class="dropzone" id="dropzone">' +
          '<b>拖入文件，或点击选择</b>' +
          '<span>文本类文件会直接读取正文；其他格式先记录元信息，可在详情中粘贴内容</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 14px">' +
          '<div class="hairline" style="flex:1"></div><span class="card-sub">或粘贴一段内容</span><div class="hairline" style="flex:1"></div>' +
        '</div>' +
        '<div class="field"><label>标题</label><input class="input" id="impTitle" placeholder="例如：菲利普斯曲线的推导笔记"></div>' +
        '<div class="field"><label>标签</label><input class="input" id="impTags" placeholder="用逗号分隔，例如：通货膨胀, 习题">' +
          '<div class="hint">常用标签：' + suggestions.map(esc).join(' · ') + '</div></div>' +
        '<div class="field"><label>正文</label><textarea class="textarea" id="impContent" placeholder="粘贴笔记、论文摘要、章节要点…"></textarea></div>',
      footer: '<span class="card-sub">仅保存在本机浏览器</span>' +
        '<div class="group"><button class="btn btn-sm" data-act="close-sheet">取消</button>' +
        '<button class="btn btn-sm btn-primary" data-act="save-import">保存到资料库</button></div>'
    }, {
      mount: function (root) {
        const dz = $('#dropzone', root);
        if (!dz) return;
        dz.addEventListener('click', () => $('#fileInput').click());
        ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
          e.preventDefault(); dz.classList.add('dragover');
        }));
        ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
          e.preventDefault(); dz.classList.remove('dragover');
        }));
        dz.addEventListener('drop', (e) => {
          if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
        });
      }
    });
  }

  function confirmSheet(title, desc, okText) {
    return new Promise((resolve) => {
      openSheet({
        eyebrow: '请确认',
        title: title,
        body: '<p style="margin:0;font-size:13px;color:var(--label-2);line-height:1.65">' + desc + '</p>',
        footer: '<button class="btn btn-sm" data-act="close-sheet">取消</button>' +
          '<button class="btn btn-sm" data-act="confirm-ok" style="background:#ff3b30;color:#fff">' + okText + '</button>'
      });
      const handler = (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'confirm-ok') { cleanup(); closeSheet(); resolve(true); }
        else if (act === 'close-sheet' || btn.classList.contains('sheet-backdrop')) { cleanup(); resolve(false); }
      };
      const cleanup = () => document.removeEventListener('click', handler, true);
      document.addEventListener('click', handler, true);
    });
  }

  /* ---------------- 标签编辑面板 ---------------- */
  function openTagSheet(id, opts) {
    opts = opts || {};
    const isNew = !id;
    const t = isNew ? null : tagById(id);
    if (!isNew && !t) return;
    const usage = t ? tagUsage(t.name) : 0;
    const color = t ? t.color : (opts.parentId ? (tagById(opts.parentId) || {}).color : pickTagColor()) || pickTagColor();
    const name = t ? t.name : '';
    const subs = t ? subTagsOf(t.id) : [];
    const mains = mainTags().filter(function (m) { return !t || m.id !== t.id; });
    const startParentId = t ? (t.parentId || '') : (opts.parentId || '');
    const lockLevel = subs.length > 0;      /* 有次标签的主标签不能再降为次标签 */
    const canSub = !lockLevel && mains.length > 0;
    const startLevel = startParentId ? 'sub' : 'main';

    const levelSelect =
      '<select class="input select" id="tagLevelSelect">' +
        '<option value="main"' + (startLevel === 'main' ? ' selected' : '') + '>主标签 · 生成资料库文件夹</option>' +
        '<option value="sub"' + (startLevel === 'sub' ? ' selected' : '') + (canSub ? '' : ' disabled') + '>次标签 · 放进主标签文件夹内</option>' +
      '</select>';

    const parentSelect =
      '<div class="field" id="tagParentField"' + (startLevel === 'sub' ? '' : ' hidden') + '>' +
        '<label>归属的主标签</label>' +
        '<select class="input select" id="tagParentSelect">' +
          mains.map(function (m) {
            return '<option value="' + m.id + '"' + (m.id === startParentId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
          }).join('') +
        '</select>' +
        '<div class="hint">文件夹路径：资料库 / 主标签 / 次标签</div>' +
      '</div>';

    const body =
      '<div class="field"><label>标签名称</label>' +
        '<input class="input" id="tagNameInput" maxlength="20" autocomplete="off" placeholder="例如：索洛模型" value="' + esc(name) + '">' +
        '<div class="hint">最多 20 字；逗号与 # 会被自动去掉；名称在全部标签中唯一。</div>' +
      '</div>' +

      '<div class="sheet-section-title">层级归属</div>' +
      levelSelect +
      (canSub ? '' : '<div class="hint" style="margin-top:5px">' +
        (lockLevel ? '该主标签下已有次标签，不能再改为次标签（最多两级）。' : '还没有其它主标签可作为归属，先创建一个主标签。') + '</div>') +
      parentSelect +
      '<div class="path-preview" id="tagPathPreview"></div>' +
      (t && !t.parentId && !subs.length
        ? '<button class="link-btn" style="margin-top:8px" data-act="tag-new-sub" data-parent="' + t.id + '">＋ 在此标签下新建次标签</button>'
        : '') +

      '<div class="sheet-section-title">标签颜色</div>' +
      '<div class="color-grid" id="tagColorGrid" data-color="' + color + '">' +
        TAG_COLORS.map((c) => '<button class="color-dot' + (c === color ? ' active' : '') + '" data-color="' + c +
          '" style="background:' + c + '" aria-label="颜色 ' + c + '"></button>').join('') +
        '<label class="color-dot custom" title="自定义颜色"><input type="color" id="tagCustomColor" value="' + color + '"></label>' +
      '</div>' +
      '<div class="tag-preview">' +
        '<span class="tag tg" id="tagPreview" style="background:' + hexA(color, 0.11) + ';color:' + shade(color, 0.14) + '">' +
          '<i class="tg-dot" style="background:' + color + '"></i><span>' + esc(name || '标签预览') + '</span></span>' +
        '<span class="hint">颜色同步到资料行、文件夹、主题卡与关联图</span>' +
      '</div>' +

      (subs.length ? '<div class="sheet-section-title" style="justify-content:space-between;gap:10px">次标签 · ' + subs.length +
          '<button class="link-btn" data-act="tag-new-sub" data-parent="' + t.id + '">＋ 新建</button></div>' +
        '<div class="subtag-list">' + subs.map(function (s) {
          return '<button class="subtag-item" data-act="tag-edit" data-id="' + s.id + '">' +
            '<i class="tg-dot" style="background:' + s.color + '"></i>' +
            '<span>' + esc(s.name) + '</span>' +
            '<em>' + tagUsage(s.name) + ' 篇</em></button>';
        }).join('') + '</div>' : '') +

      (isNew ? '' :
        '<div class="sheet-section-title">使用情况</div>' +
        '<div class="kv">' +
          '<div><span>关联资料</span><b>' + usage + ' 篇</b></div>' +
          '<div><span>' + (t.parentId ? '所在子文件夹' : '资料库文件夹') + '</span><b>' +
            esc(t.parentId ? ((tagParent(t) || {}).name || '—') + ' / ' + t.name : t.name) + '</b></div>' +
          '<div><span>创建时间</span><b>' + fmtDate(t.createdAt) + '</b></div>' +
          '<div><span>最近修改</span><b>' + fmtDate(t.updatedAt) + '</b></div>' +
        '</div>' +
        '<p class="hint" style="margin-top:10px">重命名后，' + usage + ' 篇资料的标签与对应' + (t.parentId ? '子文件夹' : '文件夹') + '会立即同步。</p>');

    openSheet({
      eyebrow: isNew ? (opts.parentId ? '新建次标签' : '新建主标签') : '标签设置',
      title: isNew ? (opts.parentId ? '在主标签下新建次标签' : '新建一个主标签') : esc(t.name),
      meta: '<span>' + (isNew
        ? (opts.parentId ? '归属「' + esc((tagById(opts.parentId) || {}).name || '') + '」' : '创建后资料库会自动生成对应文件夹')
        : usage + ' 篇资料 · ' + (t.parentId ? '次标签' : '主标签')) + '</span>',
      body: body,
      footer: (isNew
          ? '<button class="btn btn-sm" data-act="close-sheet">取消</button>'
          : '<button class="btn btn-sm" style="color:#c3271e" data-act="tag-delete" data-id="' + t.id + '">删除标签</button>') +
        '<div class="group"><button class="btn btn-sm btn-primary" data-act="tag-save" data-id="' + (isNew ? '' : t.id) + '">' +
          (isNew ? '创建' : '保存') + '</button></div>'
    }, {
      mount: function (root) {
        const grid = $('#tagColorGrid', root);
        const preview = $('#tagPreview', root);
        const nameInput = $('#tagNameInput', root);
        const custom = $('#tagCustomColor', root);
        const level = $('#tagLevelSelect', root);
        const parentField = $('#tagParentField', root);
        const parentSel = $('#tagParentSelect', root);
        const pathEl = $('#tagPathPreview', root);

        const syncLevel = function () {
          const isSub = level && level.value === 'sub';
          if (parentField) parentField.hidden = !isSub;
          if (pathEl) {
            const pname = isSub && parentSel && tagById(parentSel.value) ? tagById(parentSel.value).name : '';
            const label = (nameInput && nameInput.value.trim()) || '新标签';
            pathEl.innerHTML = '<span>文件夹路径</span><b>资料库' +
              (isSub ? ' / ' + esc(pname || '选择主标签') : '') + ' / ' + esc(label) + '</b>';
          }
        };

        const paint = function (c) {
          if (preview) {
            preview.style.background = hexA(c, 0.11);
            preview.style.color = shade(c, 0.14);
            const dot = preview.querySelector('.tg-dot');
            if (dot) dot.style.background = c;
          }
          if (custom) custom.value = c;
        };

        if (grid) {
          grid.addEventListener('click', function (e) {
            const dot = e.target.closest('[data-color]');
            if (!dot) return;
            const c = dot.getAttribute('data-color');
            grid.setAttribute('data-color', c);
            $$('.color-dot', grid).forEach((x) => x.classList.toggle('active', x === dot));
            paint(c);
          });
        }
        if (custom) {
          custom.addEventListener('input', function () {
            const c = custom.value;
            grid.setAttribute('data-color', c);
            $$('.color-dot', grid).forEach((x) => x.classList.toggle('active', x.classList.contains('custom')));
            paint(c);
          });
        }
        if (level) level.addEventListener('change', syncLevel);
        if (parentSel) parentSel.addEventListener('change', syncLevel);
        if (nameInput) {
          nameInput.addEventListener('input', function () {
            const label = preview && preview.querySelector('span:last-child');
            if (label) label.textContent = nameInput.value.trim() || '标签预览';
            syncLevel();
          });
          nameInput.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const btn = $('[data-act="tag-save"]', root);
            if (btn) btn.click();
          });
          setTimeout(function () { nameInput.focus(); nameInput.select(); }, 140);
        }
        syncLevel();
      }
    });
  }

  /* ---------------- 数据操作 ---------------- */
  function addDoc(data) {
    const doc = {
      id: uid(),
      title: data.title || '未命名资料',
      type: data.type || 'note',
      tags: (function () {
        const out = [];
        (data.tags || []).forEach(function (raw) {
          const n = cleanTagName(raw);
          if (n && out.indexOf(n) < 0) out.push(n);
        });
        return out.slice(0, 8);
      })(),
      content: data.content || '',
      size: data.size || (data.content ? new Blob([data.content]).size : 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReviewed: null,
      backup: { state: 'local', at: null },
      fileRel: data.fileRel || null,
      fileName: data.fileName || null,
      pages: data.pages || 0,
      needsText: !!data.needsText,
      extractedAt: data.extractedAt || null
    };
    doc.tags.forEach(function (name) { ensureTag(name); });
    state.docs.unshift(doc);
    recompute();
    return doc;
  }

  function addTag(id, tag) {
    const d = docById(id);
    if (!d) return false;
    const name = cleanTagName(tag);
    if (!name) return false;
    d.tags = d.tags || [];
    if (d.tags.indexOf(name) >= 0) { toast('这份资料已经有「' + name + '」'); return false; }
    if (d.tags.length >= 8) { toast('单份资料最多 8 个标签'); return false; }
    ensureTag(name);
    d.tags.push(name);
    d.updatedAt = new Date().toISOString();
    recompute();
    render();
    refreshDocTags(id);
    toast('已添加标签「' + name + '」', 'check');
    return true;
  }

  function removeTag(id, tag) {
    const d = docById(id);
    if (!d || !d.tags) return;
    d.tags = d.tags.filter((t) => t !== tag);
    d.updatedAt = new Date().toISOString();
    recompute();
    render();
    refreshDocTags(id);
    toast('已移除标签「' + tag + '」');
  }

  /* 保存标签：新建 / 改名 / 改色 / 调整层级
     改名会同步所有资料与筛选；层级只用 id 引用，改名不影响父子关系 */
  function saveTag(id, rawName, color, parentId) {
    const name = cleanTagName(rawName);
    if (!name) { toast('标签名称不能为空'); return false; }
    const now = new Date().toISOString();
    const safeColor = /^#[0-9a-f]{6}$/i.test(color || '') ? color : pickTagColor();
    const parent = parentId ? tagById(parentId) : null;

    if (parentId && !parent) { toast('归属的主标签不存在'); return false; }
    if (parent && parent.parentId) { toast('次标签下不能再挂次标签（最多两级）'); return false; }

    if (!id) {
      const exist = tagByName(name);
      if (exist) { toast('已有同名标签「' + name + '」，直接使用即可'); return false; }
      tagList().push({
        id: tagId(), name: name, color: safeColor, parentId: parent ? parent.id : null,
        createdAt: now, updatedAt: now
      });
      recompute();
      save();
      render();
      toast(parent ? '已在「' + parent.name + '」下创建次标签「' + name + '」' : '已创建主标签「' + name + '」', 'check');
      return true;
    }

    const t = tagById(id);
    if (!t) return false;
    const oldName = t.name;
    const target = tagByName(name);
    if (target && target.id !== t.id) { toast('已有同名标签「' + name + '」，请换一个名称'); return false; }
    if (parent && parent.id === t.id) { toast('标签不能归属自己'); return false; }
    if (parent && subTagsOf(t.id).length) {
      toast('该主标签下还有 ' + subTagsOf(t.id).length + ' 个次标签，不能改为次标签');
      return false;
    }

    if (name !== oldName) {
      state.docs.forEach(function (d) {
        d.tags = (d.tags || []).map(function (x) { return x === oldName ? name : x; });
      });
      state.activeTags = state.activeTags.map(function (x) { return x === oldName ? name : x; });
    }
    const levelChanged = (t.parentId || null) !== (parent ? parent.id : null);
    t.name = name;
    t.color = safeColor;
    t.parentId = parent ? parent.id : null;
    t.updatedAt = now;

    recompute();
    save();
    render();
    if (name !== oldName) toast('已重命名为「' + name + '」，' + tagUsage(name) + ' 篇资料与文件夹同步更新', 'check');
    else if (levelChanged) toast(parent ? '已移入「' + parent.name + '」的子文件夹' : '已升级为主标签文件夹', 'check');
    else toast('标签「' + name + '」已更新', 'check');
    return true;
  }

  /* 三选一确认：返回所选值，取消返回 false */
  function choiceSheet(parts) {
    return new Promise(function (resolve) {
      let settled = false;
      const done = function (v) {
        if (settled) return;
        settled = true;
        document.removeEventListener('click', handler, true);
        resolve(v);
      };
      const handler = function (e) {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'choice') { done(btn.getAttribute('data-choice')); closeSheet(); }
        else if (act === 'close-sheet' || btn.classList.contains('sheet-backdrop')) done(false);
      };
      openSheet({
        eyebrow: parts.eyebrow || '请确认',
        title: parts.title,
        body: '<p style="margin:0;font-size:13px;color:var(--label-2);line-height:1.7">' + parts.body + '</p>',
        footer: '<button class="btn btn-sm" data-act="close-sheet">取消</button>' +
          '<div class="group">' + parts.actions + '</div>'
      });
      document.addEventListener('click', handler, true);
    });
  }

  async function deleteTag(id) {
    const t = tagById(id);
    if (!t) return false;
    const subs = subTagsOf(t.id);
    const n = tagUsage(t.name);
    const subNames = subs.map(function (s) { return s.name; });

    if (!subs.length) {
      const ok = await confirmSheet('删除标签「' + t.name + '」？',
        n
          ? '该标签会从 ' + n + ' 篇资料上解除，资料库里的对应' + (t.parentId ? '子文件夹' : '文件夹') + '随之消失。资料本身不会被删除。'
          : '这个标签还没有被任何资料使用，删除不会影响资料。', '删除标签');
      if (!ok) return false;
      return finishDeleteTag(t, [], '');
    }

    const choice = await choiceSheet({
      title: '删除主标签「' + t.name + '」？',
      body: '它下面还有 <b>' + subs.length + '</b> 个次标签（' + esc(subNames.slice(0, 4).join('、')) +
        (subs.length > 4 ? ' 等' : '') + '）。删除主标签会同时解除 ' + n + ' 篇资料上的这个标签，资料本身不会被删除。' +
        '<ul class="choice-list">' +
          '<li><b>次标签升为主标签</b><span>保留次标签与它们的资料，变成并列的主文件夹。</span></li>' +
          '<li><b>连同次标签一起删除</b><span>次标签一并移除，相关资料上的这些标签同时解除。</span></li>' +
        '</ul>',
      actions: '<button class="btn btn-sm" data-act="choice" data-choice="promote">次标签升为主标签</button>' +
        '<button class="btn btn-sm" data-act="choice" data-choice="cascade" style="background:#ff3b30;color:#fff">连同次标签删除</button>'
    });
    if (!choice) return false;
    return finishDeleteTag(t, subs, choice);
  }

  /* mode: '' 普通删除；'promote' 次标签升级；'cascade' 级联删除 */
  function finishDeleteTag(t, subs, mode) {
    const now = new Date().toISOString();
    if (mode === 'promote') {
      subs.forEach(function (s) { s.parentId = null; s.updatedAt = now; });
    }
    const kill = [t.name].concat(mode === 'cascade' ? subs.map(function (s) { return s.name; }) : []);
    state.docs.forEach(function (d) {
      d.tags = (d.tags || []).filter(function (x) { return kill.indexOf(x) < 0; });
    });
    state.tags = tagList().filter(function (x) { return kill.indexOf(x.name) < 0; });
    /* 兜底：父标签已不存在的次标签自动升级，避免出现孤儿层级 */
    state.tags.forEach(function (x) {
      if (x.parentId && !tagById(x.parentId)) x.parentId = null;
    });
    state.activeTags = state.activeTags.filter(function (x) { return kill.indexOf(x) < 0; });
    state.closedFolders = state.closedFolders.filter(function (k) { return !!tagById(k); });

    recompute();
    save();
    render();
    if (mode === 'promote') toast('已删除「' + t.name + '」，' + subs.length + ' 个次标签已升为主标签');
    else if (mode === 'cascade') toast('已删除「' + t.name + '」及其 ' + subs.length + ' 个次标签');
    else toast('已删除标签「' + t.name + '」');
    return true;
  }

  async function cleanupTags() {
    /* 有次标签的主标签不算「孤立」，避免清理后子标签失去归属 */
    const unused = tagList().filter(function (t) {
      return tagUsage(t.name) === 0 && (!t.parentId ? subTagsOf(t.id).length === 0 : true);
    });
    if (!unused.length) { toast('没有可清理的标签'); return; }
    const ok = await confirmSheet('清理未使用的标签？',
      '将删除 ' + unused.length + ' 个没有任何资料的标签：' + unused.slice(0, 6).map(function (t) { return t.name; }).join('、') +
      (unused.length > 6 ? ' 等' : '') + '。此操作不影响资料。', '清理');
    if (!ok) return;
    const names = unused.map(function (t) { return t.name; });
    state.tags = tagList().filter(function (t) { return names.indexOf(t.name) < 0; });
    save();
    render();
    toast('已清理 ' + names.length + ' 个未使用标签', 'check');
  }

  function readTextFile(f, ext) {
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () {
        let text = String(reader.result || '');
        if (ext === 'html' || ext === 'htm') {
          text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        } else if (ext === 'md' || ext === 'markdown') {
          text = stripMarkup(text);
        }
        resolve(text);
      };
      reader.onerror = function () { resolve(''); };
      reader.readAsText(f);
    });
  }

  async function importFiles(files) {
    const list = Array.prototype.slice.call(files);
    if (!list.length) return;
    closeSheet();

    const typeMap = { pdf: 'pdf', md: 'md', markdown: 'md', docx: 'docx', doc: 'docx', pptx: 'pptx', ppt: 'pptx', txt: 'note', json: 'note', csv: 'note', html: 'url', htm: 'url' };
    let stored = 0, parsed = 0, pending = 0;

    toast('正在导入 ' + list.length + ' 份资料…');

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const type = typeMap[ext] || 'note';
      const title = f.name.replace(/\.[^.]+$/, '');

      /* 本地模式：先落盘到访达可见的仓库，之后才能「在访达中显示」 */
      let saved = null;
      if (state.localMode) {
        try {
          const res = await apiUpload(f);
          if (res && res.ok && res.file) { saved = res.file; stored += 1; }
        } catch (err) {
          console.warn('原件入库失败，退化为浏览器内保存：', err);
        }
      }

      let content = '';
      let needsText = false;
      let pages = 0;
      let extractedAt = null;

      if (TEXT_EXT.indexOf(ext) >= 0) {
        content = (await readTextFile(f, ext)).slice(0, 20000);
        if (!content.trim()) needsText = true;
      } else if (EXTRACT_TYPES.indexOf(type) >= 0 && saved) {
        /* 上传即解析：摘要、关键词、主题在导入这一步就生成 */
        const ex = await apiExtract(saved.rel);
        if (ex && ex.ok && ex.text) {
          content = ex.text.slice(0, 20000);
          pages = ex.pages || 0;
          extractedAt = new Date().toISOString();
          parsed += 1;
        } else {
          needsText = true;
          pending += 1;
        }
      } else {
        needsText = true;
        pending += 1;
      }

      addDoc({
        title: title,
        type: type,
        content: content,
        size: f.size,
        tags: [],
        fileRel: saved ? saved.rel : null,
        fileName: saved ? saved.name : null,
        pages: pages,
        needsText: needsText,
        extractedAt: extractedAt
      });
    }

    if (state.view !== 'library') {
      state.view = 'library';
      $('#scrollArea').scrollTop = 0;
    }
    save();
    render();

    const bits = ['已导入 ' + list.length + ' 份资料'];
    if (parsed) bits.push(parsed + ' 份已生成摘要');
    if (stored) bits.push(stored + ' 份原件已入库');
    if (pending) bits.push(state.localMode ? pending + ' 份待提取正文' : pending + ' 份需本地运行才能解析');
    toast(bits.join(' · '), 'check');
  }

  /* 重新从原件提取正文：导入时没解析成功、或想更新摘要时手动触发 */
  async function reextractDoc(id, silent) {
    const d = docById(id);
    if (!d) return;
    if (!d.fileRel) { if (!silent) toast('这份资料没有关联的本机文件'); return; }
    if (!state.localMode) { if (!silent) toast('需要在本地运行（npm start）才能解析原件'); return; }
    if (!silent) toast('正在解析「' + shortTitle(d.title) + '」的正文…');

    const r = await apiExtract(d.fileRel);
    if (r && r.ok && r.text) {
      d.content = r.text.slice(0, 20000);
      d.needsText = false;
      d.pages = r.pages || d.pages || 0;
      d.extractedAt = new Date().toISOString();
      d.extractTried = true;
      recompute();
      save();
      render();
      if ($('#sheetRoot').classList.contains('open')) openDoc(id);
      toast('已解析 ' + Number(r.chars || d.content.length).toLocaleString() + ' 字' +
        (r.pages ? ' · ' + r.pages + ' 页' : '') + '，摘要已更新', 'check');
    } else if (!silent) {
      toast('没能提取正文：' + ((r && r.error) || '本地服务未响应'));
    }
  }

  /* 已有资料（此版本之前导入的 PDF/Office）在本地启动时批量补解析一次 */
  async function backfillText() {
    if (!state.localMode || !state.docs.length) return;
    const a = ensureAnalysis();
    const pending = state.docs.filter(function (d) {
      const ins = a.insights[d.id];
      return ins && ins.needsText && d.fileRel && EXTRACT_TYPES.indexOf(d.type) >= 0 && !d.extractTried;
    }).slice(0, 12);
    if (!pending.length) return;

    let done = 0;
    for (let i = 0; i < pending.length; i++) {
      const d = pending[i];
      d.extractTried = true;
      const r = await apiExtract(d.fileRel);
      if (r && r.ok && r.text) {
        d.content = r.text.slice(0, 20000);
        d.needsText = false;
        d.pages = r.pages || d.pages || 0;
        d.extractedAt = new Date().toISOString();
        done += 1;
      }
    }
    recompute();
    save();
    render();
    if (done) toast('已补齐 ' + done + ' 份资料的正文，摘要已生成', 'check');
  }

  async function backupOne(id) {
    const d = docById(id);
    if (!d) return;
    d.backup = { state: 'pending', at: d.backup ? d.backup.at : null };
    render();
    await sleep(520);
    d.backup = { state: 'synced', at: new Date().toISOString() };
    recompute();
    render();
    toast('「' + shortTitle(d.title) + '」已备份', 'check');
  }

  async function backupAll() {
    if (running) return;
    const pending = state.docs.filter((d) => !d.backup || d.backup.state !== 'synced');
    if (!pending.length) { toast('所有资料都已备份'); return; }
    running = true;
    state._backupProgress = 0;
    render();
    for (let i = 0; i < pending.length; i++) {
      pending[i].backup = { state: 'pending', at: pending[i].backup ? pending[i].backup.at : null };
      await sleep(260);
      pending[i].backup = { state: 'synced', at: new Date().toISOString() };
      state._backupProgress = Math.round(((i + 1) / pending.length) * 100);
      const bar = $('#backupProgress i');
      if (bar) bar.style.width = state._backupProgress + '%';
    }
    await sleep(300);
    running = false;
    state._backupProgress = null;
    recompute();
    render();
    toast('备份完成 · ' + pending.length + ' 篇资料已归档', 'check');
  }

  async function runAnalysis() {
    if (running) return;
    running = true;
    progress = 6;
    render();
    const steps = ['正在读取资料与结构…', '提炼关键词与主题…', '计算内容关联…', '识别知识缺口…', '生成结构化总结与建议…'];
    for (let i = 0; i < steps.length; i++) {
      await sleep(380);
      progress = Math.round(((i + 1) / steps.length) * 100);
      const bar = $('#agentProgress i');
      const txt = $('#agentStatus');
      if (bar) bar.style.width = progress + '%';
      if (txt) txt.textContent = steps[i];
    }
    recompute();
    running = false;
    progress = 100;
    render();
    toast('分析完成 · 生成 ' + state.analysis.suggestions.length + ' 条建议', 'check');
  }

  function toggleAdopt(id) {
    const i = state.adopted.indexOf(id);
    if (i >= 0) {
      state.adopted.splice(i, 1);
      toast('已撤销该方案');
    } else {
      state.adopted.push(id);
      toast('已加入学习计划', 'check');
    }
    save();
    render();
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  function exportJSON() {
    download('study-desk-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(state, null, 2), 'application/json');
    toast('已导出 JSON 存档', 'check');
  }

  function exportMarkdown() {
    const a = ensureAnalysis();
    let md = '# 学习资料分析报告\n\n生成时间：' + new Date(a.generatedAt).toLocaleString('zh-CN') + '\n\n';
    md += '资料总数：' + a.docCount + ' 篇 · 主题：' + a.stats.tagCount + ' 个 · 平均覆盖度：' + a.stats.avgCoverage + '%\n\n';
    md += '## 一、资料分布\n\n';
    Object.keys(a.stats.typeDist).forEach((k) => { md += '- ' + k + '：' + a.stats.typeDist[k] + ' 篇\n'; });
    md += '\n## 二、结构化总结\n\n';
    state.docs.forEach((d) => {
      const ins = a.insights[d.id];
      md += '### ' + d.title + '\n\n';
      md += '> ' + ins.tldr + '\n\n';
      md += '关键词：' + ins.keywords.join('、') + '\n\n';
      if (ins.concepts && ins.concepts.length) {
        md += '概念（强度）：' + ins.concepts.map(function (c) { return c.term + '(' + c.score + ')'; }).join('、') + '\n\n';
      }
      ins.points.forEach((p, i) => { md += (i + 1) + '. ' + p + '\n'; });
      md += '\n';
    });
    md += '## 三、知识缺口\n\n';
    a.gaps.forEach((g) => { md += '- **' + g.title + '**：' + g.desc + '（做法：' + g.fix + '）\n'; });
    md += '\n## 四、建议方案\n\n';
    a.suggestions.forEach((s) => {
      md += '### ' + s.kind + ' · ' + s.title + '\n\n';
      md += '- 优先级：' + PRI[s.priority] + '\n- 依据：' + s.basis + '\n- 适用场景：' + s.scenario + '\n';
      s.steps.forEach((st, i) => { md += '- 步骤 ' + (i + 1) + '：' + st + '\n'; });
      md += '\n';
    });
    download('学习资料分析报告.md', md, 'text/markdown;charset=utf-8');
    toast('已导出 Markdown 报告', 'check');
  }

  /* ---------------- 事件 ---------------- */
  function setView(v) {
    if (!VIEWS[v]) return;
    state.view = v;
    save();
    $('#scrollArea').scrollTop = 0;
    render();
  }

  document.addEventListener('click', async function (e) {
    if (pickerApi && !e.target.closest('.tag-add-row')) pickerApi.close();
    const btn = e.target.closest('[data-act]');
    if (!btn) {
      const nav = e.target.closest('[data-view]');
      if (nav) setView(nav.getAttribute('data-view'));
      return;
    }
    const act = btn.getAttribute('data-act');

    switch (act) {
      case 'view': setView(btn.getAttribute('data-v')); break;
      case 'doc': openDoc(btn.getAttribute('data-id'), { original: btn.getAttribute('data-original') === '1' }); break;
      case 'close-sheet': closeSheet(); break;
      case 'topic': openTopic(btn.getAttribute('data-topic')); break;
      case 'adopt': toggleAdopt(btn.getAttribute('data-id')); break;
      case 'backup': backupOne(btn.getAttribute('data-id')); break;
      case 'backup-all': backupAll(); break;
      case 'run-analysis': runAnalysis(); break;
      case 'tab': state.analysisTab = btn.getAttribute('data-tab'); state.graphFocus = null; save(); render(); break;
      case 'topics-tab': state.topicsTab = btn.getAttribute('data-tab') === 'concepts' ? 'concepts' : 'topics'; save(); render(); break;
      case 'concept-filter': state.conceptFilter = btn.getAttribute('data-f') || 'all'; save(); render(); break;
      case 'concept': openConcept(btn.getAttribute('data-term')); break;
      case 'concept-jump': {
        const cdoc = btn.getAttribute('data-doc');
        const cterm = btn.getAttribute('data-term');
        if (cdoc && sheetDocId === cdoc && $('#originalText')) jumpToTerm(cterm);
        else if (cdoc) openDoc(cdoc, { focusTerm: cterm, original: true });
        break;
      }
      case 'concept-rules': openConceptRules(); break;
      case 'graph-mode': state.graphMode = btn.getAttribute('data-mode') === 'doc' ? 'doc' : 'concept';
        state.graphFocus = null; save(); render(); break;
      case 'graph-core': state.graphCoreOnly = !state.graphCoreOnly; save(); render(); break;
      case 'graph-relayout': state.graphSeed = (state.graphSeed || 0) + 1; save(); render(); break;
      case 'goto-graph': {
        state.view = 'analysis';
        state.analysisTab = 'graph';
        state.graphMode = btn.getAttribute('data-mode') === 'doc' ? 'doc' : 'concept';
        state.graphFocus = btn.getAttribute('data-term') || null;
        closeSheet();
        $('#scrollArea').scrollTop = 0;
        save(); render();
        setTimeout(function () {
          const g = $('#graphSvg');
          if (g) g.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 300);
        break;
      }
      case 'sort': state.sort = btn.getAttribute('data-sort'); save(); render(); break;
      case 'library-mode': state.libraryMode = btn.getAttribute('data-mode') === 'list' ? 'list' : 'folder'; save(); render(); break;
      case 'folder-rule': state.folderRule = btn.getAttribute('data-rule') === 'primary' ? 'primary' : 'all'; save(); render(); break;
      case 'toggle-folder': {
        const key = btn.getAttribute('data-id');
        if (!key) break;
        const i = state.closedFolders.indexOf(key);
        if (i >= 0) state.closedFolders.splice(i, 1); else state.closedFolders.push(key);
        save(); render(); break;
      }
      case 'open-tag-library': {
        const name = btn.getAttribute('data-tag');
        state.activeTags = name ? [name] : [];
        state.libraryMode = 'folder';
        state.view = 'library';
        $('#scrollArea').scrollTop = 0;
        save(); render(); break;
      }
      case 'tag-manager':
        closeSheet();
        state.view = 'tags';
        $('#scrollArea').scrollTop = 0;
        save(); render(); break;
      case 'tag-new': openTagSheet(); break;
      case 'tag-new-sub': openTagSheet('', { parentId: btn.getAttribute('data-parent') }); break;
      case 'tag-toggle': if (pickerApi) pickerApi.toggle(); break;
      case 'tag-pick': {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-tag');
        const input = $('#tagAddInput');
        if (addTag(id, name)) {
          if (input) { input.value = ''; input.focus(); }
          if (pickerApi) pickerApi.open();
        }
        break;
      }
      case 'tag-pick-sub': {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-tag');
        const parent = tagById(btn.getAttribute('data-parent'));
        if (!parent) break;
        if (!tagByName(name)) ensureTag(name, parent.color, parent.id);
        const input = $('#tagAddInput');
        if (addTag(id, name)) {
          if (input) { input.value = ''; input.focus(); }
          if (pickerApi) pickerApi.open();
        }
        break;
      }
      case 'reextract': reextractDoc(btn.getAttribute('data-id')); break;
      case 'tag-edit': openTagSheet(btn.getAttribute('data-id')); break;
      case 'tag-save': {
        const nameEl = $('#tagNameInput');
        const grid = $('#tagColorGrid');
        if (!nameEl || !grid) break;
        const levelEl = $('#tagLevelSelect');
        const parentEl = $('#tagParentSelect');
        const parentId = levelEl && levelEl.value === 'sub' && parentEl ? parentEl.value : '';
        const done = saveTag(btn.getAttribute('data-id') || '', nameEl.value, grid.getAttribute('data-color'), parentId);
        if (done) closeSheet();
        break;
      }
      case 'tag-delete': {
        const id = btn.getAttribute('data-id');
        const removed = await deleteTag(id);
        if (removed) closeSheet();
        break;
      }
      case 'cleanup-tags': cleanupTags(); break;
      case 'filter-tag': {
        const t = btn.getAttribute('data-tag');
        if (!t) state.activeTags = [];
        else if (t === UNTAGGED) {
          const i = state.activeTags.indexOf(UNTAGGED);
          if (i >= 0) state.activeTags.splice(i, 1); else state.activeTags = [UNTAGGED];
        }
        else {
          const i = state.activeTags.indexOf(t);
          if (i >= 0) state.activeTags.splice(i, 1); else state.activeTags.push(t);
        }
        save(); render(); break;
      }
      case 'filter-untagged': {
        state.activeTags = [UNTAGGED];
        state.view = 'library';
        save(); render(); break;
      }
      case 'import-open': openImport(); break;
      case 'save-import': {
        const title = ($('#impTitle') || {}).value || '';
        const tagsRaw = ($('#impTags') || {}).value || '';
        const content = ($('#impContent') || {}).value || '';
        if (!title.trim() && !content.trim()) { toast('请填写标题或正文'); break; }
        const tags = tagsRaw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
        addDoc({ title: title.trim() || content.slice(0, 16), tags: tags, content: content.trim(), type: 'note' });
        closeSheet();
        setView('library');
        toast('已保存到资料库', 'check');
        break;
      }
      case 'reveal':
      case 'open-file': {
        const d2 = docById(btn.getAttribute('data-id'));
        if (!d2 || !d2.fileRel) { toast('这份资料没有关联的本机文件'); break; }
        if (!state.localMode) { toast('线上模式无法访问本机文件，请用 npm start 本地打开'); break; }
        const r2 = await apiPost('/api/reveal', { rel: d2.fileRel, mode: act === 'open-file' ? 'open' : 'reveal' });
        if (r2 && r2.ok) toast(act === 'open-file' ? '已用默认应用打开' : '已在访达中定位该文件', 'check');
        else toast('打开失败：' + ((r2 && r2.error) || '本地服务未响应'));
        break;
      }
      case 'open-folder': {
        if (!state.localMode) { toast('该功能需要本地运行（npm start）'); break; }
        const r3 = await apiPost('/api/open-folder', {});
        if (r3 && r3.ok) toast('已打开资料文件夹', 'check');
        else toast('无法打开：' + ((r3 && r3.error) || '未知错误'));
        break;
      }
      case 'goto-original': {
        const el = $('#originalText');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        break;
      }
      case 'tag-remove': removeTag(btn.getAttribute('data-id'), btn.getAttribute('data-tag')); break;
      case 'delete-doc': {
        const id = btn.getAttribute('data-id');
        const d = docById(id);
        const ok = await confirmSheet('删除这份资料？',
          '「' + esc(d ? d.title : '') + '」及其标签会从资料库移除，此操作无法撤销。' +
          (d && d.fileRel ? '原始文件仍保留在资料文件夹中，不会一并删除。' : '建议先导出 JSON 存档。'), '删除');
        if (ok) {
          state.docs = state.docs.filter((x) => x.id !== id);
          recompute();
          render();
          toast('已删除资料');
        }
        break;
      }
      case 'toggle-auto': state.autoBackup = !state.autoBackup; save(); render(); break;
      case 'export-json': exportJSON(); break;
      case 'export-md': exportMarkdown(); break;
      case 'clear-data': {
        const ok = await confirmSheet('清空本机全部数据？', '所有资料、标签与总结都会从当前浏览器移除。请确认已经导出过 JSON 存档。', '清空数据');
        if (ok) {
          localStorage.removeItem(LS_KEY);
          state = defaultState();
          state.docs = [];
          state.adopted = [];
          state.activeTags = [];
          state.query = '';
          $('#searchInput').value = '';
          recompute();
          save();
          render();
          toast('已清空本机数据');
        }
        break;
      }
      default: break;
    }
  });

  /* 顶部操作 */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    /* 旧版本（含示例资料）的存储直接作废，避免示例数据残留在资料库里 */
    LEGACY_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });

    state = load();
    render();
    probeLocal().then(function () {
      if (state.view === 'overview' && !state.docs.length) render();
      backfillText();
    });

    $('#importBtn').addEventListener('click', openImport);
    $('#privacySwitch').addEventListener('click', () => {
      state.privacy = !state.privacy;
      save();
      updateChrome();
      toast(state.privacy ? '隐私遮罩已开启' : '隐私遮罩已关闭');
    });
    $('#exportDataBtn').addEventListener('click', exportJSON);

    const input = $('#searchInput');
    if (state.query) input.value = state.query;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = input.value;
        if (state.query.trim() && state.view !== 'library') {
          state.view = 'library';
          $('#scrollArea').scrollTop = 0;
        }
        save();
        render();
      }, 110);
    });

    $('#fileInput').addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) importFiles(e.target.files);
      e.target.value = '';
    });

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
      }
      if ((e.key === 'Enter' || e.key === ' ') && document.activeElement &&
          document.activeElement.classList && document.activeElement.classList.contains('sum-card')) {
        e.preventDefault();
        document.activeElement.click();
      }
      if (e.key === 'Escape') {
        if ($('#sheetRoot').classList.contains('open')) closeSheet();
        else if (document.activeElement === input) input.blur();
      }
      if (e.key === '/' && document.activeElement !== input && !/input|textarea/i.test((document.activeElement || {}).tagName || '')) {
        e.preventDefault();
        input.focus();
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.view === 'analysis' && state.analysisTab === 'graph') render();
      }, 260);
      $$('.segmented').forEach((seg) => {
        const active = seg.querySelector('button.active');
        const ind = seg.querySelector('.seg-ind');
        if (!active || !ind) return;
        ind.style.width = active.offsetWidth + 'px';
        ind.style.transform = 'translateX(' + (active.offsetLeft - 3) + 'px)';
      });
    });
  }
})();
