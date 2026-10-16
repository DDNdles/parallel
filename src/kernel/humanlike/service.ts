/**
 * 拟人化服务 —— 内核里"什么时候说、怎么说"的那一半。
 *
 * 对上下暴露三件事：
 *  1. `ingest()`  入站消息的门控：@/私聊/命令立刻放行，其余按必要性打分 + 空窗补偿攒着，
 *                 攒够了再由回调叫 pipeline 去跑一轮（这就是"会接话"与"会主动说话"）。
 *  2. `compose()` 出站回复的塑形：分段 → 注错字 → 逐条 + 打字停顿（这就是"单句单句发"）。
 *  3. 每会话一份心流状态：最近消息窗口（存在感惩罚用）、平均消息间隔（空窗补偿用）、
 *                 连续不理人的计数（空闲退避用）。
 *
 * 这一层不在插件体系里：它是 chat 区行为本身，插件只能通过钩子微调（关分段/关错字）。
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
import { backoffBypassed, idleBackoffSeconds, talkValueFor } from './frequency.ts';
import { normalizeVisibleContent, splitOutgoingMessage, typingDelayMs } from './delivery.ts';
import { isSilentScene, readAuthoredActions, splitBubbles } from './script.ts';
import { advanceAlter, alterOffsetForPrompt, createAlterState, readAlter, type AlterState } from './alter.ts';
import { detectCollapse, rhythmNudge, rhythmSignature } from './rhythm.ts';
import { deriveWindow, evaluateAgency, nextRecheckAt, type ProactiveContactCandidate } from './agency.ts';
import { currentActivity, emptyPlan, prunePlan, schedulePrompt, type SchedulePlan } from './schedule.ts';
import {
  DEFAULT_HUMANLIKE,
  PRESENCE_WINDOW_SECONDS,
  type HumanlikeConfig,
  type TriggerBatch,
} from './types.ts';

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
  /** 情绪偏移状态（HDSI Alter） */
  alter: AlterState;
  /** 日程计划（HDSI Schedule Preplan） */
  schedule: SchedulePlan;
  /** 上一次主动开口的时间（HDSI 用最小间隔挡频繁主动） */
  lastProactiveAt: number;
}

const INTERVAL_SAMPLE = 20;

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
  /**
   * 侧端氛围分析（HDSI 的 Alter 分析任务）。命中阈值时异步跑一次，**不阻塞可见回复**；
   * 回来之后写进氛围参考，之后几轮注入。拿不到（没接模型 / 失败）就当没这回事。
   */
  describeAlter?: (payload: {
    value: number;
    direction: 'serious' | 'relaxed';
    recent: string[];
  }) => Promise<{ direction: 'serious' | 'relaxed'; description: string; intensity: number } | null>;
}

export class HumanlikeService {
  private states = new Map<string, ChatState>();
  private disposed = false;
  private readonly now: () => number;

  constructor(private opts: HumanlikeServiceOptions) {
    this.now = opts.now ?? Date.now;
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
        alter: createAlterState(), schedule: emptyPlan(), lastProactiveAt: 0,
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

    // 防抖：静默 windowMs 后评估
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = this.timer(() => {
      st.debounce = undefined;
      this.evaluate(event, st, cfg, hasAt, hasMention);
    }, cfg.merge.windowMs);

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
    const mainGate = mode === 'frequency'
      ? pending >= cfg.timing.pendingThreshold
      : scored.score >= threshold;

    let reason: TriggerBatch['reason'] | null = null;
    let detail = '';
    if (mainGate) {
      reason = mode === 'frequency' ? 'frequency' : 'necessity';
      detail = mode === 'frequency'
        ? `pending=${pending} >= ${cfg.timing.pendingThreshold}`
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
        data: { reason, detail, score: scored.score, pending, frequency },
      });
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
    this.armRecheck(carrier, st, delay);
    this.logWait(carrier, st, `不说：${scored.detail}｜${comp.detail}`);
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

  // ------------------------------------------------------------ 三个 HDSI 子系统的注入

