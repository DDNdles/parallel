import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockOneBot } from './helpers/mock-onebot.ts';

// ============================================================
// 贴表情（react）：表情名 → face 编号，贴到目标消息下面（set_msg_emoji_like），
// 目标消息由程序定位（模型看不到消息号），会话流留一条 reaction
// ============================================================

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${what} 超时`);
}

async function boot() {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-react-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  await kernel.boot();
  const group = '9703';
  kernel.container.setGroupState('chat', group, true, 'owner');
  const mock = new MockOneBot(`ws://127.0.0.1:${cfg.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, '协议端握手');
  return {
    kernel, mock, group,
    chat: { platform: 'qq' as const, type: 'group' as const, chatId: group },
    cleanup: async () => { mock.close(); await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('react：表情名解析成 face 编号，贴到指定人最近一条消息下面', async () => {
  const g = await boot();
  try {
    g.mock.sendGroupMessage({ groupId: Number(g.group), userId: 20001, text: '在吗', nickname: '小明', messageId: 778801 });
    await until(() => g.kernel.sessionLog.tail(g.group, 'group').some((e) => e.type === 'message_in' && e.nickname === '小明'),
      5000, '入站消息');

    const r = await g.kernel.chat.react(g.chat, '微笑', '小明');
    assert.equal(r.messageId, '778801', '贴的是这个人最近一条消息的消息号');
    assert.equal(r.emojiId, '14', '微笑 → face 编号 14');
    assert.equal(r.emojiName, '微笑');
    assert.equal(r.userId, '20001');

    const act = await g.mock.waitForAction('set_msg_emoji_like', 5000);
    assert.equal(String(act.params.message_id), '778801');
    assert.equal(String(act.params.emoji_id), '14');
    assert.equal(act.params.set, true);

    const log = g.kernel.sessionLog.tail(g.group, 'group').find((e) => e.type === 'reaction');
    assert.ok(log, '会话流要留一条 reaction');
    assert.equal((log!.data as any)?.reaction?.emojiId, '14');
    assert.equal((log!.data as any)?.reaction?.nickname, '小明');

    const names = g.kernel.container.toolsForChat(g.chat, 'member', 'chat').map((t) => t.name);
    assert.ok(names.includes('react'), `chat 工具面要有 react：${names}`);
    assert.ok(!names.includes('run_bash'), 'react 不能把 work 工具带进 chat 面');
  } finally {
    await g.cleanup();
  }
});

test('react：省略 target 贴对面刚说的那条；编号/别名也认', async () => {
  const g = await boot();
  try {
    g.mock.sendGroupMessage({ groupId: Number(g.group), userId: 20002, text: '哈哈哈', nickname: '小红', messageId: 778802 });
    await until(() => g.kernel.sessionLog.tail(g.group, 'group').some((e) => e.type === 'message_in' && e.nickname === '小红'),
      5000, '入站消息');

    await g.kernel.chat.react(g.chat, '76'); // 赞
    const act = await g.mock.waitForAction('set_msg_emoji_like', 5000);
    assert.equal(String(act.params.message_id), '778802');
    assert.equal(String(act.params.emoji_id), '76');

    await g.kernel.chat.react(g.chat, '哭'); // 别名 → 9（大哭）
    const acts = g.mock.actions.filter((a) => a.action === 'set_msg_emoji_like');
    assert.equal(String(acts[acts.length - 1].params.emoji_id), '9');
  } finally {
    await g.cleanup();
  }
});

test('react：私聊不支持、认不出的表情说清楚、没有消息可贴时说清楚', async () => {
  const g = await boot();
  try {
    const priv = { platform: 'qq' as const, type: 'private' as const, chatId: '20003' };
    await assert.rejects(() => g.kernel.chat.react(priv, '微笑'), /只支持群聊/);

    await assert.rejects(() => g.kernel.chat.react(g.chat, '没有这个表情'), /认不出这个表情/);

    // 群里还没有任何入站消息：无从定位
    await assert.rejects(() => g.kernel.chat.react(g.chat, '微笑'), /还没有能贴表情的消息/);
  } finally {
    await g.cleanup();
  }
});
