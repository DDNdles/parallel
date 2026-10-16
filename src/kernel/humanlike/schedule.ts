/**
 * Schedule Preplan 日程 —— 照 HDSI 的口径做的轻量版。
 *
 * HDSI 用「周规律 + 日期例外」描述角色近期的生活结构，程序保存多日、**主叙事只读取未来约半天**，
 * 并且有一条硬规则：**不得把计划当成已发生的事实**（计划只约束合理性，真实剧情始终优先）。
 *
 * 我们的用法有两处：
 *   ① 供 Agency Window 判断"她现在忙不忙"（容量），
 *   ② 主动轮里作为"她接下来的生活"注入 —— 一句带过，且标明是计划不是事实。
 */

export interface ScheduleConfig {
  enable: boolean;
  /** 主动轮能看到的未来时长（小时）—— HDSI `mainPlanHorizonHours` 约半天 */
  horizonHours: number;
  /** 周规律最多保留几条 */
  maxRules: number;
  /** 日期例外最多保留几条 */
  maxExceptions: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  enable: false,
  horizonHours: 12,
  maxRules: 12,
  maxExceptions: 32,
};

/** 周规律：每周固定几天的某段时间做什么（days 用 0=周日 … 6=周六） */
export interface ScheduleRule {
  days: number[];
  from: string;
  to: string;
  label: string;
  /** 这段时间是否"忙"（忙 → Agency Window 判占用） */
  busy?: boolean;
}

/** 日期例外：某一天覆盖规律（date 用 YYYY-MM-DD） */
export interface ScheduleException {
  date: string;
  from: string;
  to: string;
  label: string;
  busy?: boolean;
}

export interface SchedulePlan {
  rules: ScheduleRule[];
  exceptions: ScheduleException[];
}

export function emptyPlan(): SchedulePlan {
  return { rules: [], exceptions: [] };
}

function toMinutes(hhmm: string): number | undefined {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : undefined;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function covers(from: string, to: string, cur: number): boolean {
  const a = toMinutes(from);
  const b = toMinutes(to);
  if (a === undefined || b === undefined) return false;
  if (a <= b) return cur >= a && cur < b;
  return cur >= a || cur < b;      // 跨零点
}

export interface CurrentActivity {
  label: string;
  busy: boolean;
  /** 这段活动到几点结束 */
  until: string;
}

/** 她现在在做什么（例外优先于周规律；都没命中就是空闲） */
export function currentActivity(plan: SchedulePlan, now: Date): CurrentActivity | null {
  const cur = now.getHours() * 60 + now.getMinutes();
  const today = dayKey(now);
  const hit =
    plan.exceptions.find((e) => e.date === today && covers(e.from, e.to, cur))
    ?? plan.rules.find((r) => r.days.includes(now.getDay()) && covers(r.from, r.to, cur));
  if (!hit) return null;
  return { label: hit.label, busy: !!hit.busy, until: hit.to };
}

/** 未来 horizon 小时内的安排（一句话一条，按时间排） */
export function upcoming(plan: SchedulePlan, now: Date, cfg: ScheduleConfig): string[] {
  const horizonMin = Math.max(1, cfg.horizonHours) * 60;
  const out: { at: number; text: string }[] = [];
  for (let d = 0; d <= 1; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const key = dayKey(day);
    for (const e of plan.exceptions.filter((x) => x.date === key)) {
      const from = toMinutes(e.from);
      if (from === undefined) continue;
      const abs = from + d * 1440;
      if (abs > now.getHours() * 60 + now.getMinutes() && abs <= now.getHours() * 60 + now.getMinutes() + horizonMin) {
        out.push({ at: abs, text: `${d === 0 ? '今天' : '明天'} ${e.from}-${e.to} ${e.label}` });
      }
    }
    for (const r of plan.rules.filter((x) => x.days.includes(day.getDay()))) {
      const from = toMinutes(r.from);
      if (from === undefined) continue;
      const abs = from + d * 1440;
      if (abs > now.getHours() * 60 + now.getMinutes() && abs <= now.getHours() * 60 + now.getMinutes() + horizonMin) {
        out.push({ at: abs, text: `${d === 0 ? '今天' : '明天'} ${r.from}-${r.to} ${r.label}` });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.text);
}

/** 清掉过期例外并截断容量（HDSI 的日程只保留有限条目，避免无限膨胀） */
export function prunePlan(plan: SchedulePlan, now: Date, cfg: ScheduleConfig): SchedulePlan {
  const today = dayKey(now);
  const exceptions = plan.exceptions.filter((e) => e.date >= today).slice(-cfg.maxExceptions);
  const rules = plan.rules.slice(-cfg.maxRules);
  return { rules, exceptions };
}

/** 计划注入文本：**必须标明是计划不是事实**（HDSI 的硬规则） */
export function schedulePrompt(plan: SchedulePlan, now: Date, cfg: ScheduleConfig): string | null {
  const items = upcoming(plan, now, cfg);
  const current = currentActivity(plan, now);
  if (!items.length && !current) return null;
  return [
    '# 她接下来的生活（计划，不是已发生的事实）',
    current ? `- 此刻：${current.label}（到 ${current.until}）` : '',
    ...items.map((t) => `- ${t}`),
    '这些只是安排，别当成已经做过的事；真实剧情以对话为准。',
  ].filter(Boolean).join('\n');
}
