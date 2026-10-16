import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup as setupChatPlugin } from '../src/plugins/chat/index.ts';

/**
 * 引用回复工具（reply_quote）：chat 面限定。
 * 插件本体要插件容器才活；这里给一个宽松的假上下文把 setup 扫到 reply_quote 注册完，
 * 拿到 ToolDef 再单测 handler 的三个行为面：
 *   1. 段序：引用段在前、正文在后（QQ 靠这个顺序认引用块）
 *   2. 发送后按 spoke 报给内核（本轮不再走普通出站）
 *   3. 空 id / 空正文拒发
 */

test('reply_quote：引用段在前，发送后经 spoke 回报内核', async () => {
  const sent: { segments: unknown[]; chatId: string }[] = [];
  const defs: Record<string, any> = {};
  let stop = false;

  // 宽松的假 PluginContext：覆盖 setup 一路会摸到的面；往注册列表塞完工具为止
  const ctx: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'llm') return { registerTool: (def: any) => { defs[def.name] = def; } };
      if (prop === 'chat') return {
        send: async (chat: { chatId: string }, segments: unknown[]) => { sent.push({ segments, chatId: chat.chatId }); },
        sendText: async () => {},
      };
      if (prop === 'state') return { get: () => undefined, set: () => {}, all: () => ({}) };
      if (prop === 'config') return { persona: { default: 'whale-girl' } };
      if (prop === 'humanlike') return {
        registerSchedulePlan: undefined,
        planSchedule: (chat: unknown, plan: unknown) => plan,
        scheduleOf: () => ({ rules: [], exceptions: [] }),
      };
      if (prop === 'bus') return { on: () => () => {} };
      if (prop === 'log') return { info() {}, warn() {}, error() {}, debug() {} };
      throw new Error(`test proxy: 未做准备位的 ctx 属性 ${prop} — setup 在拿到 reply_quote 才允许往后爬`);
    },
  }) as any;

  try {
    setupChatPlugin(ctx);
  } catch (e) {
    // 走到还没准备位的属性就停扫——工具在我们前面注册完就够用
    if (!defs.reply_quote) throw e;
    stop = true;
  }
  assert.ok(defs.reply_quote, stop ? '要在抛错前注册到 reply_quote' : '拿到了 reply_quote 工具');
  assert.equal(defs.reply_quote.surface, 'chat', 'work 面严格看不见');

  const tctx = { chat: { platform: 'qq', type: 'group', chatId: '9527' } };
  const r = await defs.reply_quote.handler({ messageId: '9001', text: '那条我回过了，再说一次：周五团建算上我' }, tctx);
  assert.equal(sent.length, 1, '发了一次');
  assert.deepEqual(sent[0].segments.map((s: any) => s.type), ['reply', 'text'], '引用段必须在前');
  assert.equal((sent[0].segments[0] as any).data.id, '9001');
  assert.equal((r as any).spoke, '那条我回过了，再说一次：周五团建算上我', 'spoke 把正文报给内核');

  // 拒发面
  const bad1 = await defs.reply_quote.handler({ messageId: '', text: 'hi' }, tctx);
  const bad2 = await defs.reply_quote.handler({ messageId: '9001', text: '' }, tctx);
  const bad3 = await defs.reply_quote.handler({ messageId: 'abc-xyz', text: 'hi' }, tctx);
  assert.equal(sent.length, 1, '三种坏参都不发');
  assert.ok(!(bad1 as any).spoke && !(bad2 as any).spoke && !(bad3 as any).spoke, '都不出 spoke');
});
