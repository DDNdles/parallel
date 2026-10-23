#!/usr/bin/env node
/**
 * 频率模式小时级观测：从 data/sessions/*.jsonl 读真实会话日志，算这一小时“像不像人”。
 *
 * 只看落账事实，不调模型、不改配置：
 *   - 入站条数 / 独立发言人数 / 其中 @ 到 bot 的条数
 *   - 出站气泡数 / 回复轮数 / 每轮几条 / 每百条入站回几轮
 *   - 开口原因（frequency / idle / …）、沉默评估、退避、打断、重复重写、限速、空回复、发送错误
 *   - 延迟：入站→agent 开始（等人/合批）、agent 开始→第一条气泡（模型）、开口→第一条气泡
 *   - 模型：agent_end 的 usage（prompt/completion/ms）
 *
 * 用法：
 *   node scripts/observe-frequency.mjs                 # 最近一个完整小时，JSON
 *   node scripts/observe-frequency.mjs --markdown      # 人读版
 *   node scripts/observe-frequency.mjs --from 2026-10-23T09:00:00+08:00 --to 2026-10-23T10:00:00+08:00
 *   node scripts/observe-frequency.mjs --hours 3       # 最近 3 个完整小时（按整点切）
 *   node scripts/observe-frequency.mjs --save          # 追加到 data/experiments/frequency-mode/hourly.jsonl
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = join(ROOT, 'data', 'sessions');
const CONFIG = join(ROOT, 'data', 'config.json');
const SECRETS = join(ROOT, 'data', 'secrets.json');
const EXP_DIR = join(ROOT, 'data', 'experiments', 'frequency-mode');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

function parseTime(v) {
  if (v === undefined) return null;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 最近 N 个完整小时：以当前整点为右端 */
function defaultWindow(hours) {
  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end);
  start.setHours(start.getHours() - hours);
  return { from: start.getTime(), to: end.getTime() };
}

const hours = Math.max(1, Math.min(24, Number(argVal('--hours') ?? 1)));
const fromArg = parseTime(argVal('--from'));
const toArg = parseTime(argVal('--to'));
let from;
let to;
if (fromArg !== null && toArg !== null) {
  from = fromArg;
  to = toArg;
} else if (fromArg !== null) {
  from = fromArg;
  to = from + hours * 3600_000;
} else {
  ({ from, to } = defaultWindow(hours));
}
if (!(to > from)) {
  console.error('时间窗不合法：--to 必须晚于 --from');
  process.exit(2);
}

const local = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const readJson = (file, def) => {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return def; }
};

// ---------- 配置快照 ----------
const cfg = readJson(CONFIG, {});
const hl = cfg.humanlike ?? {};
const params = {
  mode: hl.timing?.replyTriggerMode,
  timing: {
    pendingThreshold: hl.timing?.pendingThreshold,
    talkValue: hl.timing?.talkValue,
    privateTalkValue: hl.timing?.privateTalkValue,
    inevitableAtReply: hl.timing?.inevitableAtReply,
    mentionedBotReply: hl.timing?.mentionedBotReply,
    focusMode: hl.timing?.focusMode,
  },
  merge: { ...(hl.merge ?? {}) },
  backoff: { ...(hl.backoff ?? {}) },
  interrupt: { ...(hl.interrupt ?? {}) },
  outgoing: {
    replyMaxCharacters: hl.outgoing?.replyMaxCharacters,
    maxReplyTokens: hl.outgoing?.maxReplyTokens,
    bubbleSoftMaxCharacters: hl.outgoing?.bubbleSoftMaxCharacters,
    splitReplyMessages: hl.outgoing?.splitReplyMessages,
    typingEnabled: hl.outgoing?.typingEnabled,
  },
  repetition: { ...(hl.repetition ?? {}) },
  rhythm: { mode: hl.rhythm?.mode, historyLimit: hl.rhythm?.historyLimit, collapseMinSamples: hl.rhythm?.collapseMinSamples, exhaustLimit: hl.rhythm?.exhaustLimit },
  proactive: { enable: hl.proactive?.enable, idleSeconds: hl.proactive?.idleSeconds },
};
const selfQq = String(cfg.ui?.lastLogin?.qq ?? '');

