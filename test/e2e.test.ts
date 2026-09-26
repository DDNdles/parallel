import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import { MockProvider } from '../src/kernel/services/llm.ts';
import { MockOneBot } from './helpers/mock-onebot.ts';
import { SandboxError } from '../src/kernel/services/sandbox.ts';

/**
 * 端到端：真实内核 + 模拟协议端（MockOneBot），不插真 QQ 号验证主流程。
 */
let kernel: Kernel;
let dataDir: string;
let mock: MockOneBot;
let mockProvider: MockProvider;

const GROUP = 123;
const MEMBER = 10001;
const MASTER = 9999;

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待 ${what} 超时`);
}

const ONEBOT_PORT = 30000 + (process.pid % 20000); // 随机端口避免并发测试/残留进程冲突

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-e2e-'));
  kernel = new Kernel({ dataDir, noApi: true });
  // 加速：抖动/限速调整 + 主人配置
  kernel.config.config.risk.jitterMinMs = 5;
  kernel.config.config.risk.jitterMaxMs = 30;
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
  mockProvider = (kernel.llm as unknown as { providers: Map<string, MockProvider> }).providers.get('mock')!;
  await kernel.boot();
  mock = new MockOneBot(`ws://127.0.0.1:${ONEBOT_PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, 'get_login_info');
});

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

test('群聊 @机器人触发完整 agent loop 并回复', async () => {
  // 开启 chat + sandbox 插件（管理员通过模拟命令开，这里直接容器操作等价）
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  kernel.container.setGroupState('sandbox', String(GROUP), true, String(MASTER));

  // 脚本：先调用沙箱工具，再回答
  mockProvider.script.push({
    toolCalls: [{ name: 'run_python', args: { code: 'print(2**10)' } }],
  }, {
    content: '喵！是 1024 哦～',
  });

  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: ' 帮我算下 2^10', atMe: true, nickname: '小明' });
  const reply = await mock.waitForReply(GROUP);
  assert.match(reply, /1024/);
  assert.match(reply, /喵/);

  // 工具确实在沙箱里跑过：会话日志应有 tool_call/tool_result
  const tail = kernel.sessionLog.tail(String(GROUP), 'group', 50);
  assert.ok(tail.some((e) => e.type === 'tool_call' && e.text === 'run_python'));
  assert.ok(tail.some((e) => e.type === 'tool_result' && (e.data?.result as string)?.includes('1024')));
});

// ============================================================
// 3. 分群开关后果严格成立（红线 §2.4）
// ============================================================

test('群禁用的插件：工具缺席/命令不可用/普通成员不可见', async () => {
  mock.actions.length = 0;
  // 未开启 web-search 的群：工具列表里没有 web_search
  const chatRef = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  kernel.container.setGroupState('web-search', String(GROUP), false, String(MASTER));
  const toolsOff = kernel.container.toolsForChat(chatRef, 'member').map((t) => t.name);
  assert.ok(!toolsOff.includes('web_search'), `web_search 不应出现: ${toolsOff}`);

  // 开启后出现
  kernel.container.setGroupState('web-search', String(GROUP), true, String(MASTER));
  const toolsOn = kernel.container.toolsForChat(chatRef, 'member').map((t) => t.name);
  assert.ok(toolsOn.includes('web_search'));

  // 关闭后：普通成员 /帮助 完全看不到该插件命令；管理员可见（标未开启）
  kernel.container.setGroupState('web-search', String(GROUP), false, String(MASTER));
  const memberCmds = kernel.container.commandsForChat(chatRef, 'member').filter((c) => c.pluginId === 'web-search');
  assert.equal(memberCmds.length, 0, '普通成员不应看到被禁用插件的命令');
  const adminCmds = kernel.container.commandsForChat(chatRef, 'admin').filter((c) => c.pluginId === 'web-search');
  assert.equal(adminCmds.length, 1);
  assert.equal(adminCmds[0].enabled, false);

  // 全局运行时停用 → 所有群所有角色都不可见
  await kernel.container.setRuntimeEnabled('web-search', false);
  assert.equal(kernel.container.toolsForChat(chatRef, 'owner').filter((t) => t.name === 'web_search').length, 0);
  await kernel.container.setRuntimeEnabled('web-search', true);

  // /搜索 命令在该群不可用（普通成员视角=未知命令；不泄露存在性）
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/搜索 猫', nickname: '小明' });
  const reply = await mock.waitForReply(GROUP);
  assert.match(reply, /未知命令/);
  mock.actions.length = 0;
});

