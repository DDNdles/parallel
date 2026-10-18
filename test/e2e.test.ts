import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import type { MockEngine } from '../src/kernel/services/mock-engine.ts';
import { MockOneBot } from './helpers/mock-onebot.ts';
import { SandboxError } from '../src/kernel/services/sandbox.ts';

/**
 * 端到端：真实内核 + 模拟协议端（MockOneBot），不插真 QQ 号验证主流程。
 */
let kernel: Kernel;
let dataDir: string;
let mock: MockOneBot;
let mockProvider: MockEngine;

const GROUP = 123;
const MEMBER = 10001;
const MASTER = 9999;

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 15000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待 ${what} 超时`);
}

/** 等协议端动作安静下来（连发分片、上一用例遗留的轮次都结束），再开始下一段断言 */
async function quiesce(idleMs = 300, maxMs = 8000): Promise<void> {
  const start = Date.now();
  let last = mock.actions.length;
  let since = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (mock.actions.length !== last) { last = mock.actions.length; since = Date.now(); continue; }
    if (Date.now() - since >= idleMs) return;
  }
}

/** 用例之间共库：先把这个号的事实清干净，别拿"上一条用例留下的条数"当基线 */
function wipeFacts(userId: number): void {
  const ids = kernel.memory.topFacts(String(userId), 200).map((f) => f.id);
  if (ids.length) kernel.memory.deleteFacts(String(userId), ids);
}

const ONEBOT_PORT = 30000 + (process.pid % 20000); // 随机端口避免并发测试/残留进程冲突
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-e2e-'));
  kernel = new Kernel({ dataDir, noApi: true });
  // 加速：限速放开 + 主人配置
  // 限速按条计费（一轮回复拆成几条就吃几个令牌），默认值 12 条/分钟是这个文件里几十条断言的量级 ——
  // 不放开的话跑到后半程桶就空了，消息被静默丢弃，后面几条用例会莫名其妙地超时。
  // 两处都要写：写 config 是为了扛住中途 saveConfig 触发的 configChanged 热更新。
  kernel.config.config.risk.replyRatePerMin = 10_000;
  kernel.chat.setRatePerMin(10_000);
  // 拟人层在测试里要确定性：把打字延迟压到 HDSI 的下限（公式不可关闭，最低 250ms/条），
  // 基础延迟与上限归零、抖动归零。拆分开关保持打开 —— 但只有模型写了分隔标记才会分多条。
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingBaseDelaySeconds = 0;
  hlOut.typingMaxDelaySeconds = 0;
  hlOut.typingJitterRatio = 0;
  kernel.config.config.onebot.port = ONEBOT_PORT;
  // 协议端托管只在带桌面端的内核里跑（见 kernel.boot 的 noApi 判断）：测试内核用 MockOneBot
  // 顶替，真托管会在临时目录下载 89MB 发行包，抢磁盘/网络并在首个 agent loop 窗口里制造偶发超时（历史 flake 根因）。
  kernel.config.config.masterIds = [String(MASTER)];
  // 预置里没有 Mock 供应商了（模型页不再列测试用项）：测试自己挂一个脚本供应商
  (kernel.config.config.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  kernel.config.config.llm.activeProvider = 'mock';
  // 两条链各自独立、不再互相跟随（work 链空 = /work 没有模型），测试显式配满两条
  kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  kernel.config.config.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  mockProvider = (kernel.llm as unknown as { providers: Map<string, MockEngine> }).providers.get('mock')!;
  await kernel.boot();
  mock = new MockOneBot(`ws://127.0.0.1:${ONEBOT_PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, 'get_login_info');
});

// 用例共用一个群，拟人层会把"决定不回"的消息攒在缓冲里；上一条用例的攒货不能漏到下一条，
// 否则一条旧消息会在后面的用例里突然触发一轮回复。每个用例开始前清空攒货与计时器。
beforeEach(() => { kernel.humanlike.resetAll(); });

after(async () => {
  mock.close();
  await kernel.shutdown();
  // Windows 上内核仍有异步尾部（容器清理/TTL 扫描）短暂持有句柄：给 300ms 余量，
  // 清不掉就放弃（临时目录由 OS 回收），避免 cleanup 竞态把整套用例判 fail。
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temp 目录系统会回收 */ }
});

// ============================================================
// 1. 协议端接入：access token 鉴权
// ============================================================

test('拒绝错误 token 的协议端连接', async () => {
  const bad = new MockOneBot(`ws://127.0.0.1:${ONEBOT_PORT}/onebot`, 'wrong-token');
  try {
    await bad.connect();
    // open 先触发的情况：服务端在握手后立即以 1008 踢掉
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('错误 token 连接未被踢掉')), 3000);
      bad.ws!.on('close', () => { clearTimeout(t); resolve(); });
    });
  } catch {
    /* 连接直接被拒绝（期望路径之一） */
  }
  assert.equal(bad.connected, false, '错误 token 的连接不应保持打开');
});

// ============================================================
// 2. 主流程：@机器人 → AgentLoop → 回复（含工具调用）
// ============================================================

test('群聊 @机器人触发完整 agent loop（记忆查询 + 回复）', async () => {
  // 开启 chat + sandbox 插件（管理员通过模拟命令开，这里直接容器操作等价）
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  kernel.container.setGroupState('sandbox', String(GROUP), true, String(MASTER));

  // chat 工具面 2026-10-17 起 = 记忆读写三件套：sandbox 这类行为工具在 chat 轮严格缺席
  const chatTools = kernel.container
    .toolsForChat({ platform: 'qq', type: 'group', chatId: String(GROUP) }, 'member')
    .map((t) => t.name).sort();
  assert.deepEqual(chatTools, ['recall_facts', 'remember_setting', 'search_history'], `chat 面只该有记忆读写: ${chatTools}`);

  // 脚本：先调一次记忆查询（chat 面的工具），拿到结果后作答
  mockProvider.script.push({
    toolCalls: [{ name: 'recall_facts', args: { query: '2^10' } }],
  }, {
    content: '喵！是 1024 哦～',
  });

  const mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: ' 帮我算下 2^10', atMe: true, nickname: '小明' });
  const reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /1024/);
  assert.match(reply, /喵/);

  // 工具确实跑过：会话日志应有 tool_call/tool_result
  await quiesce();
  const tail = kernel.sessionLog.tail(String(GROUP), 'group', 50);
  assert.ok(tail.some((e) => e.type === 'tool_call' && e.text === 'recall_facts'));
  assert.ok(tail.some((e) => e.type === 'tool_result' && String(e.data?.result ?? '').includes('记忆')));
});

