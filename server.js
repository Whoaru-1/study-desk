#!/usr/bin/env node
/**
 * Study Desk — 零依赖本地静态服务器
 *
 * 用法:
 *   node server.js            # http://127.0.0.1:4173
 *   PORT=8080 node server.js  # 自定义端口
 *   npm start
 *
 * 仅监听 127.0.0.1，不对局域网/公网暴露，避免个人资料被同网段设备访问。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.argv[2]) || 4173;

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
const RESET = '\x1b[0m';

/* 未找到时的提示页 */
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
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
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

const server = http.createServer(function (req, res) {
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
  const line = '─'.repeat(46);
  console.log('\n  ' + DIM + line + RESET);
  console.log('  ' + GREEN + '●' + RESET + '  Study Desk 已启动');
  console.log('  ' + DIM + '→' + RESET + '  ' + CYAN + 'http://' + HOST + ':' + PORT + RESET);
  console.log('  ' + DIM + '仅本机可访问 · 数据保存在浏览器 localStorage' + RESET);
  console.log('  ' + DIM + '停止服务: Ctrl+C' + RESET);
  console.log('  ' + DIM + line + RESET + '\n');
});

process.on('SIGINT', function () {
  console.log('\n  ' + DIM + '已停止 Study Desk' + RESET + '\n');
  server.close(function () { process.exit(0); });
});
