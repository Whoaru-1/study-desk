#!/usr/bin/env node
/**
 * Study Desk — 零依赖本地服务器
 *
 * 除静态托管外，额外提供三个本机能力（浏览器沙箱无法直接做到）：
 *   GET  /api/health       探测是否为本地模式
 *   POST /api/files        把导入的文件写入访达可见的仓库目录
 *   GET  /api/extract      从仓库里的 PDF / DOCX / PPTX / 文本中提取正文
 *   POST /api/reveal       在访达中定位 / 打开该文件
 *   POST /api/open-folder  打开仓库目录
 *
 * 用法:
 *   node server.js            # http://127.0.0.1:4173
 *   PORT=8080 node server.js  # 自定义端口
 *   npm start
 *
 * 仅监听 127.0.0.1，不对局域网/公网暴露；所有 API 还会校验 Host 头。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { extract } = require('./lib/extract');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.argv[2]) || 4173;

/* 文件仓库：导入的原始文件会落在这里，路径即访达里能看到的真实位置 */
const VAULT = process.env.STUDYDESK_VAULT || path.join(os.homedir(), 'Documents', 'StudyDesk');
/* 测试用：只记录不真正调用 open(1)，避免自动化测试时弹出访达窗口 */
const REVEAL_DRY = process.env.REVEAL_DRY === '1';
const MAX_UPLOAD = 200 * 1024 * 1024; /* 200MB */