// ============================================================
// 3. 分群开关后果严格成立（红线 §2.4）
// ============================================================

test('群禁用的插件：工具缺席（命令面已整体清空）', async () => {
  mock.actions.length = 0;
  // 2026-10-17 起 chat 面只收记忆读取：插件工具（web_search 这类）一律不进 chat 轮，
  // 分群开关只作用于 work 面 —— 这里两面分别验证。
  const chatRef = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  kernel.container.setGroupState('web-search', String(GROUP), false, String(MASTER));
  const chatToolsOff = kernel.container.toolsForChat(chatRef, 'member').map((t) => t.name);
  assert.ok(!chatToolsOff.includes('web_search'), `chat 面不该有 web_search: ${chatToolsOff}`);
  const workOff = kernel.container.toolsForChat(chatRef, 'member', 'work').map((t) => t.name);
  assert.ok(!workOff.includes('web_search'), `未开启的插件其工具在 work 面也要缺席: ${workOff}`);

  // 开启后：work 面出现；chat 面仍然没有（chat 面是白名单口径，恒不含插件工具）
  kernel.container.setGroupState('web-search', String(GROUP), true, String(MASTER));
  const workOn = kernel.container.toolsForChat(chatRef, 'member', 'work').map((t) => t.name);
  assert.ok(workOn.includes('web_search'), `开启后 work 面应出现: ${workOn}`);
  const chatOn = kernel.container.toolsForChat(chatRef, 'member').map((t) => t.name);
  assert.ok(!chatOn.includes('web_search'), `chat 面恒不含插件工具: ${chatOn}`);

  // 关闭后：连命令表里也查不到它的命令（2026-10-17 指令面整体清空后，内建命令表本就是空的）
  kernel.container.setGroupState('web-search', String(GROUP), false, String(MASTER));
  assert.equal(
    kernel.container.commandsForChat(chatRef, 'member').filter((c) => c.pluginId === 'web-search').length,
    0, 'web-search 的 /搜索 已随指令面清空删除',
  );

  // 全局运行时停用 → 所有群所有角色都不可见
  await kernel.container.setRuntimeEnabled('web-search', false);
  assert.equal(kernel.container.toolsForChat(chatRef, 'owner', 'work').filter((t) => t.name === 'web_search').length, 0);
  await kernel.container.setRuntimeEnabled('web-search', true);
  mock.actions.length = 0;
});

// ============================================================
// 4. 指令面（2026-10-17 用户明令）：/work 以外全删
// ============================================================

test('QQ 指令面只剩 /work：旧的 /帮助 /人格 /设定 /搜索 一律未知命令', async () => {
  mock.actions.length = 0;

  // 内建命令表已清空（注册表留着给用户插件用；本仓库没有注册命令的用户插件）
  const cmds = kernel.container.commandsForChat({ platform: 'qq', type: 'group', chatId: String(GROUP) }, 'owner');
  assert.equal(cmds.length, 0, `内建命令表应为空，实得: ${cmds.map((c) => c.def.name).join(', ')}`);

  // 主人发旧指令也只是「未知命令」——没有哪个被留成隐藏入口
  for (const text of ['/帮助', '/人格', '/设定', '/搜索 猫']) {
    const mark = mock.actions.length;
    mock.sendGroupMessage({ groupId: GROUP, userId: MASTER, text, nickname: '主人' });
    const reply = await mock.waitForReply(GROUP, 8000, mark);
    assert.match(reply, /未知命令/, `${text} 该按未知命令处理：${reply}`);
  }

  // 普通成员视角同样只有「未知命令」（不泄露存在性）
  let mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/帮助', nickname: '小明' });
  let reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.equal(reply.trim(), '未知命令', `普通成员旧指令该得到统一未知命令：${reply}`);

  // /work 仍在：管理员门槛 + 空任务给用法
  mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/work 算点什么', nickname: '小明' });
  reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /权限不足/, `/work 仍要管理员：${reply}`);

  mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MASTER, text: '/work', nickname: '主人' });
  reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /用法：\/work/, `/work 无任务该给用法：${reply}`);
  mock.actions.length = 0;
});

// ============================================================
// 5. 用户记忆：FTS 检索 + 忘记我
// ============================================================

test('记忆服务：添加/检索/忘记', () => {
  kernel.memory.addFact(String(MEMBER), { content: '喜欢的乐队是万人谜', sourcePlugin: 'test' });
  kernel.memory.addFact(String(MEMBER), { content: '约定周末一起打游戏', sourcePlugin: 'test' });
  const hits = kernel.memory.searchFacts(String(MEMBER), '乐队', 5);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].content, /万人谜/);
  // 忘记我：清空事实
  kernel.memory.forget(String(MEMBER));
  assert.equal(kernel.memory.searchFacts(String(MEMBER), '乐队', 5).length, 0);
});

test('QQ 侧不再有清除记忆的入口：/忘记我 当未知命令处理，记忆不动', async () => {
  kernel.memory.addFact(String(MEMBER), { content: '爱吃香菜', sourcePlugin: 'test' });
  mock.actions.length = 0;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/忘记我', nickname: '小明' });
  const reply = await mock.waitForReply(GROUP);
  assert.match(reply, /未知命令|没有这个命令|不认识/);
  assert.equal(kernel.memory.topFacts(String(MEMBER), 10).length, 1, '群里一句话清不掉记忆');
  mock.actions.length = 0;
});

test('chat 工具面 = 记忆读写三件套：行为型工具（forget_me / remember_fact / plan_schedule / reply_quote）已删', () => {
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  const names = kernel.container
    .toolsForChat({ platform: 'qq', type: 'group', chatId: String(GROUP) }, 'member')
    .map((t) => t.name).sort();
  assert.deepEqual(names, ['recall_facts', 'remember_setting', 'search_history'], `chat 面只该有记忆读写: ${names}`);
  // 忘记走桌面端用户页（记忆服务层），模型侧不再有入口；用户事实写入由后台自动提炼承担
  for (const gone of ['forget_me', 'remember_fact', 'plan_schedule', 'reply_quote']) {
    assert.ok(!names.includes(gone), `${gone} 不该再出现在 chat 面`);
  }
});

