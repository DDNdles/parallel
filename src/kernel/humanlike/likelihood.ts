/**
 * 开口概率模型 + 动态门控 —— 对齐 MaiBot 主线 2026-10 之后的路线
 * （`reply_likelihood.py` 日志拟合逻辑回归 + `dynamic_gate.py` 动态阈值）。
 *
 * 旧的「80 分必要性启发式」（necessity.ts，MaiBot 已退役的 offline 版本）在这里
 * **降级成先验特征**：它的公式仍负责快速算出「这条内容值不值一提」的样貌，
 * 但最终开不开口由概率与**每会话自适应阈值**决定：
 *   - 冷启动用手工先验权重，行为与旧公式同量级；
 *   - 每次评估都产生一行带特征与结果的样本（进 `gate-model.json` 的环形样本池）；
 *   - 攒够样本就 SGD 重训，权重落盘 —— 与 MaiBot"从日志里学"同一条路。
 *
 * 防坑：MaiBot 的拟合权重里有一条「最近消息数 -0.0367/条」的衰减项，热群里会把
 * 放行概率压到 0.0001 与静态阈值失配、形成正反馈锁死（Issue #2109）。
 * 这里的对应防御有两道：特征里不收"纯消息条数衰减"这一维；阈值有硬下界，
 * 连续沉默时只降不破底。
 */

/** 一次评估的输入特征（来自 necessity 公式的各分项 + 门控现场） */
export interface GateFeatures {
  /** 相关性 0~100（@/提及/私聊/focus，necessity 的 relevance 分项） */
  relevance: number;
  /** 内容分（问题/请求/征询/长文本 加分，短反应倒扣） */
  content: number;
  /** 积压压力分 0~100 */
  pressure: number;
  /** 存在感惩罚 0~25 */
  presence: number;
  /** 空窗补偿是否达成（0/1） */
  comp: 0 | 1;
  /** 当前生效频率 0~1 */
  freq: number;
  /** 当前积压条数 */
  pending: number;
  /** 空窗/平均消息间隔，cap 1（0 = 没有可用节奏） */
  idleRatio: number;
}

/** 线性 logit 权重：`z = bias + Σ w[i] · scaled_f[i]` */
export interface GateWeights {
  bias: number;
  /** 与 likelihoodFeatureVector 输出同长 */
  w: number[];
}

/** 训练样本：特征向量（已缩放）+ 这一次评估的实际结果（1=开口 0=沉默） */
export interface GateSample {
  /** 缩放后的特征向量 */
  f: number[];
  y: 0 | 1;
}

/**
 * 先验权重。缩放口径见 likelihoodFeatureVector：
 * rel/100、content/50、pressure/100、presence/25、comp、freq、log1p(pending)/3、min(1,idleRatio)。
 * 校准目标：@/大积压/空窗达成 高概率；普通短反应 低概率；量级上与旧 necessityThreshold≈80 相当
 * ——但它只是先验，重训后会按真实会话结果自动校准。
 */
export const DEFAULT_GATE_WEIGHTS: GateWeights = {
  bias: -1.55,
  w: [2.35, 0.85, 1.7, -1.15, 1.25, 0.55, 0.3, 0.35],
};

export function likelihoodFeatureVector(f: GateFeatures): number[] {
  return [
    clamp01(f.relevance / 100),
    clamp01(f.content / 50),
    clamp01(f.pressure / 100),
    clamp01(f.presence / 25),
    f.comp ? 1 : 0,
    clamp01(f.freq),
    Math.log1p(Math.max(0, f.pending)) / 3,
    clamp01(Math.max(0, f.idleRatio)),
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
  // 夹回先验邻域
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

// ------------------------------------------------------------ 动态阈值

/** 阈值的硬边界：不破底（防 #2109 锁死）、不上顶（防话痨放大） */
export const GATE_THRESHOLD_MIN = 0.15;
export const GATE_THRESHOLD_MAX = 0.85;

export interface GateWindow {
  /** 窗口内评估次数 */
  evaluations: number;
  /** 窗口内开口次数 */
  spoke: number;
}

/**
 * 每会话阈值控制器的纯函数：说过头往上收、一直不吭声往下放。
 * 窗口径 20 分钟、步长小（±0.06~0.08），一晚也不会跑飞。
 */
export function nextGateThreshold(cur: number, win: GateWindow): { next: number; changed: boolean; why: string } {
  const c = clampThreshold(cur);
  // 20 分钟里开了 4 次以上：这口气说得有点多，阈值上抬
  if (win.spoke >= 4 && win.evaluations >= 4) {
    return { next: clampThreshold(c + 0.08), changed: c < GATE_THRESHOLD_MAX, why: `20min 开口 ${win.spoke} 次，阈值上抬` };
  }
  // 评估了 5 次都沉默：放低门槛，别把自己憋成哑巴（Issue #2109 的反面预防）
  if (win.evaluations >= 5 && win.spoke === 0) {
    return { next: clampThreshold(c - 0.06), changed: c > GATE_THRESHOLD_MIN, why: `20min 沉默 ${win.evaluations} 次，阈值下调` };
  }
  return { next: c, changed: false, why: '' };
}

export function clampThreshold(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(GATE_THRESHOLD_MAX, Math.max(GATE_THRESHOLD_MIN, v));
}
