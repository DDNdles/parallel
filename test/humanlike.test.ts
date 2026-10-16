import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NECESSITY_TRIGGER_SCORE, scoreReplyNecessity, idleCompensation, presencePenalty,
  isShortReactionBatch, stripNecessityNoise, looksLikeQuestion, pressureScore,
} from '../src/kernel/humanlike/necessity.ts';
import { talkValueFor, idleBackoffSeconds, backoffBypassed, inTimeWindow } from '../src/kernel/humanlike/frequency.ts';
import {
  splitOutgoingMessage, normalizeVisibleContent, typingDelayMs, clip, DEFAULT_OUTGOING,
} from '../src/kernel/humanlike/delivery.ts';
import { HumanlikeService } from '../src/kernel/humanlike/service.ts';
import { DEFAULT_HUMANLIKE, type HumanlikeConfig } from '../src/kernel/humanlike/types.ts';
import { readAuthoredActions, splitBubbles, hasSayBlocks, isSilentScene } from '../src/kernel/humanlike/script.ts';
import {
  DEFAULT_RHYTHM, rhythmSignature, detectCollapse,
} from '../src/kernel/humanlike/rhythm.ts';
import {
  DEFAULT_ALTER, createAlterState, advanceAlter, adjustAlterWeight, calculateAlterThreshold,
  normalizeAlterValue, readAlter, applyAlterAnalysis, alterOffsetForPrompt, parseAlterAnalysis,
} from '../src/kernel/humanlike/alter.ts';
import { DEFAULT_AGENCY, deriveWindow, evaluateAgency } from '../src/kernel/humanlike/agency.ts';
import {
  DEFAULT_SCHEDULE, currentActivity, upcoming, prunePlan, schedulePrompt,
} from '../src/kernel/humanlike/schedule.ts';
import { DEFAULT_CONFIG } from '../src/kernel/config.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { ChatService, type TransportAdapter } from '../src/kernel/services/chat.ts';
import type { SendPlan } from '../src/kernel/humanlike/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, ChatRef } from '../src/kernel/types.ts';

/** 确定性随机数：0 = 永不合并/永不命中概率分支，1 = 总是 */
const rng0 = () => 0;
const rng1 = () => 0.999999;

const chat: ChatRef = { platform: 'qq', type: 'group', chatId: '123' };

function input(over: Partial<Parameters<typeof scoreReplyNecessity>[0]> = {}) {
  return {
    texts: ['普通聊天'], pendingCount: 1, triggerThreshold: 6,
    hasAt: false, hasMention: false, isGroupChat: true, focusActive: false,
    recentSelfReplies: 0, recentWindowMessages: 10,
    effectiveFrequency: 1, idleSeconds: 0, idleReachedAverage: false,
    ...over,
  };
}

// ============================================================
// 1. 必要性打分（移植 MaiBot reply_necessity）
// ============================================================

test('必要性：@ 直接给满分，普通群聊消息给 0 分', () => {
  // 相关性 100 + 压力分（1/6 → round(50×(1/6)²) = 1）
  assert.equal(scoreReplyNecessity(input({ hasAt: true })).score, 101);
  assert.ok(scoreReplyNecessity(input({ hasAt: true })).score >= NECESSITY_TRIGGER_SCORE);
  // 普通发言：相关性 0 + 内容 0 + 压力 1 ⇒ 远低于 80
  const plain = scoreReplyNecessity(input());
  assert.ok(plain.score < NECESSITY_TRIGGER_SCORE, `普通发言不该过阈值: ${plain.score}`);
  assert.ok(!plain.detail.includes('强相关'), `普通发言不该有强相关项: ${plain.detail}`);
  assert.match(scoreReplyNecessity(input({ hasAt: true })).detail, /强相关=100\(@\)/);
});

test('必要性：私聊/提及/focus 各自的相关性档位（100/80/40/40）', () => {
  assert.equal(scoreReplyNecessity(input({ isGroupChat: false })).score, 41);
  assert.equal(scoreReplyNecessity(input({ hasMention: true })).score, 81);
  assert.ok(scoreReplyNecessity(input({ hasMention: true })).detail.includes('提及'));
  assert.equal(scoreReplyNecessity(input({ focusActive: true })).score, 41);
});

test('必要性：内容是加分项，纯短反应是减分项', () => {
  // 只有 @ 才能把普通发言拉过线；内容分只贡献 15~55
  const asked = scoreReplyNecessity(input({ texts: ['这个怎么弄'], hasAt: true }));
  assert.ok(asked.detail.includes('问题'), asked.detail);
  const shortReaction = scoreReplyNecessity(input({ texts: ['哈哈哈'] }));
  assert.ok(shortReaction.detail.includes('短反应'), shortReaction.detail);
  assert.ok(shortReaction.score <= 0 || shortReaction.score < scoreReplyNecessity(input({ texts: ['嗯'] })).score + 1);
});

test('必要性：存在感惩罚按自己占最近窗口的比例递增（25% 免罚，60% 罚满 25）', () => {
  assert.equal(presencePenalty(2, 10), 0, '20% 免罚');
  assert.equal(presencePenalty(6, 10), 25, '60% 罚满');
  assert.equal(presencePenalty(9, 10), 25, '超过 60% 不再加罚');
  assert.equal(presencePenalty(0, 10), 0);
  assert.equal(presencePenalty(5, 0), 0, '窗口为空不罚');
  const mid = presencePenalty(3, 10);
  assert.ok(mid > 0 && mid < 25, `30% 应在 0~25 之间: ${mid}`);
});

test('必要性：频率系数把分数按 0.5 + 0.5×f 缩放（0.5 是最低倍率）', () => {
  const full = scoreReplyNecessity(input({ hasAt: true, effectiveFrequency: 1 })).score;
  const half = scoreReplyNecessity(input({ hasAt: true, effectiveFrequency: 0 })).score;
  assert.equal(full, 101);
  assert.equal(half, 51, '频率 0 时倍率 0.5：round(101×0.5)');
});

test('必要性：积压压力阈值内二次增长、超过后对数增长，封顶 100', () => {
  assert.equal(pressureScore(0, 6, false), 0);
  assert.equal(pressureScore(6, 6, false), 50, '刚好到阈值 = 标准分');
  assert.equal(pressureScore(3, 6, false), 13, '阈值内二次曲线：50*(0.5)^2');
  assert.equal(pressureScore(6, 6, true), 50, '空闲加成后仍被标准分封顶');
  const over = pressureScore(30, 6, false);
  assert.ok(over > 50 && over <= 100, `超阈值应在 50~100: ${over}`);
  assert.equal(pressureScore(1000, 6, false), 100, '封顶 100');
});