// ============================================================
// 4. 权限边界（红线 §3.5）：人设切换仅主人
// ============================================================

test('普通成员/管理员不能切换人格，主人可以', async () => {
  mock.actions.length = 0;
  // 普通成员
  let mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/人格', role: 'member', nickname: '小明' });
  let reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /权限不足/);

  // 管理员（群管理员角色）
  mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: 10002, text: '/人格', role: 'admin', nickname: '群管' });
  reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /权限不足/);

  // 主人（config.masterIds）
  mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MASTER, text: '/人格', role: 'member', nickname: '主人' });
  reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /CETACEA_MOLI/);

  // 主人切换人格（当前只有这一个）
  mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MASTER, text: '/人格 切换 whale-girl', nickname: '主人' });
  reply = await mock.waitForReply(GROUP, 8000, mark);
  assert.match(reply, /已切换人格/);
  mark = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MASTER, text: '/人格 auto', nickname: '主人' });
  await mock.waitForReply(GROUP, 8000, mark);
});

// ============================================================
// 5. 好感度：LLM 工具更新 + 防刷限制（红线 §2.1）
// ============================================================

test('好感度工具更新、单日上限防刷、段位注入', async () => {
  // 找到 chat 插件注册的 update_affection 工具直接调用（与 LLM 调用同一 handler）
  const tool = kernel.container.get('chat')!.tools.get('update_affection')!;
  const tctx = {
    event: {
      id: 't1', platform: 'qq', type: 'group' as const, chatId: String(GROUP), userId: String(MEMBER),
      nickname: '小明', senderRole: 'member' as const, segments: [], text: '', isAtMe: false,
      isReplyToMe: false, raw: {}, ts: Date.now(), role: 'member' as const,
    },
    chat: { platform: 'qq', type: 'group' as const, chatId: String(GROUP) },
    role: 'member' as const,
  };
  const r1 = await tool.handler({ delta: 5, reason: '夸了 bot' }, tctx);
  assert.match(String(r1), /好感度 20 → 25/);
  // 冷却期内再更新被拒
  const r2 = await tool.handler({ delta: 5, reason: '又夸' }, tctx);
  assert.match(String(r2), /防刷|拒绝/);
  // 工具入口把单次变化钳制在 ±10
  kernel.memory.setAttr(String(MEMBER), 'affection_last_ts', Date.now() - 120_000);
  const big = await tool.handler({ delta: 50, reason: '试图一次刷很多' }, tctx);
  assert.match(String(big), /好感度 25 → 35/);
  // 今日已变动 +15（5+10）达到上限，再次更新被拒
  kernel.memory.setAttr(String(MEMBER), 'affection_last_ts', Date.now() - 120_000);
  const capped = await tool.handler({ delta: 10, reason: '继续刷' }, tctx);
  assert.match(String(capped), /单日上限/);
  assert.equal(kernel.memory.getAttr(String(MEMBER), 'affection'), 35);
});

// ============================================================
// 6. 用户记忆：FTS 检索 + 忘记我
// ============================================================

