import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import { attachmentsOf } from '../src/kernel/pipeline.ts';
import type { MockEngine } from '../src/kernel/services/mock-engine.ts';
import { MockOneBot } from './helpers/mock-onebot.ts';
import {
  FORWARD_MAX_DEPTH, FORWARD_MAX_NODE_IMAGES, FORWARD_MAX_NODE_MEDIA, FORWARD_MAX_NODES,
  FORWARD_PROMPT_IMAGES, FORWARD_PROMPT_NODES, forwardTotal, renderForward,
} from '../src/kernel/util/forward.ts';
import type { ChatEvent, ForwardRecord } from '../src/kernel/types.ts';

/**
 * 群友发来的「聊天记录」合集（QQ 的合并转发）。
 *
 * 为什么单独一个用例文件：2026-10-15 实测有头模式的 LLBot 只给
 * `{type:'forward',data:{id:<resId>}}` 这一个字段，正文必须再问一次 get_forward_msg
 * 才拿得到——不补这一步，这条消息在内核里就是一句空文本，模型和桌面端都看不见内容。
 * 这里把三件事钉住：节点取回来了、会话日志里存下了、模型输入里展开了；
 * 以及取不到时（协议端不支持 / 记录过期）不许编内容、不许打断正常聊天。
 * 顺带覆盖顶层消息的图/语音/视频落盘（适配器里与记录走的是同一个 pullMedia）。
 */
let kernel: Kernel;
let dataDir: string;
let mock: MockOneBot;
let mockProvider: MockEngine;

const GROUP = 654;
const MEMBER = 20001;
const MASTER = 20009;
const RES_ID = 'vqs3IZtJC1UgZbkrGOBI5VA4dlR+fX2gpu77x1vHfwBYKobHAmDvYJxWiR+iVJba';

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 12000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待 ${what} 超时`);
}

/** 一条转发节点：形状照 LLBot get_forward_msg 的实际回包（content 是消息段数组） */
const node = (nickname: string, text: string, user_id = MEMBER) => ({
  content: [{ type: 'text', data: { text } }],
  sender: { nickname, user_id },
  time: 1_760_000_000,
  message_format: 'array',
  message_type: 'group',
});
/** 一堆节点（测上限用） */
const manyNodes = (n: number) => Array.from({ length: n }, (_, i) => node(`群友${i + 1}`, `第 ${i + 1} 条`));
/** 真实入站形状：只有一个 resId，别的什么都没有 */
const forwardEvent = (opts: { text?: string; messageId: number; atMe?: boolean; group?: number }) => {
  mock.sendGroupMessage({
    groupId: opts.group ?? GROUP, userId: MEMBER, text: opts.text ?? '', nickname: '小明', messageId: opts.messageId,
    atMe: opts.atMe,
    extraSegments: [{ type: 'forward', data: { id: RES_ID } }],
  });
};
const entryOf = (messageId: number, group = GROUP) =>
  kernel.sessionLog.tail(String(group), 'group', 200).find((e) => String((e.data as { messageId?: string })?.messageId) === String(messageId));
const forwardOf = (messageId: number, group = GROUP) => (entryOf(messageId, group)?.data as { forward?: ForwardRecord } | undefined)?.forward;

const ONEBOT_PORT = 30000 + (process.pid % 20000);
/** 假图片服务器：内核下载走真 fetch，测试里得有真字节可下 */
const IMG_PORT = 20000 + (process.pid % 5000);
let imgServer: Server;
before(async () => {
  imgServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));
  });
  await new Promise<void>((r) => imgServer.listen(IMG_PORT, '127.0.0.1', r));
  dataDir = mkdtempSync(join(tmpdir(), 'parallel-forward-'));
  kernel = new Kernel({ dataDir, noApi: true });
  kernel.config.config.risk.replyRatePerMin = 10_000;
  kernel.chat.setRatePerMin(10_000);
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingBaseDelaySeconds = 0;
  hlOut.typingMaxDelaySeconds = 0;
  hlOut.typingJitterRatio = 0;
  kernel.config.config.onebot.port = ONEBOT_PORT;
  kernel.config.config.masterIds = [String(MASTER)];
  (kernel.config.config.providers as Record<string, unknown>).mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  kernel.config.config.llm.activeProvider = 'mock';
  kernel.config.config.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  kernel.config.config.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  mockProvider = (kernel.llm as unknown as { providers: Map<string, MockEngine> }).providers.get('mock')!;
  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  mock = new MockOneBot(`ws://127.0.0.1:${ONEBOT_PORT}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, 'get_login_info');
  await until(() => !!(kernel.adapter.status() as { selfId?: string }).selfId, 5000, '适配器 selfId');
});

