import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busEvents } from '../src/kernel/bus.ts';

// ============================================================
// chat 面的 work 工具（2026-10-21，取代 /work 命令）
//
//  1. work_dispatch / work_status 对普通群友可见，但工具内部判权限并回绝
//     （用 minRole 藏工具的话，chat 就没法"用人格婉拒"，而是根本不知道有这回事）；
//  2. work_status 只回**调用者自己**的活：同群另一个人的进度不许出现；
//  3. 派活是异步的：handler 立即返回，本轮 chat 收尾（agent.end）后才真正开跑。
// ============================================================

async function boot(group: string) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-worktool-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  (cfg.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true, inputTypes: ['text', 'image'] }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.masterIds = ['10001'];
  cfg.extraAdminIds = ['10002'];
  Object.assign(cfg.humanlike.outgoing, {
    typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0, typingJitterRatio: 0,
  });
  cfg.risk.replyRatePerMin = 10_000;
  await kernel.boot();
  kernel.chat.setRatePerMin(10_000);
  kernel.pipeline.duplicateWindowMs = 0;

  const chat = { platform: 'qq' as const, type: 'group' as const, chatId: group };
  const chatKey = `${chat.type}_${chat.chatId}`;
  kernel.container.setGroupState('work', chat.chatId, true, 'owner');
  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  const tools = (role: 'owner' | 'admin' | 'member') =>
    kernel.container.toolsForChat(chat, role, 'chat');
  const tctx = (userId: string, role: string, opts: { messages?: string[]; batch?: any[]; speakers?: any[]; event?: any } = {}) => {
    const event = opts.event ?? {
      platform: chat.platform, type: chat.type, chatId: chat.chatId,
      userId, nickname: `群友${userId}`, senderRole: role === 'member' ? 'member' : 'owner',
      segments: [], text: '', isAtMe: true, isReplyToMe: false, raw: null, ts: Date.now(), role,
    };
    return {
      event, chat, role,
      contextMessages: (opts.messages ?? []).map((t, i) => ({ role: 'user' as const, content: t, ts: Date.now() + i })),
      ...(opts.batch ? { batch: opts.batch } : {}),
      ...(opts.speakers ? { speakers: opts.speakers } : {}),
    };
  };
  return {
    kernel, chat, chatKey, mock, tools, tctx,
    cleanup: async () => { await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`等待 ${what} 超时`);
}

test('work_dispatch / work_status：普通群友能看到工具，但调用被工具内权限挡下', async () => {
  const g = await boot('9401');
  try {
    const memberTools = g.tools('member');
    const dispatch = memberTools.find((t) => t.name === 'work_dispatch');
    const status = memberTools.find((t) => t.name === 'work_status');
    assert.ok(dispatch, '普通群友的 chat 面也要有 work_dispatch（否则没法人格化拒绝）');
    assert.ok(status, '普通群友的 chat 面也要有 work_status');

    const denied = await dispatch!.handler(
      { messages: ['删库跑路'] },
      g.tctx('20001', 'member', { messages: ['删库跑路'] }) as any,
    );
    assert.match(String(denied), /权限不足/, `普通群友派活要被拒绝：${denied}`);
    assert.equal(g.kernel.workRunner.list(10, g.chatKey).length, 0, '被拒绝时不许偷偷开跑');

    const deniedStatus = await status!.handler({}, g.tctx('20001', 'member') as any);
    assert.match(String(deniedStatus), /权限不足/, `普通群友查进度要被拒绝：${deniedStatus}`);
    assert.ok(!String(deniedStatus).includes('任务「'), '拒绝时不能泄露任何人的任务');
  } finally {
    await g.cleanup();
  }
});

