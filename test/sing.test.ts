import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockOneBot } from './helpers/mock-onebot.ts';
import { estimateSeconds } from '../src/plugins/sing/index.ts';
import type { ChatRef } from '../src/kernel/types.ts';

// ============================================================
// 唱歌插件（sing）
//
//  1. fal-ai-ace-step：提交 → 轮询 → 取结果 → 下载 mp3；请求体/鉴权头按官方
//     schema（含 2026-10 核对到的 original_tags 必填）；
//  2. provider=custom 通用契约：POST {baseUrl}/generate → 音频直出；
//  3. 配置缺失 / 500 / 轮询超时都返回可转述的中文错误，不抛异常；
//  4. 冷却按会话生效，失败的调用不占冷却、不占额度；
//  5. 额度按用户每自然日计数，失败退回；主人默认不限；
//  6. reload 后工具恰好一个、REST /status 仍通。
//
//  网络一律 mock globalThis.fetch；发消息只走 MockOneBot，不碰真实 QQ。
// ============================================================

const realFetch = globalThis.fetch;
const FAL_SUBMIT = 'https://queue.fal.run/fal-ai/ace-step/audio-to-audio';
const STATUS_URL = `${FAL_SUBMIT}/requests/req_1/status`;
const RESULT_URL = `${FAL_SUBMIT}/requests/req_1`;
const MEDIA_URL = 'https://v3.fal.media/files/test/out.mp3';
const MINIMAX_URL = 'https://api.minimax.cn/v1/music_generation';

/** MPEG1 Layer III 128kbps / 44.1kHz 的一帧：FF FB 90 00 + 413 字节负载（帧长 417） */
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
/** ID3v2 空标签（10 字节头，size=0）——插件要能跳过它找到第一帧 */
const ID3_HEADER = Buffer.concat([Buffer.from('ID3'), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])]);
/** 10 帧有效 mp3：插件只嗅文件头 + 解析帧头估时长，不解码 */
const MP3 = Buffer.concat([ID3_HEADER, ...Array.from({ length: 10 }, () => MP3_FRAME)]);
/** 参考音频：RIFF/WAVE 头够插件认出 wav */
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(64, 0)]);

/** 造一段带 fmt/data 块的标准 PCM WAV（用于估时长单测，不在网络 mock 里用） */
function wavOf(byteRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // 单声道
  header.writeUInt32LE(16000, 24);      // sampleRate
  header.writeUInt32LE(byteRate, 28);   // byteRate
  header.writeUInt16LE(2, 32);          // blockAlign
  header.writeUInt16LE(16, 34);         // bitsPerSample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${what} 超时`);
}

type Captured = { url: string; method: string; headers: Record<string, string>; body: any };

/** 只拦命中的请求；其余走真 fetch（内核自身不该发，留作兜底） */
function mockFetch(handler: (url: string) => Response | undefined) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body: any;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method: String(init.method ?? 'GET'), headers, body });
    const resp = handler(url);
    if (!resp) return realFetch(input, init);
    return resp;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const jsonResp = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const audioResp = () => new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });

async function boot(opts: {
  apiKey?: string;
  cookie?: string;
  config?: Record<string, unknown>;
  refWav?: boolean;
  connect?: boolean;
} = {}) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-sing-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  cfg.masterIds = ['10001'];
  if (opts.apiKey !== undefined) kernel.config.setPluginSecret('sing', 'apiKey', opts.apiKey);
  // cookie 是 secret 字段：必须走 secrets 存储，写 plugin_user_config 读不到
  if (opts.cookie !== undefined) kernel.config.setPluginSecret('sing', 'cookie', opts.cookie);

  const values: Record<string, unknown> = { ...(opts.config ?? {}) };
  if (opts.refWav) {
    const refPath = join(dataDir, 'dafeiyu-ref.wav');
    writeFileSync(refPath, WAV);
    if (values.refAudio === undefined) values.refAudio = refPath;
  }
  for (const [key, value] of Object.entries(values)) {
    kernel.db.run(
      `INSERT INTO plugin_user_config (plugin_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      'sing', key, JSON.stringify(value), Date.now(),
    );
  }

  await kernel.boot();

  let mock: MockOneBot | undefined;
  if (opts.connect) {
    mock = new MockOneBot(`ws://127.0.0.1:${cfg.onebot.port}/onebot`, kernel.config.secrets.onebotAccessToken);
    await mock.connect();
    await until(() => mock!.actions.some((a) => a.action === 'get_login_info'), 5000, '协议端握手');
  }

  const chat: ChatRef = { platform: 'qq', type: 'group', chatId: '7710' };
  const toolOf = (role: 'owner' | 'admin' | 'member' = 'member', target: ChatRef = chat) => {
    const t = kernel.container.toolsForChat(target, role, 'chat').find((x) => x.name === 'sing');
    assert.ok(t, `${role} 的 chat 面缺少 sing`);
    return t!;
  };
  const call = async (
    args: Record<string, unknown>,
    o: { role?: 'owner' | 'admin' | 'member'; userId?: string; chat?: ChatRef } = {},
  ): Promise<string> => {
    const role = o.role ?? 'member';
    const target = o.chat ?? chat;
    const userId = o.userId ?? (role === 'member' ? '20001' : role === 'admin' ? '10002' : '10001');
    const r = await toolOf(role, target).handler(args, {
      chat: target,
      role,
      event: {
        platform: target.platform, type: target.type, chatId: target.chatId, userId, nickname: userId,
        senderRole: role, segments: [], text: '', isAtMe: true, isReplyToMe: false, raw: null, ts: 0, role,
      },
    } as any);
    return typeof r === 'string' ? r : r.content;
  };

  return {
    kernel, dataDir, chat, mock, call, toolOf,
    cleanup: async () => {
      mock?.close();
      await kernel.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 从 MockOneBot 发出的 send_group_msg 里取 record 段，并校验本地文件真实存在 */
function recordFileOf(act: { params: any }): string {
  const segments = (act.params.message ?? []) as any[];
  const record = segments.find((s) => s.type === 'record');
  assert.ok(record, `发送段里要有 record：${JSON.stringify(segments)}`);
  const file = String(record.data?.file ?? '');
  assert.match(file, /^file:\/\//, 'record 必须自己转成 file://（adapter 只转 image）');
  const abs = fileURLToPath(file);
  assert.ok(existsSync(abs), `record 指向的本地文件不存在：${abs}`);
  return abs;
}

test('fal-ai-ace-step：提交 → 轮询 → 下载 mp3，record 语音发进群', async () => {
  const k = await boot({
    apiKey: 'fal-key-123',
    refWav: true,
    connect: true,
    config: { provider: 'fal-ai-ace-step', cooldownSeconds: 0, timeoutMs: 5000, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => {
    if (url === FAL_SUBMIT) {
      return jsonResp({ request_id: 'req_1', status: 'IN_QUEUE', status_url: STATUS_URL, response_url: RESULT_URL });
    }
    if (url === STATUS_URL) {
      return jsonResp({ request_id: 'req_1', status: 'COMPLETED', status_url: STATUS_URL, response_url: RESULT_URL });
    }
    if (url === RESULT_URL) {
      return jsonResp({
        audio: { url: MEDIA_URL, content_type: 'audio/mpeg', file_size: MP3.length },
        seed: 42, tags: 'cute female vocal', lyrics: '人是猫',
      });
    }
    if (url === MEDIA_URL) return audioResp();
    return undefined;
  });
  try {
    const out = await k.call({
      lyrics: '[verse]\n人是猫 人是猫',
      tags: 'cute female vocal, pop, 120bpm',
      seconds: 30,
    });
    assert.match(out, /已把这段歌唱进语音发到会话里了（约 \d+ 秒）/, out);

    const submit = mock.calls[0]!;
    assert.equal(submit.url, FAL_SUBMIT);
    assert.equal(submit.method, 'POST');
    assert.equal(submit.headers.authorization, 'Key fal-key-123');
    assert.equal(submit.headers['content-type'], 'application/json');
    assert.match(String(submit.body.audio_url), /^data:audio\/wav;base64,/, '本地参考音频要转成 data URI');
    assert.equal(submit.body.tags, 'cute female vocal, pop, 120bpm');
    assert.equal(submit.body.original_tags, 'cute female vocal, pop, 120bpm',
      '官方 OpenAPI 把 original_tags 标为必填（调研结论漏了）');
    assert.equal(submit.body.lyrics, '[verse]\n人是猫 人是猫');
    assert.equal(submit.body.edit_mode, 'lyrics');
    assert.equal('seconds' in submit.body, false, 'ACE-Step 没有时长字段');

    const poll = mock.calls.find((c) => c.url === STATUS_URL);
    assert.ok(poll, '要轮询 status_url');
    assert.equal(poll!.method, 'GET');
    assert.equal(poll!.headers.authorization, 'Key fal-key-123');
    const result = mock.calls.find((c) => c.url === RESULT_URL);
    assert.ok(result, '完成要取 response_url');
    assert.equal(result!.headers.authorization, 'Key fal-key-123');
    const media = mock.calls.find((c) => c.url === MEDIA_URL);
    assert.ok(media, '要下载音频 URL');
    assert.equal(media!.headers.authorization, undefined, '媒体直链不带服务商鉴权');

    const abs = recordFileOf(await k.mock!.waitForAction('send_group_msg', 5000));
    assert.deepEqual(readFileSync(abs), MP3, '落盘的 mp3 字节要与下载内容一致');
    assert.ok(abs.startsWith(join(k.dataDir, 'plugin-data', 'sing')), '产物落在 pluginDataDir/sing');
    assert.match(abs.replace(/\\/g, '/'), /sing_[a-z0-9]+\.mp3$/);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('provider=custom：POST {baseUrl}/generate，body {lyrics,tags,seconds}，响应体直接是音频（SCOW 代理带上会话 Cookie）', async () => {
  const base = 'http://127.0.0.1:18080';
  const k = await boot({
    apiKey: 'cus-key-456',
    cookie: 'SCOW_USER=ustc-test-token',   // 107 平台这类 SCOW 代理只认 Cookie
    connect: true,
    config: {
      provider: 'custom', baseUrl: base, cooldownSeconds: 0, dailyQuota: 5,
    },
  });
  const mock = mockFetch((url) => (url === `${base}/generate` ? audioResp() : undefined));
  try {
    const out = await k.call({ lyrics: '啦啦啦大肥鱼', tags: 'chill, female vocal', seconds: 25 });
    assert.match(out, /已把这段歌唱进语音/, out);

    assert.equal(mock.calls.length, 1);
    const req = mock.calls[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `${base}/generate`);
    assert.equal(req.headers.authorization, 'Bearer cus-key-456');
    assert.equal(req.headers.cookie, 'SCOW_USER=ustc-test-token', '配了 cookie 就要随 custom 请求带上');
    assert.deepEqual(req.body, { lyrics: '啦啦啦大肥鱼', tags: 'chill, female vocal', seconds: 25 });

    const abs = recordFileOf(await k.mock!.waitForAction('send_group_msg', 5000));
    assert.deepEqual(readFileSync(abs), MP3);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('MiniMax：同步接口返回 data.audio URL，再下载；voiceId 不参与（用参考音频 base64）', async () => {
  const k = await boot({
    apiKey: 'mm-key-789',
    refWav: true,
    config: { provider: 'minimax-music', cooldownSeconds: 0, timeoutMs: 5000 },
  });
  const mock = mockFetch((url) => {
    if (url === MINIMAX_URL) {
      return jsonResp({ data: { audio: MEDIA_URL, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } });
    }
    if (url === MEDIA_URL) return audioResp();
    return undefined;
  });
  try {
    // 桌面端模拟会话：不需要协议端也能走完发送
    const desk: ChatRef = { platform: 'ui', type: 'group', chatId: 'desk' };
    // 官方 music-cover 要求 lyrics/prompt 至少 10 字符，成功样例必须满足下限
    const out = await k.call({ lyrics: '喵喵喵喵喵喵喵喵喵喵', tags: '二次元流行, 欢快, 电子萌系' }, { chat: desk });
    assert.match(out, /已把这段歌唱进语音/, out);

    const req = mock.calls[0]!;
    assert.equal(req.url, MINIMAX_URL);
    assert.equal(req.headers.authorization, 'Bearer mm-key-789');
    assert.equal(req.body.model, 'music-cover');
    assert.equal(req.body.prompt, '二次元流行, 欢快, 电子萌系');
    assert.equal(req.body.lyrics, '喵喵喵喵喵喵喵喵喵喵');
    assert.equal(req.body.output_format, 'url');
    assert.equal(typeof req.body.audio_base64, 'string', '本地参考音频走 audio_base64');
    assert.equal(req.body.audio_url, undefined);
    assert.ok(mock.calls.some((c) => c.url === MEDIA_URL), '要下载返回的音频地址');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('MiniMax：歌词/风格低于官方 10 字符下限（或超过 1000）时直接拒绝，不发请求', async () => {
  const k = await boot({
    apiKey: 'mm-key-789',
    refWav: true,
    config: { provider: 'minimax-music', cooldownSeconds: 0, dailyQuota: 5 },
  });
  const mock = mockFetch(() => undefined);
  const desk: ChatRef = { platform: 'ui', type: 'group', chatId: 'desk' };
  try {
    const shortLyrics = await k.call({ lyrics: '喵喵喵', tags: '二次元流行, 欢快, 电子萌系' }, { chat: desk });
    assert.match(shortLyrics, /10/, shortLyrics);

    const shortTags = await k.call({ lyrics: '喵喵喵喵喵喵喵喵喵喵', tags: '欢快' }, { chat: desk });
    assert.match(shortTags, /风格|10/, shortTags);

    const longLyrics = await k.call({ lyrics: '喵'.repeat(1001), tags: '二次元流行, 欢快, 电子萌系' }, { chat: desk });
    assert.match(longLyrics, /1000/, longLyrics);

    assert.equal(mock.calls.length, 0, '参数不合官方范围时不该发请求');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('没配 API Key / 没配音色：返回中文配置错误且不发请求；beforeLLM 只追加节', async () => {
  const noKey = await boot();
  const mock = mockFetch(() => undefined);
  try {
    assert.match(await noKey.call({ lyrics: '唱一首' }), /还没配置.*API Key/);
    assert.equal(mock.calls.length, 0, '没配 Key 时不该发请求');

    const hooks = noKey.kernel.container.get('sing')!.hooks;
    const req: any = {
      chat: noKey.chat,
      event: { platform: 'qq', type: 'group', chatId: noKey.chat.chatId, userId: '20001' },
      system: 'base', messages: [], tools: [],
      systemSections: [{ order: 1, text: '别的插件先注入的节' }],
    };
    const out = await hooks.beforeLLM!(req);
    assert.equal(out.systemSections![0].text, '别的插件先注入的节', '原有节必须保留');
    const sec = out.systemSections!.find((s) => s.title === 'sing');
    assert.ok(sec, 'beforeLLM 要追加唱歌说明节');
    assert.equal(sec!.order, 291);
    assert.match(sec!.text, /sing/);
    assert.match(sec!.text, /一次只唱一首/);
    assert.match(sec!.text, /还没配置唱歌服务的 API Key/);
  } finally {
    mock.restore();
    await noKey.cleanup();
  }

  const noVoice = await boot({ apiKey: 'fal-key-123', config: { provider: 'fal-ai-ace-step' } });
  const mock2 = mockFetch(() => undefined);
  try {
    const out = await noVoice.call({ lyrics: '唱一首' });
    assert.match(out, /还没配置好/);
    assert.match(out, /参考音频|音色/);
    assert.equal(mock2.calls.length, 0, '配置不全时不该消耗一次网络调用');
  } finally {
    mock2.restore();
    await noVoice.cleanup();
  }
});

test('服务 500 / 轮询超时：返回中文错误字符串，不抛未捕获异常', async () => {
  const base = 'http://127.0.0.1:18081';
  const failed = await boot({
    apiKey: 'cus-key-456',
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 0, timeoutMs: 3000 },
  });
  const mock = mockFetch((url) => (url === `${base}/generate`
    ? new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'content-type': 'application/json' } })
    : undefined));
  try {
    const out = await failed.call({ lyrics: '唱一首' });
    assert.match(out, /自部署唱歌服务/);
    assert.match(out, /HTTP 500/);
  } finally {
    mock.restore();
    await failed.cleanup();
  }

  const slow = await boot({
    apiKey: 'fal-key-123',
    refWav: true,
    config: { provider: 'fal-ai-ace-step', timeoutMs: 1000, cooldownSeconds: 0 },
  });
  const mock2 = mockFetch((url) => {
    if (url === FAL_SUBMIT) {
      return jsonResp({ request_id: 'req_1', status: 'IN_QUEUE', status_url: STATUS_URL, response_url: RESULT_URL });
    }
    if (url === STATUS_URL) return jsonResp({ request_id: 'req_1', status: 'IN_PROGRESS' });
    return undefined;
  });
  try {
    const out = await slow.call({ lyrics: '唱一首很长的歌' });
    assert.match(out, /超时/, out);
    assert.ok(mock2.calls.length >= 2, '提交之后至少轮询过一次');
    assert.ok(!mock2.calls.some((c) => c.url === RESULT_URL), '超时后不该去取结果');
  } finally {
    mock2.restore();
    await slow.cleanup();
  }
});

test('额度：失败不计数，满 dailyQuota 拒绝，主人默认不限', async () => {
  const base = 'http://127.0.0.1:18082';
  const k = await boot({
    apiKey: 'cus-key-456',
    connect: true,
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 0, dailyQuota: 1 },
  });
  let n = 0;
  const mock = mockFetch((url) => {
    if (url !== `${base}/generate`) return undefined;
    n += 1;
    return n === 1
      ? new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'content-type': 'application/json' } })
      : audioResp();
  });
  try {
    assert.match(await k.call({ lyrics: '第一首会失败' }), /HTTP 500/, '第一次失败');
    assert.match(await k.call({ lyrics: '第二首能唱' }), /已把这段歌唱进语音/);

    const refused = await k.call({ lyrics: '第三首被额度拦住' });
    assert.match(refused, /额度用完了/);
    assert.match(refused, /1\/1/);
    assert.equal(mock.calls.length, 2, '失败那次不计数，被拒绝时不再打 API');

    assert.match(await k.call({ lyrics: '主人还能唱' }, { role: 'owner' }), /已把这段歌唱进语音/);
    assert.equal(mock.calls.length, 3, '主人不受每日额度限制');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('冷却：同会话第二次被拦；失败调用不占冷却', async () => {
  const base = 'http://127.0.0.1:18083';
  const k = await boot({
    apiKey: 'cus-key-456',
    connect: true,
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 60, dailyQuota: 5 },
  });
  let n = 0;
  const mock = mockFetch((url) => {
    if (url !== `${base}/generate`) return undefined;
    n += 1;
    return n === 1
      ? new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'content-type': 'application/json' } })
      : audioResp();
  });
  const realNow = Date.now;
  try {
    assert.match(await k.call({ lyrics: '第一次失败' }), /HTTP 500/);
    assert.match(await k.call({ lyrics: '失败后立刻能再唱' }), /已把这段歌唱进语音/,
      '失败调用不该占住冷却');

    const blocked = await k.call({ lyrics: '冷却里还想唱' });
    assert.match(blocked, /刚唱过|冷却/);
    assert.equal(mock.calls.length, 2, '冷却中被拦时不该打 API');

    // 时间往前拨 61 秒：冷却结束
    const baseNow = realNow();
    Date.now = () => baseNow + 61_000;
    assert.match(await k.call({ lyrics: '冷却结束再唱' }), /已把这段歌唱进语音/);
    assert.equal(mock.calls.length, 3);
  } finally {
    Date.now = realNow;
    mock.restore();
    await k.cleanup();
  }
});

test('冷却：生成时长超过 cooldownSeconds 时，同会话仍由在途锁拦住第二首', async () => {
  const base = 'http://127.0.0.1:18085';
  const k = await boot({
    apiKey: 'cus-key-456',
    connect: true,
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 1, timeoutMs: 10_000, dailyQuota: 5 },
  });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = (async () => {
    calls += 1;
    await gate;
    return audioResp();
  }) as typeof fetch;
  try {
    const first = k.call({ lyrics: '第一首正在唱' });
    await until(() => calls === 1, 3000, '第一首开始生成');
    // 等到冷却时间过去：只靠时间戳的实现这时会放行第二首
    await new Promise((r) => setTimeout(r, 1100));
    const second = await k.call({ lyrics: '第二首想插队' });
    assert.match(second, /已经有一首在唱|唱完/, second);
    assert.equal(calls, 1, '第一首还在途时不能再打一次生成接口');

    release();
    assert.match(await first, /已把这段歌唱进语音/, '第一首仍应正常唱完并发出');
  } finally {
    release?.();
    globalThis.fetch = realFetch;
    await k.cleanup();
  }
});

test('发送被限速整批丢弃：返回失败，不保留额度与冷却', async () => {
  const base = 'http://127.0.0.1:18086';
  const k = await boot({
    apiKey: 'cus-key-456',
    connect: true,
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 60, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => (url === `${base}/generate` ? audioResp() : undefined));
  try {
    k.kernel.chat.setRatePerMin(1);
    // 先吃掉这个会话唯一的发送令牌：接下来 sing 的语音会被 ChatService 静默丢弃
    await k.kernel.chat.send(k.chat, [{ type: 'text', data: { text: '占掉唯一令牌' } }]);

    const first = await k.call({ lyrics: '唱好了但发不出去' });
    assert.match(first, /限速|没真的发出去/, first);
    const resp = await k.kernel.container.dispatchHttp('sing', 'GET', '/status', { userId: '20001' }, {});
    const body = JSON.parse(String(resp!.body));
    assert.equal(body.today.count, 0, '没送达不能计入额度');

    const second = await k.call({ lyrics: '失败后冷却不该占住' });
    assert.match(second, /限速|没真的发出去/, second);
    assert.equal(mock.calls.length, 2, '第一次发送失败后冷却与在途锁都应释放');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('estimateSeconds：mp3 按 MPEG 帧头码率、wav 按 fmt byteRate，解析失败回退并标 exact=false', () => {
  // 100 帧 × 417 字节 @128kbps ≈ 2.6 秒 → 3 秒
  const mp3 = Buffer.concat([ID3_HEADER, ...Array.from({ length: 100 }, () => MP3_FRAME)]);
  const mp3Est = estimateSeconds(mp3, 'audio/mpeg');
  assert.equal(mp3Est.exact, true, '有合法 MPEG 帧头时不该走粗估');
  assert.equal(mp3Est.seconds, Math.round((100 * 417 * 8) / 128000));

  const wav = wavOf(32000, 64000);   // 32000 B/s × 2s
  const wavEst = estimateSeconds(wav, 'audio/wav');
  assert.deepEqual(wavEst, { seconds: 2, exact: true });

  // 只有 ID3 头、没有合法帧：退回旧的 128kbps 粗估
  const brokenMp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 0x55)]);
  const brokenMp3Est = estimateSeconds(brokenMp3, 'audio/mpeg');
  assert.equal(brokenMp3Est.exact, false);
  assert.equal(brokenMp3Est.seconds, 1);

  // fmt 块 size=0 的坏 wav：同样回退
  const brokenWavEst = estimateSeconds(WAV, 'audio/wav');
  assert.equal(brokenWavEst.exact, false);
  assert.equal(brokenWavEst.seconds, 1);
});

test('estimateSeconds：VBR mp3 逐帧累计（首帧码率不再代表整段），断链只当参考', () => {
  // 32kbps 首帧（104 字节）+ 99 帧 128kbps：真时长 = 100 帧 × 1152 / 44100 ≈ 2.6 秒，
  // 按首帧码率算会得出 ~10 秒的错值
  const frame32 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x10, 0x00]), Buffer.alloc(100)]);
  const vbr = Buffer.concat([ID3_HEADER, frame32, ...Array.from({ length: 99 }, () => MP3_FRAME)]);
  const est = estimateSeconds(vbr, 'audio/mpeg');
  assert.equal(est.exact, true, '帧链走完的 VBR 应逐帧精确');
  assert.equal(est.seconds, Math.round((100 * 1152) / 44100));

  // 帧链中途断掉（第二帧不是同步头）：不能再宣称精确，回退粗估
  const broken = Buffer.concat([ID3_HEADER, frame32, Buffer.alloc(2048, 0x55)]);
  const brokenEst = estimateSeconds(broken, 'audio/mpeg');
  assert.equal(brokenEst.exact, false);
  assert.equal(brokenEst.seconds, 1);
});

test('REST /preview：主人试唱只落盘不发送；/records 记一条，/audio 回同字节，假 id 与越界都 404', async () => {
  const base = 'http://127.0.0.1:18087';
  const k = await boot({
    apiKey: 'cus-key-456',
    connect: true,
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 0, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => (url === `${base}/generate` ? audioResp() : undefined));
  try {
    const resp = await k.kernel.container.dispatchHttp('sing', 'POST', '/preview', {}, {
      lyrics: '桌面端试唱一句', tags: 'pop', seconds: 20,
    });
    assert.ok(resp);
    assert.equal(resp!.status, 200);
    const preview = JSON.parse(String(resp!.body)) as { ok: boolean; id: string; seconds: number };
    assert.equal(preview.ok, true);
    assert.match(preview.id, /^sing_[a-z0-9]+$/);
    assert.ok(preview.seconds >= 1);

    // 试唱不能真的发消息：协议端只该有握手动作
    const sends = k.mock!.actions.filter((a) => a.action === 'send_group_msg' || a.action === 'send_private_msg');
    assert.equal(sends.length, 0, '试唱不应发送任何消息');

    const disk = join(k.dataDir, 'plugin-data', 'sing', 'sing', `${preview.id}.mp3`);
    assert.deepEqual(readFileSync(disk), MP3, '试唱产物要落盘');

    const recResp = await k.kernel.container.dispatchHttp('sing', 'GET', '/records', {}, {});
    const recBody = JSON.parse(String(recResp!.body));
    assert.equal(recBody.ok, true);
    assert.equal(recBody.records.length, 1, '成功试唱要记进 records');
    const rec = recBody.records[0];
    assert.deepEqual(
      Object.keys(rec).sort(),
      ['chatId', 'file', 'id', 'mime', 'provider', 'seconds', 'ts', 'userId'],
      '/records 只返回约定字段',
    );
    assert.equal(rec.id, preview.id);
    assert.equal(rec.file, `${preview.id}.mp3`, 'file 只存文件名');
    assert.equal(rec.userId, 'desktop', '试唱记录标 desktop');
    assert.equal(rec.chatId, 'desktop');
    assert.equal(rec.provider, 'custom');
    assert.equal(rec.mime, 'audio/mpeg');
    assert.equal(rec.seconds, preview.seconds);
    assert.deepEqual(recBody.lastErrors, []);

    const audio = await k.kernel.container.dispatchHttp('sing', 'GET', '/audio', { id: preview.id }, {});
    assert.equal(audio!.status, 200);
    assert.equal(audio!.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(audio!.body, MP3, '/audio 回与落盘一致的字节');

    const fake = await k.kernel.container.dispatchHttp('sing', 'GET', '/audio', { id: 'sing_nope' }, {});
    assert.equal(fake!.status, 404, '假 id 必须 404');

    // 就算 state 里被塞进 ../ 文件名，/audio 也必须拒绝（只认 records + 边界校验）
    writeFileSync(join(k.dataDir, 'plugin-data', 'sing', 'evil.mp3'), Buffer.from('evil'));
    k.kernel.db.run(
      `INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      'sing', 'records',
      JSON.stringify([{
        id: 'sing_evil', ts: Date.now(), userId: 'desktop', chatId: 'desktop', seconds: 1,
        provider: 'custom', file: '../evil.mp3', mime: 'audio/mpeg',
      }]),
      Date.now(),
    );
    const evil = await k.kernel.container.dispatchHttp('sing', 'GET', '/audio', { id: 'sing_evil' }, {});
    assert.equal(evil!.status, 404, '路径穿越必须被拒');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('REST /send：按 id 把已有录音补发到指定会话（record 段 file:// + 可选文字）', async () => {
  const base = 'http://127.0.0.1:18088';
  const k = await boot({
    apiKey: 'cus-key-456',
    connect: true,
    config: { provider: 'custom', baseUrl: base, cooldownSeconds: 0, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => (url === `${base}/generate` ? audioResp() : undefined));
  try {
    const made = await k.kernel.container.dispatchHttp('sing', 'POST', '/preview', {}, {
      lyrics: '先唱一首存着', tags: 'pop', seconds: 20,
    });
    const preview = JSON.parse(String(made!.body)) as { ok: boolean; id: string };

    const from = k.mock!.actions.length;
    // chatId 先过格式关：不足 5 位的手误直接 400，不进协议端
    const bad = await k.kernel.container.dispatchHttp('sing', 'POST', '/send', {}, {
      id: preview.id, type: 'group', chatId: '8899', text: '来听这段',
    });
    assert.ok(bad);
    assert.equal(bad!.status, 400);
    assert.match(String(bad!.body), /5~12 位数字/);

    const resp = await k.kernel.container.dispatchHttp('sing', 'POST', '/send', {}, {
      id: preview.id, type: 'group', chatId: '88990', text: '来听这段',
    });
    assert.ok(resp);
    assert.equal(resp!.status, 200);
    const body = JSON.parse(String(resp!.body));
    assert.equal(body.ok, true);
    assert.equal(typeof body.messageId, 'string');

    const act = await k.mock!.waitForAction('send_group_msg', 5000, from);
    assert.equal(String(act.params.group_id), '88990');
    // 语音与文字分开发：record 先走（才是补发的主体），文字随后单独一条
    const all = k.mock!.actions.slice(from).filter((a) => a.action === 'send_group_msg');
    const recSeg = all.flatMap((a) => (a.params.message ?? []) as any[]).find((s) => s.type === 'record');
    assert.ok(recSeg, `补发必须有 record 段`);
    assert.match(String(recSeg.data.file), /^file:\/\//, 'record 段要自己转 file://');
    const abs = fileURLToPath(String(recSeg.data.file));
    assert.deepEqual(readFileSync(abs), MP3, '补发指向 preview 落盘的那份文件');
    assert.equal(abs, join(k.dataDir, 'plugin-data', 'sing', 'sing', `${preview.id}.mp3`));
    // 语音发出去之后，文字条也跟着走（同一次补发的第二条）
    const textSeg = all.flatMap((a) => (a.params.message ?? []) as any[]).find((s) => s.type === 'text');
    assert.equal(textSeg?.data?.text, '来听这段');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('热重载：工具恰好一个、REST /status 仍通', async () => {
  const k = await boot({
    apiKey: 'cus-key-456',
    config: {
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:18084',
      voiceId: 'clone-123',
      cooldownSeconds: 0,
    },
  });
  try {
    const names = () => k.kernel.container.toolsForChat(k.chat, 'member', 'chat').filter((t) => t.name === 'sing');
    assert.equal(names().length, 1);
    assert.equal(k.kernel.container.get('sing')!.tools.size, 1);

    await k.kernel.container.reload('sing');

    assert.equal(names().length, 1, 'reload 后工具不能重复');
    assert.equal(k.kernel.container.get('sing')!.tools.size, 1);

    const resp = await k.kernel.container.dispatchHttp('sing', 'GET', '/status', {}, {});
    assert.ok(resp, 'reload 后 /status 路由应还在');
    assert.equal(resp!.status, 200);
    const body = JSON.parse(String(resp!.body));
    assert.deepEqual(
      Object.keys(body).sort(),
      ['lastGenerationAt', 'ok', 'provider', 'today', 'voiceIdSet'],
      '/status 只返回约定字段',
    );
    assert.equal(body.ok, true);
    assert.equal(body.provider, 'custom');
    assert.equal(body.voiceIdSet, true);
    assert.equal(body.lastGenerationAt, null);
    assert.deepEqual(body.today, { userId: '10001', count: 0 });
  } finally {
    await k.cleanup();
  }
});