try {
  fs.mkdirSync(VAULT, { recursive: true });
} catch (err) {
  console.error('\n  无法创建资料目录 ' + VAULT + '：' + err.message + '\n');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const NOT_FOUND = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>404 · Study Desk</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;
font-family:-apple-system,"SF Pro Text","PingFang SC",sans-serif;color:#1c1c1e}
.card{text-align:center;padding:48px 40px;background:#fff;border-radius:24px;
box-shadow:0 18px 48px -16px rgba(0,0,0,.18)}
h1{font-size:44px;margin:0 0 6px;font-weight:650;letter-spacing:-.02em}
p{color:#6b6b70;font-size:14px;margin:0 0 22px}
a{display:inline-block;padding:10px 20px;border-radius:99px;background:#0a84ff;color:#fff;
text-decoration:none;font-size:13.5px;font-weight:590}</style></head>
<body><div class="card"><h1>404</h1><p>这个路径下没有文件。</p><a href="/">回到工作台</a></div></body></html>`;

/* ---------------- 通用工具 ---------------- */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('文件超过 ' + Math.round(limit / 1048576) + 'MB 限制'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/* 只接受本机来源，防止同网段设备调用 open(1) */
function isLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const name = host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function safeName(raw) {
  let name = String(raw || '').replace(/^.*[\\/]/, '');
  name = name.replace(/[:*?"<>|\\/]/g, '_').replace(/^\.+/, '').trim();
  if (!name) name = 'untitled';
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function uniquePath(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(VAULT, name);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(VAULT, base + ' (' + i + ')' + ext);
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

function resolveInVault(rel) {
  if (!rel) return null;
  const abs = path.resolve(VAULT, String(rel));
  const root = VAULT.endsWith(path.sep) ? VAULT : VAULT + path.sep;
  if (abs !== VAULT && !abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

function vaultLabel() {
  const home = os.homedir();
  const abs = path.resolve(VAULT);
  return abs.startsWith(home) ? '~' + abs.slice(home.length) : abs;
}

/* 调用系统能力：darwin 用 open(1)，win32 用 explorer，linux 用 xdg-open */
function systemReveal(abs, mode) {
  const platform = process.platform;
  if (REVEAL_DRY) {
    console.log(DIM + '  [dry-run] ' + mode + ' ' + abs + RESET);
    return Promise.resolve({ ok: true, dry: true });
  }

  let cmd, args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = mode === 'open' ? [abs] : ['-R', abs];
  } else if (platform === 'win32') {
    cmd = 'explorer.exe';
    args = mode === 'open' ? [abs] : ['/select,' + abs];
  } else {
    cmd = 'xdg-open';
    args = [mode === 'open' ? abs : path.dirname(abs)];
  }

  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    child.on('error', function (err) { resolve({ ok: false, error: err.message }); });
    child.on('spawn', function () {
      child.unref();
      resolve({ ok: true });
    });
  });
}

/* ---------------- API 路由 ---------------- */

async function handleApi(req, res, url) {
  if (!isLocalHost(req)) return json(res, 403, { ok: false, error: '仅允许本机访问' });

  /* 探测本地能力 */
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      local: true,
      platform: process.platform,
      vault: vaultLabel(),
      canReveal: ['darwin', 'win32', 'linux'].indexOf(process.platform) >= 0,
      canExtract: true,
      pdfEngine: process.platform === 'darwin' ? 'pdfkit' : 'fallback',
      dryRun: REVEAL_DRY
    });
  }

  /* 提取正文：导入后自动生成摘要、或详情里点「重新提取正文」时调用 */
  if (url.pathname === '/api/extract' && req.method === 'GET') {
    const abs = resolveInVault(url.searchParams.get('rel'));
    if (!abs) return json(res, 404, { ok: false, error: '仓库中找不到该文件（可能已被移动或删除）' });

    const started = Date.now();
    const result = await extract(abs);
    if (!result.ok) return json(res, 422, result);

    console.log(CYAN + '  ⌘ 解析正文' + RESET + ' ' + path.basename(abs) +
      DIM + '  ' + result.chars + '字' + (result.pages ? ' · ' + result.pages + '页' : '') +
      ' · ' + (Date.now() - started) + 'ms' + RESET);
    return json(res, 200, result);
  }

  /* 保存上传的文件到仓库 */
  if (url.pathname === '/api/files' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    let body;
    try {
      body = await readBody(req, MAX_UPLOAD);
    } catch (err) {
      return json(res, err.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: err.message });
    }
    if (!body.length) return json(res, 400, { ok: false, error: '文件内容为空' });

    const target = uniquePath(name);
    try {
      fs.writeFileSync(target, body);
    } catch (err) {
      return json(res, 500, { ok: false, error: '写入失败：' + err.message });
    }

    console.log(GREEN + '  ＋ 已存入仓库' + RESET + ' ' + path.basename(target) + DIM + '  ' + Math.round(body.length / 1024) + 'KB' + RESET);
    return json(res, 201, {
      ok: true,
      file: { name: path.basename(target), rel: path.basename(target), size: body.length }
    });
  }

  /* 在访达中显示 / 用默认应用打开 */
  if (url.pathname === '/api/reveal' && req.method === 'POST') {
    let payload;
    try {
      const raw = await readBody(req, 64 * 1024);
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch (err) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const abs = resolveInVault(payload.rel);
    if (!abs) return json(res, 404, { ok: false, error: '仓库中找不到该文件（可能已被移动或删除）' });

    const result = await systemReveal(abs, payload.mode === 'open' ? 'open' : 'reveal');
    if (!result.ok) return json(res, 500, result);
    console.log(CYAN + '  ◎ ' + (payload.mode === 'open' ? '打开' : '定位') + RESET + ' ' + path.basename(abs));
    return json(res, 200, result);
  }

  /* 打开仓库目录 */
  if (url.pathname === '/api/open-folder' && req.method === 'POST') {
    const result = await systemReveal(VAULT, 'reveal');
    return json(res, result.ok ? 200 : 500, result);
  }

  return json(res, 404, { ok: false, error: '未定义的接口' });
}

/* ---------------- 静态资源 ---------------- */

function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (_) {
    return null; /* 非法百分号编码 */
  }
  const rel = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (full !== ROOT && !full.startsWith(rootPrefix)) return null; /* 目录穿越 */
  return full;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, headers || {}));
  res.end(body);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) return send(res, 404, NOT_FOUND, { 'Content-Type': MIME['.html'] });

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';

    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      ETag: etag
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }

    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', function () { res.destroy(); });
    stream.pipe(res);
  });
}

/* ---------------- 服务入口 ---------------- */

const server = http.createServer(function (req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || HOST + ':' + PORT));

  if (url.pathname.indexOf('/api/') === 0) {
    handleApi(req, res, url).catch(function (err) {
      console.error(RED + '  API 错误: ' + err.message + RESET);
      if (!res.headersSent) json(res, 500, { ok: false, error: err.message });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
  }

  const target = resolveSafe(req.url || '/');
  if (!target) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });

  const started = Date.now();
  res.on('finish', function () {
    const code = res.statusCode;
    const tone = code >= 400 ? YELLOW : GREEN;
    console.log(
      DIM + '  ' + req.method.padEnd(4) + RESET +
      ' ' + tone + String(code) + RESET +
      ' ' + decodeURIComponent(req.url || '/') +
      DIM + '  ' + (Date.now() - started) + 'ms' + RESET
    );
  });

  fs.stat(target, function (err, stat) {
    if (!err && stat.isDirectory()) {
      return serveFile(req, res, path.join(target, 'index.html'));
    }
    serveFile(req, res, target);
  });
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  ' + YELLOW + '端口 ' + PORT + ' 已被占用' + RESET +
      '\n  换个端口试试:  ' + CYAN + 'PORT=4174 npm start' + RESET + '\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, function () {
  const line = '─'.repeat(52);
  console.log('\n  ' + DIM + line + RESET);
  console.log('  ' + GREEN + '●' + RESET + '  Study Desk 已启动');
  console.log('  ' + DIM + '→' + RESET + '  ' + CYAN + 'http://' + HOST + ':' + PORT + RESET);
  console.log('  ' + DIM + '→' + RESET + '  资料仓库  ' + CYAN + vaultLabel() + RESET);
  console.log('  ' + DIM + '（导入的原始文件会存到这里，可在访达中直接打开）' + RESET);
  console.log('  ' + DIM + '停止服务: Ctrl+C' + RESET);
  console.log('  ' + DIM + line + RESET + '\n');
});

process.on('SIGINT', function () {
  console.log('\n  ' + DIM + '已停止 Study Desk' + RESET + '\n');
  server.close(function () { process.exit(0); });
});