test('必要性：噪声剥离 —— 引用、媒体占位、@、合并转发都不算内容', () => {
  assert.equal(stripNecessityNoise('[CQ:reply,id=1] 在吗'), '在吗');
  assert.equal(stripNecessityNoise('@12345 你好'), '你好');
  assert.equal(stripNecessityNoise('[图片：xxx]'), '');
  assert.equal(stripNecessityNoise('【合并转发消息: ...'), '');
  assert.equal(stripNecessityNoise('@all 大家早'), '');
  // 「[回复了X的消息: Y]，说：Z」——MaiBot 的两条正则叠加后仍会留下"，说："，这里如实对齐
  const legacy = stripNecessityNoise('[回复了张三的消息: 哦]，说：其实我想问');
  assert.ok(legacy.includes('其实我想问'), legacy);
  assert.ok(!legacy.includes('回复了'), legacy);
});

test('必要性：短反应批次与疑问句的识别', () => {
  assert.equal(isShortReactionBatch(['哈哈', '草']), true);
  assert.equal(isShortReactionBatch(['这是一句挺长的话']), false);
  assert.equal(isShortReactionBatch([]), true);
  assert.equal(looksLikeQuestion('这个怎么弄'), true);
  assert.equal(looksLikeQuestion('你在吗？'), true);
  assert.equal(looksLikeQuestion('今天天气不错'), false);
  assert.equal(looksLikeQuestion('在吗？'), false, 'MaiBot 要求至少 4 个字符，短问句不算');
});

test('必要性：别人在叫别的 AI 时不算请求（MaiBot 的 deepseek/豆包 名单）', () => {
  const toOther = scoreReplyNecessity(input({ texts: ['DeepSeek，帮我看看'] }));
  const toUs = scoreReplyNecessity(input({ texts: ['帮我看看'] }));
  assert.ok(!toOther.detail.includes('请求'), toOther.detail);
  assert.ok(toUs.detail.includes('请求'), toUs.detail);
});

// ============================================================
// 2. 空窗补偿（移植 MaiBot turn_gates）
// ============================================================

test('空窗补偿：pending=0 时禁止纯沉默触发', () => {
  const r = idleCompensation({ pendingCount: 0, triggerThreshold: 6, idleSeconds: 999, averageIntervalSeconds: 3 });
  assert.equal(r.reached, false);
  assert.match(r.detail, /纯沉默/);
});

test('空窗补偿：积压条数 + 空窗折算才算等效条数，且折算封顶在 阈值-1', () => {
  // 平均 3s 一条、沉默 20s → 折算 5（封顶） + 积压 1 = 6 ≥ 6 ⇒ 触发
  const reached = idleCompensation({ pendingCount: 1, triggerThreshold: 6, idleSeconds: 20, averageIntervalSeconds: 3 });
  assert.equal(reached.reached, true, reached.detail);
  assert.match(reached.detail, /等效消息数=6\.00\/6/);
  // 沉默刚开始：折算很小，不触发，并算出还差多久（(6-1)×3 - 1 = 14s）
  const waiting = idleCompensation({ pendingCount: 1, triggerThreshold: 6, idleSeconds: 1, averageIntervalSeconds: 3 });
  assert.equal(waiting.reached, false);
  assert.ok(Math.abs(waiting.delaySeconds - 14) < 0.01, waiting.detail);
  // 没有平均间隔（消息太少）时不做补偿
  assert.equal(idleCompensation({ pendingCount: 1, triggerThreshold: 6, idleSeconds: 99, averageIntervalSeconds: null }).reached, false);
  // 折算封顶：哪怕沉默一年，纯靠折算也跨不过阈值（必须真的有积压消息）
  const capped = idleCompensation({ pendingCount: 1, triggerThreshold: 2, idleSeconds: 1e6, averageIntervalSeconds: 3 });
  assert.equal(capped.reached, true);
  assert.match(capped.detail, /折算=1\.00/);
});

// ============================================================
// 3. 频率规则与空闲退避（移植 MaiBot talk_value_rules / idle_backoff）
// ============================================================

test('频率：全局值 + 规则覆盖 + 时段（含跨零点）', () => {
  const base = { talkValue: 1, privateTalkValue: 0.5, enableRules: false, rules: [] };
  assert.equal(talkValueFor(base, chat), 1);
  assert.equal(talkValueFor(base, { ...chat, type: 'private' }), 0.5);

  const withRules = {
    ...base,
    enableRules: true,
    rules: [
      { ruleType: 'group' as const, itemId: '', platform: '', time: '00:00-08:59', value: 0.2 },
      { ruleType: 'group' as const, itemId: '', platform: '', time: '', value: 0.9 },
    ],
  };
  assert.equal(talkValueFor(withRules, chat, new Date(2026, 0, 1, 3, 0)), 0.2, '凌晨命中低频率时段');
  assert.equal(talkValueFor(withRules, chat, new Date(2026, 0, 1, 15, 0)), 0.9, '白天落到兜底规则');

  assert.equal(inTimeWindow('23:00-02:00', 23 * 60 + 30), true);
  assert.equal(inTimeWindow('23:00-02:00', 1 * 60), true);
  assert.equal(inTimeWindow('23:00-02:00', 12 * 60), false);
  assert.equal(inTimeWindow('*', 5), true);
  assert.equal(inTimeWindow('', 5), false, '空时段交给调用方当兜底');
});

test('频率：规则按会话精确命中，非法输入不炸', () => {
  const cfg = {
    talkValue: 1, privateTalkValue: 1, enableRules: true,
    rules: [{ ruleType: 'group' as const, itemId: '999', platform: '', time: '*', value: 0.1 }],
  };
  assert.equal(talkValueFor(cfg, chat), 1, '别的群不受影响');
  assert.equal(talkValueFor(cfg, { ...chat, chatId: '999' }), 0.1);
  assert.equal(talkValueFor({ ...cfg, rules: [{ ...cfg.rules[0], value: NaN }] }, { ...chat, chatId: '999' }), 1);
});

