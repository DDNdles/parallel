/**
 * 拟人化层（内核自有，不在插件体系里）。这里只做导出，实现分两侧：
 *  什么时候开口（移植 MaiBot，保留）：
 *  - `necessity.ts`  该不该开口的打分（移植 MaiBot reply_necessity + turn_gates）
 *  - `frequency.ts`  发言频率规则与空闲退避（移植 MaiBot talk_value_rules + idle_backoff）
 *  怎么说 / 拆几条 / 隔多久（2026-10-17 起为**纯程序**，HDSI 的小说格式与 Alter 已删）：
 *  - `delivery.ts`   出站投递：按句分条 + 句边截断 + 打字节奏
 *  - `interrupt.ts`  出站打断：对面插话时把还没发的气泡砍掉（纯程序，不叫模型）
 *  - `rhythm/agency/schedule.ts`  节奏反定型 / 行动窗口 / 日程（写入入口已随工具面收窄移除）
 *  - `service.ts`    每会话的心流状态机，把两侧串起来并对内暴露 ingest/compose
 */

export { HumanlikeService, type HumanlikeServiceOptions, type SendPlan } from './service.ts';
export {
  DEFAULT_HUMANLIKE, PRESENCE_WINDOW_SECONDS,
  type HumanlikeConfig, type TimingConfig, type TriggerBatch,
  type BackoffConfig, type TalkRule, type OutgoingConfig,
} from './types.ts';
export { NECESSITY_TRIGGER_SCORE, scoreReplyNecessity, idleCompensation, presencePenalty } from './necessity.ts';
export { shouldInterrupt, isStopPhrase, type InterruptInput, type InterruptDecision } from './interrupt.ts';
export { talkValueFor, idleBackoffSeconds, backoffBypassed, inTimeWindow } from './frequency.ts';
export {
  DEFAULT_RHYTHM, rhythmSignature, detectCollapse, rhythmNudge, type RhythmConfig,
} from './rhythm.ts';
export {
  DEFAULT_AGENCY, deriveWindow, evaluateAgency, nextRecheckAt, quietHoursEnd, AGENCY_REASON_ZH,
  type AgencyConfig, type AgencyWindow, type AgencyCapacity, type ProactiveContactCandidate,
} from './agency.ts';
export {
  DEFAULT_SCHEDULE, emptyPlan, currentActivity, upcoming, prunePlan, schedulePrompt,
  type ScheduleConfig, type SchedulePlan, type ScheduleRule, type ScheduleException,
} from './schedule.ts';
export {
  DEFAULT_OUTGOING, MAX_BUBBLES, SILENT_MARKER, clip, isSilentScene,
  normalizeVisibleContent, splitIntoBubbles, trimAtSentence, typingDelayMs,
} from './delivery.ts';