// ---------- 会话日志 ----------
/** @type {Map<string, any[]>} */
const byChat = new Map();
let badLines = 0;
let scanned = 0;
if (existsSync(SESSIONS)) {
  for (const name of readdirSync(SESSIONS).filter((f) => f.endsWith('.jsonl'))) {
    let raw = '';
    try { raw = readFileSync(join(SESSIONS, name), 'utf-8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      scanned++;
      let e;
      try { e = JSON.parse(line); } catch { badLines++; continue; }
      const ts = Number(e?.ts);
      if (!Number.isFinite(ts) || ts < from || ts >= to) continue;
      const key = `${e.chatType ?? 'group'}_${e.chatId ?? ''}`;
      if (!byChat.has(key)) byChat.set(key, []);
      byChat.get(key).push(e);
    }
  }
}

// ---------- 工具 ----------
function pct(values, p) {
  const a = values.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)));
  return Math.round(a[i]);
}
function stat(values) {
  const a = values.filter((n) => Number.isFinite(n));
  if (!a.length) return { n: 0, p50: null, p90: null, max: null, avg: null };
  const sum = a.reduce((x, y) => x + y, 0);
  return { n: a.length, p50: pct(a, 0.5), p90: pct(a, 0.9), max: Math.round(Math.max(...a)), avg: Math.round(sum / a.length) };
}
function pushHist(map, k) { map[k] = (map[k] ?? 0) + 1; }
function minuteKey(ts) { return Math.floor(ts / 60_000); }

function isChatLane(e) { return e?.lane !== 'work'; }
function gateKind(e) {
  const d = e?.data ?? {};
  const text = String(e?.text ?? '');
  const decision = d.decision ? String(d.decision) : '';
  // 打断/重写/限速这些条目也带 data.reason（如「插话（掷中 0.05）」），
  // 必须在 reason 之前认 decision，否则会被误算成一次开口
  if (decision && decision !== 'wait') return { kind: 'decision', decision };
  // wait 条目也带 data.decision='wait'，先按文本细分成退避/分数/专注
  if (text.startsWith('退避中')) return { kind: 'wait', wait: 'backoff' };
  if (text.startsWith('不说：')) return { kind: 'wait', wait: 'score' };
  if (text.startsWith('专注模式')) return { kind: 'wait', wait: 'focus' };
  if (decision === 'wait') return { kind: 'wait', wait: 'other' };
  if (d.reason) return { kind: 'open', reason: String(d.reason) };
  if (text.startsWith('开口（')) {
    const m = text.match(/^开口（([^）]+)）/);
    return { kind: 'open', reason: m?.[1] ?? 'unknown' };
  }
  if (text.startsWith('主动开口被行动容量挡下')) return { kind: 'decision', decision: 'agency_blocked' };
  if (d.decision) return { kind: 'decision', decision: String(d.decision) };
  return { kind: 'other' };
}