test('空闲退避：从起点开始指数增长并封顶；积压够多就绕过', () => {
  const cfg = { baseSeconds: 15, capSeconds: 300, startCount: 2, bypassPendingCount: 6 };
  assert.equal(idleBackoffSeconds(cfg, 0), 0);
  assert.equal(idleBackoffSeconds(cfg, 1), 0, '还没到起点');
  assert.equal(idleBackoffSeconds(cfg, 2), 15);
  assert.equal(idleBackoffSeconds(cfg, 3), 30);
  assert.equal(idleBackoffSeconds(cfg, 4), 60);
  assert.equal(idleBackoffSeconds(cfg, 20), 300, '封顶');
  assert.equal(backoffBypassed(cfg, 5), false);
  assert.equal(backoffBypassed(cfg, 6), true);
});

// ============================================================
// 4. 出站投递（移植 HDSI runtime：分隔标记切分 / 归一化截断 / 打字节奏）
// ============================================================

test('投递：只按分隔标记切分，没有标记就整条 —— 不做任何自动断句', () => {
  assert.deepEqual(splitOutgoingMessage('一<sep/>二<sep/>三', DEFAULT_OUTGOING), ['一', '二', '三']);
  // 多句标点、没有分隔标记 → 仍然是一条（HDSI：一条为默认，分不分由模型决定）
  assert.deepEqual(splitOutgoingMessage('第一句，第二句，第三句。', DEFAULT_OUTGOING), ['第一句，第二句，第三句。']);
});

test('投递：关掉拆分时整条返回；自定义分隔标记生效', () => {
  const off = { ...DEFAULT_OUTGOING, splitReplyMessages: false };
  assert.deepEqual(splitOutgoingMessage('一<sep/>二', off), ['一<sep/>二']);
  const custom = { ...DEFAULT_OUTGOING, messageSeparator: '||' };
  assert.deepEqual(splitOutgoingMessage('一||二||三', custom), ['一', '二', '三']);
});

test('投递：splitBubbles（剧本体逐 action 用）有标记按标记切、无标记整条；只有标记时切空', () => {
  assert.deepEqual(splitBubbles('一<sep/>二'), ['一', '二']);
  assert.deepEqual(splitBubbles('一整条没有标记'), ['一整条没有标记']);
  assert.deepEqual(splitBubbles('一<sep/>二', '<sep/>', false), ['一\n二'], '关掉分条时标记换成换行，不把内部记号发进群');
  assert.deepEqual(splitBubbles('<sep/>'), [], '只有标记 → 切空，不回退整条（免得把标记发进群）');
});

test('投递：归一化分隔标记写法、剥媒体占位符，并硬截断（先截断整条）', () => {
  // 全角/变体写法归一到配置的标记
  assert.equal(normalizeVisibleContent('一＜sep/＞二', 100, '<sep/>'), '一<sep/>二');
  assert.equal(normalizeVisibleContent('一<sep>二', 100, '<sep/>'), '一<sep/>二');
  // 媒体占位符剥掉
  assert.equal(normalizeVisibleContent('看图【图片】[CQ:image,file=x]好了', 100, '<sep/>'), '看图好了');
  // 模型自己发明的内联记号（内核没有对应实现）不该被人看见，但分隔标记自己必须活着
  assert.equal(normalizeVisibleContent('<set_mood mood="晕乎乎"/>你好<update_affection delta="1" reason="拌嘴"/>', 100, '<sep/>'), '你好');
  assert.equal(normalizeVisibleContent('早<sep/>好', 100, '<sep/>'), '早<sep/>好');
  assert.equal(normalizeVisibleContent('换行||分隔', 100, '||'), '换行||分隔');
  // 截断是硬切尾巴，不重切、不丢整条
  assert.equal(normalizeVisibleContent('一二三四五', 3, '<sep/>'), '一二三');
  assert.equal(clip('  abc  ', 2), 'ab');
  assert.equal(clip(undefined, 5), '');
});

test('投递：打字延迟按字数/速度算；抖动 0 时确定；下限 250ms、上限封顶', () => {
  const base = { ...DEFAULT_OUTGOING, typingBaseDelaySeconds: 1, typingCharactersPerSecond: 8, typingMaxDelaySeconds: 12, typingJitterRatio: 0 };
  // 16 字 / 8 = 2，加上基础 1 秒 → 3000ms
  assert.equal(typingDelayMs('一二三四五六七八九十一二三四五六', base), 3000);
  // 空串也走基础延迟
  assert.equal(typingDelayMs('', base), 1000);
  // 上限封顶
  assert.equal(typingDelayMs('一二三四五六七八九十一二三四五六', { ...base, typingMaxDelaySeconds: 2 }), 2000);
  // base=0 + max=0 → 落到 250ms 下限（HDSI 没有「0 = 关闭打字」这一档）
  assert.equal(typingDelayMs('随便什么', { ...base, typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0 }), 250);
  // 抖动落点由 rng 决定，但始终落在 [250, cap]
  const jit = { ...base, typingJitterRatio: 0.3 };
  const lo = typingDelayMs('一二三四五六七八', jit, () => 0);
  const hi = typingDelayMs('一二三四五六七八', jit, () => 1);
  assert.ok(lo >= 250 && hi <= 12000 && lo < hi, `抖动区间异常: ${lo} / ${hi}`);
});

test('投递：分隔标记切出的气泡经归一化后逐条交付；括号动作不再被程序清洗', () => {
  const raw = '在的<sep/>（笑）刚睡醒<sep/>你说';
  const clipped = normalizeVisibleContent(raw, DEFAULT_OUTGOING.maxMessageCharacters, DEFAULT_OUTGOING.messageSeparator);
  const bubbles = splitOutgoingMessage(clipped, DEFAULT_OUTGOING);
  assert.deepEqual(bubbles, ['在的', '（笑）刚睡醒', '你说']);
  // HDSI 不做括号清洗，旁白靠 <say> 结构与提示词约束
  assert.ok(bubbles[1].includes('（笑）'));
});

// ============================================================
// 5. 服务：入站门控 / 合批 / 存在感 / 出站计划
// ============================================================

/** makeService 每个用例建一个 ErrorCenter 的临时目录；进程退出时统一清掉
 *  （以前没人收，跑一次测试攒几十个空目录，跑了几百次就留下几百个） */
const HL_TMP_DIRS: string[] = [];
process.on('exit', () => {
  for (const d of HL_TMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 收不掉就算了，不能因此让测试挂掉 */ }
  }
});

