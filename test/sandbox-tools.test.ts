import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================
// 沙箱文件工具（对齐 pi 的 read / edit 那套）：
//   sandbox_read 分页、sandbox_edit 精确替换、sandbox_grep、sandbox_glob
// 都走内核真实装配（插件载入 + 工具面筛选），不直接调插件内部函数。
// ============================================================

async function boot(group = '7001') {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-sbtools-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as unknown as { onebot: { port: number } };
  cfg.onebot.port = 30000 + (process.pid % 20000);
  await kernel.boot();
  const chat = { platform: 'ui', type: 'group' as const, chatId: group };
  for (const id of ['sandbox', 'work']) kernel.container.setGroupState(id, chat.chatId, true, 'owner');
  const tctx = {
    chat, role: 'owner',
    event: {
      platform: 'ui', type: 'group', chatId: chat.chatId, userId: '10001', nickname: '主人',
      segments: [], text: '', isAtMe: true, isReplyToMe: false, senderRole: 'owner', raw: null, ts: 0, role: 'owner',
    },
  } as any;
  // 沙箱工具找的是 work 面：2026-10-17 起 chat 面只收记忆读取（surface:'memory'），
  // 沙箱/委托这类工具在 chat 轮严格缺席
  const toolOf = (name: string, surface: 'chat' | 'work' = 'work') => {
    const t = kernel.container.toolsForChat(chat, 'owner', surface).find((x) => x.name === name);
    assert.ok(t, `${surface} 面缺少工具 ${name}`);
    return t!;
  };
  const call = async (name: string, args: Record<string, unknown>, surface: 'chat' | 'work' = 'work'): Promise<string> => {
    const r = await toolOf(name, surface).handler(args, tctx);
    return typeof r === 'string' ? r : r.content;
  };
  return {
    kernel, chat, tctx, toolOf, call,
    cleanup: async () => { await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('sandbox_read：长文件分页，给出续读位置；小文件不加脚注', async () => {
  const k = await boot('7001');
  try {
    const big = Array.from({ length: 250 }, (_, i) => `L${i + 1}`).join('\n');
    await k.call('sandbox_write', { path: 'big.txt', content: big });

    const head = await k.call('sandbox_read', { path: 'big.txt' });
    assert.ok(head.startsWith('L1\n'), '默认从头开始');
    assert.ok(head.includes('L200') && !head.includes('\nL201'), '默认只给 200 行');
    assert.match(head, /第 1-200 行 \/ 共 250 行；继续读用 offset=201/);

    const tail = await k.call('sandbox_read', { path: 'big.txt', offset: 201 });
    assert.ok(tail.startsWith('L201\n') && tail.includes('L250'), `续读拿到尾巴：${tail.slice(0, 40)}`);
    assert.ok(!tail.includes('\nL1\n'), '续读不重复开头');
    assert.match(tail, /第 201-250 行 \/ 共 250 行）/, '读到底就不再提示续读');

    const five = await k.call('sandbox_read', { path: 'big.txt', limit: 5 });
    assert.match(five, /^L1\nL2\nL3\nL4\nL5\n/, 'limit 生效');
    assert.match(five, /继续读用 offset=6/);

    await k.call('sandbox_write', { path: 'small.txt', content: '只有一行\n第二行' });
    const small = await k.call('sandbox_read', { path: 'small.txt' });
    assert.equal(small, '只有一行\n第二行', '一次读完的小文件与旧行为一致（无脚注）');
  } finally {
    await k.cleanup();
  }
});

test('sandbox_edit：精确替换，唯一性与不重叠都要拦', async () => {
  const k = await boot('7002');
  try {
    await k.call('sandbox_write', { path: 'code.py', content: 'alpha\nbeta\ngamma\n' });
    const one = await k.call('sandbox_edit', { path: 'code.py', edits: [{ oldText: 'beta', newText: 'BETA' }] });
    assert.match(one, /已改 code\.py：1 处/);
    assert.equal(await k.call('sandbox_read', { path: 'code.py' }), 'alpha\nBETA\ngamma\n');

    const two = await k.call('sandbox_edit', {
      path: 'code.py',
      edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'gamma', newText: 'GAMMA' }],
    });
    assert.match(two, /2 处/);
    assert.equal(await k.call('sandbox_read', { path: 'code.py' }), 'ALPHA\nBETA\nGAMMA\n');

    // 匹配不到：不静默跳过，也不退回整文件覆盖
    const missing = await k.call('sandbox_edit', { path: 'code.py', edits: [{ oldText: '不存在的行', newText: 'x' }] });
    assert.match(missing, /没匹配上/);
    assert.equal(await k.call('sandbox_read', { path: 'code.py' }), 'ALPHA\nBETA\nGAMMA\n', '失败时文件不能被动过');

    // 出现多次：要求把上下文写长
    await k.call('sandbox_write', { path: 'dup.txt', content: 'same\nsame\n' });
    const dup = await k.call('sandbox_edit', { path: 'dup.txt', edits: [{ oldText: 'same', newText: 'x' }] });
    assert.match(dup, /出现多次/);
    assert.equal(await k.call('sandbox_read', { path: 'dup.txt' }), 'same\nsame\n');

    // 范围重叠：提示合并成一次编辑
    await k.call('sandbox_write', { path: 'ov.txt', content: 'abcdef\n' });
    const ov = await k.call('sandbox_edit', {
      path: 'ov.txt',
      edits: [{ oldText: 'abc', newText: 'A' }, { oldText: 'cde', newText: 'C' }],
    });
    assert.match(ov, /重叠/);
    assert.equal(await k.call('sandbox_read', { path: 'ov.txt' }), 'abcdef\n');

    // 参数与路径的拒绝路径
    assert.match(await k.call('sandbox_edit', { path: 'code.py', edits: [] }), /edits 不能为空/);
    assert.match(await k.call('sandbox_edit', { path: 'code.py', edits: [{ oldText: '', newText: 'x' }] }), /oldText 是空的/);
    assert.match(await k.call('sandbox_edit', { path: '', edits: [{ oldText: 'a', newText: 'b' }] }), /要给 path/);
    assert.match(await k.call('sandbox_edit', { path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }), /编辑失败/);
    assert.match(await k.call('sandbox_edit', { path: '../outside.txt', edits: [{ oldText: 'a', newText: 'b' }] }), /越界/);
  } finally {
    await k.cleanup();
  }
});

test('sandbox_grep：按内容搜、按 glob 收窄、无结果与坏正则都说清楚', async () => {
  const k = await boot('7003');
  try {
    await k.call('sandbox_write', { path: 'notes.md', content: '第一行\nalpha 在这里\n最后一行' });
    await k.call('sandbox_write', { path: 'sub/deep.md', content: '开头\nalpha 也在\n结尾' });
    await k.call('sandbox_write', { path: 'sub/table.csv', content: 'k,v\nalpha,1' });

    const all = await k.call('sandbox_grep', { pattern: 'alpha' });
    assert.match(all, /notes\.md:2: alpha 在这里/);
    assert.match(all, /sub\/deep\.md:2: alpha 也在/);
    assert.match(all, /sub\/table\.csv:2: alpha,1/);
    assert.match(all, /扫了 3 个文件，命中 3 处/);

    const mdOnly = await k.call('sandbox_grep', { pattern: 'alpha', glob: '*.md' });
    assert.ok(mdOnly.includes('notes.md:2:') && mdOnly.includes('sub/deep.md:2:'), '任意层级的 .md 都搜到');
    assert.ok(!mdOnly.includes('table.csv'), 'glob 之外的被排除');

    const subOnly = await k.call('sandbox_grep', { pattern: 'alpha', path: 'sub' });
    assert.ok(subOnly.includes('sub/deep.md:2:') && !subOnly.includes('notes.md'), 'path 限定子目录');

    const cs = await k.call('sandbox_grep', { pattern: 'ALPHA', case_sensitive: true });
    assert.match(cs, /没有匹配/, '区分大小写时搜不到小写的 alpha');

    const none = await k.call('sandbox_grep', { pattern: '这辈子不会出现的串' });
    assert.match(none, /没有匹配：扫了 3 个文件/);

    assert.match(await k.call('sandbox_grep', { pattern: '(' }), /正则不合法/);
    assert.match(await k.call('sandbox_grep', { pattern: '' }), /pattern 不能为空/);
    assert.match(await k.call('sandbox_grep', { pattern: 'alpha', path: '不存在的目录' }), /搜索失败/);
  } finally {
    await k.cleanup();
  }
});

test('sandbox_glob：跨层匹配、无斜杠模式等价 **/，最近修改优先', async () => {
  const k = await boot('7004');
  try {
    await k.call('sandbox_write', { path: 'top.md', content: 'a' });
    await k.call('sandbox_write', { path: 'sub/mid.md', content: 'b' });
    await k.call('sandbox_write', { path: 'sub/mid.csv', content: 'c' });
    await k.call('sandbox_write', { path: 'docs/deep/x.csv', content: 'd' });
    // 重写 top.md：让它的 mtime 变成最新（排序断言才不依赖写入顺序的巧合）
    await k.call('sandbox_write', { path: 'top.md', content: 'a2' });

    const md = await k.call('sandbox_glob', { pattern: '**/*.md' });
    const mdLines = md.split('\n');
    assert.equal(mdLines.length, 2, `两个 md：${md}`);
    assert.ok(mdLines.some((l) => l.startsWith('top.md ')) && mdLines.some((l) => l.startsWith('sub/mid.md ')));
    assert.ok(mdLines[0].startsWith('top.md '), '刚改过的排前面');

    const csv = await k.call('sandbox_glob', { pattern: '*.csv' });
    assert.ok(csv.includes('sub/mid.csv') && csv.includes('docs/deep/x.csv'), `无斜杠 = 任意层级：${csv}`);

    const scoped = await k.call('sandbox_glob', { pattern: '*', path: 'sub' });
    assert.ok(scoped.includes('sub/mid.md') && scoped.includes('sub/mid.csv'));
    assert.ok(!scoped.includes('top.md'), 'path 限定了起点');

    assert.match(await k.call('sandbox_glob', { pattern: '**/*.nope' }), /没有匹配/);
    assert.match(await k.call('sandbox_glob', { pattern: '  ' }), /pattern 不能为空/);
  } finally {
    await k.cleanup();
  }
});

test('todo：按 run 隔离、有上限、清单挂进 work system 分节', async () => {
  const k = await boot('7005');
  try {
    const tctxA = { ...k.tctx, work: { depth: 0, runId: 'work_A', agent: 'work' } } as any;
    const tctxB = { ...k.tctx, work: { depth: 0, runId: 'work_B', agent: 'work' } } as any;
    const todo = k.toolOf('todo', 'work');
    const call = async (tctx: any, args: Record<string, unknown>) => {
      const r = await todo.handler(args, tctx);
      return typeof r === 'string' ? r : r.content;
    };

    const first = await call(tctxA, { items: [{ text: '查资料', status: 'done' }, { text: '算一遍', status: 'in_progress' }, { text: '写报告', status: 'pending' }] });
    assert.match(first, /- \[x\] 查资料/);
    assert.match(first, /- \[~\] 算一遍/);
    assert.match(first, /- \[ \] 写报告/);
    assert.match(first, /共 3 条，剩 2 条未完成/);

    // 另一个 run 看不到 A 的清单（按 runId 隔离）
    const empty = await call(tctxB, { items: [] });
    assert.match(empty, /清单已清空/);

    const hookReq = (runId: string, tools: unknown[]) => ({
      chat: k.chat, event: k.tctx.event, system: '', messages: [], tools,
      workTurn: true, workRunId: runId, systemSections: [],
    }) as any;
    const withA = await k.kernel.container.runWorkHooks(hookReq('work_A', [todo]));
    const sectionA = withA.systemSections!.find((s) => s.name === 'work-todo');
    assert.ok(sectionA, 'A 的清单该作为分节注入');
    assert.match(sectionA!.text, /- \[~\] 算一遍/);
    assert.equal(sectionA!.order, 660);

    const withB = await k.kernel.container.runWorkHooks(hookReq('work_B', [todo]));
    assert.ok(!withB.systemSections!.some((s) => s.name === 'work-todo'), 'B 没有清单就不加节');

    const withoutTool = await k.kernel.container.runWorkHooks(hookReq('work_A', [{ name: 'work_finish' }]));
    assert.ok(!withoutTool.systemSections!.some((s) => s.name === 'work-todo'), '工具面里没有 todo 就不该提清单');

    // 上限：多的截掉并说明；越界状态归一到 pending
    const many = await call(tctxA, { items: Array.from({ length: 25 }, (_, i) => ({ text: `T${i + 1}`, status: 'weird' })) });
    assert.match(many, /只保留前 20 条/);
    assert.equal(many.split('\n').filter((l) => l.startsWith('- [ ')).length, 20);
    assert.match(many, /共 20 条，剩 20 条未完成/);

    // 清空后分节也要跟着消失
    await call(tctxA, { items: [] });
    const afterClear = await k.kernel.container.runWorkHooks(hookReq('work_A', [todo]));
    assert.ok(!afterClear.systemSections!.some((s) => s.name === 'work-todo'));
  } finally {
    await k.cleanup();
  }
});

// ============================================================
// work_ask：把"卡住了"做成一个正式结局（不是交付，也不是失败）
// ============================================================

test('work_ask：work 面可见、chat 面缺席；空问题被拒；提问带 meta.awaiting', async () => {
  const k = await boot('7004');
  try {
    // chat 面在收集阶段就看不到它（surface:'work'）
    assert.equal(
      k.kernel.container.toolsForChat(k.chat, 'owner').find((t) => t.name === 'work_ask'),
      undefined,
      'chat 面不该有 work_ask',
    );

    const t = k.toolOf('work_ask', 'work');
    assert.equal(t.minRole, 'admin');
    assert.ok(t.promptSnippet, '工具清单里要看得见它');
    assert.ok(t.promptGuidelines?.length, '规则节由它自己带');

    // 空问题：拒绝，且不能收尾（模型必须重问或去干活）
    const bad = await t.handler({ question: '   ' }, k.tctx) as any;
    assert.match(bad.content, /提问被拒绝/);
    assert.equal(bad.terminate, undefined);

    const ok = await t.handler({ question: '用哪份文件？', notes: '已把 inbox 列出来' }, k.tctx) as any;
    assert.equal(ok.terminate, true, '提问即结束本次任务（等发起者回答）');
    assert.equal(ok.meta.awaiting, true, '内核据这个 meta 判"不是干完了"');
    assert.equal(ok.meta.question, '用哪份文件？');
    assert.equal(ok.meta.notes, '已把 inbox 列出来');
    assert.equal(ok.finalReply, '## 待确认\n用哪份文件？\n\n## 已做到\n已把 inbox 列出来');
  } finally {
    await k.cleanup();
  }
});
