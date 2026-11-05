'use strict';
/**
 * 正文提取：把导入到仓库里的文件转成可分析的文字
 *
 * 依赖为零：
 *   · PDF —— macOS 用系统自带的 PDFKit（经 osascript JXA 调用），
 *            其它平台退化为 zlib + 文本操作符的粗略提取
 *   · DOCX / PPTX —— 本质是 zip，用 zlib.inflateRawSync 解包后取 XML 文本
 *   · TXT / MD / CSV 等 —— 直接按 UTF-8 读取
 *
 * 结果按「路径 + 大小 + 修改时间」缓存，重复分析不会重复解析。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const MAX_TEXT = 60000;      /* 返回给前端的正文上限 */
const PDF_TIMEOUT = 25000;   /* 单个 PDF 解析超时 */
const CACHE_MAX = 48;

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.js', '.css', '.xml', '.tex', '.srt', '.log']);
const ZIP_EXT = new Set(['.docx', '.pptx', '.xlsx']);
const cache = new Map();

/* ---------------- 文本清洗 ---------------- */

/* PDF 抽出来的文字常被硬换行切断，这里按标点重新拼回段落 */
function tidy(raw) {
  const clean = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, ' ');

  const lines = clean.split('\n').map((l) => l.replace(/[\t ]+/g, ' ').trim());
  const paras = [];
  let buf = '';
  const flush = () => { if (buf) { paras.push(buf); buf = ''; } };

  lines.forEach(function (line) {
    if (!line) { flush(); return; }
    buf += line;
    /* 句末标点、或明显是标题/项目符号的短行（PPT 一页一行）都断段 */
    if (/[。！？；：!?;:.）)】」』]$/.test(line) || buf.length >= 140 || line.length <= 16) flush();
  });
  flush();

  return paras.join('\n')
    /* 汉字之间被 PDF 拆出的空格（"第 十 六 章"）合并回去 */
    .replace(/([\u4e00-\u9fa5])[ ]+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------------- PDF ---------------- */

let jxaPath = null;
function jxaScriptPath() {
  if (jxaPath && fs.existsSync(jxaPath)) return jxaPath;
  const code = [
    'ObjC.import("Foundation");',
    'ObjC.import("Quartz");',
    'function run(argv) {',
    '  var url = $.NSURL.fileURLWithPath(argv[0]);',
    '  var doc = $.PDFDocument.alloc.initWithURL(url);',
    '  if (!doc || doc.isNil()) return JSON.stringify({ ok: false, error: "无法解析该 PDF" });',
    '  var text = ObjC.unwrap(doc.string) || "";',
    '  return JSON.stringify({ ok: true, text: text, pages: Number(doc.pageCount) || 0 });',
    '}'
  ].join('\n');
  const file = path.join(os.tmpdir(), 'studydesk-pdf.js');
  try {
    fs.writeFileSync(file, code, 'utf8');
    jxaPath = file;
    return file;
  } catch (err) {
    jxaPath = null;
    return null;
  }
}

function pdfByPdfKit(abs) {
  return new Promise(function (resolve) {
    const script = jxaScriptPath();
    if (!script) return resolve(null);
    execFile('osascript', ['-l', 'JavaScript', script, abs], {
      timeout: PDF_TIMEOUT,
      maxBuffer: 48 * 1024 * 1024,
      encoding: 'utf8'
    }, function (err, stdout) {
      if (err && !stdout) return resolve(null);
      try {
        const out = JSON.parse(String(stdout || '').trim());
        if (!out || !out.ok) return resolve(null);
        resolve({ text: out.text || '', pages: out.pages || 0, source: 'pdfkit' });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/* 非 macOS 的兜底：解压每条流，抓 BT/ET 之间的 Tj、TJ 字符串 */
function pdfByOperators(buf) {
  const latin = buf.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(latin)) !== null) {
    const raw = Buffer.from(m[1], 'latin1');
    let data = null;
    try { data = zlib.inflateSync(raw); } catch (e) {
      try { data = zlib.inflateRawSync(raw); } catch (e2) { data = raw; }
    }
    const body = data.toString('latin1');
    if (body.indexOf('BT') < 0) continue;
    const textRe = /\(((?:\\.|[^()\\])*)\)\s*(?:Tj|TJ|')|\[((?:[^\]]|\][^T])*)\]\s*TJ/g;
    let t;
    while ((t = textRe.exec(body)) !== null) {
      if (t[1] != null) {
        out.push(t[1].replace(/\\([()\\])/g, '$1'));
      } else if (t[2]) {
        const parts = t[2].match(/\(((?:\\.|[^()\\])*)\)/g) || [];
        out.push(parts.map((p) => p.slice(1, -1).replace(/\\([()\\])/g, '$1')).join(''));
      }
    }
    if (out.length > 400000) break;
  }
  return { text: out.join(' '), pages: 0, source: 'fallback' };
}

async function pdfText(abs, buf) {
  if (process.platform === 'darwin') {
    const r = await pdfByPdfKit(abs);
    if (r && r.text && r.text.trim().length > 40) return r;
    if (r && r.pages) return r; /* 扫描件：没有文本层也如实返回 */
  }
  try {
    return pdfByOperators(buf);
  } catch (e) {
    return { text: '', pages: 0, source: 'fallback' };
  }
}

/* ---------------- DOCX / PPTX（zip） ---------------- */

function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (!off || off >= buf.length) return null;

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (localOff + 30 > buf.length) continue;
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnameLen + lextraLen;
    if (start + compSize > buf.length) continue;
    entries.push({ name: name, method: method, data: buf.subarray(start, start + compSize) });
  }
  return entries;
}

function unzipText(entry) {
  try {
    const data = entry.method === 0 ? entry.data : zlib.inflateRawSync(entry.data);
    return data.toString('utf8');
  } catch (e) {
    return '';
  }
}

function xmlToText(xml, paraTag) {
  if (!xml) return '';
  return xml
    .replace(new RegExp('</' + paraTag + '>', 'g'), '\n')
    .replace(/<w:tab\/>|<a:tab\/>/g, ' ')
    .replace(/<w:br\/>|<a:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function officeText(abs, ext, buf) {
  const entries = readZip(buf);
  if (!entries) return { text: '', pages: 0, source: 'zip' };

  if (ext === '.docx') {
    const main = entries.filter((e) => e.name === 'word/document.xml')[0];
    const xml = main ? unzipText(main) : '';
    return { text: xmlToText(xml, 'w:p'), pages: 0, source: 'docx' };
  }

  if (ext === '.pptx') {
    const slides = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort(function (a, b) {
        const na = Number((a.name.match(/slide(\d+)/) || [])[1] || 0);
        const nb = Number((b.name.match(/slide(\d+)/) || [])[1] || 0);
        return na - nb;
      });
    const text = slides.map((s) => xmlToText(unzipText(s), 'a:p')).join('\n');
    return { text: text, pages: slides.length, source: 'pptx' };
  }

  return { text: '', pages: 0, source: 'zip' };
}

/* ---------------- 对外接口 ---------------- */

async function extract(abs) {
  const ext = path.extname(abs).toLowerCase();
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    return { ok: false, error: '文件不存在或无法读取' };
  }
  if (!stat.isFile()) return { ok: false, error: '不是文件' };
  if (stat.size > 200 * 1024 * 1024) return { ok: false, error: '文件超过 200MB，暂不解析' };

  const key = abs + ':' + stat.size + ':' + stat.mtimeMs;
  if (cache.has(key)) return cache.get(key);

  let raw = null;
  let pages = 0;
  let source = '';

  try {
    if (ext === '.pdf') {
      const buf = fs.readFileSync(abs);
      const r = await pdfText(abs, buf);
      raw = tidy(r.text);
      pages = r.pages || 0;
      source = r.source;
    } else if (ZIP_EXT.has(ext)) {
      const buf = fs.readFileSync(abs);
      const r = officeText(abs, ext, buf);
      raw = tidy(r.text);
      pages = r.pages || 0;
      source = r.source;
    } else if (TEXT_EXT.has(ext)) {
      raw = fs.readFileSync(abs, 'utf8').trim();
      source = 'text';
    } else if (ext === '.doc' || ext === '.ppt') {
      return { ok: false, error: '旧版 Office 格式无法解析，请另存为 ' + ext + 'x 后重新导入' };
    } else {
      return { ok: false, error: '该格式暂不支持自动提取（支持 PDF / DOCX / PPTX / 文本）' };
    }
  } catch (err) {
    return { ok: false, error: '解析失败：' + err.message };
  }

  const text = String(raw || '').replace(/\n{3,}/g, '\n\n').trim();
  const result = text.length
    ? { ok: true, text: text.slice(0, MAX_TEXT), chars: text.length, truncated: text.length > MAX_TEXT, pages: pages, source: source }
    : { ok: false, error: '没有提取到文字，可能是扫描件或纯图片文件', pages: pages, source: source };

  cache.set(key, result);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { extract: extract, tidy: tidy };