test('work_status：只回调用者自己的活（同群另一个人的进度看不到），并带用时/轮次/token', async () => {
  const g = await boot('9402');
  try {
    const chat = g.chat;
    const agent = g.kernel.container.workAgent();
    const tools = g.kernel.container.workToolsFor(chat, 'owner', agent, 0);
    const a = g.kernel.workRunner.run({
      chat, task: 'A 的慢活', taskLabel: 'A 的慢活', userId: '10001', nickname: 'A',
      role: 'owner', agent, tools, trigger: 'command', depth: 0,
    });
    // 第一轮先报一次用量（有 tool 调用），第二轮延迟 1.2s：这段时间 status 要能查到实时进度
    g.mock.script.push({ toolCalls: [{ name: 'sandbox_list', args: {} }] });
    g.mock.script.push({ content: '还在算', delayMs: 1200, toolCalls: [{ name: 'work_finish', args: { summary: 'A 做完了' } }] });
    await until(() => g.kernel.workRunner.liveStatus('10001').active.length > 0, 8000, 'A 开跑');

    const b = g.kernel.workRunner.run({
      chat, task: 'B 的慢活', taskLabel: 'B 的慢活', userId: '10002', nickname: 'B',
      role: 'admin', agent, tools, trigger: 'command', depth: 0,
    });
    g.mock.script.push({ content: 'B 也在算', delayMs: 800, toolCalls: [{ name: 'work_finish', args: { summary: 'B 做完了' } }] });
    await until(() => g.kernel.workRunner.liveStatus('10002').active.length > 0, 8000, 'B 开跑');

    const status = g.tools('owner').find((t) => t.name === 'work_status')!;
    const text = String(await status.handler({}, g.tctx('10001', 'owner') as any));
    assert.match(text, /正在跑 1 件/, text);
    assert.match(text, /A 的慢活/, text);
    assert.match(text, /第 \d+ 轮/, text);
    assert.match(text, /token/, '要报 token 用量');
    assert.match(text, /缓存命中/, '要报缓存命中');
    assert.ok(!text.includes('B 的慢活'), `不许看到别人的活：${text}`);

    // 另一个人的 status 只看到自己的
    const textB = String(await status.handler({}, g.tctx('10002', 'admin') as any));
    assert.match(textB, /B 的慢活/, textB);
    assert.ok(!textB.includes('A 的慢活'), `B 也不许看到 A 的活：${textB}`);

    await a;
    await b;
  } finally {
    await g.cleanup();
  }
});

test('群管理员（不在 masterIds/extraAdminIds 里）派活：汇报轮沿用当时的角色，产物改由聊天记录发出', async () => {
  const g = await boot('9404');
  try {
    const dispatch = g.tools('admin').find((t) => t.name === 'work_dispatch')!;
    // 只在 QQ 群权限里是管理员、配置里没有这个号；派活时 tctx.role='admin' 应当被沿用
    g.kernel.sandbox.write({ ...g.chat, scope: 'u30003' }, 'out.md', '# hi\n');
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '做完了', artifacts: ['out.md'] } }] });
    g.mock.script.push({ content: '做完了，文件给你。' });
    const done = new Promise<any>((resolve) => {
      const off = g.kernel.bus.on('work.done' as any, (d: any) => {
        if (d.chatKey === g.chatKey && d.trigger === 'chat') { off(); resolve(d); }
      });
    });
    await dispatch.handler(
      { messages: ['做个小文件'] },
      g.tctx('30003', 'admin', { messages: ['做个小文件'] }) as any,
    );
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });
    await done;
    const reportCall = await until(
      () => g.mock.calls.find((c: any) => String(c.lastUser ?? '').includes('【你派出去的活做完了】')),
      8000, '汇报轮',
    );
    assert.ok(reportCall.tools?.includes('work_dispatch'), `汇报轮必须是管理员工具面：${reportCall.tools}`);
    assert.ok(!reportCall.tools?.includes('deliver_file'), '汇报轮的正文+产物由内核合并成聊天记录，不再给 deliver_file');
  } finally {
    await g.cleanup();
  }
});

