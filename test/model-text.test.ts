import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bus } from '../src/kernel/bus.ts';
import { SessionLog } from '../src/kernel/sessionlog.ts';
import { inboundModelText } from '../src/kernel/util/modeltext.ts';

/**
 * 「给人看的落账文本」与「给模型看的正文」是两层。
 *
 * 落账里存的是 `[回复:785187325]测试`、`[聊天记录]` 这种占位——桌面端要靠它 + data.files/data.forward
 * 画引用块和记录卡。但把这些直接喂模型就变成噪声：协议端的消息号模型解不开，
 * 而 `[聊天记录]` 只在"本轮"由 pipeline 展开过一次，**重启后回读历史就只剩这四个字**，
 * 群友递过来的那份记录等于没发过。这里钉住净化后的样子。
 */

const dir = () => mkdtempSync(join(tmpdir(), 'parallel-modeltext-'));

test('inboundModelText：引用占位换成被引用的原文', () => {
  const out = inboundModelText({
    text: '[回复:785187325]那你看着办',
    replyTo: { nickname: '小明', text: '周五团建去不去' },
  });
  assert.equal(out, '（引用「小明」：周五团建去不去）那你看着办', out);
  // 负数消息号（有头模式实测见过）与查不到原文的引用都要剥干净
  assert.equal(inboundModelText({ text: '[回复:-596684453]测试' }), '测试');
});

test('inboundModelText：聊天记录展开，取不到时留着占位', () => {
  const fwd = {
    id: 'r1', title: '', dropped: 0, failed: false,
    nodes: [
      { nickname: '小明', userId: '1', text: '周五团建去不去', ts: 0 },
      { nickname: '小红', userId: '2', text: '我去', ts: 0 },
    ],
  };
  const out = inboundModelText({ text: '大家看看这个 [聊天记录]', forward: fwd });
  assert.ok(out.includes('【聊天记录'), out);
  assert.ok(out.includes('小明：周五团建去不去') && out.includes('小红：我去'), out);
  assert.ok(!out.includes('[聊天记录]'), '占位要换成展开正文，别留两个字糊在那里');
  // failed（协议端不支持 / 记录过期）：不编内容，占位留着
  assert.equal(inboundModelText({ text: '[聊天记录]', forward: { ...fwd, failed: true } }), '[聊天记录]');
});

test('会话日志回读历史时走同一套净化（重启后那份记录仍在）', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    log.append('100', 'group', {
      type: 'message_in', role: 'user', nickname: '小明', text: '[回复:900]收一下',
      data: { replyTo: { nickname: '张三', text: '文档在共享盘' } },
    });
    log.append('100', 'group', {
      type: 'message_in', role: 'user', nickname: '小红', text: '昨天的 [聊天记录]',
      data: { forward: { id: 'r1', title: '', dropped: 0, failed: false, nodes: [{ nickname: '甲', userId: '1', text: '定了', ts: 0 }] } },
    });
    log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '收到' });

    const p = log.project('100', 'group');
    assert.deepEqual(p.messages, [
      { role: 'user', content: '（引用「张三」：文档在共享盘）收一下' },
      { role: 'user', content: '昨天的\n【聊天记录·共 1 条】\n甲：定了' },
      { role: 'assistant', content: '收到' },
    ], JSON.stringify(p.messages));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
