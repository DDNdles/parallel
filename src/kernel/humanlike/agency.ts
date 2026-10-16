/**
 * 主体行动窗口 Agency Window —— 移植 HDSI `src/agency.ts` 的容量判据与配置默认值。
 *
 * HDSI 的原意：主动联系不能只凭"她想说"，还要过一遍**现实条件** ——
 * 日程负荷（activityLoad）/ 隐私空间（privacy）/ 设备可用性（deviceAccess）三样构成"行动容量"，
 * 容量不足就排一个 `proactive-check` 稍后重查，而不是硬发。
 *
 * 我们的映射（诚实版，不假装有日程系统）：
 *   - deviceAccess：她在"睡觉"（安静时段）时算 unavailable —— 这也是最实际的一条防打扰
 *   - privacy：群聊 = public、私聊 = private（HDSI 用它挡"私人级别"的披露）
 *   - activityLoad：由日程计划（schedule.ts）推出的当前活动；忙 = occupied/overloaded
 * 判据表与 `evaluateAgencyCapacity` 逐条对齐，返回的 reason 也用同一套字符串。
 */

export interface AgencyConfig {
  enable: boolean;
  /** 安静时段（她睡着，不主动开口）；跨零点用 "23:30-07:30" 这种写法 */
  quietHours: string;
  /** 两次主动联系之间的最小间隔（分钟）—— HDSI `minimumProactiveIntervalMinutes` */
  minimumProactiveIntervalMinutes: number;
  /** 窗口有效期（分钟）—— HDSI `maxWindowMinutes` */
  maxWindowMinutes: number;
  /** 主动联系能往前看多久（小时）—— HDSI `maxCandidateHours` */
  maxCandidateHours: number;
}

export const DEFAULT_AGENCY: AgencyConfig = {
  enable: true,
  quietHours: '00:30-07:30',
  minimumProactiveIntervalMinutes: 60,
  maxWindowMinutes: 240,
  maxCandidateHours: 24,
};

export type ActivityLoad = 'free' | 'occupied' | 'overloaded';
export type Privacy = 'private' | 'shared' | 'public';
export type DeviceAccess = 'available' | 'limited' | 'unavailable';

export interface AgencyWindow {
  activityLoad: ActivityLoad;
  privacy: Privacy;
  deviceAccess: DeviceAccess;
  /** 这次判断的有效期 */
  validUntil: number;
  nextOpportunityAt?: number;
}

export interface ProactiveContactCandidate {
  /** 联系的性质：日常闲聊 / 承诺回访 / 事务性更新 */
  origin: 'chat' | 'promise' | 'practical-update';
  /** 披露级别：personal 的内容不能在公开场合说 */
  disclosure?: 'ordinary' | 'personal';
  /** 一句话说明这次联系的生活理由（HDSI 要求候选引用真实剧本条目） */
  reason: string;
}

export interface AgencyCapacity {
  allowed: boolean;
  reason: string;
  nextOpportunityAt?: number;
}

function inWindow(now: Date, span: string): boolean {
  const m = span.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return false;
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

/** 安静时段的下一个结束时刻（用来排"稍后重查"） */
export function quietHoursEnd(now: Date, span: string): Date | undefined {
  const m = span.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const end = new Date(now);
  end.setHours(Number(m[3]), Number(m[4]), 0, 0);
  if (end <= now) end.setDate(end.getDate() + 1);
  return end;
}

/** 由「现在 + 会话类型 + 当前活动」推出行动窗口 */
export function deriveWindow(
  now: Date,
  chatType: 'group' | 'private',
  cfg: AgencyConfig,
  activity?: { busy: boolean; label?: string } | null,
): AgencyWindow {
  const asleep = inWindow(now, cfg.quietHours);
  const load: ActivityLoad = activity?.busy ? 'overloaded' : 'free';
  return {
    activityLoad: load,
    privacy: chatType === 'private' ? 'private' : 'public',
    deviceAccess: asleep ? 'unavailable' : 'available',
    validUntil: now.getTime() + Math.max(1, cfg.maxWindowMinutes) * 60_000,
    nextOpportunityAt: asleep ? quietHoursEnd(now, cfg.quietHours)?.getTime() : undefined,
  };
}

/**
 * 容量判据（顺序与 HDSI `evaluateAgencyCapacity` 一致）：
 * 窗口缺失/过期 → 设备不可用 → 设备受限 → 日程过载 → 披露级别不足 → 最小间隔未到 → 日程占用。
 * `promise`（承诺回访）不受最小间隔与"占用"限制 —— 答应过的事要兑现。
 */
export function evaluateAgency(
  window: AgencyWindow | undefined,
  candidate: ProactiveContactCandidate,
  now: Date,
  cfg: AgencyConfig,
  lastProactiveAt?: number,
): AgencyCapacity {
  if (!window || window.validUntil <= now.getTime()) return { allowed: false, reason: 'agency-window-missing-or-expired' };
  const nextOpportunityAt = window.nextOpportunityAt && window.nextOpportunityAt > now.getTime() ? window.nextOpportunityAt : undefined;

  if (window.deviceAccess === 'unavailable') return { allowed: false, reason: 'device-unavailable', nextOpportunityAt };
  if (window.deviceAccess === 'limited') return { allowed: false, reason: 'device-limited', nextOpportunityAt };
  if (window.activityLoad === 'overloaded') return { allowed: false, reason: 'schedule-overloaded', nextOpportunityAt };
  if (candidate.disclosure === 'personal' && window.privacy !== 'private') {
    return { allowed: false, reason: 'privacy-insufficient', nextOpportunityAt };
  }

  const minInterval = Math.max(0, cfg.minimumProactiveIntervalMinutes) * 60_000;
  if (candidate.origin !== 'promise' && lastProactiveAt && now.getTime() - lastProactiveAt < minInterval) {
    return { allowed: false, reason: 'minimum-proactive-interval', nextOpportunityAt: lastProactiveAt + minInterval };
  }
  if (window.activityLoad === 'occupied' && candidate.origin !== 'promise' && candidate.origin !== 'practical-update') {
    return { allowed: false, reason: 'schedule-occupied', nextOpportunityAt };
  }
  return { allowed: true, reason: 'capacity-available' };
}

/** 判据理由 → 给人看的一句话 */
export const AGENCY_REASON_ZH: Record<string, string> = {
  'agency-window-missing-or-expired': '窗口过期',
  'device-unavailable': '她在睡觉（安静时段）',
  'device-limited': '设备受限',
  'schedule-overloaded': '日程过载',
  'privacy-insufficient': '这个场合不方便说私事',
  'minimum-proactive-interval': '距上次主动开口还没到最小间隔',
  'schedule-occupied': '日程占用',
  'capacity-available': '可以开口',
};

/** 被判据挡住时，下一次重查的时间：优先取判据给的机会点，否则退到最小间隔之后 */
export function nextRecheckAt(capacity: AgencyCapacity, now: Date, cfg: AgencyConfig): number | undefined {
  if (capacity.allowed) return undefined;
  if (capacity.nextOpportunityAt) return capacity.nextOpportunityAt;
  return now.getTime() + Math.max(5, cfg.minimumProactiveIntervalMinutes) * 60_000;
}
