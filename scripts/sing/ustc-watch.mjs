#!/usr/bin/env node
/**
 * 107 唱歌服务自动接线（不依赖 SSH）：
 *   轮询 SCOW 的作业 API（会话 Cookie 鉴权）→ 发现 sing 作业 RUNNING 时拿到计算节点名 →
 *   经 SCOW 代理探活 /health → 把 provider=custom / baseUrl=代理地址 / apiKey / cookie
 *   写进内核唱歌插件配置（内核会顺带热重载插件）；作业结束则清空 baseUrl 播报下线。
 *
 * 为什么这么做：107 平台没有开放 SSH（官方文档口径），计算节点无公网入口；
 * 唯一能让本机 bot 打到计算节点的通道是 SCOW 门户的通用代理
 *   https://107.ustc.edu.cn/api/proxy/training/relative/<节点>/<端口>/<path>
 * 它只认浏览器登录后的 Cookie（SCOW_USER=ustc-...）。
 *
 * 用法：
 *   node scripts/sing/ustc-watch.mjs --cookie "SCOW_USER=ustc-..." [--api-key <SING_API_KEY>]
 *        [--interval 120] [--once] [--kernel http://127.0.0.1:3080]
 *   不带 --once 时循环；Ctrl+C 退出。
 *
 * 凭据来源：cookie 必须由人从浏览器里取（登录 107 → DevTools → Cookie: SCOW_USER）；
 * 内核 uiToken 自动从 data/secrets.json 读。两者都不写进任何文件。
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG = join(ROOT, 'data', 'sing', 'watch.log');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const COOKIE = arg('cookie', process.env.SCOW_COOKIE ?? '');
const API_KEY = arg('api-key', process.env.SING_API_KEY ?? '');
const INTERVAL = Math.max(30, Number(arg('interval', '120')) | 0);
const ONCE = process.argv.includes('--once');
const KERNEL = arg('kernel', 'http://127.0.0.1:3080').replace(/\/+$/, '');
const PORTAL = 'https://107.ustc.edu.cn';
const USER = 'pb25071412';
const CLUSTER = 'training';
const JOB_NAME = 'sing';
const SERVICE_PORT = 8046;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, line + '\n');
  } catch { /* 日志写不进去不影响主流程 */ }
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

async function proxyGet(path, timeoutMs = 8000) {
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

/** 把插件配置写成指向某个节点（baseUrl 变了才写） */
async function wire(node) {
  const baseUrl = `${PORTAL}/api/proxy/${CLUSTER}/relative/${node}/${SERVICE_PORT}`;
  const health = await proxyGet(`${baseUrl}/health`).catch((e) => ({ status: 0, text: String(e) }));
  if (health.status !== 200) {
    log(`节点 ${node} 的 /health 还不通（${health.status} ${health.text.slice(0, 120)}），下轮再试`);
    return false;
  }
  const cfg = await kernelPost('/api/plugins/sing/config', {
    values: { provider: 'custom', baseUrl, ...(API_KEY ? { apiKey: API_KEY } : {}), cookie: COOKIE },
  });
  if (cfg.status !== 200) {
    log(`写插件配置失败：HTTP ${cfg.status} ${cfg.text.slice(0, 200)}`);
    return false;
  }
  await kernelPost('/api/plugins/sing/reload', {});
  log(`已接线：${baseUrl}/generate（health=${health.text.trim()}）`);
  return true;
}

/** 作业没了：把 baseUrl 清空，插件退化成「没配置」而不是打到一个死地址 */
async function unwire(reason) {
  const cfg = await kernelPost('/api/plugins/sing/config', { values: { baseUrl: '' } }).catch(() => null);
  log(`服务下线（${reason}），已清空 baseUrl${cfg && cfg.status !== 200 ? `（写配置失败 HTTP ${cfg.status}）` : ''}`);
}

async function tick(state) {
  const list = await jobs();
  const mine = list.find((j) => j.name === JOB_NAME && String(j.state).toUpperCase() === 'RUNNING' && j.nodes && j.nodes !== 'None');
  if (mine) {
    const node = String(mine.nodes).split(',')[0].trim();
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
  log(`watcher 启动：间隔 ${INTERVAL}s，门户 ${PORTAL}，内核 ${KERNEL}${ONCE ? '，单次模式' : ''}`);
  if (!process.execArgv.includes('--use-system-ca')) {
    log('提示：107 门户的证书链缺中间证书，Node 自带 CA 会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE；请用 node --use-system-ca 启动本脚本');
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
