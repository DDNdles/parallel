/**
 * 出站投递 —— 「一段回复怎么变成几条 QQ 消息」。
 *
 * 2026-10-17 起这一层是**纯程序**：模型输出什么就发什么。HDSI 的小说格式整层已删
 * （`<say>` 台词块、`<sep/>` 分隔标记、旁白、字数预算、Alter 标记），
 * 模型不再为格式多写一个字；"说几条、多长"由下面三步保证：
 *   1. `normalizeVisibleContent` 剥掉媒体占位符与模型手滑输出的标签，并按单条上限硬截断；
 *   2. `trimAtSentence` 句边截断兜底：回复超长时保留到最后一个句末标点，不把半句话拍出去；
 *   3. `splitIntoBubbles` 按换行与句末标点切成气泡（最多 10 条，超出时均衡合并）；
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
  /** 单条气泡目标字数：超过后在逗号/顿号处补切（0 = 用默认 24） */
  bubbleSoftMaxCharacters: number;
  /** 是否模拟「正在输入」的停顿（默认关：气泡之间立即发） */
  typingEnabled: boolean;
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
  replyMaxCharacters: 100,
  maxReplyTokens: 400,
  bubbleSoftMaxCharacters: 24,
  typingEnabled: false,
  typingBaseDelaySeconds: 1,
  typingCharactersPerSecond: 8,
  typingMaxDelaySeconds: 12,
  typingJitterRatio: 0.3,
  maxMessageCharacters: 2000,
};

/** 气泡数硬上限：连续发送（中间没有对方插话）最多 10 条 */
export const MAX_BUBBLES = 10;
/** 提示里的推荐总长（字）：硬上限由设置页 replyMaxCharacters 决定，必要情况可以突破推荐值 */
export const RECOMMENDED_REPLY_CHARS = 50;
/** 提示里的推荐气泡数（2～3 条）：硬上限是 MAX_BUBBLES，必要情况可以超过 3 条 */
export const RECOMMENDED_BUBBLES = 3;

/** 句末标点（切分与句边截断共用） */
const ENDERS = new Set([...'。！？!?…；;']);

/** 句末标点后面跟着的收尾符号（引号/括号等），跟同一句走 */
const CLOSERS = new Set([...'」』"”’）)】]']);

/** 长句补切点：逗号/顿号/冒号（只在句子超过目标字数时启用，短句仍然不切） */
const SOFT_BREAKS = new Set([...'，,、：:']);

/** 完全没有逗号可切时的硬上限：超过就按字数硬切，避免一条 50+ 字 */
const HARD_BUBBLE_CHARS = 40;

/**
 * 气泡清洁：去掉切分标点与句尾句号。
 * 保留问号/叹号/省略号（这些是语气，不是句末句号）；逗号/顿号/冒号/分号在切分点剥掉。
 */
function cleanBubble(text: string): string {
  let t = String(text ?? '').trim();
  // 句号/逗号等写在收尾引号或括号前时，只删标点、保留引号
  t = t.replace(/[。，,、：:；;]+([」』"”’）)】]*)$/g, '$1').trim();
  t = t.replace(/[。，,、：:；;]+$/g, '').trim();
  return t;
}

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
 * 单条句子超过目标字数时，优先在逗号/顿号/冒号处补切；没有可切点再按 40 字硬切。
 * 切点离句首太近（<8 字）或剩余太短（<4 字）时不切，避免切出碎泡。
 */
function splitLongBubble(text: string, softMax: number): string[] {
  const limit = Math.max(8, Math.floor(softMax || 24));
  const out: string[] = [];
  let rest = String(text ?? '').trim();
  while ([...rest].length > limit) {
    const chars = [...rest];
    const scanTo = Math.min(limit, chars.length);
    let cut = -1;
    for (let i = scanTo - 1; i >= 8; i--) {
      if (SOFT_BREAKS.has(chars[i])) { cut = i; break; }
    }
    if (cut >= 8 && chars.length - cut - 1 >= 4) {
      out.push(chars.slice(0, cut + 1).join('').trim());
      rest = chars.slice(cut + 1).join('').trim();
      continue;
    }
    if (chars.length > HARD_BUBBLE_CHARS) {
      let hard = HARD_BUBBLE_CHARS;
      // 优先在靠后的空格处切；中文没有空格就按 40 字切
      for (let i = HARD_BUBBLE_CHARS - 1; i >= Math.floor(HARD_BUBBLE_CHARS / 2); i--) {
        if (/\s/.test(chars[i])) { hard = i; break; }
      }
      out.push(chars.slice(0, hard).join('').trim());
      rest = chars.slice(hard).join('').trim();
      continue;
    }
    break;
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 超过 maxBubbles 时，把相邻句贪心/DP 合并成 maxBubbles 组：
 * 目标是最小化“最长组”的字数，保持原句顺序与标点；不再把尾巴全粘到最后一组。
 */
function mergeToCap(parts: string[], maxBubbles: number): string[] {
  const n = parts.length;
  const cap = Math.max(1, Math.floor(maxBubbles));
  if (n <= cap) return parts;
  const lens = parts.map((p) => [...p].length);
  const prefix = [0];
  for (const len of lens) prefix.push(prefix[prefix.length - 1] + len);

  // dp[g][i] = 前 i 个句分成 g 组时，最长组的最小字数
  const dp: number[][] = Array.from({ length: cap + 1 }, () => Array(n + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: cap + 1 }, () => Array(n + 1).fill(-1));
  for (let i = 1; i <= n; i++) dp[1][i] = prefix[i];
  for (let g = 2; g <= cap; g++) {
    for (let i = g; i <= n; i++) {
      for (let j = g - 1; j < i; j++) {
        const groupLen = prefix[i] - prefix[j];
        const worst = Math.max(dp[g - 1][j], groupLen);
        if (worst < dp[g][i]) {
          dp[g][i] = worst;
          cut[g][i] = j;
        }
      }
    }
  }

  const groups: string[] = [];
  let i = n;
  for (let g = cap; g >= 1; g--) {
    const j = cut[g][i];
    if (j < 0) break;
    groups.unshift(parts.slice(j, i).join(''));
    i = j;
  }
  if (i > 0) groups.unshift(parts.slice(0, i).join(''));
  return groups;
}

/**
 * 按换行与句末标点把一段话切成气泡（最贴近真人"一句一条"的打字节奏）。
 *  - 换行是最强的分条意图：模型自己换的行不合并；
 *  - 句末标点后切；连续标点（？！？…）并作同一个句尾；引号/右括号跟着前一句走；
 *  - 单句超过 softMax（默认 24 字）时，再在逗号/顿号/冒号处补切；
 *  - 超过 maxBubbles 时做**均衡连续分组**，保持 10 条上限、不把尾巴全粘最后一条。
 */
export function splitIntoBubbles(text: string, maxBubbles = MAX_BUBBLES, softMax = 24): string[] {
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
  const pieces = out
    .flatMap((b) => splitLongBubble(b, softMax))
    .map(cleanBubble)
    .filter(Boolean);
  return mergeToCap(pieces, maxBubbles);
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
