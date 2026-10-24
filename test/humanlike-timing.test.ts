import assert from 'node:assert/strict';
import { test } from 'node:test';

// 2026-10-24 开口时机 B/C 层优化的专项测试：
//   B1 空窗补偿锚定 bot 上次开口（不再被 buffer TTL 连坐）
//   B2 群重新热闹（近 5 分钟 ≥3 条真人消息）清退避
//   B3 问句打折 / 刷屏加倍
//   C1 自适应门槛（快群=配置值，慢群放宽到 5）
//   C2 软阈值概率开口
//   C4 昼夜因子（冷清小时门槛上浮）
import {
  ADAPTIVE, CIRCADIAN, SIGNAL,
  adaptiveThreshold, circadianThresholdMultiplier, idleEquivalentCap,
  looksLikeFlood, looksLikeQuestion, softThresholdProbability,
} from '../src/kernel/humanlike/frequency.ts';
import { HumanlikeService } from '../src/kernel/humanlike/service.ts';
import { DEFAULT_HUMANLIKE, type HumanlikeConfig } from '../src/kernel/humanlike/types.ts';
import { Bus } from '../src/kernel/bus.ts';
import { ErrorCenter } from '../src/kernel/errors.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, ChatRef } from '../src/kernel/types.ts';

const chat: ChatRef = { platform: 'qq', type: 'group', chatId: '910' };
const rng0 = () => 0;
const rng1 = () => 0.999999;

// ============================================================
// 纯函数
// ============================================================

test('C1 自适应门槛：快群恰为配置值，慢群反比放宽，下限 5，样本不足不动', () => {
  assert.equal(adaptiveThreshold(10, null, 0), 10, '没有平均间隔 → 配置值');
  assert.equal(adaptiveThreshold(10, 30, ADAPTIVE.MIN_SAMPLES - 1), 10, '样本不足 → 配置值');
  assert.equal(adaptiveThreshold(10, 30, 20), 10, '快群（avg 被钳在 30s 下限）→ 恰为配置值，busy 行为不变');
  assert.equal(adaptiveThreshold(10, 60, 20), 5, '中速群 60s → 10×30/60=5');
  assert.equal(adaptiveThreshold(10, 93, 20), 5, '慢群 93s → 3.2 → 下限 5');
  assert.equal(adaptiveThreshold(10, 300, 20), 5, '死群 → 下限 5');
  assert.equal(adaptiveThreshold(6, 60, 20), 5, '配置本身低于下限时也不抬高配置意图：6→3→钳 5');
});

test('C4 昼夜因子：样本不足中性；活跃小时 1.0、最冷小时 1+MAX_EXTRA', () => {
  assert.equal(circadianThresholdMultiplier(null, 3), 1);
  const empty = new Array<number>(24).fill(0);
  assert.equal(circadianThresholdMultiplier(empty, 3), 1, '全零直方图 → 中性');
  const buckets = new Array<number>(24).fill(0);
  buckets[21] = 100;            // 晚 9 点最热
  buckets[4] = 0;               // 凌晨 4 点从没消息
  buckets[12] = 40;
  assert.ok(Math.abs(circadianThresholdMultiplier(buckets, 21) - 1) < 1e-9, '最热小时 ×1.0');
  assert.ok(Math.abs(circadianThresholdMultiplier(buckets, 4) - (1 + CIRCADIAN.MAX_EXTRA)) < 1e-9, '最冷小时 ×1.75');
  const noon = circadianThresholdMultiplier(buckets, 12);
  assert.ok(noon > 1 && noon < 1 + CIRCADIAN.MAX_EXTRA, `中间档介于两者之间（实际 ${noon.toFixed(2)}）`);
});

test('B1 折算帽：min(阈值-1, ceil(0.4×阈值))，慢群门槛低时帽也低', () => {
  assert.equal(idleEquivalentCap(10), 4);
  assert.equal(idleEquivalentCap(5), 2);
  assert.equal(idleEquivalentCap(3), 2);
  assert.equal(idleEquivalentCap(2), 1, '阈值 2 时帽 1：单条消息 + 帽 < 阈值，纯折算永远不够');
});

