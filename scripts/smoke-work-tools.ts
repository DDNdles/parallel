/**
 * work 面工具冒烟：真实内核 + 假协议端 + Docker 沙箱，逐个调用（不是只查注册表）。
 *
 * 用法：node --experimental-transform-types --no-warnings scripts/smoke-work-tools.ts
 *
 * 覆盖 agents/work.md 白名单里的全部工具；web_search 需要 Tavily key，
 * 没配时只验证工具在、能给出明确不可用提示（标 ENV，不算故障）。
 * 浏览器用沙箱里自建的 HTML 页面，不依赖外网。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/kernel.ts';
import { resolveWorkAgent } from '../src/kernel/work-agent.ts';
import { workScopeOf } from '../src/kernel/services/work.ts';
import { MockOneBot } from '../test/helpers/mock-onebot.ts';

type Status = 'PASS' | 'ENV' | 'FAIL';
interface Row { name: string; status: Status; ms: number; detail: string }
const rows: Row[] = [];
const add = (name: string, status: Status, ms: number, detail: string): void => {
  rows.push({ name, status, ms, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 160) });
};

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms))]);

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-smoke-work-'));
  const onebotPort = 30000 + (process.pid % 20000);
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = onebotPort;
  cfg.masterIds = ['10001'];
  cfg.sandbox.runtime = 'docker';
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.risk.replyRatePerMin = 10_000;
  await kernel.boot();

  const chatId = '9500';
  const rawChat = { platform: 'qq' as const, type: 'group' as const, chatId };
  for (const lp of kernel.container.list()) {
    kernel.container.setGroupState(lp.manifest.id, chatId, true, 'smoke');
  }
  const chat = { ...rawChat, scope: workScopeOf('10001') };
  const tctx = {
    chat,
    role: 'owner',
    event: {
      platform: 'qq', type: 'group', chatId, userId: '10001', nickname: 'Smoke',
      segments: [], text: '', isAtMe: true, isReplyToMe: false, senderRole: 'owner',
      raw: null, ts: Date.now(), role: 'owner',
    },
    work: { runId: 'smoke-run', depth: 0 },
  } as any;

  const mock = new MockOneBot(`ws://127.0.0.1:${onebotPort}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !mock.actions.some((a) => a.action === 'get_login_info')) {
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 300));

  // 1) 白名单 vs 实际注册：work 轮真正能看到的工具
  const agent = resolveWorkAgent({ pluginDir: join(process.cwd(), 'src/plugins/work') });
  const tools = kernel.container.workToolsFor(chat, 'owner', agent, 0);
  const registered = new Map(tools.map((t) => [t.name, t]));
  const wanted = agent.tools ?? [];
  const missing = wanted.filter((n) => !registered.has(n));
  add('-- 白名单注册', missing.length ? 'FAIL' : 'PASS', 0,
    `${tools.length} 个工具；缺：${missing.join(',') || '无'}`);
  const chatTools = kernel.container.toolsForChat(rawChat, 'owner', 'chat').map((t) => t.name);
  const chatWant = ['work_dispatch', 'work_status', 'deliver_file'].filter((n) => !chatTools.includes(n));
  add('-- chat 侧入口', chatWant.length ? 'FAIL' : 'PASS', 0,
    `work_dispatch/work_status/deliver_file ${chatWant.length ? `缺 ${chatWant.join(',')}` : '都在'}`);

  const call = async (name: string, args: Record<string, unknown>, timeoutMs = 150_000): Promise<{ text: string; raw: any }> => {
    const t = registered.get(name);
    if (!t) throw new Error(`工具不存在：${name}`);
    const started = Date.now();
    try {
      const r: any = await withTimeout(Promise.resolve(t.handler(args, tctx)), timeoutMs, name);
      const text = typeof r === 'string' ? r : String(r?.content ?? '');
      add(name, 'PASS', Date.now() - started, text || '（空返回）');
      return { text, raw: r };
    } catch (e) {
      add(name, 'FAIL', Date.now() - started, (e as Error).message);
      throw e;
    }
  };
  const expect = (name: string, text: string, needle: string | RegExp): void => {
    const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
    if (!ok) {
      const row = rows.find((r) => r.name === name && r.status === 'PASS');
      if (row) { row.status = 'FAIL'; row.detail = `结果不符（期望 ${needle}）：${row.detail}`; }
    }
  };

  try {
    // 2) 任务清单 + 沙箱文件工具
    const todos = await call('todo', {
      items: [{ text: '写冒烟文件', status: 'done' }, { text: '跑完全部工具', status: 'in_progress' }],
    });
    expect('todo', todos.text, /剩 1 条未完成/);
    await call('sandbox_write', { path: 'smoke/hello.txt', content: 'hello\nworld\n中文行\n' });
    const rd = await call('sandbox_read', { path: 'smoke/hello.txt' });
    expect('sandbox_read', rd.text, 'world');
    const ed = await call('sandbox_edit', { path: 'smoke/hello.txt', edits: [{ oldText: 'world', newText: 'parallel' }] });
    expect('sandbox_edit', ed.text, '已改');
    const gr = await call('sandbox_grep', { pattern: 'parallel', path: 'smoke' });
    expect('sandbox_grep', gr.text, 'hello.txt');
    const gl = await call('sandbox_glob', { pattern: '**/*.txt', path: 'smoke' });
    expect('sandbox_glob', gl.text, 'hello.txt');
    const ls = await call('sandbox_list', { path: 'smoke' });
    expect('sandbox_list', ls.text, 'hello.txt');

    // 3) 一次性执行（都强制在 Docker 容器里）
    const py = await call('run_python', { code: 'print(1 + 1)' });
    expect('run_python', py.text, /2/);
    const js = await call('run_js', { code: 'console.log(6 * 7)' });
    expect('run_js', js.text, /42/);
    const bash = await call('run_bash', { command: 'echo smoke-bash' });
    expect('run_bash', bash.text, 'smoke-bash');
    // work 容器联网 + 镜像里的 node（2026-10-24 起）：一条命令同时验两样
    const net = await call('run_bash', { command: 'node --version && curl -fsS -m 10 https://example.com -o /dev/null && echo NET-OK' });
    expect('run_bash', net.text, /NET-OK/);
    // shell 顺手写文件：执行前后快照要比出 +N -M（工作页逐行显示）
    const bashWrite = await call('run_bash', { command: "printf 'alpha\\nbeta\\n' > smoke/from-bash.txt" });
    expect('run_bash', bashWrite.text, '文件改动');
    const ch1 = (bashWrite.raw?.meta?.changes ?? []).find((c: any) => c.path === 'smoke/from-bash.txt');
    add('-- 文件改动', ch1 && ch1.added === 2 && ch1.removed === 0 ? 'PASS' : 'FAIL', 0,
      ch1 ? `+${ch1.added} -${ch1.removed}` : '没有从 run_bash 拿到 changes');
    const bashEdit = await call('run_bash', { command: "printf 'alpha\\nbeta\\ngamma\\n' > smoke/from-bash.txt" });
    const ch2 = (bashEdit.raw?.meta?.changes ?? []).find((c: any) => c.path === 'smoke/from-bash.txt');
    add('-- 文件改动(改)', ch2 && ch2.added === 1 && ch2.removed === 0 ? 'PASS' : 'FAIL', 0,
      ch2 ? `+${ch2.added} -${ch2.removed}` : '没有从 run_bash 拿到 changes');
    const pyw = await call('run_python_work', { code: 'print("smoke-python")' });
    expect('run_python_work', pyw.text, 'smoke-python');

    // 4) 常驻 Python 会话（变量跨调用保留）+ 重置
    const s1 = await call('python_session', { code: 'kept = "会话变量"\nprint(kept)' });
    expect('python_session', s1.text, '会话变量');
    const s2 = await call('python_session', { code: 'print(kept)' });
    expect('python_session', s2.text, '会话变量');
    const reset = await call('python_session_reset', {});
    expect('python_session_reset', reset.text, '重置');

    // 5) 浏览器：本页自带表单，按快照编号点击、输入、截图
    await call('sandbox_write', {
      path: 'smoke/page.html',
      content: [
        '<!doctype html><html><head><meta charset="utf-8"><title>smoke page</title></head><body>',
        '<h1 id="h">Smoke</h1>',
        '<a href="#done">Go</a>',
        '<input id="i" placeholder="type here">',
        '<button onclick="document.getElementById(\'h\').textContent=document.getElementById(\'i\').value">Set</button>',
        '</body></html>',
      ].join('\n'),
    });
    const abs = join(kernel.sandbox.root(chat), 'smoke/page.html').replace(/\\/g, '/');
    const fileUrl = `file:///${abs.replace(/^\//, '')}`;
    const open = await call('browser_open', { url: fileUrl }, 180_000);
    expect('browser_open', open.text, /Smoke/);
    const snap = await call('browser_snapshot', {}, 120_000);
    const btn = snap.text.split('\n').find((l) => l.includes('<button') && l.includes('Set')) ?? '';
    const idx = Number(btn.match(/\[(\d+)\]/)?.[1]);
    if (!Number.isFinite(idx)) {
      const row = rows.find((r) => r.name === 'browser_snapshot');
      if (row) { row.status = 'FAIL'; row.detail = `快照里找不到按钮编号：${snap.text.slice(0, 120)}`; }
    } else {
      const typed = await call('browser_type', { selector: '#i', text: 'hello-browser' }, 120_000);
      expect('browser_type', typed.text, /hello-browser|已输入|typed/i);
      const clicked = await call('browser_click', { index: idx }, 120_000);
      expect('browser_click', clicked.text, /hello-browser/);
      const pressed = await call('browser_press', { key: 'Escape' }, 120_000);
      expect('browser_press', pressed.text, /Smoke|hello-browser/);
      const shot = await call('browser_screenshot', {}, 120_000);
      assertShot(shot);
    }

    // 6) 联网
    const fetched = await call('web_fetch', { urls: ['https://example.com'] }, 60_000);
    expect('web_fetch', fetched.text, /Example Domain|example/i);
    {
      const t = registered.get('web_search');
      if (!t) add('web_search', 'FAIL', 0, '工具未注册');
      else {
        const started = Date.now();
        const r: any = await Promise.resolve(t.handler({ query: 'parallel bot' }, tctx));
        const text = typeof r === 'string' ? r : String(r?.content ?? '');
        const env = text.includes('用不了') || text.includes('密钥');
        add('web_search', env ? 'ENV' : 'PASS', Date.now() - started, text);
      }
    }

    // 7) 长期记忆读取
    const facts = await call('recall_facts', { query: '喜欢' });
    expect('recall_facts', facts.text, /没有相关记忆|找到的记忆/);

    // 8) 发文件：send_file 已随 2026-10-23 的交付链路改版删除（产物由内核打包 zip 发「工作交付」），
    //    这里只验证它确实不在 work 面上
    add('-- send_file 已删', registered.has('send_file') ? 'FAIL' : 'PASS', 0,
      registered.has('send_file') ? 'send_file 还在 work 面上' : '已随交付改版删除');

    // 9) 子代理委派（mock 模型：子代理一轮就 work_finish）
    const mockEngine = (kernel.llm as any).providers.get('mock');
    mockEngine.script.push({ content: '子代理处理完毕', toolCalls: [{ name: 'work_finish', args: { summary: '子代理交付完成' } }] });
    const del = await call('delegate', { agent: 'data', task: '统计 1+1 并交付' }, 90_000);
    expect('delegate', del.text, '子代理交付完成');

    // 10) 收尾工具
    const fin = await call('work_finish', { summary: '冒烟完成', artifacts: ['smoke/hello.txt'], notes: '无' });
    if (fin.raw?.terminate !== true) {
      const row = rows.find((r) => r.name === 'work_finish');
      if (row) { row.status = 'FAIL'; row.detail = '没有 terminate:true'; }
    }
    const ask = await call('work_ask', { question: '要继续吗？', notes: '已写好 hello.txt' });
    if (ask.raw?.terminate !== true || ask.raw?.meta?.awaiting !== true) {
      const row = rows.find((r) => r.name === 'work_ask');
      if (row) { row.status = 'FAIL'; row.detail = '缺少 terminate/awaiting 标记'; }
    }
  } finally {
    try { mock.close(); } catch { /* ignore */ }
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // 报表
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  console.log('\n===== work 工具冒烟 =====');
  for (const r of rows) {
    console.log(`${pad(r.status, 5)} ${pad(r.name, 22)} ${pad(`${r.ms}ms`, 9)} ${r.detail}`);
  }
  const fails = rows.filter((r) => r.status === 'FAIL');
  const envs = rows.filter((r) => r.status === 'ENV');
  console.log(`\n合计 ${rows.length}：PASS ${rows.length - fails.length - envs.length} / ENV ${envs.length} / FAIL ${fails.length}`);
  if (fails.length) process.exitCode = 1;
}

function assertShot(shot: { text: string; raw: any }): void {
  const images = shot.raw?.images;
  if (!Array.isArray(images) || !images.length) {
    const row = rows.find((r) => r.name === 'browser_screenshot');
    if (row) { row.status = 'FAIL'; row.detail = `没有返回图片：${shot.text.slice(0, 100)}`; }
  }
}

main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exitCode = 1;
});
