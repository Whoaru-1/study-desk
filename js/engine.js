/* 本地分析引擎：纯前端运行，不发起任何网络请求 */
window.Engine = (function () {
  'use strict';

  const STOP_CHARS = new Set(
    ('的了和是在对与及这那有为以于也就都而把被从到我你他她它们可很更最不没如果因为所以但是而且还才只让使给按照据通过关于一如何在所等之其此该些即则若并同由上述其中两者之间从而因此进而就其每各该当以及或与' +
    '虽然然而不过只是主要可以能够需要应该可能已经进行具有我们他们于是不仅而且或者一个一种一些这个那个不是没有应该必须提供得到发生出现成为作为对于由于同样此外例如比如根据表明认为指出').split('')
  );
  const EN_STOP = new Set(['the','and','for','with','that','this','from','are','was','were','has','have','not','you','can','its','our','their','but','will','which','what','when','how','all','any','may','one','two','also','more','than','then','into','such','some','only','been','they','there','these','those','would','could','should','his','her','had','who','them']);

  /* 学科词表：命中后优先作为术语，且会从文本中「挖掉」以避免切出碎片 */
  const LEXICON = new Set([
    '失业率','自然失业率','劳动力','劳动力市场','摩擦性失业','结构性失业','周期性失业','奥肯定律','参与率','工资刚性','效率工资','失业缺口','就业',
    '通货膨胀','通货膨胀率','通胀','通胀预期','预期通胀','通货紧缩','消费者价格指数','GDP平减指数','费雪方程','费雪效应','菜单成本','鞋底成本','货币','货币政策','财政政策','利率','名义利率','实际利率','货币供给','货币需求',
    '菲利普斯曲线','附加预期的菲利普斯曲线','牺牲率','自然率假说','理性预期','适应性预期','预期','短期','长期','均衡','模型','假设','推导','公式','计算','习题','复习','考点',
    '经济周期','总需求','总供给','总需求曲线','总供给曲线','产出缺口','乘数','加速数','边际消费倾向','消费函数','投资','库存周期','信贷周期','衰退','滞胀','扩张','复苏',
    '经济增长','索洛模型','稳态','资本积累','资本深化','折旧','折旧率','人口增长率','储蓄率','全要素生产率','增长核算','条件收敛','内生增长','AK模型','生产函数','规模报酬','边际报酬递减',
    '人力资本','技术进步','研发','研发投入','知识溢出','制度','教育投入','知识产权',
    '开放经济','汇率','名义汇率','实际汇率','购买力平价','利率平价','国际收支','经常账户','资本账户','三元悖论','蒙代尔','弗莱明','资本流动','外汇储备','固定汇率','浮动汇率',
    'IS-LM','AD-AS','挤出效应','流动性陷阱','财政乘数','自动稳定器','相机抉择','传导渠道','央行独立性','政策协调','公开市场操作','财政扩张','货币扩张',
    '供给冲击','需求冲击','价格粘性','工资粘性','潜在产出','自然产出','需求管理','财政赤字','债务','政策可信度','通胀目标','前瞻性指引'
  ]);

  const GENERIC_TERMS = new Set(['讨论','分析','影响','包括','取决','说明','指出','认为','研究','发现','利用','检验','支持','结论','结果','数据','方法','提出','表明','显示','产生','出现','具有','形成','构成','本文','可以','需要','进行','通过','以及','同时','因此','但是','如果','因为','所以','其中','方面','问题','内容','主要','重要','不同','相同','增加','提高','降低']);
  const FORMAT_TAGS = new Set(['习题','练习','复习','课程讲义','讲义','笔记','论文精读','考试','作业','课程','资料']);
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const LEX_SORTED = Array.from(LEXICON).sort((a, b) => b.length - a.length);

  function isCJK(ch) { return /[\u4e00-\u9fa5]/.test(ch); }

  /* 从文本中抽取候选术语：词表最长匹配 + 剩余文本 n-gram */
  function extractTerms(text) {
    const raw = String(text || '');
    const tf = Object.create(null);
    const hits = [];

    // 1) 词表最长匹配（不区分大小写），命中后以空白掩码
    let masked = raw;
    for (const term of LEX_SORTED) {
      const re = new RegExp(escRe(term), 'gi');
      const found = masked.match(re);
      if (!found) continue;
      tf[term] = (tf[term] || 0) + found.length;
      hits.push(term);
      masked = masked.replace(re, '　');
    }

    // 2) 英文/缩写
    const acronyms = masked.match(/[A-Za-z]{2,}(?:-[A-Za-z]{2,}){0,2}/g) || [];
    acronyms.forEach(function (w) {
      const lw = w.toLowerCase();
      if (EN_STOP.has(lw)) return;
      const key = /^[A-Z]/.test(w) ? w.toUpperCase() : lw;
      tf[key] = (tf[key] || 0) + 1;
    });

    // 3) 中文 n-gram（2—6 字），跳过含停用字的组合
    const segs = masked.toLowerCase().match(/[\u4e00-\u9fa5]+/g) || [];
    segs.forEach(function (seg) {
      const chars = Array.from(seg);
      for (let n = 2; n <= 6; n++) {
        for (let i = 0; i + n <= chars.length; i++) {
          const gram = chars.slice(i, i + n).join('');
          let bad = false;
          for (const c of gram) { if (STOP_CHARS.has(c)) { bad = true; break; } }
          if (bad) continue;
          tf[gram] = (tf[gram] || 0) + 1;
        }
      }
    });

    return { tf: tf, hits: hits, charLen: raw.length };
  }

  function splitSentences(text) {
    if (!text) return [];
    return String(text)
      .replace(/\s+/g, ' ')
      .split(/(?<=[。！？!?；;])|\n+/)
      .map((s) => s.trim().replace(/^[。；，、]+/, ''))
      .filter((s) => s.length >= 12);
  }

  function trimTo(s, n) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* 关键词选择：idf × 长度权重，并剔除「被更长词组覆盖的碎片」 */
  function pickKeywords(tf, df, N, charLen, limit) {
    const terms = Object.keys(tf);
    const minFreq = charLen < 90 ? 1 : 2;

    const cands = [];
    terms.forEach(function (term) {
      const freq = tf[term];
      if (FORMAT_TAGS.has(term) || GENERIC_TERMS.has(term)) return;
      const isLex = LEXICON.has(term);
      if (!isLex && freq < minFreq) return;
      if (term.length >= 7) return;

      // 碎片检测：所有更长的候选词组频次之和已覆盖该词出现次数
      if (!isLex) {
        let covered = 0;
        for (const t of terms) {
          if (t.length > term.length && t.length <= term.length + 3 && t.indexOf(term) >= 0) covered += tf[t];
        }
        if (covered >= freq * 0.85) return;
      }

      const idf = Math.log(1 + N / (df[term] || 1));
      const lenW = [0, 1, 1, 1.14, 1.26, 1.32, 1.36][term.length] || 1.4;
      const score = (1 + Math.log(freq)) * idf * lenW * (isLex ? 1.9 : 1);
      cands.push({ term: term, score: score, freq: freq, lex: isLex });
    });

    cands.sort((a, b) => b.score - a.score || b.term.length - a.term.length);

    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= limit) break;
      const conflict = chosen.some((k) => k.term.indexOf(c.term) >= 0 || c.term.indexOf(k.term) >= 0);
      if (conflict) continue;
      chosen.push(c);
    }
    return chosen;
  }

  function summarizeContent(text, keywords) {
    const sents = splitSentences(text);
    if (!sents.length) return { tldr: trimTo(text || '', 80), points: [] };
    const weights = {};
    keywords.forEach((k, i) => { weights[k.term] = k.score * (1 - i * 0.055); });

    const scored = sents.map((s, idx) => {
      let sc = 0;
      Object.keys(weights).forEach((term) => { if (s.indexOf(term) >= 0) sc += weights[term]; });
      sc = sc / Math.sqrt(Math.max(14, s.length) / 10);
      if (idx === 0) sc *= 1.12;
      if (s.length > 130) sc *= 0.8;
      return { s: s, sc: sc, idx: idx };
    });

    const ranked = scored.slice().sort((a, b) => b.sc - a.sc);
    const head = scored.slice(0, 2).sort((a, b) => b.sc - a.sc)[0] || scored[0];
    const lead = head;
    const rest = ranked.filter((x) => x.idx !== lead.idx).slice(0, 3)
      .sort((a, b) => a.idx - b.idx);
    return {
      tldr: trimTo(lead.s, 90),
      points: rest.map((t) => trimTo(t.s, 96))
    };
  }

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 999);
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  /* ---------------- 主分析 ---------------- */
  function analyze(docs) {
    const N = Math.max(1, docs.length);
    const extracted = {};
    const df = Object.create(null);

    docs.forEach(function (d) {
      const ex = extractTerms(d.title + '。' + (d.tags || []).join('。') + '。' + d.content);
      extracted[d.id] = ex;
      Object.keys(ex.tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });

    /* 1) 逐篇结构化摘要 */
    const insights = {};
    docs.forEach(function (d) {
      const ex = extracted[d.id];
      const kws = pickKeywords(ex.tf, df, N, ex.charLen, 8);
      const sum = summarizeContent(d.content, kws);
      insights[d.id] = {
        id: d.id,
        keywords: kws.map((k) => k.term),
        keywordScores: kws,
        theme: (d.tags && d.tags[0]) || (kws[0] ? kws[0].term : '未归类'),
        tldr: sum.tldr,
        points: sum.points,
        charCount: (d.content || '').length
      };
    });

    /* 未提取正文的占位资料：不参与关键词与摘要 */
    docs.forEach(function (d) {
      if (/已记录元信息|补充正文后重新分析/.test(d.content || '')) {
        insights[d.id].keywords = [];
        insights[d.id].keywordScores = [];
        insights[d.id].points = [];
        insights[d.id].theme = (d.tags && d.tags[0]) || '待补全';
        insights[d.id].tldr = '该文件尚未提取正文，暂时无法生成摘要。可在资料详情中粘贴内容后重新分析。';
      }
    });

    /* 2) 关联：共享关键词 + 同主题 */
    const edges = [];
    const deg = Object.create(null);
    docs.forEach(function (a, i) {
      docs.slice(i + 1).forEach(function (b) {
        const ka = insights[a.id].keywords, kb = insights[b.id].keywords;
        const shared = ka.filter((k) => kb.indexOf(k) >= 0);
        const tagShared = (a.tags || []).filter((t) => (b.tags || []).indexOf(t) >= 0);
        const w = shared.length + tagShared.length * 1.5;
        if (w >= 1.5) {
          edges.push({ source: a.id, target: b.id, weight: w, shared: shared.slice(0, 4), tags: tagShared });
          deg[a.id] = (deg[a.id] || 0) + w;
          deg[b.id] = (deg[b.id] || 0) + w;
        }
      });
    });

    /* 3) 重要度 */
    docs.forEach(function (d) {
      const ins = insights[d.id];
      const lengthScore = clamp(ins.charCount / 700, 0, 1) * 38;
      const kwScore = clamp(ins.keywords.length / 8, 0, 1) * 22;
      const linkScore = clamp((deg[d.id] || 0) / 9, 0, 1) * 22;
      const recency = clamp(1 - daysSince(d.updatedAt) / 90, 0, 1) * 18;
      ins.importance = Math.round(clamp(lengthScore + kwScore + linkScore + recency, 12, 99));
    });

    /* 4) 主题（标签聚合） */
    const tagMap = Object.create(null);
    docs.forEach(function (d) {
      (d.tags && d.tags.length ? d.tags : ['未归类']).forEach(function (t) {
        if (!tagMap[t]) tagMap[t] = { name: t, docs: [], types: new Set(), recent: 0, keywords: Object.create(null) };
        const g = tagMap[t];
        g.docs.push(d.id);
        g.types.add(d.type);
        if (daysSince(d.updatedAt) < 30) g.recent += 1;
        insights[d.id].keywords.forEach(function (k) { g.keywords[k] = (g.keywords[k] || 0) + 1; });
      });
    });

    const topics = Object.keys(tagMap).map(function (name) {
      const g = tagMap[name];
      const count = g.docs.length;
      const diversity = g.types.size / 4;
      const recency = count ? g.recent / count : 0;
      const coverage = name === '未归类'
        ? 18
        : Math.round(clamp(0.55 * clamp(count / 4, 0, 1) + 0.25 * clamp(diversity, 0, 1) + 0.20 * recency, 0, 1) * 100);
      const kws = Object.keys(g.keywords)
        .sort((a, b) => (g.keywords[b] * Math.log(1 + N / (df[b] || 1))) - (g.keywords[a] * Math.log(1 + N / (df[a] || 1))))
        .slice(0, 6);
      return { name: name, count: count, docIds: g.docs.slice(), coverage: coverage, keywords: kws };
    }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));

    const coreTopics = topics.filter((t) => t.name !== '未归类' && t.count >= 2);
    const tailTopics = topics.filter((t) => t.name !== '未归类' && t.count === 1);

    /* 5) 全库关键词：由各篇关键词汇总，避免碎片 */
    const kwCount = Object.create(null);
    docs.forEach(function (d) {
      insights[d.id].keywords.forEach(function (k) { kwCount[k] = (kwCount[k] || 0) + 1; });
    });
    const globalKw = Object.keys(kwCount)
      .filter((t) => (kwCount[t] >= 2 || LEXICON.has(t)) && t.length <= 6)
      .sort((a, b) => kwCount[b] - kwCount[a] || a.length - b.length)
      .slice(0, 30)
      .map((t) => ({ term: t, df: kwCount[t] }));

    /* 6) 知识缺口 */
    const gaps = [];
    const untagged = docs.filter((d) => !d.tags || !d.tags.length);
    if (untagged.length) {
      gaps.push({
        id: 'gap-untagged', sev: 'high', icon: '!', tone: 'red',
        title: untagged.length + ' 篇资料尚未打标签',
        desc: '未归类的资料不会进入主题聚合，也无法参与跨主题关联，等于游离在知识体系之外。',
        fix: '打开这些资料，补充 1—3 个主题标签', docIds: untagged.map((d) => d.id)
      });
    }

    if (tailTopics.length >= 3) {
      const ratio = tailTopics.length / Math.max(1, coreTopics.length + tailTopics.length);
      gaps.push({
        id: 'gap-thin', sev: ratio > 0.65 ? 'high' : 'mid', icon: '◔', tone: 'orange',
        title: tailTopics.length + ' 个标签只对应 1 篇资料',
        desc: '「' + tailTopics.slice(0, 3).map((t) => t.name).join('」「') + '」等标签下没有第二份资料交叉印证，' +
          (ratio > 0.5 ? '说明标签切得过细，主题网络被切碎。' : '这些概念容易停留在单点记忆。'),
        fix: '合并同义标签，或为每个薄弱主题补充一份不同来源的资料', docIds: tailTopics.reduce((a, t) => a.concat(t.docIds), [])
      });
    }

    // 标签重叠：两个主题覆盖几乎同一批资料
    const overlapPairs = [];
    const solidTopics = topics.filter((t) => t.name !== '未归类' && t.count >= 2);
    for (let i = 0; i < solidTopics.length; i++) {
      for (let j = i + 1; j < solidTopics.length; j++) {
        const A = solidTopics[i], B = solidTopics[j];
        const inter = A.docIds.filter((id) => B.docIds.indexOf(id) >= 0).length;
        const union = A.docIds.length + B.docIds.length - inter;
        if (union && inter / union >= 0.8) overlapPairs.push({ a: A, b: B, sim: inter / union });
      }
    }
    if (overlapPairs.length) {
      const p = overlapPairs[0];
      gaps.push({
        id: 'gap-overlap', sev: 'mid', icon: '⇄', tone: 'purple',
        title: '「' + p.a.name + '」与「' + p.b.name + '」覆盖同一批资料',
        desc: '两个标签的资料重合度达到 ' + Math.round(p.sim * 100) + '%，主题边界模糊，会让知识结构看起来比实际更分散。',
        fix: '合并为一个上位主题，或为两者各自补充差异化资料',
        docIds: p.a.docIds.filter((id) => p.b.docIds.indexOf(id) >= 0)
      });
    }

    const practiceTags = new Set();
    docs.forEach(function (d) {
      const tags = d.tags || [];
      if (tags.indexOf('习题') >= 0 || tags.indexOf('练习') >= 0) tags.forEach((t) => practiceTags.add(t));
    });
    const noPractice = coreTopics.filter((t) => !practiceTags.has(t.name));
    if (noPractice.length) {
      gaps.push({
        id: 'gap-practice', sev: 'mid', icon: '✎', tone: 'blue',
        title: noPractice.length + ' 个重点主题缺少练习材料',
        desc: '「' + noPractice.slice(0, 2).map((t) => t.name).join('」「') + '」只有阅读型资料，没有计算或推导练习，难以检验是否真正掌握。',
        fix: '为每个重点主题补一套 3—5 道计算题，并限时完成', docIds: noPractice.reduce((a, t) => a.concat(t.docIds), [])
      });
    }

    const stale = docs.filter((d) => daysSince(d.lastReviewed || d.updatedAt) > 30);
    if (stale.length) {
      gaps.push({
        id: 'gap-stale', sev: stale.length >= 4 ? 'high' : 'mid', icon: '↻', tone: 'orange',
        title: stale.length + ' 篇资料超过 30 天未复习',
        desc: '按遗忘曲线，这些内容已进入快速遗忘区间，其中 ' +
          stale.filter((d) => insights[d.id].importance > 55).length + ' 篇属于重要度较高的资料。',
        fix: '把重要度最高的 5 篇排入本周复习计划', docIds: stale.map((d) => d.id)
      });
    }

    const unsynced = docs.filter((d) => !d.backup || d.backup.state !== 'synced');
    if (unsynced.length) {
      gaps.push({
        id: 'gap-backup', sev: 'high', icon: '↑', tone: 'red',
        title: unsynced.length + ' 篇资料未完成备份',
        desc: '这些资料目前只存在于本机浏览器，磁盘故障、清理缓存或误删都会造成不可恢复的丢失。',
        fix: '在备份页执行一次完整备份，并导出 JSON 存档', docIds: unsynced.map((d) => d.id)
      });
    }

    const isoKw = Object.keys(df)
      .filter((t) => df[t] === 1 && LEXICON.has(t) && t.length >= 3)
      .sort((a, b) => b.length - a.length).slice(0, 1)
      .map((t) => ({ term: t, df: 1 }));
    if (isoKw.length) {
      gaps.push({
        id: 'gap-isolated', sev: 'low', icon: '◇', tone: 'gray',
        title: '「' + isoKw[0].term + '」只在一篇资料中出现',
        desc: '该概念没有与其它资料形成呼应，可能是笔记遗漏，也可能是尚未展开的新知识点。',
        fix: '补充一篇延伸阅读，或做一张概念卡片把它接入主题网络', docIds: []
      });
    }

    /* 7) 可行建议 */
    const suggestions = [];

    const reviewPool = docs.slice().sort(function (a, b) {
      const sa = (daysSince(a.lastReviewed || a.updatedAt) / 30) * 0.6 + (insights[a.id].importance / 100) * 0.9;
      const sb = (daysSince(b.lastReviewed || b.updatedAt) / 30) * 0.6 + (insights[b.id].importance / 100) * 0.9;
      return sb - sa;
    }).slice(0, 5);

    const weakTopics = coreTopics.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 2);
    const avgCoverage = Math.round(avg(topics.map((t) => t.coverage)));

    suggestions.push({
      id: 'sug-review', kind: '复习计划', kindTone: 'blue',
      priority: stale.length >= 4 ? 'high' : 'mid',
      title: '5 天滚动复习：先补最易遗忘的 5 篇',
      basis: '按「最近复习时间 × 资料重要度」排序；其中 ' + stale.length + ' 篇已超过 30 天未触碰，' +
        reviewPool.filter((d) => insights[d.id].importance > 55).length + ' 篇属于高重要度资料，优先安排在前两天。',
      scenario: '适合期末复习启动阶段，或每周固定 3 次、每次 25 分钟的学习时段。',
      steps: reviewPool.map(function (d, i) {
        return '第 ' + (i + 1) + ' 天 · ' + trimTo(shortTitle(d.title), 20) + '：先合上原文复述核心结论，再回看标注的关键词（' +
          insights[d.id].keywords.slice(0, 3).join('、') + '）';
      }),
      estimated: '5 天 · 每次约 25 分钟',
      docIds: reviewPool.map((d) => d.id)
    });

    suggestions.push({
      id: 'sug-organize', kind: '整理方案', kindTone: 'purple',
      priority: (untagged.length >= 2 || tailTopics.length > coreTopics.length) ? 'high' : 'mid',
      title: '统一标签体系：把 ' + (untagged.length || 0) + ' 篇游离资料并入主题网络',
      basis: '当前有 ' + coreTopics.length + ' 个核心主题、' + tailTopics.length + ' 个单篇标签，' +
        (untagged.length ? untagged.length + ' 篇没有标签；' : '') +
        '标签切得过细会让主题覆盖度被稀释，也难以看出知识结构。',
      scenario: '适合资料量在 10—50 篇、准备长期维护知识库时执行；一次性投入，后续检索效率明显提升。',
      steps: [
        '第一层只保留 6—10 个「章节主题」标签，例如「通货膨胀」「经济增长」',
        '第二层用「用途」标签区分资料形态：习题 / 公式 / 讲义 / 论文精读',
        '把无标签资料逐篇归档，标题统一为「主题 · 具体内容」',
        '合并同义标签，保证一个概念只有一个名字'
      ],
      estimated: '一次性 · 约 20 分钟',
      docIds: untagged.map((d) => d.id)
    });

    const pathTopics = coreTopics.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 4).reverse();
    const stageNames = ['打底：理清概念与定义', '建模：掌握图形与公式', '串联：理解变量间传导', '应用：结合政策与案例'];

    suggestions.push({
      id: 'sug-path', kind: '学习路径', kindTone: 'green',
      priority: 'mid',
      title: '四阶段学习路径：从机制理解到政策应用',
      basis: '依据主题覆盖度（' + pathTopics.map((t) => t.name + ' ' + t.coverage + '%').join('、') + '）与资料间关键词关联度排序，先补短板再串联成网。',
      scenario: '适合系统学习一门课程，或把零散笔记整合为完整知识框架时使用。',
      steps: pathTopics.length ? pathTopics.map(function (t, i) {
        return '阶段 ' + (i + 1) + ' · ' + stageNames[i] + ' —— 主题「' + t.name + '」（' + t.count + ' 篇，覆盖度 ' + t.coverage + '%）';
      }) : ['先导入资料，再生成学习路径'],
      estimated: '约 3 周 · 每周 2 个主题',
      docIds: pathTopics.reduce((a, t) => a.concat(t.docIds), [])
    });

    if (weakTopics.length) {
      suggestions.push({
        id: 'sug-fill', kind: '补强建议', kindTone: 'orange',
        priority: 'high',
        title: '为「' + weakTopics.map((t) => t.name).join('」「') + '」补充支撑材料',
        basis: '这两个主题的覆盖度为 ' + weakTopics.map((t) => t.coverage + '%').join(' 与 ') +
          '，低于全库平均 ' + avgCoverage + '%，且缺少练习与图表类资料。',
        scenario: '适合在进入下一章之前补齐前置知识，避免后续模型推导出现断点。',
        steps: [
          '为每个薄弱主题补 1 篇教材精读笔记，明确 3 个核心结论',
          '补 1 套计算题并限时完成，标记做错的步骤',
          '用一张图串起该主题与相邻主题的因果关系',
          '一周后回看错题，确认是理解问题还是记忆问题'
        ],
        estimated: '每个主题约 40 分钟',
        docIds: weakTopics.reduce((a, t) => a.concat(t.docIds), [])
      });
    }

    /* 8) 统计 */
    const typeDist = {};
    docs.forEach((d) => { typeDist[d.type] = (typeDist[d.type] || 0) + 1; });
    const backedUp = docs.filter((d) => d.backup && d.backup.state === 'synced').length;

    return {
      generatedAt: new Date().toISOString(),
      docCount: docs.length,
      insights: insights,
      edges: edges,
      degree: deg,
      topics: topics,
      coreTopics: coreTopics,
      tailTopics: tailTopics,
      keywords: globalKw,
      gaps: gaps,
      suggestions: suggestions,
      stats: {
        typeDist: typeDist,
        backedUp: backedUp,
        unsynced: docs.length - backedUp,
        avgCoverage: avgCoverage,
        tagCount: coreTopics.length + tailTopics.length,
        coreCount: coreTopics.length,
        tailCount: tailTopics.length,
        untagged: untagged.length
      }
    };
  }

  function shortTitle(t) {
    return String(t).replace(/^第\s*\d+\s*章\s*·\s*/, '').replace(/（.*?）/g, '').trim();
  }

  /* 原文关键词高亮（返回安全 HTML） */
  function highlight(text, keywords) {
    const esc = String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safe = keywords
      .filter((k) => k && k.length >= 2)
      .slice(0, 10)
      .sort((a, b) => b.length - a.length)
      .map(escRe);
    if (!safe.length) return esc;
    return esc.replace(new RegExp('(' + safe.join('|') + ')', 'gi'), '<mark>$1</mark>');
  }

  return { analyze: analyze, highlight: highlight, trimTo: trimTo, shortTitle: shortTitle, extractTerms: extractTerms };
})();