test('C2 软阈值：95% 门槛以下 0、门槛处 1、之间线性', () => {
  assert.equal(softThresholdProbability(9, 10), 0, '9/10 < 9.5 → 0（10-24 收紧后 9 条不再提前开）');
  assert.ok(Math.abs(softThresholdProbability(9.75, 10) - 0.5) < 1e-9, '中点 0.5');
  assert.equal(softThresholdProbability(10, 10), 1);
  assert.equal(softThresholdProbability(2, 2), 0, '门槛 <3 没有软区');
});

test('B3 问句启发式：问号/吗么嘛收尾/短疑问词开头；陈述句不误中', () => {
  for (const t of ['在吗', '有人吗？', '这个怎么用？', '真的假的？', '吃了吗。', '去么', '是嘛', '怎么办', '为什么啊', '咋回事', '怎么']) {
    assert.ok(looksLikeQuestion(t), `应识别问句：${t}`);
  }
  for (const t of ['风好大', '哈哈哈', '今天吃了火锅', '那我们去吃饭', '牛啊', '为什么这么长的一句话其实是在陈述一个事实而已啦']) {
    assert.ok(!looksLikeQuestion(t), `不应误中：${t}`);
  }
});

test('B3 刷屏识别：≥5 条超短消息且 ≥2 人才算；长消息或单人都不算', () => {
  const now = 1_000_000;
  const mk = (userId: string, text: string, dt: number) => ({ userId, text, ts: now - dt });
  const spam = ['u1', 'u2', 'u1', 'u2', 'u1'].map((u, i) => mk(u, '哈哈哈哈', i * 5_000));
  assert.ok(looksLikeFlood(spam, now));
  assert.ok(!looksLikeFlood(spam.slice(0, 4), now), '4 条不够');
  assert.ok(!looksLikeFlood([mk('u1', '这句话特别长肯定超过十个字了', 0), ...spam.slice(1)], now), '混入长消息不算');
  assert.ok(!looksLikeFlood(['u1', 'u1', 'u1', 'u1', 'u1'].map((u, i) => mk(u, '哈', i * 5_000)), now), '单人刷不算');
  assert.ok(!looksLikeFlood(spam.map((e, i) => ({ ...e, ts: now - (i + 1) * 60_000 })), now), '超出 90s 窗口不算');
});

// ============================================================
// 服务级集成（fake clock：tsc 单测驱动 evaluate 全链路）
// ============================================================

const HL_TMP: string[] = [];

function makeService(over: Partial<HumanlikeConfig> = {}, random: () => number = rng0) {
  // 合批参数默认归零（评估即时可测）；backoff 不动——需要退避的用例显式配，需要关的也显式关
  const cfg: HumanlikeConfig = JSON.parse(JSON.stringify({
    ...DEFAULT_HUMANLIKE,
    merge: { enable: true, windowMs: 0, maxWaitMs: 0, bufferTtlMs: 120_000, fireDelayMinMs: 0, fireDelayMaxMs: 0 },
    ...over,
  }));
  const dir = mkdtempSync(join(tmpdir(), 'hl-timing-'));
  HL_TMP.push(dir);
  const bus = new Bus();
  const errors = new ErrorCenter(bus, { dataDir: dir });
  const triggers: { events: ChatEvent[]; reason: string; detail: string }[] = [];
  const gates: { text?: string; data?: Record<string, unknown> }[] = [];
  let fake = 1_700_000_000_000; // 固定起点，小时桶确定
  const svc = new HumanlikeService({
    config: () => cfg,
    selfNickname: () => '麦麦',
    trigger: (b) => triggers.push({ events: b.events, reason: b.reason, detail: b.detail }),
    sessionLog: { append: (_c: string, _t: 'group' | 'private', e: { text?: string; data?: Record<string, unknown> }) => { gates.push({ text: e.text, data: e.data }); } } as never,
    bus, errors,
    now: () => fake,
    random,
  });
  return {
    svc, cfg, triggers, gates,
    tick: (ms: number) => { fake += ms; },
    now: () => fake,
  };
}

function ev(text: string, over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    id: `e${Math.random()}`, platform: 'qq', type: 'group', chatId: '910',
    userId: '10001', nickname: '小明', senderRole: 'member',
    segments: [{ type: 'text', data: { text } }], text,
    isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(), ...over,
  };
}

/** 喂一条消息并把防抖/起跳耗完（windowMs=0 + fireDelay 0 时等于立即评估）。
 *  ts 必须钉在 fake 时钟上：服务内部所有时间窗（TTL/活跃/空窗）都拿 now - e.ts 比。 */