test('演化层：remember_setting 写得进、一轮只收一条，work 面严格缺席', async () => {
  // work 面（入口 agent 的取法，不挂白名单）也不该看见它——work 轮不套人格，演化层在那种语境里没有意义
  const workNames = kernel.container
    .toolsForChat({ platform: 'qq', type: 'group', chatId: String(GROUP) }, 'member', 'work')
    .map((t) => t.name);
  assert.ok(!workNames.includes('remember_setting'), `work 面不该有 remember_setting: ${workNames}`);

  const key = 'overlay:whale-girl';
  kernel.db.run('DELETE FROM plugin_kv WHERE plugin_id=? AND key=?', 'chat', key);   // 清干净再看写入
  const overlay = () => {
    const row = kernel.db.get<{ value: string }>('SELECT value FROM plugin_kv WHERE plugin_id=? AND key=?', 'chat', key);
    return row ? (JSON.parse(row.value) as { layer: string; content: string; at: number }[]) : [];
  };

  // 一轮里写两条：第一条收下，第二条被按轮预算拒掉（演化层容量 24，一口气刷满会把 Canon 挤没）
  mockProvider.script.push({
    toolCalls: [
      { name: 'remember_setting', args: { layer: 'character', content: '她开始接受被叫小肥鱼', source: '群友反复这么叫' } },
      { name: 'remember_setting', args: { layer: 'world', content: '群里养了一只猫', source: '跟着一块儿起哄' } },
    ],
  }, {
    content: '记住啦',
  });
  const mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '以后就叫你小肥鱼了', atMe: true, nickname: '小明' });
  const reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /记住啦/, '写完演化照常把话说出来');

  await quiesce();
  const list = overlay();
  assert.equal(list.length, 1, `一轮只该落一条演化: ${JSON.stringify(list)}`);
  assert.equal(list[0].layer, 'character');
  assert.match(list[0].content, /小肥鱼/);
  assert.ok(list[0].at > 0, '带写入时间（桌面端人格页按它排序）');
  // 两条回执都真的回给了模型（会话语义：写入回执 + 超预算的拒绝理由）
  const results = kernel.sessionLog.tail(String(GROUP), 'group', 80)
    .filter((e) => e.type === 'tool_result').map((e) => String(e.data?.result ?? ''));
  assert.ok(results.some((r) => r.includes('已写入')), `该有一条写入回执: ${JSON.stringify(results)}`);
  assert.ok(results.some((r) => r.includes('已经写过一条')), `该有一条超预算回执: ${JSON.stringify(results)}`);
  mock.actions.length = 0;
});

// ============================================================
// 5.2 自动记忆提炼：攒够轮 + 静默够久 → 后台一发 → 落库（不进上下文）
// ============================================================

test('自动保存记忆：提炼出来的条权重 <1，且能经检索查回', async () => {
  const U = '777888';
  const p = kernel.config.config.persona as unknown as Record<string, unknown>;
  const saved = { ...p };
  p.memoryAutoSave = true; p.memoryMinTurns = 2; p.memoryIdleSeconds = 10; p.memoryMaxFacts = 5;
  mockProvider.memoryReply = '- 喜欢的乐队是万人谜\n- 约定每周五一起打游戏';
  try {
    wipeFacts(Number(U));
    for (const text of ['我最近迷上万人谜了', '就这么说定 每周五一起打游戏']) {
      const mark = mock.actions.length;
      mock.sendGroupMessage({ groupId: GROUP, userId: Number(U), text, atMe: true, nickname: 'Auto' });
      await mock.waitForReply(GROUP, 8000, mark);
    }
    // 静默门槛 10s + 扫描一拍 15s：轮询等它自己发生（不催、不改内部状态）
    await until(() => kernel.memory.topFacts(U, 10).length >= 2, 25000, '自动记忆落库');
    const facts = kernel.memory.topFacts(U, 10);
    assert.ok(facts.every((f) => f.weight < 1), '自动提炼的都带 <1 权重（用户页据此打「自动」徽标）');
    assert.ok(facts.some((f) => f.content.includes('万人谜')));
    assert.equal(facts[0].sourcePlugin, 'chat');
    // 检索得到（模型经 recall_facts 就是走这条路），而上下文里没有它们
    assert.ok(kernel.memory.searchFacts(U, '万人谜', 5).length >= 1);
  } finally {
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, saved);
    kernel.memory.forget(U);
    mockProvider.memoryReply = 'NONE';
    mock.actions.length = 0;
  }
});

test('关掉自动保存后不再提炼（开关真管用）', async () => {
  const U = '777889';
  const p = kernel.config.config.persona as unknown as Record<string, unknown>;
  const saved = { ...p };
  p.memoryAutoSave = false; p.memoryMinTurns = 2; p.memoryIdleSeconds = 10;
  mockProvider.memoryReply = '- 不该被记下来的一件事';
  try {
    for (const text of ['第一句', '第二句']) {
      const mark = mock.actions.length;
      mock.sendGroupMessage({ groupId: GROUP, userId: Number(U), text, atMe: true, nickname: 'Auto' });
      await mock.waitForReply(GROUP, 8000, mark);
    }
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(kernel.memory.topFacts(U, 10).length, 0, '关掉开关就不该写队列、更不该提炼');
  } finally {
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, saved);
    mockProvider.memoryReply = 'NONE';
    mock.actions.length = 0;
  }
});

// ============================================================
// 7. 沙箱边界（红线 §3.2）
// ============================================================

test('沙箱：路径穿越被拒绝', () => {
  const sb = kernel.sandbox;
  const chat = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  assert.throws(() => sb.resolveInside(chat, '../../secrets.json'), SandboxError);
  assert.throws(() => sb.resolveInside(chat, 'a/../../..'), SandboxError);
  assert.throws(() => sb.resolveInside(chat, 'C:\\Windows\\system32'), SandboxError);
  // 合法路径 OK
  const p = sb.resolveInside(chat, 'sub/dir/file.txt');
  assert.ok(p.includes('group_' + GROUP));
});

test('沙箱：写入/读取/配额/TTL 字段', () => {
  const sb = kernel.sandbox;
  const chat = { platform: 'qq', type: 'group' as const, chatId: '888' }; // 新会话，不干扰别的用例
  sb.write(chat, 'hello.txt', '你好，沙箱');
  assert.equal(sb.read(chat, 'hello.txt'), '你好，沙箱');
  // 单文件配额
  assert.throws(() => sb.write(chat, 'big.bin', 'x'.repeat(11 * 1024 * 1024)), /单文件上限/);
  // 列表
  const entries = sb.list(chat);
  assert.ok(entries.some((e) => e.relPath === 'hello.txt'));
  sb.clear(chat);
});

test('沙箱：真实执行 python（超时/输出截断机制）', async () => {
  const sb = kernel.sandbox;
  const chat = { platform: 'qq', type: 'private' as const, chatId: '777' };
  const r = await sb.run(chat, { language: 'python', code: 'print("calc:", 6*7)' });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /calc: 42/);
  // 超时被杀
  const r2 = await sb.run(chat, { language: 'python', code: 'import time\ntime.sleep(30)', timeoutMs: 1500 });
  assert.equal(r2.timedOut, true);
  sb.clear(chat);
});

