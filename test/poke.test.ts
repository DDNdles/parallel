import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockOneBot } from './helpers/mock-onebot.ts';

// ============================================================
// 戳一戳：昵称 → 最近说话人，send_poke 落到协议端，会话流留一条 poke
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
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-poke-'));
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
  const group = '9603';
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

test('poke：昵称解析成最近说话人，发出 send_poke 并落 poke 日志', async () => {
  const g = await boot();
  try {
    g.mock.sendGroupMessage({ groupId: Number(g.group), userId: '20001', text: '在吗', nickname: '小明' });
    await until(() => g.kernel.sessionLog.tail(g.group, 'group').some((e) => e.type === 'message_in' && e.nickname === '小明'),
      5000, '入站消息');

    const r = await g.kernel.chat.poke(g.chat, '小明');
    assert.deepEqual(r, { userId: '20001', nickname: '小明' });
    const act = await g.mock.waitForAction('send_poke', 5000);
    assert.equal(String(act.params.group_id), g.group);
    assert.equal(String(act.params.user_id), '20001');

    const log = g.kernel.sessionLog.tail(g.group, 'group').find((e) => e.type === 'poke');
    assert.ok(log, '会话流要留一条 poke');
    assert.equal((log!.data as any)?.poke?.nickname, '小明');

    const names = g.kernel.container.toolsForChat(g.chat, 'member', 'chat').map((t) => t.name);
    assert.ok(names.includes('poke'), `chat 工具面要有 poke：${names}`);
    assert.ok(!names.includes('run_bash'), 'poke 不能把 work 工具带进 chat 面');
  } finally {
    await g.cleanup();
  }
});

test('poke：私聊省略 target = 对面；找不到昵称就说清楚', async () => {
  const g = await boot();
  try {
    const priv = { platform: 'qq' as const, type: 'private' as const, chatId: '20002' };
    await g.kernel.chat.poke(priv);
    const act = await g.mock.waitForAction('send_poke', 5000);
    assert.equal(String(act.params.user_id), '20002');

    await assert.rejects(() => g.kernel.chat.poke(g.chat, '不存在的人'), /没找到最近说话的人/);
  } finally {
    await g.cleanup();
  }
});