beforeEach(() => { kernel.humanlike.resetAll(); });

after(async () => {
  mock.close();
  await kernel.shutdown();
  await new Promise((r) => setTimeout(r, 300));
  await new Promise<void>((r) => imgServer.close(() => r()));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temp 目录系统会回收 */ }
});

// ---------------- 渲染层（纯函数）先钉住取舍 ----------------

test('renderForward：昵称打头逐条展开，超限的部分只报数目', () => {
  const rec: ForwardRecord = {
    id: RES_ID, title: '', dropped: 0, failed: false,
    nodes: manyNodes(FORWARD_PROMPT_NODES + 3).map((n, i) => ({
      nickname: `群友${i + 1}`, userId: '1', text: `第 ${i + 1} 条`, ts: 1_760_000_000_000,
    })),
  };
  const out = renderForward(rec);
  assert.ok(out.startsWith('【聊天记录·共'), out.slice(0, 40));
  assert.ok(out.includes('群友1：第 1 条'), '第一条要展开');
  assert.ok(out.includes(`群友${FORWARD_PROMPT_NODES}：第 ${FORWARD_PROMPT_NODES} 条`), '窗口内的最后一条也要展开');
  assert.ok(!out.includes(`群友${FORWARD_PROMPT_NODES + 1}：`), '超出模型窗口的不展开');
  assert.ok(out.includes(`（其余 ${rec.nodes.length - FORWARD_PROMPT_NODES} 条未展开）`), '要说清后面还有多少');
});

test('renderForward：空记录不给模型任何正文，dropped 算进总数', () => {
  assert.equal(renderForward({ id: '', title: '', nodes: [], dropped: 0, failed: true }), '');
  const rec: ForwardRecord = { id: '', title: '', dropped: 30, failed: false, nodes: [{ nickname: '甲', userId: '', text: '一', ts: 0 }] };
  assert.equal(forwardTotal(rec), 31);
  assert.ok(renderForward(rec).includes('共 31 条'), '被上限丢掉的那部分也要报进条数，不许谎称完整');
});

// ---------------- 适配器：认段 → 现取节点 ----------------

test('记录里的图算进本轮附件：模型看得见图，不只是看见"这里有张图"', () => {
  const ev = {
    segments: [], text: '[聊天记录]',
    forward: {
      id: 'x', title: '', dropped: 0, failed: false,
      nodes: [
        { nickname: '甲', userId: '', text: '看这张 [图片]', ts: 0, files: [{ name: 'a.png', rel: 'inbox/a.png', sandboxPath: 'C:/sb/inbox/a.png', size: 3 }] },
        { nickname: '乙', userId: '', text: '没图', ts: 0 },
      ],
    },
  } as unknown as ChatEvent;
  const atts = attachmentsOf(ev);
  assert.equal(atts.length, 1, JSON.stringify(atts));
  assert.equal(atts[0].kind, 'image');
  assert.equal(atts[0].path, 'C:/sb/inbox/a.png', '本机路径直给内核读 base64');
  assert.equal(atts[0].mime, 'image/png');
  // 取不到的那份记录（failed）不该带出任何附件
  assert.deepEqual(attachmentsOf({ segments: [], text: '', forward: { id: 'x', title: '', nodes: [], dropped: 0, failed: true } } as unknown as ChatEvent), []);
});

