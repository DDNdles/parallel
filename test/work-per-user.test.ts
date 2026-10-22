import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// work 的「每个人各自一个会话」与「重启后还画得出指标」
//
// 两条用户反馈对应的行为（2026-10-20）：
//  1. 同一个群里多位管理员 /work 时，沙箱、常驻 Python/浏览器容器、待答复现场必须按人分开；
//  2. 内核重启后，桌面端「工作」抽屉仍要能列出运行、画出上下文圆环/缓存/TPS——
//     记录只存在内存里的话，重启即空白。
// ============================================================

async function boot(port: number) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-peruser-'));
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
  Object.assign(cfg.humanlike.outgoing, {
    typingBaseDelaySeconds: 0, typingMaxDelaySeconds: 0, typingJitterRatio: 0,
  });
  cfg.risk.replyRatePerMin = 10_000;
  await kernel.boot();
  kernel.chat.setRatePerMin(10_000);
  kernel.pipeline.duplicateWindowMs = 0;
  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  return {
    kernel, dataDir, mock,
    cleanup: async (keep = false) => {
      await kernel.shutdown();
      if (!keep) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 直接走 WorkRunner：不起协议端，只验执行面的隔离与记录口径 */
function workInput(chat: { platform: 'qq'; type: 'group'; chatId: string }, userId: string, task: string) {
  return {
    chat, task, taskLabel: task, userId, nickname: `群友${userId}`, role: 'owner',
    tools: [] as any[], trigger: 'command' as const, depth: 0,
  };
}

test('work 沙箱按发起人分开：同群两个人的文件互不可见，群 inbox 会镜像进去', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9301' };
    const a = { ...chat, scope: 'u10001' };
    const b = { ...chat, scope: 'u10002' };

    // 不同人的沙箱根不同，且各写各的文件
    assert.notEqual(g.kernel.sandbox.root(a), g.kernel.sandbox.root(b));
    g.kernel.sandbox.write(a, 'a-only.txt', 'A 的产物');
    g.kernel.sandbox.write(b, 'b-only.txt', 'B 的产物');
    assert.ok(existsSync(join(g.kernel.sandbox.root(a), 'a-only.txt')));
    assert.ok(!existsSync(join(g.kernel.sandbox.root(b), 'a-only.txt')), 'B 不该看到 A 的文件');
    assert.throws(() => g.kernel.sandbox.read(b, 'a-only.txt'), /不存在/);

    // 群聊收到的文件落在聊天级 inbox；work 开跑前镜像进发起人的沙箱
    const inboxDir = join(g.kernel.sandbox.root(chat), 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'report.csv'), 'a,b\n1,2\n');
    const copied = g.kernel.sandbox.syncInbox(chat, a);
    assert.equal(copied, 1, '应当镜像 1 个文件');
    assert.match(g.kernel.sandbox.read(a, 'inbox/report.csv'), /1,2/);
    assert.throws(() => g.kernel.sandbox.read(b, 'inbox/report.csv'), /不存在/, '没镜像的人读不到');
  } finally {
    await g.cleanup();
  }
});

test('work 按人隔离：同一个群里两位发起人各是独立运行，产物只归自己', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9302' };
    const chatKey = 'group_9302';

    // 两个人各跑一次 work（脚本：直接交一份产物）
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: 'A 做完了', artifacts: ['a.txt'] } }] });
    const ra = await g.kernel.workRunner.run(workInput(chat, '10001', '做 A'));
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: 'B 做完了', artifacts: ['b.txt'] } }] });
    const rb = await g.kernel.workRunner.run(workInput(chat, '10002', '做 B'));

    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.deepEqual(ra.artifacts, ['a.txt']);
    assert.deepEqual(rb.artifacts, ['b.txt']);

    // 列表按聊天聚合，但每条都带发起人（前端据此分组）
    const runs = g.kernel.workRunner.list(10, chatKey);
    assert.equal(runs.length, 2);
    const byUser = new Map(runs.map((r: any) => [r.userId, r]));
    assert.ok(byUser.get('10001') && byUser.get('10002'), '两条运行要能按发起人区分');

    // 产物归属：A 只看得见自己的，B 也是
    const artA = g.kernel.workRunner.latestArtifacts(chatKey, '10001');
    const artB = g.kernel.workRunner.latestArtifacts(chatKey, '10002');
    assert.deepEqual(artA?.artifacts, ['a.txt']);
    assert.deepEqual(artB?.artifacts, ['b.txt']);
    assert.equal(artA?.userId, '10001');

    // 沙箱：产物落在各自目录里
    const rootA = g.kernel.sandbox.root({ ...chat, scope: 'u10001' });
    const rootB = g.kernel.sandbox.root({ ...chat, scope: 'u10002' });
    assert.notEqual(rootA, rootB);
  } finally {
    await g.cleanup();
  }
});

