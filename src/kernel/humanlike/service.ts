/**
 * 拟人化服务 —— 内核里"什么时候说、怎么说"的那一半。
 *
 * 对上下暴露三件事：
 *  1. `ingest()`  入站消息的门控：@/私聊/命令立刻放行，其余按必要性打分 + 空窗补偿攒着，
 *                 攒够了再由回调叫 pipeline 去跑一轮（这就是"会接话"与"会主动说话"）。
 *  2. `compose()` 出站回复的塑形：按句分条 → 逐条打字停顿（纯程序，模型不写任何格式标记）。
 *  3. 每会话一份心流状态：最近消息窗口（存在感惩罚 / 轰炸降频用）、平均消息间隔（空窗补偿用）、
 *                 连续不理人的计数（空闲退避用）。
 *
 * 这一层不在插件体系里：它是 chat 区行为本身，插件只能通过钩子微调。
 */

import type { ChatEvent, ChatRef, MsgSegment } from '../types.ts';
import type { Bus } from '../bus.ts';
import type { ErrorCenter } from '../errors.ts';
import type { SessionLog } from '../sessionlog.ts';
import {
  NECESSITY_TRIGGER_SCORE,
  idleCompensation,
  presencePenalty,
  scoreReplyNecessity,
} from './necessity.ts';
import {
  DEFAULT_GATE_WEIGHTS,
  fitWeights,
  nextGateThreshold,
  replyLikelihood,
  gateSampleOf,
  type GateFeatures,
  type GateSample,
  type GateWeights,
} from './likelihood.ts';
import { backoffBypassed, burstGatePenalty, idleBackoffSeconds, talkValueFor } from './frequency.ts';
import { isSilentScene, normalizeVisibleContent, splitIntoBubbles, trimAtSentence, typingDelayMs } from './delivery.ts';
import { detectCollapse, rhythmNudge, rhythmSignature } from './rhythm.ts';
import { deriveWindow, evaluateAgency, nextRecheckAt, type ProactiveContactCandidate } from './agency.ts';
import { currentActivity, emptyPlan, prunePlan, schedulePrompt, type SchedulePlan } from './schedule.ts';
import {
  DEFAULT_HUMANLIKE,
  PRESENCE_WINDOW_SECONDS,
  type HumanlikeConfig,
  type TriggerBatch,
} from './types.ts';
import { readJson, atomicWriteJson } from '../util/fsutil.ts';

interface ChatState {
  buffer: ChatEvent[];
  firstBufferedAt: number;
  debounce?: NodeJS.Timeout;
  maxWait?: NodeJS.Timeout;
  /** 下一次评估 */
  recheck?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  /** 最近窗口内的消息（self = 自己发的），用于存在感惩罚 */
  recent: { at: number; self: boolean }[];
  /** 相邻入站消息的间隔（秒），用于空窗补偿里的"群平均节奏" */
  intervals: number[];
  lastInboundAt: number;
  lastSpokeAt: number;
  /** 连续"评估过但决定不说"的次数，驱动空闲退避 */
  consecutiveNoAction: number;
  backoffUntil: number;
  lastWaitLoggedAt: number;
  /** 当前被"专注"的会话（focusMode） */
  focused: boolean;
  /** 最近若干轮的「节奏签名」（HDSI ChatRhythm 的窗口） */
  rhythmSigs: string[];
  /** 连续注入了提示但节奏没变好的次数（熔断用） */
  rhythmExhausted: number;
  /** 日程计划（HDSI Schedule Preplan；写入入口已删，只剩读取与容量判断） */
  schedule: SchedulePlan;
  /** 上一次主动开口的时间（HDSI 用最小间隔挡频繁主动） */
  lastProactiveAt: number;
  /** likelihood 模式：本会话的开口阈值，随最近 20 分钟的实际开口率自适应 */
  gateThreshold: number;
  /** likelihood 模式：最近 20 分钟的评估/开口记录（阈值控制器用） */
  gateDecisions: { at: number; spoke: boolean }[];
}

const INTERVAL_SAMPLE = 20;
/** 拟合闭环的最小样本量：首次与之后每满 80 条新样本重训一次 */
const GATE_FIT_MIN_ROWS = 80;
const GATE_FIT_BATCH = 80;
/** 样本池上限（连同权重的 JSON 约 130KB） */
const GATE_ROW_CAP = 1200;
/** likelihood 模式的开口阈值初值 */
const GATE_THRESHOLD_INIT = 0.5;