test('发文件仅限沙箱内（发送服务强校验）', async () => {
  const chat = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  await assert.rejects(() => kernel.chat.sendFile(chat, 'C:/Windows/notepad.exe'), /沙箱/);
});

// ============================================================
// 8. 人格插件内容保护 + provider→人格 绑定
// ============================================================

test('persona 插件对非主人脱敏（普通成员不可套取人设内容）', async () => {
  const chatRef = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  // chat 是 persona 类且 locked：2026-10-17 指令面清空后它不再注册任何 QQ 命令
  const cmds = kernel.container.commandsForChat(chatRef, 'member').filter((c) => c.pluginId === 'chat');
  assert.equal(cmds.length, 0, '人格插件不该再有 QQ 命令入口');

  // 剩下的人设内容出口是内核 RPC 的插件详情：非主人读必须脱敏
  const ask = (role: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('内核响应超时')), 4000);
    kernel.bus.once('kernel.rpc.reply', (res: { ok: boolean; data?: unknown; error?: string }) => {
      clearTimeout(timer);
      if (res.ok) resolve(res.data as Record<string, unknown>);
      else reject(new Error(res.error ?? '内核错误'));
    });
    kernel.bus.emit('kernel.rpc', { type: 'plugin_detail', pluginId: 'chat', chatId: String(GROUP), chatType: 'group', role });
  });
  const memberView = await ask('member');
  assert.equal(memberView.redacted, true, '普通成员看人格插件要脱敏');
  assert.equal(memberView.description, '（人格插件内容不公开）');
  assert.deepEqual(memberView.permissions, []);
  const ownerView = await ask('owner');
  assert.equal(ownerView.redacted, false, '主人可以看全部');
  assert.notEqual(ownerView.description, '（人格插件内容不公开）');
});

// ============================================================
// 9. 插件崩溃隔离 + 自动停用通知（红线 §3.4）
// ============================================================

test('插件连续同错 3 次自动停用', async () => {
  mock.actions.length = 0;
  // 安装一个用户插件（写入 data/plugins 后扫描）
  const pdir = join(dataDir, 'plugins', 'crashy');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({
    id: 'crashy', name: '必崩插件', version: '0.0.1', description: '测试用',
    category: 'tool', defaultGroupState: 'on', permissions: [],
  }));
  writeFileSync(join(pdir, 'index.ts'), `
    export function setup(ctx) {
      ctx.registerCommand({ name: '必崩', handler: () => { throw new Error('boom-测试崩溃'); } });
    }
  `);
  const installed = await kernel.container.installUserPlugins();
  assert.ok(installed.includes('crashy'));

  // 调 3 次命令触发连续同错（命令路径不走 LLM，无需脚本）
  for (let i = 0; i < 3; i++) {
    mock.sendGroupMessage({ groupId: GROUP, userId: MASTER, text: '/必崩', nickname: '主人' });
    await until(() => mock.actions.filter((a) => a.action === 'send_group_msg').length >= i + 1, 8000, `崩溃响应 ${i}`);
  }
  await until(() => kernel.container.get('crashy')?.state === 'disabled', 5000, '自动停用');
  // 主人收到自动停用通知（notifyOwner → send_private_msg；注意区分 ErrorCenter 的普通报错通知）
  await until(
    () => mock.actions.some((a) => a.action === 'send_private_msg' && JSON.stringify(a.params).includes('自动停用')),
    8000, '主人通知',
  );
  const notified = mock.actions.filter((a) => a.action === 'send_private_msg' && JSON.stringify(a.params).includes('自动停用'));
  assert.match(String(notified.at(-1)?.params?.message?.map?.((s: any) => s.data?.text).join('') ?? ''), /自动停用/);
  mock.actions.length = 0;
  // 清理
  await kernel.container.uninstallUserPlugin('crashy').catch(() => kernel.container.unload('crashy'));
});

// ============================================================
// 10. 风控：私聊全收、群聊非 @ 静默、限速
// ============================================================

test('群聊非 @机器人 时保持沉默', async () => {
  const before = mock.actions.filter((a) => a.action === 'send_group_msg').length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '普通聊天不艾特', nickname: '小明' });
  await new Promise((r) => setTimeout(r, 700));
  const afterCount = mock.actions.filter((a) => a.action === 'send_group_msg').length;
  assert.equal(afterCount, before, '非唤醒消息不应回复');
});

test('隐藏会话：bot 收不到任何东西（消息不落账，也不回复/不命令/不主动）', async () => {
  const HIDE_GROUP = '7101';
  kernel.container.setGroupState('chat', HIDE_GROUP, true, 'ui');
  const selfId = (kernel.adapter.status() as unknown as { selfId?: string }).selfId || 'default';
  const prefs = kernel.config.config.ui.chatPrefs[selfId] ??= { pinned: [], hidden: [] };
  prefs.hidden.push(`group_${HIDE_GROUP}`);
  try {
    const scriptLen = mockProvider.script.length;
    mockProvider.script.push({ content: '（这句不该出现在任何地方）' });
    const mark = mock.actions.length;
    mock.sendGroupMessage({ groupId: HIDE_GROUP, userId: MASTER, text: '/work 算点什么', nickname: '主人' });
    // 隐藏即"收不到"：会话流里既没有入站也没有出站
    await new Promise((r) => setTimeout(r, 900));
    const tail = kernel.sessionLog.tail(HIDE_GROUP, 'group', 50);
    assert.ok(!tail.some((e) => e.type === 'message_in'), '隐藏会话不该收下这条消息');
    assert.ok(!tail.some((e) => e.type === 'message_out'), '隐藏会话不该有任何出站');
    const spoke = mock.actions.slice(mark).some((a) => a.action === 'send_group_msg' && String(a.params.group_id) === HIDE_GROUP);
    assert.ok(!spoke, '协议端不应收到该群的任何发言');
    mockProvider.script.length = scriptLen;   // 闸口生效时哨兵不会被消费，别漏给后面的用例
  } finally {
    prefs.hidden = prefs.hidden.filter((k) => k !== `group_${HIDE_GROUP}`);
  }
});

