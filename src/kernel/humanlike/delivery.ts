/**
 * 出站投递 —— 「一段回复怎么变成几条 QQ 消息」。
 *
 * 2026-10-17 起这一层是**纯程序**：模型输出什么就发什么。HDSI 的小说格式整层已删
 * （`<say>` 台词块、`<sep/>` 分隔标记、旁白、字数预算、Alter 标记），
 * 模型不再为格式多写一个字；"说几条、多长"由下面三步保证：
 *   1. `normalizeVisibleContent` 剥掉媒体占位符与模型手滑输出的标签，并按单条上限硬截断；
 *   2. `trimAtSentence` 句边截断兜底：回复超长时保留到最后一个句末标点，不把半句话拍出去；
 *   3. `splitIntoBubbles` 按换行与句末标点切成气泡（最多 4 条，尾巴并进最后一条）；
 *      `typingDelayMs` 算第二条及后续气泡的「正在输入」等待 —— 基础延迟 + 字数/速度，
 *      乘抖动，下限 250ms。首条不等（用户已经等过模型了）。
 */

export interface OutgoingConfig {
  /** 是否把回复按换行/句子拆成多条 QQ 消息（关掉 = 整段一条发出去） */
  splitReplyMessages: boolean;
  /** 回复总长上限（字符）：超了在最后一个句末标点处截断 —— 「说得短」的硬兜底 */
  replyMaxCharacters: number;
  /** chat 轮单次请求的输出 token 硬顶（防止模型写小作文；<=0 = 不设） */
  maxReplyTokens: number;
  /** 发送第二条及后续分段消息前的基础打字等待秒数 */
  typingBaseDelaySeconds: number;
  /** 模拟打字速度，每秒字符数；越小长消息等得越久 */
  typingCharactersPerSecond: number;
  /** 单条后续分段消息的最长打字等待秒数 */
  typingMaxDelaySeconds: number;
  /** 打字延迟随机浮动比例，0 = 固定延迟 */
  typingJitterRatio: number;
  /** 单条可见消息的最大字符数（平台硬上限的安全垫） */
  maxMessageCharacters: number;
}

export const DEFAULT_OUTGOING: OutgoingConfig = {
  splitReplyMessages: true,
  replyMaxCharacters: 120,
  maxReplyTokens: 400,
  typingBaseDelaySeconds: 1,
  typingCharactersPerSecond: 8,
  typingMaxDelaySeconds: 12,
  typingJitterRatio: 0.3,
  maxMessageCharacters: 2000,
};

/** 气泡数上限：再多就把尾巴并进最后一条 —— 打字等待按条累加，放任切分会把回复拖到半分钟 */
export const MAX_BUBBLES = 4;

/** 句末标点（切分与句边截断共用） */
const ENDERS = new Set([...'。！？!?…；;']);

/** 句末标点后面跟着的收尾符号（引号/括号等），跟同一句走 */
const CLOSERS = new Set([...'」』"”’）)】]']);

/**
 * 字符串则 trim 后截断，非字符串给空串（硬截断，不重切、不丢弃整条）。
 */
export function clip(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, Math.max(1, Math.floor(length))) : '';
}

/**
 * 归一化可见正文：剥媒体占位符、剥模型手滑输出的标签，最后 trim + 按 `maxMessageCharacters` 截断。
 *
 * 两类标签要处理：
 *  - **成对的 `say` 标记**：剧本体删除后模型有时还带着旧习惯（或读到窗口里没退干净的旧消息）写出
 *    `<say id="s1">…</say>` —— 把它们剥掉、留着里面的话，这是迁移期的兜底，不是格式约定；
 *  - 其它自闭标签（`<set_mood mood="…"/>` 这类模型自造的记号）一律整体剥掉。
 */
export function normalizeVisibleContent(value: unknown, maxCharacters: number): string {
  return String(value ?? '')
    // 成对的 say 标记（迁移期兜底）：剥掉标签、留着里面的话
    .replace(/<\/?say\b[^>]*>/gi, '')
    // 旧分隔标记（迁移期兜底）：模型偶尔还写 <sep/> / <br/>，当作换行——那是分条意图，别把记号发出去
    .replace(/<\/?(?:sep|br)\b[^>]*\/?>/gi, '\n')
    // 其它模型自造的（自闭）标签整体剥掉
    .replace(/<[a-z_][a-z0-9_]*(?:\s[^>]*)?\/>/gi, '')
    .replace(/<\/?(?:file|img|image|audio|record|video|flash|mface)\b[^>]*\/?>/gi, '')
    .replace(/\[CQ:(?:file|image|record|video|flash|mface),[^\]]*\]/gi, '')
    .replace(/[\[【](?:表情包?|图片|动图|GIF)[\]】]/gi, '')
    .replace(/[\[【](?:流汗|微笑|笑哭|尴尬|爱心|惊讶|流泪|委屈)[\]】]/gi, '')
    .trim()
    .slice(0, Math.max(1, Math.floor(maxCharacters)));
}

