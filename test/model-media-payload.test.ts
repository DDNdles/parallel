import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
 */
const GROUP = 671;
const MEMBER = 20001;
const MASTER = 20010;
const RES_ID = 'res-media-1';

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

const send = (messageId: number, extraSegments: any[]) => mock.sendGroupMessage({
  groupId: GROUP, userId: MEMBER, text: '', atMe: true, nickname: '小明', messageId, extraSegments,
});

test('顶层图片/语音/视频：真出现在发出去的请求体里（image_url + input_audio + video_url）', async () => {
  const since = seen.length;
  send(70001, [
    { type: 'text', data: { text: '这张图、这段语音、这个视频都给你' } },
    { type: 'image', data: { file: 'pic.png', url: URL_OF('pic.png') } },
    { type: 'record', data: { file: 'voice.wav', url: URL_OF('voice.wav') } },
    { type: 'video', data: { file: 'clip.mp4', url: URL_OF('clip.mp4') } },
  ]);
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
});

test('人格设定不再占 user 轮：三条设定进 system，最后一条 user 是真人那句', async () => {
  const since = seen.length;
  send(70010, [{ type: 'text', data: { text: '你还记得我是谁吗' } }]);
  const body = await nextBody(since, '纯文本那一发');
  const users = (body?.messages ?? []).filter((m: any) => m?.role === 'user');
  const last = users[users.length - 1];
  assert.match(textOf(Array.isArray(last?.content) ? last.content : []), /你还记得我是谁吗/, '最后一条 user 必须是真人那句');
  assert.ok(!allUserText(body).includes('【人格强化'), '人格强化不该以 user 轮出现（模型会当成对方念的话）');
  const sys = (body?.messages ?? []).filter((m: any) => m?.role === 'system').map((m: any) => String(m.content ?? '')).join('\n');
  assert.match(sys, /【人格强化/, '它要落在 system 里');
});

test('聊天记录里的图与视频：跟着记录正文一起进这一发请求', async () => {
  mock.setReply('get_forward_msg', {
    messages: [
      {
        content: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { file: 'pic.png', url: URL_OF('pic.png') } }],
        sender: { nickname: '小明', user_id: MEMBER }, time: 1_760_000_000, message_format: 'array', message_type: 'group',
      },
      {
        content: [{ type: 'video', data: { resource_id: 'res-clip', temp_url: URL_OF('clip.mp4') } }],
        sender: { nickname: '小红', user_id: 20002 }, time: 1_760_000_001, message_format: 'array', message_type: 'group',
      },
    ],
  });
  const since = seen.length;
  send(70002, [{ type: 'text', data: { text: '昨天那堆记录' } }, { type: 'forward', data: { id: RES_ID } }]);
  const body = await nextBody(since, '带记录媒体的请求');
  const blocks = lastUserBlocks(body);

  assert.ok(allUserText(body).includes('【聊天记录'), '记录正文要展开进用户消息');
  assert.equal(has(blocks, 'image_url').length, 1, JSON.stringify(blocks.map((b) => b?.type)));
  assert.equal(has(blocks, 'video_url').length, 1);
  assert.equal(has(blocks, 'input_audio').length, 0, '这条记录里没有语音');
});

test('模型页那行没声明输入类型：媒体不进请求，且在报错中心留下话（不静默当没听见）', async () => {
  const models = (kernel.config.config.providers as Record<string, any>).stub.models as any[];
  models[0].inputTypes = ['text'];
  try {
    const since = seen.length;
    send(70003, [
      { type: 'text', data: { text: '再听一次' } },
      { type: 'image', data: { file: 'pic.png', url: URL_OF('pic.png') } },
      { type: 'record', data: { file: 'voice.wav', url: URL_OF('voice.wav') } },
    ]);
    const blocks = lastUserBlocks(await nextBody(since, '文本-only 的那一发'));
    assert.deepEqual(blocks.map((b) => b?.type), ['text'], JSON.stringify(blocks));
    await until(() => kernel.errors.list().some((e) => e.category === 'provider' && /没勾选图片、音频/.test(e.message)),
      5000, '报错中心那条 warn');
  } finally {
    models[0].inputTypes = ['text', 'image', 'audio', 'video'];
  }
});

test('语音容器不是浏览器/对端都认的 wav 时：转得动就转，转不动如实报，不塞个假块', async () => {
  // 假端点给的是 PNG 字节冒充 .silk：没有 ffmpeg 能解它，块就不该出现（正文仍留 [语音]）
  mock.setReply('get_record', { url: URL_OF('pic.png') });
  const since = seen.length;
  send(70004, [{ type: 'record', data: { file: 'bad.silk' } }]);
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
