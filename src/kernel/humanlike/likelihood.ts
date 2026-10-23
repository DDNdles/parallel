/**
 * 开口概率 + 动态预算门控 —— 对齐 MaiBot 主线 `dynamic` 模式：
 * `src/maisaka/turn_trigger/reply_likelihood.py` 与 `dynamic_gate.py`。
 *
 * 两块职责分开：
 *  1. **概率**：8 个会话结构特征 → 逻辑回归 → 这批消息会让 chat 轮开口的概率。
 *     特征与先验权重逐项对齐 MaiBot；权重是离线拟合的结果，这里作为先验。
 *  2. **门控**：1 小时窗口里按 talk_value 折算目标回复量，用窗口内概率的分位点当阈值。
 *     概率只负责排序，真正决定"放几个"的是预算。
 *
 * 与 MaiBot 的唯一有意差异：MaiBot 用无门控时期 Planner 首轮的 `no_reply` 当拟合标签；
 * 这里用**模型最终有没有真说话**（`noteTurnOutcome` 的回执）当标签。先验仍是 MaiBot 的权重，
 * 样本攒够后只在先验邻域内重训，避免少量新样本把行为带跑。
 */

/** 一次评估的输入特征（口径与 MaiBot ReplyLikelihoodInput 一致） */
export interface GateFeatures {
  /** 这批消息是否提到 bot（名字 / 叫醒词 / 回复 bot；@ 由强制触发在门外处理） */
  mentionBot: boolean;
  /** 是否 @ 了 bot 以外的人（两人对话/点名别人时应该更安静） */
  atOther: boolean;
  /** 是否带问号 */
  hasQuestionMark: boolean;
  /** 是否全是表情/图片/语音等媒体占位 */
  placeholderOnly: boolean;
  /** 最近 5 分钟里 bot 发言占全部消息的比例（0~1） */
  recentSelfRatio: number;
  /** 最近 5 分钟的消息总数（含 bot） */
  recentMessageCount: number;
  /** 距 bot 上一次真正发言的秒数；从没说过给 3600 */
  secondsSinceBotMessage: number;
  /** 当前待处理消息条数（特征里封顶 20，与 MaiBot 一致） */
  pendingCount: number;
}

/** 线性 logit 权重：`z = bias + Σ w[i] · scaled_f[i]` */
export interface GateWeights {
  bias: number;
  /** 与 likelihoodFeatureVector 输出同长 */
  w: number[];
}

/** 训练样本：特征向量（已缩放）+ 这一次的实际结果（1=模型真说话 0=模型没说话） */
export interface GateSample {
  f: number[];
  y: 0 | 1;
}

/**
 * MaiBot `reply_likelihood.py` 的原始权重。
 * 保留一份原文，方便以后重新拟合时对照；真正参与计算的是下面缩放后的先验。
 *
 * 原始特征口径：recent_message_count 是原条数、seconds_since_bot 取 log1p、pending 封顶 20。
 * 为了让在线重训的梯度量级稳定，特征向量把这三项分别除以 50 / 5 / 20，
 * 权重同比放大，先验概率与 MaiBot 逐位等价。
 */
export const MAIBOT_RAW_WEIGHTS = {
  bias: -1.2005,
  mentionBot: 1.5852,
  atOther: -1.1157,
  hasQuestionMark: 0.4807,
  placeholderOnly: -1.0281,
  recentSelfRatio: 2.6525,
  recentMessageCount: -0.0367,
  logSecondsSinceBotMessage: 0.0571,
  pendingCount: 0.1012,
} as const;

/** 特征缩放口径（与 MAIBOT_RAW_WEIGHTS 配套） */
export const GATE_FEATURE_SCALES = {
  recentMessageCount: 50,
  logSecondsSinceBotMessage: 5,
  pendingCount: 20,
} as const;

/**
 * 先验权重（已按 GATE_FEATURE_SCALES 缩放）。
 * 校准目标：提到 bot / 积压多 / 很久没说话 → 高概率；@ 别人 / 纯媒体 / 自己刚说过 → 低概率。
 */
