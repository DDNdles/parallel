import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import { MockOneBot } from './helpers/mock-onebot.ts';

/**
 * 「模型到底收没收到这份媒体」不看代码猜，只看内核真发出去的请求报文。
 *
 * 2026-10-15 查出来的两个断点都藏在这条线上，而且都骗过了当时的用例：
 *  - `attachmentsOf` 把段里的裸文件名（QQ 的 `xxx.amr` 这种文件号）当本机路径，
 *    于是内核去读一个不存在的文件，且读失败就不再看 URL —— 顶层图片与顶层语音从来没进过模型；
 *  - `chainStreamFn`（chat 主链路）算好了图片块却没往请求里放，只有 `chatViaPiAi` 那条放了
 *    —— 记录里的图同样被丢掉。
 * 所以这里用假端点顶替模型（照 scripts/dump-payloads.mjs 那套），把 OpenAI 兼容报文里的
 * 内容块逐类钉住：image_url / input_audio / video_url，以及"模型页没声明就不该出现"。
 *
 * 2026-10-16 再加一层：图片**按消息归位**（窗口内每条历史消息的图长在它自己那条上，本轮的图长在最新那条），
 * 音视频（pi-ai 的 content 块里没有这两类）统一补在最新那条 user 的尾部；补传口径 = 下载口径，
 * 记录里的媒体不再二次砍。窗口内的历史（连同它带的媒体）每轮都会跟着再送一遍，
 * 所以钉精确块数的用例各用各的干净群，别让上一个用例的历史混进计数。
 */
const GROUP = 671;
const MEMBER = 20001;
const MASTER = 20010;
const RES_ID = 'res-media-1';
/** 人设主体从当前内置人格读取：断言"设定进了 system 且只进一次"，不绑死某个人格版本 */
const CANON = JSON.parse(readFileSync(
  join(process.cwd(), 'src/plugins/chat/personas/whale-girl/canon.json'), 'utf-8',
)) as { canon: { protagonist: string[]; voice?: { post_history?: string } } };
const PERSONA_BODY = String(CANON.canon.protagonist[0]);
const POST_HISTORY = String(CANON.canon.voice?.post_history ?? '');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
/** 合法的最小 WAV：RIFF/fmt/data，data 段放几个字节的"静音" */
const WAV = (() => {
  const pcm = Buffer.alloc(64, 7);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
})();
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'binary'), Buffer.alloc(16, 1)]);

const MEDIA: Record<string, { buf: Buffer; type: string }> = {
  'pic.png': { buf: PNG, type: 'image/png' },
  'voice.wav': { buf: WAV, type: 'audio/wav' },
  'clip.mp4': { buf: MP4, type: 'video/mp4' },
  // 两帧 1×1 GIF（红/蓝）：QQ 的「动画表情」落盘后就长这样，扩展名还可能是 .png
  'anim.gif': {
    buf: Buffer.from(
      'R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==',
      'base64',
    ),
    type: 'image/gif',
  },
};

let kernel: Kernel;
let dataDir: string;
let mock: MockOneBot;
let srv: Server;
/** 假端点收到的请求报文（OpenAI 兼容 body） */
let seen: any[] = [];
let port = 0;

