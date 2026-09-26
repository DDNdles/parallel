import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitSegments } from '../src/kernel/services/chat.ts';
import { clamp, todayKey } from '../src/kernel/util/misc.ts';
import { RateLimiter, SlidingWindowCounter } from '../src/kernel/ratelimit.ts';
import { atomicWriteJson, readJson } from '../src/kernel/util/fsutil.ts';
import { Scheduler } from '../src/kernel/scheduler.ts';
import { Bus } from '../src/kernel/bus.ts';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------- 消息分段 ----------------

test('splitSegments: 长文本按上限切分', () => {
  const long = 'a'.repeat(4000);
  const parts = splitSegments([{ type: 'text', data: { text: long } }], 1800);
  assert.equal(parts.length, 3);
  assert.equal(parts.reduce((s, p) => s + p[0].data.text.length, 0), 4000);
});

test('splitSegments: 短文本单条、非文本段独立成条', () => {
  const parts = splitSegments([
    { type: 'text', data: { text: '你好' } },
    { type: 'image', data: { file: 'x.png' } },
    { type: 'text', data: { text: '图' } },
  ], 1800);
  assert.equal(parts.length, 3);
});

// ---------------- 工具函数 ----------------

test('clamp / todayKey', () => {
  assert.equal(clamp(120, 0, 100), 100);
  assert.equal(clamp(-5, 0, 100), 0);
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------- 限速与抖动 ----------------

test('RateLimiter: 令牌桶限速', () => {
  const rl = new RateLimiter(3);
  assert.equal(rl.tryTake('g').ok, true);
  assert.equal(rl.tryTake('g').ok, true);
  assert.equal(rl.tryTake('g').ok, true);
  const fourth = rl.tryTake('g');
  assert.equal(fourth.ok, false);
  assert.ok(fourth.waitMs > 0);
  // 不同 key 互不影响
  assert.equal(rl.tryTake('other').ok, true);
});

test('SlidingWindowCounter: 60s 窗口计数', () => {
  const c = new SlidingWindowCounter();
  c.hit('k');
  c.hit('k');
  assert.equal(c.count('k'), 2);
});

// ---------------- 配置原子落盘 ----------------

test('atomicWriteJson: 写入 + 备份轮转 + 损坏回退', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-cfg-'));
  const file = join(dir, 'config.json');
  atomicWriteJson(file, { v: 1 });
  assert.ok(existsSync(file));
  atomicWriteJson(file, { v: 2 });
  assert.ok(existsSync(file + '.bak'));
  atomicWriteJson(file, { v: 3 });
  atomicWriteJson(file, { v: 4 });
  // 主文件损坏 → 回退 .bak
  const ok = readJson<any>(file, { v: 0 });
  assert.equal(ok.v, 4);
  const bak = readFileSync(file + '.bak', 'utf-8');
  assert.ok(JSON.parse(bak).v >= 1);
});

// ---------------- 调度器：插件卸载后任务注销 ----------------

test('Scheduler: unregisterPlugin 注销任务与 interval（插件卸载不留孤儿任务）', async () => {
  const bus = new Bus();
  const s = new Scheduler(bus, () => false); // proactive 默认关
  let fired = 0;
  s.register('p-a', { id: 'tick', intervalMs: 20, handler: () => { fired++; } });
  s.register('p-b', { id: 'tick', intervalMs: 20, handler: () => { fired++; } });
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(fired >= 2, `interval 任务应已触发（fired=${fired}）`);

  s.unregisterPlugin('p-a');
  const snapshot = fired;
  await new Promise((r) => setTimeout(r, 90));
  // p-a 已停；p-b 仍在跑
  assert.equal((s as unknown as { jobs: Map<string, { pluginId: string }> }).jobs.has('p-a:tick'), false);
  assert.ok(fired >= snapshot + 1, '其他插件的任务不应被误删');
  s.unregisterPlugin('p-b');
  const snapshot2 = fired;
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(fired, snapshot2, '注销后不应再触发');
  s.dispose();
});

test('Scheduler: proactive 任务在开关关闭时不触发', async () => {
  const bus = new Bus();
  const s = new Scheduler(bus, () => false);
  let fired = 0;
  s.register('p-c', { id: 'push', intervalMs: 20, proactive: true, handler: () => { fired++; } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, 0, 'proactive 门控关闭时不应触发');
  s.dispose();
});
