#!/usr/bin/env node
/**
 * 频率模式调参：只允许改「设置页 → 拟人化」上显示的数值/下拉项，开关与触发方式一律不许动。
 *
 *   node scripts/tune-humanlike.mjs --show
 *   node scripts/tune-humanlike.mjs --set timing.pendingThreshold=14 --set merge.windowMs=1500 --reason "12 条一开口太机械"
 *   node scripts/tune-humanlike.mjs --dry-run --set interrupt.probability=0.1
 *
 * 写入走 POST /api/config（服务端还有一层白名单与范围钳制），成功后追加到
 * data/experiments/frequency-mode/changes.jsonl。
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'data', 'config.json');
const SECRETS = join(ROOT, 'data', 'secrets.json');
const EXP_DIR = join(ROOT, 'data', 'experiments', 'frequency-mode');
const BASE = 'http://127.0.0.1:3080';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const sets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') sets.push(args[++i]);
}
const reason = String(val('--reason') ?? '').slice(0, 500);
const dry = has('--dry-run');
const show = has('--show');

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return d; } };
const token = readJson(SECRETS, {}).uiToken;
if (!token) { console.error('data/secrets.json 里没有 uiToken'); process.exit(2); }

/**
 * 前端「拟人化」页真实存在的非开关项。
 * 开关（enable、inevitableAtReply、mentionedBotReply、focusMode、typingEnabled、splitReplyMessages…）
 * 与触发方式 replyTriggerMode 不在表里：实验期间不许动。
 */
const ALLOWED = {
  'timing.pendingThreshold': { min: 1, max: 100, int: true },
  'timing.talkValue': { min: 0, max: 1 },
  'timing.privateTalkValue': { min: 0, max: 1 },
  'timing.necessityThreshold': { min: 0, max: 200, int: true },
  'outgoing.replyMaxCharacters': { min: 20, max: 2000, int: true },
  'outgoing.maxReplyTokens': { min: 0, max: 8000, int: true },
  'outgoing.bubbleSoftMaxCharacters': { min: 10, max: 80, int: true },
  'outgoing.maxMessageCharacters': { min: 1, max: 12000, int: true },
  'merge.windowMs': { min: 0, max: 60000, int: true },
  'merge.maxWaitMs': { min: 0, max: 300000, int: true },
  'merge.bufferTtlMs': { min: 0, max: 3600000, int: true },
  'merge.fireDelayMinMs': { min: 0, max: 10000, int: true },
  'merge.fireDelayMaxMs': { min: 0, max: 10000, int: true },
  'backoff.baseSeconds': { min: 0, max: 600, int: true },
  'backoff.capSeconds': { min: 0, max: 3600, int: true },
  'backoff.startCount': { min: 1, max: 50, int: true },
  'backoff.bypassPendingCount': { min: 0, max: 200, int: true },
  'interrupt.probability': { min: 0, max: 1 },
  'proactive.idleSeconds': { min: 60, max: 86400, int: true },
  'poke.minIntervalSeconds': { min: 0, max: 3600, int: true },
  'poke.maxPerHour': { min: 0, max: 120, int: true },
  'repetition.windowMessages': { min: 5, max: 100, int: true },
  'repetition.minMessages': { min: 2, max: 10, int: true },
  'repetition.cooldownMinutes': { min: 5, max: 240, int: true },
  'rhythm.historyLimit': { min: 5, max: 20, int: true },
  'rhythm.collapseMinSamples': { min: 3, max: 10, int: true },
  'rhythm.exhaustLimit': { min: 3, max: 12, int: true },
  'rhythm.mode': { options: ['gentle', 'balanced', 'aggressive'] },
  'agency.minimumProactiveIntervalMinutes': { min: 0, max: 1440, int: true },
  'agency.maxWindowMinutes': { min: 5, max: 1440, int: true },
  'agency.quietHours': { text: true, pattern: /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$|^$/ },
};

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] && typeof cur[parts[i]] === 'object' ? cur[parts[i]] : {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

if (show || !sets.length) {
  const cfg = readJson(CONFIG, {}).humanlike ?? {};
  const view = {};
  for (const key of Object.keys(ALLOWED)) view[key] = getPath(cfg, key);
  console.log(JSON.stringify({ mode: cfg.timing?.replyTriggerMode, params: view }, null, 2));
  if (!sets.length) process.exit(0);
}

const patch = {};
const changes = [];
for (const pair of sets) {
  const eq = String(pair).indexOf('=');
  if (eq < 0) { console.error(`--set 需要 key=value：${pair}`); process.exit(2); }
  const key = pair.slice(0, eq).trim();
  const raw = pair.slice(eq + 1).trim();
  const spec = ALLOWED[key];
  if (!spec) {
    console.error(`不允许改 ${key}：只允许设置页上显示的数值/下拉项，开关与触发方式不在白名单`);
    process.exit(2);
  }
  let v;
  if (spec.text) {
    v = raw;
    if (spec.pattern && !spec.pattern.test(v)) { console.error(`${key} 格式不对：${v}`); process.exit(2); }
  } else if (spec.options) {
    if (!spec.options.includes(raw)) { console.error(`${key} 只能是 ${spec.options.join('/')}`); process.exit(2); }
    v = raw;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n)) { console.error(`${key} 需要数字：${raw}`); process.exit(2); }
    if (n < spec.min || n > spec.max) { console.error(`${key} 超出范围 ${spec.min}~${spec.max}：${n}`); process.exit(2); }
    v = spec.int ? Math.round(n) : n;
  }
  setPath(patch, key, v);
  changes.push({ key, from: getPath(readJson(CONFIG, {}).humanlike ?? {}, key), to: v });
}

if (dry) {
  console.log(JSON.stringify({ dryRun: true, patch, changes, reason }, null, 2));
  process.exit(0);
}

const before = JSON.stringify(changes);
const res = await fetch(`${BASE}/api/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Auth-Token': String(token) },
  body: JSON.stringify({ humanlike: patch }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body?.error) {
  console.error(`保存失败（${res.status}）：${body?.error ?? JSON.stringify(body)}`);
  process.exit(1);
}

// 用 GET /api/config 复核落盘值（不是把请求回显当成结果）
const after = await (await fetch(`${BASE}/api/config`, { headers: { 'X-Auth-Token': String(token) } })).json();
const actual = {};
for (const c of changes) actual[c.key] = getPath(after?.humanlike ?? {}, c.key);
const mismatched = changes.filter((c) => JSON.stringify(actual[c.key]) !== JSON.stringify(c.to));
mkdirSync(EXP_DIR, { recursive: true });
appendFileSync(join(EXP_DIR, 'changes.jsonl'), JSON.stringify({
  ts: Date.now(), at: new Date().toISOString(), reason, changes, actual,
}) + '\n', 'utf-8');

if (mismatched.length) {
  console.error('写入后复核不一致：' + JSON.stringify(mismatched.map((c) => ({ key: c.key, want: c.to, got: actual[c.key] }))));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, before: JSON.parse(before), after: actual, reason }, null, 2));
