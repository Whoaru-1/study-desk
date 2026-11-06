'use strict';
/**
 * 资料仓库写入层
 *
 * 负责三件事：
 *   1. 内容级去重（同 size 才计算哈希，避免全盘读文件）
 *   2. 复制进仓库，重名自动加 (2)
 *   3. 待入库队列（inbox）：文件先落盘，等前端把元信息写进 localStorage 后 ack
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INBOX_FILE = '.workbench-inbox.json';

function sha256(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 32);
}

const hashCache = new Map();
function hashOf(abs, stat) {
  const st = stat || fs.statSync(abs);
  const key = abs + ':' + st.size + ':' + Math.round(st.mtimeMs);
  if (hashCache.has(key)) return hashCache.get(key);
  const h = sha256(abs);
  hashCache.set(key, h);
  if (hashCache.size > 4000) hashCache.delete(hashCache.keys().next().value);
  return h;
}

/* 仓库内与给定内容相同的文件（只对同尺寸文件做哈希） */
function findDuplicate(vaultDir, abs, size, hash) {
  let names = [];
  try {
    names = fs.readdirSync(vaultDir);
  } catch (e) {
    return null;
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === INBOX_FILE || name.charAt(0) === '.') continue;
    const full = path.join(vaultDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile() || st.size !== size) continue;
    try {
      if (hashOf(full, st) === hash || (abs && path.resolve(full) === path.resolve(abs))) {
        return { rel: name, size: st.size };
      }
    } catch (e) { /* 读取失败则跳过 */ }
  }
  return null;
}

function uniqueName(vaultDir, name) {
  const safe = String(name || 'untitled').replace(/[:*?"<>|\\/]/g, '_').replace(/^\.+/, '').trim() || 'untitled';
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let candidate = path.join(vaultDir, safe);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(vaultDir, base + ' (' + i + ')' + ext);
    i += 1;
    if (i > 999) break;
  }
  return path.basename(candidate);
}

function copyIn(vaultDir, srcAbs, name) {
  const st = fs.statSync(srcAbs);
  const hash = hashOf(srcAbs, st);
  const target = uniqueName(vaultDir, name || path.basename(srcAbs));
  fs.copyFileSync(srcAbs, path.join(vaultDir, target));
  return {
    rel: target,
    size: st.size,
    hash: hash,
    renamed: target !== path.basename(name || srcAbs)
  };
}

/* ---------------- 待入库队列 ---------------- */

function inboxPath(vaultDir) {
  return path.join(vaultDir, INBOX_FILE);
}

function readInbox(vaultDir) {
  try {
    const raw = fs.readFileSync(inboxPath(vaultDir), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function writeInbox(vaultDir, list) {
  try {
    fs.writeFileSync(inboxPath(vaultDir), JSON.stringify(list.slice(-500), null, 2), 'utf8');
  } catch (e) { /* 队列写失败不影响文件已落盘 */ }
}

function addInbox(vaultDir, entries) {
  const list = readInbox(vaultDir);
  const known = {};
  list.forEach(function (x) { known[x.id] = 1; });
  entries.forEach(function (e) {
    if (!known[e.id]) { list.push(e); known[e.id] = 1; }
  });
  writeInbox(vaultDir, list);
  return list;
}

function ackInbox(vaultDir, ids) {
  const kill = {};
  (ids || []).forEach(function (id) { kill[id] = 1; });
  const list = readInbox(vaultDir).filter(function (x) { return !kill[x.id]; });
  writeInbox(vaultDir, list);
  return list;
}

module.exports = {
  INBOX_FILE,
  hashOf,
  findDuplicate,
  uniqueName,
  copyIn,
  readInbox,
  addInbox,
  ackInbox
};
