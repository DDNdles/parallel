/**
 * 出站投递 —— 移植 HDSI `koishi-plugin-hds-interlude` 的输出侧（`runtime` 段）。
 *
 * HDSI 把"一段回复怎么变成几条 QQ 消息"压到极简，只有三件事：
 *   1. `splitOutgoingMessage` 按分隔标记（默认 `<sep/>`）字面切开 —— 没有断句、概率合并、
 *      颜文字保护、标点随机、错字、也没有 LLM 语义断句，这些一个都不存在。
 *      "一条为默认，只有真有节奏需要时才分条"是**提示词**要求模型自己做的（见 script.ts 的
 *      `scriptFormatText`），不是程序后处理。
 *   2. `normalizeVisibleContent` 归一化分隔标记的写法、剥掉媒体占位符，并按 `maxMessageCharacters`
 *      硬截断 —— **先截断整条再分段**（HDSI 原样；截断点之后的尾巴连同后面的气泡会一起丢掉）。
 *   3. `typingDelayMs` 算"第二条及后续气泡"的打字等待：基础延迟 + 字数/速度，乘抖动，下限 250ms。
 *      首条不等（用户已经等过模型了）。
 *
 * 对应 HDSI bundle：`splitOutgoingMessage` :10013、`typingDelayMilliseconds` :10019、
 * `normalizeVisibleMessageContent` :12185、`clip` :12652、`splitBubbles` :4941，
 * schema 默认值取自 `Runtime` :13315-13337。字段名与默认值逐条对齐。
 */

export interface OutgoingConfig {
  /** 是否把回复里的分隔标记拆成多条 QQ 消息（HDSI `runtime.splitReplyMessages`） */
  splitReplyMessages: boolean;
  /** 分段消息标记；模型在需要多条气泡时输出它（HDSI `runtime.messageSeparator`） */
  messageSeparator: string;
  /** 发送第二条及后续分段消息前的基础打字等待秒数（HDSI `runtime.typingBaseDelaySeconds`） */
  typingBaseDelaySeconds: number;
  /** 模拟打字速度，每秒字符数；越小长消息等得越久（HDSI `runtime.typingCharactersPerSecond`） */
  typingCharactersPerSecond: number;
  /** 单条后续分段消息的最长打字等待秒数（HDSI `runtime.typingMaxDelaySeconds`） */
  typingMaxDelaySeconds: number;
  /** 打字延迟随机浮动比例，0 = 固定延迟（HDSI `runtime.typingJitterRatio`） */
  typingJitterRatio: number;
  /** 单条可见消息的最大字符数（HDSI `runtime.maxMessageCharacters`） */
  maxMessageCharacters: number;
}

export const DEFAULT_OUTGOING: OutgoingConfig = {
  splitReplyMessages: true,
  messageSeparator: '<sep/>',
  typingBaseDelaySeconds: 1,
  typingCharactersPerSecond: 8,
  typingMaxDelaySeconds: 12,
  typingJitterRatio: 0.3,
  maxMessageCharacters: 2000,
};

/**
 * HDSI `clip`（bundle :12652）：字符串则 trim 后截断，非字符串给空串。
 * 注意是 `slice` 硬截断，不重切、不丢弃整条。
 */
export function clip(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, Math.max(1, Math.floor(length))) : '';
}

/**
 * HDSI `normalizeVisibleMessageContent`（bundle :12185）。
 * 归一化分隔标记的各种写法（`<sep>` / `＜sep/＞` 等）到配置的 separator、剥掉媒体占位符，
 * 最后 trim + 按 `maxMessageCharacters` 截断。**调用方要先跑它、再分段**（HDSI 的顺序）。
 *
 * 另加一条本项目自己的规则：**剥掉其它未知自闭标签**（模型会自己发明 `<set_mood mood="…"/>`
 * 这类记号写进台词里）。分隔标记本身不在此列——上面一步已把它归一成配置里的 separator，
 * 配置成 `<br/>` 这种自闭标签时也照样豁免（按标签名白名单，不写死 `sep`）。
 */
export function normalizeVisibleContent(value: unknown, maxCharacters: number, separator: string): string {
  const sep = String(separator ?? '').trim() || DEFAULT_OUTGOING.messageSeparator;
  // 只认合法标识符形状，拼进正则前不必转义；认不出来就退回豁免 sep 这个词
  const keepName = sep.match(/^<[ <]*([a-z_][a-z0-9_]*)/i)?.[1] ?? 'sep';
  return String(value ?? '')
    .replace(/[<＜]\s*sep\s*\/?\s*[>＞]/gi, sep)
    .replace(new RegExp(`<(?!${keepName}\\b)[a-z_][a-z0-9_]*(?:\\s[^>]*)?\\/>`, 'gi'), '')
    .replace(/<\/?(?:file|img|image|audio|record|video|flash|mface)\b[^>]*\/?>/gi, '')
    .replace(/\[CQ:(?:file|image|record|video|flash|mface),[^\]]*\]/gi, '')
    .replace(/[\[【](?:表情包?|图片|动图|GIF)[\]】]/gi, '')
    .replace(/[\[【](?:流汗|微笑|笑哭|尴尬|爱心|惊讶|流泪|委屈)[\]】]/gi, '')
    .trim()
    .slice(0, Math.max(1, Math.floor(maxCharacters)));
}

/**
 * HDSI `splitOutgoingMessage`（bundle :10013）：
 * 关掉拆分时整条返回；没有分隔标记时整条返回；否则按标记切、trim、去空。
 * 不做任何"自动断句"——模型没写分隔标记就是一条。
 */
export function splitOutgoingMessage(content: string, cfg: Pick<OutgoingConfig, 'splitReplyMessages' | 'messageSeparator'>): string[] {
  if (cfg.splitReplyMessages === false) return [content];
  const separator = String(cfg.messageSeparator ?? '').trim() || DEFAULT_OUTGOING.messageSeparator;
  if (!separator || !content.includes(separator)) return [content];
  return content.split(separator).map((part) => part.trim()).filter(Boolean);
}

/**
 * HDSI `typingDelayMilliseconds`（bundle :10019），逐字照搬：
 *   nominal = min(cap, base + ceil(len / cps))     ← len 用 JS UTF-16 长度，与 HDSI 一致
 *   factor  = 1 ± jitter（jitter=0 时正好为 1）
 *   结果    = clamp(nominal × factor × 1000, 下限 250ms, 上限 cap)
 *
 * 与 MaiBot 的 0.3s/汉字公式不同：**没有"0 = 不模拟打字"这一档**，最低也有 250ms。
 * `rng` 只用于测试注入，默认 Math.random（HDSI 同款）。
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
