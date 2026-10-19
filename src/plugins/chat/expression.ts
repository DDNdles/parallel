/**
 * 表达学习（chat 插件的后台通道）—— 学「什么情境下这个群的人怎么说」。
 *
 * 与黑话的分工：黑话学词义（听懂），这里学口径（怎么说）。学习素材只取群聊里
 * 真实群友的发言，不取 bot 自己的话、命令和媒体占位；学到的是「情境 → 说法 + 关键词」，
 * 注入时只当语气参考，明确要求不许照抄原句、不许解释自己在模仿。
 *
 * 纯逻辑放这里（提示词 / 解析 / 去重 / 选择 / 分节），模型调用与计时器在 index.ts，
 * 这样解析边界可以单测，不依赖真模型输出。
 */

export interface ExpressionMessage {
  ts: number;
  userId: string;
  nickname: string;
  text: string;
}

export interface ExpressionEntry {
  /** 当时在聊什么 */
  situation: string;
  /** 群友实际的说法/口吻 */
  style: string;
  /** 用来跟当前上下文做机械匹配的关键词 */
  keys: string[];
  at: number;
}

export interface ExpressionCfg {
  enable: boolean;
  minMessages: number;
  idleSeconds: number;
  maxPerChat: number;
  injectMax: number;
}

export interface ExpressionQueueGroup {
  messages: ExpressionMessage[];
  lastLearnAt: number;
  fails: number;
}
export type ExpressionQueue = Record<string, ExpressionQueueGroup>;

/** 单群最多攒多少条待学习消息（失败/一直热闹时不无限膨胀） */
export const EXPRESSION_QUEUE_MAX = 80;
/** 一次最多交给模型多少条 */
export const EXPRESSION_BATCH_MAX = 50;
/** 连续失败这么多次就丢掉半批，别拿同一坨坏输入反复烧模型 */
export const EXPRESSION_MAX_FAILS = 3;
/** 这类纯语气词不当作"表达"学（没有模仿价值） */
const TRIVIAL = new Set([
  '哈哈', '哈哈哈', '哈哈哈哈', '嗯', '嗯嗯', '哦', '噢', '好的', '好', '可以', '确实',
  '真的', '笑死', '不知道', '没事', '是的', '对啊', '收到', '在吗', '有人吗',
]);

export const EXPRESSION_SYSTEM = [
  '你是群聊表达方式整理助手。给你一段 QQ 群里群友的真实发言，找出其中**有群味、值得参考的说法**。',
  '规则：',
  '- 只学「什么情境下大家怎么说话」，不学观点、不学事实、不学人设。',
  '- 只收有辨识度的口吻/用词/句式；普通陈述、客气话、纯语气词、脏话、人身攻击都不要。',
  '- 每条给出三样：situation（当时在聊什么，一句话）、style（群友实际的说法，尽量保留原味）、keys（1~3 个关键词，供之后按上下文匹配）。',
  '- 不引用具体人的隐私信息；不要编造没出现过的说法；没有就输出空数组。',
  '只输出一行 JSON：{"expressions":[{"situation":"...","style":"...","keys":["..."]}]}',
].join('\n');

export function buildExpressionPrompt(messages: ExpressionMessage[], existing: string[]): string {
  return [
    existing.length ? `已经学过的说法（不要重复）：\n${existing.slice(0, 20).map((s) => `- ${s}`).join('\n')}` : '已经学过的说法：（无）',
    '',
    `群聊原文（共 ${messages.length} 条，按时间正序）：`,
    ...messages.map((m) => `${m.nickname || m.userId}：${m.text}`),
    '',
    '最多输出 6 条表达；没有值得学的就输出 {"expressions":[]}。',
  ].join('\n');
}

/** 去掉首尾引号/空白，压掉换行 */
function clean(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim().slice(0, max);
}

/** 去重口径：只比较字面（去标点、小写），不碰含义 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '');
}

function pickJson(text: string): unknown {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

/** 模型不听话时从文本里兜底抽关键词（优先用模型给的，没给就拿说法本身） */
function fallbackKeys(situation: string, style: string): string[] {
  const out = new Set<string>();
  for (const part of `${situation} ${style}`.split(/[\s，,。！？!?；;：:、~～…]+/)) {
    const t = part.trim();
    if ([...t].length >= 2 && [...t].length <= 12) out.add(t);
    if (out.size >= 3) break;
  }
  if (!out.size) out.add(style);
  return [...out];
}