export const DEFAULT_GATE_WEIGHTS: GateWeights = {
  bias: MAIBOT_RAW_WEIGHTS.bias,
  w: [
    MAIBOT_RAW_WEIGHTS.mentionBot,
    MAIBOT_RAW_WEIGHTS.atOther,
    MAIBOT_RAW_WEIGHTS.hasQuestionMark,
    MAIBOT_RAW_WEIGHTS.placeholderOnly,
    MAIBOT_RAW_WEIGHTS.recentSelfRatio,
    MAIBOT_RAW_WEIGHTS.recentMessageCount * GATE_FEATURE_SCALES.recentMessageCount,
    MAIBOT_RAW_WEIGHTS.logSecondsSinceBotMessage * GATE_FEATURE_SCALES.logSecondsSinceBotMessage,
    MAIBOT_RAW_WEIGHTS.pendingCount * GATE_FEATURE_SCALES.pendingCount,
  ],
};

export function likelihoodFeatureVector(f: GateFeatures): number[] {
  return [
    f.mentionBot ? 1 : 0,
    f.atOther ? 1 : 0,
    f.hasQuestionMark ? 1 : 0,
    f.placeholderOnly ? 1 : 0,
    clamp01(f.recentSelfRatio),
    Math.max(0, f.recentMessageCount) / GATE_FEATURE_SCALES.recentMessageCount,
    Math.log1p(Math.max(0, f.secondsSinceBotMessage)) / GATE_FEATURE_SCALES.logSecondsSinceBotMessage,
    Math.min(GATE_FEATURE_SCALES.pendingCount, Math.max(0, f.pendingCount)) / GATE_FEATURE_SCALES.pendingCount,
  ];
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function replyLikelihood(f: GateFeatures, w: GateWeights): number {
  const v = likelihoodFeatureVector(f);
  let z = w.bias;
  for (let i = 0; i < v.length; i++) z += (w.w[i] ?? 0) * v[i];
  return sigmoid(z);
}

export function gateSampleOf(f: GateFeatures, y: 0 | 1): GateSample {
  return { f: likelihoodFeatureVector(f), y };
}

/**
 * 逻辑回归 SGD（无依赖、无随机）。
 * 小样本下防过拟合的两道闸：`L2` 轻微收缩 + 权重离先验太远直接夹回
 * （每维最多偏 |w0| 2.5，最多偏掉 bias 3）——重训是在**校准**先验，不是把话柄交给几千条日志。
 */
export function fitWeights(
  rows: GateSample[],
  prior: GateWeights,
  opts: { iterations?: number; lr?: number; l2?: number } = {},
): GateWeights {
  const dim = prior.w.length;
  const w = prior.w.slice();
  let bias = prior.bias;
  const lr = opts.lr ?? 0.25;
  const l2 = opts.l2 ?? 1e-4;
  const iters = opts.iterations ?? 240;
  if (!rows.length) return { bias, w: w.slice() };
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let z = bias;
      for (let k = 0; k < dim; k++) z += (w[k] ?? 0) * (r.f[k] ?? 0);
      const err = sigmoid(z) - r.y;
      for (let k = 0; k < dim; k++) {
        const x = r.f[k] ?? 0;
        // L2 把权重往 0 收一点点；先验窗口在下一段统一夹
        w[k] = (w[k] ?? 0) - lr * (err * x + l2 * (w[k] ?? 0));
      }
      bias -= lr * (err + l2 * bias);
    }
  }
  for (let k = 0; k < dim; k++) w[k] = clampTo((prior.w[k] ?? 0), w[k] ?? 0, 2.5);
  bias = clampTo(prior.bias, bias, 3);
  return { bias, w };
}

function clampTo(base: number, v: number, span: number): number {
  const lo = base - span, hi = base + span;
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : base));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ------------------------------------------------------------ 动态预算门控

/** 统计窗口：1 小时（MaiBot REPLY_WINDOW_SECONDS） */
export const DYNAMIC_GATE_REPLY_WINDOW_SECONDS = 3600;
/** 虚拟轮次：40 秒内到达的消息只计一次"预计回复"（MaiBot VIRTUAL_ROUND_SECONDS） */
export const DYNAMIC_GATE_VIRTUAL_ROUND_SECONDS = 40;
/** 一次 @/提及强制触发预计占用的回复数（MaiBot 拟合均值） */
export const DYNAMIC_GATE_FORCED_TURN_EXPECTED_REPLIES = 0.91;
/** 窗口内评分少于该值时改用离线静态阈值表 */
export const DYNAMIC_GATE_MIN_WINDOW_SCORE_COUNT = 20;
/** 已计入预计回复的消息 id 上限（防内存无界） */
const DYNAMIC_GATE_MAX_COUNTED_MESSAGE_IDS = 2000;