function makeService(over: Partial<HumanlikeConfig> = {}, opts: { realClock?: boolean } = {}) {
  const cfg: HumanlikeConfig = JSON.parse(JSON.stringify({ ...DEFAULT_HUMANLIKE, ...over }));
  const dir = mkdtempSync(join(tmpdir(), 'hl-'));
  HL_TMP_DIRS.push(dir);
  const bus = new Bus();
  const errors = new ErrorCenter(bus, { dataDir: dir });
  const triggers: { events: ChatEvent[]; reason: string }[] = [];
  const logs: { type: string; text?: string }[] = [];
  let fake = 1_000_000;
  const now = () => (opts.realClock ? Date.now() : fake);
  const svc = new HumanlikeService({
    config: () => cfg,
    selfNickname: () => '麦麦',
    trigger: (b) => triggers.push({ events: b.events, reason: b.reason }),
    sessionLog: { append: (_c, _t, e) => logs.push(e) } as never,
    bus, errors, now,
  });
  return { svc, cfg, triggers, logs, now, tick: (ms: number) => { fake += ms; } };
}

function ev(text: string, over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    id: `e${Math.random()}`, platform: 'qq', type: 'group', chatId: '123',
    userId: '10001', nickname: '小明', senderRole: 'member',
    segments: [{ type: 'text', data: { text } }], text,
    isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(), ...over,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('服务：@ 立刻放行（并把攒着的消息一起带上）；普通消息被接管', async () => {
  const { svc } = makeService();
  const plain = svc.ingest(ev('早上好'), { isCommand: false });
  assert.equal(plain.action, 'handled', '普通群消息进缓冲');

  const at = svc.ingest(ev('在吗', { isAtMe: true }), { isCommand: false });
  assert.equal(at.action, 'pass');
  assert.equal((at as { events: ChatEvent[] }).events.length, 2, '攒着的那条跟在后面一起交出去');
  assert.equal((at as { events: ChatEvent[] }).events[0].text, '早上好');
  svc.dispose();
});

test('服务：命令与私聊一律立即放行，且不参与打分', () => {
  const { svc } = makeService();
  assert.equal(svc.ingest(ev('/帮助'), { isCommand: true }).action, 'pass');
  assert.equal(svc.ingest(ev('在吗', { type: 'private' }), { isCommand: false }).action, 'pass');
  svc.dispose();
});

test('服务：提到名字走提及档位，mentionedBotReply 关时仍进缓冲', () => {
  const off = makeService();
  assert.equal(off.svc.ingest(ev('麦麦 早'), { isCommand: false }).action, 'handled');
  off.svc.dispose();

  const on = makeService({ timing: { ...DEFAULT_HUMANLIKE.timing, mentionedBotReply: true } });
  assert.equal(on.svc.ingest(ev('麦麦 早'), { isCommand: false }).action, 'pass');
  on.svc.dispose();
});

test('拟人化没有总开关：配置形状里就不该有 enabled（她不是可关的功能）', () => {
  assert.equal('enabled' in DEFAULT_HUMANLIKE, false);
  assert.equal('enabled' in (DEFAULT_CONFIG.humanlike as Record<string, unknown>), false);
});

test('服务：攒够条数（frequency 模式）后由定时器触发，而不是逐条触发', async () => {
  const { svc, triggers, cfg } = makeService({
    merge: { enable: false, windowMs: 0, maxWaitMs: 0, bufferTtlMs: 120_000 },
    timing: { ...DEFAULT_HUMANLIKE.timing, replyTriggerMode: 'frequency', pendingThreshold: 3 },
  });
  svc.ingest(ev('一'), { isCommand: false });
  svc.ingest(ev('二'), { isCommand: false });
  await wait(20);
  assert.equal(triggers.length, 0, '两条还不够');
  svc.ingest(ev('三'), { isCommand: false });
  await wait(20);
  assert.equal(triggers.length, 1, '到阈值触发一次');
  assert.equal(triggers[0].events.length, 3, '三条一起交出去');
  assert.equal(triggers[0].reason, 'frequency');
  void cfg;
  svc.dispose();
});

test('服务：necessary 模式攒不够就沉默，且沉默会累加退避计数', async () => {
  const { svc, triggers, logs } = makeService({
    merge: { enable: true, windowMs: 0, maxWaitMs: 0, bufferTtlMs: 120_000 },
  });
  svc.ingest(ev('随便说说'), { isCommand: false });
  await wait(30);
  assert.equal(triggers.length, 0, '普通发言不该开口');
  assert.ok(logs.some((l) => l.type === 'gate' && /不说/.test(l.text ?? '')), JSON.stringify(logs));
  svc.dispose();
});

test('服务：空窗补偿在沉默够久后真的触发（且需要至少一条积压消息）', async () => {
  const { svc, triggers } = makeService({
    merge: { enable: true, windowMs: 10, maxWaitMs: 0, bufferTtlMs: 600_000 },
    timing: { ...DEFAULT_HUMANLIKE.timing, replyTriggerMode: 'necessity', pendingThreshold: 2 },
    backoff: { baseSeconds: 0, capSeconds: 0, startCount: 1, bypassPendingCount: 0 },
  }, { realClock: true });

  // 先用 @ 消息把"群平均节奏"建起来（@ 直接放行，不进缓冲，但计入间隔）
  for (const t of ['a', 'b', 'c']) {
    svc.ingest(ev(t, { isAtMe: true }), { isCommand: false });
    await wait(60);
  }
  triggers.length = 0;

  // 一条没人理的普通消息：积压 1 条，分数不够 ⇒ 先沉默，并排定"还差多久"的复查
  svc.ingest(ev('有人吗'), { isCommand: false });
  await wait(40);
  assert.equal(triggers.length, 0, '刚说完就回那是问答机器人，不是群友');

  // 沉默超过 (阈值-积压)×平均间隔 之后，复查把这条接上
  await wait(600);
  assert.equal(triggers.length, 1, '空窗补偿应当补上这一次开口');
  assert.equal(triggers[0].reason, 'idle');
  assert.deepEqual(triggers[0].events.map((e) => e.text), ['有人吗']);
  svc.dispose();
});

test('服务：pending=0 时不会纯靠沉默自我唤醒（主动发言默认关）', async () => {
  const { svc, triggers } = makeService({
    merge: { enable: true, windowMs: 10, maxWaitMs: 0, bufferTtlMs: 600_000 },
    timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 2 },
  }, { realClock: true });
  svc.ingest(ev('a', { isAtMe: true }), { isCommand: false });
  await wait(60);
  triggers.length = 0;
  await wait(500);
  assert.equal(triggers.length, 0, '没有积压消息 + 主动发言关 = 一直安静');
  svc.dispose();
});

