#!/usr/bin/env node
/**
 * 107 翻唱服务守护进程（supervisor）：
 *   轮询 SCOW 作业 API
 *   ├─ 有 cover/sing 作业 RUNNING → 经 SCOW 代理探活 8047/health → 把 baseUrl/apiKey/cookie
 *   │  写进内核 cover 插件（服务起来前不写；作业换节点会自动改地址）
 *   ├─ 没有作业在跑且「自动接线」打开 → 用 /api/job/submitJob 自动提交 cover 作业
 *   ├─ 有作业在排队 → 只记日志，不重复提交
 *   └─ 作业结束 → 清空由本进程接上的 baseUrl
 *
 * 用法：
 *   node --use-system-ca scripts/cover/ustc-watch.mjs            # 常驻（内核自动拉起时也用这个）
 *   node --use-system-ca scripts/cover/ustc-watch.mjs --once     # 只跑一轮，排障用
 *   node --use-system-ca scripts/cover/ustc-watch.mjs --once --dry-run   # 只打印计划，不改任何东西
 *
 * 凭据默认从 data/secrets.json 的 pluginSecrets.cover 读（cookie/apiKey），
 * 也可以用 --cookie / --api-key / 环境变量 SCOW_COOKIE、COVER_API_KEY 覆盖。
 * Cookie 是 107 的登录会话；过期后只能重新登录再更新（登录页有验证码，没法自动续）。
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER, PORTAL, REMOTE_ROOT, USER,
  buildSubmitBody, findPendingJob, findRunningJob, isManagedBaseUrl, jobNode, maskSecret, proxyBaseUrl, shouldSubmit,
} from './supervisor-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** 数据目录：内核会显式传 --data-dir（支持 --data-dir 启动的实例）；手动跑默认 ./data */
const DATA_DIR = join(arg('data-dir', process.env.PARALLEL_DATA_DIR || join(ROOT, 'data')));
const DATA = join(DATA_DIR, 'cover');
const LOG = join(DATA, 'watch.log');
const STATE = join(DATA, 'supervisor-state.json');
const PID = join(DATA, 'supervisor.pid');
const BEAT = join(DATA, 'supervisor.beat');

function readSecrets() {
  try {
    const s = JSON.parse(readFileSync(join(DATA_DIR, 'secrets.json'), 'utf8'));
    return { uiToken: s.uiToken ?? '', ...(s.pluginSecrets?.cover ?? {}) };
  } catch {
    return { uiToken: '' };
  }
}
/** 命令行/环境变量显式给的凭据优先，且不再从 secrets.json 刷新它们 */
const COOKIE_ARG = arg('cookie', process.env.SCOW_COOKIE || '');
const API_ARG = arg('api-key', process.env.COVER_API_KEY || '');
let COOKIE = COOKIE_ARG;
let API_KEY = API_ARG;
let UI_TOKEN = '';
/**
 * 每轮开头重读 secrets.json：107 登录回写后必须立刻换新 Cookie，
 * 否则本进程会一直用旧 Cookie（作业 API 401），而且 wire() 发现插件里是新值
 * 还会把旧值写回去——既毁掉新登录，又触发插件 reload 杀掉在跑的任务。
 */
function refreshSecrets() {
  const s = readSecrets();
  if (s.uiToken) UI_TOKEN = s.uiToken;
  let changed = false;
  if (!COOKIE_ARG && s.cookie && s.cookie !== COOKIE) { COOKIE = s.cookie; changed = true; }
  if (!API_ARG && s.apiKey && s.apiKey !== API_KEY) { API_KEY = s.apiKey; changed = true; }
  if (changed) log('已读取 secrets.json 里的新凭据（107 登录回写），本轮起生效');
}
const KERNEL = arg('kernel', 'http://127.0.0.1:3080').replace(/\/+$/, '');
const ROOT_REMOTE = arg('root', REMOTE_ROOT);
const INTERVAL = Math.max(30, Number(arg('interval', '120')) | 0);
const ONCE = flag('once');
const DRY = flag('dry-run');
/** 手动排障时强制允许自动提交（平时只看插件里的 autoStart 开关） */
const FORCE_SUBMIT = flag('submit');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(DATA, { recursive: true });
    appendFileSync(LOG, line + '\n');
  } catch {
    try { mkdirSync(DATA, { recursive: true }); writeFileSync(LOG, line + '\n'); } catch { /* ignore */ }
  }
}

