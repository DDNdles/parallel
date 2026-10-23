import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GATE_WEIGHTS,
  DynamicReplyGate,
  MAIBOT_RAW_WEIGHTS,
  fitWeights,
  likelihoodFeatureVector,
  replyLikelihood,
  staticThreshold,
  type GateFeatures,
} from '../src/kernel/humanlike/likelihood.ts';
import { HumanlikeService } from '../src/kernel/humanlike/service.ts';
import { SessionLog } from '../src/kernel/sessionlog.ts';
import { Bus } from '../src/kernel/bus.ts';
import { DEFAULT_HUMANLIKE, type HumanlikeConfig } from '../src/kernel/humanlike/types.ts';
import type { ChatEvent } from '../src/kernel/types.ts';

/**
 * likelihood 已对齐 MaiBot 主线 `dynamic`：
 *  8 个会话结构特征 + 1 小时预算/分位门控；@/提及强制触发按 0.91 占预算。
 * 与 MaiBot 唯一有意差异：训练标签用「模型最终有没有真说话」，不再用门控自己开没开。
 */

const mkFeatures = (over: Partial<GateFeatures> = {}): GateFeatures => ({
  mentionBot: false,
  atOther: false,
  hasQuestionMark: false,
  placeholderOnly: false,
  recentSelfRatio: 0,
  recentMessageCount: 2,
  secondsSinceBotMessage: 3600,
  pendingCount: 2,
  ...over,
});

test('先验权重逐项等于 MaiBot 原文：缩放后概率不变', () => {
  assert.equal(DEFAULT_GATE_WEIGHTS.bias, MAIBOT_RAW_WEIGHTS.bias);
  // 原始 count/seconds/pending 权重乘以各自缩放倍数，先验概率与 MaiBot 原式等价
  assert.equal(DEFAULT_GATE_WEIGHTS.w[5], MAIBOT_RAW_WEIGHTS.recentMessageCount * 50);
  assert.equal(DEFAULT_GATE_WEIGHTS.w[6], MAIBOT_RAW_WEIGHTS.logSecondsSinceBotMessage * 5);
  assert.equal(DEFAULT_GATE_WEIGHTS.w[7], MAIBOT_RAW_WEIGHTS.pendingCount * 20);
  assert.deepEqual(likelihoodFeatureVector(mkFeatures({ pendingCount: 21 })), [0, 0, 0, 0, 0, 0.04, Math.log1p(3600) / 5, 1]);
});

test('概率先验：提及/积压高，@别人/纯媒体/自己刚说过低', () => {
  const plain = replyLikelihood(mkFeatures(), DEFAULT_GATE_WEIGHTS);
  const mention = replyLikelihood(mkFeatures({ mentionBot: true }), DEFAULT_GATE_WEIGHTS);
  const pending = replyLikelihood(mkFeatures({ pendingCount: 20, recentMessageCount: 30 }), DEFAULT_GATE_WEIGHTS);
  const atOther = replyLikelihood(mkFeatures({ atOther: true }), DEFAULT_GATE_WEIGHTS);
  const media = replyLikelihood(mkFeatures({ placeholderOnly: true }), DEFAULT_GATE_WEIGHTS);
  const selfTalk = replyLikelihood(mkFeatures({ recentSelfRatio: 0.8 }), DEFAULT_GATE_WEIGHTS);
  assert.ok(mention > plain, `mention=${mention} plain=${plain}`);
  assert.ok(pending > plain, `pending=${pending} plain=${plain}`);
  assert.ok(atOther < plain, `atOther=${atOther} plain=${plain}`);
  assert.ok(media < plain, `media=${media} plain=${plain}`);
  assert.ok(selfTalk > plain, `selfTalk=${selfTalk} plain=${plain}`);
});

test('静态阈值表：与 MaiBot 原表一致，并在区间内线性插值', () => {
  assert.equal(staticThreshold(0), 1);
  assert.equal(staticThreshold(1), 0);
  assert.equal(staticThreshold(0.5), 0.336);
  assert.ok(Math.abs(staticThreshold(0.25) - 0.456) < 1e-9);
});