test('服务：noteSpoke / noteSilent 维护存在感窗口与退避', () => {
  const { svc } = makeService();
  svc.noteSpoke(chat, 3);
  const snap = svc.snapshot(chat);
  assert.equal(snap.recentSelf, 3);
  svc.noteSilent(chat);
  svc.noteSilent(chat);
  assert.equal(svc.snapshot(chat).consecutiveNoAction, 2);
  svc.dispose();
});

test('服务：compose 第一条不等、其余按打字延迟排停顿（HDSI 口径）', async () => {
  // 模型自己写了分隔标记 → 三条；首条不等，其后按字数算
  const { svc } = makeService({
    outgoing: { ...DEFAULT_OUTGOING, typingBaseDelaySeconds: 0, typingCharactersPerSecond: 1, typingMaxDelaySeconds: 30, typingJitterRatio: 0 },
  });
  const plans = await svc.compose(chat, '在的<sep/>刚睡醒<sep/>你说');
  assert.equal(plans.length, 3, `应按分隔标记拆成 3 条: ${plans.length}`);
  assert.equal(plans[0].pauseMs, 0, '第一条立刻发');
  assert.deepEqual(plans.slice(1).map((p) => p.pauseMs), [3000, 2000], '后续每条 = ceil(字数 / 每秒字数)');
  // 没有分隔标记 → 一条、无停顿（不再自动断句）
  const one = await svc.compose(chat, '第一句，第二句，第三句。');
  assert.equal(one.length, 1, '不写分隔标记就是一条');
  assert.equal(one[0].pauseMs, 0);
  svc.dispose();
});

test('服务：群里的普通消息一律进门控（没有"全都放行"的旁路）', () => {
  const { svc } = makeService();
  assert.equal(svc.ingest(ev('普通消息'), { isCommand: false }).action, 'handled');
  svc.dispose();
});

test('服务：只有剧本体可单独关（关了退回整条发），其余部分不受影响', async () => {
  // 剧本体是子开关，不是总开关：关掉只是"模型写什么就发什么"，门控与投递照旧
  const off = makeService({ script: { enable: false } });
  const plans = await off.svc.compose(chat, '第一句，第二句，第三句。');
  assert.equal(plans.length, 1, '没有分隔标记就是一条');
  assert.equal(off.svc.ingest(ev('普通消息'), { isCommand: false }).action, 'handled', '门控仍然在');
  off.svc.dispose();
});

test('服务：缓冲里的老消息会被 TTL 清掉（不复述几分钟前的话）', async () => {
  const { svc, triggers, tick, now } = makeService({
    merge: { enable: false, windowMs: 0, maxWaitMs: 0, bufferTtlMs: 1000 },
    timing: { ...DEFAULT_HUMANLIKE.timing, replyTriggerMode: 'frequency', pendingThreshold: 2 },
    backoff: { baseSeconds: 0, capSeconds: 0, startCount: 1, bypassPendingCount: 0 },
  });
  const at = (text: string) => ev(text, { ts: now() });

  svc.ingest(at('过期话'), { isCommand: false });
  await wait(20);
  tick(5000);                                   // 这条一下子放了两分钟
  svc.ingest(at('新话一号'), { isCommand: false });
  await wait(20);                               // 这次评估顺手把它清掉
  svc.ingest(at('新话二号'), { isCommand: false });
  await wait(20);

  assert.equal(triggers.length, 1, '到阈值触发一次');
  assert.deepEqual(triggers[0].events.map((e) => e.text), ['新话一号', '新话二号'], '过期那条不该被带上');
  svc.dispose();
});

// ============================================================
// 6. 配置漂移护栏
// ============================================================

test('配置：DEFAULT_CONFIG.humanlike 与 DEFAULT_HUMANLIKE 逐字段一致（防两处默认值漂移）', () => {
  const a = JSON.parse(JSON.stringify(DEFAULT_CONFIG.humanlike));
  const b = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE));
  assert.deepEqual(a, b);
  assert.equal(DEFAULT_CONFIG.humanlike.timing.replyTriggerMode, 'likelihood', '默认走拟合概率触发（2026-10-16 换路线）');
  assert.equal(DEFAULT_CONFIG.humanlike.proactive.enable, false, '主动发言默认关（风控）');
  assert.equal(DEFAULT_CONFIG.humanlike.outgoing.typingCharactersPerSecond, 8);
});

// ============================================================
// 7. 剧本体（移植 HDSI 的 <say> authored actions）
// ============================================================

test('剧本：say 块摘出台词，prose 里原话原位保留（HDSI "The original words survive."）', () => {
  const script = '她懒洋洋地沉下去，只留眼睛在水面上。\n<say id="s1">在。</say>\n<say id="s2">有事说事。</say>';
  const { prose, actions } = readAuthoredActions(script);
  assert.deepEqual(actions.map((a) => a.content), ['在。', '有事说事。']);
  assert.deepEqual(actions.map((a) => a.id), ['s1', 's2']);
  // 标签没了，但台词原文留在原位 —— 小说读起来是连贯的
  assert.equal(prose, '她懒洋洋地沉下去，只留眼睛在水面上。\n在。\n有事说事。');
  assert.ok(!prose.includes('<say'), 'prose 里不该残留标签');
  // start/end 指向 prose 里的对应区间
  for (const a of actions) assert.equal(prose.slice(a.start, a.end), a.content);
});

test('剧本：同一个 id 出现多次时全部作废（HDSI 去重口径）', () => {
  const { actions } = readAuthoredActions('<say id="s1">甲</say><say id="s1">乙</say><say id="s2">丙</say>');
  assert.deepEqual(actions.map((a) => a.content), ['丙'], '重复 id 的引用不可执行');
});

test('剧本：没有 say 块时 actions 为空（绝不从旁白里猜台词）', () => {
  const { actions, prose } = readAuthoredActions('她翻了个身，没说话。');
  assert.equal(actions.length, 0);
  assert.equal(prose, '她翻了个身，没说话。');
  assert.equal(hasSayBlocks('她翻了个身。'), false);
  assert.equal(hasSayBlocks('<say id="a">嗯</say>'), true);
});