test('记录里的语音/视频按扩展名归回 audio/video 附件（各只给一条，多给对端也用不上）', () => {
  const mk = (name: string) => ({ name, rel: `inbox/${name}`, sandboxPath: `C:/sb/inbox/${name}`, size: 1 });
  const ev = {
    segments: [], text: '',
    forward: {
      id: 'x', title: '', dropped: 0, failed: false,
      nodes: [
        { nickname: '甲', userId: '', text: '[语音]', ts: 0, files: [mk('v1.silk')] },
        { nickname: '乙', userId: '', text: '[语音]', ts: 0, files: [mk('v2.silk')] },
        { nickname: '丙', userId: '', text: '[视频]', ts: 0, files: [mk('m.mp4')] },
        { nickname: '丁', userId: '', text: '[图片]', ts: 0, files: [mk('p.jpg')] },
      ],
    },
  } as unknown as ChatEvent;
  const got = attachmentsOf(ev).map((a) => `${a.kind}:${a.name}`).sort();
  assert.deepEqual(got, ['audio:v1.silk', 'image:p.jpg', 'video:m.mp4'], JSON.stringify(got));
});

test('记录里几十张图：进模型的只取前 FORWARD_PROMPT_IMAGES 张（显示那边仍是 20 张）', () => {
  const files = Array.from({ length: FORWARD_MAX_NODE_IMAGES }, (_, i) => ({
    name: `i${i}.png`, rel: `inbox/i${i}.png`, sandboxPath: `C:/sb/inbox/i${i}.png`, size: 1,
  }));
  const ev = {
    segments: [], text: '',
    forward: {
      id: 'x', title: '', dropped: 0, failed: false,
      nodes: files.map((f, i) => ({ nickname: `群友${i}`, userId: '', text: '[图片]', ts: 0, files: [f] })),
    },
  } as unknown as ChatEvent;
  const atts = attachmentsOf(ev);
  assert.equal(atts.length, FORWARD_PROMPT_IMAGES, `只该给模型 ${FORWARD_PROMPT_IMAGES} 张，实得 ${atts.length}`);
  assert.equal(atts[0].path, 'C:/sb/inbox/i0.png', '按记录顺序取最前面几张');
});

test('聊天记录：按 resId 现取节点，正文与昵称都落进会话日志', async () => {
  mock.setReply('get_forward_msg', { messages: [node('小明', '明天交作业'), node('小红', '收到', 20002)] });
  const before = mock.actions.length;
  forwardEvent({ messageId: 90001 });

  const call = await until(
    () => mock.actions.slice(before).find((a) => a.action === 'get_forward_msg'), 8000, 'get_forward_msg');
  assert.equal(String(call.params.id), RES_ID, 'resId 要原样带给协议端');

  await until(() => !!forwardOf(90001), 8000, '会话日志里的 forward');
  const fwd = forwardOf(90001)!;
  assert.equal(fwd.failed, false);
  assert.deepEqual(fwd.nodes.map((n) => `${n.nickname}：${n.text}`), ['小明：明天交作业', '小红：收到']);
  assert.equal(fwd.nodes[0].ts, 1_760_000_000_000, '节点时间要换成毫秒（协议端给的是秒）');
  // 段里的占位留着：模型那边另有展开正文，界面拿它当"这条是聊天记录"的兜底字样
  assert.ok((entryOf(90001)?.text ?? '').includes('[聊天记录]'), entryOf(90001)?.text);
});