function analyzeChat(chatKey, entries) {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const inbound = sorted.filter((e) => e.type === 'message_in');
  const rawOutbound = sorted.filter((e) => e.type === 'message_out' && !e?.data?.simulated);
  // 工作交付（forward 标题「工作交付」）不是聊天回复：单独计数，不进气泡/轮数/bot 占比
  const workReports = rawOutbound.filter((e) => e?.data?.forward?.title === '工作交付');
  const outbound = rawOutbound.filter((e) => e?.data?.forward?.title !== '工作交付');
  const rawTurns = sorted.filter((e) => e.type === 'agent_end' && isChatLane(e));
  const reportTurnIds = new Set();
  for (const t of rawTurns) {
    if (rawOutbound.some((e) => e.ts >= t.ts && e.ts <= t.ts + 60_000 && e?.data?.forward?.title === '工作交付')) {
      reportTurnIds.add(t.id);
    }
  }
  const turns = rawTurns.filter((t) => !reportTurnIds.has(t.id));
  const starts = sorted.filter((e) => e.type === 'agent_start' && isChatLane(e));
  const gates = sorted.filter((e) => e.type === 'gate');

  const senders = new Set(inbound.map((e) => String(e.userId ?? '')).filter(Boolean));
  const inboundChars = inbound.reduce((n, e) => n + [...String(e.text ?? '')].length, 0);
  const outboundChars = outbound.reduce((n, e) => n + [...String(e.text ?? '')].length, 0);

  // @ 到 bot：message_in 的 segments 里 at.qq === 自己的号
  let atMe = 0;
  for (const e of inbound) {
    const segs = Array.isArray(e?.data?.segments) ? e.data.segments : [];
    if (selfQq && segs.some((s) => s?.type === 'at' && String(s?.data?.qq) === selfQq)) atMe++;
  }

  // 开口 / 沉默 / 其它决策
  const opens = [];
  const openReasons = {};
  const waits = { total: 0, backoff: 0, score: 0, focus: 0 };
  const decisions = {};
  for (const e of gates) {
    const g = gateKind(e);
    if (g.kind === 'open') {
      opens.push({ ts: e.ts, reason: g.reason });
      openReasons[g.reason] = (openReasons[g.reason] ?? 0) + 1;
    } else if (g.kind === 'wait') {
      waits.total++;
      waits[g.wait] = (waits[g.wait] ?? 0) + 1;
    } else if (g.kind === 'decision') {
      decisions[g.decision] = (decisions[g.decision] ?? 0) + 1;
    }
  }

  // 每轮气泡数：优先用 message_out.data.parts（part===1 是一轮的第一条）
  const bubbleHist = {};
  const bubbleCounts = [];
  for (const e of outbound) {
    const part = Number(e?.data?.part);
    const parts = Number(e?.data?.parts);
    if (Number.isFinite(part) && Number.isFinite(parts) && part === 1 && parts >= 1) {
      bubbleCounts.push(parts);
      pushHist(bubbleHist, parts);
    }
  }
  if (!bubbleCounts.length && outbound.length) {
    // 老日志没有 part：按 8s 间隔切 burst
    let cur = 0;
    let prev = 0;
    for (const e of outbound) {
      if (!prev || e.ts - prev > 8000) {
        if (cur) { bubbleCounts.push(cur); pushHist(bubbleHist, cur); }
        cur = 0;
      }
      cur++;
      prev = e.ts;
    }
    if (cur) { bubbleCounts.push(cur); pushHist(bubbleHist, cur); }
  }

  // 延迟：开口→agent 开始→第一条气泡；以及上一条入站→agent 开始
  const gateToStart = [];
  const startToOut = [];
  const gateToOut = [];
  const inboundToStart = [];
  for (const s of starts) {
    const prevIn = [...inbound].reverse().find((e) => e.ts <= s.ts);
    if (prevIn) inboundToStart.push(s.ts - prevIn.ts);
    const firstOut = outbound.find((e) => e.ts >= s.ts);
    if (firstOut) startToOut.push(firstOut.ts - s.ts);
    const prevOpen = [...opens].reverse().find((g) => g.ts <= s.ts);
    if (prevOpen) {
      gateToStart.push(s.ts - prevOpen.ts);
      if (firstOut) gateToOut.push(firstOut.ts - prevOpen.ts);
    }
  }

  // 模型用量
  let promptTokens = 0;
  let completionTokens = 0;
  const modelMs = [];
  for (const t of turns) {
    for (const u of Array.isArray(t?.data?.usage) ? t.data.usage : []) {
      promptTokens += Number(u?.prompt ?? 0) || 0;
      completionTokens += Number(u?.completion ?? 0) || 0;
      if (Number.isFinite(Number(u?.ms))) modelMs.push(Number(u.ms));
    }
  }

  const errorEntries = sorted.filter((e) => e.type === 'error');
  const activeMinutes = new Set(inbound.map((e) => minuteKey(e.ts))).size;

  return {
    chatKey,
    chatType: sorted[0]?.chatType ?? '',
    chatId: sorted[0]?.chatId ?? '',
    inbound: inbound.length,
    uniqueSenders: senders.size,
    atMe,
    inboundChars,
    inboundPerMinute: +(inbound.length / Math.max(1, (to - from) / 60_000)).toFixed(2),
    outbound: outbound.length,
    workReports: workReports.length,
    outboundChars,
    turns: turns.length,
    bubbles: {
      total: outbound.length,
      perTurn: stat(bubbleCounts),
      histogram: bubbleHist,
    },
    replyTurnsPer100Inbound: inbound.length ? +((turns.length / inbound.length) * 100).toFixed(1) : null,
    // 频率模式真正的开口率：@/提及是强制回复，不能算进"太吵"；看 frequency 开口 / 非@入站
    frequencyTurnsPer100NonAt: (() => {
      const nonAt = inbound.length - atMe;
      const freq = openReasons.frequency ?? 0;
      return nonAt > 0 ? +((freq / nonAt) * 100).toFixed(1) : null;
    })(),
    botShare: inbound.length + outbound.length ? +(outbound.length / (inbound.length + outbound.length)).toFixed(3) : null,
    opens: { total: opens.length, byReason: openReasons },
    waits,
    decisions,
    latencyMs: {
      lastInboundToAgentStart: stat(inboundToStart),
      gateToAgentStart: stat(gateToStart),
      agentStartToFirstBubble: stat(startToOut),
      gateToFirstBubble: stat(gateToOut),
    },
    model: {
      promptTokens,
      completionTokens,
      ms: stat(modelMs),
    },
    errors: errorEntries.length,
    errorSamples: errorEntries.slice(0, 3).map((e) => String(e.text ?? '').slice(0, 160)),
    activeMinutes,
    activeMinuteRatio: +(activeMinutes / Math.max(1, (to - from) / 60_000)).toFixed(2),
  };
}