test('work_dispatch：handler 立即返回，本轮 chat 收尾（agent.end）后才真正开跑', async () => {
  const g = await boot('9403');
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const done = new Promise<any>((resolve) => {
      const off = g.kernel.bus.on('work.done' as any, (d: any) => {
        if (d.chatKey === g.chatKey && d.trigger === 'chat') { off(); resolve(d); }
      });
    });
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '做完了' } }] });
    g.mock.script.push({ content: '好了，做完了。' });   // 汇报轮

    const result = String(await dispatch.handler(
      { messages: ['做个小实验'] },
      g.tctx('10001', 'owner', { messages: ['做个小实验'] }) as any,
    ));
    assert.match(result, /已把 1 条消息的原文转给工作子代理/, result);
    assert.equal(g.kernel.workRunner.list(10, g.chatKey).length, 0, 'chat 还没收尾时不该开跑');

    // 模拟本轮 chat 的 agent.end（真实链路由 AgentLoop 发这个事件）
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好，我去弄。', rounds: 2 });
    const ev = await done;
    assert.equal(ev.trigger, 'chat');
    assert.ok(g.kernel.workRunner.list(10, g.chatKey).some((r) => r.task === '做个小实验'));
    // 等汇报轮真的发出请求再拆内核（它没有协议端，发送会失败，但模型请求本身要跑完）
    await until(() => g.mock.calls.some((c: any) => String(c.lastUser ?? '').includes('【你派出去的活做完了】')), 8000, '汇报轮');
  } finally {
    await g.cleanup();
  }
});

test('work 输出流式下发：delta 先到；收尾记录不落 delta，message_end 的完整正文仍在', async () => {
  const g = await boot('9404');
  try {
    const events: any[] = [];
    const off = g.kernel.bus.on(busEvents.workEvent, (d: any) => {
      if (d.chatKey === g.chatKey) events.push(d.ev);
    });
    g.mock.script.push({
      content: '流式生成的正文',
      toolCalls: [{ name: 'work_finish', args: { summary: '完成' } }],
    });
    const agent = g.kernel.container.workAgent();
    const tools = g.kernel.container.workToolsFor(g.chat, 'owner', agent, 0);
    await g.kernel.workRunner.run({
      chat: g.chat, task: '流式', taskLabel: '流式', userId: '10001', nickname: 'A',
      role: 'owner', agent, tools, trigger: 'command', depth: 0,
    });
    off();

    const delta = events.filter((e) => e.kind === 'delta').map((e) => e.text).join('');
    assert.equal(delta, '流式生成的正文', `delta 要实时送到前端：${JSON.stringify(events)}`);
    assert.ok(events.some((e) => e.kind === 'text' && e.text.includes('流式生成的正文')), 'message_end 的完整正文要单独落 text');
    assert.ok(!events.some((e) => e.kind === 'thinking'), '没有思考链时不该凭空造思考行');

    const run = g.kernel.workRunner.list(10, g.chatKey)[0];
    assert.ok(!run.events.some((e: any) => e.kind === 'delta' || e.kind === 'thinkingDelta'), '流式增量只走实时总线，不进运行记录');
    assert.ok(run.events.some((e: any) => e.kind === 'text'), '运行记录里保留完整正文');
  } finally {
    await g.cleanup();
  }
});