const URL_OF = (name: string) => `http://127.0.0.1:${port}/media/${name}`;

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 15000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待 ${what} 超时`);
}

/** 等"这一发新请求"：返回它的 body（先记下已有条数，避免读到上一轮的） */
async function nextBody(since: number, what: string) {
  await until(() => seen.length > since, 15000, what);
  return seen[since];
}

/** 最后一条 user 消息的内容块（正文是字符串时按 OpenAI 的写法包一层）。
 *  人格插件那三条设定由 toPiMessages 摘进 system，**不占 user 轮**，所以"最后一条 user"就是真人那句
 *  ——媒体必须挂在这条上。few-shot 语气样例仍是 user/assistant 对，但排在历史之前，不会当最后一条。 */
function lastUserBlocks(body: any): any[] {
  const users = (body?.messages ?? []).filter((m: any) => m?.role === 'user');
  const c = users[users.length - 1]?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}
const has = (blocks: any[], type: string) => blocks.filter((b) => b?.type === type);
const textOf = (blocks: any[]) => blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n');
const allUserText = (body: any) => (body?.messages ?? []).filter((m: any) => m?.role === 'user')
  .map((m: any) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]))
  .flat().filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n');

before(async () => {
  srv = createServer((req, res) => {
    const path = String(req.url ?? '');
    if (path.startsWith('/media/')) {
      const m = MEDIA[path.split('/').pop() ?? ''];
      if (!m) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': m.type });
      res.end(m.buf);
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* 记下原文 */ }
      seen.push(body ?? raw);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta: any, finish: any) => `data: ${JSON.stringify({
        id: 'stub-1', object: 'chat.completion.chunk', created: 0, model: 'stub-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '（占位回复）' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => {
    port = (srv.address() as { port: number }).port;
    r();
  }));

  dataDir = mkdtempSync(join(tmpdir(), 'parallel-media-payload-'));
  kernel = new Kernel({ dataDir, noApi: true });
  kernel.config.config.risk.replyRatePerMin = 10_000;
  kernel.chat.setRatePerMin(10_000);
  const hlOut = kernel.config.config.humanlike.outgoing;
  hlOut.typingBaseDelaySeconds = 0;
  hlOut.typingMaxDelaySeconds = 0;
  hlOut.typingJitterRatio = 0;
  kernel.config.config.onebot.port = 31000 + (process.pid % 2000);
  kernel.config.config.masterIds = [String(MASTER)];
  (kernel.config.config.providers as Record<string, unknown>).stub = {
    label: 'Stub', model: 'stub-model', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: 'openai-compatible', custom: true,
    models: [{ id: 'stub-model', contextWindow: 65536, enabled: true, inputTypes: ['text', 'image', 'audio', 'video'] }],
  };
  kernel.config.config.llm.activeProvider = 'stub';
  kernel.config.config.llm.chatChain = [{ provider: 'stub', model: 'stub-model' }];
  kernel.config.setProviderKey('stub', 'stub-not-a-real-key');
  kernel.config.saveConfig();
  kernel.llm.syncCustomProviders();

  await kernel.boot();
  kernel.container.setGroupState('chat', String(GROUP), true, String(MASTER));
  mock = new MockOneBot(`ws://127.0.0.1:${kernel.config.config.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
  await mock.connect();
  await until(() => mock.actions.some((a) => a.action === 'get_login_info'), 5000, 'get_login_info');
  await until(() => !!(kernel.adapter.status() as { selfId?: string }).selfId, 5000, '适配器 selfId');
});

beforeEach(() => { kernel.humanlike.resetAll(); });

after(async () => {
  mock.close();
  await kernel.shutdown();
  await new Promise((r) => setTimeout(r, 300));
  await new Promise<void>((r) => srv.close(() => r()));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temp 目录系统会回收 */ }
});

const send = (messageId: number, extraSegments: any[], group: string = GROUP) => mock.sendGroupMessage({
  groupId: Number(group), userId: MEMBER, text: '', atMe: true, nickname: '小明', messageId, extraSegments,
});

/**
 * 每个用例一个干净群：上下文时间窗内的历史（连同它带的图/语音/视频）会被这一轮重新带上，
 * 同一个群里连着跑，前一个用例的媒体会混进后一个用例的计数。
 */
let groupSeq = 700;
function freshGroup(): string {
  const g = String(groupSeq++);
  kernel.container.setGroupState('chat', g, true, String(MASTER));
  return g;
}
/** 造一条本机媒体文件：真实路径当附件用（窗口内历史、无 URL 的视频都靠它，见下面两个用例） */
const localFile = (name: string, buf: Buffer) => {
  const p = join(dataDir, name);
  writeFileSync(p, buf);
  return p;
};

test('顶层图片/语音/视频：真出现在发出去的请求体里（image_url + input_audio + video_url）', async () => {
  const G = freshGroup();
  const since = seen.length;
  send(70001, [
    { type: 'text', data: { text: '这张图、这段语音、这个视频都给你' } },
    { type: 'image', data: { file: 'pic.png', url: URL_OF('pic.png') } },
    { type: 'record', data: { file: 'voice.wav', url: URL_OF('voice.wav') } },
    { type: 'video', data: { file: 'clip.mp4', url: URL_OF('clip.mp4') } },
  ], G);
  const blocks = lastUserBlocks(await nextBody(since, '带三种媒体的请求'));

  const imgs = has(blocks, 'image_url');
  assert.equal(imgs.length, 1, JSON.stringify(blocks.map((b) => b?.type)));
  assert.match(String(imgs[0].image_url?.url ?? ''), /^data:image\/png;base64,/, '图片要内联成 data URL');

  const auds = has(blocks, 'input_audio');
  assert.equal(auds.length, 1, '语音此前根本到不了这里：段里的裸文件名被当成了本机路径');
  assert.equal(auds[0].input_audio?.format, 'wav');
  assert.ok(String(auds[0].input_audio?.data ?? '').length > 64, '音频要 base64 成 data');

  const vids = has(blocks, 'video_url');
  assert.equal(vids.length, 1);
  assert.match(String(vids[0].video_url?.url ?? ''), /\/media\/clip\.mp4$/, '视频只递 URL，本机不代读大文件');

  // 三类媒体都挂在"真人那句"上：设定不再占 user 轮（toPiMessages 把它摘进 system）
  assert.match(textOf(blocks), /这张图、这段语音、这个视频都给你/, '媒体要挂在含真人正文的那条 user 上');
  // 图片 prepend 在正文之前、音视频补在最后一条 user 的尾部（pi-ai 的 content 块里没有这两类）
  assert.deepEqual(blocks.map((b) => b?.type), ['image_url', 'text', 'input_audio', 'video_url'],
    `块序：图在前、音视频在尾：${JSON.stringify(blocks.map((b) => b?.type))}`);
});

test('人格设定不再占 user 轮：去重后的设定进 system，最后一条 user 是真人那句', async () => {
  const G = freshGroup();
  const since = seen.length;
  send(70010, [{ type: 'text', data: { text: '你还记得我是谁吗' } }], G);
  const body = await nextBody(since, '纯文本那一发');
  const users = (body?.messages ?? []).filter((m: any) => m?.role === 'user');
  const last = users[users.length - 1];
  assert.match(textOf(Array.isArray(last?.content) ? last.content : []), /你还记得我是谁吗/, '最后一条 user 必须是真人那句');
  assert.ok(!allUserText(body).includes('【人格强化'), '人格强化不该以 user 轮出现（模型会当成对方念的话）');
  const sys = (body?.messages ?? []).filter((m: any) => m?.role === 'system').map((m: any) => String(m.content ?? '')).join('\n');
  // 2026-10-18 反重复：protagonist 与 voice.post_history 是同一整段时只注入一次；
  // 当前 canon 的 post_history 含额外的一句「梁文峰…」，两段已不再重复，此时应作为强化语注入。
  assert.ok(sys.includes(PERSONA_BODY), '人设主体要落在 system 里');
  assert.equal(sys.split(PERSONA_BODY).length - 1, 1, 'protagonist 只注入一次');
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const post = norm(POST_HISTORY);
  const main = norm(CANON.canon.protagonist.join('\n'));
  const duplicate = !!post && (post === main || main.includes(post) || post.includes(main));
  if (duplicate) assert.ok(!sys.includes('【人格强化'), '重复的 post_history 不再注入');
  else assert.ok(sys.includes(POST_HISTORY.trim()), '不重复的 post_history 要作为强化语注入');
});

test('聊天记录里的图与音视频：下载预算内的全部跟着记录一起进这一发请求', async () => {
  // 12 张图 / 2 条语音 / 2 条视频：旧口径在这一档只给模型 8 张图、各 1 条音视频，
  // 现在补传口径 = 下载口径（条数已由适配器的 FORWARD_MAX_NODE_IMAGES / _MEDIA 守住），这里不再二次砍
  const G = freshGroup();
  const IMGS = 12;
  const nodeOf = (seg: any, i: number) => ({
    content: [seg],
    sender: { nickname: `群友${i}`, user_id: 21000 + i }, time: 1_760_000_000,
    message_format: 'array', message_type: 'group',
  });
  mock.setReply('get_forward_msg', {
    messages: [
      ...Array.from({ length: IMGS }, (_, i) => nodeOf(
        { type: 'image', data: { file: 'pic.png', url: URL_OF('pic.png') } }, i)),
      nodeOf({ type: 'record', data: { file: 'voice.wav', url: URL_OF('voice.wav') } }, 90),
      nodeOf({ type: 'record', data: { file: 'voice.wav', url: URL_OF('voice.wav') } }, 91),
      // 视频段只给 resource_id + temp_url（LLBot 的 OB11 序列化就是这个形状）
      nodeOf({ type: 'video', data: { resource_id: 'res-c1', temp_url: URL_OF('clip.mp4') } }, 92),
      nodeOf({ type: 'video', data: { resource_id: 'res-c2', temp_url: URL_OF('clip.mp4') } }, 93),
    ],
  });
  const since = seen.length;
  send(70002, [{ type: 'text', data: { text: '昨天那堆记录' } }, { type: 'forward', data: { id: RES_ID } }], G);
  const body = await nextBody(since, '带记录媒体的请求');
  const blocks = lastUserBlocks(body);

  assert.ok(allUserText(body).includes('【聊天记录'), '记录正文要展开进用户消息');
  const types = JSON.stringify(blocks.map((b) => b?.type));
  assert.equal(has(blocks, 'image_url').length, IMGS, `下载了多少张图就给模型多少张：${types}`);
  assert.equal(has(blocks, 'input_audio').length, 2, `两条语音都要送：${types}`);
  assert.equal(has(blocks, 'video_url').length, 2, `两条视频都要送：${types}`);
  assert.deepEqual(has(blocks, 'video_url').map((b) => String(b.video_url?.url ?? '')), [URL_OF('clip.mp4'), URL_OF('clip.mp4')],
    '记录里的视频带公网 URL，照旧递 URL 不在本机代读');
});

test('模型页那行没声明输入类型：媒体不进请求，且在报错中心留下话（不静默当没听见）', async () => {
  const G = freshGroup();
  const models = (kernel.config.config.providers as Record<string, any>).stub.models as any[];
  models[0].inputTypes = ['text'];
  try {
    const since = seen.length;
    send(70003, [
      { type: 'text', data: { text: '再听一次' } },
      { type: 'image', data: { file: 'pic.png', url: URL_OF('pic.png') } },
      { type: 'record', data: { file: 'voice.wav', url: URL_OF('voice.wav') } },
    ], G);
    const blocks = lastUserBlocks(await nextBody(since, '文本-only 的那一发'));
    assert.deepEqual(blocks.map((b) => b?.type), ['text'], JSON.stringify(blocks));
    // 拦下它们的是两处、各留一条：图片在播种区按链首模型的输入类型拦（pi-ai 的 content 块里它才存在），
    // 音视频在 chainStreamFn 按同一张筛子拦
    await until(() => kernel.errors.list().some((e) => e.category === 'provider' && /链上模型不收图片/.test(e.message)),
      5000, '图片被拦下那条 warn');
    await until(() => kernel.errors.list().some((e) => e.category === 'provider' && /没勾选音频/.test(e.message)),
      5000, '音视频被拦下那条 warn');
  } finally {
    models[0].inputTypes = ['text', 'image', 'audio', 'video'];
  }
});

test('语音容器不是浏览器/对端都认的 wav 时：转得动就转，转不动如实报，不塞个假块', async () => {
  const G = freshGroup();
  // 假端点给的是 PNG 字节冒充 .silk：没有 ffmpeg 能解它，块就不该出现（正文仍留 [语音]）
  mock.setReply('get_record', { url: URL_OF('pic.png') });
  const since = seen.length;
  send(70004, [{ type: 'record', data: { file: 'bad.silk' } }], G);
  const blocks = lastUserBlocks(await nextBody(since, '语音那条请求'));
  const auds = has(blocks, 'input_audio');
  if (auds.length) {
    // 本机 ffmpeg 真把那份"PNG"转出了东西（不该发生，但形状要合法）
    assert.match(String(auds[0].input_audio?.format ?? ''), /^(wav|mp3)$/, JSON.stringify(auds[0]));
  } else {
    assert.ok(/语音/.test(JSON.stringify(kernel.errors.list().map((e) => e.message))), '转不动要在报错中心留话');
  }
  assert.ok(!JSON.stringify(blocks).includes('bad.silk'), '不要把协议端的文件号当成内容塞进去');
});

// ---------------- 近端历史：historyLimit 内的媒体按消息归位，超出条数的旧消息不出现 ----------------

const chatOf = (groupId: string) => ({ platform: 'qq', type: 'group' as const, chatId: groupId });

/** system 里的这两个新分节（405 只在普通轮注入；475 只要有媒体就注入——下面两个用例都是普通轮） */
const systemText = (body: any) => (body?.messages ?? []).filter((m: any) => m?.role === 'system')
  .map((m: any) => String(m.content ?? '')).join('\n');

test('近端历史消息带的图：落在它自己那条消息上；音视频按口径补在最新那条 user 尾部', async () => {
  const G = freshGroup();
  const chat = chatOf(G);
  // 造一条近端历史：真人上一句就带着图与语音（pushUser 带附件，正是 pipeline 入账时的形状）
  kernel.history.pushUser(chat, '这是我前面发的那张图', [
    { kind: 'image', path: localFile('hist-window.png', PNG), name: 'hist-window.png', mime: 'image/png' },
    { kind: 'audio', path: localFile('hist-window.wav', WAV), name: 'hist-window.wav', mime: 'audio/wav' },
  ]);

  const since = seen.length;
  send(71001, [{ type: 'text', data: { text: '接着说' } }], G);
  const body = await nextBody(since, '带近端历史的请求');
  const users = (body?.messages ?? []).filter((m: any) => m?.role === 'user');

  // 历史那条：图长在它自己那条 content 上（不是最新那条）
  const hist = users.find((m: any) => Array.isArray(m.content) && textOf(m.content).includes('这是我前面发的那张图'));
  assert.ok(hist, `近端历史消息要在请求体里：${JSON.stringify(users.map((m: any) => textOf(Array.isArray(m.content) ? m.content : [])))}`);
  const histTypes = hist.content.map((b: any) => b?.type);
  const histImgs = has(hist.content, 'image_url');
  assert.equal(histImgs.length, 1, `历史那条自己的图要归位到它这条上：${JSON.stringify(histTypes)}`);
  assert.match(String(histImgs[0].image_url?.url ?? ''), /^data:image\/png;base64,/, '本机文件要读成 data URL');
  assert.equal(has(hist.content, 'input_audio').length, 0, '语音不挂在历史那条上（pi-ai 的 content 块里没有音频）');

  // 本轮最新那条：正文在、图不在；历史里的语音补在这条的尾部
  const blocks = lastUserBlocks(body);
  assert.match(textOf(blocks), /接着说/);
  assert.equal(has(blocks, 'image_url').length, 0, `本轮没带图，最新那条 user 上就不该有图：${JSON.stringify(blocks.map((b) => b?.type))}`);
  assert.equal(has(blocks, 'input_audio').length, 1, '近端历史的语音要补在最新那条 user 上');

  // 「本轮媒体补传」要说清这一发带了什么、长在哪：历史拿不到作者，按"更早的消息"标注
  const sys = systemText(body);
  assert.match(sys, /# 本轮媒体补传/, '475 分节要交代这一发的媒体清单');
  assert.match(sys, /更早的消息：图片×1 \/ 语音×1/, '近端历史那条的媒体要列出来');
  assert.match(sys, /# 上下文/, '405 分节要说明只看得到近端消息');
  assert.match(sys, /最多 \d+ 条/);
});

test('超出 historyLimit 的旧消息不进请求体：它带的图也不出现', async () => {
  const G = freshGroup();
  const chat = chatOf(G);
  const savedLimit = kernel.config.config.storage.historyLimit;
  kernel.config.config.storage.historyLimit = 2;
  kernel.history.setLimit(2);
  try {
    kernel.history.pushUser(chat, '这是很久以前那张图', [
      { kind: 'image', path: localFile('hist-old.png', PNG), name: 'hist-old.png', mime: 'image/png' },
    ]);
    kernel.history.pushAssistant(chat, '收到一');
    kernel.history.pushAssistant(chat, '收到二');

    const since = seen.length;
    send(71002, [{ type: 'text', data: { text: '现在说点别的' } }], G);
    const body = await nextBody(since, '超出条数历史那一发');
    assert.ok(!allUserText(body).includes('这是很久以前那张图'), '超出 historyLimit 的正文不许出现在请求体里');
    const allBlocks = (body?.messages ?? []).filter((m: any) => m?.role === 'user')
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    assert.equal(has(allBlocks, 'image_url').length, 0, '那条带的图也不许进请求体');
  } finally {
    kernel.config.config.storage.historyLimit = savedLimit;
    kernel.history.setLimit(savedLimit);
  }
});

// ---------------- 动图：QQ 的「动画表情」在 chat 主链路上要被摊成分帧拼图 ----------------

test('动图表情（QQ 存成 .png 但内容是两帧 GIF）：进请求体的是 JPEG 分帧拼图 + 一句排版说明', async () => {
  // 项目自带的 ffmpeg 是抽帧的前提（测试的 dataDir 是临时目录，PATH 里通常也没有）
  const bundled = join(process.cwd(), 'data', 'bin', 'ffmpeg.exe');
  if (!existsSync(bundled)) return;
  const { setFfmpegCandidate } = await import('../src/kernel/services/media.ts');
  setFfmpegCandidate(bundled);

  const G = freshGroup();
  const since = seen.length;
  // 段里给 .png 名字、实际字节是 GIF：识别只能按内容，不能按扩展名
  send(71004, [
    { type: 'text', data: { text: '这个表情好好笑' } },
    { type: 'image', data: { file: 'sticker.png', url: URL_OF('anim.gif') } },
  ], G);
  const blocks = lastUserBlocks(await nextBody(since, '动图表情那一发'));
  const imgs = has(blocks, 'image_url');
  assert.equal(imgs.length, 1, `图片块要在：${JSON.stringify(blocks.map((b) => b?.type))}`);
  const url = String(imgs[0].image_url?.url ?? '');
  assert.match(url, /^data:image\/jpeg;base64,/, '动图要换成分帧拼图，而不是原始 GIF');
  // 拼图是 JPEG：base64 解出来要以 JPEG 的 SOI 魔数（FF D8 FF）开头
  const jpegBytes = Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64');
  assert.deepEqual([...jpegBytes.subarray(0, 3)], [0xff, 0xd8, 0xff], '拼图本体必须是 JPEG');
  assert.match(textOf(blocks), /动图/, '要告诉模型这是动图的分帧，不是多张不同的图');
  assert.match(textOf(blocks), /这个表情好好笑/, '真人正文仍要在');
});

// 同一条动图在 200 条窗口里被反复发：每出现一次就摊一张 3×3 拼图，几次重复就是几十张"同一只吉他"，
// 模型会把它判成刷屏。去重后只附第一张，后面只留一句"同一条又出现了一次"。
test('同一条动图在窗口里重复出现：只附一次分帧拼图，后面的只留说明', async () => {
  const bundled = join(process.cwd(), 'data', 'bin', 'ffmpeg.exe');
  if (existsSync(bundled)) {
    const { setFfmpegCandidate } = await import('../src/kernel/services/media.ts');
    setFfmpegCandidate(bundled);
  }
  const { toPiMessages } = await import('../src/kernel/services/pi-ai.ts');
  const att = { kind: 'image', url: URL_OF('anim.gif'), mime: 'image/gif' };
  const r = await toPiMessages(
    [
      { role: 'user', content: '第一次发这个表情', ts: 1 },
      { role: 'user', content: '又发了一次', ts: 2 },
    ] as any,
    { id: 'stub-model', provider: '' },
    '',
    { attachmentsFor: () => [att as any] },
  );
  const blocks = (m: any) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]);
  assert.equal(has(blocks(r.messages[0]), 'image').length, 1, '第一次要附图');
  assert.equal(has(blocks(r.messages[1]), 'image').length, 0, '同一条动图不再重复附图');
  assert.match(textOf(blocks(r.messages[1])), /同一条动图又出现了一次/);
  assert.match(textOf(blocks(r.messages[1])), /第 2 次/);
  assert.match(textOf(blocks(r.messages[1])), /又发了一次/, '重复那条的正文不能被吃掉');
});

// ---------------- 视频：没有公网 URL 时的内联兜底 ----------------

test('视频没有公网 URL、只有本机文件且 ≤20MB：读成 base64 内联，不是丢掉', async () => {
  const G = freshGroup();
  // 段里的 file 直接给本机路径（existsSync 命中）：适配器不去问协议端、也不下载，
  // 正好造出"只有本机文件、没有公网 URL"那种视频
  const local = localFile('local-clip.mp4', MP4);
  const since = seen.length;
  send(71003, [
    { type: 'text', data: { text: '这个视频看看' } },
    { type: 'video', data: { file: local } },
  ], G);
  const blocks = lastUserBlocks(await nextBody(since, '本机视频那一发'));
  const vids = has(blocks, 'video_url');
  assert.equal(vids.length, 1, `本机视频要内联送出：${JSON.stringify(blocks.map((b) => b?.type))}`);
  const url = String(vids[0].video_url?.url ?? '');
  assert.match(url, /^data:video\/mp4;base64,/, '没有 URL 就内联成 data URL');
  assert.ok(Buffer.from(url.slice('data:video/mp4;base64,'.length), 'base64').equals(MP4),
    '内联的就是本机那份文件本身（不许递对端取不到的本机路径）');
});
