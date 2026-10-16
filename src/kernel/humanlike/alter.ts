/**
 * Alter 情绪偏移追踪 —— 移植 HDSI `src/alter.ts`（常量与状态转移逐行对齐）。
 *
 * 解决的问题：「长期对话里角色说话风格趋同、情绪表达固定化」。
 * 机制：每轮模型在剧本里额外给一个整数 `<alter>±n</alter>`（-5..+5），表示**本轮新事件
 * 相对上一轮让整体氛围发生的净变化**。累计到动态阈值后跑一次侧端分析，得出一段
 * 「氛围参考」（serious/relaxed + 描述 + 强度），之后若干轮注入；方向反复翻转时权重衰减，
 * 低于 minWeight 就自然过期 —— 所以它只增加临时氛围，不替代任何人设。
 *
 * 阈值是动态的：一小时里轮次越密（最多 10 轮算满），阈值越低（最低 base×0.5），
 * 因为聊得越密，氛围本来就该动得越快。
 */

export interface AlterConfig {
  enabled: boolean;
  /** 基准阈值（未计密度时） */
  baseThreshold: number;
  /** 密度系数：0 = 不看聊天密度，1 = 密度直接决定阈值 */
  densityFactor: number;
  /** 同向继续时权重每点涨多少 */
  sameDirectionBoost: number;
  /** 反向时每点衰减多少 */
  oppositeDecay: number;
  /** 权重低于它就过期 */
  minWeight: number;
  /** 强度上限 */
  maxIntensity: number;
}

/** 默认值照 HDSI `DEFAULT_ALTER_SYSTEM_CONFIG`（与模型相关的 provider/model 字段我们不需要） */
export const DEFAULT_ALTER: AlterConfig = {
  enabled: true,
  baseThreshold: 10,
  densityFactor: 0.3,
  sameDirectionBoost: 0.05,
  oppositeDecay: 0.15,
  minWeight: 0.2,
  maxIntensity: 2,
};

/** 剧本里声明本轮净氛围变化的标记（HDSI 用结构化字段，我们用行内标记，解析后从剧本里摘掉） */
const ALTER_RE = /<alter>\s*([+-]?\d+)\s*<\/alter>/i;

export interface AlterOffset {
  direction: 'serious' | 'relaxed';
  description: string;
  intensity: number;
  at: number;
}

export interface AlterState {
  /** 待分析的累计值（各关系分支之和） */
  value: number;
  /** 氛围参考的权重 0..1 */
  weight: number;
  lastDirection: -1 | 0 | 1;
  offset: AlterOffset | null;
  history: { at: number; value: number }[];
  lastAnalyzeAt: number;
  /** 连续"分析了但没改善"的次数，用于熔断 */
  exhausted: number;
}

export function createAlterState(): AlterState {
  return { value: 0, weight: 0, lastDirection: 0, offset: null, history: [], lastAnalyzeAt: 0, exhausted: 0 };
}

/** 从模型输出里摘出 alter 值，并返回去掉标记的文本 */
export function readAlter(text: string): { value?: number; text: string } {
  const m = text.match(ALTER_RE);
  if (!m) return { text };
  return { value: normalizeAlterValue(Number(m[1])), text: text.replace(ALTER_RE, '').trim() };
}

/** clamp 到 -5..5 并取整（HDSI `normalizeAlterValue`） */
export function normalizeAlterValue(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(-5, Math.min(5, Math.round(v)));
}

/** 同向加权、反向衰减，钳在 0..1（HDSI `adjustAlterWeight`） */
export function adjustAlterWeight(weight: number, sameDirection: boolean, magnitude: number, cfg: AlterConfig): number {
  const rate = sameDirection ? cfg.sameDirectionBoost : -cfg.oppositeDecay;
  return clamp01(weight + Math.max(0, magnitude) * rate);
}

