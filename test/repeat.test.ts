import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RepeatWatcher, type RepeatConfig } from '../src/kernel/humanlike/repeat.ts';
import { DEFAULT_HUMANLIKE } from '../src/kernel/humanlike/types.ts';
import type { ChatEvent } from '../src/kernel/types.ts';

/** 确定性随机：永远取最小值（延迟下限 600ms） */
const rngMin = () => 0;
/** 确定性随机：延迟顶格（约 1000ms），打断能赶在发射前 */
const rngMax = () => 0.999999;

/** 造一条群消息事件 */
function msg(userId: string, text: string): ChatEvent {
  return {
    id: `ev_${userId}_${text}_${Math.random().toString(36).slice(2, 6)}`,
    platform: 'qq', type: 'group', chatId: '9527', userId, nickname: `群友${userId}`,
    senderRole: 'member', segments: [{ type: 'text', data: { text } }],
    text, isAtMe: false, isReplyToMe: false, raw: {}, ts: 1_760_000_000_000,
  } as ChatEvent;
}

interface RepeatCfg {
  enable: boolean; minPeople: number; delayMaxSec: number; cooldownMin: number; windowSec: number;
}

/** 快构造：默认 delayMaxSec=1，随机与假时钟都可注（t.value 手动推进） */
function watcher(cfgOver: Partial<RepeatCfg> = {}, random: () => number = rngMin) {
  const t = { value: 1_000_000 };
  const cfg: RepeatCfg = { ...DEFAULT_HUMANLIKE.repeat, delayMaxSec: 1, ...cfgOver };
  const sent: { chatId: string; text: string }[] = [];
  const w = new RepeatWatcher({
    config: () => cfg as RepeatConfig,
    send: async (chat, text) => { sent.push({ chatId: chat.chatId, text }); },
    onSent: (chat, text) => sent.push({ chatId: `on_${chat.chatId}`, text }),
    selfId: () => '10000',
    random,
    now: () => t.value,
  });
  return { w, sent, cfg, t };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('跟屏复读：凑满设置的人数就完整跟一遍（门槛不带浮动，设置几人就是几人）', async () => {
  const { w, sent } = watcher({ minPeople: 4 });
  // 前 3 位不同人 + 同一个人刷第二遍，都凑不够
  w.observe(msg('1', '666'));
  w.observe(msg('2', '666'));
  w.observe(msg('3', '666'));
  w.observe(msg('1', '666'));
  await sleep(900);
  assert.equal(sent.length, 0, '没到门槛不发');

  w.observe(msg('4', '666'));
  await sleep(1200);   // rngMin → 延迟 600ms，够了
  assert.equal(sent.length, 2, 'send 与 onSent 各记一笔');
  assert.equal(sent[0].text, '666');
  assert.equal(sent[1].text, '666');
  w.dispose();
});

test('跟屏复读：换话即整段作废，从新句重新数人', async () => {
  const { w, sent } = watcher();
  // 四个人说「冲」→ 达标进入等待；随后「哈哈」打断 → 全部作废。
  // 新段从「哈哈」起，只有 2 位群友，凑不够门槛
  w.observe(msg('1', '冲'));
  w.observe(msg('2', '冲'));
  w.observe(msg('3', '冲'));
  w.observe(msg('4', '冲'));
  w.observe(msg('5', '哈哈'));
  w.observe(msg('6', '哈哈'));
  await sleep(1200);
  assert.equal(sent.length, 0, '被岔开话的那段不作数');
  w.dispose();
});

test('跟屏复读：等待期内有人岔开话就不发了', async () => {
  const { w, sent } = watcher({ delayMaxSec: 1 }, rngMax);
  for (const u of ['1', '2', '3', '4']) w.observe(msg(u, '干得漂亮'));
  // 已达标进入等待（延迟顶格 ~1000ms），随即有人岔开
  w.observe(msg('5', '在吗'));
  await sleep(1400);
  assert.ok(!sent.some((s) => s.text === '干得漂亮'), '打断后整段作废');
  w.dispose();
});

test('跟屏复读：段有时间窗——窗外的同文算新一段，隔了老半天的同句不续旧账', async () => {
  // 旧实现没有窗：第 1、2 位与第 3 位隔了 200 秒也算同一段，会误触发
  const { w, sent, t } = watcher({ minPeople: 3, windowSec: 120 });
  w.observe(msg('1', '草'));
  t.value += 10_000;
  w.observe(msg('2', '草'));
  t.value += 200_000;   // 距段内上一条 200s > 120s 窗口
  w.observe(msg('3', '草'));
  await sleep(900);
  assert.equal(sent.length, 0, '窗口外的同文要重新攒');
  w.dispose();
});

test('跟屏复读：发射后段终——冷却过了再凑齐，同一句话能再次触发', async () => {
  // 旧实现 fired 挂在段上：只要没人说句不同的，这句话永远不再触发
  const { w, sent, t } = watcher({ minPeople: 2, cooldownMin: 0 });
  w.observe(msg('1', '草'));
  w.observe(msg('2', '草'));
  await sleep(900);
  assert.equal(sent.length, 2);
  t.value += 10_000;
  w.observe(msg('3', '草'));
  w.observe(msg('4', '草'));
  await sleep(900);
  assert.equal(sent.length, 4, '第二波同文重新攒一段并再次触发');
  w.dispose();
});

test('跟屏复读：冷却期内攒满——推迟到冷却结束后补发，而不是直接丢', async () => {
  const { w, sent, t } = watcher({ minPeople: 2, cooldownMin: 0.05 });   // 3 秒冷却
  w.observe(msg('1', '冲'));
  w.observe(msg('2', '冲'));
  await sleep(900);
  assert.equal(sent.length, 2, '第一波正常发出');
  t.value += 1_000;            // 假时钟仍在冷却内（还剩 ~2s）
  w.observe(msg('3', '撤退'));
  w.observe(msg('4', '撤退'));
  await sleep(900);            // 600ms 随机延迟覆盖不了剩余冷却 → 还不该发
  assert.ok(!sent.some((s) => s.text === '撤退'), '冷却期内不能发射');
  await sleep(1_800);          // 推迟后的定时器（~2s）到点
  assert.ok(sent.some((s) => s.text === '撤退'), '冷却一过补发，不能丢');
  w.dispose();
});

test('跟屏复读：冷却期内不立刻跟新一段（推迟未到点前保持安静）', async () => {
  const { w, sent } = watcher();   // 默认冷却 3 分钟
  for (const u of ['1', '2', '3', '4', '5']) w.observe(msg(u, '开团'));
  await sleep(1100);
  assert.ok(sent.length >= 2, '第一次发出去');

  for (const u of ['6', '7', '8', '9']) w.observe(msg(u, '撤退'));
  await sleep(1100);
  assert.ok(!sent.some((s) => s.text === '撤退'), '冷却期内不跟');
  w.dispose();   // 推迟中的定时器一并清掉
});

test('跟屏复读：bot 自己的话与桌面注入不参与，私聊与空文本旁路', async () => {
  const { w, sent } = watcher({ minPeople: 2 });
  const self = msg('10000', '抄');
  w.observe(self);
  const injected = msg('9', '抄');
  (injected.raw as Record<string, unknown>).injected = true;
  w.observe(injected);
  const priv = { ...msg('9', '抄'), type: 'private' as const } as ChatEvent;
  w.observe(priv);
  w.observe(msg('8', '   '));
  w.observe(msg('9', '抄'));
  await sleep(900);
  assert.ok(!sent.some((s) => s.text === '抄'), '复读自己/注入/私聊/空文本都不算');
  w.dispose();
});

test('跟屏复读：关闭开关后彻底安静', async () => {
  const off = watcher({ enable: false });
  for (const u of ['1', '2', '3', '4', '5', '6', '7']) off.w.observe(msg(u, '同'));
  await sleep(1300);
  assert.equal(off.sent.length, 0, '关了开关不跟');
  off.w.dispose();
});