test('引用一条消息：内核按消息号查回原文，落进条目的 replyTo 快照', async () => {
  const G = '7102';
  kernel.container.setGroupState('chat', G, true, 'ui');
  mock.sendGroupMessage({ groupId: Number(G), userId: MEMBER, text: '两顿 20 行不行', nickname: '小明', messageId: 55001 });
  await new Promise((r) => setTimeout(r, 500));
  mock.sendGroupMessage({
    groupId: Number(G), userId: MEMBER, text: '那我请', nickname: '小明', messageId: 55002,
    extraSegments: [{ type: 'reply', data: { id: '55001' } }, { type: 'at', data: { qq: String(MEMBER), name: '小明' } }],
  });
  await new Promise((r) => setTimeout(r, 500));
  const tail = kernel.sessionLog.tail(G, 'group', 20);
  const quoted = tail.find((e) => e.text?.includes('那我请'));
  assert.equal(quoted?.data?.messageId, '55002', '入站条目要记下协议端消息号（下次被引用才查得到）');
  assert.ok(String(quoted?.data?.replyTo?.text ?? '').includes('两顿 20'), 'replyTo 要带上被引用那条的原文');
  assert.equal(quoted?.data?.replyTo?.nickname, '小明');

  // 被引用的是一张图：快照必须连附件一起抄过来，否则桌面端引用块里只能看到"[图片]"三个字
  kernel.sessionLog.append(G, 'group', {
    type: 'message_in', role: 'user', userId: String(MEMBER), nickname: '小明', text: '[图片]',
    data: { messageId: '55100', files: [{ name: 'a.jpg', rel: 'inbox/a.jpg', size: 12 }] },
  });
  mock.sendGroupMessage({ groupId: Number(G), userId: MEMBER, text: '这张好看', nickname: '小明', messageId: 55101,
    extraSegments: [{ type: 'reply', data: { id: '55100' } }] });
  await new Promise((r) => setTimeout(r, 500));
  const imgQuote = kernel.sessionLog.tail(G, 'group', 20).find((e) => e.text?.includes('这张好看'));
  assert.deepEqual(imgQuote?.data?.replyTo?.files, [{ name: 'a.jpg', rel: 'inbox/a.jpg' }], '引用图片消息要把 rel 带上');

  // 老条目只存过文件名（10-10 之前的形状）：快照要补出 inbox/ 前缀，桌面端才取到图
  kernel.sessionLog.append(G, 'group', {
    type: 'message_in', role: 'user', userId: String(MEMBER), nickname: '小明', text: '[图片]',
    data: { messageId: '55102', files: ['b.png'] },
  });
  mock.sendGroupMessage({ groupId: Number(G), userId: MEMBER, text: '上面那张', nickname: '小明', messageId: 55103,
    extraSegments: [{ type: 'reply', data: { id: '55102' } }] });
  await new Promise((r) => setTimeout(r, 500));
  const legacyQuote = kernel.sessionLog.tail(G, 'group', 20).find((e) => e.text?.includes('上面那张'));
  assert.deepEqual(legacyQuote?.data?.replyTo?.files, [{ name: 'b.png', rel: 'inbox/b.png' }]);
});

test('私聊全收并回复', async () => {
  mock.actions.length = 0;
  // 私聊会话同样遵循"默认全关"：先给该私聊开启 chat 插件
  kernel.container.setGroupState('chat', String(MEMBER), true, String(MASTER));
  const mark = mock.actions.length;
  mockProvider.script.push({ content: '喵？私聊找我有什么事～' });
  mock.sendPrivateMessage({ userId: MEMBER, text: '在吗', nickname: '小明' });
  // 只认发给该用户(10001)的私聊，避免与其他用例的 owner 通知(9999)竞态
  const toMember = () => mock.actions.slice(mark).filter((a) => a.action === 'send_private_msg' && String(a.params.user_id) === String(MEMBER));
  await until(() => toMember().length > 0, 8000, '私聊回复');
  // 按句分条可能出两条：等分片发完（静默窗口）再把整段回复拼起来断言
  await quiesce();
  const text = toMember()
    .map((call) => (call.params.message ?? []).map((s: any) => String(s.data?.text ?? '')).join(''))
    .join('|');
  assert.match(text, /私聊/);
  mock.actions.length = 0;
});

test('私聊连发几句合成一个请求（2026-10-18：私聊也借合批那一层）', async () => {
  mock.actions.length = 0;
  const PRIVATE_USER = '10002';
  kernel.container.setGroupState('chat', PRIVATE_USER, true, String(MASTER));
  const before = mockProvider.calls.length;
  mockProvider.script.push({ content: '收到，我看看。' });
  // 连发三句（模拟"打完一句又想起来一句"）：默认 merge 窗口 1.5s + 起跳 ≤2s 足够覆盖
  mock.sendPrivateMessage({ userId: Number(PRIVATE_USER), text: '在吗', nickname: '小刚' });
  await new Promise((r) => setTimeout(r, 120));
  mock.sendPrivateMessage({ userId: Number(PRIVATE_USER), text: '问你个事', nickname: '小刚' });
  await new Promise((r) => setTimeout(r, 120));
  mock.sendPrivateMessage({ userId: Number(PRIVATE_USER), text: '算了也没啥', nickname: '小刚' });

  const toUser = () => mock.actions.filter((a) => a.action === 'send_private_msg' && String(a.params.user_id) === PRIVATE_USER);
  await until(() => toUser().length > 0, 8000, '私聊回复');
  await quiesce();

  // 三轮对话轮（tool 调用/记忆提炼那种旁路请求不算：它们没有工具且带自认标记，走 script 队列的才算）
  const chatCalls = mockProvider.calls.slice(before).filter((c) => (c.tools?.length ?? 0) > 0);
  assert.equal(chatCalls.length, 1, `三句连发只该发一个请求，实得 ${chatCalls.length} 个`);
  // 三条正文都进了同一个请求（renderBatch 各带说话人前缀拼成一段）
  const joined = String(chatCalls[0].usersJoined ?? '');
  assert.match(joined, /在吗/);
  assert.match(joined, /问你个事/);
  assert.match(joined, /算了也没啥/);
  mock.actions.length = 0;
});

// ============================================================
// 12. 登录页数据：协议端登录号/昵称 + lastLogin 持久化
// ============================================================

test('登录信息：get_login_info 后 status/selfNickname/lastLogin 就绪', async () => {
  await until(() => (kernel.adapter as any).selfNickname === 'parallel-test', 5000, 'get_login_info 昵称回填');
  const st = kernel.adapter.status();
  assert.equal(st.selfId, mock.selfId);
  assert.equal(st.selfNickname, 'parallel-test');
  // 最近登录账号持久化（登录页"已登录过"展示）
  assert.equal(kernel.config.config.ui.lastLogin?.qq, String(mock.selfId));
  assert.equal(kernel.config.config.ui.lastLogin?.nickname, 'parallel-test');
});