test('剧本：<sep/> 把一个 say 块切成多个气泡', () => {
  assert.deepEqual(splitBubbles('在。<sep/>有事说事。'), ['在。', '有事说事。']);
  assert.deepEqual(splitBubbles('就一句'), ['就一句']);
  assert.deepEqual(splitBubbles('  <sep/>  '), []);
});

test('剧本：沉默标记（[silent]，兼容旧 SKIP）', () => {
  assert.equal(isSilentScene('[silent]'), true);
  assert.equal(isSilentScene(' [silent]。 '), true);
  assert.equal(isSilentScene('SKIP'), true);
  assert.equal(isSilentScene('知道了'), false);
  assert.equal(isSilentScene('<say id="s1">在。</say>'), false);
});

test('服务：composeScene —— 只发 say 块里的字，历史回灌带标签的原文', async () => {
  const { svc } = makeService();
  const scene = '她懒得抬头。\n<say id="s1">知道了，这就去。</say>\n<say id="s2">别催。</say>';
  const { plans, historyText, spoke } = await svc.composeScene(scene);
  assert.deepEqual(plans.map((p) => p.segments[0].data.text), ['知道了，这就去。', '别催。']);
  assert.equal(spoke, true);
  assert.equal(historyText, scene, '历史必须是带标签的原文，否则模型下一轮不再写 say');
  assert.ok(!plans.some((p) => String(p.segments[0].data.text).includes('她懒得抬头')));
  svc.dispose();
});

test('服务：composeScene —— 旁白隔离只靠 <say> 结构，不做括号清洗（HDSI 口径）', async () => {
  const { svc } = makeService();
  // say 之外是旁白 → 永不外发；say 之内的字**原样**发出，哪怕它长着旁白的样子。
  // HDSI 不做括号/星号清洗，靠的是"模型只把台词放进 <say>"这条结构约定与提示词约束。
  const scene = '她懒得抬头。<say id="s1">在。</say><say id="s2">（打了个哈欠）</say>';
  const { plans } = await svc.composeScene(scene);
  const texts = plans.map((p) => p.segments[0].data.text);
  assert.deepEqual(texts, ['在。', '（打了个哈欠）']);
  assert.ok(!texts.some((t) => t.includes('她懒得抬头')), 'say 之外的旁白零泄漏');
  svc.dispose();
});

test('服务：composeScene —— 沉默标记什么都不发；没有 say 块则退回普通模式', async () => {
  const { svc, cfg } = makeService();
  const silent = await svc.composeScene('[silent]');
  assert.equal(silent.plans.length, 0);
  assert.equal(silent.spoke, false);
  assert.equal(silent.historyText, '');

  // 没有 say 块：模型没按格式来，退化成"整段当一条台词"（没有分隔标记就是一条），免得它彻底哑掉
  const plain = await svc.composeScene('知道了，这就去。');
  const joined = plain.plans.map((p) => p.segments[0].data.text).join('');
  assert.ok(joined.includes('知道了') && joined.includes('这就去'), JSON.stringify(joined));
  assert.equal(plain.spoke, true);
  void cfg;
  svc.dispose();
});

test('服务：关掉剧本体后回到普通模式（整段塑形后发出）', async () => {
  const { svc, cfg } = makeService();
  cfg.script.enable = false;
  const { plans, historyText } = await svc.composeScene('第一句。第二句。');
  assert.ok(plans.length >= 1);
  assert.equal(historyText, '第一句。第二句。');
  svc.dispose();
});

// ============================================================
// 8. HDSI 四件套：节奏反定型 / 情绪偏移 / 行动窗口 / 日程
// ============================================================

test('节奏：签名取「结构 | 尾段语气 | 字数箱体」三个维度', () => {
  assert.equal(rhythmSignature(['在。']), rhythmSignature(['好。']), '同结构的短句签名相同');
  assert.notEqual(rhythmSignature(['在。']), rhythmSignature(['在。', '有事说事。']), '气泡数不同 → 签名不同');
  assert.notEqual(rhythmSignature(['在。']), rhythmSignature(['在？']), '尾段语气不同 → 签名不同');
  assert.match(rhythmSignature(['在。']), /^1\|。\|xs$/);
});

test('节奏：balanced 档在结构+语气同构时判定型；gentle 更保守、aggressive 更早', () => {
  const same = Array.from({ length: 5 }, () => '1|。|xs');
  assert.equal(detectCollapse(same, { ...DEFAULT_RHYTHM, mode: 'balanced' }).collapsed, true);
  assert.equal(detectCollapse(same, { ...DEFAULT_RHYTHM, mode: 'aggressive' }).collapsed, true);
  // 结构一样但语气/字数有变化：balanced 认为定型（尾段语气复读），gentle 放行
  const mid = ['1|。|xs', '1|。|s', '1|。|xs', '1|。|s', '1|。|xs'];
  assert.equal(detectCollapse(mid, { ...DEFAULT_RHYTHM, mode: 'balanced' }).collapsed, true);
  assert.equal(detectCollapse(mid, { ...DEFAULT_RHYTHM, mode: 'gentle' }).collapsed, false);
  // 变化足够就是没定型
  const varied = ['1|。|xs', '2|？|s', '3+|！|m', '1||l', '2|…|xs'];
  assert.equal(detectCollapse(varied, { ...DEFAULT_RHYTHM, mode: 'aggressive' }).collapsed, false);
});

