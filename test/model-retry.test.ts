import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// 模型瞬态中断重试（2026-10-25）：Gemini 偶发 MALFORMED_FUNCTION_CALL
// 把整轮转成 stopReason='error' 的空 assistant、群里沉默——agentloop
// 识别后摘掉失败消息重跑一次（最多一次），再失败才按原路处理。
// ============================================================

async function boot(port: number) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-retry-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = port;
  (cfg.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.masterIds = ['10001'];
  await kernel.boot();
  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  return {
    kernel, dataDir, mock,
    cleanup: async () => {
      await kernel.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('chat 轮模型瞬态中断：摘掉失败消息重跑一次，回复正常送达', async () => {
  const g = await boot(33000 + (process.pid % 8000));
  try {
    // ui 平台：发送不走协议端（ChatService 只落日志与 chat.out），测试里没有 MockOneBot
    const chat = { platform: 'ui' as const, type: 'group' as const, chatId: '9501' };
    g.mock.script.push({ error: 'Provider stopped with: MALFORMED_FUNCTION_CALL' });
    g.mock.script.push({ content: '算好了，是 1024。' });
    const outs: any[] = [];
    const off = g.kernel.bus.on('chat.out' as any, (p: any) => outs.push(p));
    try {
      g.kernel.pipeline.submit({
        id: 'retry-ev-1', platform: chat.platform, type: chat.type, chatId: chat.chatId,
        userId: '10001', nickname: '主人', senderRole: 'owner',
        segments: [{ type: 'text', data: { text: '算一下 2 的 10 次方' } }], text: '算一下 2 的 10 次方',
        isAtMe: true, isReplyToMe: false, raw: { injected: true }, ts: Date.now(),
      } as any);
      await new Promise((r) => setTimeout(r, 4000));
    } finally { off(); }
    assert.equal(outs.length, 1, `中断后重跑应正常回话，实际 ${outs.length} 条`);
    assert.match(String(outs[0].text ?? ''), /1024/);
    // 会话日志里有重试标注（gate 条目，排障能看到）
    const tail = g.kernel.sessionLog.tail(chat.chatId, 'group', 50);
    assert.ok(tail.some((e: any) => e.type === 'gate' && String(e.text ?? '').includes('模型瞬态中断')), '日志要有重试 gate 条目');
  } finally {
    await g.cleanup();
  }
});

test('work 轮连续两次中断：重试一次后放弃，按空回复判失败', async () => {
  const g = await boot(33000 + (process.pid % 8000) + 1);
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9502' };
    const agent = g.kernel.container.workAgent();
    const tools = g.kernel.container.workToolsFor(chat, 'owner', agent, 0);
    g.mock.script.push({ error: 'Provider stopped with: MALFORMED_FUNCTION_CALL' });
    g.mock.script.push({ error: 'Provider stopped with: MALFORMED_FUNCTION_CALL' });
    const r = await g.kernel.workRunner.run({
      chat, task: '做个东西', taskLabel: '做个东西', userId: '10001', nickname: 'n', role: 'owner',
      agent, tools, trigger: 'command', depth: 0, idleRemindMs: 50,
    });
    assert.equal(r.ok, false, '两次都中断要按失败处理');
    assert.match(r.error ?? '', /没有返回任何内容/, `失败原因要是空回复口径：${r.error}`);
  } finally {
    await g.cleanup();
  }
});
