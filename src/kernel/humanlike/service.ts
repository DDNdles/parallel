/**
 * 拟人化服务 —— 内核里"什么时候说、怎么说"的那一半。
 *
 * 对上下暴露三件事：
 *  1. `ingest()`  入站消息的门控：私聊必回但也攒批（连发几句合成一个请求）；
 *                 群聊按积压条数门槛 + 空窗补偿攒着，
 *                 攒够了再由回调叫 pipeline 去跑一轮（这就是"会接话"与"会主动说话"）。
 *  2. `compose()` 出站回复的塑形：按句分条 → 逐条打字停顿（纯程序，模型不写任何格式标记）。
 *  3. 每会话一份心流状态：最近消息窗口（自我占比特征）、平均消息间隔（空窗补偿用）、
 *                 连续不理人的计数（空闲退避用）。
 *
 * 这一层不在插件体系里：它是 chat 区行为本身，插件只能通过钩子微调。
 */

import type { ChatEvent, ChatRef, MsgSegment } from '../types.ts';
import type { Bus } from '../bus.ts';
import type { ErrorCenter } from '../errors.ts';
import type { SessionLog } from '../sessionlog.ts';
import { faceTokensToSegments } from '../util/qqface.ts';
import {
  CIRCADIAN, LIVELINESS, SIGNAL,
  adaptiveThreshold, backoffBypassed, circadianThresholdMultiplier, idleBackoffSeconds,
  idleCompensation, idleEquivalentCap, looksLikeFlood, looksLikeQuestion,
  softThresholdProbability, talkValueFor,
} from './frequency.ts';
import {
  activeAntiRepeat,
  detectRepetition,
  markRepetitionNudged,
  markRepetitionRetry,
  repetitionHitInText,
  repetitionNudgeDue,
  repetitionSection,
  touchAntiRepeat,
  type AntiRepeatEntry,
} from './repetition.ts';
import { MAX_BUBBLES, clip, isSilentScene, normalizeVisibleContent, splitIntoBubbles, trimAtSentence, typingDelayMs } from './delivery.ts';
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
  /** 最近窗口内的消息（self = 自己真正发出去的），用于存在感/自我占比特征 */
  recent: { at: number; self: boolean }[];
  /** 相邻入站消息的间隔（秒），用于空窗补偿里的"群平均节奏"；连发 <5s 不计 */
  intervals: { at: number; gap: number }[];
  lastInboundAt: number;
  lastSpokeAt: number;
  /** 连续"进过轮但模型没说话"的次数，驱动空闲退避（门控 wait 不计） */
  consecutiveNoAction: number;
  backoffUntil: number;
  lastWaitLoggedAt: number;
  /** 最近若干轮的「节奏签名」（HDSI ChatRhythm 的窗口） */
  rhythmSigs: string[];
  /** 最近几轮实际发了几条气泡（气泡数避重用；rhythmSigs 只记 1 / 2 / 3+ 粗结构，分辨不出 3 和 4） */
  bubbleCounts: number[];
  /** 连续注入了提示但节奏没变好的次数（熔断用） */
  rhythmExhausted: number;
  /** 最近 bot 实际说出去的整轮文本（重复惩罚用；每轮一条） */
  selfTexts: { at: number; text: string }[];
  /** 最近入站文本（重复惩罚用：群里也在聊的词不罚） */
  inboundTexts: { at: number; text: string }[];
  /** 重复惩罚的冷却状态（词 → 冷却/连击） */
  antiRepeat: AntiRepeatEntry[];
  /** 日程计划（HDSI Schedule Preplan；写入入口已删，只剩读取与容量判断） */
  schedule: SchedulePlan;
  /** 上一次主动开口的时间（HDSI 用最小间隔挡频繁主动） */
  lastProactiveAt: number;
  /** C4 昼夜直方图：24 小时桶，随入站累加并按 14 天半衰遗忘；样本不足时因子回中性 */
  hourly: number[];
  hourlyTouchedAt: number;
}