/** 离线统计表：保留比例 → 概率阈值（MaiBot 原表） */
export const DYNAMIC_GATE_STATIC_KEEP_RATIO_THRESHOLDS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 1.0],
  [0.1, 0.605],
  [0.2, 0.482],
  [0.3, 0.430],
  [0.4, 0.376],
  [0.5, 0.336],
  [0.6, 0.313],
  [0.7, 0.290],
  [0.8, 0.250],
  [0.9, 0.206],
  [1.0, 0.0],
];

export interface DynamicGateDecision {
  shouldTrigger: boolean;
  probability: number;
  threshold: number;
  expectedReplies: number;
  targetReplies: number;
  actualReplies: number;
  keepRatio: number;
  detail: string;
}

/**
 * 每会话一份的动态预算门控：让窗口内实际回复次数贴近
 * `talk_value × 预计回复次数`。
 *
 * 预计回复按 40 秒虚拟轮次累计；@/提及强制触发按 0.91 计。
 * 反馈只收紧、不放宽：一波消息刚到时预计数先涨、实际回复还没跟上，
 * 若据此放宽，等这波过去就没机会收回来，回复会系统性偏多（MaiBot 原注释）。
 */
export class DynamicReplyGate {
  private proactiveScores: { at: number; p: number }[] = [];
  private forcedExpectations: { at: number; value: number }[] = [];
  private replyTimes: number[] = [];
  private countedMessageIds = new Set<string>();
  private countedMessageOrder: string[] = [];
  private openRoundStartedAt: number | null = null;
  private lastDecision: DynamicGateDecision | null = null;

  constructor(private windowSeconds = DYNAMIC_GATE_REPLY_WINDOW_SECONDS) {}

  /** 返回尚未计入预计回复的消息 id，并把它们标记为已计入（同一批消息不重复累计） */
  takeUncountedMessageIds(ids: string[]): string[] {
    const out: string[] = [];
    for (const raw of ids) {
      const id = String(raw ?? '');
      if (!id || this.countedMessageIds.has(id)) continue;
      out.push(id);
      this.countedMessageIds.add(id);
      this.countedMessageOrder.push(id);
    }
    while (this.countedMessageOrder.length > DYNAMIC_GATE_MAX_COUNTED_MESSAGE_IDS) {
      const drop = this.countedMessageOrder.shift();
      if (drop) this.countedMessageIds.delete(drop);
    }
    return out;
  }

  isRoundOpen(now: number): boolean {
    return this.openRoundStartedAt !== null
      && now - this.openRoundStartedAt < DYNAMIC_GATE_VIRTUAL_ROUND_SECONDS * 1000;
  }

  /** 记录当前虚拟轮次的预计回复量；同一轮次内覆盖上一次的值 */
  recordProactiveDemand(probability: number, now: number): void {
    if (this.isRoundOpen(now) && this.proactiveScores.length) {
      this.proactiveScores[this.proactiveScores.length - 1].p = probability;
      return;
    }
    this.openRoundStartedAt = now;
    this.proactiveScores.push({ at: now, p: probability });
  }

  /** 真正放行一轮：结束当前虚拟轮次 */
  closeRound(): void {
    this.openRoundStartedAt = null;
  }

  /** @/提及强制触发：按实测均值占用回复额度，并结束当前虚拟轮次 */
  recordForcedTurn(now: number): void {
    this.closeRound();
    this.forcedExpectations.push({ at: now, value: DYNAMIC_GATE_FORCED_TURN_EXPECTED_REPLIES });
  }

  /** 模型最终真的说话了：记一次实际回复 */
  recordReply(now: number): void {
    this.replyTimes.push(now);
  }

