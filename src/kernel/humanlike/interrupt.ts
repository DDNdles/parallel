/**
 * 出站打断 —— 「她还在一条条发气泡，对面又开口了」。
 *
 * 2026-10-18 用户两次澄清后的口径：**触发条件就是"她还在发、对面又说话了"**，
 * 不需要对方说"停"，也不看内容语义（不认制止语、不看是否 @）。
 * 所以这里只判两件事：
 *   1. 还有没有没发出去的气泡（没有就没什么可打断的）；
 *   2. 掷一次 `probability`（默认 0.8，用户指定）。
 *
 * 这一层**纯程序**、零模型调用：要求是"对面发完立刻生效"——走一趟模型，
 * 剩下那几条气泡早就按打字停顿发出去了。
 */

/** 打断判定的输入 */
export interface InterruptInput {
  /** 还剩几条气泡没发（1 = 只剩最后一条） */
  remaining: number;
  /** 插话打断的概率（0~1）；<=0 = 一律不打断，>=1 = 一律打断 */
  probability: number;
}

export interface InterruptDecision {
  interrupt: boolean;
  /** 给会话日志的理由（桌面端能看出为什么话说一半） */
  reason: string;
}

/**
 * 要不要打断。`rng` 只用于测试注入（默认 Math.random）——
 * `remaining<=0` 与 `probability<=0` 这两条硬边界不消耗它，方便测试钉值。
 */
export function shouldInterrupt(input: InterruptInput, rng: () => number = Math.random): InterruptDecision {
  if (input.remaining <= 0) return { interrupt: false, reason: '没有待发气泡' };
  const p = Math.max(0, Math.min(1, Number(input.probability) || 0));
  if (p <= 0) return { interrupt: false, reason: '打断概率为 0' };
  const hit = p >= 1 || rng() < p;
  return { interrupt: hit, reason: hit ? `插话（掷中 ${p.toFixed(2)}）` : `插话（未掷中 ${p.toFixed(2)}）` };
}