/** 相邻入站间隔的统计窗口（MaiBot 30 分钟）与连发抖动阈值（<5s 不计入平均） */
const INTERVAL_WINDOW_MS = 30 * 60_000;
const INTERVAL_BURST_MS = 5_000;
/** 间隔 ≥10 分钟算沉默不算节奏：沉默由空窗补偿折算，记进样本只会把折算的除数拉爆（沉默越久越不想说，方向反了） */
const SILENCE_GAP_SECONDS = 600;
/** 空窗补偿的平均间隔下限：低活跃群里别把沉默折算得太快（MaiBot 30s） */
const IDLE_COMPENSATION_MIN_AVERAGE_INTERVAL_SECONDS = 30;

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
}

export class HumanlikeService {
  private states = new Map<string, ChatState>();
  private disposed = false;
  private readonly now: () => number;
  /** 当前人格的叫醒词（canon.json 的 aliases，由 chat 插件推送）：与 QQ 昵称同一条提及通道 */
  private mentionAliases: string[] = [];

  constructor(private opts: HumanlikeServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  get config(): HumanlikeConfig {
    return this.opts.config() ?? DEFAULT_HUMANLIKE;
  }

  /**
   * 换人格时更新叫醒词。只收 2 字以上的词：单字（鱼/鲸）会在「鱼香肉丝」里误触；
   * 纯 ASCII 在匹配时按词边界处理（见 mentionHit）。
   */
  setMentionAliases(list: unknown): void {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(list) ? list : []) {
      const s = String(raw ?? '').trim();
      if ([...s].length < 2 || s.length > 24) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 24) break;
    }
    this.mentionAliases = out;
  }

  /** 判断"在跟我说话"时认的全部名字：QQ 昵称 + 当前人格叫醒词 */
  private mentionNames(): string[] {
    const name = this.opts.selfNickname().trim();
    return name ? [name, ...this.mentionAliases] : [...this.mentionAliases];
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
        rhythmSigs: [], bubbleCounts: [], rhythmExhausted: 0,
        selfTexts: [], inboundTexts: [], antiRepeat: [],
        schedule: emptyPlan(), lastProactiveAt: 0,
        hourly: new Array<number>(24).fill(0), hourlyTouchedAt: 0,
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
  ingest(event: ChatEvent): { action: 'pass'; events: ChatEvent[]; merged: boolean } | { action: 'handled' } {
    if (this.disposed) return { action: 'pass', events: [event], merged: false };
    const cfg = this.config;
    const timing = cfg.timing;
    const st = this.state(event);
    const now = this.now();

    // 统计：平均间隔 + 存在感窗口（每条入站都算"群里有动静"）
    this.recordInbound(st, now);
    // 重复惩罚的入站对照
    this.recordInboundText(st, now, event.text);

    // 私聊：**必回，但同样攒批**（2026-10-18 用户裁定）。
    // 打分与开口判定一概不做（私聊频率只影响主动发言，这条语义不变），只借合批那一层：
    // 对面连发三句是一件事，不该拆成三轮、每轮各起一组气泡（实测每条入站一个请求、
    // 平均 3.07 条气泡）。攒够 windowMs 就一次性交出去（不起跳：起跳抖动只属于群聊）；
    // 只有单条时与旧的秒回等价。
    if (event.type === 'private') {
      if (!cfg.merge.enable) return { action: 'pass', events: [event], merged: false };
      const chat: ChatRef = { platform: event.platform, type: event.type, chatId: event.chatId };
      st.buffer.push(event);
      if (!st.firstBufferedAt) st.firstBufferedAt = now;
      if (st.debounce) clearTimeout(st.debounce);
      // 攒批只为拼请求，**不起跳**（2026-10-19 用户裁定）：私聊单独一条也要快，
      // 群聊那 0.5~2s 起跳抖动只属于群聊门控。攒够 windowMs 就交出去。
      st.debounce = this.timer(() => {
        st.debounce = undefined;
        this.flushPrivate(chat, st);
      }, cfg.merge.windowMs);
      // 兜底与群聊同一把尺子：从第一条起最多攒 maxWaitMs
      if (!st.maxWait) {
        st.maxWait = this.timer(() => {
          st.maxWait = undefined;
          this.flushPrivate(chat, st);
        }, cfg.merge.maxWaitMs);
      }
      this.armIdleTimer(chat, st, cfg);
      return { action: 'handled' };
    }

    const hasAt = event.isAtMe;
    const hasMention = this.mentioned(event);
    const chatRef: ChatRef = { platform: event.platform, type: event.type, chatId: event.chatId };

    // 被 @ 必回：立刻放行，但把已经攒着的消息一起带上（让模型看到完整上下文）
    if (hasAt) {
      const merged = this.bufferLen(st) > 0;
      const events = this.drain(st, event);
      this.noteForcedTurn(chatRef);
      this.armIdleTimer(chatRef, st, cfg);
      return { action: 'pass', events, merged };
    }
    // 仅 @ 后才回复：名字提及不再直通（@ 已经在上面处理，私聊走前面的分支不受影响）
    if (hasMention && timing.mentionedBotReply && !timing.onlyReplyWhenAt) {
      const merged = this.bufferLen(st) > 0;
      const events = this.drain(st, event);
      this.noteForcedTurn(chatRef);
      this.armIdleTimer(chatRef, st, cfg);
      return { action: 'pass', events, merged };
    }

    this.armIdleTimer(chatRef, st, cfg);

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
   * 私聊合批到点：整批交回内核，**不评估、不打分、不过 TTL**。
   * 与群聊 `evaluate` 的区别就是这三件都不做——私聊必回，"该不该说话"在这里不是问题，
   * 攒批只为把对面连发的几句拼成一个请求。
   */
  private flushPrivate(chat: ChatRef, st: ChatState): void {
    if (this.disposed || !st.buffer.length) return;
    const events = this.drain(st);
    if (!events.length) return;
    this.opts.trigger({ chat, events, reason: 'private', detail: `私聊合批 ${events.length} 条` });
  }

  /**
   * 合批关窗后的随机起跳延时（毫秒）：默认 0.5~2 秒。**只用于群聊门控**——
   * 私聊攒批不起跳（单独一条也要快，关即处理）。
   * 等待期间新来的消息会重置防抖窗口（= 群里还在刷，她继续看戏），@/提及仍然直通。
   */
  private fireJitter(cfg: HumanlikeConfig): number {
    const lo = Math.max(0, Math.round(Number(cfg.merge.fireDelayMinMs) || 0));
    const hi = Math.max(lo, Math.round(Number(cfg.merge.fireDelayMaxMs) || 0));
    if (hi <= 0) return 0;
    const r = this.opts.random ?? Math.random;
    return lo + Math.round(r() * (hi - lo));
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
   * 核心决策：现在该不该开口。
   *  - 积压 >= `pendingThreshold` 直接放行；
   *  - 不够时用空窗补偿补一次（沉默久了折算成等效消息数，这就是潜水久了会突然插一嘴）；
   *  - `talkValue=0` = 这个会话现在不说话（@/提及仍由上面的硬规则直通）。
   * 都不满足时按 min(退避, 空窗还差的秒数) 安排下次评估，不做轮询空转。
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
    // 回复时机是全局一套（群聊/私聊只在频率上分档，没有按会话的覆盖）
    const timing = cfg.timing;

    // 仅 @ 后才回复：群聊普通消息只留在缓冲里当上下文，不评估、不主动开口，也不安排重试
    // （没有 @ 就没有需要重试的判定；@ 到达时 ingest 的直通分支会把这些消息一起带上）。
    if (timing.onlyReplyWhenAt && carrier.type === 'group') {
      this.logWait(carrier, st, '仅 @ 后才回复：普通群聊消息不触发');
      return;
    }

    // 专注模式（setting: timing.focusMode）：普通群聊不参与打分，只接 @/提及。
    if (timing.focusMode && carrier.type === 'group' && !hasAt && !hasMention) {
      this.armRecheck(carrier, st, 30_000);
      this.logWait(carrier, st, '专注模式：普通群聊不参与打分，只接 @/提及');
      return;
    }

    const pending = st.buffer.length;
    const avgInterval = this.averageInterval(st);
    const frequency = talkValueFor(timing, chat);
    const freq = Math.min(1, Math.max(0, Number(frequency) || 0));
    // talkValue=0 = 这个会话现在不说话（@/提及仍由上面的硬规则直通）
    const silentByFrequency = freq <= 0;
    /** 攒够多少条才进一轮：只看积压条数，talkValue 的数值不参与折算 */
    const configuredThreshold = Math.max(1, Math.round(Number(timing.pendingThreshold) || 1));

    // ---- C1 自适应门槛：快群（avg 被 30s 下限钳住）恰为配置值，慢群按同一把 avg 反比放宽 ----
    // ---- C4 昼夜因子：本群历史上冷清的小时更矜持（样本不足回中性 1） ----
    // ---- B3 便宜信号：末条是问句打折、窗口内同质短消息爆发加倍 ----
    const mods: string[] = [];
    let effThreshold = adaptiveThreshold(configuredThreshold, avgInterval, st.intervals.length);
    if (effThreshold !== configuredThreshold) {
      mods.push(`自适应${configuredThreshold}→${effThreshold}`);
    }
    const circMult = circadianThresholdMultiplier(st.hourly, new Date(now).getHours());
    if (circMult > 1.01) mods.push(`昼夜×${circMult.toFixed(2)}`);
    let signalMult = circMult;
    if (looksLikeQuestion(carrier.text ?? '')) {
      mods.push(`问句×${SIGNAL.QUESTION_FACTOR}`);
      signalMult *= SIGNAL.QUESTION_FACTOR;
    }
    if (looksLikeFlood(st.buffer, now)) {
      mods.push(`刷屏×${SIGNAL.FLOOD_FACTOR}`);
      signalMult *= SIGNAL.FLOOD_FACTOR;
    }
    effThreshold = Math.max(1, Math.min(24, Math.round(effThreshold * signalMult)));

    // ---- B2 退避语义修正：近 5 分钟真人消息 ≥3 条 = 群重新热闹，清退避（热闹就别装矜持） ----
    const rc = this.recentCounts(st, now);
    if (rc.total - rc.self >= LIVELINESS.MIN_INBOUND) {
      st.consecutiveNoAction = 0;
      st.backoffUntil = 0;
    }

    // ---- B1 空窗补偿换锚：沉默从 bot 上次开口算起，不再被 buffer TTL 连坐 ----
    //（没开过口时退回旧口径 now-lastInboundAt；开口后 idle 归零，天然形成短期高参与窗口 = C3）
    const idleBase = st.lastSpokeAt || st.lastInboundAt;
    const idleSeconds = idleBase ? Math.max(0, (now - idleBase) / 1000) : 0;
    const comp = idleCompensation({
      pendingCount: pending,
      triggerThreshold: effThreshold,
      idleSeconds,
      averageIntervalSeconds: avgInterval,
      maxEquivalent: idleEquivalentCap(effThreshold),
    });

    // 空闲退避：连续不理人就指数放慢；群里重新热闹（积压够多）直接绕过
    const backoff = idleBackoffSeconds(cfg.backoff, st.consecutiveNoAction);
    const bypass = backoffBypassed(cfg.backoff, pending);
    if (backoff > 0 && !bypass && now < st.backoffUntil) {
      this.armRecheck(carrier, st, Math.max(200, st.backoffUntil - now));
      this.logWait(carrier, st, `退避中（还差 ${Math.round((st.backoffUntil - now) / 1000)}s，连续不说=${st.consecutiveNoAction}）`);
      return;
    }

    let reason: TriggerBatch['reason'] | null = null;
    let detail = '';
    const modSuffix = mods.length ? `（${mods.join('，')}）` : '';
    if (!silentByFrequency && pending >= effThreshold) {
      reason = 'frequency';
      detail = `pending=${pending} >= ${effThreshold}${modSuffix}`;
    } else if (!silentByFrequency && comp.reached) {
      reason = 'idle';
      detail = `${comp.detail}${modSuffix}`;
    } else {
      // ---- C2 软阈值：等效条数已过 85% 门槛时按超出比例概率开口（消除「差一条」悬崖） ----
      const p = silentByFrequency ? 0 : softThresholdProbability(comp.equivalent, effThreshold);
      const rng = this.opts.random ?? Math.random;
      if (p > 0 && (p >= 1 || rng() < p)) {
        reason = 'frequency';
        detail = `软阈值 等效=${comp.equivalent.toFixed(2)}/${effThreshold} 概率=${p.toFixed(2)}${modSuffix}`;
      } else {
        detail = silentByFrequency ? 'talkValue=0，静默' : comp.detail + (p > 0 ? ` 软阈值未命中(p=${p.toFixed(2)})` : '') + modSuffix;
      }
    }

    if (reason) {
      const events = this.drain(st);
      st.consecutiveNoAction = 0;
      st.backoffUntil = 0;
      this.opts.sessionLog.append(carrier.chatId, carrier.type, {
        type: 'gate', role: 'system',
        text: `开口（${reason}）：${detail}`,
        data: { reason, detail, pending, frequency },
      });
      this.opts.trigger({ chat, events, reason, detail });
      return;
    }

    // 决定不说：累加退避，按 min(退避, 空窗还差的秒数) 再评估
    st.consecutiveNoAction += 1;
    const nextBackoff = idleBackoffSeconds(cfg.backoff, st.consecutiveNoAction);
    st.backoffUntil = nextBackoff > 0 ? now + nextBackoff * 1000 : 0;
    const waits = [nextBackoff * 1000, comp.delaySeconds * 1000].filter((n) => n > 0);
    const delay = Math.max(250, Math.min(...(waits.length ? waits : [1000])));
    this.armRecheck(carrier, st, delay);
    this.logWait(carrier, st, `不说：${detail}`);
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

  /** 被 @/提及强制触发：被点名了就别装矜持，清掉空闲退避 */
  noteForcedTurn(chat: ChatRef): void {
    const st = this.state(chat);
    st.consecutiveNoAction = 0;
    st.backoffUntil = 0;
  }

  // ------------------------------------------------------------ 主动发言（没人说话也开口）

  /** 群里静默够久时起个话头；由 `proactive.enable` 单独控制（风控红线：主动发言属于主动推送） */
  private armIdleTimer(chat: ChatRef, st: ChatState, cfg: HumanlikeConfig): void {
    if (st.idle) clearTimeout(st.idle);
    if (!cfg.proactive.enable) return;
    // 仅 @ 后才回复：主动起话头也不允许（那是普通开口，不是被点名）
    if (cfg.timing.onlyReplyWhenAt) return;
    st.idle = this.timer(() => {
      st.idle = undefined;
      if (this.disposed) return;
      if (cfg.timing.onlyReplyWhenAt) return;
      if (st.buffer.length) return;                       // 有待处理消息时交给正常门控
      const now = this.now();
      const idleSeconds = st.lastInboundAt ? (now - st.lastInboundAt) / 1000 : 0;
      const lastBotAt = Math.max(st.lastSpokeAt, st.lastProactiveAt);
      const selfIdle = lastBotAt ? (now - lastBotAt) / 1000 : Number.POSITIVE_INFINITY;
      if (idleSeconds < cfg.proactive.idleSeconds || selfIdle < cfg.proactive.idleSeconds) {
        this.armIdleTimer(chat, st, cfg);
        return;
      }
      st.lastProactiveAt = now;
      st.consecutiveNoAction = 0;
      st.backoffUntil = 0;
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
   * 最近几轮的**实际气泡条数**（精确值），给气泡数抽签做避重。
   * 旧状态没记 bubbleCounts 时退回节奏签名（结构维度只有 1 / 2 / 3+→4，3 条会被当成 4）。
   */
  recentBubbleShapes(chat: ChatRef, n = 3): number[] {
    const st = this.state(chat);
    if (st.bubbleCounts.length) return st.bubbleCounts.slice(-n);
    return st.rhythmSigs.slice(-n).map((sig) => {
      const head = String(sig).split(/[|/]/)[0].trim();
      if (head === '1') return 1;
      if (head === '2') return 2;
      return 4;
    });
  }

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
    // 存在感按"轮"计：一次 reply 只往历史里写一条，不按这次拆出来的气泡数重复计。
    st.recent.push({ at: now, self: true });
    if (bubbles.length) {
      const cfg = this.config.rhythm;
      st.rhythmSigs.push(rhythmSignature(bubbles));
      while (st.rhythmSigs.length > Math.max(5, cfg.historyLimit)) st.rhythmSigs.shift();
      // 气泡数避重另记精确条数：节奏签名的 3+ 分桶分辨不出 3 和 4/5/6，
      // 拿到抽签器里会漏罚 3 条、让 4 条替 5/6 条挨罚（2026-10-27 修）。
      st.bubbleCounts.push(bubbles.length);
      while (st.bubbleCounts.length > Math.max(5, cfg.historyLimit)) st.bubbleCounts.shift();
      // 重复惩罚按"轮"记：一轮多条气泡合成一条，避免一次回复里多说两遍就被算成两轮。
      const said = bubbles.map((b) => String(b ?? '').trim()).filter(Boolean).join('\n');
      if (said) {
        st.selfTexts.push({ at: now, text: said.slice(0, 300) });
        this.trimTexts(st.selfTexts, now);
      }
    }
  }

  /** 重复惩罚的最终回复检查：只在当前生效的冷却词里找，不重新扫全量 */
  repetitionHit(chat: ChatRef, reply: string): { phrase: string } | null {
    const cfg = this.config.repetition;
    if (!cfg.enable || !cfg.retry) return null;
    const hit = repetitionHitInText(reply, this.state(chat).antiRepeat, this.now());
    return hit ? { phrase: hit.phrase } : null;
  }

  /** 重写回执：成功解除冷却；失败累加 strike，到上限后不再重写 */
  noteRepetitionRetry(chat: ChatRef, phrase: string, ok: boolean): void {
    const st = this.state(chat);
    st.antiRepeat = markRepetitionRetry(st.antiRepeat, phrase, ok, this.now(), this.config.repetition);
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

    // 462 重复提醒（词面级，和上面的结构级 rhythm 互补）
    if (cfg.repetition.enable) {
      const hits = detectRepetition(st.selfTexts, st.inboundTexts, cfg.repetition);
      st.antiRepeat = hits.length
        ? touchAntiRepeat(st.antiRepeat, hits, now, cfg.repetition)
        : st.antiRepeat.filter((e) => e.untilAt > now);
      const active = activeAntiRepeat(st.antiRepeat, now);
      if (active.length && repetitionNudgeDue(st.antiRepeat, now)) {
        const text = repetitionSection(active, Math.min(cfg.repetition.windowMessages, st.selfTexts.length));
        if (text) {
          out.push({ order: 462, title: 'repetition', text });
          st.antiRepeat = markRepetitionNudged(st.antiRepeat, now);
          this.opts.sessionLog.append(chat.chatId, chat.type, {
            type: 'gate', role: 'system',
            text: `重复提醒：${active.slice(0, 3).map((e) => e.phrase).join('、')}`,
            data: { decision: 'repetition_nudge', phrases: active.slice(0, 3).map((e) => e.phrase) },
          });
        }
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
  async composeScene(text: string, opts?: { maxBubbles?: number }): Promise<{ plans: SendPlan[]; historyText: string; spoke: boolean }> {
    const cfg = this.config;
    const scene = String(text ?? '');
    if (isSilentScene(scene)) return { plans: [], historyText: '', spoke: false };

    const bubbles = this.collectBubbles(scene, cfg, opts?.maxBubbles);
    return { plans: this.plan(bubbles), historyText: bubbles.join('\n'), spoke: bubbles.length > 0 };
  }

  /** 只要发送计划（不关心正文时用；测试与验收脚本走这里） */
  async compose(chat: ChatRef, text: string): Promise<SendPlan[]> {
    void chat;
    return (await this.composeScene(text)).plans;
  }

  /** 汇报轮正文：不进聊天气泡那套「按句切、50 字截断」，也不设字数上限
   *  （2026-10-25 用户定：聊天合集里的正文全文送出），只做可见化清洗。 */
  reportText(raw: string): string {
    const scene = String(raw ?? '');
    if (isSilentScene(scene)) return '';
    return normalizeVisibleContent(scene, Number.MAX_SAFE_INTEGER).trim();
  }

  /** 单条文本的打字等待（秒），插件想自己排节奏时用（下限 0.25s） */
  typingSeconds(text: string): number {
    return typingDelayMs(text, this.config.outgoing) / 1000;
  }

  // ------------------------------------------------------------ 出站塑形

  /**
   * 可见正文 → 待发气泡（纯程序，口径见 delivery.ts）：
   * 归一化 → 句边截断（回复总长上限的兜底）→ 按换行与句末标点分条。
   * 模型不写任何格式标记；关掉 `splitReplyMessages` 就整段一条发出去。
   */
  private collectBubbles(text: string, cfg: HumanlikeConfig, maxBubblesOverride?: number): string[] {
    const out = cfg.outgoing;
    // 顺序（2026-10-24 修）：剥标记 → 句边截断到「回复总长上限」→ 分条 → **逐条**套单条上限。
    // 之前把 maxMessageCharacters（单条平台安全垫，线上 24）套在整段回复上，
    // 24 字之后被硬切，"稍等本鱼哦"只剩"稍等本"这类半截话就是这么来的。
    const stripped = normalizeVisibleContent(text, Number.MAX_SAFE_INTEGER);
    const t = trimAtSentence(stripped, out.replyMaxCharacters);
    if (!t) return [];
    if (out.splitReplyMessages === false) return [clip(t, out.maxMessageCharacters)];
    const maxBubbles = Math.max(1, Math.round(
      Number(maxBubblesOverride ?? (out as { maxBubbles?: number }).maxBubbles) || MAX_BUBBLES,
    ));
    return splitIntoBubbles(t, maxBubbles, out.bubbleSoftMaxCharacters)
      .map((b) => (b.length > out.maxMessageCharacters ? clip(b, out.maxMessageCharacters) : b));
  }

  /** 气泡 → 带打字停顿的发送计划：第一条不等，之后每条按自己的字数算「正在输入」要多久。
   *  模型写的 `[表情/微笑]` 在这里切成真正的 face 段（文字与表情可以在同一条气泡里）。 */
  private plan(bubbles: string[]): SendPlan[] {
    const cfg = this.config.outgoing;
    return bubbles
      .map((text) => ({ text, segments: faceTokensToSegments(text) }))
      // 整条只是切坏的表情标记（如 `183]`）时没有可发内容：直接丢掉这条气泡
      .filter((p) => p.segments.some((s) => s.type === 'face' || String(s.data.text ?? '').trim()))
      .map((p, i) => ({
        segments: p.segments,
        pauseMs: i === 0 || !cfg.typingEnabled ? 0 : typingDelayMs(p.text, cfg),
      }));
  }

  // ------------------------------------------------------------ 状态维护

  private recordInbound(st: ChatState, now: number): void {
    if (st.lastInboundAt) {
      const gap = (now - st.lastInboundAt) / 1000;
      // 连发抖动 <5s 不代表真实发言节奏；≥10min 是沉默不是节奏——两头都不进样本
      if (gap * 1000 >= INTERVAL_BURST_MS && gap <= SILENCE_GAP_SECONDS) {
        st.intervals.push({ at: now, gap });
      }
      const cut = now - INTERVAL_WINDOW_MS;
      while (st.intervals.length && st.intervals[0].at < cut) st.intervals.shift();
      if (st.intervals.length > 200) st.intervals.splice(0, st.intervals.length - 200);
    }
    st.lastInboundAt = now;
    st.recent.push({ at: now, self: false });
    this.trimRecent(st, now);
    // C4 昼夜直方图：先按距上次更新的时长做半衰遗忘（长眠的旧分布慢慢让位），再记入当前小时
    const decay = st.hourlyTouchedAt
      ? 0.5 ** Math.max(0, (now - st.hourlyTouchedAt) / CIRCADIAN.HALF_LIFE_MS)
      : 1;
    for (let h = 0; h < 24; h++) st.hourly[h] *= decay;
    st.hourly[new Date(now).getHours()] += 1;
    st.hourlyTouchedAt = now;
  }

  /** 重复惩罚的入站对照：记录群里最近在聊什么（空文本不算） */
  private recordInboundText(st: ChatState, now: number, text: unknown): void {
    const t = String(text ?? '').trim();
    if (!t) return;
    st.inboundTexts.push({ at: now, text: t.slice(0, 300) });
    this.trimTexts(st.inboundTexts, now);
  }

  /** 文本环统一上限：40 条 / 40 分钟；判定窗口（默认 20 轮）再从中截 */
  private trimTexts(list: { at: number; text: string }[], now: number): void {
    const cut = now - 40 * 60_000;
    while (list.length && (list[0].at < cut || list.length > 40)) list.shift();
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
    // MaiBot：30 分钟窗口里没有样本、但见过消息时，用 30s 的保守下限
    if (!st.intervals.length) {
      return st.lastInboundAt ? IDLE_COMPENSATION_MIN_AVERAGE_INTERVAL_SECONDS : null;
    }
    // 2026-10-24 起用中位数而非均值：长沉默本身会产生一个超大的间隔样本，
    // 均值被它拉爆后空窗折算（沉默÷avg）反而变弱——沉默越久越不想说话，方向反了。
    // 人类发言间隔是重尾分布，分位数才是稳健统计（lognormal 文献口径）。
    const gaps = st.intervals.map((i) => i.gap).sort((a, b) => a - b);
    const mid = gaps[Math.floor(gaps.length / 2)] ?? gaps[0] ?? 0;
    return Math.max(IDLE_COMPENSATION_MIN_AVERAGE_INTERVAL_SECONDS, mid);
  }

  private mentioned(event: ChatEvent): boolean {
    if (event.isReplyToMe) return true;
    return this.mentionNames().some((name) => mentionHit(event.text, name));
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => { try { fn(); } catch (e) { this.opts.errors.record('warn', 'kernel', `拟人层定时器出错: ${(e as Error).message}`); } }, ms);
    t.unref?.();
    return t;
  }

  /** 供 UI/排障：某会话当前的拟人层状态快照 */
  snapshot(chat: ChatRef): Record<string, unknown> {
    const cfg = this.config;
    const st = this.state(chat);
    const now = this.now();
    const { self, total } = this.recentCounts(st, now);
    return {
      pending: st.buffer.length,
      consecutiveNoAction: st.consecutiveNoAction,
      backoffUntil: st.backoffUntil,
      mentionAliases: [...this.mentionAliases],
      averageIntervalSeconds: this.averageInterval(st),
      recentSelf: self,
      recentTotal: total,
      frequency: talkValueFor(cfg.timing, chat),
      idleSeconds: st.lastInboundAt ? (now - st.lastInboundAt) / 1000 : 0,
      secondsSinceBotMessage: st.lastSpokeAt ? (now - st.lastSpokeAt) / 1000 : null,
      pendingThreshold: cfg.timing.pendingThreshold,
    };
  }

  /** 配置热更新后重新武装主动发言计时器（打开开关能立即生效） */
  rearmAll(): void {
    const cfg = this.config;
    for (const [k, st] of this.states) {
      const [type, ...rest] = k.split('_');
      // platform 不在会话键里；按本体系唯一的真实传输端补齐 qq（UI 注入只是视图，不是会话来源）
      const chat: ChatRef = { platform: 'qq', type: type as 'group' | 'private', chatId: rest.join('_') };
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

/**
 * 提及命中：中文按子串（与旧口径一致）；纯 ASCII 按词边界，避免 `bot` 命中 `robot`。
 * 大小写不敏感只对 ASCII 生效——中文没有大小写。
 */
function mentionHit(text: string, name: string): boolean {
  if (!name) return false;
  if (!/^[\x20-\x7e]+$/.test(name)) return text.includes(name);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`, 'i').test(text);
}
