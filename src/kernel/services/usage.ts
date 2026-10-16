import type { Db } from '../db.ts';
import { todayKey } from '../util/misc.ts';

/**
 * 用量聚合：把 usage_stats 算成桌面端「用量」页要的一整份报表。
 *
 * 两条口径是用户定的，别改回去：
 * ① **消息条数不对应模型**（入站/出站是全局事实，落在 model='' 那行）；
 * ② **token 必须按模型分**，并且拆成「输入未命中 / 输入缓存命中 / 输出」三档。
 * 只报账本里真有的东西：模型不回报 usage 就没有那一格，不猜、不补。
 */

export interface ModelUsage { miss: number; hit: number; out: number; calls: number }

export interface DayBucket {
  day: string;
  prompt: number;
  completion: number;
  tokens: number;
  cacheHit: number;
  cacheMiss: number;
  calls: number;
  msgIn: number;
  msgOut: number;
  /** 当天有模型调用的会话数（不含 '-' 那条全局行） */
  chats: number;
  /** 模型 id -> 三档 token 与调用次数；model 列为空的老行记在 '' 下 */
  byModel: Record<string, ModelUsage>;
}

export interface DayVal { day: string; value: number }

export interface ModelRow extends ModelUsage {
  model: string;
  providers: string[];
  tokens: number;
  days: number;
}

export interface UsageReport {
  generatedAt: number;
  firstDay: string | null;
  days: DayBucket[];
  today: DayBucket | null;
  totals: {
    prompt: number;
    completion: number;
    tokens: number;
    cacheHit: number;
    cacheMiss: number;
    calls: number;
    msgIn: number;
    msgOut: number;
    activeDays: number;
    streak: number;
    bestStreak: number;
    peak: { tokens: DayVal; msg: DayVal; calls: DayVal };
  };
  models: ModelRow[];
  work: { runs: number; ok: number; totalMs: number; maxMs: number; toolCalls: number; rounds: number };
}

interface Row {
  day: string; provider: string; model: string | null; chat_id: string;
  prompt_tokens: number; completion_tokens: number; cache_hit: number | null; cache_miss: number | null;
  llm_calls: number; messages_in: number; messages_out: number;
}

const DAY_MS = 86_400_000;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const iso = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

const emptyBucket = (day: string): DayBucket => ({
  day, prompt: 0, completion: 0, tokens: 0, cacheHit: 0, cacheMiss: 0, calls: 0,
  msgIn: 0, msgOut: 0, chats: 0, byModel: {},
});
const zeroModel = (): ModelUsage => ({ miss: 0, hit: 0, out: 0, calls: 0 });