test('work 思考链：thinking 块进思考流，正文单独进正文流', async () => {
  const g = await boot('9405');
  try {
    const events: any[] = [];
    const off = g.kernel.bus.on(busEvents.workEvent, (d: any) => {
      if (d.chatKey === g.chatKey) events.push(d.ev);
    });
    g.mock.script.push({
      thinking: '先确认文件在不在',
      content: '我看一眼',
      toolCalls: [{ name: 'work_finish', args: { summary: '完成' } }],
    });
    const agent = g.kernel.container.workAgent();
    const tools = g.kernel.container.workToolsFor(g.chat, 'owner', agent, 0);
    await g.kernel.workRunner.run({
      chat: g.chat, task: '想想', taskLabel: '想想', userId: '10001', nickname: 'A',
      role: 'owner', agent, tools, trigger: 'command', depth: 0,
    });
    off();

    const delta = events.filter((e) => e.kind === 'delta').map((e) => e.text).join('');
    assert.ok(delta.includes('我看一眼'), `正文增量要进流：${delta}`);
    assert.ok(!delta.includes('先确认文件在不在'), `thinking_delta 不该混进正文流：${delta}`);
    const thinkDelta = events.filter((e) => e.kind === 'thinkingDelta').map((e) => e.text).join('');
    assert.ok(thinkDelta.includes('先确认文件在不在'), `thinking_delta 要进思考流：${thinkDelta}`);
    const think = events.find((e) => e.kind === 'thinking');
    assert.ok(think, 'message_end 要产出思考行');
    assert.ok(think.text.includes('先确认文件在不在'), `思考链不能丢：${think.text}`);
    assert.ok(!think.text.includes('我看一眼'), `正文不能塞进思考：${think.text}`);
    const body = events.find((e) => e.kind === 'text');
    assert.ok(body?.text.includes('我看一眼'), `正文要单独落 text：${body?.text}`);
  } finally {
    await g.cleanup();
  }
});

test('chat 派给 work 的任务不截断：work.start 与列表都保留全文', async () => {
  const g = await boot('9406');
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const longTask = `任务开头。${'细节'.repeat(400)}`;
    const startEvents: any[] = [];
    const off = g.kernel.bus.on(busEvents.workStart, (d: any) => { if (d.chatKey === g.chatKey) startEvents.push(d); });
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '完成' } }] });
    g.mock.script.push({ content: '好了' });
    await dispatch.handler(
      { messages: [longTask] },
      g.tctx('10001', 'owner', { messages: [longTask] }) as any,
    );
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });
    const startEv = await until(
      () => startEvents.find((e) => e.task === longTask),
      8000, '长任务开跑',
    );
    off();
    assert.equal(startEv.task, longTask, 'work.start 推给桌面的任务必须是全文');
    // list() 里是短标；全文落库，resume/桌面端详情读 work_runs.task
    const row = (g.kernel as any).db.get('SELECT task FROM work_runs WHERE id=?', startEv.id) as { task: string };
    assert.equal(row.task, longTask, '落库的任务必须是全文');
    assert.equal(row.task.length, longTask.length);
  } finally {
    await g.cleanup();
  }
});

test('work_dispatch 端到端：只转发被引用的消息原文，chat 自己写的字进不去', async () => {
  const g = await boot('9406');
  g.mock.script.length = 0;
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const ev = (userId: string, nickname: string, text: string) => ({
      id: 'e' + Math.random().toString(36).slice(2), platform: 'qq', type: 'group' as const, chatId: g.chat.chatId,
      userId, nickname, senderRole: 'member' as const, segments: [], text,
      isAtMe: false, isReplyToMe: false, raw: null, ts: Date.now(), role: 'member' as any,
    });
    const nudge = ev('30003', '小明', '你根本没派');
    const chatter = ev('10002', 'Lawrence', '哈哈这个梗好笑');
    const original = '小明：帮我画一张豆包和奶龙对打的图，豆包要占上风';
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '画好了' } }] });
    g.mock.script.push({ content: '好了' });
    const reply = String(await dispatch.handler(
      { messages: ['帮我画一张豆包和奶龙对打的图'] },   // 只截一段，程序转发整条原文
      {
        event: chatter, batch: [nudge, chatter], chat: g.chat, role: 'owner' as const,
        contextMessages: [{ role: 'user' as const, content: original, ts: 1 }],
        speakers: [
          { userId: '30003', nickname: '小明', role: 'admin' as const, ts: 1 },
          { userId: '10002', nickname: 'Lawrence', role: 'member' as const, ts: 2 },
        ],
      } as any,
    ));
    assert.match(reply, /已把 1 条消息的原文转给工作子代理/, reply);
    assert.match(reply, /只截取了其中一段/, reply);

    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });
    const run = await until(() => g.kernel.workRunner.list(10, g.chatKey)[0], 8000, '任务开跑');
    // 任务正文 = 被引用那条消息的原文（含群聊「昵称：」前缀）；催促与闲聊都没进去
    assert.equal(run.task, original);
    const call = await until(
      () => g.mock.calls.find((c: any) => String(c.usersJoined ?? '').includes('豆包要占上风')),
      8000, 'work 首轮请求',
    );
    const body = String(call.usersJoined);
    assert.ok(body.includes(original), '转发的该是整条原文');
    assert.ok(!body.includes('你根本没派'), '本轮催促消息不在引用里，就不该进任务');
  } finally {
    await g.cleanup();
  }
});