export interface HumanlikeServiceOptions {
  config: () => HumanlikeConfig;
  /** bot 自己的昵称（判"提到我"用） */
  selfNickname: () => string;
  /** 攒够了：叫 pipeline 去跑一轮 */
  trigger: (batch: TriggerBatch) => void;
  sessionLog: Pick<SessionLog, 'append'>;
  bus: Bus;
  errors: ErrorCenter;
  /** 打字节奏与抖动在测试里要能关掉 */
  now?: () => number;
  /** 合批起跳随机延时的随机源（测试注入用；缺省 Math.random） */
  random?: () => number;
  /**
   * likelihood 模型的落盘位置（`data/gate-model.json`）。不传就只跑内存，
   * 冷启动从先验开始 —— 测试与 dump 场景用这个口。
   */
  modelFile?: string;
}

export class HumanlikeService {
  private states = new Map<string, ChatState>();
  private disposed = false;
  private readonly now: () => number;
  /** likelihood 权重（冷启动先验，随样本重训后更新） */
  private gateWeights: GateWeights = { ...DEFAULT_GATE_WEIGHTS, w: [...DEFAULT_GATE_WEIGHTS.w] };
  /** 训练样本池（环形，只入不出；随权重一起落盘，冷启动不从头学） */
  private gateRows: GateSample[] = [];
  private lastFitRows = 0;

  constructor(private opts: HumanlikeServiceOptions) {
    this.now = opts.now ?? Date.now;
    if (opts.modelFile) {
      const m = readJson<{ v?: number; weights?: GateWeights; rows?: GateSample[] }>(opts.modelFile, {});
      if (m.weights && Number.isFinite(m.weights.bias) && Array.isArray(m.weights.w) && m.weights.w.length === DEFAULT_GATE_WEIGHTS.w.length) {
        this.gateWeights = m.weights;
        this.gateRows = Array.isArray(m.rows) ? m.rows.slice(-GATE_ROW_CAP) : [];
        this.lastFitRows = this.gateRows.length;
      }
    }
  }

  get config(): HumanlikeConfig {
    return this.opts.config() ?? DEFAULT_HUMANLIKE;
  }

  /** 会话键（与 pipeline 的 chatKey 同构） */
  private key(chat: ChatRef | ChatEvent): string {
    return `${chat.type}_${chat.chatId}`;
  }

  private state(chat: ChatRef | ChatEvent): ChatState {
    const k = this.key(chat);
    let s = this.states.get(k);
    if (!s) {
      s = {
        buffer: [], firstBufferedAt: 0,
        recent: [], intervals: [],
        lastInboundAt: 0, lastSpokeAt: 0,
        consecutiveNoAction: 0, backoffUntil: 0, lastWaitLoggedAt: 0,
        focused: false,
        rhythmSigs: [], rhythmExhausted: 0,
        schedule: emptyPlan(), lastProactiveAt: 0,
        gateThreshold: GATE_THRESHOLD_INIT, gateDecisions: [],
      };
      this.states.set(k, s);
    }
    return s;
  }

  // ------------------------------------------------------------ 入站门控

  /**
   * 入站消息进拟人层。返回 `{action:'pass', events}` 表示内核照常处理（events 可能含被合并的前序消息）；
   * `{action:'handled'}` 表示这层已经接管，内核不要重复处理。
   */
  ingest(event: ChatEvent, opts: { isCommand: boolean }): { action: 'pass'; events: ChatEvent[]; merged: boolean } | { action: 'handled' } {
    if (this.disposed) return { action: 'pass', events: [event], merged: false };
    const cfg = this.config;
    const st = this.state(event);
    const now = this.now();

    // 统计：平均间隔 + 存在感窗口（命令也计入群节奏，因为它同样是"群里有动静"）
    this.recordInbound(st, now);

    // 命令是显式意图，任何时候都不参与拟人化门控
    if (opts.isCommand) return { action: 'pass', events: [event], merged: false };
    // 私聊一律立即处理（不攒、不打分）——对齐"私聊频率"只影响主动发言的语义
    if (event.type === 'private') return { action: 'pass', events: [event], merged: false };

    const hasAt = event.isAtMe;
    const hasMention = this.mentioned(event);

    // 被 @ 必回：立刻放行，但把已经攒着的消息一起带上（让模型看到完整上下文）
    if (hasAt && cfg.timing.inevitableAtReply) {
      const merged = this.bufferLen(st) > 0;
      const events = this.drain(st, event);
      this.armIdleTimer({ platform: event.platform, type: event.type, chatId: event.chatId }, st, cfg);
      return { action: 'pass', events, merged };
    }
    if (hasMention && cfg.timing.mentionedBotReply) {
      const merged = this.bufferLen(st) > 0;
      const events = this.drain(st, event);
      this.armIdleTimer({ platform: event.platform, type: event.type, chatId: event.chatId }, st, cfg);
      return { action: 'pass', events, merged };
    }

    this.armIdleTimer({ platform: event.platform, type: event.type, chatId: event.chatId }, st, cfg);

    if (!cfg.merge.enable) {
      // 不合并时仍然逐个走门控：攒 1 条就评估
      st.buffer.push(event);
      this.scheduleEvaluate(event, st, cfg, hasAt, hasMention);
      return { action: 'handled' };
    }

    st.buffer.push(event);
    if (!st.firstBufferedAt) st.firstBufferedAt = now;

    // 防抖：静默 windowMs + 随机起跳延时后评估 —— 真人也是"看到 → 停半拍 → 开始打字"，
    // 关窗就秒回显得太积极（2026-10-17 用户裁定：合批关窗后随机延时 0.5~2 秒起跳）。
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = this.timer(() => {
      st.debounce = undefined;
      this.evaluate(event, st, cfg, hasAt, hasMention);
    }, cfg.merge.windowMs + this.fireJitter(cfg));

    // 兜底：从第一条起最多攒 maxWaitMs（群里刷屏时 debounce 永远不触发）
    if (!st.maxWait) {
      st.maxWait = this.timer(() => {
        st.maxWait = undefined;
        this.evaluate(event, st, cfg, hasAt, hasMention);
      }, cfg.merge.maxWaitMs);
    }
    return { action: 'handled' };
  }