test('记忆服务：添加/检索/忘记', () => {
  kernel.memory.addFact(String(MEMBER), { content: '喜欢的乐队是万人谜', sourcePlugin: 'test' });
  kernel.memory.addFact(String(MEMBER), { content: '约定周末一起打游戏', sourcePlugin: 'test' });
  const hits = kernel.memory.searchFacts(String(MEMBER), '乐队', 5);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].content, /万人谜/);
  // 忘记我：清空事实与好感度
  kernel.memory.forget(String(MEMBER));
  assert.equal(kernel.memory.searchFacts(String(MEMBER), '乐队', 5).length, 0);
  assert.equal(kernel.memory.getAttr(String(MEMBER), 'affection'), undefined);
});

test('/忘记我 命令清空记忆', async () => {
  mock.actions.length = 0;
  kernel.memory.addFact(String(MEMBER), { content: '爱吃香菜', sourcePlugin: 'test' });
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/忘记我', nickname: '小明' });
  const reply = await mock.waitForReply(GROUP);
  assert.match(reply, /忘记/);
  assert.equal(kernel.memory.topFacts(String(MEMBER), 10).length, 0);
  mock.actions.length = 0;
});

test('/forget 指定别人：普通成员被拒，管理员可清除', async () => {
  const OTHER = '777001';
  kernel.memory.addFact(OTHER, { content: '别人的秘密', sourcePlugin: 'test' });
  mock.actions.length = 0;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: `/forget ${OTHER}`, nickname: '小明' });
  let reply = await mock.waitForReply(GROUP);
  assert.match(reply, /权限不足/);
  assert.equal(kernel.memory.topFacts(OTHER, 10).length, 1, '普通成员清不动别人');

  mock.actions.length = 0;
  mock.sendGroupMessage({ groupId: GROUP, userId: 10002, text: `/forget ${OTHER}`, role: 'admin', nickname: '群管' });
  reply = await mock.waitForReply(GROUP);
  assert.match(reply, /已清除/);
  assert.equal(kernel.memory.topFacts(OTHER, 10).length, 0);
  mock.actions.length = 0;
});

test('forgetScope=admin_only 时本人也不能清', async () => {
  kernel.memory.addFact(String(MEMBER), { content: '临时记忆', sourcePlugin: 'test' });
  kernel.config.config.risk.forgetScope = 'admin_only';
  try {
    mock.actions.length = 0;
    mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '/忘记我', nickname: '小明' });
    let reply = await mock.waitForReply(GROUP);
    assert.match(reply, /只允许管理员|权限不足/);
    assert.equal(kernel.memory.topFacts(String(MEMBER), 10).length, 1, '本人也没被清');

    mock.actions.length = 0;
    mock.sendGroupMessage({ groupId: GROUP, userId: 10002, text: '/忘记我', role: 'admin', nickname: '群管' });
    reply = await mock.waitForReply(GROUP);
    assert.match(reply, /忘记|重新认识/);
  } finally {
    kernel.config.config.risk.forgetScope = 'self_and_admin';
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

test('persona 插件对非主人脱敏（普通成员不可套取人设内容）', () => {
  const chatRef = { platform: 'qq', type: 'group' as const, chatId: String(GROUP) };
  // chat 是 persona 类且 locked：commandsForChat 对 member 只在启用时可见（本群已启用）
  const memberView = kernel.container.commandsForChat(chatRef, 'member');
  assert.ok(memberView.every((c) => c.pluginId !== 'chat' || c.def.name !== '人格'), '/人格 是 owner 专属命令，不应出现在普通成员命令集');
  // owner 视图包含 /人格
  const ownerView = kernel.container.commandsForChat(chatRef, 'owner').map((c) => c.def.name);
  assert.ok(ownerView.includes('人格'));
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
  const call = toMember().at(-1)!;
  const text = (call.params.message ?? []).map((s: any) => s.data?.text ?? '').join('');
  assert.match(text, /私聊/);
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
    const tail = kernel.sessionLog.tail('456', 'group', 10);
    return tail.some((e) => e.type === 'message_out' && (e.text ?? '').includes('ui 注入回复'));
  }, 8000, '桌面注入回复');
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
