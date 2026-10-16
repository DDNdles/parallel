/**
 * 跟屏复读 —— 纯程序段，不走模型。
 *
 * 群里 >=N 位群友接连说了同一句话时，完整跟一条同样的；N 与发送前的等待都带随机量，
 * 显得不机械。**发送那一刻链子断了就不发**：等待期间有人说了句不一样的话，
 * 这一轮就作废（run 整体重置，那句不一样的成了新一段的开头）。
 *
 * 与开口侧的差别：这里不判"要不要说"，只判"跟不跟屏"；正文原样照抄，
 * 不过出站侧的任何塑形。发送后按 role=model 回灌历史（内核的 onSent 回调负责），
 * 模型读上下文时才知道那句复读是自己发的。
 */

import type { ChatEvent, ChatRef } from '../types.ts';

/** 跟屏复读的配置（humanlike.repeat） */
export interface RepeatConfig {
  enable: boolean;
  /** 触发条数基准（实际在 minPeople ~ minPeople+2 之间现抽，显得不机械） */
  minPeople: number;
  /** 发送前的随机等待上限（秒），下限固定 0.6 秒 */
  delayMaxSec: number;
  /** 同会话两次复读之间的最小间隔（分钟） */
  cooldownMin: number;
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
  /** 说这句话的群友（去重，同一个人刷几遍只算一位） */
  users: Set<string>;
  /** 达标条数（进 run 时现抽一次） */
  required: number;
  timer?: NodeJS.Timeout;
  fired?: boolean;
}

const DELAY_MIN_MS = 600;
/** 触发条数的随机浮动范围：required = minPeople + randInt(0, 2) */
const REQUIRED_JITTER = 2;

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

    const chatKey = `${event.type}_${event.chatId}`;
    const st = this.stateOf(chatKey);

    // 同一句话：接着攒（同一个人再说一遍不加计数）；换话：整段作废，那句新的起新段
    if (st.run && st.run.text === text) {
      st.run.users.add(String(event.userId));
    } else {
      if (st.run?.timer) clearTimeout(st.run.timer);
      st.run = {
        text,
        users: new Set([String(event.userId)]),
        required: Math.max(1, Math.round(Number(cfg.minPeople) || 4)) + this.randInt(0, REQUIRED_JITTER),
      };
    }
    const run = st.run;
    if (run.fired || run.timer) return;
    if (run.users.size < run.required) return;
    if (this.now() - st.lastFireAt < Math.max(0, Number(cfg.cooldownMin) || 0) * 60_000) return;

    const maxMs = Math.max(0, Number(cfg.delayMaxSec) || 0) * 1000;
    const delay = Math.round(DELAY_MIN_MS + this.random() * (maxMs - DELAY_MIN_MS));
    run.timer = setTimeout(() => {
      run.timer = undefined;
      this.fire(chatKey, run);
    }, Math.max(0, delay));
    run.timer.unref?.();
  }

  /** 到点发射：链子是否还连着在 observe 里已经保证了（换话即整段作废），这里只查该段还没发过 */
  private fire(chatKey: string, run: RepeatRun): void {
    if (this.disposed || run.fired) return;
    const st = this.states.get(chatKey);
    if (!st || st.run !== run) return;
    run.fired = true;
    st.lastFireAt = this.now();
    const chat: ChatRef = { platform: 'qq', type: 'group', chatId: chatKey.slice('group_'.length) };
    Promise.resolve()
      .then(() => this.opts.send(chat, run.text))
      .then(() => this.opts.onSent(chat, run.text))
      .catch((e) => this.opts.log?.warn(`跟屏复读发送失败: ${(e as Error).message}`, { chatId: chat.chatId }));
  }

  /** 0~n 的随机整数（含两端） */
  private randInt(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.random() * (max - min + 1));
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
