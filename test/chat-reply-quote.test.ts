import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockOneBot } from './helpers/mock-onebot.ts';
import { canQuoteTurn } from '../src/kernel/pipeline.ts';

// ============================================================
// 引用回查：bot 自己的出站消息也要存协议端 message_id。
// 群里最常见的形状是「引用她上一句 + 这个」；只存入站 id 的话，
// 桌面端只能看到 [回复:1179965468] 占位，引用块出不来。
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

test('引用 bot 的出站消息：出站落账带 messageId，入站回查成 replyTo 快照', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-reply-quote-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.risk.replyRatePerMin = 10_000;
  Object.assign(cfg.humanlike.outgoing, {
    typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0, typingJitterRatio: 0,
  });
  await kernel.boot();

  const mock = new MockOneBot(`ws://127.0.0.1:${cfg.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  try {
    await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, '协议端握手');

    const groupId = '9600';
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: groupId };
    // 协议端固定回包，才能知道"她刚才那条"的消息号
    mock.setReply('send_group_msg', { message_id: 424242 });
    await kernel.chat.sendText(chat, '被引用的原话');

    const out = await until(
      () => kernel.sessionLog.tail(groupId, 'group').find((e) => e.type === 'message_out' && e.text === '被引用的原话'),
      5000, '出站落账',
    );
    assert.equal((out.data as { messageId?: string }).messageId, '424242', '出站条目必须存协议端消息号');

    mock.sendGroupMessage({
      groupId: Number(groupId), userId: '10001', text: '这个',
      // reply 段在正文之前，和真实协议端一致
      extraSegments: [{ type: 'reply', data: { id: '424242' } }],
    });

    const inbound = await until(
      () => kernel.sessionLog.tail(groupId, 'group').find((e) => e.type === 'message_in' && e.text.includes('424242')),
      5000, '入站落账',
    );
    const quote = (inbound.data as { replyTo?: { userId?: string; nickname?: string; text?: string } }).replyTo;
    assert.ok(quote, '引用应该被查回成快照，而不是只留 [回复:id] 占位');
    assert.equal(quote!.text, '被引用的原话');
    assert.equal(quote!.nickname, 'parallel-test', '引用自己的消息时，昵称用 bot 自己的');
  } finally {
    mock.close();
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// 出站引用「引错消息」的根因：frequency 一轮通常合并 6～10 条，回复是对整批说的，
// 程序却把最后一条当锚点。多消息合批、汇报轮/主动轮、纯 @ 都不该挂引用。
test('出站引用只在单条实质消息的轮次挂', () => {
  const ev = (segments: any[]) => ({
    id: 'e', platform: 'qq', type: 'group', chatId: '1', userId: '2', nickname: 'n',
    senderRole: 'member', segments, text: '', isAtMe: false, isReplyToMe: false, raw: null, ts: 1,
  }) as any;
  const text = ev([{ type: 'text', data: { text: '你好' } }]);
  assert.equal(canQuoteTurn(text), true, '单条有正文的消息可以引用');
  assert.equal(canQuoteTurn(text, { batch: [text, ev([{ type: 'text', data: { text: '再来' } }])] }), false, '多消息合批不引用');
  assert.equal(canQuoteTurn(text, { report: {} }), false, '汇报轮不引用');
  assert.equal(canQuoteTurn(text, { proactive: true }), false, '主动发言轮不引用');
  assert.equal(canQuoteTurn(ev([{ type: 'at', data: { qq: '1' } }])), false, '裸 @ 不引用');
  assert.equal(canQuoteTurn(ev([{ type: 'image', data: { file: 'a.png' } }])), true, '图片消息可以引用');
});