/**
 * 句边截断：超过 `maxChars` 时保留到最后一个句末标点（或换行）。
 * 句边落在后半段才按句截（前半段就出现句号的话，截出来只剩一两句碎话，不如硬切）；
 * 找不到像样的句边就硬切。**只在超长时触发** —— 正常轮碰不到它。
 */
export function trimAtSentence(text: string, maxChars: number): string {
  const t = String(text ?? '').trim();
  const limit = Math.max(1, Math.floor(maxChars));
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  let cut = -1;
  for (const ch of ENDERS) {
    const i = head.lastIndexOf(ch);
    if (i > cut) cut = i;
  }
  const nl = head.lastIndexOf('\n');
  if (nl > cut) cut = nl;
  return cut >= Math.floor(limit / 2) ? head.slice(0, cut + 1).trim() : head.trim();
}

/**
 * 按换行与句末标点把一段话切成气泡（最贴近真人"一句一条"的打字节奏）。
 *  - 换行是最强的分条意图：模型自己换的行不合并；
 *  - 句末标点后切；连续标点（？！？…）并作同一个句尾；引号/右括号跟着前一句走；
 *  - 超过 `maxBubbles` 的尾巴并进最后一条：宁可最后一条长一点，也不丢字、不无限累加打字等待。
 */
export function splitIntoBubbles(text: string, maxBubbles = MAX_BUBBLES): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split(/\r?\n+/)) {
    let buf = '';
    for (let i = 0; i < line.length; i++) {
      buf += line[i];
      if (!ENDERS.has(line[i])) continue;
      // 连续标点与收尾符号（」』"）并进同一句
      let j = i + 1;
      while (j < line.length && (ENDERS.has(line[j]) || CLOSERS.has(line[j]))) { buf += line[j]; j++; }
      i = j - 1;
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
    if (buf.trim()) out.push(buf.trim());
  }
  const cap = Math.max(1, Math.floor(maxBubbles));
  if (out.length <= cap) return out;
  return [...out.slice(0, cap - 1), out.slice(cap - 1).join('')];
}

/**
 * 「第二条及后续气泡」的打字等待（毫秒）：
 *   nominal = min(cap, base + ceil(len / cps))     ← len 用 JS UTF-16 长度
 *   factor  = 1 ± jitter（jitter=0 时正好为 1）
 *   结果    = clamp(nominal × factor × 1000, 下限 250ms, 上限 cap)
 *
 * 没有"0 = 不模拟打字"这一档，最低也有 250ms。`rng` 只用于测试注入，默认 Math.random。
 */
export function typingDelayMs(
  nextSegment: string,
  cfg: Pick<OutgoingConfig, 'typingBaseDelaySeconds' | 'typingCharactersPerSecond' | 'typingMaxDelaySeconds' | 'typingJitterRatio'>,
  rng: () => number = Math.random,
): number {
  const baseSeconds = Math.max(0, cfg.typingBaseDelaySeconds ?? 1);
  const charactersPerSecond = Math.max(1, cfg.typingCharactersPerSecond ?? 8);
  const maximumSeconds = Math.max(baseSeconds, cfg.typingMaxDelaySeconds ?? 12);
  const nominal = Math.min(maximumSeconds, baseSeconds + Math.ceil(String(nextSegment ?? '').length / charactersPerSecond));
  const jitter = Math.max(0, Math.min(0.5, Number(cfg.typingJitterRatio ?? 0.3) || 0));
  const factor = jitter ? 1 + (rng() * 2 - 1) * jitter : 1;
  return Math.max(250, Math.min(maximumSeconds * 1000, Math.round(nominal * factor * 1000)));
}

/**
 * 「这一轮不说话」的显式标记。
 * 自由文本里用一个不会被误当台词的字面量等价表达（旧写法 `SKIP` 继续兼容）。
 */
export const SILENT_MARKER = '[silent]';

export function isSilentScene(text: string): boolean {
  // 只留字母/数字/汉字：方括号、句读、空白、星号一律无视（模型有时会写成"【silent】"）
  const s = text.replace(/[^\w一-鿿]/g, '').toUpperCase();
  return s === 'SKIP' || s === 'SILENT';
}