test('动态门控：talk_value 决定保留比例；实际回复过多会收紧', () => {
  const gate = new DynamicReplyGate();
  let now = 1_000_000;
  gate.recordProactiveDemand(1, now);
  // 窗口样本不足 20 → 静态表：keep=0.5 → 0.336
  const half = gate.evaluate(0.5, 0.5, now);
  assert.equal(half.keepRatio, 0.5);
  assert.ok(Math.abs(half.threshold - 0.336) < 1e-9);
  assert.equal(half.shouldTrigger, true);

  // 实际已经回了 1 次，feedback 收紧到 0.25 → 阈值上抬
  gate.recordReply(now);
  const tightened = gate.evaluate(0.5, 0.5, now);
  assert.ok(tightened.keepRatio < 0.5, `keep=${tightened.keepRatio}`);
  assert.ok(tightened.threshold > tightened.keepRatio * 0 + 0.336, `threshold=${tightened.threshold}`);

  // talk_value=1 = 不设限：阈值 0
  const open = gate.evaluate(0.01, 1, now);
  assert.equal(open.threshold, 0);
  assert.equal(open.shouldTrigger, true);
});

test('动态门控：强制 @ 按 0.91 占预算；40 秒虚拟轮次只计一次', () => {
  const gate = new DynamicReplyGate();
  let now = 2_000_000;
  gate.recordForcedTurn(now);
  const d = gate.evaluate(0.5, 0.5, now);
  assert.ok(Math.abs(d.expectedReplies - 0.91) < 1e-9);
  // 还没有主动评分时，保留比例直接取 talk_value
  assert.equal(d.keepRatio, 0.5);

  // 再记一轮主动评分：强制已占 0.91，前馈为负 → 保留比例归零，阈值 1
  gate.recordProactiveDemand(0.5, now);
  const d2 = gate.evaluate(0.5, 0.5, now);
  assert.equal(d2.keepRatio, 0);
  assert.equal(d2.threshold, 1);

  const g2 = new DynamicReplyGate();
  g2.recordProactiveDemand(0.2, now);
  g2.recordProactiveDemand(0.6, now + 20_000);   // 同一虚拟轮次覆盖
  const s = g2.snapshot(now + 20_000);
  assert.equal(s.scores, 1);
  g2.recordProactiveDemand(0.9, now + 41_000);   // 超过 40s 开新轮
  assert.equal(g2.snapshot(now + 41_000).scores, 2);
});

test('动态门控：1 小时后窗口过期', () => {
  const gate = new DynamicReplyGate();
  const now = 3_000_000;
  gate.recordProactiveDemand(0.8, now);
  gate.recordForcedTurn(now);
  gate.recordReply(now);
  const after = gate.snapshot(now + 3_600_001);
  assert.equal(after.scores, 0);
  assert.equal(after.expectedReplies, 0);
  assert.equal(after.actualReplies, 0);
});

test('重训：两簇样本能把放行/沉默分开（夹回先验也不跑飞）', () => {
  const rows: Parameters<typeof fitWeights>[0] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ f: likelihoodFeatureVector(mkFeatures({ mentionBot: true, pendingCount: 12, recentMessageCount: 20 })), y: 1 });
    rows.push({ f: likelihoodFeatureVector(mkFeatures({ atOther: true, placeholderOnly: true, pendingCount: 1, recentMessageCount: 1 })), y: 0 });
  }
  const w = fitWeights(rows, DEFAULT_GATE_WEIGHTS);
  const hot = replyLikelihood(mkFeatures({ mentionBot: true, pendingCount: 12, recentMessageCount: 20 }), w);
  const cold = replyLikelihood(mkFeatures({ atOther: true, placeholderOnly: true, pendingCount: 1, recentMessageCount: 1 }), w);
  assert.ok(hot > 0.75, `hot=${hot}`);
  assert.ok(cold < 0.35, `cold=${cold}`);
});

// ---------------- 服务级：真 gate 真日志 ----------------

