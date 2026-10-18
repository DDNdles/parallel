/**
 * 出站打断 —— 「她说了一半，对面又开口了，要不要闭嘴」。
 *
 * 2026-10-18 用户裁定：用户在 bot 还在发气泡的时候说话，按 80% 概率把**后面的气泡**
 * 直接砍掉。这一层**纯程序**（不叫模型），因为要求是"发完立刻生效"：
 * 走模型至少要多等一次往返，那时剩下那几条早就发完了。
 *
 * 三条判据，越靠前越硬：
 *  1. 制止语命中（等等／别说了／停…）→ 一定打断。这是明确意图，不掷骰子。
 *  2. 直接点名（@ 我 或 引用我）→ 一定打断。她在跟你说话，你插进来就是打断。
 *  3. 其余 → 按 `probability` 掷一次。默认 0.8（用户指定）。
 *
 * 与开口侧的分工：那边判"要不要开始说"，这里判"要不要停止说"。两边都不看内容语义，
 * 所以都不叫模型。
 */

/** 打断判定的输入 */
export interface InterruptInput {
  /** 新入站的正文（群聊已含 `昵称：` 前缀的原始 text；这里只看裸正文的语义，不做解析） */
  text: string;
  /** 这条消息 @ 了 bot */
  isAtMe?: boolean;
  /** 这条消息引用/回复了 bot */
  isReplyToMe?: boolean;
  /** 还剩几条气泡没发（1 = 只剩最后一条） */
  remaining: number;
  /** 插话打断的概率（0~1）；<=0 = 除硬规则外一律不打断 */
  probability: number;
}

export interface InterruptDecision {
  interrupt: boolean;
  /** 给会话日志的理由（桌面端能看出为什么话说一半） */
  reason: string;
}

/**
 * 制止语：对面在叫她住口。
 * 只收短词与常见变体 —— 长句子里的"算了"多半是别的意思（"算了吧这事以后再说"是在换话题，
 * 不是叫停），所以按**整条消息很短**来判定，见 `isStopPhrase`。
 */
const STOP_PHRASES = [
  '等等', '等一下', '等下', '等会', '先等等',
  '别说了', '别讲了', '别吵', '闭嘴', '住口',
  '不用说了', '不要说了', '停', '停下', '停一下', '打住',
  '算了', '不用了', '不必了',
];

/** 一条消息最多多长时，"算了/停"这类词才算叫停（更长的多半是换话题） */
const STOP_PHRASE_MAX_CHARS = 12;

/**
 * 是不是叫停。判定口径：整条消息去掉空白与标点后不超过 `STOP_PHRASE_MAX_CHARS`，
 * 且以某个制止语开头或结尾（"先别说了"、"算了算了"都算；"这事算了怎么办"不算）。
 */
export function isStopPhrase(text: string): boolean {
  const t = String(text ?? '').replace(/[\s，。！？、,.!?~～…；;：:]/g, '');
  if (!t || t.length > STOP_PHRASE_MAX_CHARS) return false;
  return STOP_PHRASES.some((p) => t.startsWith(p) || t.endsWith(p));
}

/**
 * 要不要打断。`rng` 只用于测试注入（默认 Math.random）——
 * 只在需要掷骰子那条路上消耗它，硬规则不消耗，方便测试钉值。
 */
export function shouldInterrupt(input: InterruptInput, rng: () => number = Math.random): InterruptDecision {
  if (input.remaining <= 0) return { interrupt: false, reason: '没有待发气泡' };
  if (isStopPhrase(input.text)) return { interrupt: true, reason: '制止语' };
  if (input.isAtMe) return { interrupt: true, reason: '被 @' };
  if (input.isReplyToMe) return { interrupt: true, reason: '被引用' };
  const p = Math.max(0, Math.min(1, Number(input.probability) || 0));
  if (p <= 0) return { interrupt: false, reason: '概率为 0' };
  const hit = rng() < p;
  return { interrupt: hit, reason: hit ? `插话（掷中 ${p.toFixed(2)}）` : `插话（未掷中 ${p.toFixed(2)}）` };
}
