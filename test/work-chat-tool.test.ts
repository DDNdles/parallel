import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
    models: [{ id: 'mock-1', enabled: true }],
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
  const tctx = (userId: string, role: string) => ({
    event: {
      platform: chat.platform, type: chat.type, chatId: chat.chatId,
      userId, nickname: `群友${userId}`, senderRole: role === 'member' ? 'member' : 'owner',
      segments: [], text: '', isAtMe: true, isReplyToMe: false, raw: null, ts: Date.now(), role,
    },
    chat, role,
  });
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

    const denied = await dispatch!.handler({ task: '删库跑路' }, g.tctx('20001', 'member') as any);
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
    await until(() => g.kernel.workRunner.liveStatus(g.chatKey, '10001').active.length > 0, 8000, 'A 开跑');

    const b = g.kernel.workRunner.run({
      chat, task: 'B 的慢活', taskLabel: 'B 的慢活', userId: '10002', nickname: 'B',
      role: 'admin', agent, tools, trigger: 'command', depth: 0,
    });
    g.mock.script.push({ content: 'B 也在算', delayMs: 800, toolCalls: [{ name: 'work_finish', args: { summary: 'B 做完了' } }] });
    await until(() => g.kernel.workRunner.liveStatus(g.chatKey, '10002').active.length > 0, 8000, 'B 开跑');

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
    await dispatch.handler({ task: '做个小文件' }, g.tctx('30003', 'admin') as any);
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

    const result = String(await dispatch.handler({ task: '做个小实验' }, g.tctx('10001', 'owner') as any));
    assert.match(result, /已接下这件活/, result);
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