test('模型看到的是展开后的正文，不是一个占位符', async () => {
  // 单独开一个群：MockEngine 只留每条请求"用户侧文本"的前 600 字，
  // 用干净会话保证那句展开正文一定在窗口里，断言才不随前面的历史长短漂。
  const G = 991;
  kernel.container.setGroupState('chat', String(G), true, String(MASTER));
  mock.setReply('get_forward_msg', { messages: [node('小明', '周五团建去不去'), node('小红', '我去', 20002)] });
  const n = mockProvider.calls.length;
  const from = mock.actions.length;
  forwardEvent({ text: '大家看看这个', messageId: 90002, atMe: true, group: G });
  await mock.waitForReply(G, 12000, from);

  await until(() => mockProvider.calls.length > n, 8000, '模型请求');
  // 用 usersJoined 而不是 lastUser：人格插件会在真人那句之后再塞"说话方式/人格强化"那几条 user 消息
  const user = String(mockProvider.calls[mockProvider.calls.length - 1]?.usersJoined ?? '');
  assert.ok(user.includes('大家看看这个'), user);
  assert.ok(user.includes('【聊天记录'), '正文里要有这段记录的展开');
  assert.ok(user.includes('小明：周五团建去不去'), user);
  assert.ok(user.includes('小红：我去'), user);
});

test('条数上限：只留 FORWARD_MAX_NODES 条，剩下的记成 dropped 而不是谎称完整', async () => {
  mock.setReply('get_forward_msg', { messages: manyNodes(FORWARD_MAX_NODES + 7) });
  forwardEvent({ messageId: 90003 });
  await until(() => !!forwardOf(90003), 8000, '超长的 forward 落账');
  const fwd = forwardOf(90003)!;
  assert.equal(fwd.nodes.length, FORWARD_MAX_NODES);
  assert.equal(fwd.dropped, 7, '多出来的那部分要报数');
  assert.equal(forwardTotal(fwd), FORWARD_MAX_NODES + 7);
});

test('记录里的图片落到沙箱 inbox：节点带 files，取不到的那张留着 [图片]', async () => {
  const url = `http://127.0.0.1:${IMG_PORT}/a.png`;
  mock.setReply('get_forward_msg', {
    messages: [
      {
        content: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { file: 'a.png', url } }],
        sender: { nickname: '小明', user_id: MEMBER }, time: 1_760_000_000,
      },
      // 只给文件号、协议端又换不出临时链接：这张就是取不到，不许假装下载成功
      { content: [{ type: 'image', data: { resource_id: 'no-such-id' } }], sender: { nickname: '小红', user_id: 20002 }, time: 1_760_000_000 },
    ],
  });
  const before = mock.actions.length;
  forwardEvent({ messageId: 90004 });
  await until(() => !!forwardOf(90004), 8000, '带图的 forward 落账');
  const fwd = forwardOf(90004)!;
  assert.equal(fwd.nodes[0].text, '看这张 [图片]', '正文里仍留占位，桌面端有图才剥字');
  assert.equal(fwd.nodes[0].files?.length, 1, JSON.stringify(fwd.nodes[0]));
  const f = fwd.nodes[0].files![0];
  assert.equal(f.name, 'a.png');
  const root = kernel.sandbox.root({ platform: 'qq', type: 'group', chatId: String(GROUP) });
  assert.ok(existsSync(join(root, f.rel)), `图要真落进 inbox：${f.rel}`);
  assert.equal(fwd.nodes[1].files, undefined);
  assert.equal(fwd.nodes[1].text, '[图片]');
  // 补问 get_image 时两个键名都要给：LLBot 的 schema 要 file、NapCat 按 OneBot 11 要 file_id，
  // 只给一个就必然有一家永远取不到图（群文件那条路径原来就是这么坏的）
  const gi = mock.actions.slice(before).find((a) => a.action === 'get_image');
  assert.ok(gi, '只给文件号的那张图要问一次 get_image');
  assert.deepEqual(gi.params, { file: 'no-such-id', file_id: 'no-such-id' }, JSON.stringify(gi.params));
});

