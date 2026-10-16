/**
 * 拟人化层配置形状。两侧来源分工明确：
 *  - **什么时候开口**（保留）：对齐 MaiBot `ChatReplyTimingConfig`（talk_value / 规则 / 触发模式）
 *    与 `idle_backoff`（空闲退避）。
 *  - **怎么说 / 拆几条 / 隔多久**：对齐 HDSI 的 `runtime`（见 delivery.ts 的 `outgoing`）——
 *    MaiBot 的分段器 / 错字 / 打字速度已整体删除。
 */

import { DEFAULT_OUTGOING, type OutgoingConfig } from './delivery.ts';
import type { BackoffConfig, TalkRule } from './frequency.ts';
import { DEFAULT_RHYTHM, type RhythmConfig } from './rhythm.ts';
import { DEFAULT_ALTER, type AlterConfig } from './alter.ts';
import { DEFAULT_AGENCY, type AgencyConfig } from './agency.ts';
import { DEFAULT_SCHEDULE, type ScheduleConfig } from './schedule.ts';

export type { OutgoingConfig } from './delivery.ts';
export type { BackoffConfig, TalkRule, TalkValueConfig } from './frequency.ts';
export type { RhythmConfig } from './rhythm.ts';
export type { AlterConfig, AlterOffset, AlterState } from './alter.ts';
export type { AgencyConfig, AgencyWindow, ProactiveContactCandidate, AgencyCapacity } from './agency.ts';
export type { ScheduleConfig, SchedulePlan, ScheduleRule, ScheduleException } from './schedule.ts';

export interface TimingConfig {
  /** necessity = 综合内容/积压/存在感决定要不要开口；frequency = 只看攒了多少条 */
  replyTriggerMode: 'necessity' | 'frequency';
  /** 攒够几条就进 agent loop（frequency 模式的门槛；necessity 模式下是压力分的单位） */
  pendingThreshold: number;
  /** necessity 模式的分数门槛 */
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
  /**
   * 剧本体（移植 HDSI 的 `<say>` authored actions）：
   * 模型写的是"小说的下一段"（旁白 + 用 <say id> 包住的台词），**只有 say 块里的字进 QQ**。
   * 动作描写于是从结构上就漏不出去 —— 它属于旁白，留在剧本里给下一轮接续用。
   * 关掉则回到"模型输出什么就发什么"的普通模式。
   */
  script: {
    enable: boolean;
  };
  timing: TimingConfig;
  /** 出站投递（HDSI `runtime`）：分隔标记切分、打字节奏、单条长度上限 */
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
  /** 情绪偏移追踪（HDSI Alter）：每轮 <alter>±n</alter> 累计 + 侧端分析出氛围参考 */
  alter: AlterConfig;
  /** 主体行动窗口（HDSI Agency）：日程/隐私/设备构成主动开口的容量 */
  agency: AgencyConfig;
  /** 日程（HDSI Schedule Preplan）：周规律 + 日期例外，供容量判断与主动轮参考 */
  schedule: ScheduleConfig;
}

export const DEFAULT_HUMANLIKE: HumanlikeConfig = {
  script: { enable: true },
  timing: {
    replyTriggerMode: 'necessity',
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
  merge: { enable: true, windowMs: 1500, maxWaitMs: 6000, bufferTtlMs: 120_000 },
  backoff: { baseSeconds: 15, capSeconds: 300, startCount: 2, bypassPendingCount: 6 },
  proactive: { enable: false, idleSeconds: 3600 },
  rhythm: { ...DEFAULT_RHYTHM },
  alter: { ...DEFAULT_ALTER },
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
  reason: 'at' | 'mention' | 'necessity' | 'frequency' | 'idle' | 'proactive';
  detail: string;
}