async function feed(h: ReturnType<typeof makeService>, e: ChatEvent) {
  e.ts = h.now();
  h.svc.ingest(e, { isCommand: false });
  await new Promise((r) => setTimeout(r, 10));
}

/** 用间隔 60s 的消息把「平均间隔样本」喂够 5 条（间隔 ≥5s 才计入），把 avg 钉在 60s → 自适应 10→5 */
async function primeSlowPace(h: ReturnType<typeof makeService>, n = 6) {
  for (let i = 0; i < n; i++) {
    await feed(h, ev(`铺垫${i}`, { userId: `u${i % 3}` }));
    h.tick(60_000);
  }
}

test('B1 全链路：bot 上次开口后沉默 20 分钟，第三条新消息开口（旧口径要攒满 10 条）', async () => {
  const h = makeService({ timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 10 } });
  await primeSlowPace(h);                        // avg=60s（中位数）、样本 6 → 自适应 10→5，帽 2
  h.svc.noteSpoke(chat);                         // bot 开口：idle 锚点归零，沉默间隙不进节奏样本
  h.tick(20 * 60_000);                           // 沉默 20 分钟（<30min 样本窗，60s 样本仍有效）
  await feed(h, ev('第一句'));
  h.tick(40_000);
  await feed(h, ev('第二句'));
  assert.equal(h.triggers.length, 0, '1+帽2=3、2+帽2=4 都 <5：说完话后别太快再插嘴（10-24 收紧）');
  h.tick(40_000);
  await feed(h, ev('第三句'));
  assert.equal(h.triggers.length, 1, '3+帽2=5 ≥5 开口');
  assert.equal(h.triggers[0]?.reason, 'idle');
  h.svc.dispose();
});

test('B1 防自唤醒红线：纯沉默（pending=0）永远不触发', async () => {
  const h = makeService({ timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 10 } });
  h.svc.noteSpoke(chat);
  h.tick(6 * 3600_000);                          // bot 说完沉默 6 小时，buffer 空
  await feed(h, ev('单句'));                 // 评估后 buffer 排空进入退避 recheck
  h.triggers.length = 0;
  h.tick(600_000);                               // recheck：pending=0
  assert.equal(h.triggers.length, 0);
  h.svc.dispose();
});

test('B2：近 5 分钟 ≥3 条真人消息清退避——慢群里爬满的退避不再焊死小高峰', async () => {
  const h = makeService({
    timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 10 },
    backoff: { baseSeconds: 15, capSeconds: 300, startCount: 1, bypassPendingCount: 0 },
  });
  // 阶段一：每 5 分钟一条的零星消息（间隔 300s 算节奏）把退避爬满、每次评估都说"不说"
  for (let i = 0; i < 8; i++) {
    await feed(h, ev(`零星${i}这是一句正常长度的话`, { userId: 'u1' }));
    h.tick(300_000);
  }
  const snap1 = h.svc.snapshot(chat) as { consecutiveNoAction?: number; backoffUntil?: number };
  assert.ok((snap1.consecutiveNoAction ?? 0) >= 5, `退避计数应已爬高（实际 ${snap1.consecutiveNoAction}）`);
  assert.ok((snap1.backoffUntil ?? 0) > 0, '应处于退避窗口内');
  h.triggers.length = 0;
  // 阶段二：群友 15s 一条连发 5 条（自适应门槛 10→5）。没有 B2 的活跃清退避，
  // 满格 300s 退避会把每一次评估都挡住（bypass=0），一条都开不了口
  for (let i = 0; i < 5; i++) {
    await feed(h, ev(`热闹${i}大家真的聊起来了这句话特别长`, { userId: `u${i % 3}` }));
    h.tick(15_000);
  }
  assert.equal(h.triggers.length, 1, '热闹起来的第 5 条跨过自适应门槛 5 开口（退避已被活跃清掉）');
  h.svc.dispose();
});