test('一份记录里几十张图：最多下 FORWARD_MAX_NODE_IMAGES 张，别把协议端打死', async () => {
  mock.setReply('get_forward_msg', {
    messages: Array.from({ length: FORWARD_MAX_NODE_IMAGES + 5 }, (_, i) => ({
      content: [{ type: 'image', data: { file: `i${i}.png`, url: `http://127.0.0.1:${IMG_PORT}/i${i}.png` } }],
      sender: { nickname: `群友${i}`, user_id: 30000 + i }, time: 1_760_000_000,
    })),
  });
  forwardEvent({ messageId: 90009 });
  await until(() => !!forwardOf(90009), 12000, '几十张图的记录落账');
  const fwd = forwardOf(90009)!;
  const got = fwd.nodes.reduce((n, x) => n + (x.files?.length ?? 0), 0);
  assert.equal(got, FORWARD_MAX_NODE_IMAGES, `只该下载 ${FORWARD_MAX_NODE_IMAGES} 张，实得 ${got}`);
  assert.ok(fwd.nodes.every((x) => x.text === '[图片]'), '每张图的占位都留在正文里');
});

test('一条消息里套两份记录：两份都取回并成一张卡，不许漏掉后一份', async () => {
  mock.setReply('get_forward_msg', (params: any) => (
    params?.id === 'RES_A' ? { messages: [node('甲', 'A 里的第一句')] } : { messages: [node('乙', 'B 里的第一句', 20003)] }
  ));
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, text: '', nickname: '小明', messageId: 90008,
    extraSegments: [{ type: 'forward', data: { id: 'RES_A' } }, { type: 'forward', data: { id: 'RES_B' } }],
  });
  await until(() => !!forwardOf(90008), 8000, '两份记录并成一张卡');
  const fwd = forwardOf(90008)!;
  assert.equal(fwd.failed, false);
  assert.deepEqual(fwd.nodes.map((n) => `${n.nickname}：${n.text}`), ['甲：A 里的第一句', '乙：B 里的第一句']);
  assert.equal((entryOf(90008)?.text ?? '').split('[聊天记录]').length - 1, 2, '两个段各留一个占位，界面按卡片剥字');
});

// ---------------- 取不到：不许编内容，也不许打断聊天 ----------------
test('记录里的语音和视频也落盘：段里带 file 用原名，只给号就按类型编名', async () => {
  mock.setReply('get_forward_msg', {
    messages: [
      {
        content: [{ type: 'text', data: { text: '听这段' } }, { type: 'record', data: { file: 'v1.silk', url: `http://127.0.0.1:${IMG_PORT}/v1.silk` } }],
        sender: { nickname: '小明', user_id: MEMBER }, time: 1_760_000_000,
      },
      {
        // 视频段只给 resource_id + temp_url（LLBot 的 OB11 序列化就是这个形状）
        content: [{ type: 'video', data: { resource_id: 'res-9', temp_url: `http://127.0.0.1:${IMG_PORT}/m.mp4` } }],
        sender: { nickname: '小红', user_id: 20002 }, time: 1_760_000_000,
      },
    ],
  });
  forwardEvent({ messageId: 90012 });
  await until(() => !!forwardOf(90012), 8000, '带语音视频的记录落账');
  const fwd = forwardOf(90012)!;
  assert.equal(fwd.nodes[0].text, '听这段 [语音]');
  assert.equal(fwd.nodes[0].files?.[0].name, 'v1.silk', '段里带了原名就别改名');
  assert.equal(fwd.nodes[1].text, '[视频]');
  assert.match(fwd.nodes[1].files?.[0].name ?? '', /^video_.*\.mp4$/, '没给原名要按类型编出带扩展名的名字（raw 端点据此给 MIME）');
  const root = kernel.sandbox.root({ platform: 'qq', type: 'group', chatId: String(GROUP) });
  for (const n of fwd.nodes) for (const f of n.files ?? []) {
    assert.ok(existsSync(join(root, f.rel)), `语音/视频要真落进 inbox：${f.rel}`);
  }
  // 那份临时 URL 带 rkey、几小时就过期：只给模型用，不许躺进会话日志
  const line = JSON.stringify(entryOf(90012));
  assert.ok(!line.includes('127.0.0.1'), `落账条目里不该有临时 URL：${line.slice(0, 200)}`);
});