// ============================================================
// 13. 协议端动作：二维码尽力拉取（标准 OneBot 无此接口，应优雅返回 null）
// ============================================================

test('tryFetchQrcode：协议端不支持时返回 null 而非抛错', async () => {
  const qr = await kernel.adapter.tryFetchQrcode();
  assert.equal(qr, null);
});

// ============================================================
// 15. 桌面端注入路径（无协议端也能跑通主流程）
// ============================================================

test('桌面端注入消息走完 Pipeline（platform=ui）', async () => {
  kernel.container.setGroupState('chat', String(456), true, 'ui');
  mockProvider.script.push({ content: '（ui 注入回复）' });
  kernel.pipeline.submit({
    id: 'ui-ev-1', platform: 'ui', type: 'group', chatId: '456', userId: '10001',
    nickname: '桌面访客', senderRole: 'unknown',
    segments: [{ type: 'text', data: { text: '你好' } }], text: '你好',
    isAtMe: true, isReplyToMe: false, raw: { injected: true }, ts: Date.now(), role: 'member',
  });
  await until(() => {
    // 出站按"所有消息拼起来"断言；HDSI 下括号不再被程序清洗，整条只发一条。
    const tail = kernel.sessionLog.tail('456', 'group', 30);
    const joined = tail.filter((e) => e.type === 'message_out').map((e) => e.text ?? '').join('');
    return joined.includes('ui 注入回复');
  }, undefined, '桌面注入回复');
});

// ============================================================
// 16. 会话名：群名不能被群名片污染，未知名字按需补齐
// ============================================================

test('群名片/陌生人昵称不会顶替群名，未知名字按需补', async () => {
  const GROUP2 = 4567;
  const STRANGER = 7777;
  assert.equal(kernel.adapter.chatTitle('group', String(GROUP)), '测试群');   // get_group_list 给的

  // 群友带群名片发言：群名必须还是群名（曾把 msg.sender.card 当群名写进缓存）
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '大家好呀', nickname: '某群友' });
  await until(() => kernel.sessionLog.tail(String(GROUP), 'group', 5).some((e) => e.text === '大家好呀'), 8000, '群消息入流');
  assert.equal(kernel.adapter.chatTitle('group', String(GROUP)), '测试群');

  // 列表里没有的群：来消息后按需 get_group_info 补名，而不是拿发言人的名字顶数
  assert.equal(kernel.adapter.chatTitle('group', String(GROUP2)), '');
  mock.sendGroupMessage({ groupId: GROUP2, userId: MEMBER, text: '新群冒个泡', nickname: '某群友' });
  await until(() => kernel.adapter.chatTitle('group', String(GROUP2)) === '按需群名', 8000, 'get_group_info 补群名');

  // 私聊：好友列表里没有的人（陌生人）用发言者昵称兜底，不该停在号码上
  assert.equal(kernel.adapter.chatTitle('private', String(STRANGER)), '');
  mock.sendPrivateMessage({ userId: STRANGER, text: '在吗', nickname: '陌生人甲' });
  await until(() => kernel.adapter.chatTitle('private', String(STRANGER)) === '陌生人甲', 8000, '私聊昵称兜底');
});

// ============================================================
// 17. work 子代理：loop 事件流 + 会话级缓存命中账（会话页右侧「工作」抽屉的数据面）
// ============================================================

test('work 任务产出 loop 事件与缓存命中，且按 chatKey 过滤', async () => {
  const WORK_GROUP = '7001';
  const chatKey = `group_${WORK_GROUP}`;
  const done = new Promise<any>((resolve) => {
    const off = kernel.bus.on('work.done' as any, (d: any) => { if (d.chatKey === chatKey) { off(); resolve(d); } });
  });
  // 以主人身份触发 /work（work 插件 minRole=admin）；mock 供应商会走 python_session 工具
  kernel.pipeline.submit({
    id: 'work-ev-1', platform: 'ui', type: 'group', chatId: WORK_GROUP, userId: String(MASTER),
    nickname: '主人', senderRole: 'owner',
    segments: [{ type: 'text', data: { text: '/work 算一下 2**10' } }], text: '/work 算一下 2**10',
    isAtMe: true, isReplyToMe: false, raw: { injected: true }, ts: Date.now(),
  } as any);
  await done;

  const runs = kernel.workRunner.list(10, chatKey);
  assert.equal(runs.length, 1, '该会话应有 1 条 work 任务');
  const evs = runs[0].events ?? [];
  const kinds = evs.map((e: any) => e.kind);
  assert.ok(kinds.includes('round'), `要有轮次事件，实际 ${kinds.join(',')}`);
  assert.ok(kinds.includes('thinking'), '要有思考事件');
  assert.ok(kinds.includes('tool') && kinds.includes('toolResult'), '要有工具调用与返回事件');
  assert.ok(kinds.includes('final'), '要有收敛回答事件');
  assert.equal(evs.find((e: any) => e.kind === 'tool').name, 'python_session');
  // 缓存命中账：mock 每轮报 96 命中 / 24 未命中
  assert.ok(runs[0].usage, '要带本次任务的 token 账');
  assert.ok(runs[0].usage.cacheHit > 0 && runs[0].usage.cacheMiss > 0, '缓存命中/未命中要有数');
  assert.ok(runs[0].usage.prompt >= runs[0].usage.cacheHit, '提示词 token 不该少于命中数');

  // 别的会话取不到这条（抽屉只认当前会话）
  assert.equal(kernel.workRunner.list(10, 'group_999999').length, 0);
});

