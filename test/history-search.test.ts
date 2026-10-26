import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import type { KernelConfig } from '../src/kernel/config.ts';

/** DEFAULT_CONFIG 整树 as const → 全 readonly；测试直接改配置时取同一对象的可变视图（纯类型层） */
type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;
type Mutable<T> = { -readonly [K in keyof T]: Widen<Mutable<T[K]>> };

/**
 * search_history 工具：她"翻旧账"的通道。
 * 只搜当前会话的 message_in/message_out 原文（gate/agent 等系统条目不参与），
 * 时间正序、limit 取最近的命中、跨会话绝不串。
 */
const GROUP = 411;
const MEMBER = 10003;
const MASTER = 9997;

let kernel: Kernel;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-histsearch-'));
  kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as Mutable<KernelConfig>;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  cfg.masterIds = [String(MASTER)];
  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
});

after(async () => {
  await kernel.shutdown();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temp 目录系统会回收 */ }
});

function tool(name: string) {
  const chatRef = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  const def = kernel.container.toolsForChat(chatRef, 'member').find((t) => t.name === name);
  assert.ok(def, `工具 ${name} 应在 chat 工具面上`);
  return def!;
}

function tctx() {
  const chat = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  return { chat, event: { userId: String(MEMBER), chatId: String(GROUP), type: 'group', platform: 'qq' }, role: 'member' } as never;
}

test('search_history：命中入站+出站原文，时间正序；系统条目不参与', async () => {
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'gate', role: 'system', text: 'gate 含关键字蓝鲸也不算消息' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '蓝鲸吃什么呀' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_out', role: 'assistant', text: '蓝鲸主要吃磷虾哦' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '今天天气不错' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '蓝鲸有多大' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_out', role: 'assistant', text: '蓝鲸是地球史上最大的动物' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'agent_start', role: 'system', text: 'agent loop 开始 蓝鲸' });

  const out = String(tool('search_history').handler({ query: '蓝鲸' }, tctx()));
  assert.match(out, /找到 4 条/);
  const lines = out.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines[0].includes('小明'), '入站条目带昵称');
  assert.ok(lines[0].includes('蓝鲸吃什么呀'));
  assert.ok(lines[1].includes('我'), '出站条目以"我"自称');
  assert.ok(lines[1].includes('蓝鲸主要吃磷虾哦'));
  assert.ok(lines[3].includes('蓝鲸是地球史上最大的动物'));
  assert.ok(!out.includes('gate 含关键字'), 'gate 条目不参与检索');
  assert.ok(!out.includes('agent loop 开始'), 'agent 条目不参与检索');
});

test('search_history：limit 取最近的命中；跨会话不串', async () => {
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '磷虾 一' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '磷虾 二' });
  kernel.sessionLog.append(String(GROUP), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '磷虾 三' });
  // 别的会话的同词消息，不得串进来
  kernel.sessionLog.append('888', 'group', { type: 'message_in', role: 'user', userId: '1', nickname: '路人', text: '磷虾 别的群' });

  const out = String(tool('search_history').handler({ query: '磷虾', limit: 2 }, tctx()));
  assert.match(out, /找到 2 条/);
  assert.ok(out.includes('磷虾 二'));
  assert.ok(out.includes('磷虾 三'));
  assert.ok(!out.includes('磷虾 一'), 'limit 截掉更早的命中');
  assert.ok(!out.includes('别的群'), '其他会话的消息绝不出现');
});

test('search_history：空关键词与无命中', async () => {
  assert.match(String(tool('search_history').handler({ query: '  ' }, tctx())), /关键词为空/);
  assert.match(String(tool('search_history').handler({ query: '绝对不存在的词xyz' }, tctx())), /没有相关消息|没在你们之前聊过/);
});

