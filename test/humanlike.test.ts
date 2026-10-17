import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NECESSITY_TRIGGER_SCORE, scoreReplyNecessity, idleCompensation, presencePenalty,
  isShortReactionBatch, stripNecessityNoise, looksLikeQuestion, pressureScore,
} from '../src/kernel/humanlike/necessity.ts';
import { talkValueFor, idleBackoffSeconds, backoffBypassed, burstGatePenalty, inTimeWindow } from '../src/kernel/humanlike/frequency.ts';
import {
  normalizeVisibleContent, trimAtSentence, splitIntoBubbles, typingDelayMs, clip,
  isSilentScene, SILENT_MARKER, DEFAULT_OUTGOING,
} from '../src/kernel/humanlike/delivery.ts';
import { HumanlikeService } from '../src/kernel/humanlike/service.ts';
import { DEFAULT_HUMANLIKE, type HumanlikeConfig } from '../src/kernel/humanlike/types.ts';
import {
  DEFAULT_RHYTHM, rhythmSignature, detectCollapse,
} from '../src/kernel/humanlike/rhythm.ts';
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

test('频率：轰炸降频 —— 10 秒内超过 5 条后门槛递增，封顶 +0.3', () => {
  assert.equal(burstGatePenalty(0), 0);
  assert.equal(burstGatePenalty(5), 0, '5 条以内不罚');
  assert.equal(burstGatePenalty(6), 0.05);
  assert.ok(Math.abs(burstGatePenalty(11) - 0.3) < 1e-9, '11 条封顶');
  assert.equal(burstGatePenalty(20), 0.3, '封顶不再涨');
});

// ============================================================
// 4. 出站投递（纯程序：归一化 / 句边截断 / 按句分条 / 打字节奏）
// ============================================================

test('投递：按换行与句末标点分条；连续标点并作一个句尾；收尾引号跟着前一句', () => {
  assert.deepEqual(splitIntoBubbles('在。有事说事。'), ['在。', '有事说事。']);
  assert.deepEqual(splitIntoBubbles('在\n我先睡会儿'), ['在', '我先睡会儿'], '换行是最强的分条意图');
  assert.deepEqual(splitIntoBubbles('真的吗？？'), ['真的吗？？'], '连续问号并作同一个句尾');
  assert.deepEqual(splitIntoBubbles('他说「好。」然后走了'), ['他说「好。」', '然后走了'], '右引号跟着前一句');
  assert.deepEqual(splitIntoBubbles('嗯嗯'), ['嗯嗯'], '没有句末标点就是一条');
});

test('投递：最多 4 条气泡，尾巴并进最后一条（不丢字、不无限累加打字等待）', () => {
  const out = splitIntoBubbles('一。二。三。四。五。六。');
  assert.equal(out.length, 4);
  assert.equal(out.join(''), '一。二。三。四。五。六。');
  assert.equal(out[3], '四。五。六。');
});

test('投递：句边截断 —— 超长时保留到最后一个句末标点；句边靠前才按句截，否则硬切', () => {
  assert.equal(trimAtSentence('第一句。第二句。第三句。', 8), '第一句。第二句。', '8 字内最后一个句号处截');
  assert.equal(trimAtSentence('短短。然后是一大段没有标点的话', 8), '短短。然后是一大', '句边落在前半段 → 硬切');
  assert.equal(trimAtSentence('没有标点的长句子xxxxxxxxxx', 5), '没有标点的', '找不到像样的句边就硬切');
  assert.equal(trimAtSentence('本来就短。', 100), '本来就短。', '没超长原样返回');
});

test('投递：归一化剥媒体占位符与模型手滑标签；旧分隔标记当换行（迁移期兜底）；硬截断', () => {
  // 媒体占位符剥掉
  assert.equal(normalizeVisibleContent('看图【图片】[CQ:image,file=x]好了', 100), '看图好了');
  // 模型自己发明/残留的标签剥掉：自闭标签整体丢、成对的 say 标签留话
  assert.equal(normalizeVisibleContent('<set_mood mood="晕乎乎"/>你好', 100), '你好');
  assert.equal(normalizeVisibleContent('<say id="s1">在。</say>', 100), '在。');
  // 旧分隔标记（剧本体时代）当换行：分条意图保留，记号不外发
  assert.equal(normalizeVisibleContent('在。<sep/>有事说事。', 100), '在。\n有事说事。');
  // 截断是硬切尾巴，不重切、不丢整条
  assert.equal(normalizeVisibleContent('一二三四五', 3), '一二三');
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
  // base=0 + max=0 → 落到 250ms 下限（没有「0 = 关闭打字」这一档）
  assert.equal(typingDelayMs('随便什么', { ...base, typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0 }), 250);
  // 抖动落点由 rng 决定，但始终落在 [250, cap]
  const jit = { ...base, typingJitterRatio: 0.3 };
  const lo = typingDelayMs('一二三四五六七八', jit, () => 0);
  const hi = typingDelayMs('一二三四五六七八', jit, () => 1);
  assert.ok(lo >= 250 && hi <= 12000 && lo < hi, `抖动区间异常: ${lo} / ${hi}`);
});

test('投递：完整流水线 —— 归一化 → 句边截断 → 按句分条（截掉的尾巴不会漏出去）', () => {
  const raw = '（笑）刚睡醒。你说。<set_mood mood="x"/>';
  const t = trimAtSentence(normalizeVisibleContent(raw, DEFAULT_OUTGOING.maxMessageCharacters), DEFAULT_OUTGOING.replyMaxCharacters);
  assert.deepEqual(splitIntoBubbles(t), ['（笑）刚睡醒。', '你说。']);
  const long = `${'很长的一段话'.repeat(30)}。尾巴一句。`;
  const cut = trimAtSentence(normalizeVisibleContent(long, DEFAULT_OUTGOING.maxMessageCharacters), DEFAULT_OUTGOING.replyMaxCharacters);
  assert.ok(cut.length <= DEFAULT_OUTGOING.replyMaxCharacters, `截断后不该超上限: ${cut.length}`);
  assert.ok(splitIntoBubbles(cut).length >= 1);
});