test('work 停下来提问：转述按"等你回答"口径；管理员回答后接着干（不从头重来）', async () => {
  const WORK_GROUP = '7002';
  const chatKey = `group_${WORK_GROUP}`;
  const submit = (text: string) => kernel.pipeline.submit({
    id: `work-ask-${Math.random().toString(36).slice(2)}`, platform: 'ui', type: 'group', chatId: WORK_GROUP,
    userId: String(MASTER), nickname: '主人', senderRole: 'owner',
    segments: [{ type: 'text', data: { text } }], text,
    isAtMe: true, isReplyToMe: false, raw: { injected: true }, ts: Date.now(),
  } as any);
  const waitDone = () => new Promise<any>((resolve) => {
    const off = kernel.bus.on('work.done' as any, (d: any) => { if (d.chatKey === chatKey) { off(); resolve(d); } });
  });

  await quiesce();
  // 第一轮：work 模型卡在"不知道用哪份文件"，调 work_ask 停下来
  const done1 = waitDone();
  const calls1 = mockProvider.calls.length;
  mockProvider.script.push({ toolCalls: [{ name: 'work_ask', args: { question: '用哪份文件？', notes: '已把 inbox 列出来' } }] });
  submit('/work 整理一下那份报表');
  const ev1 = await done1;
  assert.equal(ev1.awaiting, true, 'work.done 要标出"停下来提问"');
  assert.equal(ev1.question, '用哪份文件？');

  const run1 = kernel.workRunner.list(5, chatKey)[0];
  assert.equal(run1.ok, true, '跑通了，只是要人拍板');
  assert.equal(run1.summary, '用哪份文件？', '结论就是那个问题，不是「## 待确认」那坨文本');
  assert.equal(run1.awaiting?.question, '用哪份文件？');
  assert.equal(run1.awaiting?.notes, '已把 inbox 列出来');

  // 转述轮口径：不能说成"已完成"
  await quiesce();
  const relay = mockProvider.calls.slice(calls1).map((c) => c.lastUser ?? '').find((t) => t.includes('【工作子代理'));
  assert.ok(relay, '要有一轮转述请求');
  assert.ok(relay!.includes('停下来问你一件事'), `转述要说"停下来问"：${relay}`);
  assert.ok(!relay!.includes('已完成任务'), '提问不能被说成已完成');
  assert.ok(relay!.includes('/work'), '要告诉用户怎么回答');

  // 第二轮：管理员回答 → 拼成"接着上次"的新任务交回 work
  const done2 = waitDone();
  const calls2 = mockProvider.calls.length;
  mockProvider.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '整理完了，产出 report.md', artifacts: ['report.md'] } }] });
  submit('/work 用 inbox/a.csv 那份');
  await done2;
  await quiesce();

  const task2 = mockProvider.calls.slice(calls2).map((c) => c.lastUser ?? '').find((t) => t.includes('接着上次'));
  assert.ok(task2, '第二轮的 work 请求要带上"接着上次"的任务描述');
  assert.ok(task2!.includes('你上次停下来问发起者的：用哪份文件？'), task2);
  assert.ok(task2!.includes('发起者这次说的是：用 inbox/a.csv 那份'), task2);

  const run2 = kernel.workRunner.list(5, chatKey)[0];
  assert.equal(run2.awaiting, undefined, '这一轮是正常交付，不该再挂着"等回答"');
  assert.equal(run2.summary, '整理完了，产出 report.md');
  assert.equal(run2.task, '整理一下那份报表（续）', '列表里显示短标题，不是拼接文本');

  // 待答复已被消费：再来一次 /work 不该再粘上那段历史
  const done3 = waitDone();
  const calls3 = mockProvider.calls.length;
  mockProvider.script.push({ toolCalls: [{ name: 'work_finish', args: { summary: '另一件事做完了' } }] });
  submit('/work 换个任务：看看沙箱里有什么');
  await done3;
  await quiesce();
  const task3 = mockProvider.calls.slice(calls3).map((c) => c.lastUser ?? '').find((t) => t.includes('看看沙箱里有什么'));
  assert.ok(task3, '第三轮的 work 请求');
  assert.ok(!task3!.includes('接着上次'), '没有待答复时不该拼续接前缀');
});

// ============================================================
// 17. 拟人层（chat 区全量替换）：分段发送 / 合批 / 主动发言
// ============================================================

test('拟人化：分条是纯程序 —— 句末标点/换行/旧分隔标记都分条，逗号不断句', async () => {
  await quiesce();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  const groupSends = () => mock.actions
    .filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(GROUP))
    .map((a) => (a.params.message ?? []).filter((s: any) => s.type === 'text').map((s: any) => String(s.data?.text ?? '')).join(''));

  // ① 旧分隔标记（剧本体时代的 <sep/>）仍当作换行：分条意图保留，记号不外发
  mock.actions.length = 0;
  mockProvider.script.push({ content: '今天去上课了<sep/>然后回来睡觉<sep/>睡醒吃了饭。' });
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '在吗', atMe: true, nickname: '小明' });
  await mock.waitForReply(GROUP);
  const parts = groupSends();
  assert.ok(parts.length >= 2, `写了分隔标记就该拆成多条，实际 ${parts.length} 条`);
  for (const piece of ['今天去上课了', '回来睡觉', '睡醒吃了饭']) {
    assert.ok(parts.some((t) => t.includes(piece)), `缺 ${piece}: ${JSON.stringify(parts)}`);
  }

  // ② 只有逗号与末尾句号的长句 → 一条（逗号不是句末标点，不分条）
  await quiesce();
  mock.actions.length = 0;
  mockProvider.script.push({ content: '今天去上课了，然后回来睡觉，睡醒吃了饭。' });
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '在吗', atMe: true, nickname: '小明' });
  await mock.waitForReply(GROUP);
  const one = groupSends();
  assert.equal(one.length, 1, `逗号不断句，实际 ${one.length} 条: ${JSON.stringify(one)}`);
});

test('拟人化：触发消息被后来的消息刷远时，回复自动挂引用（v1 程序锚定）', async () => {
  await quiesce();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  mock.actions.length = 0;
  const triggerId = 88001;
  // 让模型"想一会儿"：生成期间再进一条消息，触发消息就不是最新一条了
  mockProvider.script.push({ content: '收到', delayMs: 500 });
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '看看这个', atMe: true, nickname: '小明', messageId: triggerId });
  await new Promise((r) => setTimeout(r, 150));
  mock.sendGroupMessage({ groupId: GROUP, userId: 10002, text: '啊这', nickname: '阿强' });
  await mock.waitForReply(GROUP, 8000);
  await quiesce();
  const sent = mock.actions.filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(GROUP));
  const quoted = sent.find((a) => (a.params.message ?? []).some((s: any) => s.type === 'reply'));
  assert.ok(quoted, `回复应挂着触发消息的引用: ${JSON.stringify(sent)}`);
  const replySeg = (quoted!.params.message ?? []).find((s: any) => s.type === 'reply');
  assert.equal(String(replySeg.data?.id), String(triggerId), '引用的是触发那条消息');
  // 引用块与正文必须在同一个消息里（曾把 reply 段拆成一条空消息 + 一条无引用的正文）
  const text = (quoted!.params.message ?? []).filter((s: any) => s.type === 'text').map((s: any) => String(s.data?.text ?? '')).join('');
  assert.match(text, /收到/);
});