  /** 把缓冲里的消息 + 当前这条一起交出去 */
  private drain(st: ChatState, tail?: ChatEvent): ChatEvent[] {
    const events = tail ? [...st.buffer, tail] : [...st.buffer];
    st.buffer = [];
    st.firstBufferedAt = 0;
    if (st.debounce) { clearTimeout(st.debounce); st.debounce = undefined; }
    if (st.maxWait) { clearTimeout(st.maxWait); st.maxWait = undefined; }
    if (st.recheck) { clearTimeout(st.recheck); st.recheck = undefined; }
    return events;
  }

  private bufferLen(st: ChatState): number {
    return st.buffer.length;
  }

  /**
   * 合批关窗后的随机起跳延时（毫秒）：默认 0.5~2 秒。
   * 等待期间新来的消息会重置防抖窗口（= 群里还在刷，她继续看戏），@/提及仍然直通。
   */
  private fireJitter(cfg: HumanlikeConfig): number {
    const lo = Math.max(0, Math.round(Number(cfg.merge.fireDelayMinMs) || 0));
    const hi = Math.max(lo, Math.round(Number(cfg.merge.fireDelayMaxMs) || 0));
    if (hi <= 0) return 0;
    const r = this.opts.random ?? Math.random;
    return lo + Math.round(r() * (hi - lo));
  }

  /**
   * 轰炸惩罚：最近 10 秒的入站条数交给 `burstGatePenalty` 折算成开口门槛的加项。
   * 只叠加在默认的 likelihood 模式上（necessity/frequency 是对照模式，口径冻结）。
   */
  private burstPenalty(st: ChatState, now: number): number {
    let n = 0;
    for (let i = st.recent.length - 1; i >= 0; i--) {
      const r = st.recent[i];
      if (now - r.at > 10_000) break;
      if (!r.self) n++;
    }
    return burstGatePenalty(n);
  }

  // ------------------------------------------------------------ 评估

  private scheduleEvaluate(event: ChatEvent, st: ChatState, cfg: HumanlikeConfig, hasAt: boolean, hasMention: boolean): void {
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = this.timer(() => {
      st.debounce = undefined;
      this.evaluate(event, st, cfg, hasAt, hasMention);
    }, 0);
  }