/**
 * 解析模型输出 → 可落库的表达。
 * 跳过空项、纯语气词、过短/过长、与已有重复的；批内去重；限长限量。
 */
export function parseExpressions(text: string, existing: ExpressionEntry[], cap: number, now: number): ExpressionEntry[] {
  const payload = pickJson(text);
  const list = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as { expressions?: unknown }).expressions)
      ? (payload as { expressions: unknown[] }).expressions
      : []);
  const seen = new Set(existing.map((e) => norm(e.style)).filter(Boolean));
  const out: ExpressionEntry[] = [];
  for (const raw of list) {
    const item = typeof raw === 'string' ? { style: raw } : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null);
    if (!item) continue;
    const situation = clean(item.situation ?? item.context ?? '', 80);
    const style = clean(item.style ?? item.saying ?? item.text ?? '', 40);
    if (!situation || !style) continue;
    const styleKey = norm(style);
    if (!styleKey || TRIVIAL.has(styleKey)) continue;
    if (seen.has(styleKey)) continue;
    const keysRaw = Array.isArray(item.keys) ? item.keys : [];
    const keys = [...new Set(keysRaw.map((k) => clean(k, 12)).filter((k) => [...k].length >= 1))].slice(0, 3);
    seen.add(styleKey);
    out.push({ situation, style, keys: keys.length ? keys : fallbackKeys(situation, style), at: now });
    if (out.length >= Math.max(1, cap)) break;
  }
  return out;
}

/** 新旧合并：同说法保新的；按时间排序后只留最近 maxPerChat 条 */
export function mergeExpressions(existing: ExpressionEntry[], learned: ExpressionEntry[], maxPerChat: number): ExpressionEntry[] {
  const byKey = new Map<string, ExpressionEntry>();
  for (const e of [...existing, ...learned]) {
    if (!e || typeof e.style !== 'string') continue;
    const k = norm(e.style);
    if (!k) continue;
    byKey.set(k, e);
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at).slice(-Math.max(1, maxPerChat));
}

/** 这批消息是否到了学习时机（攒够 + 群已安静） */
export function expressionDue(messages: ExpressionMessage[], cfg: ExpressionCfg, now: number): boolean {
  if (!cfg.enable || messages.length < Math.max(1, cfg.minMessages)) return false;
  const last = messages[messages.length - 1]?.ts ?? 0;
  return now - last >= Math.max(0, cfg.idleSeconds) * 1000;
}

/**
 * 选这次注入哪几条：
 *  - 关键词在当前上下文里命中的优先（每个命中 +3）；
 *  - 同分按新旧排，避免永远是同几条；
 *  - 一条都没命中时仍给最近 max 条当"群味参考"（不相关也比没有强）。
 * `rng` 只用于同分打散，测试可注入。
 */
export function selectExpressions(
  entries: ExpressionEntry[],
  recentText: string,
  max: number,
  rng: () => number = Math.random,
): ExpressionEntry[] {
  const limit = Math.max(0, Math.floor(max));
  if (limit <= 0 || !entries.length) return [];
  const text = String(recentText ?? '').toLowerCase();
  const scored = entries.map((e) => {
    const hits = e.keys.filter((k) => k && text.includes(String(k).toLowerCase())).length;
    return { e, score: hits * 3, tie: rng() };
  });
  scored.sort((a, b) => b.score - a.score || b.e.at - a.e.at || a.tie - b.tie);
  // 一条都没命中时只给最近的两条当"群味参考"；4 条全塞进去会让她每轮都在学口音
  const hits = scored.some((x) => x.score > 0);
  return scored.slice(0, hits ? limit : Math.min(limit, 2)).map((x) => x.e);
}

/** 注入分节：参考语气，不照抄 */
export function expressionSection(entries: ExpressionEntry[]): string | null {
  if (!entries.length) return null;
  return [
    '# 本群的说法（参考）',
    '下面是群友聊天里出现过的真实说法。参考它们的口吻和用词；别照抄原句，也别解释你在模仿。',
    ...entries.map((e) => `- 情境：${e.situation} → 「${e.style}」`),
  ].join('\n');
}
