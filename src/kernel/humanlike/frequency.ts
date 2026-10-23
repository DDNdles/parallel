/**
 * 发言频率与空闲退避 —— 移植自 MaiBot `official_configs.ChatReplyTimingConfig`
 * 与 `src/maisaka/idle_backoff.py`。
 *
 * 2026-10-23 起「按群聊与时段单独调整频率」整层删除（用户改要每个会话单独配拟人化）：
 * 频率只剩两个开关（群聊/私聊 talkValue），会话差异走 `timingOverrides`。
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
}): { reached: boolean; delaySeconds: number; detail: string } {
  const threshold = Math.max(1, opts.triggerThreshold);
  if (opts.pendingCount < 1) {
    return { reached: false, delaySeconds: 0, detail: 'pending=0，不允许纯沉默触发' };
  }
  const avg = opts.averageIntervalSeconds;
  if (avg === null || !Number.isFinite(avg) || avg <= 0) {
    return { reached: false, delaySeconds: 0, detail: '平均消息间隔不可用，无法进行空窗补偿' };
  }
  const idleEquivalent = Math.min(opts.idleSeconds / avg, Math.max(0, threshold - 1));
  const equivalent = opts.pendingCount + idleEquivalent;
  const detail = `平均间隔=${avg.toFixed(2)}s 空窗=${opts.idleSeconds.toFixed(2)}s `
    + `空窗折算=${idleEquivalent.toFixed(2)} 等效消息数=${equivalent.toFixed(2)}/${threshold}`;
  if (equivalent >= threshold) return { reached: true, delaySeconds: 0, detail: `${detail} 判定=空窗补偿` };

  const delay = Math.max(0, (threshold - opts.pendingCount) * avg - opts.idleSeconds);
  return { reached: false, delaySeconds: delay, detail: `${detail} 延迟=${delay.toFixed(2)}s` };
}