  evaluate(probability: number, frequency: number, now: number): DynamicGateDecision {
    this.prune(now);
    const proactiveScores = this.proactiveScores.map((x) => x.p);
    const expectedProactive = proactiveScores.reduce((a, b) => a + b, 0);
    const expectedForced = this.forcedExpectations.reduce((a, b) => a + b.value, 0);
    const expectedTotal = expectedProactive + expectedForced;
    const actualReplies = this.replyTimes.length;
    const normalizedFrequency = Math.min(1, Math.max(0, Number(frequency) || 0));
    const targetReplies = normalizedFrequency * expectedTotal;

    let keepRatio: number;
    if (normalizedFrequency >= 1) {
      keepRatio = 1;
    } else if (expectedProactive <= 0) {
      keepRatio = normalizedFrequency;
    } else {
      const feedforwardRatio = (targetReplies - expectedForced) / expectedProactive;
      const feedbackFactor = Math.min(
        1,
        Math.max(0, 1 + (targetReplies - actualReplies) / Math.max(1, targetReplies)),
      );
      keepRatio = Math.min(1, Math.max(0, feedforwardRatio * feedbackFactor));
    }

    const threshold = this.resolveThreshold(proactiveScores, expectedProactive, keepRatio);
    const decision: DynamicGateDecision = {
      shouldTrigger: probability >= threshold,
      probability,
      threshold,
      expectedReplies: expectedTotal,
      targetReplies,
      actualReplies,
      keepRatio,
      detail: `概率=${probability.toFixed(3)} 阈值=${threshold.toFixed(3)} `
        + `预计回复=${expectedTotal.toFixed(1)} 目标=${targetReplies.toFixed(1)} `
        + `已回复=${actualReplies} 保留比例=${keepRatio.toFixed(2)}`,
    };
    this.lastDecision = decision;
    return decision;
  }

  /** 供状态页/测试读取；不改窗口 */
  snapshot(now: number): {
    scores: number;
    expectedReplies: number;
    targetReplies: number;
    actualReplies: number;
    threshold: number;
    keepRatio: number;
    roundOpen: boolean;
  } {
    this.prune(now);
    const expectedProactive = this.proactiveScores.reduce((a, b) => a + b.p, 0);
    const expectedForced = this.forcedExpectations.reduce((a, b) => a + b.value, 0);
    return {
      scores: this.proactiveScores.length,
      expectedReplies: expectedProactive + expectedForced,
      targetReplies: this.lastDecision?.targetReplies ?? 0,
      actualReplies: this.replyTimes.length,
      threshold: this.lastDecision?.threshold ?? 0,
      keepRatio: this.lastDecision?.keepRatio ?? 0,
      roundOpen: this.openRoundStartedAt !== null,
    };
  }

  private prune(now: number): void {
    const expireBefore = now - this.windowSeconds * 1000;
    while (this.proactiveScores.length && this.proactiveScores[0].at < expireBefore) this.proactiveScores.shift();
    while (this.forcedExpectations.length && this.forcedExpectations[0].at < expireBefore) this.forcedExpectations.shift();
    while (this.replyTimes.length && this.replyTimes[0] < expireBefore) this.replyTimes.shift();
  }

  private resolveThreshold(scores: number[], expectedProactive: number, keepRatio: number): number {
    if (keepRatio >= 1) return 0;
    if (keepRatio <= 0) return 1;
    if (scores.length < DYNAMIC_GATE_MIN_WINDOW_SCORE_COUNT) return staticThreshold(keepRatio);

    const budget = keepRatio * expectedProactive;
    let accumulated = 0;
    for (const score of [...scores].sort((a, b) => b - a)) {
      accumulated += score;
      if (accumulated >= budget) return score;
    }
    return 0;
  }
}

/** 保留比例 → 阈值：窗口样本不足时按 MaiBot 的离线表线性插值 */
export function staticThreshold(keepRatio: number): number {
  const ratio = Math.min(1, Math.max(0, keepRatio));
  for (let i = 0; i < DYNAMIC_GATE_STATIC_KEEP_RATIO_THRESHOLDS.length - 1; i++) {
    const [lowRatio, lowThreshold] = DYNAMIC_GATE_STATIC_KEEP_RATIO_THRESHOLDS[i];
    const [highRatio, highThreshold] = DYNAMIC_GATE_STATIC_KEEP_RATIO_THRESHOLDS[i + 1];
    if (ratio <= highRatio) {
      const progress = highRatio === lowRatio ? 0 : (ratio - lowRatio) / (highRatio - lowRatio);
      return lowThreshold + (highThreshold - lowThreshold) * progress;
    }
  }
  return 0;
}
