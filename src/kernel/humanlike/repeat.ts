/**
 * 跟屏复读 —— 纯程序段，不走模型。
 *
 * 群里 >=N 位群友**在时间窗内**接连说了同一句话时，完整跟一条同样的；发送前带随机等待，
 * 显得不机械。三个会让它"看起来没实现"的坑（2026-10-28 修）：
 *  - 段有时间窗（humanlike.repeat.windowSec）：窗外的同文消息算新一段。否则「哈哈哈」这类
 *    高频句隔几小时也在续同一段，凑够人数就在错误的时机突然冒出来；
 *  - 发射后整段作废：旧实现 fired 挂在段上，只要没人说一句不同的话，这句话永远不再触发；
 *  - 冷却期内攒满不再直接丢：定时器推迟到冷却结束后发射（fire 时再校验一次冷却）。
 *
 * 与开口侧的差别：这里不判"要不要说"，只判"跟不跟屏"；正文原样照抄，
 * 不过出站侧的任何塑形。发送后按 role=model 回灌历史（内核的 onSent 回调负责），
 * 模型读上下文时才知道那句复读是自己发的。
 */

import type { ChatEvent, ChatRef } from '../types.ts';

/** 跟屏复读的配置（humanlike.repeat） */
export interface RepeatConfig {
  enable: boolean;
  /** 触发条数：不同的人数（同一个人刷几遍只算一位），到点就发 */
  minPeople: number;
  /** 发送前的随机等待上限（秒），下限固定 0.6 秒 */
  delayMaxSec: number;
  /** 同会话两次复读之间的最小间隔（分钟） */
  cooldownMin: number;
  /** 段的时间窗（秒）：同文消息距段内上一条超过这个间隔就算新一段 */
  windowSec: number;
}

/** 复读发生的记账口（内核接：历史回灌 + 拟人层开口统计） */
export interface RepeatWatcherOptions {
  config: () => RepeatConfig;
  /** 发送一条纯文本（走 ChatService：限速、会话日志、UI 事件都照常过） */
  send: (chat: ChatRef, text: string) => Promise<void>;
  onSent: (chat: ChatRef, text: string) => void;
  /** bot 自己的号：复读自己发的没有意义 */
  selfId: () => string;
  now?: () => number;
  /** 随机数注入口（测试钉值用）；返回 0~1 的均匀分布 */
  random?: () => number;
  log?: { warn(msg: string, extra?: Record<string, unknown>): void };
}

interface RepeatRun {
  text: string;
  /** 说这句话的群友（去重，同一个人再说一遍不加计数） */
  users: Set<string>;
  /** 本段内最后一条消息的时刻（ms），配合 windowSec 判段是否还连着 */
  lastAt: number;
  timer?: NodeJS.Timeout;
}

const DELAY_MIN_MS = 600;

export class RepeatWatcher {
  private states = new Map<string, { run?: RepeatRun; lastFireAt: number }>();
  private disposed = false;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private opts: RepeatWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  private stateOf(chatKey: string): { run?: RepeatRun; lastFireAt: number } {
    let s = this.states.get(chatKey);
    if (!s) {
      s = { lastFireAt: 0 };
      this.states.set(chatKey, s);
    }
    return s;
  }

  /**
   * 入站观察。群聊、真实事件、有正文、不是 bot 自己的发言才参与；
   * 拟人层的门控结果不影响这里（复读不依赖"要不要接话"的判定）。
   */
  observe(event: ChatEvent): void {
    if (this.disposed) return;
    if (event.type !== 'group') return;
    const cfg = this.opts.config();
    if (!cfg?.enable) return;
    // 桌面端注入的模拟消息不参与判断，也不给它们起段
    if ((event.raw as { injected?: boolean } | undefined)?.injected) return;
    const text = String(event.text ?? '').trim();
    if (!text) return;
    if (String(event.userId) === this.opts.selfId()) return;

    const now = this.now();
    const chatKey = `${event.type}_${event.chatId}`;
    const st = this.stateOf(chatKey);
    const windowMs = Math.max(10, Number(cfg.windowSec) || 120) * 1000;

    // 同一句话且还连着窗：接着攒（同一个人再说一遍不加计数）；
    // 换话，或距离段内上一条已超出时间窗：整段作废，这句起新段
    if (st.run && st.run.text === text && now - st.run.lastAt <= windowMs) {
      st.run.users.add(String(event.userId));
      st.run.lastAt = now;
    } else {
      if (st.run?.timer) clearTimeout(st.run.timer);
      st.run = { text, users: new Set([String(event.userId)]), lastAt: now };
    }
    const run = st.run;
    if (run.timer) return;   // 已经在等发射：后面的人只是把段续着，不动定时器

    const required = Math.max(1, Math.round(Number(cfg.minPeople) || 4));
    if (run.users.size < required) return;

    // 攒够了：发送前随机等一下；若还在冷却期，推迟到冷却结束之后再发
    const cooldownMs = Math.max(0, Number(cfg.cooldownMin) || 0) * 60_000;
    const cooldownRemain = Math.max(0, st.lastFireAt + cooldownMs - now);
    const maxMs = Math.max(0, Number(cfg.delayMaxSec) || 0) * 1000;
    const jitter = Math.round(DELAY_MIN_MS + this.random() * (maxMs - DELAY_MIN_MS));
    const delay = Math.max(jitter, cooldownRemain);
    run.timer = setTimeout(() => {
      run.timer = undefined;
      this.fire(chatKey, run);
    }, delay);
    run.timer.unref?.();
  }

  /** 到点发射：段可能在等待期间被换话/超窗替换（st.run !== run），那种就不发了 */
  private fire(chatKey: string, run: RepeatRun): void {
    if (this.disposed) return;
    const st = this.states.get(chatKey);
    if (!st || st.run !== run) return;
    // 等待期间功能被关掉：这轮放弃，段作废（冷却不用再查——定定时器时已经推迟到冷却之后了）
    if (!this.opts.config()?.enable) { st.run = undefined; return; }
    st.lastFireAt = this.now();
    st.run = undefined;   // 发完即段终：同一句话之后想再复读，重新攒一段（受冷却约束）
    const chat: ChatRef = { platform: 'qq', type: 'group', chatId: chatKey.slice('group_'.length) };
    Promise.resolve()
      .then(() => this.opts.send(chat, run.text))
      .then(() => this.opts.onSent(chat, run.text))
      .catch((e) => this.opts.log?.warn(`跟屏复读发送失败: ${(e as Error).message}`, { chatId: chat.chatId }));
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.states.values()) {
      if (s.run?.timer) clearTimeout(s.run.timer);
      s.run = undefined;
    }
    this.states.clear();
  }
}