test('work 记录落库：重启后仍能列出运行并带回 events/usage（抽屉的圆环靠它）', async () => {
  const port = 30000 + (process.pid % 20000);
  const dir = mkdtempSync(join(tmpdir(), 'parallel-replay-'));
  try {
    // 第一次内核：跑一次 work（mock 每轮报 80 命中 / 20 未命中）
    {
      const { Kernel } = await import('../src/kernel/kernel.ts');
      const k = new Kernel({ dataDir: dir, noApi: true });
      const cfg = k.config.config as any;
      cfg.onebot.port = port;
      (cfg.providers as Record<string, unknown>).mock = {
        label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
        models: [{ id: 'mock-1', enabled: true }],
      };
      cfg.llm.activeProvider = 'mock';
      cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
      cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
      cfg.masterIds = ['10001'];
      await k.boot();
      const mock = (k.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
      mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '完成了', artifacts: ['out.md'] } }] });
      const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9303' };
      const r = await k.workRunner.run(workInput(chat, '10001', '做个东西'));
      assert.equal(r.ok, true);
      await k.shutdown();
      await new Promise((res) => setTimeout(res, 300));
    }

    // 第二次内核（同一 dataDir）：内存是空的，但列表要能回放出上次那条
    const { Kernel } = await import('../src/kernel/kernel.ts');
    const k2 = new Kernel({ dataDir: dir, noApi: true });
    const cfg2 = k2.config.config as any;
    cfg2.onebot.port = port + 1;
    (cfg2.providers as Record<string, unknown>).mock = {
      label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
      models: [{ id: 'mock-1', enabled: true }],
    };
    cfg2.llm.activeProvider = 'mock';
    cfg2.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
    cfg2.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
    await k2.boot();
    try {
      const runs = k2.workRunner.list(10, 'group_9303');
      assert.equal(runs.length, 1, '重启后要能从 work_runs 表回放');
      const r = runs[0];
      assert.equal(r.historical, true);
      assert.equal(r.userId, '10001', '发起人要一起落库（前端按人分组）');
      assert.deepEqual(r.artifacts, ['out.md']);
      assert.ok(Array.isArray(r.events) && r.events.length > 0, 'loop 事件要落库，重启后还能画');
      assert.ok(r.events.some((e: any) => e.kind === 'usage'), 'usage 事件要在（圆环/缓存/TPS 的数据源）');
      assert.ok(r.usage && r.usage.cacheHit > 0, '结算 usage 要落库');
      // 重启后 deliver_file 仍能找到产物（沙箱文件也还在）
      const last = k2.workRunner.latestArtifacts('group_9303', '10001');
      assert.deepEqual(last?.artifacts, ['out.md']);
    } finally {
      await k2.shutdown();
    }
  } finally {
    await new Promise((res) => setTimeout(res, 300));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* OS 回收 */ }
  }
});

test('chat 轮把每轮用量写进 agent_end（抽屉 chat 段的圆环/TPS 数据源）', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9304' };
    const chatKey = 'group_9304';
    for (const id of ['chat', 'sandbox']) g.kernel.container.setGroupState(id, chat.chatId, true, 'owner');

    const event = {
      platform: 'qq' as const, type: 'group' as const, chatId: chat.chatId,
      userId: '10001', nickname: '主人', senderRole: 'owner' as const,
      segments: [], text: '在吗', isAtMe: true, isReplyToMe: false,
      raw: null, ts: Date.now(), messageId: 'msg-usage-1',
    };
    await (g.kernel.pipeline as any).agentTurn(event, 'owner', chatKey, { userText: '在吗' });

    const tail = g.kernel.sessionLog.tail(chat.chatId, 'group', 100);
    const end = [...tail].reverse().find((e) => e.type === 'agent_end');
    assert.ok(end, '要有 agent_end');
    assert.equal(end!.lane, 'chat', 'chat 轮的条目要标成 chat 车道');
    const usage = (end!.data as any)?.usage;
    assert.ok(Array.isArray(usage) && usage.length > 0, 'agent_end 要带每轮 usage');
    assert.ok(usage[0].cacheHit > 0 && usage[0].prompt > 0, '用量要有真实数字');
    assert.ok(String((end!.data as any)?.model ?? '').includes('mock'), '要带上当时的模型标识');
  } finally {
    await g.cleanup();
  }
});

test('work 轮的会话日志条目标成 work 车道（前端才分得开两段）', async () => {
  const g = await boot(30000 + (process.pid % 20000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9305' };
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '完成' } }] });
    await g.kernel.workRunner.run(workInput(chat, '10001', '跑一下'));
    const tail = g.kernel.sessionLog.tail(chat.chatId, 'group', 100);
    const start = tail.find((e) => e.type === 'agent_start');
    const end = tail.find((e) => e.type === 'agent_end');
    assert.equal(start?.lane, 'work');
    assert.equal(end?.lane, 'work');
  } finally {
    await g.cleanup();
  }
});