test('work_dispatch：引用对不上原文整单拒绝，不会把 chat 的改写派出去', async () => {
  const g = await boot('9408');
  g.mock.script.length = 0;
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const reply = String(await dispatch.handler(
      { messages: ['画一张豆包和奶龙对打的趣味插画'] },   // 用户没这么说过
      {
        event: { userId: '10001' }, chat: g.chat, role: 'owner' as const,
        contextMessages: [{ role: 'user' as const, content: '帮我画一张豆包和奶龙对打的图', ts: 1 }],
      } as any,
    ));
    assert.match(reply, /对不上原文/, reply);
    assert.match(reply, /没派出去/, reply);
    assert.equal(g.kernel.workRunner.list(10, g.chatKey).length, 0, '拒绝时不许偷偷开跑');
  } finally {
    await g.cleanup();
  }
});

test('work_dispatch：多条引用按原顺序转发（含后续修改要求）', async () => {
  const g = await boot('9409');
  g.mock.script.length = 0;
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const startEvents: any[] = [];
    const stop = g.kernel.bus.on(busEvents.workStart, (d: any) => { if (d.chatKey === g.chatKey) startEvents.push(d); });
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '改好了' } }] });
    g.mock.script.push({ content: '好了' });
    await dispatch.handler(
      { messages: ['画一只蓝色鲸鱼', '背景换成海洋'] },
      {
        event: { userId: '10001' }, chat: g.chat, role: 'owner' as const,
        contextMessages: [
          { role: 'user' as const, content: '画一只蓝色鲸鱼', ts: 1 },
          { role: 'user' as const, content: '背景换成海洋', ts: 2 },
        ],
      } as any,
    );
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });
    const startEv = await until(
      () => startEvents.find((e) => e.task === '画一只蓝色鲸鱼\n\n背景换成海洋'),
      8000, '任务开跑',
    );
    assert.equal(startEv.task, '画一只蓝色鲸鱼\n\n背景换成海洋');
    stop();
  } finally {
    await g.cleanup();
  }
});

test('work_dispatch：本轮用户发的图片随任务一起交给 work（第一轮请求就带图）', async () => {
  const g = await boot('9407');
  g.mock.script.length = 0;
  const dir = mkdtempSync(join(tmpdir(), 'parallel-workimg-'));
  try {
    // 1x1 透明 PNG 落到本机文件：附件按 path 读取（与真人发图落盘同一条路）
    const pngPath = join(dir, 'task.png');
    writeFileSync(pngPath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '解完了' } }] });
    g.mock.script.push({ content: '好了' });
    const ret = String(await dispatch.handler(
      { messages: ['解这道模电题，写出详细推导'] },
      {
        ...g.tctx('10001', 'owner', { messages: ['解这道模电题，写出详细推导'] }),
        vision: true,
        attachments: [
          { kind: 'image' as const, path: pngPath, mime: 'image/png', name: 'task.png' },
          { kind: 'image' as const, path: pngPath, mime: 'image/png', name: 'task.png' },  // 同一张重复引用只带一次
        ],
      } as any,
    ));
    assert.match(ret, /已把 1 条消息的原文转给工作子代理/);
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });

    const call = await until(
      () => g.mock.calls.find((c: any) => String(c.usersJoined ?? '').includes('解这道模电题')),
      8000, 'work 首轮请求',
    );
    assert.ok((call.media ?? []).includes('image'), `图片要附在 work 的第一轮请求里：${JSON.stringify(call.media)}`);
    assert.ok(String(call.usersJoined).includes('1 张图已随这条消息附上'), `任务里要说明图已附上：${call.usersJoined}`);
    // 列表/进度条上的短标不带这段附件说明
    const run = await until(() => g.kernel.workRunner.list(10, g.chatKey)[0], 8000, '任务开跑');
    assert.equal(run.task, '解这道模电题，写出详细推导');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await g.cleanup();
  }
});