test('视频附件带上临时 URL：对端取不了我们本机路径，没 URL 就等于模型看不见视频', () => {
  const ev = {
    segments: [], text: '[聊天记录]',
    forward: {
      id: 'x', title: '', dropped: 0, failed: false,
      nodes: [{
        nickname: '甲', userId: '', text: '[视频]', ts: 0,
        files: [{ name: 'bv1.mp4', rel: 'inbox/bv1.mp4', sandboxPath: 'C:/sb/inbox/bv1.mp4', size: 9, url: 'https://multimedia.example/bv1.mp4?rkey=abc' }],
      }],
    },
  } as unknown as ChatEvent;
  const a = attachmentsOf(ev)[0];
  assert.equal(a.kind, 'video');
  assert.equal(a.url, 'https://multimedia.example/bv1.mp4?rkey=abc', '视频要靠公网 URL 进模型');
  assert.equal(a.path, 'C:/sb/inbox/bv1.mp4', '本机路径留着，界面与兜底用');
});

test('语音+视频合共用一份条数上限，超大的视频不下载', async () => {
  mock.setReply('get_forward_msg', {
    messages: Array.from({ length: FORWARD_MAX_NODE_MEDIA + 3 }, (_, i) => ({
      content: [{ type: 'video', data: { file: `m${i}.mp4`, url: `http://127.0.0.1:${IMG_PORT}/m${i}.mp4` } }],
      sender: { nickname: `群友${i}`, user_id: 50000 + i }, time: 1_760_000_000,
    })).concat([{
      // 服务器报个超大 content-length：内核要先问一嘴再决定下不下
      content: [{ type: 'video', data: { file: 'huge.mp4', url: `http://127.0.0.1:${IMG_PORT}/huge.mp4` } }],
      sender: { nickname: '大文件', user_id: 59999 }, time: 1_760_000_000,
    }]),
  });
  forwardEvent({ messageId: 90013 });
  await until(() => !!forwardOf(90013), 12000, '超量视频的记录落账');
  const fwd = forwardOf(90013)!;
  const got = fwd.nodes.reduce((n, x) => n + (x.files?.length ?? 0), 0);
  assert.equal(got, FORWARD_MAX_NODE_MEDIA, `语音+视频最多 ${FORWARD_MAX_NODE_MEDIA} 条，实得 ${got}`);
  assert.ok(fwd.nodes[fwd.nodes.length - 1].text === '[视频]' && !fwd.nodes[fwd.nodes.length - 1].files, '超上限那条只留占位');
});
test('记录套记录：里面那层就地展开，图也照这一层落盘（这就是"记录里的图没显示"的那种）', async () => {
  mock.setReply('get_forward_msg', (p: any) => (String(p?.id) === 'OUTER' ? {
    messages: [
      node('小明', '看这两份'),
      { content: [{ type: 'forward', data: { id: 'INNER_A' } }], sender: { nickname: '极夜', user_id: MEMBER }, time: 1_760_000_000 },
    ],
  } : {
    messages: [{
      content: [{ type: 'text', data: { text: '里面的图' } }, { type: 'image', data: { file: 'inner.png', url: `http://127.0.0.1:${IMG_PORT}/inner.png` } }],
      sender: { nickname: '路人甲', user_id: 20003 }, time: 1_760_000_000,
    }],
  }));
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, text: '', nickname: '小明', messageId: 90010,
    extraSegments: [{ type: 'forward', data: { id: 'OUTER' } }],
  });
  await until(() => !!forwardOf(90010), 8000, '嵌套记录落账');
  const fwd = forwardOf(90010)!;
  assert.deepEqual(fwd.nodes.map((n) => `${n.depth ?? 0}|${n.nickname}`), ['0|小明', '0|极夜', '1|路人甲'], JSON.stringify(fwd.nodes));
  assert.ok(fwd.nodes[1].text.includes('已展开 1 条'), fwd.nodes[1].text);
  assert.equal(fwd.nodes[2].files?.length, 1, '里面那层的图也要落盘');
  const root = kernel.sandbox.root({ platform: 'qq', type: 'group', chatId: String(GROUP) });
  assert.ok(existsSync(join(root, fwd.nodes[2].files![0].rel)), '嵌套层的图要真在 inbox 里');
});

