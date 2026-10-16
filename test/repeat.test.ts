import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RepeatWatcher, type RepeatConfig } from '../src/kernel/humanlike/repeat.ts';
import { DEFAULT_HUMANLIKE } from '../src/kernel/humanlike/types.ts';
import type { ChatEvent } from '../src/kernel/types.ts';

/** 确定性随机：永远取最小值（延迟下限 600ms、触发条数浮动 0） */
const rngMin = () => 0;
/** 确定性随机：永远取最大值（延迟与条数都顶格） */
const rngMax = () => 0.999999;

/** 造一条群消息事件 */
function msg(userId: string, text: string): ChatEvent {
  return {
    id: `ev_${userId}_${text}`,
    platform: 'qq', type: 'group', chatId: '9527', userId, nickname: `群友${userId}`,
    senderRole: 'member', segments: [{ type: 'text', data: { text } }],
    text, isAtMe: false, isReplyToMe: false, raw: {}, ts: 1_760_000_000_000,
  } as ChatEvent;
}

interface RepeatCfg {
  enable: boolean; minPeople: number; delayMaxSec: number; cooldownMin: number;
}

/** 快构造：默认 delayMaxSec=1 / cooldownMin=3，随机注入口可钉 */
function watcher(cfgOver: Partial<RepeatCfg> = {}, random: () => number = rngMin) {
  const cfg: RepeatCfg = { ...DEFAULT_HUMANLIKE.repeat, delayMaxSec: 1, ...cfgOver };
  const sent: { chatId: string; text: string }[] = [];
  const w = new RepeatWatcher({
    config: () => cfg as RepeatConfig,
    send: async (chat, text) => sent.push({ chatId: chat.chatId, text }),
    onSent: (chat, text) => sent.push({ chatId: `on_${chat.chatId}`, text }),
    selfId: () => '10000',
    random,
  });
  return { w, sent, cfg };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('跟屏复读：达到（随机后的）触发条数才完整跟一遍', async () => {
  const { w, sent } = watcher();
  // rngMin：门槛恰好 4。前 3 位不同人 + 同一个人刷第二遍，都凑不够
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
  // rngMax：延迟顶格（约 1000ms），打断能赶在发射前
  const { w, sent } = watcher({ delayMaxSec: 1 }, rngMax);
  w.observe(msg('1', '干得漂亮'));
  w.observe(msg('2', '干得漂亮'));
  w.observe(msg('3', '干得漂亮'));
  w.observe(msg('4', '干得漂亮'));
  w.observe(msg('5', '干得漂亮'));
  w.observe(msg('6', '干得漂亮'));
  // 已达标进入等待，随即有人岔开
  w.observe(msg('7', '在吗'));
  await sleep(1400);
  assert.ok(!sent.some((s) => s.text === '干得漂亮'), '打断后整段作废');
  w.dispose();
});

test('跟屏复读：冷却期内不跟新一段，bot 自己的话与桌面注入不参与', async () => {
  const { w, sent } = watcher();
  for (const u of ['1', '2', '3', '4', '5']) w.observe(msg(u, '开团'));
  await sleep(1100);
  assert.ok(sent.length >= 2, '第一次发出去');

  // 冷却期内凑齐新的一句 → 不跟
  for (const u of ['6', '7', '8', '9']) w.observe(msg(u, '撤退'));
  await sleep(1100);
  assert.ok(!sent.some((s) => s.text === '撤退'), '冷却期内不跟');

  // bot 自己 / 桌面注入 / 私聊：不参与计数
  const self = msg('10000', '抄');
  w.observe(self);
  const injected = msg('9', '抄');
  (injected.raw as Record<string, unknown>).injected = true;
  w.observe(injected);
  const priv = { ...msg('9', '抄'), type: 'private' as const } as ChatEvent;
  w.observe(priv);
  assert.ok(!sent.some((s) => s.text === '抄'), '复读自己/注入/私聊都不算');
  w.dispose();
});

test('跟屏复读：关闭开关后彻底安静，触发条数随机浮动过门槛', async () => {
  // rngMax：浮动 = 2 → 门槛 6；同样 5 位群友不够
  const { w, sent } = watcher({ minPeople: 4 }, rngMax);
  for (const u of ['1', '2', '3', '4', '5']) w.observe(msg(u, '同'));
  await sleep(1300);
  assert.equal(sent.length, 0, '浮动到 6 的门槛，5 位不够');

  const off = watcher({ enable: false });
  for (const u of ['1', '2', '3', '4', '5', '6', '7']) off.w.observe(msg(u, '同'));
  await sleep(1300);
  assert.equal(off.sent.length, 0, '关了开关不跟');
  off.w.dispose();
  w.dispose();
});