const chats = [...byChat.entries()]
  .map(([key, entries]) => analyzeChat(key, entries))
  .filter((c) => c.inbound || c.outbound || c.opens.total || c.waits.total || c.decisions && Object.keys(c.decisions).length)
  .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound));

// 汇总（只把有活动的会话算进去）
const sum = (pick) => chats.reduce((n, c) => n + (Number(pick(c)) || 0), 0);
const totals = {
  chats: chats.length,
  inbound: sum((c) => c.inbound),
  uniqueSenders: (() => {
    const s = new Set();
    for (const [, entries] of byChat) for (const e of entries) if (e.type === 'message_in' && e.userId) s.add(String(e.userId));
    return s.size;
  })(),
  atMe: sum((c) => c.atMe),
  outbound: sum((c) => c.outbound),
  workReports: sum((c) => c.workReports),
  turns: sum((c) => c.turns),
  opens: sum((c) => c.opens.total),
  waits: sum((c) => c.waits.total),
  openReasons: chats.reduce((m, c) => { for (const [k, v] of Object.entries(c.opens.byReason)) m[k] = (m[k] ?? 0) + v; return m; }, {}),
  decisions: chats.reduce((m, c) => { for (const [k, v] of Object.entries(c.decisions)) m[k] = (m[k] ?? 0) + v; return m; }, {}),
  errors: sum((c) => c.errors),
  replyTurnsPer100Inbound: sum((c) => c.inbound) ? +((sum((c) => c.turns) / sum((c) => c.inbound)) * 100).toFixed(1) : null,
  frequencyTurnsPer100NonAt: (() => {
    const nonAt = sum((c) => c.inbound) - sum((c) => c.atMe);
    const freq = chats.reduce((n, c) => n + (c.opens.byReason.frequency ?? 0), 0);
    return nonAt > 0 ? +((freq / nonAt) * 100).toFixed(1) : null;
  })(),
  botShare: (sum((c) => c.inbound) + sum((c) => c.outbound)) ? +(sum((c) => c.outbound) / (sum((c) => c.inbound) + sum((c) => c.outbound))).toFixed(3) : null,
  avgBubblesPerTurn: (() => {
    const counts = [];
    for (const c of chats) for (const [k, v] of Object.entries(c.bubbles.histogram)) for (let i = 0; i < v; i++) counts.push(Number(k));
    return counts.length ? +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2) : null;
  })(),
  bubbleHistogram: chats.reduce((m, c) => { for (const [k, v] of Object.entries(c.bubbles.histogram)) m[k] = (m[k] ?? 0) + v; return m; }, {}),
};

// ---------- 内核/错误中心 ----------
let health = { reachable: false, connected: null, selfId: null, nickname: null, errorsInWindow: null };
try {
  const token = readJson(SECRETS, {}).uiToken;
  if (token) {
    const headers = { 'X-Auth-Token': String(token) };
    const st = await (await fetch('http://127.0.0.1:3080/api/state', { headers })).json();
    health = {
      reachable: true,
      connected: !!st?.adapter?.connected,
      selfId: st?.adapter?.selfId ?? null,
      nickname: st?.adapter?.nickname ?? null,
      errorsInWindow: null,
    };
    try {
      const errs = await (await fetch('http://127.0.0.1:3080/api/errors', { headers })).json();
      // 只数 error 级：info/warn（容器启动、work 链切模型）混进来会把"错误"数放大
      if (Array.isArray(errs)) health.errorsInWindow = errs.filter((e) => e?.level === 'error' && Number(e?.ts) >= from && Number(e?.ts) < to).length;
    } catch { /* 错误中心读不到不影响观测 */ }
  }
} catch { /* 内核没起：照样从日志出报告 */ }

