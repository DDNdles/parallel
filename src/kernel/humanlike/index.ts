/**
 * 拟人化层（内核自有，不在插件体系里）。这里只做导出，实现分两侧：
 *  什么时候开口（移植 MaiBot，保留）：
 *  - `necessity.ts`  该不该开口的打分（移植 MaiBot reply_necessity + turn_gates）
 *  - `frequency.ts`  发言频率规则与空闲退避（移植 MaiBot talk_value_rules + idle_backoff）
 *  怎么说 / 拆几条 / 隔多久（移植 HDSI）：
 *  - `delivery.ts`   出站投递：分隔标记切分 + 打字节奏（HDSI `runtime`）
 *  - `script/rhythm/alter/agency/schedule.ts`  HDSI 五件套
 *  - `service.ts`    每会话的心流状态机，把两侧串起来并对内暴露 ingest/compose
 */

export { HumanlikeService, type HumanlikeServiceOptions, type SendPlan } from './service.ts';
export {
  DEFAULT_HUMANLIKE, PRESENCE_WINDOW_SECONDS,
  type HumanlikeConfig, type TimingConfig, type TriggerBatch,
  type BackoffConfig, type TalkRule, type OutgoingConfig,
} from './types.ts';
export { NECESSITY_TRIGGER_SCORE, scoreReplyNecessity, idleCompensation, presencePenalty } from './necessity.ts';
export { talkValueFor, idleBackoffSeconds, backoffBypassed, inTimeWindow } from './frequency.ts';
export {
  DEFAULT_RHYTHM, rhythmSignature, detectCollapse, rhythmNudge, type RhythmConfig,
} from './rhythm.ts';
export {
  DEFAULT_ALTER, readAlter, normalizeAlterValue, adjustAlterWeight, calculateAlterThreshold,
  advanceAlter, applyAlterAnalysis, alterOffsetForPrompt, parseAlterAnalysis,
  type AlterConfig, type AlterState, type AlterOffset,
} from './alter.ts';
export {
  DEFAULT_AGENCY, deriveWindow, evaluateAgency, nextRecheckAt, quietHoursEnd, AGENCY_REASON_ZH,
  type AgencyConfig, type AgencyWindow, type AgencyCapacity, type ProactiveContactCandidate,
} from './agency.ts';
export {
  DEFAULT_SCHEDULE, emptyPlan, currentActivity, upcoming, prunePlan, schedulePrompt,
  type ScheduleConfig, type SchedulePlan, type ScheduleRule, type ScheduleException,
} from './schedule.ts';
export {
  readAuthoredActions, splitBubbles, hasSayBlocks, isSilentScene,
  scriptFormatText, BUBBLE_SEP, SILENT_MARKER, type AuthoredAction,
} from './script.ts';
export {
  splitOutgoingMessage, normalizeVisibleContent, typingDelayMs, clip,
  DEFAULT_OUTGOING, type OutgoingConfig,
} from './delivery.ts';