/** 同一原因的日志别每轮都刷：默认 30 分钟一条 */
const lastNote = new Map();
function note(key, msg, everyMs = 30 * 60 * 1000) {
  const now = Date.now();
  if (now - (lastNote.get(key) ?? 0) < everyMs) return;
  lastNote.set(key, now);
  log(msg);
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  try {
    mkdirSync(DATA, { recursive: true });
    const next = { ...readState(), ...patch };
    const tmp = `${STATE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, STATE);
  } catch { /* 状态只用于冷却，写不进去就重启后多试一次，不算错 */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 心跳：内核靠它判断「已经有一个 supervisor 在跑」（也能认出内核硬重启后留下的孤儿） */
function beat() {
  try { mkdirSync(DATA, { recursive: true }); writeFileSync(BEAT, String(Date.now())); } catch { /* ignore */ }
}

/** 常驻模式防止内核重复拉起；--once 是排障入口，不抢锁 */
if (!ONCE) {
  try {
    const old = Number(readFileSync(PID, 'utf8').trim());
    if (old && old !== process.pid && pidAlive(old)) {
      log(`已有 supervisor 在跑（pid ${old}），本进程退出`);
      process.exit(0);
    }
  } catch { /* 没锁文件 */ }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(PID, String(process.pid));
  beat();
  const clearPid = () => {
    try { if (readFileSync(PID, 'utf8').trim() === String(process.pid)) unlinkSync(PID); } catch { /* ignore */ }
    try { unlinkSync(BEAT); } catch { /* ignore */ }
  };
  process.on('exit', clearPid);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

async function kernelGet(path, timeoutMs = 10000) {
  const r = await fetch(`${KERNEL}${path}`, {
    headers: UI_TOKEN ? { 'x-auth-token': UI_TOKEN } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text().catch(() => '');
  return { status: r.status, text };
}

async function kernelPost(path, body) {
  const r = await fetch(`${KERNEL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(UI_TOKEN ? { 'x-auth-token': UI_TOKEN } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, text: await r.text().catch(() => '') };
}

/** 插件配置（含 secret 回显）；插件不存在/内核没起来时当空配置 */
async function pluginConfig() {
  const r = await kernelGet('/api/plugins/cover/config');
  if (r.status !== 200) return { values: {}, ok: false };
  try { return { values: JSON.parse(r.text)?.values ?? {}, ok: true }; } catch { return { values: {}, ok: false }; }
}

async function jobs() {
  const url = `${PORTAL}/api/job/getRunningJobs?userId=${USER}&cluster=${CLUSTER}`;
  let r;
  try {
    r = await fetch(url, { headers: { cookie: COOKIE }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return { ok: false, list: [], error: `作业 API 连不上：${e.message}` };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, list: [], error: `作业 API HTTP ${r.status}（Cookie 过期，重新登录 107 后更新插件 Cookie）` };
  }
  if (!r.ok) return { ok: false, list: [], error: `作业 API HTTP ${r.status}` };
  try {
    const j = await r.json();
    return { ok: true, list: Array.isArray(j.results) ? j.results : [] };
  } catch {
    return { ok: false, list: [], error: '作业 API 回来的不是 JSON' };
  }
}

async function proxyGet(url, timeoutMs = 10000) {
  const r = await fetch(url, { headers: { cookie: COOKIE }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text().catch(() => '');
  return { status: r.status, text };
}

async function wire(node, cur) {
  const baseUrl = proxyBaseUrl(node);
  const health = await proxyGet(`${baseUrl}/health`).catch((e) => ({ status: 0, text: String(e) }));
  let healthy = health.status === 200;
  if (healthy) {
    // 别把旧的 sing 服务当成 cover 接上去；/health 必须自报 service=cover 且 ok=true
    try {
      const h = JSON.parse(health.text);
      if (h?.service !== 'cover' || h?.ok === false) healthy = false;
    } catch { healthy = false; }
  }
  if (!healthy) {
    note(`health:${node}`, `作业在 ${node} 上，但翻唱 /health 还不通（${health.status} ${health.text.slice(0, 120)}），下轮再试`, 10 * 60 * 1000);
    return false;
  }
  const need = cur.baseUrl !== baseUrl || (!!API_KEY && cur.apiKey !== API_KEY) || (!!COOKIE && cur.cookie !== COOKIE);
  if (!need) {
    note('wired', `已接线 cover：${baseUrl}（health=${health.text.trim()}）`, 6 * 60 * 60 * 1000);
    return true;
  }
  if (DRY) {
    log(`[dry-run] 将接线 cover：${baseUrl}（health=${health.text.trim()}）`);
    return false;
  }
  const cfg = await kernelPost('/api/plugins/cover/config', {
    values: { baseUrl, ...(API_KEY ? { apiKey: API_KEY } : {}), ...(COOKIE ? { cookie: COOKIE } : {}) },
  });
  if (cfg.status !== 200) {
    log(`写 cover 插件配置失败：HTTP ${cfg.status} ${cfg.text.slice(0, 200)}`);
    return false;
  }
  log(`已接线 cover：${baseUrl}（health=${health.text.trim()}）`);
  return true;
}

async function unwire(cur) {
  if (!isManagedBaseUrl(cur.baseUrl)) return; // 自己手填的地址不归守护进程管
  if (DRY) { log(`[dry-run] 将清空 baseUrl（原 ${cur.baseUrl}）`); return; }
  const cfg = await kernelPost('/api/plugins/cover/config', { values: { baseUrl: '' } }).catch(() => null);
  log(`翻唱服务下线（作业不再运行），已清空 baseUrl${cfg && cfg.status !== 200 ? `（写配置失败 HTTP ${cfg.status}）` : ''}`);
}

async function submit(now) {
  const body = buildSubmitBody({ root: ROOT_REMOTE, apiKey: API_KEY });
  if (DRY) {
    const shown = { ...body, command: maskSecret(body.command, API_KEY) };
    log(`[dry-run] 将提交作业：${JSON.stringify(shown)}`);
    return { ok: false, dry: true };
  }
  let r;
  try {
    r = await fetch(`${PORTAL}/api/job/submitJob`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    log(`提交作业失败：${maskSecret(e.message, API_KEY)}`);
    saveState({ lastFailedAt: now });
    return { ok: false };
  }
  const text = await r.text().catch(() => '');
  if (!r.ok) {
    log(`提交作业失败：HTTP ${r.status} ${maskSecret(text.slice(0, 400), API_KEY)}`);
    saveState({ lastFailedAt: now });
    return { ok: false };
  }
  let jobId = '';
  try { jobId = String(JSON.parse(text)?.jobId ?? ''); } catch { /* 回包不是 JSON 也照样记原文 */ }
  log(`已自动提交 cover 作业${jobId ? ` ${jobId}` : ''}（排队/启动情况看下一轮）`);
  saveState({ lastSubmitAt: now, lastFailedAt: 0 });
  return { ok: true };
}

async function tick() {
  refreshSecrets(); // 107 登录回写后立刻改用新 Cookie（见 refreshSecrets 注释）
  const now = Date.now();
  const st = readState();
  const cfg = await pluginConfig();
  const cur = cfg.values;
  // 用户自己填了非 SCOW 代理地址（自部署）：这套守护进程不接管，免得把地址改掉
  if (cur.baseUrl && !isManagedBaseUrl(cur.baseUrl)) {
    note('self-hosted', 'baseUrl 是自部署地址，107 守护进程不接管（要停掉本进程可关闭「自动接线」）', 6 * 60 * 60 * 1000);
    return { cookieOk: true };
  }
  const list = await jobs();

  if (!list.ok) {
    note('jobs-fail', list.error, 15 * 60 * 1000);
    if (cur.baseUrl && isManagedBaseUrl(cur.baseUrl)) {
      const health = await proxyGet(`${cur.baseUrl.replace(/\/+$/, '')}/health`).catch(() => ({ status: 0 }));
      if (health.status !== 200) note('stale-base', '107 作业状态拉不到，代理地址也探不通；先保持现状，等 Cookie 更新', 30 * 60 * 1000);
    }
    return { cookieOk: !/Cookie 过期/.test(list.error || '') };
  }

  const running = findRunningJob(list.list);
  if (running) {
    const node = jobNode(running);
    if (!/^[A-Za-z0-9._-]+$/.test(node)) {
      note('bad-node', `作业 ${running.jobId} 在跑但节点名看不懂（nodesOrReason=${JSON.stringify(running.nodesOrReason)}），下轮再试`, 10 * 60 * 1000);
      return { cookieOk: true, running: true };
    }
    note('found', `发现作业 ${running.jobId} 在 ${node} 上运行`, 6 * 60 * 60 * 1000);
    await wire(node, cur);
    return { cookieOk: true, running: true };
  }

  // 没有 RUNNING：把之前接上的地址撤掉（作业可能刚结束，也可能换节点重排）
  await unwire(cur);

  const pending = findPendingJob(list.list);
  if (pending) {
    note('pending', `作业 ${pending.jobId} 在排队（${pending.state}${pending.nodesOrReason ? `，${pending.nodesOrReason}` : ''}），等它跑起来`, 30 * 60 * 1000);
    return { cookieOk: true, pending: true };
  }

  const plan = shouldSubmit({
    autoStart: FORCE_SUBMIT || cur.autoStart === true,
    cookieOk: true,
    jobs: list.list,
    now,
    lastSubmitAt: st.lastSubmitAt ?? 0,
    lastFailedAt: st.lastFailedAt ?? 0,
  });
  if (!plan.submit) {
    note('idle', `没有作业在跑；不自动提交（${plan.reason}）`, 60 * 60 * 1000);
    return { cookieOk: true, submitted: false };
  }
  log(`没有作业在跑，自动提交（${plan.reason}）`);
  await submit(now);
  return { cookieOk: true, submitted: true };
}

async function main() {
  refreshSecrets();
  if (!COOKIE) {
    console.error('缺少 Cookie：请在「插件 → 翻唱」里填 SCOW Cookie，或 --cookie "SCOW_USER=ustc-..."');
    process.exit(2);
  }
  log(`cover supervisor 启动：间隔 ${INTERVAL}s，门户 ${PORTAL}，内核 ${KERNEL}${ONCE ? '，单次' : ''}${DRY ? '，dry-run' : ''}`);
  if (!process.execArgv.includes('--use-system-ca')) {
    log('提示：107 门户的证书链缺中间证书，请用 node --use-system-ca 启动本脚本');
  }
  let kernelFails = 0;
  for (;;) {
    try {
      const r = await tick();
      kernelFails = 0;
      if (!r.cookieOk) note('cookie-bad', 'Cookie 已失效：去浏览器重新登录 107，再把新 Cookie 填进插件', 60 * 60 * 1000);
    } catch (e) {
      // 内核 API 不通 ≠ 107 出问题：连续 5 轮（约 10 分钟）都不通才认为内核没了，自己退出等下次启动
      kernelFails++;
      log(`本轮失败（${kernelFails}/5）：${maskSecret(e.message, API_KEY)}`);
      if (kernelFails >= 5) {
        log('内核连续 5 轮不可达，supervisor 退出');
        process.exit(0);
      }
    }
    if (ONCE) return;
    beat();
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}

main().catch((e) => {
  log(`supervisor 崩溃：${maskSecret(e.stack ?? e.message, API_KEY)}`);
  process.exit(1);
});