const report = {
  window: { from, to, fromLocal: local(from), toLocal: local(to), hours: +((to - from) / 3600_000).toFixed(2) },
  params,
  health,
  totals,
  chats,
  scan: { linesScanned: scanned, badLines },
};

if (has('--save')) {
  mkdirSync(EXP_DIR, { recursive: true });
  appendFileSync(join(EXP_DIR, 'hourly.jsonl'), JSON.stringify(report) + '\n', 'utf-8');
}

if (has('--markdown')) {
  const fmt = (v) => (v === null || v === undefined ? '—' : String(v));
  const lines = [];
  lines.push(`# 频率模式观测 ${report.window.fromLocal} → ${report.window.toLocal}`);
  lines.push('');
  lines.push(`参数：mode=${params.mode} pending=${params.timing.pendingThreshold} talk=${params.timing.talkValue} ` +
    `merge=${params.merge.windowMs}/${params.merge.maxWaitMs}ms fire=${params.merge.fireDelayMinMs}-${params.merge.fireDelayMaxMs}ms ` +
    `backoff=${params.backoff.baseSeconds}/${params.backoff.capSeconds}s start=${params.backoff.startCount} bypass=${params.backoff.bypassPendingCount} ` +
    `interrupt=${params.interrupt.probability} replyMax=${params.outgoing.replyMaxCharacters} bubble=${params.outgoing.bubbleSoftMaxCharacters}`);
  lines.push('');
  lines.push(`总量：入站 ${totals.inbound}（${totals.uniqueSenders} 人，@我 ${totals.atMe}）/ 出站 ${totals.outbound} 条、${totals.turns} 轮 / ` +
    `每百条入站回 ${fmt(totals.replyTurnsPer100Inbound)} 轮 / frequency 开口 ${totals.openReasons.frequency ?? 0} 次（${fmt(totals.frequencyTurnsPer100NonAt)}/百条非@）/ ` +
    `bot 消息占比 ${fmt(totals.botShare)} / 平均每轮 ${fmt(totals.avgBubblesPerTurn)} 条` +
    (totals.workReports ? ` / 工作交付 ${totals.workReports} 条（不计入聊天）` : ''));
  const reasons = Object.entries(totals.openReasons).map(([k, v]) => `${k}:${v}`).join(' ') || '无';
  const decs = Object.entries(totals.decisions).map(([k, v]) => `${k}:${v}`).join(' ') || '无';
  lines.push(`开口 ${totals.opens}（${reasons}）/ 沉默评估 ${totals.waits} / 其它决策 ${decs} / 错误 ${totals.errors}（会话落账）+ ${health.errorsInWindow ?? 0}（错误中心 error 级）`);
  lines.push(`气泡分布：${Object.entries(totals.bubbleHistogram).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}条×${v}`).join(' ') || '无'}`);
  if (!health.reachable) lines.push('⚠ 内核 /api/state 不可达（本小时报告只来自会话日志）');
  else lines.push(`内核：协议端 ${health.connected ? '在线' : '离线'}，${health.nickname ?? ''} ${health.selfId ?? ''}`);
  lines.push('');
  lines.push('| 会话 | 入站 | @我 | 出站 | 轮数 | 回轮/百条 | freq/非@百条 | bot占比 | 开口 | 沉默 | 打断/作废 | 空回复 | 重复重写 | 限速 | 平均/最长 气泡 | 首气泡延迟 p50/p90 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const c of chats) {
    const d = c.decisions;
    const interrupted = Math.max(d.generation_interrupted ?? 0, d.generation_aborted ?? 0);
    const lat = c.latencyMs.agentStartToFirstBubble;
    lines.push(`| ${c.chatKey} | ${c.inbound} | ${c.atMe} | ${c.outbound} | ${c.turns} | ${fmt(c.replyTurnsPer100Inbound)} | ${fmt(c.frequencyTurnsPer100NonAt)} | ${fmt(c.botShare)} | ${c.opens.total} | ${c.waits.total} | ${interrupted} | ${d.empty_reply ?? 0} | ${d.repetition_retry ?? 0} | ${(d.rate_limited ?? 0) + (d.rate_truncated ?? 0)} | ${fmt(c.bubbles.perTurn.avg)}/${fmt(c.bubbles.perTurn.max)} | ${fmt(lat.p50)}/${fmt(lat.p90)}ms |`);
  }
  console.log(lines.join('\n'));
} else {
  console.log(JSON.stringify(report, null, 2));
}
