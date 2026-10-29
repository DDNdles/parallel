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

test('inboundModelText：群聊带昵称前缀（模型的群里身份感知来源）', () => {
  // 有昵称给昵称
  assert.equal(inboundModelText({ text: '收一下', nickname: '小明' }), '小明：收一下');
  // 昵称是空白/缺失就不产前缀（QQ 号回落由调用方做）
  assert.equal(inboundModelText({ text: '收一下', nickname: '   ' }), '收一下');
  assert.equal(inboundModelText({ text: '收一下' }), '收一下');
  // 正文被剥干净了就不给孤零零一个前缀
  assert.equal(inboundModelText({ text: '[回复:-1]', nickname: '小明' }), '');
  // 前缀拼在引用块前面，不落在引用里
  assert.equal(
    inboundModelText({ text: '[回复:900]收一下', nickname: '小明', replyTo: { nickname: '张三', text: '文件在共享盘' } }),
    '小明：（引用「张三」：文件在共享盘）收一下',
  );
});

test('inboundModelText：引用的是一份聊天记录时，正文一起展开（不能只剩 [聊天记录]）', () => {
  const fwd = {
    id: 'r9', title: '', dropped: 0, failed: false,
    nodes: [
      { nickname: '月亮', userId: '1', text: '活动延期了', ts: 0 },
      { nickname: '阿甘', userId: '2', text: '那还去不去', ts: 0 },
    ],
  };
  const out = inboundModelText({
    text: '[回复:1039783197]如何评价', nickname: '阿甘',
    replyTo: { nickname: '甘愿.', text: '[聊天记录]', forward: fwd },
  });
  assert.ok(out.includes('引用「甘愿.」发来的聊天记录'), out);
  assert.ok(out.includes('月亮：活动延期了') && out.includes('阿甘：那还去不去'), `记录节点要进来：${out}`);
  assert.ok(!out.includes('[聊天记录]'), out);
  // 取不到正文的记录（failed / 旧日志没存）：保持原来的占位口径，不编内容
  const miss = inboundModelText({
    text: '[回复:7]看看', replyTo: { nickname: '甘愿.', text: '[聊天记录]', forward: { ...fwd, failed: true } },
  });
  assert.equal(miss, '（引用「甘愿.」：[聊天记录]）看看');
});

test('inboundModelText：QQ 表情编号换成中文名（模型读得懂）', () => {
  assert.equal(inboundModelText({ text: '[表情:32]' }), '[表情:疑问]');
  assert.equal(inboundModelText({ text: '不理你[表情:14]', nickname: '小明' }), '小明：不理你[表情:微笑]');
  // 引用里带着表情也要换（引用快照存的是落账原文）
  assert.equal(
    inboundModelText({ text: '[回复:1]哈哈', replyTo: { nickname: '小红', text: '笑死[表情:32]' } }),
    '（引用「小红」：笑死[表情:疑问]）哈哈',
  );
  // 不认识的编号不硬猜，原样留着
  assert.equal(inboundModelText({ text: '[表情:9999]' }), '[表情:9999]');
});

test('会话日志回读历史时走同一套净化（重启后那份记录仍在；群聊带昵称前缀、私聊不带）', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    const e1 = log.append('100', 'group', {
      type: 'message_in', role: 'user', nickname: '小明', text: '[回复:900]收一下',
      data: { replyTo: { nickname: '张三', text: '文档在共享盘' } },
    });
    const e2 = log.append('100', 'group', {
      type: 'message_in', role: 'user', nickname: '小红', text: '昨天的 [聊天记录]',
      data: { forward: { id: 'r1', title: '', dropped: 0, failed: false, nodes: [{ nickname: '甲', userId: '1', text: '定了', ts: 0 }] } },
    });
    const e3 = log.append('100', 'group', { type: 'message_out', role: 'assistant', text: '收到' });

    const p = log.project('100', 'group');
    assert.deepEqual(p.messages, [
      { role: 'user', content: '小明：（引用「张三」：文档在共享盘）收一下', ts: e1.ts },
      { role: 'user', content: '小红：昨天的\n【聊天记录·共 1 条】\n甲：定了', ts: e2.ts },
      { role: 'assistant', content: '收到', ts: e3.ts },
    ], JSON.stringify(p.messages));

    // 私聊不带前缀：对面是谁 system 已写明，每条挂名只是白吃 token
    const log2 = new SessionLog(d, new Bus());
    const e4 = log2.append('200', 'private', { type: 'message_in', role: 'user', nickname: '小明', text: '收一下' });
    const p2 = log2.project('200', 'private');
    assert.deepEqual(p2.messages, [
      { role: 'user', content: '收一下', ts: e4.ts },
    ], JSON.stringify(p2.messages));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('引用记录的落账：节点正文存下来，带 rkey 的临时 URL 不落盘', () => {
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    const fwd = {
      id: 'r7', title: '', dropped: 0, failed: false,
      nodes: [{
        nickname: '月亮', userId: '2', text: '活动延期了', ts: 0,
        files: [{
          name: 'p.png', rel: 'inbox/p.png', sandboxPath: 'C:/sb/inbox/p.png', size: 3,
          url: 'https://multimedia.example/p.png?rkey=abc',
        }],
      }],
    };
    log.logInbound({
      id: 'ev1', platform: 'qq', type: 'group', chatId: '100', userId: '9', nickname: '阿甘',
      senderRole: 'member', segments: [{ type: 'reply', data: { id: '1' } }], text: '[回复:1]如何评价',
      isAtMe: true, isReplyToMe: false, messageId: '777', raw: {}, ts: Date.now(),
      replyTo: { userId: '2', nickname: '甘愿.', text: '[聊天记录]', forward: fwd },
    } as never);
    const line = log.tail('100', 'group', 10).at(-1)!;
    const stored = (line.data as { replyTo?: { forward?: { nodes?: { text: string; files?: { rel: string }[] }[] } } }).replyTo?.forward;
    assert.equal(stored?.nodes?.[0].text, '活动延期了', '引用的记录正文要落账（重启后回读历史还得靠它）');
    assert.equal(stored?.nodes?.[0].files?.[0].rel, 'inbox/p.png', '附件只留沙箱内相对路径');
    const rawLine = JSON.stringify(line);
    assert.ok(!rawLine.includes('rkey'), `临时 URL 不该进会话日志：${rawLine.slice(0, 300)}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('inboundModelText：消息号只是落账字段，不进模型正文（引用回复已改程序自动锚定）', () => {
  // 引用锚点由内核在发送时从事件上取，模型侧不再需要 [#编号] 地址
  assert.equal(inboundModelText({ text: '收一下', nickname: '小明' }), '小明：收一下');
  const d = dir();
  try {
    const log = new SessionLog(d, new Bus());
    log.append('300', 'group', {
      type: 'message_in', role: 'user', nickname: '小明', text: '冲', data: { messageId: '9001' },
    });
    const p = log.project('300', 'group');
    assert.equal(p.messages[0]?.content, '小明：冲', JSON.stringify(p.messages));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
