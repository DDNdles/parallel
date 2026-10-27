#!/usr/bin/env node
/**
 * 107 半自动登录：打开真实登录页，人过一次验证码，脚本把会话 Cookie 抓回来写进配置。
 *
 * 为什么是半自动：验证码是 SVG 干扰图，视觉模型识图不可靠，失败重试有锁号风险；
 * 统一认证（CAS）又有 JS 挑战/风控。人工只剩「输一次验证码」这一步。
 *
 * 用法：
 *   node src/plugins/cover/scow-login.mjs              # 有头浏览器，人工登录（推荐）
 *   node src/plugins/cover/scow-login.mjs --headless   # 无头，靠 data/cover/scow-storage-state.json 续期
 *
 * 流程：Playwright 开平台登录页 → 人工完成登录（账号密码+验证码，或统一认证）
 *   → 检测到 SCOW_USER cookie 且作业 API 200 → 回写 secrets.json + 写进 cover 插件。
 * 不保存账号密码；浏览器会话只留在 data/cover/scow-storage-state.json（gitignored）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }

function readJson(p, def) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; }
}

const DATA_DIR = resolve(arg('data-dir', process.env.PARALLEL_DATA_DIR || join(ROOT, 'data')));
const KERNEL = arg('kernel', `http://127.0.0.1:${readJson(join(DATA_DIR, 'config.json'), {}).ui?.port ?? 3080}`)
  .replace(/\/+$/, '');
const HEADLESS = flag('headless');
const STORAGE = join(DATA_DIR, 'cover', 'scow-storage-state.json');
const STATUS = join(DATA_DIR, 'cover', 'login-status.json');
const LOGIN_URL = 'https://107.ustc.edu.cn/auth/public/scowAuth?callbackUrl='
  + encodeURIComponent('http://107.ustc.edu.cn/api/auth/callback');
const TIMEOUT_MIN = Number(arg('timeout', '5')) || 5;

const log = (m) => console.log(`[scow-login] ${m}`);

/** 桌面页靠这个文件显示「等待浏览器登录/成功/失败」 */
function writeStatus(status, error = '') {
  try {
    mkdirSync(dirname(STATUS), { recursive: true });
    const next = { status, ts: Date.now(), ...(error ? { error } : {}) };
    const tmp = `${STATUS}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, STATUS);
  } catch { /* 状态写不下不影响登录 */ }
}

/** 原子写 secrets.json：只动 cover.cookie，别的字段和别的插件密钥原样保留 */
function saveCookie(cookie) {
  const p = join(DATA_DIR, 'secrets.json');
  const s = readJson(p, {});
  const pluginSecrets = { ...(s.pluginSecrets ?? {}) };
  pluginSecrets.cover = { ...(pluginSecrets.cover ?? {}), cookie };
  const next = { ...s, pluginSecrets };
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, p);
}

async function pushToKernel(cookie) {
  try {
    const token = readJson(join(DATA_DIR, 'secrets.json'), {}).uiToken ?? '';
    const r = await fetch(`${KERNEL}/api/plugins/cover/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-auth-token': token } : {}) },
      body: JSON.stringify({ values: { cookie } }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) { log('新 Cookie 已写进 cover 插件（热生效）'); return; }
    log(`写插件配置失败 HTTP ${r.status}：请在「插件 → 翻唱」里手动粘贴 Cookie`);
  } catch (e) {
    log(`连不上内核（${e.message}）：Cookie 已存 secrets.json，下次内核启动自动带上`);
  }
}

async function launch(chromium) {
  // 用系统已装的 Edge/Chrome，避免再下 100MB Chromium
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel, headless: HEADLESS }); } catch { /* 试下一个 */ }
  }
  try { return await chromium.launch({ headless: HEADLESS }); } catch (e) {
    log(`找不到可用浏览器（${e.message}）：装 Chrome/Edge，或 npx playwright install chromium`);
    return null;
  }
}

async function main() {
  writeStatus('running');
  let pw;
  try { pw = await import('playwright-core'); } catch {
    log('没有 playwright-core：先 npm i playwright-core（用系统 Edge/Chrome 即可，不用下浏览器）');
    writeStatus('failed', '没有 playwright-core，先在项目里 npm i playwright-core');
    process.exit(2);
  }
  const browser = await launch(pw.chromium);
  if (!browser) { writeStatus('failed', '找不到 Chrome/Edge，请安装后再试'); process.exit(2); }

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    ...(existsSync(STORAGE) ? { storageState: STORAGE } : {}),
  });
  const page = await ctx.newPage();

  log(`打开登录页${HEADLESS ? '（无头）' : '，请在浏览器里完成登录（账号密码 + 验证码，或统一认证）'}…`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let cookie = '';
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://107.ustc.edu.cn');
    const found = cookies.find((c) => c.name === 'SCOW_USER');
    if (found) {
      const candidate = `SCOW_USER=${found.value}`;
      try {
        const r = await fetch('https://107.ustc.edu.cn/api/job/getRunningJobs?userId=pb25071412&cluster=training', {
          headers: { cookie: candidate }, signal: AbortSignal.timeout(15000),
        });
        if (r.ok) { cookie = candidate; log(`登录成功，作业 API HTTP ${r.status}`); break; }
        log(`已拿到 Cookie 但作业 API 回 HTTP ${r.status}，等浏览器里继续操作…`);
      } catch (e) {
        log(`作业 API 探活失败（${e.message}），等下一轮…`);
      }
    }
    await new Promise((x) => setTimeout(x, 2000));
  }

  // 先存会话状态，再关浏览器
  try {
    mkdirSync(dirname(STORAGE), { recursive: true });
    await ctx.storageState({ path: STORAGE });
  } catch { /* 存不下不影响本次 Cookie */ }
  await browser.close();

  if (!cookie) {
    log(`${TIMEOUT_MIN} 分钟内没等到有效登录，退出（未改任何配置）`);
    writeStatus('failed', `${TIMEOUT_MIN} 分钟内没等到有效登录（浏览器可能被关掉了），再点一次`);
    process.exit(1);
  }
  saveCookie(cookie);
  log('新 Cookie 已写入 data/secrets.json');
  await pushToKernel(cookie);
  writeStatus('done');
  log('完成');
}

main().catch((e) => {
  log(`失败：${e.stack ?? e.message}`);
  writeStatus('failed', String(e.message ?? e).slice(0, 300));
  process.exit(1);
});
