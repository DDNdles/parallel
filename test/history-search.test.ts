import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';

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
  kernel.config.config.onebot.port = 30000 + (process.pid % 20000);
  kernel.config.config.masterIds = [String(MASTER)];
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
  assert.match(String(tool('search_history').handler({ query: '绝对不存在的词xyz' }, tctx())), /没有找到/);
});
