'use strict';
/**
 * WorkBuddy → 学习资料工作台 集成插件（HTTP 部分）
 *
 * 接口约定（全部只在 127.0.0.1 提供）：
 *   GET  /api/wb/health                     能力与约束
 *   GET  /api/wb/list?hours=&types=&limit=  读取 WorkBuddy 产出文件
 *   POST /api/wb/upload  { ids:[], includeDuplicates } → { jobId }
 *   GET  /api/wb/job?id=                    任务进度（前端 300ms 轮询）
 *   POST /api/wb/job/cancel { id }          取消未开始的条目
 *   GET  /api/wb/inbox                      待入库队列（MCP 上传后由此入库）
 *   POST /api/wb/inbox/ack { ids:[] }       前端写入 localStorage 后确认
 */

const jobs = require('./jobs');
const outputs = require('./wb-outputs');
const vault = require('./vault');

const PLUGIN = { name: 'workbuddy-bridge', version: '1.0.0' };

module.exports = function createWbPlugin(ctx) {
  const vaultDir = ctx.vaultDir;
  const json = ctx.json;
  const readBody = ctx.readBody;
  const log = ctx.log || function () {};
  const SESSION_ID = process.env.CODEBUDDY_SESSION_ID || '';

  function list(opts) {
    const hours = Math.min(Math.max(Number(opts.hours) || 168, 1), 24 * 365);
    const types = String(opts.types || '').split(',').map((s) => s.trim()).filter(Boolean);
    const items = outputs.list({
      since: Date.now() - hours * 3600 * 1000,
      types: types.length ? types : null,
      limit: opts.limit || 200
    });

    /* 标记：已在本机资料库 / 已在待入库队列 */
    const inbox = vault.readInbox(vaultDir);
    const inboxIds = {};
    inbox.forEach(function (x) { inboxIds[x.id] = 1; });

    items.forEach(function (it) {
      it.inInbox = !!inboxIds[it.id];
      if (!it.supported || !it.exists) return;
      const dup = vault.findDuplicate(vaultDir, it.path, it.size, it.hash);
      it.duplicate = !!dup;
      if (dup) it.duplicateOf = dup.rel;
    });
    return items;
  }

  async function handleList(res, url) {
    try {
      const items = list({
        hours: url.searchParams.get('hours'),
        types: url.searchParams.get('types'),
        limit: url.searchParams.get('limit')
      });
      json(res, 200, {
        ok: true,
        total: items.length,
        supported: items.filter((x) => x.supported).length,
        missing: items.filter((x) => !x.exists).length,
        duplicates: items.filter((x) => x.duplicate).length,
        roots: outputs.roots(),
        limits: { maxFile: outputs.MAX_FILE, maxBatch: jobs.MAX_BATCH },
        items: items
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
  }

  async function handleUpload(req, res) {
    let payload;
    try {
      const raw = await readBody(req, 512 * 1024);
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch (err) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    if (!ids.length) return json(res, 400, { ok: false, error: '请选择至少一个文件' });

    const all = list({ hours: 24 * 365, limit: 500 });
    const byId = {};
    all.forEach(function (it) { byId[it.id] = it; });

    const picked = [];
    const missing = [];
    ids.forEach(function (id) {
      const it = byId[id];
      if (!it) { missing.push({ id: id, reason: '文件已从产出列表消失' }); return; }
      if (!it.supported) { missing.push({ id: id, name: it.name, reason: it.reason || '不支持的文件类型' }); return; }
      picked.push(it);
    });

    if (!picked.length) {
      return json(res, 409, { ok: false, error: '所选文件都不可导入', rejected: missing });
    }
    if (picked.length > jobs.MAX_BATCH) {
      return json(res, 413, { ok: false, error: '单次最多导入 ' + jobs.MAX_BATCH + ' 个文件' });
    }

    let job;
    try {
      job = jobs.create(picked, { includeDuplicates: !!payload.includeDuplicates });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }

    jobs.run(job, { vaultDir: vaultDir, sessionId: SESSION_ID }).then(function (done) {
      log('WorkBuddy 导入完成：成功 ' + done.items.filter((x) => x.status === 'done').length +
        ' / 跳过 ' + done.items.filter((x) => x.status === 'skipped').length +
        ' / 失败 ' + done.items.filter((x) => x.status === 'failed').length);
    });

    json(res, 202, { ok: true, jobId: job.id, accepted: picked.length, rejected: missing });
  }

  async function handleAck(req, res) {
    let payload;
    try {
      const raw = await readBody(req, 256 * 1024);
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch (err) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const left = vault.ackInbox(vaultDir, Array.isArray(payload.ids) ? payload.ids : []);
    json(res, 200, { ok: true, remaining: left.length });
  }

  function handle(req, res, url) {
    const p = url.pathname;
    if (p.indexOf('/api/wb/') !== 0) return false;

    if (p === '/api/wb/health') {
      json(res, 200, {
        ok: true, plugin: PLUGIN.name, version: PLUGIN.version,
        artifactIndex: outputs.INDEX_DIR,
        roots: outputs.roots(),
        limits: { maxFile: outputs.MAX_FILE, maxBatch: jobs.MAX_BATCH },
        inbox: vault.readInbox(vaultDir).length
      });
      return true;
    }
    if (p === '/api/wb/list') { handleList(res, url); return true; }
    if (p === '/api/wb/upload' && req.method === 'POST') { handleUpload(req, res); return true; }
    if (p === '/api/wb/job') {
      const job = jobs.get(url.searchParams.get('id'));
      if (!job) return json(res, 404, { ok: false, error: '任务不存在或已过期' }), true;
      return json(res, 200, { ok: true, job: jobs.publicJob(job) }), true;
    }
    if (p === '/api/wb/job/cancel' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', function () {
        try {
          const id = JSON.parse(body || '{}').id;
          json(res, 200, { ok: jobs.cancel(id) });
        } catch (e) {
          json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }
      });
      return true;
    }
    if (p === '/api/wb/inbox') {
      const items = vault.readInbox(vaultDir);
      json(res, 200, { ok: true, total: items.length, items: items });
      return true;
    }
    if (p === '/api/wb/inbox/ack' && req.method === 'POST') { handleAck(req, res); return true; }

    json(res, 404, { ok: false, error: '未定义的插件接口' });
    return true;
  }

  return { handle, list, getJob: jobs.get, publicJob: jobs.publicJob, PLUGIN };
};

module.exports.PLUGIN = PLUGIN;
