import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_WORK_AGENT } from '../src/kernel/work-agent.ts';

// ============================================================
// work 轮的「强制 work_finish 才完成」（2026-10-25 用户定）：
//  - 纯文字轮（没调任何工具）不再让任务自然结束；
//  - 等 idleRemindMs 还没有下文 → 内核提醒「继续执行或调 work_finish」，最多 5 次；
//  - 提醒满限仍只发文字 → ok=false 按未完成处理，不能拿一句旁白假装成功。
// 注意工具面要用真实的 workToolsFor：传空数组时 work_finish 根本不在面上，
// 「Tool not found」照样能把 run 推成 ok=true（旧假完成路径就是这么漏的）。
// ============================================================

async function boot(port: number) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-idle-'));
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
  await kernel.boot();
  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  return {
    kernel, dataDir, mock,
    cleanup: async () => {
      await kernel.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const workInput = (chatId: string, task: string, idleRemindMs: number, tools: any[]) => ({
  chat: { platform: 'qq' as const, type: 'group' as const, chatId },
  task, taskLabel: task, userId: '10001', nickname: '群友10001', role: 'owner',
  tools, trigger: 'command' as const, depth: 0, idleRemindMs,
});

test('work 旁白被提醒拉回：纯文字轮后内核提醒，模型随即 work_finish 正常交付', async () => {
  const g = await boot(31000 + (process.pid % 9000));
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9401' };
    const tools = g.kernel.container.workToolsFor(chat, 'owner', DEFAULT_WORK_AGENT, 0);
    assert.ok(tools.some((t) => t.name === 'work_finish'), 'work 面必须带 work_finish');
    g.kernel.sandbox.write({ ...chat, scope: 'u10001' }, 'out.md', '# 结果\n');
    // 第一轮只发旁白（无工具调用）→ 内核等 80ms 提醒 → 第二轮才 work_finish
    g.mock.script.push({ content: '我先看看沙箱里已有的进度。' });
    g.mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '做完了', artifacts: ['out.md'] } }] });

    const r = await g.kernel.workRunner.run(workInput('9401', '做个东西', 80, tools));
    assert.equal(r.ok, true, `应成功：${r.error ?? ''}`);
    assert.deepEqual(r.artifacts, ['out.md']);
    assert.equal(r.awaiting, undefined);
    // 提醒要留在事件流里（工作页能看到内核拉了它一把）
    const run = g.kernel.workRunner.list(1, 'group_9401')[0];
    assert.ok(
      run.events.some((e: any) => e.kind === 'text' && String(e.text).includes('内核提醒')),
      '事件流里要有内核提醒',
    );
  } finally {
    await g.cleanup();
  }
});

test('work 始终只发旁白：提醒满 5 次仍不收尾 → 按未完成处理（ok=false）', async () => {
  const g = await boot(31000 + (process.pid % 9000) + 1);
  try {
    const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9402' };
    const tools = g.kernel.container.workToolsFor(chat, 'owner', DEFAULT_WORK_AGENT, 0);
    // 只给一条旁白；之后的模型调用走 mock 默认回声（同样是纯文字），
    // 5 次提醒耗尽 → finished=false → WorkRunner 判未完成
    g.mock.script.push({ content: '我打算接下来把篱笆改成绿篱，并调深颜色。' });

    const r = await g.kernel.workRunner.run(workInput('9402', '做个东西', 30, tools));
    assert.equal(r.ok, false, '提醒满限仍不 work_finish 不能算成功');
    assert.match(r.error ?? '', /未调用 work_finish/, '错误要说明是没调 work_finish');
    assert.ok((r.summary ?? '').length > 0, '最后的旁白要留在摘要里');
    const run = g.kernel.workRunner.list(1, 'group_9402')[0];
    const reminds = run.events.filter((e: any) => e.kind === 'text' && String(e.text).includes('内核提醒'));
    assert.equal(reminds.length, 5, `应恰好提醒 5 次，实际 ${reminds.length}`);
  } finally {
    await g.cleanup();
  }
});