  /**
   * 核心决策：现在该不该开口。三种放行条件（对齐 MaiBot 的 gate 语义）：
   *  1. 硬规则：@ / 提及（由调用方先拦）
   *  2. 主门：frequency 攒够条数 / necessity 分数达标
   *  3. 空窗补偿：沉默时长折算出的"等效消息数"达标（这就是为什么潜水久了会突然插一嘴）
   * 都不满足时按 `min(退避, 空窗还差的秒数)` 安排下次评估，不做轮询空转。
   */
  private evaluate(carrier: ChatEvent, st: ChatState, cfg: HumanlikeConfig, hasAt: boolean, hasMention: boolean): void {
    if (this.disposed || !st.buffer.length) return;
    const now = this.now();
    // 过期的攒货先扔掉：隔了几分钟的老话再接上去很出戏
    const ttl = Math.max(0, cfg.merge.bufferTtlMs);
    if (ttl > 0) {
      const keep = st.buffer.filter((e) => now - e.ts <= ttl);
      if (keep.length !== st.buffer.length) {
        st.buffer = keep;
        if (!keep.length) { st.firstBufferedAt = 0; return; }
      }
    }
    const chat: ChatRef = { platform: carrier.platform, type: carrier.type, chatId: carrier.chatId };

    const pending = st.buffer.length;
    const idleSeconds = st.lastInboundAt ? Math.max(0, (now - st.lastInboundAt) / 1000) : 0;
    const avgInterval = this.averageInterval(st);
    const comp = idleCompensation({
      pendingCount: pending,
      triggerThreshold: cfg.timing.pendingThreshold,
      idleSeconds,
      averageIntervalSeconds: avgInterval,
    });

    // 空闲退避：连续不理人就指数放慢；群里重新热闹（积压够多）直接绕过
    const backoff = idleBackoffSeconds(cfg.backoff, st.consecutiveNoAction);
    const bypass = backoffBypassed(cfg.backoff, pending);
    if (backoff > 0 && !bypass && now < st.backoffUntil) {
      this.armRecheck(carrier, st, Math.max(200, st.backoffUntil - now));
      this.logWait(carrier, st, `退避中（还差 ${Math.round((st.backoffUntil - now) / 1000)}s，连续不说=${st.consecutiveNoAction}）`);
      return;
    }

    const texts = st.buffer.map((e) => e.text);
    const { self: recentSelf, total: recentTotal } = this.recentCounts(st, now);
    const frequency = talkValueFor(
      {
        talkValue: cfg.timing.talkValue,
        privateTalkValue: cfg.timing.privateTalkValue,
        enableRules: cfg.timing.enableRules,
        rules: cfg.timing.rules,
      },
      chat,
      new Date(now),
    );
    const scored = scoreReplyNecessity({
      texts,
      pendingCount: pending,
      triggerThreshold: cfg.timing.pendingThreshold,
      hasAt,
      hasMention,
      isGroupChat: carrier.type === 'group',
      focusActive: st.focused,
      recentSelfReplies: recentSelf,
      recentWindowMessages: recentTotal,
      effectiveFrequency: frequency,
      idleSeconds,
      idleReachedAverage: comp.reached,
    }, this.opts.selfNickname());

    const mode = cfg.timing.replyTriggerMode;
    const threshold = mode === 'frequency' ? Number.POSITIVE_INFINITY : cfg.timing.necessityThreshold;
    // likelihood 模式：旧启发式各分项降级为特征，拼出开口概率；旧 necessity 直接比分数
    const likelihood = mode === 'likelihood'
      ? (() => {
          const feats: GateFeatures = {
            relevance: scored.parts.relevance,
            content: scored.parts.content,
            pressure: scored.parts.pressure,
            presence: scored.parts.presence,
            comp: comp.reached ? 1 : 0,
            freq: frequency,
            pending,
            idleRatio: avgInterval > 0 ? Math.min(1, idleSeconds / avgInterval) : 0,
          };
          return { feats, p: replyLikelihood(feats, this.gateWeights) };
        })()
      : null;
    // 轰炸降频：刷屏时把开口门槛抬起来（只作用于 likelihood；对照模式口径冻结）
    const burst = likelihood ? this.burstPenalty(st, now) : 0;
    const gate = st.gateThreshold + burst;
    const mainGate = mode === 'frequency'
      ? pending >= cfg.timing.pendingThreshold
      : likelihood
        ? likelihood.p >= gate
        : scored.score >= threshold;

    let reason: TriggerBatch['reason'] | null = null;
    let detail = '';
    if (mainGate) {
      reason = likelihood ? 'likelihood' : mode === 'frequency' ? 'frequency' : 'necessity';
      detail = mode === 'frequency'
        ? `pending=${pending} >= ${cfg.timing.pendingThreshold}`
        : likelihood
          ? `P=${likelihood.p.toFixed(2)} ≥ ${gate.toFixed(2)}${burst > 0 ? `（含轰炸 +${burst.toFixed(2)}）` : ''}｜${scored.detail}`
          : scored.detail;
    } else if (comp.reached) {
      reason = 'idle';
      detail = `${comp.detail}｜必要性 ${scored.detail}`;
    }

    if (reason) {
      const events = this.drain(st);
      st.consecutiveNoAction = 0;
      st.backoffUntil = 0;
      st.focused = true;
      st.lastSpokeAt = now;
      this.absorbSelf(st, now);
      this.opts.sessionLog.append(carrier.chatId, carrier.type, {
        type: 'gate', role: 'system',
        text: `开口（${reason}）：${detail}`,
        data: {
          reason, detail, score: scored.score, pending, frequency,
          ...(likelihood ? { p: Number(likelihood.p.toFixed(3)), gate: Number(st.gateThreshold.toFixed(3)) } : {}),
        },
      });
      // 开口也要给样本池记 y=1，并让阈值控制器抬头（说过头了自动收敛）
      if (likelihood) this.recordGate(st, now, true, likelihood.feats);
      this.opts.trigger({ chat, events, reason, detail });
      return;
    }

    // 决定不说
    st.consecutiveNoAction += 1;
    const nextBackoff = idleBackoffSeconds(cfg.backoff, st.consecutiveNoAction);
    st.backoffUntil = nextBackoff > 0 ? now + nextBackoff * 1000 : 0;
    const delay = Math.max(
      250,
      Math.min(
        nextBackoff > 0 ? nextBackoff * 1000 : Number.POSITIVE_INFINITY,
        comp.delaySeconds > 0 ? comp.delaySeconds * 1000 : Number.POSITIVE_INFINITY,
      ) || 1000,
    );
    if (likelihood) this.recordGate(st, now, false, likelihood.feats);
    this.armRecheck(carrier, st, delay);
    this.logWait(carrier, st, likelihood
      ? `不说：P=${likelihood.p.toFixed(2)} < ${gate.toFixed(2)}${burst > 0 ? `（含轰炸 +${burst.toFixed(2)}）` : ''}｜${scored.detail}`
      : `不说：${scored.detail}｜${comp.detail}`);
  }

