import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GATE_WEIGHTS,
  DynamicReplyGate,
  MAIBOT_RAW_WEIGHTS,
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
 * likelihood = MaiBot dynamic 原样：
 *  8 个会话结构特征 + 固定权重 + 1 小时预算/分位阈值；@/提及强制按 0.91 占预算。
 * 不再有最小批次、不再在线重训；frequency 的门槛是 ceil(1/talk_value)。
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
  assert.equal(DEFAULT_GATE_WEIGHTS.w[5], MAIBOT_RAW_WEIGHTS.recentMessageCount * 50);
  assert.equal(DEFAULT_GATE_WEIGHTS.w[6], MAIBOT_RAW_WEIGHTS.logSecondsSinceBotMessage * 5);
  assert.equal(DEFAULT_GATE_WEIGHTS.w[7], MAIBOT_RAW_WEIGHTS.pendingCount * 20);
  assert.deepEqual(likelihoodFeatureVector(mkFeatures({ pendingCount: 21 })), [0, 0, 0, 0, 0, 0.04, Math.log1p(3600) / 5, 1]);
});

test('概率先验：提及/积压高，@别人/纯媒体低', () => {
  const plain = replyLikelihood(mkFeatures(), DEFAULT_GATE_WEIGHTS);
  const mention = replyLikelihood(mkFeatures({ mentionBot: true }), DEFAULT_GATE_WEIGHTS);
  const pending = replyLikelihood(mkFeatures({ pendingCount: 20, recentMessageCount: 30 }), DEFAULT_GATE_WEIGHTS);
  const atOther = replyLikelihood(mkFeatures({ atOther: true }), DEFAULT_GATE_WEIGHTS);
  const media = replyLikelihood(mkFeatures({ placeholderOnly: true }), DEFAULT_GATE_WEIGHTS);
  assert.ok(mention > plain, `mention=${mention} plain=${plain}`);
  assert.ok(pending > plain, `pending=${pending} plain=${plain}`);
  assert.ok(atOther < plain, `atOther=${atOther} plain=${plain}`);
  assert.ok(media < plain, `media=${media} plain=${plain}`);
});

test('静态阈值表：与 MaiBot 原表一致，并在区间内线性插值', () => {
  assert.equal(staticThreshold(0), 1);
  assert.equal(staticThreshold(1), 0);
  assert.equal(staticThreshold(0.5), 0.336);
  assert.ok(Math.abs(staticThreshold(0.25) - 0.456) < 1e-9);
});

test('动态门控：talk_value 决定保留比例；实际回复过多会收紧', () => {
  const gate = new DynamicReplyGate();
  const now = 1_000_000;
  gate.recordProactiveDemand(1, now);
  const half = gate.evaluate(0.5, 0.5, now);
  assert.equal(half.keepRatio, 0.5);
  assert.ok(Math.abs(half.threshold - 0.336) < 1e-9);
  assert.equal(half.shouldTrigger, true);

  gate.recordReply(now);
  const tightened = gate.evaluate(0.5, 0.5, now);
  assert.ok(tightened.keepRatio < 0.5, `keep=${tightened.keepRatio}`);
  assert.ok(tightened.threshold > 0.336, `threshold=${tightened.threshold}`);

  const open = gate.evaluate(0.01, 1, now);
  assert.equal(open.threshold, 0);
  assert.equal(open.shouldTrigger, true);
});

test('动态门控：强制 @ 按 0.91 占预算；40 秒虚拟轮次只计一次', () => {
  const gate = new DynamicReplyGate();
  const now = 2_000_000;
  gate.recordForcedTurn(now);
  const d = gate.evaluate(0.5, 0.5, now);
  assert.ok(Math.abs(d.expectedReplies - 0.91) < 1e-9);
  assert.equal(d.keepRatio, 0.5);

  gate.recordProactiveDemand(0.5, now);
  const d2 = gate.evaluate(0.5, 0.5, now);
  assert.equal(d2.keepRatio, 0);
  assert.equal(d2.threshold, 1);

  const g2 = new DynamicReplyGate();
  g2.recordProactiveDemand(0.2, now);
  g2.recordProactiveDemand(0.6, now + 20_000);
  assert.equal(g2.snapshot(now + 20_000).scores, 1);
  g2.recordProactiveDemand(0.9, now + 41_000);
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

// ---------------- 服务级 ----------------

interface Harness {
  service: HumanlikeService;
  dirs: string[];
  triggered: string[];
  batches: import('../src/kernel/humanlike/types.ts').TriggerBatch[];
  cfg: HumanlikeConfig;
  log: SessionLog;
}
function makeService(patch: (c: HumanlikeConfig) => void): Harness {
  const cfg: HumanlikeConfig = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE)) as HumanlikeConfig;
  cfg.merge = { enable: false, windowMs: 200, maxWaitMs: 1000, bufferTtlMs: 120_000 };
  patch(cfg);
  let t = 1_700_000_000_000;
  const dirs: string[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), 'parallel-gate-log-')); dirs.push(sessionDir);
  const triggered: string[] = [];
  const batches: Harness['batches'] = [];
  const log = new SessionLog(sessionDir, new Bus());
  const service = new HumanlikeService({
    config: () => cfg,
    selfNickname: () => '大肥鱼',
    trigger: (batch) => { triggered.push(batch.reason); batches.push(batch); },
    sessionLog: log,
    bus: new Bus(),
    errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
    now: () => { t += 1_000; return t; },
  });
  return { service, dirs, triggered, batches, cfg, log };
}

