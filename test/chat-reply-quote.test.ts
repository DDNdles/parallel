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
    // 等 selfId 就位再发：@ 判断靠它，登录回包还没处理完就发会被当成普通消息（frequency 门控会攒着不动）
    await until(() => (kernel.adapter as any).status?.()?.selfId, 5000, '协议端登录');

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
      groupId: Number(groupId), userId: 10001, text: '这个',
      // reply 段在正文之前，和真实协议端一致
      extraSegments: [{ type: 'reply', data: { id: '424242' } }],
    });

    const inbound = await until(
      () => kernel.sessionLog.tail(groupId, 'group').find((e) => e.type === 'message_in' && (e.text ?? '').includes('424242')),
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

test('引用回查：内存尾之外的旧消息按消息号回磁盘找回来', async () => {
  const { SessionLog } = await import('../src/kernel/sessionlog.ts');
  const { Bus } = await import('../src/kernel/bus.ts');
  const d = mkdtempSync(join(tmpdir(), 'parallel-reply-deep-'));
  try {
    const first = new SessionLog(d, new Bus());
    first.append('g9', 'group', {
      type: 'message_in', role: 'user', userId: '1', nickname: 'A', text: '[图片]',
      data: { messageId: '9001', files: [{ name: 'old.png', rel: 'inbox/old.png', sandboxPath: 'x', size: 1 }] },
    } as any);
    // 往后灌 340 条，把那条挤出内存尾（tailSize=300）
    for (let i = 0; i < 340; i++) {
      first.append('g9', 'group', { type: 'gate', role: 'system', text: `g${i}`, data: {} } as any);
    }
    const second = new SessionLog(d, new Bus());   // 新实例：内存里只有最后 300 条
    const inMem = second.tail('g9', 'group', Number.MAX_SAFE_INTEGER);
    assert.ok(!inMem.some((e) => (e.data as any)?.messageId === '9001'), '老消息不该在内存尾里');

    const hit = second.findByMessageId('g9', 'group', '9001');
    assert.ok(hit, '内存尾查不到时要回磁盘里找回来');
    assert.equal(hit!.text, '[图片]');
    assert.equal((hit!.data as any).files[0].rel, 'inbox/old.png', '被引用消息的文件清单要一起带回来');
    assert.equal(second.findByMessageId('g9', 'group', '不存在'), null, '真没有就返回 null');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('引用一张图：那张图作为附件进本轮请求，模型真的看得见', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-reply-img-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true, inputTypes: ['text', 'image'] }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.risk.replyRatePerMin = 10_000;
  cfg.masterIds = ['10008'];
  Object.assign(cfg.humanlike.outgoing, {
    typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0, typingJitterRatio: 0,
  });
  await kernel.boot();
  const groupId = '9601';
  const chat = { platform: 'qq' as const, type: 'group' as const, chatId: groupId };
  kernel.container.setGroupState('chat', groupId, true, '10008');
  const mock = new MockOneBot(`ws://127.0.0.1:${cfg.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  try {
    // 等 selfId 就位再发：@ 的判定靠它，登录回包还没处理完就发，这条会被当成普通消息攒进 frequency 门控
    await until(() => String((kernel.adapter as any).status?.()?.selfId ?? ''), 5000, '协议端登录');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    kernel.sandbox.write(chat, 'inbox/q.png', png);
    // 旧的那条图片消息（引用回查靠协议端消息号对上）
    kernel.sessionLog.append(groupId, 'group', {
      type: 'message_in', role: 'user', userId: '10008', nickname: '小明', text: '[图片]',
      data: { messageId: '777001', files: [{ name: 'q.png', rel: 'inbox/q.png', size: png.length }] },
    } as any);

    const provider = (kernel.llm as any).providers.get('mock');
    mock.sendGroupMessage({
      groupId: Number(groupId), userId: 10008, text: '这张图里是什么', atMe: true,
      extraSegments: [{ type: 'reply', data: { id: '777001' } }],
    });
    const call = await until(
      () => provider.calls.find((c: any) => String(c.usersJoined ?? '').includes('这张图里是什么')),
      8000, '本轮请求',
    );
    assert.ok((call.media ?? []).includes('image'), `被引用的图要作为附件附上：${JSON.stringify(call.media)}`);
    assert.ok(String(call.usersJoined).includes('引用'), `引用块要保留：${call.usersJoined}`);
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