/** 动态阈值：一小时内轮次越密阈值越低（HDSI `calculateAlterThreshold`） */
export function calculateAlterThreshold(history: { at: number }[], cfg: AlterConfig, now: number): number {
  const turns = history.filter((h) => h.at >= now - 3600_000).length;
  const density = Math.min(turns / 10, 1);
  const base = Math.max(1, cfg.baseThreshold);
  const factor = clamp01(cfg.densityFactor);
  return Math.max(base * 0.5, base * (1 - density * factor));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface AlterAdvance {
  state: AlterState;
  threshold: number;
  thresholdReached: boolean;
  offsetExpired: boolean;
}

/**
 * 推进一轮：累计 alter、按方向调整权重、判阈值。
 * 命中阈值只表示"该跑一次侧端分析了"，**可见回复不等它**（HDSI 同款）。
 */
export function advanceAlter(state: AlterState, alter: number, now: number, cfg: AlterConfig): AlterAdvance {
  const next: AlterState = { ...state, history: [...state.history] };
  next.value = Math.max(-1000, Math.min(1000, next.value + alter));
  const direction = Math.sign(alter) as -1 | 0 | 1;

  let offsetExpired = false;
  if (next.offset && direction) {
    next.weight = adjustAlterWeight(next.weight, direction === next.lastDirection, Math.abs(alter), cfg);
    if (next.weight < cfg.minWeight) {
      next.offset = null;
      next.weight = 0;
      offsetExpired = true;
    }
  }
  if (direction) next.lastDirection = direction;
  next.history.push({ at: now, value: alter });
  if (next.history.length > 40) next.history.splice(0, next.history.length - 40);

  const threshold = calculateAlterThreshold(next.history, cfg, now);
  return { state: next, threshold, thresholdReached: Math.abs(next.value) >= threshold, offsetExpired };
}

/** 该不该跑侧端分析：命中阈值 + 未在冷却中（HDSI 用 5 分钟冷却） */
export function shouldAnalyzeAlter(state: AlterState, now: number, cooldownMs = 5 * 60_000): boolean {
  return state.lastAnalyzeAt > 0 && now - state.lastAnalyzeAt < cooldownMs ? false : true;
}

/**
 * 侧端分析回来：写氛围参考、清零待分析值、重置权重方向。
 * `description` 是侧端模型给的短描述（不许含姓名/引用/私聊细节，HDSI 有这条硬要求）。
 */
export function applyAlterAnalysis(
  state: AlterState,
  result: { direction: 'serious' | 'relaxed'; description: string; intensity: number },
  now: number,
  cfg: AlterConfig,
): AlterState {
  const intensity = Math.max(0, Math.min(cfg.maxIntensity, Math.round(result.intensity)));
  return {
    ...state,
    value: 0,
    weight: intensity > 0 ? Math.max(cfg.minWeight, intensity / cfg.maxIntensity) : 0,
    offset: intensity > 0
      ? { direction: result.direction, description: result.description.slice(0, 120), intensity, at: now }
      : null,
    lastAnalyzeAt: now,
  };
}

/** 供注入的氛围参考；关掉/过期/权重不足都返回 null */
export function alterOffsetForPrompt(state: AlterState | undefined, cfg: AlterConfig): (AlterOffset & { weight: number }) | null {
  if (!cfg.enabled || !state?.offset || state.weight < cfg.minWeight) return null;
  return { ...state.offset, weight: state.weight };
}

// ---------------------------------------------------------------- 侧端氛围分析

/** 侧端分析的输出契约（HDSI 用侧端模型把累计状态写成一段氛围描述） */
export const ALTER_ANALYSIS_SYSTEM = [
  '你在给一段长期对话累积出来的"氛围"写一句短描述，供角色之后的语气做底色参考。',
  '只输出 JSON：{"direction":"serious|relaxed","description":"一句话","intensity":0~N}',
  'description 必须是**纯氛围**：不许出现人名、昵称、引用原话、私聊细节，也不要写具体事件。',
  'intensity 是这段氛围该有多强，整数，0 表示几乎没有。',
].join('\n');

export function buildAlterPrompt(value: number, recent: string[]): string {
  return [
    `累计净变化：${value > 0 ? '+' : ''}${value}（正 = 越聊越放松，负 = 越聊越沉）`,
    recent.length ? `最近几轮回复的节奏签名：${recent.join('、')}` : '',
    '',
    '按上面的契约输出 JSON。',
  ].filter(Boolean).join('\n');
}

/** 解析侧端分析结果；不合法就返回 null（当作没分析过，下一轮再试） */
export function parseAlterAnalysis(raw: string): { direction: 'serious' | 'relaxed'; description: string; intensity: number } | null {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const direction = o.direction === 'serious' || o.direction === 'relaxed'
    ? o.direction
    : (o.direction === '认真' ? 'serious' : o.direction === '放松' ? 'relaxed' : null);
  if (!direction) return null;
  const description = String(o.description ?? '').trim();
  const intensity = Number(o.intensity);
  if (!description || !Number.isFinite(intensity)) return null;
  return { direction, description: description.slice(0, 120), intensity };
}
