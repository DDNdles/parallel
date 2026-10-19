/**
 * 回复必要性打分 —— 移植自 MaiBot `src/maisaka/reply_necessity.py`（常量、权重、公式逐条对齐）。
 *
 * 决定「这条消息值不值得我开口」，纯函数、不调模型：
 *   final = round((相关性 + 内容 + 积压压力 - 存在感惩罚) × (0.5 + 0.5 × 频率))
 * 达到阈值才进 agent loop。这套东西是「像群友」与「像问答机器人」的分水岭。
 */

export const NECESSITY_TRIGGER_SCORE = 80;
export const NECESSITY_PRESSURE_STANDARD_SCORE = 50;
export const NECESSITY_PRESSURE_MAX_SCORE = 100;
export const NECESSITY_PRESSURE_FULL_RATIO = 5.0;
export const NECESSITY_IDLE_PRESSURE_BONUS = 15;
export const NECESSITY_RECENT_SELF_RATIO_FREE = 0.25;
export const NECESSITY_RECENT_SELF_RATIO_FULL = 0.6;
export const NECESSITY_RECENT_SELF_PENALTY_MAX = 25;

const DIRECT_REQUEST_TERMS = ['帮我', '帮忙', '能不能', '可以吗', '要不要'];
const WEAK_REQUEST_TERMS = ['需要', '求', '看看', '试试'];
const QUESTION_TERMS = ['怎么', '如何', '为什么', '有没有'];
const OPINION_TERMS = ['你觉得', '你认为', '咋看', '有什么建议'];
const SHORT_REACTIONS = new Set(['哈哈', '哈哈哈', '草', '笑死', '好', '嗯', '啊', '哦', '6', '666', '？', '?']);
const MEDIA_PLACEHOLDER_PREFIXES = ['[CQ:image', '[图片：', '[表情包:', '[文件]', '[语音:', '[卡片:'];
const IGNORED_TEXT_PREFIXES = ['【合并转发消息:', ...MEDIA_PLACEHOLDER_PREFIXES, '本群发言榜'];
/** 别人在跟别的 AI 说话，不算在跟我说话（MaiBot 原表） */
const OTHER_ASSISTANT_ADDRESSEE = /^(?:DeepSeek|ChatGPT|Grok|豆包|千问|元宝|通义|Kimi|Claude)[，,、\s]/;

export interface NecessityInput {
  /** 当前积压待判的这批消息原文 */
  texts: string[];
  /** 积压条数（未处理的消息数） */
  pendingCount: number;
  /** 条数阈值：压力分以它为单位，空窗补偿也用它 */
  triggerThreshold: number;
  hasAt: boolean;
  hasMention: boolean;
  isGroupChat: boolean;
  /** 最近窗口内自己发了几条 */
  recentSelfReplies: number;
  /** 最近窗口内总消息数 */
  recentWindowMessages: number;
  /** 0–1，越大越爱说（talk_value 求值结果） */
  effectiveFrequency: number;
  idleSeconds: number;
  idleReachedAverage: boolean;
}

export interface NecessityScore {
  score: number;
  detail: string;
  pressureScore: number;
  /** likelihood 模式把旧公式降级成特征用：这里给出各分项原值 */
  parts: { relevance: number; content: number; pressure: number; presence: number };
}

/** 剥掉引用、媒体占位、合并转发、@ 提及，只留用户当前发言主体 */
export function stripNecessityNoise(text: string): string {
  let s = String(text ?? '').split(/\s+/).filter(Boolean).join(' ').trim();
  if (s.startsWith('@all')) return '';
  if (s.startsWith('[回复了') && s.includes('【合并转发消息:')) return '';
  if (IGNORED_TEXT_PREFIXES.some((p) => s.startsWith(p))) return '';

  s = s.replace(/^\[CQ:reply[^\]]*\]\s*/, '');
  s = s.replace(/^\[reply\]\s*/, '');
  s = s.replace(/^\[回复了.+?的消息: .+?\]\s*/, '');
  const legacy = s.match(/\]，说：\s*(.+)$/);
  if (legacy) s = legacy[1];
  s = s.replace(/^\[回复消息\]\s*/, '');
  s = s.replace(/^\[回复了一条消息，但原消息已无法访问\]\s*/, '');
  s = s.replace(/@<[^>]+>|@\S+/g, '').trim();
  if (MEDIA_PLACEHOLDER_PREFIXES.some((p) => s.startsWith(p))) return '';
  return s.trim();
}

/** 待处理消息是否基本是短反应或纯占位内容 */
export function isShortReactionBatch(texts: string[]): boolean {
  const norm = texts.map((t) => t.split(/\s+/).filter(Boolean).join(' ').trim()).filter(Boolean);
  if (!norm.length) return true;
  if (norm.some((t) => [...t].length > 8)) return false;
  return norm.every((t) => SHORT_REACTIONS.has(t));
}

/** 当前发言是否像一个真实问题 */
export function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  if (/^[？?！!~～…\s]+[\w\u4e00-\u9fff]{1,4}[？?！!~～…\s]+$/.test(text)) return false;
  if (QUESTION_TERMS.some((t) => text.includes(t))) return true;
  if (/(?<![这那没])什么/.test(text)) return true;
  if (/[吗呢][？?。！!~～…]*$/.test(text) && text.length >= 4 && text.length <= 80) return true;
  return /[？?](?:$|[。！!~～…])/.test(text) && text.length >= 4 && text.length <= 120;
}