test('套娃只展开到 FORWARD_MAX_DEPTH，其余留占位：不许无限递归取包', async () => {
  const chain = (d: number) => ({
    messages: [{
      content: d < FORWARD_MAX_DEPTH + 1
        ? [{ type: 'text', data: { text: `第 ${d} 层` } }, { type: 'forward', data: { id: `L${d + 1}` } }]
        : [{ type: 'text', data: { text: `第 ${d} 层（最里面）` } }],
      sender: { nickname: `层${d}`, user_id: 40000 + d }, time: 1_760_000_000,
    }],
  });
  mock.setReply('get_forward_msg', (p: any) => chain(Number(String(p?.id).replace('L', '')) || 0));
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, text: '', nickname: '小明', messageId: 90011,
    extraSegments: [{ type: 'forward', data: { id: 'L0' } }],
  });
  await until(() => !!forwardOf(90011), 8000, '深层嵌套落账');
  const fwd = forwardOf(90011)!;
  const deepest = Math.max(...fwd.nodes.map((n) => n.depth ?? 0));
  assert.ok(deepest <= FORWARD_MAX_DEPTH, `只该展开到第 ${FORWARD_MAX_DEPTH} 层，实到 ${deepest}`);
  const tail = fwd.nodes[fwd.nodes.length - 1];
  assert.ok(tail.depth === FORWARD_MAX_DEPTH && tail.text.includes('[聊天记录]'), JSON.stringify(tail));
});
test('协议端不支持 get_forward_msg：failed 落账，占位留着，本轮照常回复', async () => {
  mock.failAction('get_forward_msg');
  const from = mock.actions.length;
  forwardEvent({ text: '你看这份', messageId: 90005, atMe: true });
  await until(() => !!forwardOf(90005), 8000, 'failed 的 forward 落账');

  const fwd = forwardOf(90005)!;
  assert.equal(fwd.failed, true);
  assert.deepEqual(fwd.nodes, [], '取不到就是没有，不许凭空造内容');
  assert.ok((entryOf(90005)?.text ?? '').includes('[聊天记录]'));
  assert.ok(!(entryOf(90005)?.text ?? '').includes('【聊天记录'), '模型那边也不该出现展开块');

  mock.failAction('get_forward_msg', false);
  const reply = await mock.waitForReply(GROUP, 12000, from);
  assert.ok(reply.trim().length > 0, `取不到记录不能影响这轮对话：${reply}`);
});

test('协议端回了个空壳（记录被撤回过）：按取不到处理，不显示空卡片', async () => {
  mock.setReply('get_forward_msg', { messages: [] });
  forwardEvent({ messageId: 90006 });
  await until(() => !!forwardOf(90006), 8000, '空壳的 forward 落账');
  assert.equal(forwardOf(90006)!.failed, true);
  assert.equal(forwardOf(90006)!.nodes.length, 0);
});

