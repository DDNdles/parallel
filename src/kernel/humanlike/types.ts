/**
 * 拟人化层配置形状。两侧来源分工明确：
 *  - **什么时候开口**（对齐 MaiBot `ChatReplyTimingConfig` 与 `idle_backoff`）
 *  - **怎么说 / 拆几条 / 隔多久**（纯程序出站：按句分条 + 打字节奏，见 delivery.ts）
 *  2026-10-17 起 HDSI 的小说格式层（script）与 Alter 情绪偏移整层已删。
 */

import { DEFAULT_OUTGOING, type OutgoingConfig } from './delivery.ts';
import type { BackoffConfig, TalkRule } from './frequency.ts';
import { DEFAULT_RHYTHM, type RhythmConfig } from './rhythm.ts';
import { DEFAULT_AGENCY, type AgencyConfig } from './agency.ts';
import { DEFAULT_SCHEDULE, type ScheduleConfig } from './schedule.ts';
import type { JargonConfig } from './jargon.ts';
import type { RepeatConfig } from './repeat.ts';

export type { OutgoingConfig } from './delivery.ts';
export type { BackoffConfig, TalkRule, TalkValueConfig } from './frequency.ts';
export type { RhythmConfig } from './rhythm.ts';
export type { AgencyConfig, AgencyWindow, ProactiveContactCandidate, AgencyCapacity } from './agency.ts';
export type { ScheduleConfig, SchedulePlan, ScheduleRule, ScheduleException } from './schedule.ts';
export type { JargonConfig } from './jargon.ts';
export type { RepeatConfig } from './repeat.ts';

export interface TimingConfig {
  /**
   * likelihood = 开口概率（日志拟合回归 + 每会话动态门控，MaiBot 2026-10 主线路线，默认）；
   * necessity = 综合内容/积压/存在感打分的旧启发式（MaiBot 已退役，留作对照）；
   * frequency = 只看攒了多少条。
   */
  replyTriggerMode: 'likelihood' | 'necessity' | 'frequency';
  /** 攒够几条就进 agent loop（frequency 模式的门槛；necessity 模式下是压力分的单位） */
  pendingThreshold: number;
  /** necessity 模式的分数门槛（likelihood 模式下不参与判定） */
  necessityThreshold: number;
  talkValue: number;
  privateTalkValue: number;
  enableRules: boolean;
  rules: TalkRule[];
  /** 提到名字更容易回（默认关，与 MaiBot 一致） */
  mentionedBotReply: boolean;
  /** 被 @ 必回（默认开，与 MaiBot 一致） */
  inevitableAtReply: boolean;
  /** 专注模式：不参与群聊激活度打分，只认强相关 */
  focusMode: boolean;
}

export interface HumanlikeConfig {
  // 这里**没有总开关**：拟人化是 chat 区行为本身，不是可关的功能。
  // 「说几句、拆几条、隔多久、要不要理」都调，但"她是不是这样活着"没有 off 档 ——
  // 要退行为人得像退回出厂设置，那不是设置页该提供的开关。
  /** 圈内黑话（表达学习，jargon.ts）：挖本群高频词 → 反事实判定 → prompt 参考节 */
  jargon: JargonConfig;
  /** 跟屏复读（repeat.ts）：纯程序段，>=N 位群友说了同一句就完整跟一条 */
  repeat: RepeatConfig;
  timing: TimingConfig;
  /** 出站投递（纯程序）：按句分条、句边截断、打字节奏、单条长度上限 */
  outgoing: OutgoingConfig;
  /** 多用户消息防抖合并 */
  merge: {
    enable: boolean;
    /** 静默多久就把攒着的消息处理掉 */
    windowMs: number;
    /** 从第一条起最多攒多久（群里刷屏时兜底） */
    maxWaitMs: number;
    /** 攒着的消息超过这个年龄就丢掉：隔了半小时的老话不值得再接 */
    bufferTtlMs: number;
    /** 关窗后的随机起跳延时下限（毫秒）：0 与上限同为 0 = 关掉随机延时 */
    fireDelayMinMs: number;
    /** 关窗后的随机起跳延时上限（毫秒） */
    fireDelayMaxMs: number;
  };
  backoff: BackoffConfig;
  /** 真正的「没人说话也开口」——默认关（风控红线：主动发言要显式开启） */
  proactive: {
    enable: boolean;
    /** 群里静默超过这么久，且自己也很久没说话，才起话头 */
    idleSeconds: number;
  };
  /** 聊天节奏反定型（HDSI ChatRhythm）：回复结构定型时注入纠偏 */
  rhythm: RhythmConfig;
  /** 主体行动窗口（HDSI Agency）：日程/隐私/设备构成主动开口的容量 */
  agency: AgencyConfig;
  /** 日程（HDSI Schedule Preplan）：周规律 + 日期例外，供容量判断与主动轮参考 */
  schedule: ScheduleConfig;
}

export const DEFAULT_HUMANLIKE: HumanlikeConfig = {
  jargon: { enable: true },
  repeat: { enable: true, minPeople: 4, delayMaxSec: 4, cooldownMin: 3 },
  timing: {
    replyTriggerMode: 'likelihood',
    pendingThreshold: 12,
    necessityThreshold: 80,
    talkValue: 1,
    privateTalkValue: 1,
    enableRules: false,
    rules: [
      { platform: '', itemId: '', ruleType: 'group', time: '00:00-08:59', value: 0.8 },
      { platform: '', itemId: '', ruleType: 'group', time: '09:00-18:59', value: 1 },
    ],
    mentionedBotReply: false,
    inevitableAtReply: true,
    focusMode: false,
  },
  outgoing: { ...DEFAULT_OUTGOING },
  merge: { enable: true, windowMs: 1500, maxWaitMs: 6000, bufferTtlMs: 120_000, fireDelayMinMs: 500, fireDelayMaxMs: 2000 },
  backoff: { baseSeconds: 15, capSeconds: 300, startCount: 2, bypassPendingCount: 6 },
  proactive: { enable: false, idleSeconds: 3600 },
  rhythm: { ...DEFAULT_RHYTHM },
  agency: { ...DEFAULT_AGENCY },
  schedule: { ...DEFAULT_SCHEDULE },
};

/** 最近窗口（存在感统计用，对齐 MaiBot 的 5 分钟） */
export const PRESENCE_WINDOW_SECONDS = 300;

/** runtime 交给 pipeline 去跑的一次「该说话了」 */
export interface TriggerBatch {
  /** 目标会话（主动发言轮没有事件，只有这个） */
  chat: import('../types.ts').ChatRef;
  events: import('../types.ts').ChatEvent[];
  reason: 'at' | 'mention' | 'likelihood' | 'necessity' | 'frequency' | 'idle' | 'proactive';
  detail: string;
}