function groupEvent(text: string, over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    id: `e-${Math.random()}`, platform: 'qq', type: 'group', chatId: '910', userId: 'u1', nickname: '小明',
    text, segments: [], files: [], isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(),
    ...over,
  } as ChatEvent;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('frequency：门槛 = ceil(1/talkValue)；攒够才触发，门控 wait 不累加退避', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'frequency';
    cfg.timing.talkValue = 0.34;          // ceil(1/0.34) = 3
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('一'), { isCommand: false });
    await wait(30);
    assert.equal(h.service.snapshot({ platform: 'qq', type: 'group', chatId: '910' }).consecutiveNoAction, 0, '门控 wait 不累加退避');
    await h.service.ingest(groupEvent('二'), { isCommand: false });
    await wait(30);
    assert.equal(h.triggered.length, 0, '两条还不够');
    await h.service.ingest(groupEvent('三'), { isCommand: false });
    await wait(60);
    assert.ok(h.triggered.includes('frequency'), JSON.stringify(h.triggered));
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('likelihood：talkValue=1 单条也能触发（没有最小批次，和 MaiBot 一样）', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.talkValue = 1;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('今天天气不错'), { isCommand: false });
    await wait(60);
    assert.ok(h.triggered.includes('likelihood'), JSON.stringify(h.triggered));
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('likelihood：talkValue 低时普通闲聊不过、提及能过', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.talkValue = 0.2;
    cfg.timing.mentionedBotReply = false;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('今天天气不错'), { isCommand: false });
    await wait(50);
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

test('回执：gateId 存在；noteTurnOutcome 只记日志；dropGate 不再回执', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.talkValue = 1;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
  });
  try {
    await h.service.ingest(groupEvent('大肥鱼 你怎么看'), { isCommand: false });
    await wait(60);
    const gate = h.batches[0];
    assert.ok(gate?.gateId, '开口应带 gateId');
    h.service.noteTurnOutcome(gate.chat, gate.gateId, false);
    const tail = h.log.tail('910', 'group', 20);
    assert.ok(tail.some((e) => (e.data as { decision?: string } | undefined)?.decision === 'turn_outcome'), JSON.stringify(tail));
    h.service.noteSilent(gate.chat);
    assert.equal(h.service.snapshot(gate.chat).consecutiveNoAction, 1, '模型真进过轮但没说话才累加退避');

    h.batches.length = 0;
    await h.service.ingest(groupEvent('大肥鱼 第2条'), { isCommand: false });
    await wait(60);
    const gate2 = h.batches[0];
    assert.ok(gate2?.gateId);
    h.service.dropGate(gate2!.chat, gate2!.gateId);
    h.service.noteTurnOutcome(gate2!.chat, gate2!.gateId, true);
    const count = h.log.tail('910', 'group', 40)
      .filter((e) => (e.data as { gateId?: string } | undefined)?.gateId === gate2!.gateId
        && (e.data as { decision?: string } | undefined)?.decision === 'turn_outcome').length;
    assert.equal(count, 0, 'drop 后不再回执');
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('强制 @ 按 0.91 计入 1 小时预算；真正发出去才算 actual reply', async () => {
  const h = makeService((cfg) => {
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.inevitableAtReply = true;
  });
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '910' };
    h.service.ingest(groupEvent('在吗', { isAtMe: true }), { isCommand: false });
    const snap = h.service.snapshot(chat) as { dynamic?: { expectedReplies?: number; actualReplies?: number } };
    assert.ok(Math.abs((snap.dynamic?.expectedReplies ?? 0) - 0.91) < 1e-9, JSON.stringify(snap));
    h.service.noteSpoke(chat, 1, ['在']);
    const after = h.service.snapshot(chat) as { dynamic?: { actualReplies?: number } };
    assert.equal(after.dynamic?.actualReplies, 1, '强制轮的回复也要计入实际回复');
  } finally {
    h.service.dispose();
    for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
  }
});
