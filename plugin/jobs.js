'use strict';
/**
 * 上传任务：单并发队列 + 逐条进度 + 可取消 + 失败不中断
 *
 * 一个 job 的状态机：
 *   pending → copying → done
 *                    ↘ skipped（重复 / 已入库 / 用户取消）
 *                    ↘ failed（无权限、源文件消失、磁盘满…）
 * 每个文件独立结算，任一失败不影响其余文件。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vault = require('./vault');
const outputs = require('./wb-outputs');

const jobs = new Map();
const MAX_JOBS = 30;
const MAX_BATCH = 30;

const ERR_TEXT = {
  ENOENT: '源文件已被移动或删除',
  EACCES: '没有读取权限',
  EPERM: '没有读取权限',
  ENOSPC: '磁盘空间不足',
  EMFILE: '打开文件过多，请稍后重试'
};

function newJobId() {
  return 'wb-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    running: !!job.running,
    cancelled: !!job.cancelled,
    total: job.items.length,
    done: job.items.filter((x) => x.status !== 'pending' && x.status !== 'copying').length,
    ok: job.items.filter((x) => x.status === 'done').length,
    skipped: job.items.filter((x) => x.status === 'skipped').length,
    failed: job.items.filter((x) => x.status === 'failed').length,
    bytes: job.items.reduce((s, x) => s + (x.status === 'done' ? x.size : 0), 0),
    items: job.items.map(function (x) {
      return {
        id: x.id, name: x.name, size: x.size, status: x.status,
        reason: x.reason || '', rel: x.rel || null, type: x.type || '', hash: x.hash || ''
      };
    })
  };
}

function create(items, opts) {
  opts = opts || {};
  if (!Array.isArray(items) || !items.length) throw new Error('没有选择任何文件');
  if (items.length > MAX_BATCH) throw new Error('单次最多导入 ' + MAX_BATCH + ' 个文件');

  const job = {
    id: newJobId(),
    createdAt: Date.now(),
    running: false,
    cancelled: false,
    includeDuplicates: !!opts.includeDuplicates,
    items: items.map(function (it) {
      return {
        id: it.id, path: it.path, name: it.name, size: Number(it.size) || 0,
        type: it.type, ext: it.ext, hash: it.hash || '',
        status: 'pending', reason: '', rel: null
      };
    })
  };

  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  job.items.forEach(function (x) {
    if (x.status === 'pending') { x.status = 'skipped'; x.reason = '已取消'; }
  });
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(job, ctx) {
  const vaultDir = ctx.vaultDir;
  job.running = true;
  const seen = {};   /* 本批次内内容去重 */
  const inbox = vault.readInbox(vaultDir);
  const inboxIds = {};
  inbox.forEach(function (x) { inboxIds[x.id] = 1; });

  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i];
    if (item.status !== 'pending') continue;

    if (job.cancelled) {
      item.status = 'skipped';
      item.reason = '已取消';
      continue;
    }

    item.status = 'copying';
    await sleep(0);   /* 让出事件循环，前端能拿到中间状态 */

    try {
      let st = null;
      try {
        st = fs.statSync(item.path);
      } catch (e) {
        item.status = 'failed';
        item.reason = ERR_TEXT[e.code] || '源文件不可读';
        continue;
      }
      item.size = st.size;

      if (st.size > outputs.MAX_FILE) {
        item.status = 'failed';
        item.reason = '超过 200MB 上限';
        continue;
      }

      const hash = item.hash || outputs.shortHash(item.path, st);
      item.hash = hash;

      if (seen[hash]) {
        item.status = 'skipped';
        item.reason = '与本次已选文件内容相同';
        continue;
      }
      seen[hash] = item.id;

      if (inboxIds[item.id]) {
        item.status = 'skipped';
        item.reason = '已在待入库队列中';
        continue;
      }

      if (!job.includeDuplicates) {
        const dup = vault.findDuplicate(vaultDir, item.path, st.size, hash);
        if (dup) {
          item.status = 'skipped';
          item.reason = '资料库中已有相同内容';
          item.rel = dup.rel;
          continue;
        }
      }

      const copied = vault.copyIn(vaultDir, item.path, item.name);
      item.rel = copied.rel;
      item.size = copied.size;

      vault.addInbox(vaultDir, [{
        id: item.id,
        rel: copied.rel,
        name: path.basename(copied.rel),
        originalName: item.name,
        size: copied.size,
        hash: copied.hash,
        type: item.type,
        source: 'workbuddy',
        sessionId: ctx.sessionId || '',
        at: new Date().toISOString()
      }]);
      inboxIds[item.id] = 1;

      item.status = 'done';
      item.reason = copied.renamed ? '已重命名为 ' + copied.rel + '（同名文件已存在）' : '';
    } catch (err) {
      item.status = 'failed';
      item.reason = ERR_TEXT[err.code] || ('写入失败：' + err.message);
    }
  }

  job.running = false;
  job.finishedAt = Date.now();
  return job;
}

module.exports = { create, get, cancel, run, publicJob, MAX_BATCH };