test('work_dispatch：链首模型不收图时只把图片位置写进任务，不塞附件', async () => {
  const g = await boot('9408');
  g.mock.script.length = 0;
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '做完了' } }] });
    g.mock.script.push({ content: '好了' });
    await dispatch.handler(
      { messages: ['看看这张图'] },
      {
        ...g.tctx('10001', 'owner', { messages: ['看看这张图'] }),
        vision: false,
        attachments: [{ kind: 'image' as const, path: join(tmpdir(), 'x.png'), mime: 'image/png' }],
      } as any,
    );
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });
    const call = await until(
      () => g.mock.calls.find((c: any) => String(c.usersJoined ?? '').includes('看看这张图')),
      8000, 'work 首轮请求',
    );
    assert.ok(String(call.usersJoined).includes('用 sandbox_read 打开看'), `要告诉它自己去看：${call.usersJoined}`);
    assert.ok(!(call.media ?? []).includes('image'), '不收图的模型不该塞图片');
  } finally {
    await g.cleanup();
  }
});

test('work_status：报出 todo 清单进度（完成数 / 正在做 / 逐条状态）', async () => {
  const g = await boot('9405');
  // mock 脚本队列是进程级单例：前一个用例可能留下没消费的汇报轮脚本，先清干净
  g.mock.script.length = 0;
  try {
    const chat = g.chat;
    const agent = g.kernel.container.workAgent();
    const tools = g.kernel.container.workToolsFor(chat, 'owner', agent, 0);
    const a = g.kernel.workRunner.run({
      chat, task: '写一份报告', taskLabel: '写一份报告', userId: '10001', nickname: 'A',
      role: 'owner', agent, tools, trigger: 'command', depth: 0,
    });
    // 第一轮先写清单；第二轮拖 2s 再收尾，中间这段时间查状态
    g.mock.script.push({
      content: '先列个清单',
      toolCalls: [{
        name: 'todo',
        args: {
          items: [
            { text: '收集资料', status: 'done' },
            { text: '写正文', status: 'in_progress' },
            { text: '打包交付', status: 'pending' },
          ],
        },
      }],
    });
    g.mock.script.push({ content: '还在写', delayMs: 2000, toolCalls: [{ name: 'work_finish', args: { summary: '写完了' } }] });

    const status = g.tools('owner').find((t) => t.name === 'work_status')!;
    const text = await until(() => {
      const s = String(status.handler({}, g.tctx('10001', 'owner') as any));
      return s.includes('写正文') ? s : undefined;
    }, 8000, 'todo 清单出现在 status 里');
    assert.match(text, /清单：1\/3 完成/, text);
    assert.match(text, /正在做「写正文」/, text);
    assert.match(text, /\[x\] 收集资料/, text);
    assert.match(text, /\[~\] 写正文/, text);
    assert.match(text, /\[ \] 打包交付/, text);
    await a;
  } finally {
    await g.cleanup();
  }
});

// ============================================================
// 纯转发：引用命中的整条原文进任务；对不上整单拒绝
// ============================================================

