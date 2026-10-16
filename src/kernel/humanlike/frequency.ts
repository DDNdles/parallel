/**
 * 发言频率与空闲退避 —— 移植自 MaiBot `official_configs.ChatReplyTimingConfig`
 * 与 `src/maisaka/idle_backoff.py`。
 *
 * 频率不是单一数字，而是三层：全局 talk_value → 按时段/会话命中的规则覆盖 → 连续不理人的指数退避。
 */

import type { ChatRef } from '../types.ts';

export interface TalkRule {
  /** 平台；空 = 不限 */
  platform?: string;
  /** 会话 id（群号 / 用户号）；空 = 不限 */
  itemId?: string;
  /** 聊天流类型；any = 不限 */
  ruleType?: 'group' | 'private' | 'any';
  /** 时段 "HH:MM-HH:MM"（可跨零点）、"*" 全天、"" 兜底 */
  time?: string;
  /** 命中后的频率 0–1 */
  value: number;
}

export interface TalkValueConfig {
  talkValue: number;
  privateTalkValue: number;
  enableRules: boolean;
  rules: TalkRule[];
}

/** 判断一份时刻是否落在规则时段内（支持 23:00-02:00 这种跨零点） */
export function inTimeWindow(time: string | undefined, minuteOfDay: number): boolean {
  const t = String(time ?? '').trim();
  if (!t) return false;          // 空 = 不按时间匹配（交给调用方当兜底）
  if (t === '*') return true;
  const m = t.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start <= end) return minuteOfDay >= start && minuteOfDay <= end;
  return minuteOfDay >= start || minuteOfDay <= end;
}

/** 规则是否作用在这个会话上（只看平台 / 会话 id / 聊天流类型，不看时间） */
function matchesSession(rule: TalkRule, chat: ChatRef): boolean {
  if (rule.platform && rule.platform !== chat.platform) return false;
  if (rule.itemId && String(rule.itemId) !== String(chat.chatId)) return false;
  const rt = rule.ruleType ?? 'any';
  return rt === 'any' || rt === chat.type;
}

/**
 * 求当前生效的发言频率（0–1）。
 * 时间留空的规则是**兜底**：只有在没有任何带时段的规则命中时才用它，
 * 否则一条 `time: ''` 的规则会把所有时段规则都盖掉。同层多条命中取最后一条。
 */
export function talkValueFor(cfg: TalkValueConfig, chat: ChatRef, now = new Date()): number {
  const base = chat.type === 'private' ? cfg.privateTalkValue : cfg.talkValue;
  if (!cfg.enableRules || !cfg.rules?.length) return clamp01(base);
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  let timed: number | null = null;
  let fallback: number | null = null;
  for (const rule of cfg.rules) {
    if (!matchesSession(rule, chat)) continue;
    const t = String(rule.time ?? '').trim();
    if (!t) { fallback = clamp01(Number(rule.value)); continue; }
    if (inTimeWindow(t, minuteOfDay)) timed = clamp01(Number(rule.value));
  }
  return timed ?? fallback ?? clamp01(base);
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
