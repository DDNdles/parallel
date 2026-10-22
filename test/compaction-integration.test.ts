import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { Kernel } from '../src/kernel/kernel.ts';

/**
 * 上下文压缩的集成验证（走真实链路：Pipeline → pi-agent-core Agent → 走链流函数 → 压缩 → 会话条目树）。
 *
 * 用 mock 引擎是为了**确定性**：真模型没法可靠地造出"必须再来一轮"的场景，
 * 而压缩的触发点是"第二轮请求之前"（pi-agent-core 的 prepareNextTurn），所以必须有两轮。
 * mock 的 script 队列在这里正好用来钉住"第几轮调什么工具"。
 *
 * 断言的是三件事，缺一不可：
 *  ① 出现了 compaction 事件（阈值确实被触发）；
 *  ② 会话日志里真落了 compaction 条目（重启后历史不会又变回全文）；
 *  ③ **压缩后的那次请求里带上了摘要**（证明它真的作用到了线上请求，而不只是本地算了一下）。
 */

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

test('压缩：第二轮前触发，摘要落成会话条目，且真的进了后续请求', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-compact-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as unknown as { onebot: { port: number }; ui: { port: number } };
  cfg.onebot.port = await freePort();
  cfg.ui.port = await freePort();

  // 小窗口 + 大 reserve → 阈值压到 1000 token（pi 的 token 账里 system prompt 不计入，
  // 所以必须是**对话本身**够大：靠下面那次大工具结果把上下文顶起来）
  (kernel.config.config.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true, contextWindow: 3000 }],
  };
  kernel.config.config.llm.activeProvider = 'mock';
  kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  kernel.config.config.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  (kernel.config.config as unknown as { work: { compaction: unknown } }).work.compaction =
    { enabled: true, reserveTokens: 2000, keepRecentTokens: 200 };

  const chatId = '77001';
  const chatKey = `group_${chatId}`;
  for (const id of ['sandbox', 'work']) kernel.container.setGroupState(id, chatId, true, '1');
  await kernel.boot();

  const mock = (kernel.llm as unknown as { providers: Map<string, any> }).providers.get('mock')!;
  // 第一轮：调一个**不终止**的工具（sandbox_write），这样才会有第二轮；
  // 第二轮：用 work_finish 交差。压缩的检查点就在这两轮之间（prepareNextTurn）。
  mock.script.push({ toolCalls: [{ name: 'sandbox_write', args: { path: 'calc.txt', content: 'x'.repeat(8000) } }] });
  mock.script.push({ toolCalls: [{ name: 'sandbox_read', args: { path: 'calc.txt' } }] });
  mock.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '（mock 交付）算完了' } }] });

  try {
    // 2026-10-21：/work 删了。这里直接走 WorkRunner（压缩发生在它的 AgentLoop 里），
    // 不经 chat 派活那一轮——测试要钉的是"压缩在第二轮请求前触发"，不是派活语法。
    const chat = { platform: 'ui' as const, type: 'group' as const, chatId };
    const agent = kernel.container.workAgent();
    const tools = kernel.container.workToolsFor(chat, 'owner', agent, 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      kernel.workRunner.run({
        chat, task: '随便算点东西', userId: '1', nickname: '主人', role: 'owner',
        agent, tools, trigger: 'command', depth: 0,
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 60_000); }),
    ]);
    if (timer) clearTimeout(timer);
    assert.ok(result, 'work 轮要在 60s 内结束');

    const run = kernel.workRunner.list(5, chatKey)[0];
    const kinds = (run?.events ?? []).map((e: any) => e.kind);
      const compactions = (run?.events ?? []).filter((e: any) => e.kind === 'compaction');
    assert.ok(kinds.includes('compaction'), `要出现压缩事件，实际事件：${kinds.join(',')}`);
    assert.ok(compactions[0].summary.length > 0, '压缩事件要带摘要正文');

    // ② 会话条目树里落了压缩条目
    const proj = kernel.sessionLog.project(chatId, 'group');
    assert.ok(proj.summary, '会话日志里要有一条 compaction 条目（重启后据此重建历史）');
    assert.ok(proj.summary.includes('mock 摘要'), `摘要内容要对得上，实际：${proj.summary.slice(0, 60)}`);

    // ③ 摘要真的进了后续请求：某个带工具的请求里能看到回填的摘要包装
    assert.ok(mock.calls.length >= 3, `摘要请求也要发出去（含它的模型调用次数 ≥ 3），实际 ${mock.calls.length}`);
    const withSummary = mock.calls.filter((c: any) => c.usersJoined?.includes('历史压缩'));
    assert.ok(withSummary.length > 0,
      '压缩后的请求里要带上回填的摘要（标记【历史压缩】）');
  } finally {
    await kernel.shutdown();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上偶尔占着文件 */ }
  }
});