test('节奏：样本不够时不判定（宽限期）', () => {
  const few = ['1|。|xs', '1|。|xs'];
  assert.equal(detectCollapse(few, DEFAULT_RHYTHM).collapsed, false);
  assert.match(detectCollapse(few, DEFAULT_RHYTHM).detail, /样本 2\//);
});

test('情绪偏移：alter 取值钳到 -5..5 并取整', () => {
  assert.equal(normalizeAlterValue(3.4), 3);
  assert.equal(normalizeAlterValue(-9), -5);
  assert.equal(normalizeAlterValue(99), 5);
  assert.equal(normalizeAlterValue(Number.NaN), undefined);
  assert.equal(normalizeAlterValue('2'), undefined);
});

test('情绪偏移：从剧本里摘出 <alter> 并把标记从正文里去掉', () => {
  const r = readAlter('她翻了个身。<alter>+2</alter>\n<say id="s1">在。</say>');
  assert.equal(r.value, 2);
  assert.ok(!r.text.includes('<alter>'), r.text);
  assert.ok(r.text.includes('<say id="s1">在。</say>'), '剧本本体不动');
  assert.equal(readAlter('没有标记').value, undefined);
});

test('情绪偏移：同向加权、反向衰减，权重钳在 0..1', () => {
  const cfg = DEFAULT_ALTER;
  assert.ok(adjustAlterWeight(0.5, true, 2, cfg) > 0.5, '同向要涨');
  assert.ok(adjustAlterWeight(0.5, false, 2, cfg) < 0.5, '反向要落');
  assert.equal(adjustAlterWeight(0.9, true, 5, cfg), 1, '封顶 1');
  assert.equal(adjustAlterWeight(0.05, false, 5, cfg), 0, '到底 0');
});

test('情绪偏移：聊天越密阈值越低（但不会低于基准的一半）', () => {
  const cfg = DEFAULT_ALTER;
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const few = [{ at: now }];
  const many = Array.from({ length: 10 }, (_, i) => ({ at: now - i * 1000 }));
  const tFew = calculateAlterThreshold(few, cfg, now);
  const tMany = calculateAlterThreshold(many, cfg, now);
  assert.ok(tMany < tFew, `密的时候阈值应更低: ${tMany} < ${tFew}`);
  assert.equal(tMany, cfg.baseThreshold * (1 - 1 * cfg.densityFactor));
  assert.ok(calculateAlterThreshold([], cfg, now) >= cfg.baseThreshold * 0.5);
});

test('情绪偏移：累计到阈值才算命中；反向翻转会把权重衰减到过期', () => {
  const cfg = DEFAULT_ALTER;
  let now = 1_000_000;
  let st = createAlterState();
  let out = advanceAlter(st, 4, now, cfg);
  assert.equal(out.state.value, 4);
  assert.equal(out.thresholdReached, false, '4 < 阈值 10');
  out = advanceAlter(out.state, 4, (now += 1000), cfg);
  assert.equal(out.state.value, 8);
  out = advanceAlter(out.state, 4, (now += 1000), cfg);
  assert.equal(out.state.value, 12);
  assert.equal(out.thresholdReached, true, '12 >= 10');

  // 先建立一段氛围（高权重），再反复反向 → 权重掉到 minWeight 以下就过期
  st = applyAlterAnalysis({ ...out.state }, { direction: 'relaxed', description: '聊得很松', intensity: 2 }, now, cfg);
  assert.ok(alterOffsetForPrompt(st, cfg), '刚建立时应当可注入');
  // 注意 HDSI 的语义：**稳定反向不会衰减**，只有来回翻转才衰减（同向是加权）。
  // 所以一直给 -1 反而会把它养起来；要过期必须真的来回翻。
  for (let i = 0; i < 3; i++) {
    st = advanceAlter(st, -1, (now += 1000), cfg).state;
  }
  assert.ok(alterOffsetForPrompt(st, cfg), '一直同向（哪怕反向）只会加权，不会过期');
  for (let i = 0; i < 8; i++) {
    st = advanceAlter(st, i % 2 === 0 ? 1 : -1, (now += 1000), cfg).state;
  }
  assert.equal(alterOffsetForPrompt(st, cfg), null, '来回翻转够多就自然过期');
  assert.equal(alterOffsetForPrompt(st, { ...cfg, enabled: false }), null, '关掉就不注入');
});

test('情绪偏移：侧端分析结果的解析与容错', () => {
  const ok = parseAlterAnalysis('```json\n{"direction":"relaxed","description":"整体轻松","intensity":1}\n```');
  assert.deepEqual(ok, { direction: 'relaxed', description: '整体轻松', intensity: 1 });
  assert.equal(parseAlterAnalysis('不是 JSON'), null);
  assert.equal(parseAlterAnalysis('{"direction":"weird","description":"x","intensity":1}'), null);
  assert.equal(parseAlterAnalysis('{"direction":"serious","intensity":1}'), null, '没有描述不算');
});

test('行动窗口：安静时段 → 设备不可用，并给出下一个机会点', () => {
  const cfg = DEFAULT_AGENCY;
  const night = new Date(2026, 0, 1, 2, 0, 0);
  const w = deriveWindow(night, 'group', cfg, null);
  assert.equal(w.deviceAccess, 'unavailable');
  assert.ok(w.nextOpportunityAt && w.nextOpportunityAt > night.getTime(), '应排出下次机会');
  const cap = evaluateAgency(w, { origin: 'chat', reason: '想说点什么' }, night, cfg);
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'device-unavailable');
  // 白天正常
  const day = new Date(2026, 0, 1, 15, 0, 0);
  assert.equal(deriveWindow(day, 'group', cfg, null).deviceAccess, 'available');
  assert.equal(evaluateAgency(deriveWindow(day, 'group', cfg, null), { origin: 'chat', reason: 'x' }, day, cfg).allowed, true);
});

test('行动窗口：判据顺序 —— 日程过载 / 披露不足 / 最小间隔 / 日程占用', () => {
  const cfg = DEFAULT_AGENCY;
  const now = new Date(2026, 0, 1, 15, 0, 0);
  const base = deriveWindow(now, 'group', cfg, null);

  const overloaded = { ...base, activityLoad: 'overloaded' as const };
  assert.equal(evaluateAgency(overloaded, { origin: 'chat', reason: 'x' }, now, cfg).reason, 'schedule-overloaded');

  // 群聊 = public → 私事不能说
  assert.equal(
    evaluateAgency(base, { origin: 'chat', disclosure: 'personal', reason: 'x' }, now, cfg).reason,
    'privacy-insufficient',
  );
  // 私聊 = private → 可以
  const priv = deriveWindow(now, 'private', cfg, null);
  assert.equal(evaluateAgency(priv, { origin: 'chat', disclosure: 'personal', reason: 'x' }, now, cfg).allowed, true);

  // 距上次主动开口 10 分钟 < 最小间隔 60 分钟
  const cap = evaluateAgency(base, { origin: 'chat', reason: 'x' }, now, cfg, now.getTime() - 10 * 60_000);
  assert.equal(cap.reason, 'minimum-proactive-interval');
  assert.ok(cap.nextOpportunityAt && cap.nextOpportunityAt > now.getTime(), '给出下一次机会点');
  // 但承诺回访不受最小间隔限制
  assert.equal(evaluateAgency(base, { origin: 'promise', reason: '答应过' }, now, cfg, now.getTime() - 60_000).allowed, true);

  // 日程占用只挡普通闲聊
  const occupied = { ...base, activityLoad: 'occupied' as const };
  assert.equal(evaluateAgency(occupied, { origin: 'chat', reason: 'x' }, now, cfg).reason, 'schedule-occupied');
  assert.equal(evaluateAgency(occupied, { origin: 'practical-update', reason: 'x' }, now, cfg).allowed, true);

  // 窗口过期
  assert.equal(evaluateAgency({ ...base, validUntil: now.getTime() - 1 }, { origin: 'chat', reason: 'x' }, now, cfg).reason, 'agency-window-missing-or-expired');
});