export function usageReport(db: Db): UsageReport {
  const rows = db.all<Row>(
    'SELECT day, provider, model, chat_id, prompt_tokens, completion_tokens, cache_hit, cache_miss, llm_calls, messages_in, messages_out FROM usage_stats',
  );

  const map = new Map<string, DayBucket>();
  const provOf = new Map<string, Set<string>>();      // 模型 -> 出现过它的供应商（只为标签准确）
  const daysOf = new Map<string, Set<string>>();
  for (const r of rows) {
    const day = String(r.day ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const b = map.get(day) ?? emptyBucket(day);
    map.set(day, b);
    const tokens = (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
    const msg = (r.messages_in ?? 0) + (r.messages_out ?? 0);
    /* 恒等式 prompt = 命中 + 未命中：迁移前的老行两列都是 0，但 prompt_tokens 有值，
       这时整笔输入算「未命中」（没报缓存就是没命中），否则历史的输入会凭空消失。 */
    const hit = r.cache_hit ?? 0;
    const miss = hit + (r.cache_miss ?? 0) === 0 ? (r.prompt_tokens ?? 0) : (r.cache_miss ?? 0);
    b.prompt += r.prompt_tokens ?? 0;
    b.completion += r.completion_tokens ?? 0;
    b.tokens += tokens;
    b.cacheHit += hit;
    b.cacheMiss += miss;
    b.calls += r.llm_calls ?? 0;
    b.msgIn += r.messages_in ?? 0;
    b.msgOut += r.messages_out ?? 0;
    const model = String(r.model ?? '');
    if (r.llm_calls) {
      if (r.chat_id && r.chat_id !== '-') b.chats += 1;
      const cell = b.byModel[model] ?? (b.byModel[model] = zeroModel());
      cell.hit += hit;
      cell.miss += miss;
      cell.out += r.completion_tokens ?? 0;
      cell.calls += r.llm_calls ?? 0;
      if (!provOf.has(model)) provOf.set(model, new Set());
      provOf.get(model)!.add(String(r.provider ?? '?'));
      if (!daysOf.has(model)) daysOf.set(model, new Set());
      daysOf.get(model)!.add(day);
    }
  }

  const days = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const active = new Set(days.filter((d) => d.tokens > 0 || d.calls > 0 || d.msgIn + d.msgOut > 0).map((d) => d.day));

  const sum = (f: (d: DayBucket) => number) => days.reduce((s, d) => s + f(d), 0);
  const peakOf = (f: (d: DayBucket) => number): DayVal =>
    days.reduce<DayVal>((best, d) => (f(d) > best.value ? { day: d.day, value: f(d) } : best), { day: '', value: 0 });

  // 连续天数：从今天往回数（今天还没记上账不算断，从昨天起接着数）
  const streakFrom = (startNum: number) => {
    let n = 0;
    let cur = startNum;
    while (active.has(iso(cur))) { n++; cur--; }
    return n;
  };
  const todayNum = dayNum(todayKey());
  const streak = streakFrom(todayNum) || streakFrom(todayNum - 1);
  let bestStreak = 0;
  const nums = [...active].map(dayNum).sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    bestStreak = Math.max(bestStreak, j - i + 1);
    i = j;
  }

  const models: ModelRow[] = [...provOf.keys()].map((model) => {
    let acc = zeroModel();
    for (const d of days) {
      const c = d.byModel[model];
      if (!c) continue;
      acc = { miss: acc.miss + c.miss, hit: acc.hit + c.hit, out: acc.out + c.out, calls: acc.calls + c.calls };
    }
    return {
      model, providers: [...(provOf.get(model) ?? [])],
      ...acc, tokens: acc.miss + acc.hit + acc.out, days: daysOf.get(model)?.size ?? 0,
    };
  }).sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);

  let work: UsageReport['work'] = { runs: 0, ok: 0, totalMs: 0, maxMs: 0, toolCalls: 0, rounds: 0 };
  try {
    const w = db.get<Record<string, number | null>>(
      'SELECT COUNT(*) n, SUM(ok) ok, SUM(duration_ms) ms, MAX(duration_ms) maxms, SUM(tool_calls) tc, SUM(rounds) rd FROM work_runs',
    );
    work = { runs: Number(w?.n ?? 0), ok: Number(w?.ok ?? 0), totalMs: Number(w?.ms ?? 0), maxMs: Number(w?.maxms ?? 0), toolCalls: Number(w?.tc ?? 0), rounds: Number(w?.rd ?? 0) };
  } catch { /* 老库没有 work_runs 表：用量页其余部分照常 */ }

  return {
    generatedAt: Date.now(),
    firstDay: days[0]?.day ?? null,
    days,
    today: map.get(todayKey()) ?? null,
    totals: {
      prompt: sum((d) => d.prompt),
      completion: sum((d) => d.completion),
      tokens: sum((d) => d.tokens),
      cacheHit: sum((d) => d.cacheHit),
      cacheMiss: sum((d) => d.cacheMiss),
      calls: sum((d) => d.calls),
      msgIn: sum((d) => d.msgIn),
      msgOut: sum((d) => d.msgOut),
      activeDays: active.size,
      streak,
      bestStreak,
      peak: {
        tokens: peakOf((d) => d.tokens),
        msg: peakOf((d) => d.msgIn + d.msgOut),
        calls: peakOf((d) => d.calls),
      },
    },
    models,
    work,
  };
}
