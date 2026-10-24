// B 站扫码登录拿 SESSDATA，验证后自动写进 bilibili 插件配置（2026-10-24）
// 用法：node scripts/bili-sessdata.mjs
//   1. 走 B 站官方网页版扫码登录（passport 二维码接口，不碰任何第三方）；
//   2. 从登录成功的 crossDomain 回调 URL 里解出 SESSDATA，用 nav 接口验证登录态并显示账号名；
//   3. POST /api/plugins/bilibili/config 写入插件（内核在线时自动热重载，设置页立刻回显）。
// 终端二维码显示不了就扫 data/bili-qr.png。写不进去（内核没跑）会把 SESSDATA 原文打出来，抄走手填。
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const QR_PNG = join(root, 'data', 'bili-qr.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, extraHeaders = {}) {
  const resp = await fetch(url, {
    headers: { ...BASE_HEADERS, ...extraHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** 从 crossDomain 回调 URL 的查询串里取登录 cookie（searchParams 已解码一次，正是 Cookie 里要的原文） */
function cookieOf(crossDomainUrl) {
  const q = new URL(crossDomainUrl).searchParams;
  const sessdata = (q.get('SESSDATA') ?? '').trim();
  if (!sessdata) throw new Error('登录成功但回调 URL 里没有 SESSDATA，B 站接口可能改版了。');
  return { sessdata, biliJct: q.get('bili_jct') ?? '', dedeUserId: q.get('DedeUserID') ?? '' };
}

/** 一轮扫码：出码 → 轮询到确认/过期；成功返回 data（含 url 与 refresh_token），过期返回 null */
async function loginOnce() {
  const gen = await getJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  if (gen.code !== 0 || !gen.data?.qrcode_key) throw new Error(`获取二维码失败：${gen.message ?? gen.code}`);
  const { qrcode_key: key, url } = gen.data;
  console.log('\n' + await QRCode.toString(url, { type: 'terminal', small: true }));
  await QRCode.toFile(QR_PNG, url, { width: 320, margin: 2 });
  console.log('用 B 站手机 App 扫上面的码（终端显示坏了就开 ' + QR_PNG + '），3 分钟内有效…');
  const started = Date.now();
  let saidScanned = false;
  while (Date.now() - started < QR_LIFETIME_MS) {
    await sleep(POLL_INTERVAL_MS);
    const r = await getJson(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}`);
    const code = r.data?.code ?? r.code;
    if (code === 0 && r.data?.url) return r.data;
    if (code === 86090 && !saidScanned) { console.log('已扫码，在手机上点「确认登录」。'); saidScanned = true; }
    if (code === 86038) { console.log('二维码过期，重新生成。'); return null; }
    // 86101 = 还没扫，安静等
  }
  console.log('等超时了，重新生成二维码。');
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

// ---- 出码，扫到为止（Ctrl-C 随时退） ----
let data = null;
while (!data) data = await loginOnce();
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
