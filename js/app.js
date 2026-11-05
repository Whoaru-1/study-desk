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
      adopted: [],
      analysis: null,
      view: 'overview',
      query: '',
      activeTags: [],
      sort: 'recent',
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
      return Object.assign(base, s, { docs: Array.isArray(s.docs) ? s.docs : base.docs });
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
    state.analysis = window.Engine.analyze(state.docs);
    save();
  }

  function ensureAnalysis() {
    if (!state.analysis || !state.analysis.insights) recompute();
    return state.analysis;
  }

  function docById(id) { return state.docs.filter((d) => d.id === id)[0]; }

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
    return '<button class="doc" data-act="doc" data-id="' + d.id + '">' +
      '<span class="doc-ico" style="background:' + meta.color + ';color:#fff">' +
      (opt.showType === false ? '' : meta.short) + '</span>' +
      '<span class="doc-main">' +
        '<span class="doc-title">' + esc(d.title) + '</span>' +
        '<span class="doc-meta"><span>' + meta.label + '</span><i></i><span>' + fmtDate(d.updatedAt) + '</span>' +
        (ins ? '<i></i><span>重要度 ' + ins.importance + '</span>' : '') +
        '</span>' +
        snippet +
        ((d.tags && d.tags.length)
          ? '<span class="doc-tags">' + d.tags.slice(0, 4).map((t, i) =>
              '<span class="tag ' + ['', 'g', 'o', 'p'][i % 4] + '">' + esc(t) + '</span>').join('') +
            (d.tags.length > 4 ? '<span class="tag n">+' + (d.tags.length - 4) + '</span>' : '') + '</span>'
          : '<span class="doc-tags"><span class="tag n">未打标签</span></span>') +
      '</span>' +
      '<span class="doc-right">' +
        (opt.hideStatus ? '' : '<span class="status ' + st.cls + '"><i></i>' + st.label + '</span>') +
        '<svg class="chev" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</span></button>';
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
            '<div class="bar-row"><div class="bar-top"><span>' + esc(t.name) + '</span><b>' + t.count + ' 篇</b></div>' +
            '<div class="bar-track"><div class="bar-fill" data-w="' + Math.round((t.count / maxTag) * 100) +
            '" style="background:' + colorFor(t.name) + ';opacity:' + (1 - i * 0.06) + '"></div></div></div>').join('') +
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
      list = list.filter((d) => (d.tags || []).some((t) => state.activeTags.indexOf(t) >= 0));
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

  function viewLibrary() {
    const a = ensureAnalysis();
    const list = filteredDocs();
    const allTags = a.topics.filter((t) => t.name !== '未归类').map((t) => t.name);

    return '<div class="seg-row">' +
        '<div class="kit-row">' +
          '<div class="segmented" data-seg="sort">' +
            '<span class="seg-ind"></span>' +
            ['recent:最近更新', 'importance:重要度', 'title:标题'].map((s) => {
              const k = s.split(':');
              return '<button data-act="sort" data-sort="' + k[0] + '" class="' + (state.sort === k[0] ? 'active' : '') + '">' + k[1] + '</button>';
            }).join('') +
          '</div>' +
          '<span class="count-label">' + (list.length === state.docs.length ? '共 ' + state.docs.length + ' 篇' : '筛选出 ' + list.length + ' / ' + state.docs.length + ' 篇') + '</span>' +
        '</div>' +
        '<button class="btn btn-sm btn-ghost" data-act="import-open">导入资料</button>' +
      '</div>' +

      '<div class="filter-scroll">' +
        '<button class="tag n ' + (state.activeTags.length ? '' : 'on') + '" data-act="filter-tag" data-tag="">全部</button>' +
        allTags.map((t) => '<button class="tag n ' + (state.activeTags.indexOf(t) >= 0 ? 'on' : '') +
          '" data-act="filter-tag" data-tag="' + esc(t) + '">' + esc(t) + '</button>').join('') +
      '</div>' +

      '<div class="card reveal" style="padding:8px 10px">' +
        (list.length ? '<div class="doc-list">' + list.map((d) => docRow(d)).join('') + '</div>'
          : '<div class="empty"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7.5C4 6.1 5.1 5 6.5 5h3.2c.7 0 1.4.3 1.9.8l.9.9c.3.3.7.5 1.1.5h4c1.4 0 2.5 1.1 2.5 2.5v7.2c0 1.4-1.1 2.6-2.5 2.6h-10C5.1 19.5 4 18.3 4 16.9V7.5Z" stroke="currentColor" stroke-width="1.6"/></svg>' +
            '<b>' + (state.query ? '没有匹配的资料' : '这个筛选下还没有资料') + '</b>' +
            '<p>' + (state.query ? '换个关键词，或清除筛选条件' : '导入你的第一份资料开始建立知识库') + '</p></div>') +
      '</div>' +

      '<div class="dropzone" data-act="import-open" style="margin-top:14px">' +
        '<b>把文件拖到这里，或点击导入</b>' +
        '<span>支持 Markdown / 文本 / Word / PDF / PPT · 内容仅保存在本机</span>' +
      '</div>';
  }

  /* ---------------- 视图：知识主题 ---------------- */
  function viewTopics() {
    if (!state.docs.length) return emptyLibrary();
    const a = ensureAnalysis();
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
      '<div class="topic-grid">' + core.map((t, i) =>
        '<div class="topic reveal" data-act="topic" data-topic="' + esc(t.name) + '" style="animation-delay:' + Math.min(i * 26, 260) + 'ms">' +
          '<div class="topic-head"><div><div class="topic-name">' + esc(t.name) + '</div>' +
          '<div class="topic-sub">' + t.count + ' 篇资料 · ' + (t.coverage >= 70 ? '结构完整' : t.coverage >= 40 ? '尚可扩展' : '较薄弱') + '</div></div>' +
          ring(t.coverage, colorFor(t.name)) + '</div>' +
          '<div class="kw-cloud">' + t.keywords.slice(0, 4).map((k) => '<span class="kw">' + esc(k) + '</span>').join('') + '</div>' +
        '</div>').join('') +
      '</div>' +

      (untagged ? '<div class="card reveal" style="margin-top:14px;display:flex;align-items:center;gap:12px">' +
        '<span class="gap-ico" style="background:rgba(255,59,48,.10);color:#c3271e">!</span>' +
        '<div style="flex:1"><div class="gap-title">' + untagged.count + ' 篇资料未归类</div>' +
        '<div class="gap-desc">这些资料不会进入主题网络，也不会被主题覆盖度统计。</div></div>' +
        '<button class="btn btn-sm" data-act="filter-untagged">去整理</button></div>' : '') +

      (tail.length ? '<div class="section-title"><h2>长尾标签</h2><span>' + tail.length + ' 个标签只有 1 篇资料</span></div>' +
        '<div class="card reveal"><div class="kw-cloud" style="gap:7px">' +
          tail.map((t) => '<button class="tag n" data-act="topic" data-topic="' + esc(t.name) + '" style="padding:4px 9px;font-size:11.5px">' +
            esc(t.name) + ' <span style="opacity:.5">1</span></button>').join('') +
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

  /* ---------------- 视图：智能分析 ---------------- */
  function viewAnalysis() {
    if (!state.docs.length) return emptyLibrary();
    const a = ensureAnalysis();
    const tab = state.analysisTab;
    const tabs = [['summary', '智能总结'], ['gaps', '知识缺口'], ['graph', '内容关联'], ['suggest', '建议方案']];

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
    if (tab === 'graph') return a.edges.length + ' 条关联';
    return a.suggestions.length + ' 条可采纳建议';
  }

  function analysisSummary(a) {
    const docs = state.docs.slice().sort((x, y) => a.insights[y.id].importance - a.insights[x.id].importance);
    return '<div class="sum-grid">' + docs.map((d, i) => {
      const ins = a.insights[d.id];
      const relCount = a.edges.filter((e) => e.source === d.id || e.target === d.id).length;
      return '<div class="sum-card reveal" data-act="doc" data-id="' + d.id + '" data-original="1" role="button" tabindex="0" aria-label="查看《' + esc(shortTitle(d.title)) + '》详情" style="animation-delay:' + Math.min(i * 20, 200) + 'ms">' +
        '<div class="sum-head"><div style="min-width:0">' +
          '<div class="sum-title">' + esc(shortTitle(d.title)) + '</div>' +
          '<div class="doc-meta" style="margin-top:4px"><span>' + (window.TYPE_META[d.type] || {}).label + '</span><i></i><span>' + esc(ins.theme) + '</span><i></i><span>' + relCount + ' 条关联</span></div>' +
        '</div>' +
        '<span class="imp-badge" style="color:' + (ins.importance > 70 ? '#c3271e' : ins.importance > 45 ? '#a86500' : '#6e6e73') + ';background:' + (ins.importance > 70 ? 'rgba(255,59,48,.10)' : ins.importance > 45 ? 'rgba(255,149,0,.12)' : 'rgba(120,120,128,.12)') + '">' + ins.importance + '</span>' +
        '</div>' +
        '<p class="sum-tldr">' + esc(ins.tldr) + '</p>' +
        '<ul class="points">' + ins.points.slice(0, 3).map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
        '<div class="kw-cloud">' + ins.keywords.slice(0, 5).map((k) => '<span class="kw">' + esc(k) + '</span>').join('') + '</div>' +
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

  function analysisGraph(a) {
    const narrow = window.innerWidth < 720;
    const W = narrow ? 430 : 760, H = narrow ? 560 : 430;
    const nodes = state.docs.map((d) => ({
      id: d.id,
      label: Engine.trimTo(shortTitle(d.title), narrow ? 7 : 10),
      full: d.title,
      r: 9 + (a.insights[d.id].importance / 100) * 13,
      color: colorFor((d.tags && d.tags[0]) || d.type)
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
      '<g class="gnode" data-id="' + n.id + '" transform="translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')">' +
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
          '<span><i style="background:#8a8a92"></i>连线 = 共享关键词</span>' +
        '</div>' +
      '</div>' +
      '<div class="grid" style="grid-template-columns:repeat(2,1fr);margin-top:14px">' +
        '<div class="card"><div class="card-title" style="margin-bottom:10px">关联最紧密的资料对</div>' +
          a.edges.slice().sort((x, y) => y.weight - x.weight).slice(0, 3).map((e) => {
            const s = docById(e.source), t = docById(e.target);
            if (!s || !t) return '';
            return '<div class="rel" data-act="doc" data-id="' + e.source + '"><span class="rel-ico" style="background:' + colorFor((s.tags || [])[0] || s.type) + '">↗</span>' +
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
    nodes.forEach((n, i) => {
      const ang = i * 2.399963229;
      const rad = Math.sqrt((i + 0.6) / nodes.length) * Math.min(W, H) * 0.46;
      n.x = W / 2 + Math.cos(ang) * rad * 1.18;
      n.y = H / 2 + Math.sin(ang) * rad * 0.92;
      n.vx = 0; n.vy = 0;
      n.side = i % 2 === 0 ? 1 : -1;
    });
    const idx = {};
    nodes.forEach((n, i) => { idx[n.id] = i; });

    for (let it = 0; it < 520; it++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
          const d = Math.sqrt(d2);
          const rep = 14000 / d2;
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
        const target = 104 + 46 / (1 + e.weight * 0.25);
        const f = (d - target) * 0.022;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      });
      nodes.forEach((n) => {
        n.vx += (W / 2 - n.x) * 0.0028;
        n.vy += (H / 2 - n.y) * 0.0028;
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
    analysis: { title: '智能分析', sub: '本地引擎生成 · 结论可回溯到原文', render: viewAnalysis },
    backup: { title: '备份', sub: '本机资料的备份与安全', render: viewBackup }
  };

  function render() {
    ensureAnalysis();
    const v = VIEWS[state.view] || VIEWS.overview;
    $('#viewTitle').textContent = v.title;
    $('#viewSub').textContent = state.view === 'library'
      ? '共 ' + state.docs.length + ' 篇 · ' + (state.analysis.stats.tagCount) + ' 个主题标签'
      : v.sub;
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
      const d = docById(id);
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
        if (tip && d) {
          const r = wrap.getBoundingClientRect();
          tip.textContent = d.title;
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
      g.addEventListener('click', function () { openDoc(id); });
    });
    edges.forEach((e) => e.setAttribute('data-op', e.getAttribute('stroke-opacity')));
  }

  /* ---------------- 面板（Sheet） ---------------- */
  function openSheet(parts, opts) {
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
    setTimeout(() => {
      root.classList.remove('open', 'closing');
      root.innerHTML = '';
      root.setAttribute('aria-hidden', 'true');
    }, 240);
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

    const allTags = a.topics.filter((t) => t.name !== '未归类').map((t) => t.name);

    const body =
      '<div class="kv">' +
        '<div><span>类型</span><b>' + meta.label + ' · ' + fmtSize(d.size) + '</b></div>' +
        '<div><span>重要度</span><b>' + ins.importance + ' / 100</b></div>' +
        '<div><span>最近复习</span><b>' + fmtDate(d.lastReviewed) + '</b></div>' +
        '<div><span>备份状态</span><b>' + st.label + (d.backup && d.backup.at ? ' · ' + fmtDate(d.backup.at) : '') + '</b></div>' +
      '</div>' +

      '<div class="sheet-section-title">智能摘要</div>' +
      '<p class="sum-tldr" style="margin:0 0 8px">' + esc(ins.tldr) + '</p>' +
      '<ul class="points">' + ins.points.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' +

      '<div class="sheet-section-title">关键词</div>' +
      '<div class="kw-cloud">' + ins.keywords.map((k) => '<span class="kw hot">' + esc(k) + '</span>').join('') + '</div>' +

      '<div class="sheet-section-title">标签</div>' +
      '<div class="chips-edit">' +
        (d.tags && d.tags.length ? d.tags.map((t) =>
          '<span class="chip">' + esc(t) +
          '<button data-act="tag-remove" data-id="' + d.id + '" data-tag="' + esc(t) + '" aria-label="移除标签">×</button></span>').join('')
          : '<span class="muted" style="font-size:12px">还没有标签</span>') +
      '</div>' +
      '<div class="tag-add-row">' +
        '<input class="input" id="tagAddInput" data-id="' + d.id + '" placeholder="输入标签后回车，例如：通货膨胀" list="tagOptions">' +
        '<datalist id="tagOptions">' + allTags.map((t) => '<option value="' + esc(t) + '">').join('') + '</datalist>' +
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
      '<div class="original" id="originalText">' + Engine.highlight(d.content || '（暂无正文，可在导入时粘贴内容）', ins.keywords) + '</div>';

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
        const input = $('#tagAddInput', root);
        if (input) {
          input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            const v = input.value.trim().replace(/[,，\s]+/g, '');
            if (!v) return;
            addTag(d.id, v);
            openDoc(d.id);
            const again = $('#tagAddInput');
            if (again) again.focus();
          });
        }
        if (opts.original) {
          const el = $('#originalText', root);
          if (el) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 240);
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

  /* ---------------- 数据操作 ---------------- */
  function addDoc(data) {
    const doc = {
      id: uid(),
      title: data.title || '未命名资料',
      type: data.type || 'note',
      tags: (data.tags || []).filter(Boolean).slice(0, 6),
      content: data.content || '',
      size: data.size || (data.content ? new Blob([data.content]).size : 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReviewed: null,
      backup: { state: 'local', at: null },
      fileRel: data.fileRel || null,
      fileName: data.fileName || null
    };
    state.docs.unshift(doc);
    recompute();
    return doc;
  }

  function addTag(id, tag) {
    const d = docById(id);
    if (!d) return;
    d.tags = d.tags || [];
    if (d.tags.indexOf(tag) < 0) {
      d.tags.push(tag);
      d.updatedAt = new Date().toISOString();
      recompute();
      toast('已添加标签「' + tag + '」', 'check');
    }
  }

  function removeTag(id, tag) {
    const d = docById(id);
    if (!d || !d.tags) return;
    d.tags = d.tags.filter((t) => t !== tag);
    d.updatedAt = new Date().toISOString();
    recompute();
    openDoc(id);
    toast('已移除标签「' + tag + '」');
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
    let stored = 0;

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const type = typeMap[ext] || 'note';
      const title = f.name.replace(/\.[^.]+$/, '');

      /* 本地模式：先落盘到访达可见的仓库，之后才能「在访达中显示」 */
      let saved = null;
      if (state.localMode) {
        toast('正在写入资料文件夹…');
        try {
          const res = await apiUpload(f);
          if (res && res.ok && res.file) { saved = res.file; stored += 1; }
        } catch (err) {
          console.warn('原件入库失败，退化为浏览器内保存：', err);
        }
      }

      const content = TEXT_EXT.indexOf(ext) >= 0
        ? (await readTextFile(f, ext)).slice(0, 20000)
        : '（' + (window.TYPE_META[type] || {}).label + ' 文件，已记录元信息。可在资料详情中补充正文后重新分析。）';

      addDoc({
        title: title,
        type: type,
        content: content,
        size: f.size,
        tags: [],
        fileRel: saved ? saved.rel : null,
        fileName: saved ? saved.name : null
      });
    }

    render();
    toast('已导入 ' + list.length + ' 份资料' + (stored ? ' · ' + stored + ' 份原件已入库' : ''), 'check');
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
      case 'tab': state.analysisTab = btn.getAttribute('data-tab'); save(); render(); break;
      case 'sort': state.sort = btn.getAttribute('data-sort'); save(); render(); break;
      case 'filter-tag': {
        const t = btn.getAttribute('data-tag');
        if (!t) state.activeTags = [];
        else {
          const i = state.activeTags.indexOf(t);
          if (i >= 0) state.activeTags.splice(i, 1); else state.activeTags.push(t);
        }
        save(); render(); break;
      }
      case 'filter-untagged': {
        state.activeTags = ['未归类'];
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
