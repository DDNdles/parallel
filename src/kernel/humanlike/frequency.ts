/**
 * 发言频率与空闲退避 —— 移植自 MaiBot `official_configs.ChatReplyTimingConfig`
 * 与 `src/maisaka/idle_backoff.py`。
 *
 * 2026-10-23 起只分群聊/私聊两档（先删按群聊与时段规则，再删按单个会话覆盖）：
 * 频率只剩两个开关（群聊/私聊 talkValue），其余时机参数全局共用一套。
 */

import type { ChatRef } from '../types.ts';

/**
 * 求当前生效的发言频率（0–1）。私聊用 privateTalkValue，群聊用 talkValue。
 * 只当静默开关：0 = 不说话，大于 0 不改变积压条数门槛。
 */
export function talkValueFor(cfg: { talkValue: number; privateTalkValue: number }, chat: ChatRef): number {
  return clamp01(chat.type === 'private' ? cfg.privateTalkValue : cfg.talkValue);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export interface BackoffConfig {
  baseSeconds: number;
  capSeconds: number;
  startCount: number;
  bypassPendingCount: number;
}

/**
 * 连续不理人之后，下一次评估前先等多久 —— 移植自 `idle_backoff.py` 的
 * `min(cap, base × 2^(连续次数 - 起点))`。群里重新热闹起来（积压够多）就绕过退避。
 */
export function idleBackoffSeconds(cfg: BackoffConfig, consecutiveNoAction: number): number {
  const base = Math.max(0, cfg.baseSeconds);
  const cap = Math.max(0, cfg.capSeconds);
  if (base <= 0 || cap <= 0) return 0;
  const start = Math.max(1, cfg.startCount);
  if (consecutiveNoAction < start) return 0;
  const exponent = Math.max(0, consecutiveNoAction - start);
  return Math.min(cap, base * 2 ** exponent);
}

/** 积压够多就不退避了（群里炸了就别装矜持） */
export function backoffBypassed(cfg: BackoffConfig, pendingCount: number): boolean {
  const bypass = Math.max(0, cfg.bypassPendingCount);
  return bypass > 0 && pendingCount >= bypass;
}

/**
 * 空窗补偿 —— 移植自 MaiBot `turn_gates.py` 的 `_calculate_idle_compensation`。
 *
 * 把沉默时长按群的平均消息节奏折算成「等效消息数」，加在真实积压条数上：
 *   idle_equivalent = min(沉默秒数 / 平均间隔, 阈值 - 1)      ← 封顶是双保险
 *   equivalent      = 积压条数 + idle_equivalent
 * 群越活跃（平均间隔越小）折算得越快，于是潜水久了也能自然插一嘴；
 * 封顶 + `pending = 0` 直接拒绝，保证**至少要有一条真实新消息**才可能触发，
 * 杜绝纯靠沉默累积反复自我唤醒（MaiBot 的注释原话）。
 */
export function idleCompensation(opts: {
  pendingCount: number;
  triggerThreshold: number;
  idleSeconds: number;
  averageIntervalSeconds: number | null;
  /** 折算帽（默认 阈值-1 = MaiBot 原版）。2026-10-24 起调用方传 min(阈值-1, ceil(0.6×阈值))：门槛已被自适应放低的慢群别再吃全额折算 */
  maxEquivalent?: number;
}): { reached: boolean; delaySeconds: number; detail: string; equivalent: number } {
  const threshold = Math.max(1, opts.triggerThreshold);
  if (opts.pendingCount < 1) {
    return { reached: false, delaySeconds: 0, detail: 'pending=0，不允许纯沉默触发', equivalent: 0 };
  }
  const avg = opts.averageIntervalSeconds;
  if (avg === null || !Number.isFinite(avg) || avg <= 0) {
    return { reached: false, delaySeconds: 0, detail: '平均消息间隔不可用，无法进行空窗补偿', equivalent: opts.pendingCount };
  }
  const cap = Math.max(0, opts.maxEquivalent ?? Math.max(0, threshold - 1));
  const idleEquivalent = Math.min(opts.idleSeconds / avg, cap);
  const equivalent = opts.pendingCount + idleEquivalent;
  const detail = `平均间隔=${avg.toFixed(2)}s 空窗=${opts.idleSeconds.toFixed(2)}s `
    + `空窗折算=${idleEquivalent.toFixed(2)} 等效消息数=${equivalent.toFixed(2)}/${threshold}`;
  if (equivalent >= threshold) return { reached: true, delaySeconds: 0, detail: `${detail} 判定=空窗补偿`, equivalent };

  const delay = Math.max(0, (threshold - opts.pendingCount) * avg - opts.idleSeconds);
  return { reached: false, delaySeconds: delay, detail: `${detail} 延迟=${delay.toFixed(2)}s`, equivalent };
}

// ============================================================
// 2026-10-24 开口时机 B/C 层优化（零新增配置旋钮，全部自适应）：
//   B1 空窗补偿锚定「bot 上次开口」而非 buffer 生存期（不再被 TTL 连坐）
//   B2 退避语义修正：群重新热闹（近 5 分钟 ≥3 条真人消息）即清退避
//   B3 便宜信号：问句打折、刷屏加倍（不花 LLM）
//   C1 自适应门槛：慢群按同一把平均间隔反比放宽，快群保持配置值
//   C2 软阈值：等效条数过 85% 门槛后按超出比例概率开口（消除「差一条」悬崖）
//   C3 接话窗口：并进 B1 的锚点（开口后 idle 归零，自然形成短期高参与）
//   C4 昼夜因子：按本会话小时直方图（带遗忘）给门槛乘 1.0~1.75
// ============================================================

/** C1：快群的 avg 被下限钳在 30s → 门槛恰为配置值（busy 行为不变）；慢群按同一把 avg 反比放宽 */
export const ADAPTIVE = { MIN_THRESHOLD: 5, REF_AVG_SECONDS: 30, MIN_SAMPLES: 5 } as const;

export function adaptiveThreshold(configured: number, avgIntervalSeconds: number | null, sampleCount: number): number {
  const base = Math.max(1, Math.round(Number(configured) || 1));
  if (avgIntervalSeconds === null || !Number.isFinite(avgIntervalSeconds) || sampleCount < ADAPTIVE.MIN_SAMPLES) return base;
  const scaled = base * (ADAPTIVE.REF_AVG_SECONDS / Math.max(ADAPTIVE.REF_AVG_SECONDS, avgIntervalSeconds));
  return Math.max(ADAPTIVE.MIN_THRESHOLD, Math.min(base, Math.round(scaled)));
}

/** C4：直方图样本不足回中性 1；本小时占比越低门槛越高（最冷的小时 ×1.75） */
export const CIRCADIAN = { MAX_EXTRA: 0.75, MIN_SAMPLES: 30, HALF_LIFE_MS: 14 * 24 * 3600_000 } as const;

export function circadianThresholdMultiplier(hourBuckets: number[] | null, hour: number): number {
  if (!hourBuckets || hourBuckets.length !== 24) return 1;
  const total = hourBuckets.reduce((a, b) => a + b, 0);
  if (total < CIRCADIAN.MIN_SAMPLES) return 1;
  const max = Math.max(...hourBuckets);
  if (max <= 0) return 1;
  const r = (hourBuckets[hour] ?? 0) / max;
  return 1 + (1 - r) * CIRCADIAN.MAX_EXTRA;
}

/** B1：折算帽。门槛 10 → 帽 6；自适应放低到 5 → 帽 3（单条消息 + 帽 < 门槛，死群不会变成每条必回） */
export const IDLE_CAP_RATIO = 0.6;

export function idleEquivalentCap(threshold: number): number {
  return Math.min(Math.max(0, threshold - 1), Math.ceil(threshold * IDLE_CAP_RATIO));
}

/** C2：等效条数 ∈ [85% 门槛, 门槛) 时按超出比例给开口概率；门槛 <3 没有软区 */
export const SOFT = { START_RATIO: 0.85 } as const;

export function softThresholdProbability(equivalent: number, threshold: number): number {
  if (threshold < 3 || equivalent < threshold * SOFT.START_RATIO) return 0;
  if (equivalent >= threshold) return 1;
  return (equivalent - threshold * SOFT.START_RATIO) / (threshold - threshold * SOFT.START_RATIO);
}

/** B3：问句启发式——末尾问号 /「吗么嘛」收尾（剥掉句号与空白后）/ 短「怎么为什么咋」开头 */
export function looksLikeQuestion(text: string): boolean {
  const t = String(text ?? '').trim().replace(/[。．…\s]+$/, '');
  if (!t) return false;
  if (/[?？]$/.test(t)) return true;
  if (/(吗|么|嘛)[!！?？~～]?$/.test(t)) return true;
  if (t.length <= 14 && /^(怎么|为什么|为啥|咋)/.test(t)) return true;
  return false;
}

/** B3：刷屏识别——窗口内 ≥N 条全是超短消息、≥2 个说话人（同质短消息爆发 = 灌水不是讨论） */
export const SIGNAL = {
  QUESTION_FACTOR: 0.5,
  FLOOD_FACTOR: 2,
  FLOOD_MIN_COUNT: 5,
  FLOOD_MAX_CHARS: 10,
  FLOOD_WINDOW_MS: 90_000,
} as const;

export function looksLikeFlood(events: { userId?: string; text?: string; ts: number }[], now: number): boolean {
  const win = events.filter((e) => now - e.ts <= SIGNAL.FLOOD_WINDOW_MS);
  if (win.length < SIGNAL.FLOOD_MIN_COUNT) return false;
  const allShort = win.every((e) => String(e.text ?? '').trim().length <= SIGNAL.FLOOD_MAX_CHARS);
  if (!allShort) return false;
  return new Set(win.map((e) => String(e.userId ?? '?'))).size >= 2;
}

/** B2：近 5 分钟真人消息 ≥3 条 = 群重新热闹了，清退避（人类在热闹时反而抢话，Holler 2021） */
export const LIVELINESS = { MIN_INBOUND: 3, WINDOW_MS: 300_000 } as const;
