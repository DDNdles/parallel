import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// chat 侧交付：work 做好文件 → chat 用 deliver_file 发给用户
//
// 这条链路过去是断的：work 的交付物清单只进了转述提示词，chat 面**没有任何发文件的工具**
// （send_file 是 surface:'work'，chat 轮严格缺席），于是模型只能说"发不了"。
// 这里用 mock 引擎真跑一轮 chat，断言文件被交给协议端，而不是只回了路径。
// ============================================================

async function boot(group: string) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-deliver-'));
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
  // 拟人层在测试里要确定性：停顿归零（分段仍按模型正文来）
  Object.assign(cfg.humanlike.outgoing, {
    typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0, typingJitterRatio: 0,
  });
  cfg.risk.replyRatePerMin = 10_000;
  await kernel.boot();
  kernel.chat.setRatePerMin(10_000);
  kernel.pipeline.duplicateWindowMs = 0;

  const chat = { platform: 'qq' as const, type: 'group' as const, chatId: group };
  for (const id of ['sandbox', 'work', 'chat']) kernel.container.setGroupState(id, chat.chatId, true, 'owner');
  const chatKey = `${chat.type}_${chat.chatId}`;

  /** 记下协议端收到的文件（替身适配器：不连真协议端，只验证调用链把文件交出去了） */
  const files: string[] = [];
  const targets: string[] = [];
  kernel.chat.attachAdapter({
    send: async () => 'mid',
    sendForward: async () => undefined,
    sendPoke: async () => {},
    sendReaction: async () => {},
    sendFile: async (_c, abs) => { files.push(abs); targets.push(String(_c.chatId)); return 'fid'; },
    connected: () => true,
    status: () => ({ connected: true }),
  });
  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  return { kernel, chat, chatKey, files, targets, mock, cleanup: async () => { await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('deliver_file：work 交付登记过的产物，chat 真能发给用户（不是只回路径）', async () => {
  const g = await boot('9101');
  try {
    // 造一次"work 已交付"的现场（会话沙箱里的两个文件 + 一条成功的运行记录）
    g.kernel.sandbox.write(g.chat, 'report.html', '<html><body>报告</body></html>');
    g.kernel.sandbox.write(g.chat, 'pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    g.kernel.db.run(
      `INSERT INTO work_runs (id, chat_key, task, model, trigger, phase, ok, rounds, tool_calls, duration_ms, summary, error, user_id, ts, artifacts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'work_e2e1', g.chatKey, '做一份报告', 'mock:mock-1', 'command', 'done', 1, 3, 3, 1000, '', null, '10001', Date.now(),
      JSON.stringify(['report.html', 'pic.png']),
    );

    // chat 模型这轮就调一次 deliver_file（不带 path = 发送全部产物）
    g.mock.script.push({ toolCalls: [{ name: 'deliver_file', args: {} }] });
    g.mock.script.push({ content: '给你，报告和配图都在这儿了～' });

    const event = {
      platform: 'qq' as const, type: 'group' as const, chatId: g.chat.chatId,
      userId: '10001', nickname: '主人', senderRole: 'owner' as const,
      segments: [], text: '把刚才做的东西发我', isAtMe: true, isReplyToMe: false,
      raw: null, ts: Date.now(), messageId: 'msg-deliver-1',
    };
    await (g.kernel.pipeline as any).agentTurn(event, 'owner', g.chatKey, { userText: '把刚才做的东西发我' });

    assert.equal(g.files.length, 2, `应当发出两个文件，实际：${JSON.stringify(g.files)}`);
    assert.ok(g.files.some((f) => f.endsWith('report.html')), 'report.html 没发出去');
    assert.ok(g.files.some((f) => f.endsWith('pic.png')), 'pic.png 没发出去');
  } finally {
    await g.cleanup();
  }
});

test('deliver_file：私聊任务沙箱的产物发到真实 QQ 号（不把 u<QQ> 合成 id 当收件人）', async () => {
  const g = await boot('9104');
  try {
    // 私聊 work 任务的沙箱引用：chatId 是 u<QQ>、scope 是任务号（真实收件人只有 QQ 号）
    const taskId = 'tdeadbeef';
    const sandboxKey = `private_u10001__${taskId}`;
    const workChat = { platform: 'qq' as const, type: 'private' as const, chatId: 'u10001', scope: taskId };
    g.kernel.sandbox.write(workChat, 'imagegen/poster.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    g.kernel.db.run(
      `INSERT INTO work_runs (id, chat_key, task, model, trigger, phase, ok, rounds, tool_calls, duration_ms, summary, error, user_id, ts, artifacts, sandbox_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `work_${taskId}`, 'private_10001', '画海报', 'mock:mock-1', 'chat', 'done', 1, 3, 3, 1000, '', null, '10001', Date.now(),
      JSON.stringify(['imagegen/poster.jpg']), sandboxKey,
    );

    const realChat = { platform: 'qq' as const, type: 'private' as const, chatId: '10001' };
    const tool = g.kernel.container.toolsForChat(realChat, 'owner').find((t) => t.name === 'deliver_file');
    assert.ok(tool);
    const r = await tool!.handler({}, {
      chat: realChat, role: 'owner',
      event: {
        platform: 'qq', type: 'private', chatId: '10001', userId: '10001', nickname: '主人',
        segments: [], text: '我图图呢', isAtMe: true, isReplyToMe: false, senderRole: 'owner', raw: null, ts: Date.now(),
      },
    } as any);
    const text = typeof r === 'string' ? r : r.content;
    assert.match(text, /已发送/, `应当发送成功，实际：${text}`);
    assert.equal(g.files.length, 1, `应当发出一个文件，实际：${JSON.stringify(g.files)}`);
    assert.ok(g.files[0].endsWith('poster.jpg'));
    assert.deepEqual(g.targets, ['10001'], `收件人必须是真实 QQ 号，实际：${JSON.stringify(g.targets)}`);
  } finally {
    await g.cleanup();
  }
});

test('send_file：work 轮拒绝直接发（合成会话不是收件人），改用 work_finish 登记', async () => {
  const g = await boot('9105');
  try {
    const workChat = { platform: 'qq' as const, type: 'private' as const, chatId: 'u10001', scope: 'tfeed' };
    const tool = g.kernel.container.toolsForChat(workChat, 'owner', 'work').find((t) => t.name === 'send_file');
    assert.ok(tool, 'work 面应当有 send_file（历史行为），但调用要被挡下');
    const r = await tool!.handler({ path: 'x.txt' }, { chat: workChat, role: 'owner', work: { depth: 0 }, event: { userId: '10001' } } as any);
    const text = typeof r === 'string' ? r : r.content;
    assert.match(text, /work_finish/);
    assert.equal(g.files.length, 0);
  } finally {
    await g.cleanup();
  }
});

test('派活确认轮：maxBubbles=1 时只出一条气泡', async () => {
  const g = await boot('9106');
  try {
    const { plans } = await g.kernel.humanlike.composeScene('收到，本鱼这就把活派下去画！居然敢说本鱼滞销。明明超抢手好不好！正在画啦。', { maxBubbles: 1 });
    assert.equal(plans.length, 1);
  } finally {
    await g.cleanup();
  }
});

test('汇报轮模型空输出：登记的产物照样发出去（不跟着沉默）', async () => {
  const g = await boot('9107');
  try {
    const taskId = 'tabc';
    const sandboxKey = `group_${g.chat.chatId}__${taskId}`;
    const workChat = { platform: 'qq' as const, type: 'group' as const, chatId: g.chat.chatId, scope: taskId };
    g.kernel.sandbox.write(workChat, 'imagegen/poster.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const sentFiles: string[] = [];
    g.kernel.chat.attachAdapter({
      send: async () => 'mid',
      sendForward: async () => 'fid',
      sendPoke: async () => {},
      sendReaction: async () => {},
      sendFile: async (_c: any, abs: string) => { sentFiles.push(abs); return 'fid'; },
      connected: () => true,
      status: () => ({ connected: true }),
    });
    // 模型这一轮一个字都没产出（链挂/额度尽）
    g.mock.script.push({ content: '' });

    await (g.kernel.pipeline as any).agentTurn(
      {
        platform: 'qq', type: 'group', chatId: g.chat.chatId, userId: '10001', nickname: '主人', senderRole: 'owner',
        segments: [], text: '', isAtMe: false, isReplyToMe: false, raw: { workReport: true }, ts: Date.now(),
      },
      'owner', g.chatKey,
      {
        report: {
          task: '画海报',
          result: {
            id: `work_${taskId}`, ok: true, sandboxKey, summary: '画好了', rounds: 1, toolCalls: 1,
            durationMs: 1, artifacts: ['imagegen/poster.jpg'], model: 'mock:mock-1',
          },
        },
      },
    );

    assert.equal(sentFiles.length, 1, '空文本也不能把产物丢了');
    assert.ok(sentFiles[0].includes('poster.jpg'), '产物要作为独立文件消息发出');
  } finally {
    await g.cleanup();
  }
});

test('deliver_file：没有交付记录时如实说没有，不杜撰文件', async () => {
  const g = await boot('9102');
  try {
    const tool = g.kernel.container.toolsForChat(g.chat, 'owner').find((t) => t.name === 'deliver_file');
    assert.ok(tool, 'chat 面应当有 deliver_file');
    const r = await tool!.handler({}, {
      chat: g.chat, role: 'owner',
      event: {
        platform: 'qq', type: 'group', chatId: g.chat.chatId, userId: '10001', nickname: '主人',
        segments: [], text: '', isAtMe: true, isReplyToMe: false, senderRole: 'owner', raw: null, ts: 0,
      },
    } as any);
    const text = typeof r === 'string' ? r : r.content;
    assert.match(text, /还没有产出过文件/);
    assert.equal(g.files.length, 0, '不该发任何文件');
  } finally {
    await g.cleanup();
  }
});

test('deliver_file：只给 chat 面的管理员，普通成员拿不到；work 面也不该出现', async () => {
  const g = await boot('9103');
  try {
    const names = (role: 'member' | 'owner', surface: 'chat' | 'work') =>
      g.kernel.container.toolsForChat(g.chat, role, surface).map((t) => t.name);
    assert.ok(names('owner', 'chat').includes('deliver_file'), '管理员 chat 面应有 deliver_file');
    assert.ok(!names('member', 'chat').includes('deliver_file'), '普通成员不该拿到 deliver_file');
    assert.ok(!names('owner', 'work').includes('deliver_file'), 'work 轮已有 send_file，不必再给 deliver_file');
  } finally {
    await g.cleanup();
  }
});
