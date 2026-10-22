import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// work 并发分配：3 个任务同时跑 → 3 个不同的链上模型；
// 每个任务自己的替代链仍从它那个槽起绕一圈（由 chainStreamFn 的 start 保证）。
// ============================================================

test('work 并发：三个任务分到三个不同模型，跑完槽位释放', async () => {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-work-slots-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = 30000 + (process.pid % 20000);
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [
      { id: 'mock-1', enabled: true },
      { id: 'mock-2', enabled: true },
      { id: 'mock-3', enabled: true },
    ],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [
    { provider: 'mock', model: 'mock-1' },
    { provider: 'mock', model: 'mock-2' },
    { provider: 'mock', model: 'mock-3' },
  ];
  await kernel.boot();
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9604' };
    const agent = kernel.container.workAgent();
    const tools = kernel.container.workToolsFor(chat, 'owner', agent, 0);
    const mock = (kernel.llm as any).providers.get('mock');
    const run = (n: number) => kernel.workRunner.run({
      chat, task: `并发任务 ${n}`, taskLabel: `并发任务 ${n}`, userId: '10001', nickname: 'A',
      role: 'owner', agent, tools, trigger: 'command', depth: 0,
    });
    // 三次 run 同步领槽后再各自等模型；脚本一步收尾
    for (let i = 0; i < 3; i++) mock.script.push({ content: 'ok', toolCalls: [{ name: 'work_finish', args: { summary: 'ok' } }] });
    const results = await Promise.all([run(1), run(2), run(3)]);
    const models = results.map((r) => r.model).sort();
    assert.deepEqual(models, ['mock:mock-1', 'mock:mock-2', 'mock:mock-3'], `三个任务应分到三个模型：${models}`);

    // 全部结束后槽位清零：第四个任务重新从第一个模型起（游标轮转后回到 0）
    mock.script.push({ content: 'ok', toolCalls: [{ name: 'work_finish', args: { summary: 'ok' } }] });
    const fourth = await run(4);
    assert.equal(fourth.model, 'mock:mock-1');
  } finally {
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