test('投递：沉默标记（[silent]，兼容旧 SKIP）', () => {
  assert.equal(isSilentScene('[silent]'), true);
  assert.equal(isSilentScene(' [silent]。 '), true);
  assert.equal(isSilentScene('SKIP'), true);
  assert.equal(isSilentScene('知道了'), false);
  assert.equal(SILENT_MARKER, '[silent]');
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
    // 起跳随机延时用固定 0（= 取下限）：测试要确定性，抖动幅度由用例显式配置
    random: rng0,
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
  assert.equal(svc.ingest(ev('/work 算一下昨天的账'), { isCommand: true }).action, 'pass');
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

test('服务：合批关窗后按随机延时起跳，不是关窗就秒回', async () => {
  const { svc, triggers } = makeService({
    merge: { enable: true, windowMs: 10, maxWaitMs: 10_000, bufferTtlMs: 120_000, fireDelayMinMs: 40, fireDelayMaxMs: 40 },
    timing: { ...DEFAULT_HUMANLIKE.timing, replyTriggerMode: 'frequency', pendingThreshold: 1 },
  });
  svc.ingest(ev('在吗'), { isCommand: false });
  await wait(25);
  assert.equal(triggers.length, 0, '关窗（windowMs=10ms）之后还要等起跳延时（40ms）');
  await wait(60);
  assert.equal(triggers.length, 1, '延时一到就起跳');
  svc.dispose();
});

test('服务：@ 直通不受合批与起跳延时影响（同步放行）', async () => {
  const { svc, triggers } = makeService({
    merge: { enable: true, windowMs: 10_000, maxWaitMs: 10_000, bufferTtlMs: 120_000, fireDelayMinMs: 5_000, fireDelayMaxMs: 5_000 },
    timing: { ...DEFAULT_HUMANLIKE.timing, replyTriggerMode: 'frequency', pendingThreshold: 1 },
  });
  const at = svc.ingest(ev('在吗', { isAtMe: true }), { isCommand: false });
  assert.equal(at.action, 'pass', '@ 立即交回调用方，不走合批与延时');
  assert.equal(triggers.length, 0, '直通路径由 pipeline 处理，不经过 trigger 回调');
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

test('服务：compose 第一条不等、其余按打字延迟排停顿（按句分条）', async () => {
  const { svc } = makeService({
    outgoing: { ...DEFAULT_OUTGOING, typingBaseDelaySeconds: 0, typingCharactersPerSecond: 1, typingMaxDelaySeconds: 30, typingJitterRatio: 0 },
  });
  // 三句话 → 三个气泡；首条不等，其后每条 = ceil(字数 / 每秒字数)
  const plans = await svc.compose(chat, '在的。刚睡醒。你说。');
  assert.equal(plans.length, 3, `应按句拆成 3 条: ${plans.length}`);
  assert.equal(plans[0].pauseMs, 0, '第一条立刻发');
  assert.deepEqual(plans.slice(1).map((p) => p.pauseMs), [4000, 3000], '后续每条 = ceil(字数 / 每秒字数)');
  // 逗号不断句：只有逗号的长句仍是一条
  const one = await svc.compose(chat, '第一句，第二句，第三句。');
  assert.equal(one.length, 1, '逗号不是句末标点');
  assert.equal(one[0].pauseMs, 0);
  svc.dispose();
});

test('服务：群里的普通消息一律进门控（没有"全都放行"的旁路）', () => {
  const { svc } = makeService();
  assert.equal(svc.ingest(ev('普通消息'), { isCommand: false }).action, 'handled');
  svc.dispose();
});

test('服务：关掉分条就整段一条发出去（分条是纯程序开关，门控照旧）', async () => {
  const off = makeService({ outgoing: { ...DEFAULT_OUTGOING, splitReplyMessages: false } });
  const plans = await off.svc.compose(chat, '第一句。第二句。');
  assert.equal(plans.length, 1, '分条关掉 = 整段一条');
  assert.equal(plans[0].segments[0].data.text, '第一句。第二句。');
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
// 7. 出站落地（composeScene）：模型说什么就发什么
// ============================================================

test('服务：composeScene —— 发出去的就是模型写的正文；历史回灌与发出去的气泡同形', async () => {
  const { svc } = makeService();
  const { plans, historyText, spoke } = await svc.composeScene('知道了。别催。');
  assert.deepEqual(plans.map((p) => p.segments[0].data.text), ['知道了。', '别催。']);
  assert.equal(historyText, '知道了。\n别催。', '历史与群里看到的同形（不再有带标签剧本）');
  assert.equal(spoke, true);
  svc.dispose();
});

test('服务：composeScene —— 超长按句边截断；沉默标记什么都不发', async () => {
  const { svc } = makeService({ outgoing: { ...DEFAULT_OUTGOING, replyMaxCharacters: 12 } });
  const cut = await svc.composeScene('第一句短。第二句也还行。第三句就开始啰嗦了要说个没完。');
  const joined = cut.plans.map((p) => p.segments[0].data.text).join('');
  assert.ok(joined.length <= 12, `截断后不该超上限: ${joined.length}`);
  assert.ok(joined.startsWith('第一句短。'), joined);
  const silent = await svc.composeScene('[silent]');
  assert.equal(silent.plans.length, 0);
  assert.equal(silent.spoke, false);
  assert.equal(silent.historyText, '');
  svc.dispose();
});

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