interface Harness { service: HumanlikeService; dirs: string[]; triggered: string[]; batches: import('../src/kernel/humanlike/types.ts').TriggerBatch[]; cfg: HumanlikeConfig }
function makeService(patch: (c: HumanlikeConfig) => void, modelFile?: string): Harness {
  const cfg: HumanlikeConfig = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE)) as HumanlikeConfig;
  cfg.merge = { enable: false, windowMs: 200, maxWaitMs: 1000, bufferTtlMs: 120_000 };
  patch(cfg);
  let t = 1_700_000_000_000;
  const dirs: string[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), 'parallel-gate-log-')); dirs.push(sessionDir);
  const triggered: string[] = [];
  const batches: Harness['batches'] = [];
  const service = new HumanlikeService({
    config: () => cfg,
    selfNickname: () => '大肥鱼',
    trigger: (batch) => { triggered.push(batch.reason); batches.push(batch); },
    sessionLog: new SessionLog(sessionDir, new Bus()),
    bus: new Bus(),
    errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
    now: () => { t += 1_000; return t; },
    modelFile,
  });
  return { service, dirs, triggered, batches, cfg };
}

function groupEvent(text: string, over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    id: `e-${Math.random()}`, platform: 'qq', type: 'group', chatId: '910', userId: 'u1', nickname: '小明',
    text, segments: [], files: [], isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(),
    ...over,
  } as ChatEvent;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('frequency 模式：攒够 pendingThreshold 触发；门控 wait 不累加退避', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'frequency';
    cfg.timing.pendingThreshold = 3;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('一'), { isCommand: false });
    await wait(30);
    assert.equal(h.service.snapshot({ platform: 'qq', type: 'group', chatId: '910' }).consecutiveNoAction, 0, '门控 wait 不累加退避');
    await h.service.ingest(groupEvent('二'), { isCommand: false });
    await h.service.ingest(groupEvent('三'), { isCommand: false });
    await wait(60);
    assert.ok(h.triggered.includes('frequency'), JSON.stringify(h.triggered));
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('likelihood 模式：最小批次 + 概率门控；提及能过、普通短反应留门外', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.pendingThreshold = 2;
    cfg.timing.talkValue = 0.2;
    cfg.timing.mentionedBotReply = false;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('哈哈'), { isCommand: false });
    await wait(40);
    assert.equal(h.triggered.length, 0, '单条短反应不够最小批次');

    await h.service.ingest(groupEvent('今天天气不错'), { isCommand: false });
    await h.service.ingest(groupEvent('是啊挺暖和的'), { isCommand: false });
    await wait(60);
    assert.equal(h.triggered.length, 0, '普通闲聊概率不够');

    await h.service.ingest(groupEvent('大肥鱼 你怎么看'), { isCommand: false });
    await wait(60);
    assert.ok(h.triggered.includes('likelihood'), JSON.stringify(h.triggered));
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('likelihood：talkValue=0 直接静默；@ 仍直通', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.pendingThreshold = 1;
    cfg.timing.talkValue = 0;
  });
  try {
    await h.service.ingest(groupEvent('大肥鱼 你怎么看'), { isCommand: false });
    await wait(40);
    assert.equal(h.triggered.length, 0, 'talkValue=0 不该主动开口');
    const at = h.service.ingest(groupEvent('在吗', { isAtMe: true }), { isCommand: false });
    assert.equal(at.action, 'pass', '@ 仍应直通');
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('样本按回合结果记账：开口后没回执不落 y，回执 silent 落 0，drop 不落', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.pendingThreshold = 1;
    cfg.timing.talkValue = 0.2;
    cfg.timing.mentionedBotReply = false;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('大肥鱼 你怎么看'), { isCommand: false });
    await wait(60);
    assert.ok(h.batches.length >= 1, '应触发一轮');
    const gate = h.batches[0];
    assert.ok(gate.gateId, '开口应带 gateId');
    assert.equal(h.service.gateModelSnapshot().rows, 0, '开口当下不落样本（等模型结果）');
    h.service.noteTurnOutcome(gate.chat, gate.gateId, false);
    assert.equal(h.service.gateModelSnapshot().rows, 1, '回执 silent 后落一条 y=0');

    h.batches.length = 0;
    await h.service.ingest(groupEvent('大肥鱼 这个流程怎么走'), { isCommand: false });
    await wait(60);
    const gate2 = h.batches[0];
    assert.ok(gate2?.gateId, '第二轮也应带 gateId');
    const rows = h.service.gateModelSnapshot().rows;
    h.service.dropGate(gate2!.chat, gate2!.gateId);
    assert.equal(h.service.gateModelSnapshot().rows, rows, 'drop 不落样本');
    h.service.noteSilent(gate2!.chat);
    assert.equal(h.service.snapshot(gate2!.chat).consecutiveNoAction, 1, '模型真进过轮但没说话才累加退避');
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('强制 @ 按 0.91 计入 1 小时预算', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.inevitableAtReply = true;
  });
  try {
    h.service.ingest(groupEvent('在吗', { isAtMe: true }), { isCommand: false });
    const snap = h.service.snapshot({ platform: 'qq', type: 'group', chatId: '910' }) as { dynamic?: { expectedReplies?: number; actualReplies?: number } };
    assert.ok(Math.abs((snap.dynamic?.expectedReplies ?? 0) - 0.91) < 1e-9, JSON.stringify(snap));
    h.service.noteSpoke({ platform: 'qq', type: 'group', chatId: '910' }, 1, ['在']);
    const after = h.service.snapshot({ platform: 'qq', type: 'group', chatId: '910' }) as { dynamic?: { actualReplies?: number } };
    assert.equal(after.dynamic?.actualReplies, 1, '强制轮的回复也要计入实际回复');
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('权重与样本随行落盘；旧 v1 模型文件作废', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'parallel-gate-log-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-gate-model-'));
  const modelFile = join(dataDir, 'gate-model.json');
  try {
    const cfg: HumanlikeConfig = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE)) as HumanlikeConfig;
    cfg.merge = { enable: false, windowMs: 200, maxWaitMs: 1000, bufferTtlMs: 120_000 };
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.pendingThreshold = 1;
    cfg.timing.talkValue = 1;           // 1 = 不设限，保证每条都能触发
    cfg.timing.mentionedBotReply = false;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
    let t = 1_700_000_000_000;
    let service!: HumanlikeService;
    service = new HumanlikeService({
      config: () => cfg,
      selfNickname: () => '大肥鱼',
      trigger: (b) => { if (b.gateId) service.noteTurnOutcome(b.chat, b.gateId, true); },
      sessionLog: new SessionLog(sessionDir, new Bus()),
      bus: new Bus(),
      errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
      now: () => { t += 1_000; return t; },
      modelFile,
    });

    for (let i = 0; i < 45; i++) {
      await service.ingest(groupEvent(`大肥鱼 第${i}条`), { isCommand: false });
      await wait(18);
    }
    const saved = JSON.parse(readFileSync(modelFile, 'utf-8')) as { v?: number; feature?: string; weights: { bias: number; w: number[] }; rows: { f: number[]; y: number }[] };
    assert.equal(saved.v, 2);
    assert.equal(saved.feature, 'maibot-v1');
    assert.ok(Array.isArray(saved.rows) && saved.rows.length >= 40, '样本池随行落盘');
    assert.equal(saved.weights.w.length, 8, '权重形状对得上');

    const firstSnapshot = service.gateModelSnapshot();
    const service2 = new HumanlikeService({
      config: () => cfg,
      selfNickname: () => '大肥鱼',
      trigger: () => undefined,
      sessionLog: new SessionLog(sessionDir, new Bus()),
      bus: new Bus(),
      errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
      now: () => { t += 1_000; return t; },
      modelFile,
    });
    assert.equal(service2.gateModelSnapshot().rows, saved.rows.length, '冷启动读回样本池');
    assert.equal(service2.gateModelSnapshot().bias, firstSnapshot.bias, '冷启动读回权重');

    // 旧 v1 文件不应被当成新特征权重
    const fs = await import('node:fs');
    fs.writeFileSync(modelFile, JSON.stringify({ v: 1, weights: saved.weights, rows: saved.rows }));
    const service3 = new HumanlikeService({
      config: () => cfg,
      selfNickname: () => '大肥鱼',
      trigger: () => undefined,
      sessionLog: new SessionLog(sessionDir, new Bus()),
      bus: new Bus(),
      errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
      now: () => { t += 1_000; return t; },
      modelFile,
    });
    assert.equal(service3.gateModelSnapshot().rows, 0, '旧 v1 模型文件作废');
    assert.equal(service3.gateModelSnapshot().bias, DEFAULT_GATE_WEIGHTS.bias, '回到 MaiBot 先验');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