test('日程：日期例外覆盖周规律；upcoming 只看到 horizon 之内', () => {
  const plan = {
    rules: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', label: '上班', busy: true }],
    exceptions: [{ date: '2026-01-01', from: '20:00', to: '22:00', label: '跨年', busy: false }],
  };
  // 2026-01-01 是周四，本该命中"上班"，但例外优先
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m, 0);
  assert.equal(currentActivity(plan, at(10))?.label, '上班');
  assert.equal(currentActivity(plan, at(21))?.label, '跨年', '例外优先于周规律');
  assert.equal(currentActivity(plan, at(23))?.label ?? null, null, '都没命中就是空闲');

  const cfg = DEFAULT_SCHEDULE;
  const up = upcoming(plan, at(8), { ...cfg, horizonHours: 12 });
  assert.ok(up.some((t) => t.includes('上班')), up.join('|'));
  const up2 = upcoming(plan, at(19), { ...cfg, horizonHours: 12 });
  assert.ok(up2.some((t) => t.includes('跨年')), up2.join('|'));
});

test('日程：计划注入必须标明"不是已发生的事实"', () => {
  const plan = { rules: [{ days: [1], from: '09:00', to: '18:00', label: '上班', busy: true }], exceptions: [] };
  const text = schedulePrompt(plan, new Date(2026, 0, 5, 8, 0, 0), DEFAULT_SCHEDULE);
  assert.ok(text, '有安排就该出节');
  assert.match(text!, /计划，不是已发生的事实/);
  assert.match(text!, /别当成已经做过的事/);
  assert.equal(
    schedulePrompt({ rules: [], exceptions: [] }, new Date(2026, 0, 5, 8, 0, 0), DEFAULT_SCHEDULE),
    null,
    '没安排就不出节',
  );
});

test('日程：过期例外会被清掉', () => {
  const plan = {
    rules: [],
    exceptions: [
      { date: '2025-12-31', from: '01:00', to: '02:00', label: '过期' },
      { date: '2026-01-01', from: '01:00', to: '02:00', label: '今天' },
    ],
  };
  const pruned = prunePlan(plan, new Date(2026, 0, 1, 12, 0, 0), DEFAULT_SCHEDULE);
  assert.deepEqual(pruned.exceptions.map((e) => e.label), ['今天']);
});

// ============================================================
// 发送服务：风控限速 × 拟人化节奏（这一层是两边唯一交汇的地方）
// ============================================================

function makeChat(opts: { ratePerMin: number }) {
  const bus = new Bus();
  const sent: string[] = [];
  const logs: any[] = [];
  let n = 0;
  const adapter: TransportAdapter = {
    send: async (_chat, segments) => { sent.push(segments.filter((s) => s.type === 'text').map((s) => String(s.data.text)).join('')); return `m${++n}`; },
    sendFile: async () => 'f',
    connected: () => true,
    status: () => ({}),
  };
  const svc = new ChatService(bus, {
    ratePerMin: opts.ratePerMin,
    sandboxRoot: () => '',
    sessionLog: { append: (_c: string, _t: string, e: any) => { logs.push(e); return {} as any; } } as never,
    onUsage: () => {},
  });
  svc.attachAdapter(adapter);
  return { svc, sent, logs };
}

const bubble = (t: string, pauseMs = 0): SendPlan => ({
  segments: [{ type: 'text' as const, data: { text: t } }],
  pauseMs,
});

test('发送服务：配额够就按计划几条发几条（限速按条计费，不按轮）', async () => {
  const { svc, sent } = makeChat({ ratePerMin: 10 });
  const r = await svc.sendPlanned(chat, [bubble('一'), bubble('二'), bubble('三')]);
  assert.equal(r.sent, 3);
  assert.deepEqual(sent, ['一', '二', '三']);
});

test('发送服务：配额不够时截断成前几条，而不是整批静默丢弃', async () => {
  const { svc, sent, logs } = makeChat({ ratePerMin: 2 });
  const r = await svc.sendPlanned(chat, [bubble('一'), bubble('二'), bubble('三'), bubble('四')]);
  assert.equal(r.sent, 2);
  assert.deepEqual(sent, ['一', '二']);
  const gate = logs.find((l) => l.data?.decision === 'rate_truncated');
  assert.ok(gate, '截断要在会话日志里留一条 gate，不能悄悄少发');
  assert.equal(gate.data.wanted, 4);
  assert.equal(gate.data.granted, 2);
});

test('发送服务：一个令牌都没有时才整批丢弃，并记 rate_limited', async () => {
  const { svc, sent, logs } = makeChat({ ratePerMin: 1 });
  await svc.sendPlanned(chat, [bubble('一')]);       // 吃掉唯一那个令牌
  const r = await svc.sendPlanned(chat, [bubble('二'), bubble('三')]);
  assert.equal(r.sent, 0);
  assert.deepEqual(sent, ['一']);
  assert.ok(logs.find((l) => l.data?.decision === 'rate_limited'));
});

test('发送服务：停顿只来自计划本身（风控不再另加随机抖动）', async () => {
  // 有打字停顿：总耗时就是停顿之和，不该再多出别的东西
  const withPause = makeChat({ ratePerMin: 10 });
  const t0 = Date.now();
  await withPause.svc.sendPlanned(chat, [bubble('一'), bubble('二', 30)]);
  const paused = Date.now() - t0;
  assert.ok(paused >= 25 && paused < 200, `总耗时应接近 30ms 停顿，实际 ${paused}ms`);

  // 没有停顿：立刻发出去，不额外等
  const noPause = makeChat({ ratePerMin: 10 });
  const t1 = Date.now();
  await noPause.svc.sendPlanned(chat, [bubble('整条回复')]);
  assert.ok(Date.now() - t1 < 100, '无停顿的回复不该被风控延迟');
});
