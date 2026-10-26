#!/usr/bin/env node
/**
 * 107 翻唱服务自动接线：
 *   轮询 SCOW 作业 API → 发现 sing 作业 RUNNING（RVC 服务用 srun 复用它同一张 A100）
 *   → 经 SCOW 代理探活 8047/health → 把 baseUrl/apiKey/cookie 写进内核 cover 插件
 *   → 作业结束清空 baseUrl。
 *
 * 用法：
 *   node --use-system-ca scripts/cover/ustc-watch.mjs \
 *     --cookie "SCOW_USER=ustc-..." --api-key <COVER_API_KEY> [--interval 120] [--once]
 *
 * 注意：107 门户证书链缺中间证书，必须带 --use-system-ca；Cookie 从浏览器
 * DevTools 取，不写进任何文件。
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG = join(ROOT, 'data', 'cover', 'watch.log');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const COOKIE = arg('cookie', process.env.SCOW_COOKIE ?? '');
const API_KEY = arg('api-key', process.env.COVER_API_KEY ?? '');
const INTERVAL = Math.max(30, Number(arg('interval', '120')) | 0);
const ONCE = process.argv.includes('--once');
const KERNEL = arg('kernel', 'http://127.0.0.1:3080').replace(/\/+$/, '');
const PORTAL = 'https://107.ustc.edu.cn';
const USER = 'pb25071412';
const CLUSTER = 'training';
const JOB_NAME = 'sing';
const SERVICE_PORT = 8047;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, line + '\n');
  } catch { /* ignore */ }
}

function uiToken() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'secrets.json'), 'utf8')).uiToken ?? '';
  } catch {
    return '';
  }
}

async function jobs() {
  const url = `${PORTAL}/api/job/getRunningJobs?userId=${USER}&cluster=${CLUSTER}`;
  const r = await fetch(url, { headers: { cookie: COOKIE }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`作业 API HTTP ${r.status}（Cookie 可能过期，重新登录 107 后换 --cookie）`);
  const j = await r.json();
  return Array.isArray(j.results) ? j.results : [];
}

async function proxyGet(path, timeoutMs = 10000) {
  const r = await fetch(path, { headers: { cookie: COOKIE }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text().catch(() => '');
  return { status: r.status, text };
}

async function kernelPost(path, body) {
  const r = await fetch(`${KERNEL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': uiToken() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, text: await r.text().catch(() => '') };
}

async function wire(node) {
  const baseUrl = `${PORTAL}/api/proxy/${CLUSTER}/relative/${node}/${SERVICE_PORT}`;
  const health = await proxyGet(`${baseUrl}/health`).catch((e) => ({ status: 0, text: String(e) }));
  if (health.status !== 200) {
    log(`节点 ${node} 的翻唱 /health 还不通（${health.status} ${health.text.slice(0, 120)}），下轮再试`);
    return false;
  }
  const cfg = await kernelPost('/api/plugins/cover/config', {
    values: { baseUrl, ...(API_KEY ? { apiKey: API_KEY } : {}), cookie: COOKIE },
  });
  if (cfg.status !== 200) {
    log(`写 cover 插件配置失败：HTTP ${cfg.status} ${cfg.text.slice(0, 200)}`);
    return false;
  }
  await kernelPost('/api/plugins/cover/reload', {});
  log(`已接线 cover：${baseUrl}（health=${health.text.trim()}）`);
  return true;
}

async function unwire(reason) {
  const cfg = await kernelPost('/api/plugins/cover/config', { values: { baseUrl: '' } }).catch(() => null);
  log(`翻唱服务下线（${reason}），已清空 baseUrl${cfg && cfg.status !== 200 ? `（写配置失败 HTTP ${cfg.status}）` : ''}`);
}

async function tick(state) {
  const list = await jobs();
  const mine = list.find((j) => j.name === JOB_NAME && String(j.state).toUpperCase() === 'RUNNING' && j.nodes && j.nodes !== 'None');
  if (mine) {
    const node = String(mine.nodesOrReason || '').split(',')[0].trim();
    if (!/^[A-Za-z0-9._-]+$/.test(node)) {
      log(`作业 ${mine.jobId} 在跑但节点名看不懂（nodesOrReason=${JSON.stringify(mine.nodesOrReason)}），下轮再试`);
      return;
    }
    if (node !== state.node) {
      log(`发现作业 ${mine.jobId} 在 ${node} 上运行`);
      if (await wire(node)) state.node = node;
    }
  } else if (state.node) {
    await unwire('作业不再运行');
    state.node = '';
  }
}

async function main() {
  if (!COOKIE) {
    console.error('缺少 --cookie（浏览器登录 107 后从 DevTools 取 SCOW_USER=ustc-...）');
    process.exit(2);
  }
  log(`cover watcher 启动：间隔 ${INTERVAL}s，门户 ${PORTAL}，内核 ${KERNEL}${ONCE ? '，单次模式' : ''}`);
  if (!process.execArgv.includes('--use-system-ca')) {
    log('提示：107 门户的证书链缺中间证书，请用 node --use-system-ca 启动本脚本');
  }
  const state = { node: '' };
  for (;;) {
    try {
      await tick(state);
    } catch (e) {
      log(`轮询失败：${e.message}`);
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}

main().catch((e) => {
  log(`watcher 崩溃：${e.stack ?? e.message}`);
  process.exit(1);
});