test('search_history：命中消息里的图片一起返回（读不动的跳过）；不收图的模型如实说看不到', async () => {
  const chatRef = { platform: 'qq' as const, type: 'group' as const, chatId: String(GROUP) };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  kernel.sandbox.write(chatRef, 'inbox/old1.png', png);
  kernel.sandbox.write(chatRef, 'inbox/old2.png', png);
  kernel.sessionLog.append(String(GROUP), 'group', {
    type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text: '看这张鲸鱼图',
    data: {
      files: [
        { name: 'old1.png', rel: 'inbox/old1.png', size: png.length },
        { name: 'gone.png', rel: 'inbox/gone.png', size: 1 },        // 文件已被清理：跳过
        { name: 'old2.png', rel: 'inbox/old2.png', size: png.length },
      ],
    },
  } as never);

  const r = await Promise.resolve(tool('search_history').handler({ query: '鲸鱼图' }, tctx()) as any);
  assert.equal(typeof r, 'object', '带图时要返回带附件的对象');
  assert.equal(r.images?.length, 2, '存在的两张都带上，已清理的那张跳过');
  assert.equal(r.images[0].mimeType, 'image/png');
  assert.equal(r.images[0].data, png.toString('base64'), 'base64 原样回传');
  assert.match(r.content, /这条带了 2 张图，图片附在本结果里/);

  // 链首模型不收图：不塞附件，但也不能骗它说看得见
  const plain = await Promise.resolve(tool('search_history').handler(
    { query: '鲸鱼图' }, { ...(tctx() as any), vision: false } as any,
  ) as any);
  assert.equal(typeof plain, 'string');
  assert.match(plain, /你看不到图片本身/);
});

test('search_history：只翻窗口之外——模型眼前就有的那几条不该还回去', async () => {
  const G = 412;
  kernel.container.setGroupState('chat', String(G), true, String(MASTER));
  const t0 = Date.now();
  const put = (text: string, ts: number) => kernel.sessionLog.append(String(G), 'group', { type: 'message_in', role: 'user', userId: '10003', nickname: '小明', text, ts } as never);
  put('上周说过张桓堉这个人', t0 - 40 * 60_000);
  put('张桓堉', t0 - 20_000);                       // 窗口内：模型本轮就看着它
  const ctx2 = { chat: { platform: 'qq', type: 'group' as const, chatId: String(G) },
    event: { userId: String(MEMBER), chatId: String(G), type: 'group', platform: 'qq', id: 'turn-win-1', ts: t0 },
    historyWindowStartTs: t0 - 5 * 60_000, role: 'member' } as never;
  const def = kernel.container.toolsForChat({ platform: 'qq', type: 'group', chatId: String(G) }, 'member').find((t) => t.name === 'search_history')!;
  const out = String(def.handler({ query: '张桓堉' }, ctx2));
  assert.match(out, /找到 1 条/, '只该还给它窗口外那一条');
  assert.ok(out.includes('上周说过张桓堉这个人'), '窗口外的旧命中要给');
  assert.ok(!out.includes('：张桓堉'), '窗口内那条（模型眼前就有）不该再还回去');
});

test('一轮之内翻旧账有预算：查满就劝它照字面回答，别再连环查', async () => {
  const G = 413;
  kernel.container.setGroupState('chat', String(G), true, String(MASTER));
  const ctx3 = { chat: { platform: 'qq', type: 'group' as const, chatId: String(G) },
    event: { userId: String(MEMBER), chatId: String(G), type: 'group', platform: 'qq', id: 'turn-quota-1', ts: Date.now() },
    role: 'member' } as never;
  const chatRef = { platform: 'qq', type: 'group' as const, chatId: String(G) };
  const hist = kernel.container.toolsForChat(chatRef, 'member').find((t) => t.name === 'search_history')!;
  const recall = kernel.container.toolsForChat(chatRef, 'member').find((t) => t.name === 'recall_facts')!;
  const outs: string[] = [];
  for (let i = 0; i < 5; i++) outs.push(String(hist.handler({ query: '不存在的词' + i }, ctx3)));
  outs.push(String(recall.handler({ query: '也不存在' }, ctx3)));
  assert.ok(!/别再查/.test(outs.slice(0, 3).join('\n')), '前 3 次（预算内）正常检索');
  assert.match(outs[3], /别再查/);
  assert.match(outs[5], /别再查/, '两个工具共用一份预算');
  // 换一轮（另一个事件 id）就该重新给预算
  const ctx4 = { ...(ctx3 as object), event: { ...((ctx3 as { event: object }).event), id: 'turn-quota-2' } } as never;
  assert.ok(!/别再查/.test(String(hist.handler({ query: '新话题' }, ctx4))), '预算按轮算，不按群累计');
});
