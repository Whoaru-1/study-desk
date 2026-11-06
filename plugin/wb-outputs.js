'use strict';
/**
 * WorkBuddy 产出文件索引读取
 *
 * WorkBuddy 会把每次会话产出的文件登记在：
 *   ~/.workbuddy/artifact-index/<conversationId>.json
 * 每个文件带 uri（file:// 绝对路径）、name、size、mimeType、updatedAt。
 * 这里把它读成扁平列表，并做存在性、类型、路径合法性校验。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const INDEX_DIR = process.env.WB_ARTIFACT_DIR || path.join(os.homedir(), '.workbuddy', 'artifact-index');

/* 资料类型白名单：值与工作台 TYPE_META 对齐 */
const TYPE_MAP = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  md: 'md',
  markdown: 'md',
  txt: 'note',
  csv: 'note',
  json: 'note',
  html: 'url',
  htm: 'url',
  ipynb: 'note'
};

/* 允许读取的源目录（防止越权读取任意路径） */
const DEFAULT_ROOTS = [
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'WorkBuddy')
];

const MAX_FILE = 200 * 1024 * 1024;

function roots() {
  const extra = String(process.env.WB_OUTPUT_ROOTS || '')
    .split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  const cwd = process.env.WB_WORKSPACE || '';
  const list = DEFAULT_ROOTS.concat(extra);
  if (cwd) list.push(cwd);
  return Array.from(new Set(list.map((p) => path.resolve(p))));
}

function withinRoots(abs) {
  return roots().some((root) => {
    const r = root.endsWith(path.sep) ? root : root + path.sep;
    return abs === root || abs.startsWith(r);
  });
}

function decodeUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.indexOf('file://') !== 0) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch (e) {
    return null;
  }
}

const idOf = (str) => crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);

/* 疑似中间产物：隐藏文件、临时后缀、分页/导出副本（.p1.pdf、.tmp2.pdf） */
function isTransient(name) {
  return /^\./.test(name) || /\.tmp\d*\./i.test(name) || /\.p\d+\./i.test(name) ||
    /\.tmp$/i.test(name) || /^~\$/.test(name);
}

/* 读取全部索引文件；同一路径以 updatedAt 最新的一条为准 */
function readArtifacts() {
  let names = [];
  try {
    names = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }

  const byPath = Object.create(null);
  names.forEach(function (file) {
    const sessionId = file.replace(/\.json$/, '');
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, file), 'utf8'));
    } catch (e) {
      return;
    }
    (doc.artifacts || []).forEach(function (a) {
      const abs = decodeUri(a.uri);
      if (!abs) return;
      const prev = byPath[abs];
      const updated = Number(a.updatedAt || a.createdAt || 0);
      if (prev && prev.updatedAt >= updated) return;
      byPath[abs] = {
        path: abs,
        name: a.name || path.basename(abs),
        mime: a.mimeType || '',
        size: Number(a.size || 0),
        updatedAt: updated,
        createdAt: Number(a.createdAt || updated),
        sessionId: sessionId,
        tool: (a._meta && a._meta['codebuddy.ai/toolName']) || ''
      };
    });
  });
  return Object.keys(byPath).map((k) => byPath[k]);
}

/* 规范化：类型、大小、路径、存在性、重复判断 */
function normalize(list, opts) {
  opts = opts || {};
  const since = opts.since ? Number(opts.since) : 0;
  const limit = Math.min(Number(opts.limit) || 200, 500);
  const typeFilter = opts.types && opts.types.length ? opts.types : null;
  const out = [];
  const seenHash = Object.create(null);

  list
    .filter((a) => !since || a.updatedAt >= since)
    .sort((x, y) => y.updatedAt - x.updatedAt)
    .forEach(function (a) {
      const ext = path.extname(a.name).slice(1).toLowerCase();
      const type = TYPE_MAP[ext] || '';
      const item = {
        id: idOf(a.path),
        name: a.name,
        path: a.path,
        dir: path.dirname(a.path),
        ext: ext,
        type: type,
        mime: a.mime,
        size: a.size,
        updatedAt: a.updatedAt,
        sessionId: a.sessionId,
        supported: !!type,
        exists: true,
        transient: isTransient(a.name),
        reason: ''
      };

      if (!withinRoots(a.path)) {
        item.supported = false;
        item.reason = '不在允许读取的目录内';
      } else {
        let stat = null;
        try {
          stat = fs.statSync(a.path);
        } catch (e) {
          item.exists = false;
          item.supported = false;
          item.reason = '源文件已被移动或删除';
        }
        if (stat) {
          if (!stat.isFile()) {
            item.supported = false;
            item.reason = '不是普通文件';
          } else {
            item.size = stat.size;
            item.updatedAt = Math.max(item.updatedAt, Math.round(stat.mtimeMs));
            if (stat.size > MAX_FILE) {
              item.supported = false;
              item.reason = '超过 200MB 上限';
            }
            /* 只为可导入的类型计算内容哈希：列表里大量代码/图片不值得读盘 */
            if (type) {
              item.hash = shortHash(a.path, stat);
              if (seenHash[item.hash]) {
                item.supported = false;
                item.reason = '与另一条产出内容相同';
                item.dupOf = seenHash[item.hash];
              } else {
                seenHash[item.hash] = item.id;
              }
            }
          }
        }
      }
      if (typeFilter && typeFilter.indexOf(type) < 0) return;
      if (out.length < limit) out.push(item);
    });

  return out;
}

/* 内容哈希（大小 + 修改时间缓存，避免重复读盘） */
const hashCache = new Map();
function shortHash(abs, stat) {
  const st = stat || fs.statSync(abs);
  const key = abs + ':' + st.size + ':' + Math.round(st.mtimeMs);
  if (hashCache.has(key)) return hashCache.get(key);
  let hash = '';
  try {
    hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 32);
  } catch (e) {
    hash = 'err-' + idOf(abs);
  }
  hashCache.set(key, hash);
  if (hashCache.size > 4000) hashCache.delete(hashCache.keys().next().value);
  return hash;
}

function list(opts) {
  return normalize(readArtifacts(), opts || {});
}

module.exports = {
  INDEX_DIR,
  TYPE_MAP,
  MAX_FILE,
  roots,
  withinRoots,
  readArtifacts,
  list,
  shortHash,
  idOf,
  isTransient
};
