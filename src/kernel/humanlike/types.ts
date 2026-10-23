/**
 * 拟人化层配置形状。两侧来源分工明确：
 *  - **什么时候开口**（对齐 MaiBot `ChatReplyTimingConfig` 与 `idle_backoff`）
 *  - **怎么说 / 拆几条 / 隔多久**（纯程序出站：按句分条 + 打字节奏，见 delivery.ts）
 *  2026-10-17 起 HDSI 的小说格式层（script）与 Alter 情绪偏移整层已删。
 */

import { DEFAULT_OUTGOING, type OutgoingConfig } from './delivery.ts';
import type { BackoffConfig, TalkRule } from './frequency.ts';
import type { RepetitionConfig } from './repetition.ts';
import { DEFAULT_RHYTHM, type RhythmConfig } from './rhythm.ts';
import { DEFAULT_AGENCY, type AgencyConfig } from './agency.ts';
import { DEFAULT_SCHEDULE, type ScheduleConfig } from './schedule.ts';
import type { JargonConfig } from './jargon.ts';
import type { RepeatConfig } from './repeat.ts';

export type { OutgoingConfig } from './delivery.ts';
export type { BackoffConfig, TalkRule, TalkValueConfig } from './frequency.ts';
export type { RepetitionConfig } from './repetition.ts';
export type { RhythmConfig } from './rhythm.ts';
export type { AgencyConfig, AgencyWindow, ProactiveContactCandidate, AgencyCapacity } from './agency.ts';
export type { ScheduleConfig, SchedulePlan, ScheduleRule, ScheduleException } from './schedule.ts';
export type { JargonConfig } from './jargon.ts';
export type { RepeatConfig } from './repeat.ts';

export interface TimingConfig {
  /** 攒够这么多条消息才进一轮（frequency 模式的开口门槛） */
  pendingThreshold: number;
  /** 群聊频率开关：0 = 静默；大于 0 时不改变条数门槛 */
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
  /**
   * 重复惩罚（repetition.ts）：最近若干轮 bot 发言里反复出现的词/人设名，
   * 注入提醒；命中后可用一次重写把它去掉。与 rhythm（结构定型）互补。
   */
  repetition: RepetitionConfig;
  /**
   * 表达学习（chat 插件后台）：从群聊里学「什么情境下大家怎么说」，作为语气参考注入。
   * 只学说法与口吻，不改人设、不产数值；与黑话（学词义）是两件事。
   */
  expression: {
    enable: boolean;
    /** 攒够多少条群消息才学一次 */
    minMessages: number;
    /** 群安静多久才学（秒） */
    idleSeconds: number;
    /** 每个会话最多保留多少条表达 */
    maxPerChat: number;
    /** 每次注入几条参考 */
    injectMax: number;
  };
  /** 跟屏复读（repeat.ts）：纯程序段，>=N 位群友说了同一句就完整跟一条 */
  repeat: RepeatConfig;
  /** 戳一戳（chat 工具）：有明确指向/犯贱时的社交动作；冷却与小时上限是硬护栏 */
  poke: { enable: boolean; minIntervalSeconds: number; maxPerHour: number };
  timing: TimingConfig;
  /** 出站投递（纯程序）：按句分条、句边截断、打字节奏、单条长度上限 */
  outgoing: OutgoingConfig;
  /**
   * 出站打断（interrupt.ts）：她还在发气泡时对面又开口，按概率把**剩下的气泡**砍掉；
   * 模型还在生成时新消息进来，则直接 abort 这一轮（2026-10-18，pipeline.maybeInterrupt）。
   * 纯程序、不叫模型 —— 要求是"对面发完立刻生效"，走模型那一趟早就发完了。
   */
  interrupt: {
    enable: boolean;
    /** 插话打断的概率（0~1）；命令插话必断，不受它约束 */
    probability: number;
  };
  /** 消息防抖合并（群聊与私聊共用：私聊不打分，但同样攒批） */
  merge: {
    enable: boolean;
    /** 静默多久就把攒着的消息处理掉 */
    windowMs: number;
    /** 从第一条起最多攒多久（刷屏/连发时兜底；群聊与私聊同一把尺子） */
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
  repetition: {
    enable: true,
    windowMessages: 20,
    minMessages: 3,
    cooldownMinutes: 30,
    maxPhrases: 3,
    retry: true,
    maxStrikes: 3,
  },
  expression: { enable: true, minMessages: 20, idleSeconds: 120, maxPerChat: 24, injectMax: 4 },
  repeat: { enable: true, minPeople: 4, delayMaxSec: 4, cooldownMin: 3 },
  poke: { enable: true, minIntervalSeconds: 30, maxPerHour: 6 },
  timing: {
    pendingThreshold: 12,
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
  interrupt: { enable: true, probability: 0.8 },
  merge: { enable: true, windowMs: 2000, maxWaitMs: 6000, bufferTtlMs: 120_000, fireDelayMinMs: 500, fireDelayMaxMs: 2000 },
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
  /**
   * 触发原因。`private` = 私聊合批到点：只说明"攒够了"，**不代表做过开口判定**
   * （私聊必回、不参与打分，见 service.ingest 的私聊分支）。
   */
  reason: 'at' | 'mention' | 'frequency' | 'idle' | 'proactive' | 'private';
  detail: string;
}
