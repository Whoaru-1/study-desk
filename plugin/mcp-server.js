#!/usr/bin/env node
'use strict';
/**
 * WorkBuddy → 学习资料工作台 · MCP 服务（stdio）
 *
 * 给 WorkBuddy 的 Agent 提供 4 个工具，走的是与网页端完全相同的核心逻辑：
 *   wb_outputs_list   列出产出文件（可直接给用户确认）
 *   wb_outputs_upload 批量复制进资料库，并写入「待入库」队列
 *   wb_inbox          查看待入库队列
 *   wb_health         能力与限制
 *
 * 传输：JSON-RPC 2.0 over stdio，每行一条消息；日志只写 stderr。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const outputs = require('./wb-outputs');
const jobs = require('./jobs');
const vault = require('./vault');

const VAULT = process.env.STUDYDESK_VAULT || path.join(os.homedir(), 'Documents', 'StudyDesk');
try { fs.mkdirSync(VAULT, { recursive: true }); } catch (e) { /* 目录不可建时仍可列文件 */ }

const SERVER = { name: 'workbuddy-workbench', version: '1.0.0' };
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'wb_outputs_list',
    description: '列出 WorkBuddy 产出的文件（读取 ~/.workbuddy/artifact-index），返回 id、名称、大小、类型、是否已在资料库。上传前先用它确认要传哪些。',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: '只看最近多少小时，默认 168（7 天）' },
        types: { type: 'string', description: '逗号分隔的类型过滤，如 pdf,docx,md；留空为全部' },
        limit: { type: 'number', description: '最多返回多少个，默认 60' },
        keyword: { type: 'string', description: '按文件名包含的关键词过滤' }
      }
    }
  },
  {
    name: 'wb_outputs_upload',
    description: '把选中的 WorkBuddy 产出文件复制进学习资料工作台的资料文件夹，并加入「待入库」队列。可用 ids（来自 wb_outputs_list）或 keyword 选择文件。文件不会从原位置移动。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要上传的文件 id 列表' },
        keyword: { type: 'string', description: '按文件名包含关键词批量选择（未提供 ids 时生效）' },
        hours: { type: 'number', description: '配合 keyword 使用时的候选时间窗，默认 168' },
        includeDuplicates: { type: 'boolean', description: '为 true 时连重复内容也导入（默认跳过）' }
      }
    }
  },
  {
    name: 'wb_inbox',
    description: '查看已复制到资料文件夹、但还没被工作台确认入库的文件。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'wb_health',
    description: '检查插件能力：产出索引位置、允许读取的目录、大小与批量限制、待入库数量。',
    inputSchema: { type: 'object', properties: {} }
  }
];

function listOutputs(args) {
  args = args || {};
  const items = outputs.list({
    since: Date.now() - (Number(args.hours) || 168) * 3600 * 1000,
    types: args.types ? String(args.types).split(',').map((s) => s.trim()).filter(Boolean) : null,
    limit: Math.min(Number(args.limit) || 60, 200)
  }).filter(function (it) {
    if (!args.keyword) return true;
    return it.name.toLowerCase().indexOf(String(args.keyword).toLowerCase()) >= 0;
  });

  const inbox = {};
  vault.readInbox(VAULT).forEach(function (x) { inbox[x.id] = 1; });

  return {
    total: items.length,
    files: items.map(function (it) {
      return {
        id: it.id,
        name: it.name,
        path: it.path,
        size: it.size,
        type: it.type || it.ext,
        supported: it.supported,
        duplicate: !!it.duplicate,
        inInbox: !!inbox[it.id],
        reason: it.reason || '',
        updatedAt: new Date(it.updatedAt).toISOString()
      };
    })
  };
}

async function upload(args) {
  args = args || {};
  const all = outputs.list({ since: Date.now() - (Number(args.hours) || 168) * 3600 * 1000, limit: 300 });
  let picked = [];

  if (Array.isArray(args.ids) && args.ids.length) {
    const map = {};
    all.forEach(function (it) { map[it.id] = it; });
    picked = args.ids.map(function (id) { return map[id]; }).filter(Boolean);
    if (!picked.length) {
      throw new Error('没有找到这些 id 对应的产出文件，可能是超出了时间窗或被移动，请先调用 wb_outputs_list');
    }
  } else if (args.keyword) {
    const kw = String(args.keyword).toLowerCase();
    picked = all.filter(function (it) { return it.supported && it.name.toLowerCase().indexOf(kw) >= 0; });
    if (!picked.length) throw new Error('没有文件名包含「' + args.keyword + '」的产出文件');
  } else {
    throw new Error('请提供 ids 或 keyword');
  }

  picked = picked.filter(function (it) { return it.supported; });
  if (picked.length > jobs.MAX_BATCH) picked = picked.slice(0, jobs.MAX_BATCH);

  const job = jobs.create(picked, { includeDuplicates: !!args.includeDuplicates });
  await jobs.run(job, { vaultDir: VAULT, sessionId: process.env.CODEBUDDY_SESSION_ID || '' });
  const pub = jobs.publicJob(job);

  return {
    ok: pub.ok,
    skipped: pub.skipped,
    failed: pub.failed,
    vault: VAULT,
    next: pub.ok ? '文件已复制到资料文件夹并进入待入库队列；打开工作台（npm start）后会在「从 WorkBuddy 导入 → 待入库」里等你确认，确认后自动生成摘要。' : '',
    items: pub.items.map(function (x) {
      return { name: x.name, status: x.status, rel: x.rel, reason: x.reason };
    })
  };
}

async function callTool(name, args) {
  if (name === 'wb_outputs_list') return listOutputs(args);
  if (name === 'wb_outputs_upload') return upload(args);
  if (name === 'wb_inbox') {
    const items = vault.readInbox(VAULT);
    return { total: items.length, items: items.map(function (x) {
      return { name: x.name, rel: x.rel, size: x.size, at: x.at };
    }) };
  }
  if (name === 'wb_health') {
    return {
      ok: true,
      version: SERVER.version,
      artifactIndex: outputs.INDEX_DIR,
      vault: VAULT,
      roots: outputs.roots(),
      limits: { maxFile: outputs.MAX_FILE, maxBatch: jobs.MAX_BATCH },
      inbox: vault.readInbox(VAULT).length
    };
  }
  throw new Error('未知工具：' + name);
}

/* ---------------- JSON-RPC ---------------- */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: id,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER
      }
    });
  }
  if (method === 'notifications/initialized' || msg.id === undefined) return;   /* 通知无需回复 */
  if (method === 'ping') return send({ jsonrpc: '2.0', id: id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const params = msg.params || {};
    try {
      const result = await callTool(params.name, params.arguments || {});
      return send({
        jsonrpc: '2.0', id: id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      });
    } catch (err) {
      return send({
        jsonrpc: '2.0', id: id,
        result: { content: [{ type: 'text', text: '调用失败：' + err.message }], isError: true }
      });
    }
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: '不支持的方法：' + method } });
  }
}

/* 串行处理：工具调用之间保持顺序（上传后再查 inbox 不会读到旧状态） */
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', function (line) {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
  }
  chain = chain.then(function () { return handle(msg); }).catch(function (err) {
    send({ jsonrpc: '2.0', id: msg && msg.id, error: { code: -32603, message: err.message } });
  });
});

process.on('SIGINT', function () { process.exit(0); });
console.error('[workbuddy-workbench] MCP server ready · vault=' + VAULT);
