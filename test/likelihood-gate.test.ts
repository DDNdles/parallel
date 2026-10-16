import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GATE_WEIGHTS, GATE_THRESHOLD_MAX, GATE_THRESHOLD_MIN,
  fitWeights, nextGateThreshold, replyLikelihood,
  type GateFeatures,
} from '../src/kernel/humanlike/likelihood.ts';
import { HumanlikeService } from '../src/kernel/humanlike/service.ts';
import { SessionLog } from '../src/kernel/sessionlog.ts';
import { Bus } from '../src/kernel/bus.ts';
import { DEFAULT_HUMANLIKE, type HumanlikeConfig } from '../src/kernel/humanlike/types.ts';
import type { ChatEvent } from '../src/kernel/types.ts';

/**
 * 开口侧 2026-10-16 换的路线：旧 80 分启发式（MaiBot 已退役）降级为特征，
 * 开不开口由「拟合概率 × 每会话动态阈值」决定。
 * 三层分开钉：概率先验的排序 / 重训确实把两簇样本分开 / 动态阈值的收放与边界；
 * 再来一发服务级猴子测试：真 gate 真日志真落盘。
 */

const mkFeatures = (over: Partial<GateFeatures> = {}): GateFeatures => ({
  relevance: 0, content: 0, pressure: 0, presence: 0, comp: 0, freq: 1, pending: 1, idleRatio: 0,
  ...over,
});

test('概率先验：@/大积压/空窗达成 明显高过普通短反应', () => {
  const hot = replyLikelihood(mkFeatures({ relevance: 100, content: 20, pressure: 60, comp: 1, pending: 12, idleRatio: 1 }), DEFAULT_GATE_WEIGHTS);
  const plain = replyLikelihood(mkFeatures({ presence: 8, pending: 2 }), DEFAULT_GATE_WEIGHTS);
  assert.ok(hot > plain, `hot=${hot} plain=${plain}`);
  // 单条「哈哈」这类：压力与内容都起不来，不该靠近 0.5 的默认门槛
  assert.ok(replyLikelihood(mkFeatures({ presence: 8, pending: 1 }), DEFAULT_GATE_WEIGHTS) < 0.45);
});

test('重训：两簇合成样本能把放行/沉默分开（夹回先验也不跑飞）', () => {
  const rows: Parameters<typeof fitWeights>[0] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ f: [1, 0.35 + (i % 3) * 0.05, 0.6 + (i % 5) * 0.04, 0, 1, 1, 0.4, 0.4], y: 1 });
    rows.push({ f: [0, 0.01 + (i % 3) * 0.01, 0.02, 0.5, 0, 0.9, 0.05, 0], y: 0 });
  }
  const w = fitWeights(rows, DEFAULT_GATE_WEIGHTS);
  const hot = replyLikelihood(mkFeatures({ relevance: 100, content: 18, pressure: 62, comp: 1, pending: 12, idleRatio: 0.4 }), w);
  const cold = replyLikelihood(mkFeatures({ presence: 12, pending: 1 }), w);
  assert.ok(hot > 0.75, `hot=${hot}`);
  assert.ok(cold < 0.35, `cold=${cold}`);
});

test('动态阈值：连续沉默就下调且不破底；开口过头才上调且不上顶；动静不大时不动', () => {
  assert.ok(nextGateThreshold(0.5, { evaluations: 6, spoke: 0 }).next < 0.5);
  assert.ok(nextGateThreshold(0.76, { evaluations: 5, spoke: 4 }).next > 0.76);
  assert.equal(nextGateThreshold(GATE_THRESHOLD_MIN, { evaluations: 9, spoke: 0 }).next, GATE_THRESHOLD_MIN, '不破底');
  assert.ok(nextGateThreshold(GATE_THRESHOLD_MAX, { evaluations: 5, spoke: 4 }).next <= GATE_THRESHOLD_MAX, '不上顶');
  assert.equal(nextGateThreshold(0.5, { evaluations: 2, spoke: 1 }).next, 0.5);
});

// ---------------- 服务级：likelihood 模式真的驱动 gate ----------------