function requestReason(text: string, directContext: boolean): string {
  if (!directContext && OTHER_ASSISTANT_ADDRESSEE.test(text)) return '';
  const hits = DIRECT_REQUEST_TERMS.filter((t) => text.includes(t));
  if (hits.includes('能不能') && !(directContext || text.startsWith('能不能'))) {
    hits.splice(hits.indexOf('能不能'), 1);
  }
  if (!directContext) {
    for (const weak of ['可以吗', '要不要']) {
      const i = hits.indexOf(weak);
      if (i >= 0) hits.splice(i, 1);
    }
  }
  if (hits.length) return hits.join('/');
  if (directContext) {
    const weak = WEAK_REQUEST_TERMS.filter((t) => text.includes(t));
    if (weak.length) return weak.join('/');
  }
  return '';
}

function opinionReason(text: string, directContext: boolean, botName: string): string {
  if (text.includes('不怎么看')) return '';
  if (!directContext && botName && !text.includes(botName)) return '';
  const hits = OPINION_TERMS.filter((t) => text.includes(t));
  if (hits.length) return hits.join('/');
  const name = botName ? botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '你';
  if (new RegExp(`(?:你|${name}).{0,6}怎么看|怎么看.{0,6}(?:你|${name})`).test(text)) return '怎么看';
  return '';
}

function scoreContent(
  cleaned: string[],
  combined: string,
  directContext: boolean,
  botName: string,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (cleaned.some((t) => looksLikeQuestion(t))) { score += 15; reasons.push('问题'); }

  const req = requestReason(combined, directContext);
  if (req) { score += 20; reasons.push(`请求:${req}`); }

  const op = opinionReason(combined, directContext, botName);
  if (op) { score += 20; reasons.push(`征询:${op}`); }

  const len = [...combined].length;
  if (len >= 40) { score += 5; reasons.push('长文本'); }
  if (len >= 120) { score += 10; reasons.push('较长文本'); }
  if (isShortReactionBatch(cleaned)) { score -= 25; reasons.push('短反应'); }
  return { score, reasons };
}

/** 按积压消息量算压力分：阈值内二次增长，超过阈值后对数增长 */
export function pressureScore(
  pendingCount: number,
  threshold: number,
  idleReachedAverage: boolean,
): number {
  const norm = Math.max(1, threshold);
  const ratio = Math.max(0, pendingCount / norm);
  if (ratio <= 1) {
    let s = Math.round(NECESSITY_PRESSURE_STANDARD_SCORE * ratio * ratio);
    if (idleReachedAverage) s += NECESSITY_IDLE_PRESSURE_BONUS;
    return Math.min(NECESSITY_PRESSURE_STANDARD_SCORE, s);
  }
  const overflow = ratio - 1;
  const fullOverflow = NECESSITY_PRESSURE_FULL_RATIO - 1;
  const factor = Math.min(1, Math.log1p(overflow) / Math.log1p(fullOverflow));
  const s = NECESSITY_PRESSURE_STANDARD_SCORE
    + Math.round((NECESSITY_PRESSURE_MAX_SCORE - NECESSITY_PRESSURE_STANDARD_SCORE) * factor);
  return Math.min(NECESSITY_PRESSURE_MAX_SCORE, s);
}

/** 按最近窗口内自己发言占比算存在感惩罚（防自说自话刷屏） */
export function presencePenalty(recentSelfReplies: number, recentWindowMessages: number): number {
  if (recentSelfReplies <= 0 || recentWindowMessages <= 0) return 0;
  const ratio = Math.min(1, recentSelfReplies / recentWindowMessages);
  if (ratio <= NECESSITY_RECENT_SELF_RATIO_FREE) return 0;
  const span = NECESSITY_RECENT_SELF_RATIO_FULL - NECESSITY_RECENT_SELF_RATIO_FREE;
  const progress = Math.min(1, (ratio - NECESSITY_RECENT_SELF_RATIO_FREE) / span);
  return Math.round(NECESSITY_RECENT_SELF_PENALTY_MAX * progress);
}

export function scoreReplyNecessity(input: NecessityInput, botName = ''): NecessityScore {
  const threshold = Math.max(1, input.triggerThreshold);

  let relevance: number;
  let relevanceReason: string;
  if (input.hasAt) { relevance = 100; relevanceReason = '@'; }
  else if (input.hasMention) { relevance = 80; relevanceReason = '提及'; }
  else if (!input.isGroupChat) { relevance = 40; relevanceReason = '私聊'; }
  else { relevance = 0; relevanceReason = '普通'; }

  const directContext = relevance > 0;
  const cleaned = input.texts.map(stripNecessityNoise);
  const combined = cleaned.filter(Boolean).join('\n');
  const content = scoreContent(cleaned, combined, directContext, botName);
  const pressure = pressureScore(input.pendingCount, threshold, input.idleReachedAverage);
  const penalty = presencePenalty(input.recentSelfReplies, input.recentWindowMessages);

  const raw = relevance + content.score + pressure - penalty;
  const freq = Math.min(1, input.effectiveFrequency);
  const factor = 0.5 + 0.5 * freq;
  const score = Math.max(0, Math.round(raw * factor));

  const parts = [`最终=${score}`, `原始=${raw}`];
  if (relevance !== 0) parts.push(`强相关=${relevance}(${relevanceReason})`);
  if (content.score !== 0) parts.push(`内容=${content.score}(${content.reasons.join(',')})`);
  if (penalty !== 0) parts.push(`存在感=-${penalty}(5min=${input.recentSelfReplies}/${input.recentWindowMessages})`);
  parts.push(`频率=${freq.toFixed(3)}`, `倍率=${factor.toFixed(2)}`);

  return { score, detail: parts.join(' '), pressureScore: pressure, parts: { relevance, content: content.score, pressure, presence: penalty } };
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