test('拟人化：一问一答没被刷远时不挂引用（一般的消息不需要引用）', async () => {
  await quiesce();
  mock.actions.length = 0;
  mockProvider.script.push({ content: '好' });
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '在吗', atMe: true, nickname: '小明', messageId: 88002 });
  await mock.waitForReply(GROUP, 8000);
  await quiesce();
  const sent = mock.actions.filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(GROUP));
  assert.ok(sent.length >= 1, '回复照常发出');
  assert.ok(sent.every((a) => !(a.params.message ?? []).some((s: any) => s.type === 'reply')),
    `没有被刷远就不该挂引用: ${JSON.stringify(sent)}`);
});

test('拟人化：群里几条消息攒一起，一次交给模型（且带上说话人）', async () => {
  await quiesce();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  mock.actions.length = 0;
  mockProvider.script.push({ content: '收到' });
  // 两条没人理的消息先进缓冲，第三条 @ 触发时把它们一起带上
  mock.sendGroupMessage({ groupId: GROUP, userId: 10002, text: '今天游戏更新了', nickname: '阿强' });
  await new Promise((r) => setTimeout(r, 80));
  mock.sendGroupMessage({ groupId: GROUP, userId: 10003, text: '下班回去看看', nickname: '小美' });
  await new Promise((r) => setTimeout(r, 80));
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '你玩吗', atMe: true, nickname: '小明' });
  await mock.waitForReply(GROUP);

  const call = (kernel.llm as any).providers.get('mock').calls.at(-1);
  const joined = String(call?.usersJoined ?? '');
  assert.ok(joined.includes('今天游戏更新了'), `模型应看到前序消息: ${joined}`);
  assert.ok(joined.includes('阿强') && joined.includes('小美'), `应带说话人: ${joined}`);
  assert.ok(joined.includes('你玩吗'), `当前消息也在: ${joined}`);
});

test('拟人化：主动发言轮里模型回 SKIP 就保持沉默', async () => {
  await quiesce();
  const PRO_GROUP = 4570;
  kernel.container.setGroupState('chat', String(PRO_GROUP), true, String(MASTER));
  const hl = kernel.config.config.humanlike;
  const savedProactive = hl.proactive.enable;
  const savedAgency = hl.agency.enable;
  hl.proactive.enable = true;                 // 主动发言默认关，这里临开
  // 行动容量跟着墙钟走：夜里（默认安静时段 00:30-07:30）会把主动轮整体挡下，用例就失去意义。
  // 这里测的是主动发言链路本身，容量判据在 humanlike.test.ts 里有专门单元测试。
  hl.agency.enable = false;
  try {
    mock.actions.length = 0;
    mockProvider.script.push({ content: 'SKIP' });
    // 走 pipeline 的主动发言入口（真实链路里由拟人层定时器调用）
    kernel.pipeline.enqueueBatch({
      chat: { platform: 'qq', type: 'group', chatId: String(PRO_GROUP) },
      events: [], reason: 'proactive', detail: '测试注入',
    });
    await quiesce();
    const sends = mock.actions.filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(PRO_GROUP));
    assert.equal(sends.length, 0, '模型回 SKIP 时一个字都不该发');
  } finally {
    hl.proactive.enable = savedProactive;
    hl.agency.enable = savedAgency;
  }
});

test('拟人化：主动发言轮真说话时不往历史塞假用户消息', async () => {
  await quiesce();
  const PRO_GROUP = 4571;
  kernel.container.setGroupState('chat', String(PRO_GROUP), true, String(MASTER));
  const hl = kernel.config.config.humanlike;
  const savedProactive = hl.proactive.enable;
  const savedAgency = hl.agency.enable;
  hl.proactive.enable = true;
  hl.agency.enable = false;                   // 同上：别让墙钟的安静时段挡下主动轮
  const chat = { platform: 'qq', type: 'group' as const, chatId: String(PRO_GROUP) };
  try {
    // 先造一轮真实对话，历史里就该有 user+assistant
    mock.actions.length = 0;
    mockProvider.script.push({ content: '在的' });
    mock.sendGroupMessage({ groupId: PRO_GROUP, userId: MEMBER, text: '在吗', atMe: true, nickname: '小明' });
    await mock.waitForReply(PRO_GROUP);
    const before = kernel.history.snapshot(chat).length;
    assert.ok(before >= 2, `真实一轮后历史应有 user+assistant: ${before}`);

    mock.actions.length = 0;
    mockProvider.script.push({ content: '话说最近有什么好看的剧吗？' });
    kernel.pipeline.enqueueBatch({ chat, events: [], reason: 'proactive', detail: '测试注入' });
    const text = await mock.waitForReply(PRO_GROUP);
    assert.ok(text.includes('好看的剧'), `主动发言应真的发出去: ${text}`);

    const after = kernel.history.snapshot(chat);
    assert.equal(after.length, before + 1, '只该多一条 assistant');
    assert.equal(after.at(-1)?.role, 'assistant');
    assert.ok(!after.some((m) => String(m.content).includes('安静了一阵子')), '主动发言的提示词不该进历史');
  } finally {
    hl.proactive.enable = savedProactive;
    hl.agency.enable = savedAgency;
  }
});

test('拟人化：没有总开关可关（出站塑形始终在生效）', async () => {
  await quiesce();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  // 内核不提供关掉拟人化的入口：配置里没有 enabled 键，API 也不认
  assert.equal('enabled' in kernel.config.config.humanlike, false);
  mock.actions.length = 0;
  // 一整句没有句末标点 → 一条发出（按句分条是程序在生效，但单句就是单条）
  mockProvider.script.push({ content: '第一句，第二句，第三句。' });
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '在吗', atMe: true, nickname: '小明' });
  await mock.waitForReply(GROUP, 8000);
  await quiesce();
  const sends = mock.actions.filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(GROUP));
  assert.ok(sends.length >= 1, '回复照常发出');
});

test('拟人化：首轮请求不会把同一条用户消息发两遍', async () => {
  await quiesce();
  const G = 4572;                                   // 全新会话 → 历史缓存必然走"从会话日志重建"那条路
  kernel.container.setGroupState('chat', String(G), true, String(MASTER));
  mock.actions.length = 0;
  mockProvider.script.push({ content: '收到' });
  mock.sendGroupMessage({ groupId: G, userId: MEMBER, text: '独一无二的一句话', atMe: true, nickname: '小明' });
  await mock.waitForReply(G);
  const call = (kernel.llm as any).providers.get('mock').calls.at(-1);
  const joined = String(call?.usersJoined ?? '');
  const hits = joined.split('独一无二的一句话').length - 1;
  assert.equal(hits, 1, `同一条消息只该出现一次，实际 ${hits} 次: ${joined}`);
});