interface Harness { service: HumanlikeService; dirs: string[]; triggered: string[] }
function makeService(patch: (c: HumanlikeConfig) => void, modelFile?: string): Harness {
  const cfg: HumanlikeConfig = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE)) as HumanlikeConfig;
  cfg.merge = { enable: false, windowMs: 200, maxWaitMs: 1000, bufferTtlMs: 120_000 };
  patch(cfg);
  let t = 1_700_000_000_000;
  const dirs: string[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), 'parallel-gate-log-')); dirs.push(sessionDir);
  const service = new HumanlikeService({
    config: () => cfg,
    selfNickname: () => '大肥鱼',
    trigger: (batch) => { triggered.push(batch.reason); },
    sessionLog: new SessionLog(sessionDir, new Bus()),
    bus: new Bus(),
    errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
    now: () => { t += 1_000; return t; },
    modelFile,
  });
  const triggered: string[] = [];
  return { service, dirs, triggered };
}

function groupEvent(text: string): ChatEvent {
  return {
    platform: 'qq', type: 'group', chatId: '910', userId: 'u1', nickname: '小明',
    text, segments: [], files: [], isAtMe: false, isReplyToMe: false, raw: {}, ts: Date.now(),
  } as ChatEvent;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('likelihood 模式：短反应留在门外；攒出积压与内容分就开口（reason=likelihood）', async () => {
  const triggered: string[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), 'parallel-gate-log-'));
  try {
    const cfg: HumanlikeConfig = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE)) as HumanlikeConfig;
    cfg.merge = { enable: false, windowMs: 200, maxWaitMs: 1000, bufferTtlMs: 120_000 };
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.pendingThreshold = 3;      // 让积压压力分在 3 条内就能起来（压力单位 = 阈值）
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
    let t = 1_700_000_000_000;
    const service = new HumanlikeService({
      config: () => cfg,
      selfNickname: () => '大肥鱼',
      trigger: (batch) => { triggered.push(batch.reason); },
      sessionLog: new SessionLog(sessionDir, new Bus()),
      bus: new Bus(),
      errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
      now: () => { t += 1_000; return t; },
    });

    await wait(20);
    await service.ingest(groupEvent('哈哈'), { isCommand: false });
    await wait(40);
    assert.equal(triggered.length, 0, '单条短反应不该开口');

    await service.ingest(groupEvent('地下停车位到底该怎么租啊！昨晚物业还贴条了'), { isCommand: false });
    await wait(40);
    await service.ingest(groupEvent('能不能说说流程啊，我头一次搞这个'), { isCommand: false });
    await wait(60);
    assert.ok(triggered.includes('likelihood'), JSON.stringify(triggered));
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('likelihood 权重与样本随行落盘；第二个实例冷启动接着学', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'parallel-gate-log-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-gate-model-'));
  const modelFile = join(dataDir, 'gate-model.json');
  try {
    const cfg: HumanlikeConfig = JSON.parse(JSON.stringify(DEFAULT_HUMANLIKE)) as HumanlikeConfig;
    cfg.merge = { enable: false, windowMs: 200, maxWaitMs: 1000, bufferTtlMs: 120_000 };
    cfg.timing.replyTriggerMode = 'likelihood';
    cfg.timing.pendingThreshold = 3;
    cfg.backoff = { baseSeconds: 0, capSeconds: 0, startCount: 2, bypassPendingCount: 6 };
    let t = 1_700_000_000_000;
    const service = new HumanlikeService({
      config: () => cfg,
      selfNickname: () => '大肥鱼',
      trigger: () => undefined,
      sessionLog: new SessionLog(sessionDir, new Bus()),
      bus: new Bus(),
      errors: {} as unknown as import('../src/kernel/errors.ts').ErrorCenter,
      now: () => { t += 1_000; return t; },
      modelFile,
    });

    // 攒 45 条样本（阈值会在中途降到下界然后开始说，闭环全部走一遍），
    // 45 > 40：至少触发一次「定期存样本池」
    for (let i = 0; i < 45; i++) {
      await service.ingest(groupEvent('哈哈'), { isCommand: false });
      await wait(25);
    }
    const saved = JSON.parse(readFileSync(modelFile, 'utf-8')) as { weights: { bias: number; w: number[] }; rows: { f: number[]; y: number }[] };
    assert.ok(Array.isArray(saved.rows) && saved.rows.length >= 40, '样本池随行落盘');
    assert.ok(Number.isFinite(saved.weights?.bias) && saved.weights.w.length === 8, '权重形状对得上');

    // 第二个实例从盘上读回：快照里的权重与样本数要跟前一个实例一致
    const savedRows = saved.rows.length;
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
    const snap2 = service2.gateModelSnapshot();
    assert.equal(snap2.rows, savedRows, '冷启动读回样本池');
    assert.equal(snap2.bias, firstSnapshot.bias, '冷启动读回权重');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