test('顶层图片仍走适配器落盘（这条以前没有任何用例覆盖，改预算时差点被静默废掉）', async () => {
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, text: '看这张', nickname: '小明', messageId: 90015,
    extraSegments: [{ type: 'image', data: { file: 'top.png', url: `http://127.0.0.1:${IMG_PORT}/top.png` } }],
  });
  await until(() => !!entryOf(90015), 8000, '图片消息落账');
  const e = entryOf(90015)!;
  assert.equal(e.text, '[图片]看这张');
  const files = (e.data?.files ?? []) as { name: string; rel: string; size: number }[];
  assert.equal(files.length, 1, JSON.stringify(e.data?.files));
  assert.equal(files[0].name, 'top.png');
  assert.ok(files[0].size > 0);
  const root = kernel.sandbox.root({ platform: 'qq', type: 'group', chatId: String(GROUP) });
  assert.ok(existsSync(join(root, files[0].rel)), `图片要真落进 inbox：${files[0].rel}`);
  // 落账的附件只留 name/rel/size：那份带 rkey 的临时 URL 不该躺在会话日志里。
  // （段里那个 url 是补链接时就写回去的，属既有行为，要清另说。）
  assert.ok(!JSON.stringify(e.data?.files).includes('127.0.0.1'), JSON.stringify(e.data?.files));
});

test('语音容器：浏览器能解的原样存，silk 先转 wav（转不动就按原样存别丢文件）', async () => {
  mock.setReply('get_record', { url: `http://127.0.0.1:${IMG_PORT}/a.mp3` });
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, text: '', nickname: '小明', messageId: 90016,
    extraSegments: [{ type: 'record', data: { file: 'a.mp3' } }],
  });
  await until(() => !!entryOf(90016), 8000, 'mp3 语音落账');
  assert.equal(((entryOf(90016)!.data?.files ?? []) as { name: string }[])[0].name, 'a.mp3', 'mp3 浏览器能解，不该被改名');
  // silk 转不动时按原样存那条：由顶层语音用例（假服务器给的是 PNG 字节，ffmpeg 必然失败）钉住
});

test('顶层语音/视频消息也落盘：以前只有 [语音] 三个字，等于没给人听', async () => {
  mock.setReply('get_record', { url: `http://127.0.0.1:${IMG_PORT}/top.silk` });
  mock.sendGroupMessage({
    groupId: GROUP, userId: MEMBER, text: '听这段', nickname: '小明', messageId: 90014,
    extraSegments: [{ type: 'record', data: { file: 'top.silk' } }],
  });
  await until(() => !!entryOf(90014), 8000, '语音消息落账');
  const e = entryOf(90014)!;
  // 段序是 [record, text]（MockOneBot 把 extraSegments 放在文本段之前），所以占位在前
  assert.equal(e.text, '[语音]听这段');
  const files = (e.data?.files ?? []) as { name: string; rel: string }[];
  assert.equal(files.length, 1, JSON.stringify(e.data?.files));
  assert.equal(files[0].name, 'top.silk');
  const root = kernel.sandbox.root({ platform: 'qq', type: 'group', chatId: String(GROUP) });
  assert.ok(existsSync(join(root, files[0].rel)), `语音要真落进 inbox：${files[0].rel}`);
  // 补临时链接时两个键名都要给（NapCat 只认 file_id）
  const gi = mock.actions.filter((a) => a.action === 'get_record').slice(-1)[0];
  assert.deepEqual(gi.params, { file: 'top.silk', file_id: 'top.silk' }, JSON.stringify(gi.params));
});

test('没有合并转发段的消息不会去问 get_forward_msg', async () => {
  const before = mock.actions.length;
  mock.sendGroupMessage({ groupId: GROUP, userId: MEMBER, text: '随便说一句', nickname: '小明', messageId: 90007 });
  await until(() => !!entryOf(90007), 8000, '普通消息落账');
  assert.ok(!mock.actions.slice(before).some((a) => a.action === 'get_forward_msg'), '不该为普通消息多发一次动作');
  assert.equal(forwardOf(90007), undefined, '没有记录就不该有 forward 字段');
});