  /**
   * 这一轮要追加的 system 分节（顺序在剧本体之后、插件节之前）：
   *   450 Alter 氛围参考 / 460 节奏提醒 / 470 日程
   * 都只在真有内容时才出节 —— 空节只会白占 token 和注意力。
   */
  sceneSections(chat: ChatRef): { order: number; title: string; text: string }[] {
    const cfg = this.config;
    const st = this.state(chat);
    const now = this.now();
    const out: { order: number; title: string; text: string }[] = [];

    // 450 氛围参考（HDSI Alter）
    const offset = alterOffsetForPrompt(st.alter, cfg.alter);
    if (offset) {
      out.push({
        order: 450,
        title: 'alter',
        text: [
          '# 当前氛围（最近这段时间累积出来的，不是这一句的指令）',
          `- 基调偏「${offset.direction === 'serious' ? '认真' : '放松'}」，强度 ${offset.intensity}/${cfg.alter.maxIntensity}（置信 ${offset.weight.toFixed(2)}）`,
          `- ${offset.description}`,
          '它只影响语气底色，别拿它当话题，也别说明它的存在。',
        ].join('\n'),
      });
    }

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

  /** 日程计划读写（模型经 plan_schedule 工具写；写的时候顺手清过期项） */
  planSchedule(chat: ChatRef, plan: SchedulePlan): SchedulePlan {
    const st = this.state(chat);
    st.schedule = prunePlan(plan, new Date(this.now()), this.config.schedule);
    return st.schedule;
  }

  scheduleOf(chat: ChatRef): SchedulePlan {
    return this.state(chat).schedule;
  }

  /** 侧端分析回来：写氛围参考（HDSI `completeAlterAnalysis`） */
  noteAlterOffset(chat: ChatRef, offset: { direction: 'serious' | 'relaxed'; description: string; intensity: number }): void {
    const st = this.state(chat);
    const now = this.now();
    const cfg = this.config.alter;
    const intensity = Math.max(0, Math.min(cfg.maxIntensity, Math.round(offset.intensity)));
    st.alter = {
      ...st.alter,
      value: 0,
      weight: intensity > 0 ? Math.max(cfg.minWeight, intensity / cfg.maxIntensity) : 0,
      offset: intensity > 0 ? { direction: offset.direction, description: offset.description.slice(0, 120), intensity, at: now } : null,
      lastAnalyzeAt: now,
      exhausted: 0,
    };
  }

  /** 评估过了但最终没发（模型给了 SKIP） */
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
   * 一段剧本 → 待发气泡（HDSI 口径，见 delivery.ts 的说明）。**不做任何文字后处理清洗**：
   *  - 剧本体开着且模型按格式写了 say 块：只有 say 块里的字进群；逐个 action 先归一化并按
   *    `maxMessageCharacters` 截断，再按分隔标记切（HDSI 正是"先截断整条、再分段"）。
   *  - 没有 say 块（模型没按格式来）：退回普通模式，整段当一个可见回复，同样先截断再切 ——
   *    免得它彻底哑掉（对应 HDSI 的 legacy reply.content 路径）。
   * 括号/星号动作描写不再被程序清洗，靠 `<say>` 结构与提示词约束（HDSI 同款）。
   */
  private collectBubbles(scene: string, cfg: HumanlikeConfig): string[] {
    const out = cfg.outgoing;
    const norm = (s: string) => normalizeVisibleContent(s, out.maxMessageCharacters, out.messageSeparator);
    if (cfg.script.enable) {
      const { actions } = readAuthoredActions(scene);
      if (actions.length) {
        const bubbles: string[] = [];
        for (const action of actions) {
          bubbles.push(...splitBubbles(norm(action.content), out.messageSeparator, out.splitReplyMessages));
        }
        return bubbles.filter(Boolean);
      }
    }
    return splitOutgoingMessage(norm(scene), out).filter(Boolean);
  }

  /** 气泡 → 带打字停顿的发送计划：第一条不等，之后每条按自己的字数算「正在输入」要多久（HDSI） */
  private plan(bubbles: string[]): SendPlan[] {
    const cfg = this.config.outgoing;
    return bubbles.map((text, i) => ({
      segments: [{ type: 'text', data: { text } }] as MsgSegment[],
      pauseMs: i === 0 ? 0 : typingDelayMs(text, cfg),
    }));
  }

  /**
   * 一段模型输出 → `{ plans, historyText, spoke }`。
   *
   * 剧本体开着时（默认）：模型写的是"小说的下一段"，**只有 `<say id>` 块里的字会变成 QQ 消息**；
   * 旁白（动作/神态/环境）留在剧本里，从结构上就漏不出去。
   *
   * `historyText` 刻意用**带标签的原文**回灌历史：模型是照着自己上一轮的样子学的 ——
   * 回灌摘掉标签的 prose，它下一轮就不再写 `<say>`，退化成大段旁白直发（实测第 3 轮就退化了）。
   * 标签只在这一层被摘掉，不进历史。
   *
   * 三种情形：
   *   ① 有 say 块 → 只发这些
   *   ② 整段就是沉默标记 → 什么都不发（HDSI 的"不回"）
   *   ③ 没有 say 块 → 模型没按格式来：退回普通模式把整段当一条台词发，免得它彻底哑掉
   */
  async composeScene(text: string, chat?: ChatRef): Promise<{ plans: SendPlan[]; historyText: string; spoke: boolean }> {
    const cfg = this.config;
    // Alter 标记是元数据，不进剧本也不进历史
    const alterRead = readAlter(text);
    const scene = alterRead.text;
    if (chat && alterRead.value !== undefined && cfg.alter.enabled) this.advanceAlterFor(chat, alterRead.value, scene);

    if (isSilentScene(scene)) return { plans: [], historyText: '', spoke: false };

    const bubbles = this.collectBubbles(scene, cfg);
    return { plans: this.plan(bubbles), historyText: scene, spoke: bubbles.length > 0 };
  }

  /** 推进 Alter：累计 + 判阈值；命中阈值就异步跑一次侧端分析（不阻塞本轮） */
  private advanceAlterFor(chat: ChatRef, alter: number, scene: string): void {
    const cfg = this.config;
    const st = this.state(chat);
    const now = this.now();
    const out = advanceAlter(st.alter, alter, now, cfg.alter);
    st.alter = out.state;
    if (!out.thresholdReached || !this.opts.describeAlter) return;
    if (st.alter.lastAnalyzeAt > 0 && now - st.alter.lastAnalyzeAt < 5 * 60_000) return;
    const value = st.alter.value;
    const direction: 'serious' | 'relaxed' = value >= 0 ? 'relaxed' : 'serious';
    const recent = st.rhythmSigs.slice(-4);
    st.alter = { ...st.alter, lastAnalyzeAt: now };
    void this.opts.describeAlter({ value, direction, recent })
      .then((r) => { if (r) this.noteAlterOffset(chat, r); })
      .catch(() => { /* 侧端失败就当没这回事，下一轮会再试 */ });
    void scene;
  }

  /** 只要发送计划（不关心剧本正文时用；测试与验收脚本走这里） */
  async compose(chat: ChatRef, text: string): Promise<SendPlan[]> {
    void chat;
    return (await this.composeScene(text)).plans;
  }

  /** 单条文本的打字等待（秒），插件/命令想自己排节奏时用（HDSI 口径，下限 0.25s） */
  typingSeconds(text: string): number {
    return typingDelayMs(text, this.config.outgoing) / 1000;
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