test('work_dispatch：任务正在跑时，用户改需求以插话转发给该任务，不另开新活', async () => {
  const g = await boot('9410');
  g.mock.script.length = 0;
  try {
    const chat = g.chat;
    const agent = g.kernel.container.workAgent();
    const tools = g.kernel.container.workToolsFor(chat, 'owner', agent, 0);
    // 一个跑得久的活：两轮工具、第二轮拖一下，留出插话窗口；第三轮才收尾
    g.mock.script.push({ toolCalls: [{ name: 'sandbox_list', args: {} }] });
    g.mock.script.push({ content: '还在做', delayMs: 1500, toolCalls: [{ name: 'sandbox_list', args: {} }] });
    g.mock.script.push({ content: '收尾', toolCalls: [{ name: 'work_finish', args: { summary: '做完了' } }] });
    const running = g.kernel.workRunner.run({
      chat, task: '先画一张海报', taskLabel: '先画一张海报', userId: '10001', nickname: '主人',
      role: 'owner', agent, tools, trigger: 'chat', depth: 0,
    });
    await until(() => g.kernel.workRunner.liveStatus('10001').active.length > 0, 8000, '任务开跑');
    await new Promise((r) => setTimeout(r, 400));   // 等 pi Agent 建好、插话句柄登记

    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const reply = String(await dispatch.handler(
      { messages: ['背景换成红色'] },
      {
        event: { userId: '10001', nickname: '主人' }, chat, role: 'owner' as const,
        contextMessages: [{ role: 'user' as const, content: '背景换成红色', ts: Date.now() }],
      } as any,
    ));
    assert.match(reply, /插话给/, `应该是插话而不是新任务：${reply}`);

    const runs = g.kernel.workRunner.list(10, g.chatKey);
    assert.equal(runs.length, 1, '插话不能另开任务');
    assert.equal(runs[0].task, '先画一张海报');
    assert.ok(
      (runs[0].events ?? []).some((e: any) => e.kind === 'steer' && String(e.text).includes('背景换成红色')),
      '任务事件流里要有插话记录',
    );

    await running;
    assert.ok(
      g.mock.calls.some((c: any) => String(c.usersJoined ?? '').includes('背景换成红色')),
      '插话内容要进模型下一轮请求',
    );
  } finally {
    await g.cleanup();
  }
});

test('work_dispatch：引用早前几条消息时按时间顺序转发整条原文（含群聊昵称前缀）', async () => {
  const g = await boot('9405');
  try {
    const dispatch = g.tools('owner').find((t) => t.name === 'work_dispatch')!;
    const T = Date.now();
    const done = new Promise<any>((resolve) => {
      const off = g.kernel.bus.on('work.done' as any, (d: any) => {
        if (d.chatKey === g.chatKey && d.trigger === 'chat') { off(); resolve(d); }
      });
    });
    g.kernel.sandbox.write({ ...g.chat, scope: 'u10001' }, 'out.md', '# hi\n');
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '做完了', artifacts: ['out.md'] } }] });
    g.mock.script.push({ content: '做好了。' });
    const ret = String(await dispatch.handler(
      // 两段都是截取：程序转发各自整条原文，按消息时间排序
      { messages: ['logo 放右下角', '标题用思源黑体'] },
      {
        ...g.tctx('10001', 'owner'),
        contextMessages: [
          { role: 'user' as const, content: '张三：标题用思源黑体，别用别的', ts: T - 900_000 },
          { role: 'user' as const, content: '李四：logo 放右下角，谢谢', ts: T - 600_000 },
        ],
        speakers: [
          { userId: '30001', nickname: '张三', role: 'admin' as const, ts: T - 900_000 },
          { userId: '30002', nickname: '李四', role: 'member' as const, ts: T - 600_000 },
        ],
      } as any,
    ));
    assert.match(ret, /已把 2 条消息的原文转给工作子代理/, `回执要说明转发条数：${ret}`);
    g.kernel.bus.emit('agent.end', { chatKey: g.chatKey, reply: '好', rounds: 2 });
    const d = await done;
    const row = (g.kernel as any).db.get('SELECT task FROM work_runs WHERE id=?', d.id) as { task: string };
    assert.equal(row.task, '张三：标题用思源黑体，别用别的\n\n李四：logo 放右下角，谢谢');
  } finally {
    await g.cleanup();
  }
});