  private armRecheck(carrier: ChatEvent, st: ChatState, delayMs: number): void {
    if (st.recheck) clearTimeout(st.recheck);
    const cfg = this.config;
    st.recheck = this.timer(() => {
      st.recheck = undefined;
      if (!st.buffer.length) return;
      this.evaluate(carrier, st, cfg, false, false);
    }, Math.min(30_000, Math.max(100, delayMs)));
  }

  /** 每次评估都说"不说"会把日志刷爆，限流到 10s 一条 */
  private logWait(carrier: ChatEvent, st: ChatState, text: string): void {
    const now = this.now();
    if (now - st.lastWaitLoggedAt < 10_000) return;
    st.lastWaitLoggedAt = now;
    this.opts.sessionLog.append(carrier.chatId, carrier.type, {
      type: 'gate', role: 'system', text, data: { decision: 'wait' },
    });
  }

  // ------------------------------------------------------------ 拟合闭环（likelihood 模式）

  /**
   * 一次 likelihood 评估的记账：样本池 + 阈值控制器。
   * 阈值只在「沉默」一侧收放：开口方向靠控制器看窗口里的开口次数（说过头就在下一次评估时上抬），
   * 窗口径「最近 20 分钟」——刚好压得住热群，也放得开冷群。
   */
  private recordGate(st: ChatState, now: number, spoke: boolean, feats: GateFeatures): void {
    st.gateDecisions.push({ at: now, spoke });
    const cut = now - 20 * 60_000;
    while (st.gateDecisions.length && st.gateDecisions[0].at < cut) st.gateDecisions.shift();

    this.gateRows.push(gateSampleOf(feats, spoke ? 1 : 0));
    if (this.gateRows.length > GATE_ROW_CAP) this.gateRows.splice(0, this.gateRows.length - GATE_ROW_CAP);
    this.maybeFit();

    if (!spoke) {
      const win = this.gateWindowOf(st, now);
      const adj = nextGateThreshold(st.gateThreshold, win);
      if (adj.changed) st.gateThreshold = adj.next;
    }
  }

  private gateWindowOf(st: ChatState, now: number): { evaluations: number; spoke: number } {
    const cut = now - 20 * 60_000;
    let evaluations = 0, spoke = 0;
    for (const d of st.gateDecisions) {
      if (d.at < cut) continue;
      evaluations++;
      if (d.spoke) spoke++;
    }
    return { evaluations, spoke };
  }

  /** 攒够了整批新样本就重训一次，权重落盘（下一轮评估用新权重） */
  private maybeFit(): void {
    if (this.gateRows.length - this.lastFitRows >= GATE_FIT_BATCH) {
      this.gateWeights = fitWeights(this.gateRows, DEFAULT_GATE_WEIGHTS);
      this.lastFitRows = this.gateRows.length;
      this.saveGateModel();
      return;
    }
    // 没到重训量级也要定期存样本池：冷启动接得上上一轮的学头
    if (this.gateRows.length - this.lastSavedRows >= 40) this.saveGateModel();
  }

  private lastSavedRows = 0;

