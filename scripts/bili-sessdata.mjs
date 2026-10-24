// B 站扫码登录拿 SESSDATA，验证后自动写进 bilibili 插件配置（2026-10-24）
// 用法：node scripts/bili-sessdata.mjs [--qr]
//   1. 走 B 站官方网页版扫码登录（passport 二维码接口，不碰任何第三方）；
//   2. 默认在**默认浏览器**里打开确认页——浏览器里已登录 B 站的话，点一下「确认登录」即可；
//      同时在终端出二维码（+ data/bili-qr.png），想用手机 App 扫也行；--qr = 不弹浏览器只出码；
//   3. 从登录成功的 crossDomain 回调 URL 里解出 SESSDATA，用 nav 接口验证登录态并显示账号名；
//   4. POST /api/plugins/bilibili/config 写入插件（内核在线时自动热重载，设置页立刻回显）。
// 码过期自动换码并重开浏览器（B 站二维码约 3 分钟有效）；总计 15 分钟没确认就退出。
// 写不进去（内核没跑）会把 SESSDATA 原文打出来，抄走手填。
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_HEADERS = {
  'user-agent': UA,
  'referer': 'https://www.bilibili.com/',
  'accept': 'application/json, text/plain, */*',
};
const POLL_INTERVAL_MS = 2000;
/** B 站二维码有效期约 3 分钟，宁可提前几秒重新生成 */
const QR_LIFETIME_MS = 170_000;
/** 总时长上限：到点没确认就收摊，别无限弹标签页 */
const TOTAL_TIMEOUT_MS = 15 * 60_000;
const QR_PNG = join(root, 'data', 'bili-qr.png');
const phoneOnly = process.argv.includes('--qr');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, extraHeaders = {}) {
  const resp = await fetch(url, {
    headers: { ...BASE_HEADERS, ...extraHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** 用系统默认浏览器打开确认页 */
function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 从 crossDomain 回调 URL 的查询串里取登录 cookie（searchParams 已解码一次，正是 Cookie 里要的原文） */
function cookieOf(crossDomainUrl) {
  const q = new URL(crossDomainUrl).searchParams;
  const sessdata = (q.get('SESSDATA') ?? '').trim();
  if (!sessdata) throw new Error('登录成功但回调 URL 里没有 SESSDATA，B 站接口可能改版了。');
  return { sessdata, biliJct: q.get('bili_jct') ?? '', dedeUserId: q.get('DedeUserID') ?? '' };
}

/** 一轮扫码：出码（浏览器确认页 + 二维码兜底）→ 轮询到确认/过期；成功返回 data，过期返回 null */
async function loginOnce() {
  const gen = await getJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  if (gen.code !== 0 || !gen.data?.qrcode_key) throw new Error(`获取二维码失败：${gen.message ?? gen.code}`);
  const { qrcode_key: key, url } = gen.data;
  console.log('\n' + await QRCode.toString(url, { type: 'terminal', small: true }));
  await QRCode.toFile(QR_PNG, url, { width: 320, margin: 2 });
  console.log(`确认地址（手动粘到登录过 B 站的浏览器也行）：\n  ${url}`);
  if (phoneOnly) {
    console.log(`用手机 B 站 App 扫上面的码（终端显示坏了就开 ${QR_PNG}）。`);
  } else if (openInBrowser(url)) {
    console.log('已在默认浏览器打开确认页：已登录 B 站的话点「确认登录」即可；打开的浏览器没登录，就把上面的地址粘到登录过的那个浏览器，或用手机扫上面的码。');
  } else {
    console.log(`自动打开浏览器失败：把上面的地址粘到登录过 B 站的浏览器，或用手机 App 扫码（图在 ${QR_PNG}）。`);
  }
  const started = Date.now();
  let saidScanned = false;
  while (Date.now() - started < QR_LIFETIME_MS) {
    await sleep(POLL_INTERVAL_MS);
    const r = await getJson(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}`);
    const code = r.data?.code ?? r.code;
    if (code === 0 && r.data?.url) return r.data;
    if (code === 86090 && !saidScanned) { console.log('已扫码/已打开确认页，等你点「确认登录」。'); saidScanned = true; }
    if (code === 86038) { console.log('二维码过期，重新生成。'); return null; }
    // 86101 = 还没扫，安静等
  }
  console.log('这枚码到时间了，重新生成。');
  return null;
}

function kernelBase() {
  const { uiToken } = JSON.parse(readFileSync(join(root, 'data', 'secrets.json'), 'utf-8'));
  const cfg = JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf-8'));
  return { base: `http://127.0.0.1:${cfg.ui?.port ?? 3080}`, uiToken };
}

async function writeConfig(base, uiToken, sessdata) {
  const resp = await fetch(`${base}/api/plugins/bilibili/config`, {
    method: 'POST',
    headers: { 'x-auth-token': uiToken, 'content-type': 'application/json' },
    body: JSON.stringify({ values: { sessdata } }),
    signal: AbortSignal.timeout(15_000),
  });
  const r = await resp.json().catch(() => ({ ok: false }));
  if (!resp.ok || r.error) throw new Error(r.error ?? `HTTP ${resp.status}`);
}

const cleanupPng = () => { try { if (existsSync(QR_PNG)) unlinkSync(QR_PNG); } catch { /* 留着也无妨 */ } };
process.on('SIGINT', () => { cleanupPng(); process.exit(130); });

// ---- 出码，确认到为止（过期自动换码重开浏览器；Ctrl-C 随时退） ----
let data = null;
const deadline = Date.now() + TOTAL_TIMEOUT_MS;
while (!data) {
  if (Date.now() > deadline) { cleanupPng(); console.error('15 分钟没确认，收摊了；想继续就重跑一次。'); process.exit(1); }
  data = await loginOnce();
}
cleanupPng();

const { sessdata, dedeUserId } = cookieOf(data.url);

// ---- 验证登录态，顺便认一下是哪个号 ----
const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', { cookie: `SESSDATA=${sessdata}` });
if (!nav.data?.isLogin) throw new Error(`SESSDATA 验证失败（nav isLogin=false，code=${nav.code}），不写入。`);
console.log(`\n登录成功：${nav.data.uname}（mid ${nav.data.mid}${dedeUserId && dedeUserId !== String(nav.data.mid) ? `，回调 DedeUserID=${dedeUserId}` : ''}）`);

// ---- 写进 bilibili 插件配置（写入即热重载） ----
try {
  const { base, uiToken } = kernelBase();
  await writeConfig(base, uiToken, sessdata);
  const back = await (await fetch(`${base}/api/plugins/bilibili/config`, { headers: { 'x-auth-token': uiToken } })).json();
  const stored = String(back?.values?.sessdata ?? '');
  if (!stored) throw new Error('读回为空');
  console.log(`已写入插件配置（设置 → b站搜索 → SESSDATA 已回显）：${stored.slice(0, 6)}…${stored.slice(-4)}`);
} catch (e) {
  console.error(`写入失败（${e.message}）——SESSDATA 原文在下面，可去设置页手填：`);
  console.log(sessdata);
  process.exit(1);
}