test('B3：末条问句把门槛打对折并在 gate 日志留痕；刷屏把门槛翻倍', async () => {
  const h = makeService({
    timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 10 },
    backoff: { baseSeconds: 0, capSeconds: 0, startCount: 1, bypassPendingCount: 0 },
  });
  // avg 样本不足（间隔 <5s 的连发不计）→ 无自适应，门槛就是 10
  for (let i = 0; i < 4; i++) {
    await feed(h, ev(`陈述${i}这是一条比较长的陈述句`, { userId: `u${i}` }));
    h.tick(1_000);
  }
  assert.equal(h.triggers.length, 0, '4 条 < 10 不开口');
  await feed(h, ev('所以到底去不去？', { userId: 'u0' }));  // 第 5 条是问句：10×0.5=5 → 开
  assert.equal(h.triggers.length, 1, '问句把门槛 10 → 5，第 5 条开口');
  assert.match(String(h.gates.at(-1)?.text ?? ''), /问句×0\.5/);
  h.svc.dispose();

  const h2 = makeService({
    timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 5 },
    backoff: { baseSeconds: 0, capSeconds: 0, startCount: 1, bypassPendingCount: 0 },
  });
  const flood = ['哈哈哈哈', '草', '笑死', '666', '绷不住'];
  for (let i = 0; i < 5; i++) {
    await feed(h2, ev(flood[i]!, { userId: `u${i % 2}` }));  // 5 条超短、2 人 → 刷屏×2 → 5→10
    h2.tick(1_000);
  }
  assert.equal(h2.triggers.length, 0, '第 5 条本应过门槛 5，但刷屏 ×2 抬到 10，不开口');
  //（不说日志有 10s 限流，测试窗口内被并掉；刷屏加倍本身已由"没开口"证明）
  h2.svc.dispose();
});

test('C2：等效条数过 95% 门槛按概率开口——rng 必中即开、必不中静默', async () => {
  const off = { baseSeconds: 0, capSeconds: 0, startCount: 1, bypassPendingCount: 0 };
  const mk = (random: () => number) => makeService(
    { timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 5 }, backoff: off },
    random,
  );
  // 门槛 5、软区 [4.75, 5)：noteSpoke 后停 26s 再来 4 条（间隔 1s，无节奏样本）
  // → idle≈29s/30s≈0.97（帽 2）→ 等效 4.97 → p≈0.87：rng0 必中、rng1 必不中
  for (const [name, random, expectFire] of [['必中(rng0)', rng0, 1], ['必不中(rng1)', rng1, 0]] as const) {
    const h = mk(random);
    h.svc.noteSpoke(chat);
    h.tick(26_000);
    for (let i = 0; i < 4; i++) {
      await feed(h, ev(`铺垫用的较长消息内容第${i}句，请忽略`, { userId: `u${i % 3}` }));
      h.tick(1_000);
    }
    assert.equal(h.triggers.length, expectFire, `软阈值（等效≈4.97/5，p≈0.87）：${name} → ${expectFire ? '开口' : '静默'}`);
    h.svc.dispose();
  }
});

test('C4 集成不变量：直方图样本不足时昼夜因子中性，开口行为与从前一致', async () => {
  const h = makeService({
    timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 3 },
    backoff: { baseSeconds: 0, capSeconds: 0, startCount: 1, bypassPendingCount: 0 },
  });
  for (let i = 0; i < 3; i++) {
    await feed(h, ev(`正常聊天第${i}句`, { userId: `u${i}` }));
    h.tick(1_000);
  }
  assert.equal(h.triggers.length, 1, '样本不足时昼夜因子中性，3 条过门槛 3 照常开口');
  h.svc.dispose();
});

test('快群保护：连发（<5s 间隔）不进 avg 样本，门槛维持配置值——busy hour 行为不变', async () => {
  // rng1：软阈值概率分支必不中——本测试只验证硬门槛，不让 C2 的概率掺和
  const h = makeService({ timing: { ...DEFAULT_HUMANLIKE.timing, pendingThreshold: 10 } }, rng1);
  for (let i = 0; i < 9; i++) {
    await feed(h, ev(`快节奏消息第${i}条，比较长`, { userId: `u${i % 4}` }));
    h.tick(1_500);                                // 1.5s 间隔 → burst，不计样本
  }
  assert.equal(h.triggers.length, 0, '9 条仍 < 10：快群里门槛没有被动过');
  await feed(h, ev('第十条也来了，内容比较长', { userId: 'u1' }));
  assert.equal(h.triggers.length, 1, '第 10 条照常开口（reason=frequency）');
  assert.equal(h.triggers[0]?.reason, 'frequency');
  h.svc.dispose();
});

test.after(() => { for (const d of HL_TMP) rmSync(d, { recursive: true, force: true }); });