  private saveGateModel(): void {
    if (!this.opts.modelFile) return;
    this.lastSavedRows = this.gateRows.length;
    try {
      atomicWriteJson(this.opts.modelFile, {
        v: 1,
        weights: this.gateWeights,
        rows: this.gateRows,
      }, { rotate: false });
    } catch { /* 落盘失败只影响下次冷启动的起点，不值得打断说话 */ }
  }

  /** likelihood 模型快照（调试/测试/未来状态页用；不给运行路径） */
  gateModelSnapshot(): { bias: number; w: number[]; rows: number } {
    return { bias: this.gateWeights.bias, w: [...this.gateWeights.w], rows: this.gateRows.length };
  }

  // ------------------------------------------------------------ 主动发言（没人说话也开口）

  /** 群里静默够久时起个话头；由 `proactive.enable` 单独控制（风控红线：主动发言属于主动推送） */
  private armIdleTimer(chat: ChatRef, st: ChatState, cfg: HumanlikeConfig): void {
    if (st.idle) clearTimeout(st.idle);
    if (!cfg.proactive.enable) return;
    st.idle = this.timer(() => {
      st.idle = undefined;
      if (this.disposed) return;
      if (st.buffer.length) return;                       // 有待处理消息时交给正常门控
      const now = this.now();
      const idleSeconds = st.lastInboundAt ? (now - st.lastInboundAt) / 1000 : 0;
      const selfIdle = st.lastSpokeAt ? (now - st.lastSpokeAt) / 1000 : Number.POSITIVE_INFINITY;
      if (idleSeconds < cfg.proactive.idleSeconds || selfIdle < cfg.proactive.idleSeconds) {
        this.armIdleTimer(chat, st, cfg);
        return;
      }
      st.lastSpokeAt = now;
      st.consecutiveNoAction = 0;
      st.backoffUntil = 0;
      this.absorbSelf(st, now);
      const detail = `群里静默 ${Math.round(idleSeconds)}s（阈值 ${cfg.proactive.idleSeconds}s），主动起话头`;
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'gate', role: 'system', text: `主动发言：${detail}`, data: { reason: 'proactive', detail },
      });
      this.opts.trigger({ chat, events: [], reason: 'proactive', detail });
      this.armIdleTimer(chat, st, cfg);
    }, cfg.proactive.idleSeconds * 1000);
  }

  // ------------------------------------------------------------ 回合结果回执

  /**
   * 说出去了：记进存在感窗口、清退避计数，并把这一轮的**节奏签名**记进窗口。
   * `bubbles` 是实际发出去的那几条，用于 HDSI ChatRhythm 的定型检测。
   */
  noteSpoke(chat: ChatRef, count = 1, bubbles: string[] = []): void {
    const st = this.state(chat);
    const now = this.now();
    st.lastSpokeAt = now;
    st.consecutiveNoAction = 0;
    st.backoffUntil = 0;
    for (let i = 0; i < count; i++) st.recent.push({ at: now, self: true });
    if (bubbles.length) {
      const cfg = this.config.rhythm;
      st.rhythmSigs.push(rhythmSignature(bubbles));
      while (st.rhythmSigs.length > Math.max(5, cfg.historyLimit)) st.rhythmSigs.shift();
    }
  }

  /** 主动开口记一笔（HDSI Agency 的最小间隔判据要用） */
  noteProactive(chat: ChatRef): void {
    this.state(chat).lastProactiveAt = this.now();
  }

  // ------------------------------------------------------------ 子系统的注入

  /**
   * 这一轮要追加的 system 分节（顺序在输出口径之后、插件节之前）：
   *   460 节奏提醒 / 470 日程
   * 都只在真有内容时才出节 —— 空节只会白占 token 和注意力。
   */
  sceneSections(chat: ChatRef): { order: number; title: string; text: string }[] {
    const cfg = this.config;
    const st = this.state(chat);
    const now = this.now();
    const out: { order: number; title: string; text: string }[] = [];

    // 460 节奏提醒（HDSI ChatRhythm）
    if (cfg.rhythm.enable && st.rhythmExhausted < cfg.rhythm.exhaustLimit) {
      const r = detectCollapse(st.rhythmSigs, cfg.rhythm);
      if (r.collapsed) {
        st.rhythmExhausted += 1;      // 注入了就算一次尝试；下一轮若仍定型会再加，够次数就熔断
        out.push({ order: 460, title: 'rhythm', text: rhythmNudge(r.detail, cfg.rhythm.mode) });
      } else if (st.rhythmExhausted > 0) {
        st.rhythmExhausted = 0;       // 节奏变好了，解除熔断计数
      }
    }

    // 470 日程（HDSI Schedule Preplan）：只作计划，明确写"不是已发生的事实"
    if (cfg.schedule.enable) {
      const text = schedulePrompt(st.schedule, new Date(now), cfg.schedule);
      if (text) out.push({ order: 470, title: 'schedule', text });
    }
    return out;
  }

  /**
   * 主动开口前过一遍行动容量（HDSI Agency）。
   * 被挡住时返回下一次重查时间 —— 由调用方去排，而不是轮询空转。
   */
  proactiveCapacity(chat: ChatRef, candidate?: Partial<ProactiveContactCandidate>): { allowed: boolean; reason: string; recheckAt?: number } {
    const cfg = this.config;
    if (!cfg.agency.enable) return { allowed: true, reason: 'disabled' };
    const st = this.state(chat);
    const now = this.now();
    const nowDate = new Date(now);
    const activity = cfg.schedule.enable ? currentActivity(st.schedule, nowDate) : null;
    const window = deriveWindow(nowDate, chat.type, cfg.agency, activity);
    const cap = evaluateAgency(
      window,
      { origin: candidate?.origin ?? 'chat', disclosure: candidate?.disclosure ?? 'ordinary', reason: candidate?.reason ?? '' },
      nowDate, cfg.agency, st.lastProactiveAt || undefined,
    );
    return { allowed: cap.allowed, reason: cap.reason, recheckAt: nextRecheckAt(cap, nowDate, cfg.agency) };
  }

  /** 日程计划读写（模型与 QQ 侧的入口都已删除；这里留给主动开口的容量判断） */
  planSchedule(chat: ChatRef, plan: SchedulePlan): SchedulePlan {
    const st = this.state(chat);
    st.schedule = prunePlan(plan, new Date(this.now()), this.config.schedule);
    return st.schedule;
  }

  scheduleOf(chat: ChatRef): SchedulePlan {
    return this.state(chat).schedule;
  }

  /** 评估过了但最终没发（模型给了沉默标记） */
  noteSilent(chat: ChatRef): void {
    const st = this.state(chat);
    st.consecutiveNoAction += 1;
    const backoff = idleBackoffSeconds(this.config.backoff, st.consecutiveNoAction);
    st.backoffUntil = backoff > 0 ? this.now() + backoff * 1000 : 0;
  }

  /** 轮次结束后重新武装主动发言计时器 */
  afterTurn(chat: ChatRef): void {
    const st = this.state(chat);
    this.armIdleTimer(chat, st, this.config);
  }

  /** 让某个会话参与/退出 focus（focusMode 打开时只有一个会话被专注） */
  setFocus(chat: ChatRef, on: boolean): void {
    const st = this.state(chat);
    st.focused = on;
  }

  // ------------------------------------------------------------ 出站塑形

  /**
   * 一段模型输出 → `{ plans, historyText, spoke }`。
   *
   * 2026-10-17 起没有剧本体：模型写的字就是话本身（不写动作描写靠 440 输出口径约束，
   * 不再有 `<say>` 结构兜底）。三种情形：
   *   ① 整段就是沉默标记 → 什么都不发（主动轮用它保持安静）；
   *   ② 其余 → 归一化（剥占位/标签、单条上限硬截断）→ 按回复总长句边截断 → 按句/换行分条。
   * `historyText` 就是真正发出去的气泡合并 —— 历史里模型自己的话与群里看到的同形态。
   */
  async composeScene(text: string): Promise<{ plans: SendPlan[]; historyText: string; spoke: boolean }> {
    const cfg = this.config;
    const scene = String(text ?? '');
    if (isSilentScene(scene)) return { plans: [], historyText: '', spoke: false };

    const bubbles = this.collectBubbles(scene, cfg);
    return { plans: this.plan(bubbles), historyText: bubbles.join('\n'), spoke: bubbles.length > 0 };
  }

  /** 只要发送计划（不关心正文时用；测试与验收脚本走这里） */
  async compose(chat: ChatRef, text: string): Promise<SendPlan[]> {
    void chat;
    return (await this.composeScene(text)).plans;
  }

  /** 单条文本的打字等待（秒），插件/命令想自己排节奏时用（下限 0.25s） */
  typingSeconds(text: string): number {
    return typingDelayMs(text, this.config.outgoing) / 1000;
  }

  // ------------------------------------------------------------ 出站塑形

  /**
   * 可见正文 → 待发气泡（纯程序，口径见 delivery.ts）：
   * 归一化 → 句边截断（回复总长上限的兜底）→ 按换行与句末标点分条。
   * 模型不写任何格式标记；关掉 `splitReplyMessages` 就整段一条发出去。
   */
  private collectBubbles(text: string, cfg: HumanlikeConfig): string[] {
    const out = cfg.outgoing;
    const t = trimAtSentence(normalizeVisibleContent(text, out.maxMessageCharacters), out.replyMaxCharacters);
    if (!t) return [];
    if (out.splitReplyMessages === false) return [t];
    return splitIntoBubbles(t);
  }

  /** 气泡 → 带打字停顿的发送计划：第一条不等，之后每条按自己的字数算「正在输入」要多久 */
  private plan(bubbles: string[]): SendPlan[] {
    const cfg = this.config.outgoing;
    return bubbles.map((text, i) => ({
      segments: [{ type: 'text', data: { text } }] as MsgSegment[],
      pauseMs: i === 0 ? 0 : typingDelayMs(text, cfg),
    }));
  }

  // ------------------------------------------------------------ 状态维护

  private recordInbound(st: ChatState, now: number): void {
    if (st.lastInboundAt) {
      const gap = (now - st.lastInboundAt) / 1000;
      // 超过 10 分钟的空档不算"节奏"，否则午休回来会把平均间隔拉爆
      if (gap > 0 && gap < 600) {
        st.intervals.push(gap);
        if (st.intervals.length > INTERVAL_SAMPLE) st.intervals.shift();
      }
    }
    st.lastInboundAt = now;
    st.recent.push({ at: now, self: false });
    this.trimRecent(st, now);
  }

  private absorbSelf(st: ChatState, now: number): void {
    st.recent.push({ at: now, self: true });
    this.trimRecent(st, now);
  }

  private trimRecent(st: ChatState, now: number): void {
    const cut = now - PRESENCE_WINDOW_SECONDS * 1000;
    while (st.recent.length && st.recent[0].at < cut) st.recent.shift();
    if (st.recent.length > 200) st.recent.splice(0, st.recent.length - 200);
  }

  private recentCounts(st: ChatState, now: number): { self: number; total: number } {
    this.trimRecent(st, now);
    return { self: st.recent.filter((r) => r.self).length, total: st.recent.length };
  }

  private averageInterval(st: ChatState): number | null {
    if (st.intervals.length < 2) return null;
    const sum = st.intervals.reduce((a, b) => a + b, 0);
    return sum / st.intervals.length;
  }

  private mentioned(event: ChatEvent): boolean {
    if (event.isReplyToMe) return true;
    const name = this.opts.selfNickname();
    return !!name && event.text.includes(name);
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => { try { fn(); } catch (e) { this.opts.errors.record('warn', 'kernel', `拟人层定时器出错: ${(e as Error).message}`); } }, ms);
    t.unref?.();
    return t;
  }

  /** 供 UI/排障：某会话当前的拟人层状态快照 */
  snapshot(chat: ChatRef): Record<string, unknown> {
    const st = this.state(chat);
    const now = this.now();
    const { self, total } = this.recentCounts(st, now);
    return {
      pending: st.buffer.length,
      consecutiveNoAction: st.consecutiveNoAction,
      backoffUntil: st.backoffUntil,
      averageIntervalSeconds: this.averageInterval(st),
      recentSelf: self,
      recentTotal: total,
      frequency: talkValueFor(
        {
          talkValue: this.config.timing.talkValue,
          privateTalkValue: this.config.timing.privateTalkValue,
          enableRules: this.config.timing.enableRules,
          rules: this.config.timing.rules,
        },
        chat,
      ),
      idleSeconds: st.lastInboundAt ? (now - st.lastInboundAt) / 1000 : 0,
      presencePenalty: presencePenalty(self, total),
      triggerThreshold: this.config.timing.necessityThreshold || NECESSITY_TRIGGER_SCORE,
    };
  }

  /** 配置热更新后重新武装主动发言计时器（打开开关能立即生效） */
  rearmAll(): void {
    const cfg = this.config;
    for (const [k, st] of this.states) {
      const [type, ...rest] = k.split('_');
      const chat: ChatRef = { platform: '', type: type as 'group' | 'private', chatId: rest.join('_') };
      this.armIdleTimer(chat, st, cfg);
    }
  }

  /** 清掉所有会话的攒货与计时器（测试用；配置热更新后也可用来甩掉过期状态） */
  resetAll(): void {
    for (const st of this.states.values()) {
      for (const t of [st.debounce, st.maxWait, st.recheck, st.idle]) if (t) clearTimeout(t);
    }
    this.states.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.resetAll();
  }
}

/** 一条待发消息及其发送前的停顿 */
export interface SendPlan {
  segments: MsgSegment[];
  /** 发出这条之前的等待（毫秒）；第一条为 0 */
  pauseMs: number;
}
