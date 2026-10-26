import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockOneBot } from './helpers/mock-onebot.ts';
import { searchNetease } from '../src/plugins/cover/index.ts';
import type { ChatRef } from '../src/kernel/types.ts';

// ============================================================
// 翻唱插件（cover）
//
//  1. 网易云搜索 → 取流下载 → POST 自部署 /cover（multipart）
//  2. 服务端返回 mp3 → 落盘 → record 段（file://）发进会话
//  3. 搜不到 / VIP 没有播放地址 / 服务 500：中文错误，不发语音
//  4. 额度、冷却、在途锁、发送限速回执
//  5. REST /preview /records /audio /send、热重载
//
//  网络一律 mock globalThis.fetch；发消息只走 MockOneBot，不碰真实 QQ。
// ============================================================

const realFetch = globalThis.fetch;
const SEARCH_URL = 'https://music.163.com/api/search/get/web';
const OUTER_URL = 'https://music.163.com/song/media/outer/url?id=1330348068.mp3';
const COVER_BASE = 'http://127.0.0.1:18090';
const COVER_URL = `${COVER_BASE}/cover`;

const MP3 = Buffer.concat([
  Buffer.from('ID3'),
  Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(413),
]);

const SEARCH_OK = {
  result: {
    songs: [
      { id: 111, name: '起风了 (伴奏)', artists: [{ name: '某某' }] },
      { id: 1330348068, name: '起风了', artists: [{ name: '买辣椒也用券' }] },
      { id: 222, name: '起风了', artists: [{ name: '周深' }] },
    ],
  },
};

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
type Handler = (url: string, init: any) => Response | undefined | Promise<Response | undefined>;

function mockFetch(handler: Handler) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body: any = init.body;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method: String(init.method ?? 'GET'), headers, body });
    const resp = await handler(url, init);
    if (!resp) return realFetch(input, init);
    return resp;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const jsonResp = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const audioResp = (seconds = 180) => new Response(MP3, {
  status: 200,
  headers: { 'content-type': 'audio/mpeg', 'x-cover-seconds': String(seconds) },
});

async function boot(opts: {
  apiKey?: string;
  cookie?: string;
  config?: Record<string, unknown>;
  connect?: boolean;
} = {}) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-cover-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  cfg.masterIds = ['10001'];
  if (opts.apiKey !== undefined) kernel.config.setPluginSecret('cover', 'apiKey', opts.apiKey);
  if (opts.cookie !== undefined) kernel.config.setPluginSecret('cover', 'cookie', opts.cookie);
  for (const [key, value] of Object.entries(opts.config ?? {})) {
    kernel.db.run(
      `INSERT INTO plugin_user_config (plugin_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      'cover', key, JSON.stringify(value), Date.now(),
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
    const t = kernel.container.toolsForChat(target, role, 'chat').find((x) => x.name === 'cover');
    assert.ok(t, `${role} 的 chat 面缺少 cover`);
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

test('searchNetease：跳过伴奏，按 artist 消歧；搜不到时返回中文 notfound', async () => {
  const mock = mockFetch((url) => (url === SEARCH_URL ? jsonResp(SEARCH_OK) : undefined));
  try {
    const picked = await searchNetease('起风了', '周深', 5000);
    assert.equal(picked.ok, true);
    if (picked.ok) {
      assert.equal(picked.song.id, 222, '指定歌手时应选中周深版');
      assert.equal(picked.song.artists, '周深');
    }

    const noArtist = await searchNetease('起风了', '', 5000);
    assert.equal(noArtist.ok, true);
    if (noArtist.ok) assert.equal(noArtist.song.id, 1330348068, '不指定歌手时跳过伴奏取第一首');
  } finally {
    mock.restore();
  }

  const empty = mockFetch((url) => (url === SEARCH_URL ? jsonResp({ result: {} }) : undefined));
  try {
    const got = await searchNetease('没有这首歌', '', 5000);
    assert.equal(got.ok, false);
    if (!got.ok) assert.match(got.error, /没搜到|换个歌名/);
  } finally {
    empty.restore();
  }
});

test('成功翻唱：网易云取流 → multipart /cover → record 语音发进群', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    cookie: 'SCOW_USER=ustc-test-token',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 0, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) return audioResp(180);
    return undefined;
  });
  try {
    const out = await k.call({ song: '起风了', artist: '买辣椒也用券' });
    assert.match(out, /翻唱成语音发进会话了（约 180 秒）/, out);

    const search = mock.calls.find((c) => c.url === SEARCH_URL)!;
    assert.equal(search.method, 'POST');
    assert.match(String(search.body), /s=%E8%B5%B7%E9%A3%8E%E4%BA%86/);
    const outer = mock.calls.find((c) => c.url === OUTER_URL)!;
    assert.equal(outer.headers.referer, 'https://music.163.com/');
    const cover = mock.calls.find((c) => c.url === COVER_URL)!;
    assert.equal(cover.method, 'POST');
    assert.equal(cover.headers.authorization, 'Bearer cover-key-123');
    assert.equal(cover.headers.cookie, 'SCOW_USER=ustc-test-token');
    const form = cover.body as FormData;
    assert.equal(form.get('with_instrumental'), 'true');
    const blob = form.get('audio') as Blob;
    assert.ok(blob && typeof (blob as any).arrayBuffer === 'function', 'multipart 要带音频文件');
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), MP3, '上传的应是原曲字节');

    const abs = recordFileOf(await k.mock!.waitForAction('send_group_msg', 5000));
    assert.deepEqual(readFileSync(abs), MP3, '落盘字节要与服务返回一致');
    assert.ok(abs.startsWith(join(k.dataDir, 'plugin-data', 'cover', 'cover')), '产物落在 pluginDataDir/cover');
    assert.match(abs.replace(/\\/g, '/'), /cover_[a-z0-9]+\.mp3$/);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('异步任务：POST 返回 job id 后轮询 /jobs/{id}，done 再取 /jobs/{id}/audio', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 0, dailyQuota: 5 },
  });
  let polls = 0;
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) {
      return new Response(JSON.stringify({ ok: true, id: 'job1', status: 'queued', seconds: 180 }), {
        status: 202, headers: { 'content-type': 'application/json' },
      });
    }
    if (url === `${COVER_BASE}/jobs/job1`) {
      polls += 1;
      return jsonResp(polls === 1
        ? { ok: true, id: 'job1', status: 'running', seconds: 180 }
        : { ok: true, id: 'job1', status: 'done', seconds: 180 });
    }
    if (url === `${COVER_BASE}/jobs/job1/audio`) return audioResp(180);
    return undefined;
  });
  try {
    const out = await k.call({ song: '起风了' });
    assert.match(out, /翻唱成语音.*约 180 秒/, out);
    assert.ok(polls >= 2, '要轮询到 done 才取音频');
    assert.ok(mock.calls.some((c) => c.url === `${COVER_BASE}/jobs/job1/audio`), '完成后要取 /jobs/{id}/audio');
    const abs = recordFileOf(await k.mock!.waitForAction('send_group_msg', 5000));
    assert.deepEqual(readFileSync(abs), MP3);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('VIP/版权没有播放地址：明确报错，不调用翻唱服务、不占额度', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 0, dailyQuota: 1 },
  });
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url.startsWith('https://music.163.com/song/media/outer/url')) {
      return new Response('forbidden', { status: 403 });
    }
    if (url.startsWith('https://music.163.com/api/song/enhance/player/url')) {
      return jsonResp({ data: [{ url: null }] });
    }
    if (url === COVER_URL) return audioResp(100);
    return undefined;
  });
  try {
    const out = await k.call({ song: '起风了' });
    assert.match(out, /VIP|版权|播放地址/, out);
    assert.equal(mock.calls.some((c) => c.url === COVER_URL), false, '没有原曲就不该调翻唱服务');

    const status = await k.kernel.container.dispatchHttp('cover', 'GET', '/status', { userId: '20001' }, {});
    const body = JSON.parse(String(status!.body));
    assert.equal(body.today.count, 0, '失败不占额度');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('服务 500：中文错误，不抛异常；失败不占冷却', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 60, dailyQuota: 5 },
  });
  let n = 0;
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) {
      n += 1;
      return n === 1
        ? new Response('{"ok":false,"error":"RVC 转换失败"}', { status: 500, headers: { 'content-type': 'application/json' } })
        : audioResp(120);
    }
    return undefined;
  });
  try {
    const failed = await k.call({ song: '起风了' });
    assert.match(failed, /翻唱服务|处理失败/, failed);
    const ok = await k.call({ song: '起风了' });
    assert.match(ok, /翻唱成语音/, '失败不应占住冷却');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('额度：普通成员每天 1 首，主人不限；冷却按会话拦第二首', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 0, dailyQuota: 1 },
  });
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) return audioResp(90);
    return undefined;
  });
  try {
    assert.match(await k.call({ song: '起风了' }), /翻唱成语音/);
    const refused = await k.call({ song: '起风了' });
    assert.match(refused, /额度用完了/);
    assert.match(refused, /1\/1/);
    assert.match(await k.call({ song: '起风了' }, { role: 'owner' }), /翻唱成语音/, '主人不受额度限制');
  } finally {
    mock.restore();
    await k.cleanup();
  }

  const cool = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 60, dailyQuota: 5 },
  });
  const mock2 = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) return audioResp(90);
    return undefined;
  });
  try {
    assert.match(await cool.call({ song: '起风了' }), /翻唱成语音/);
    const blocked = await cool.call({ song: '起风了' });
    assert.match(blocked, /刚翻过|冷却/);
  } finally {
    mock2.restore();
    await cool.cleanup();
  }
});

test('发送被限速整批丢弃：返回失败，不保留额度与冷却', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 60, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) return audioResp(90);
    return undefined;
  });
  try {
    k.kernel.chat.setRatePerMin(1);
    await k.kernel.chat.send(k.chat, [{ type: 'text', data: { text: '占掉唯一令牌' } }]);
    const first = await k.call({ song: '起风了' });
    assert.match(first, /限速|没真的发出去/, first);
    const also = await k.call({ song: '起风了' });
    assert.match(also, /限速|没真的发出去/, '第一次发送失败后冷却与在途锁都应释放');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('REST /preview 只落盘不发送；/records 字段、/audio 同字节、/send 补发、热重载', async () => {
  const k = await boot({
    apiKey: 'cover-key-123',
    connect: true,
    config: { baseUrl: COVER_BASE, cooldownSeconds: 0, dailyQuota: 5 },
  });
  const mock = mockFetch((url) => {
    if (url === SEARCH_URL) return jsonResp(SEARCH_OK);
    if (url === OUTER_URL) return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url === COVER_URL) return audioResp(180);
    return undefined;
  });
  try {
    const resp = await k.kernel.container.dispatchHttp('cover', 'POST', '/preview', {}, { song: '起风了' });
    assert.equal(resp!.status, 200);
    const preview = JSON.parse(String(resp!.body)) as { ok: boolean; id: string; seconds: number; song: string };
    assert.equal(preview.ok, true);
    assert.match(preview.id, /^cover_[a-z0-9]+$/);
    assert.equal(preview.song, '起风了');
    assert.equal(preview.seconds, 180);

    const sends = k.mock!.actions.filter((a) => a.action === 'send_group_msg' || a.action === 'send_private_msg');
    assert.equal(sends.length, 0, '试翻不应发送任何消息');

    const records = await k.kernel.container.dispatchHttp('cover', 'GET', '/records', {}, {});
    const recBody = JSON.parse(String(records!.body));
    assert.equal(recBody.records.length, 1);
    assert.deepEqual(
      Object.keys(recBody.records[0]).sort(),
      ['artist', 'chatId', 'file', 'id', 'mime', 'seconds', 'song', 'ts', 'userId'],
    );
    assert.equal(recBody.records[0].userId, 'desktop');

    const audio = await k.kernel.container.dispatchHttp('cover', 'GET', '/audio', { id: preview.id }, {});
    assert.equal(audio!.status, 200);
    assert.deepEqual(audio!.body, MP3);

    const bad = await k.kernel.container.dispatchHttp('cover', 'POST', '/send', {}, {
      id: preview.id, type: 'group', chatId: '8899',
    });
    assert.equal(bad!.status, 400);

    const from = k.mock!.actions.length;
    const sent = await k.kernel.container.dispatchHttp('cover', 'POST', '/send', {}, {
      id: preview.id, type: 'group', chatId: '88990', text: '来听翻唱',
    });
    assert.equal(sent!.status, 200);
    const act = await k.mock!.waitForAction('send_group_msg', 5000, from);
    const abs = recordFileOf(act);
    assert.deepEqual(readFileSync(abs), MP3);
    // 语音与附言分开发：record 一条、text 一条，文字在第二条
    const all = k.mock!.actions.slice(from).filter((a) => a.action === 'send_group_msg');
    const textSeg = all.flatMap((a) => (a.params.message ?? []) as any[]).find((s) => s.type === 'text');
    assert.equal(textSeg?.data?.text, '来听翻唱');

    assert.equal(k.kernel.container.get('cover')!.tools.size, 1);
    await k.kernel.container.reload('cover');
    assert.equal(k.kernel.container.get('cover')!.tools.size, 1);
    const status = await k.kernel.container.dispatchHttp('cover', 'GET', '/status', {}, {});
    assert.equal(status!.status, 200);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('没配 baseUrl：返回配置错误，不发请求；beforeLLM 追加 order 292 的节', async () => {
  const k = await boot({ config: { cooldownSeconds: 0 } });
  const mock = mockFetch(() => undefined);
  try {
    const out = await k.call({ song: '起风了' });
    assert.match(out, /翻唱服务还没配置|baseUrl/);
    assert.equal(mock.calls.length, 0, '没配服务地址时不该发请求');

    const hooks = k.kernel.container.get('cover')!.hooks;
    const req: any = {
      chat: k.chat,
      event: { platform: 'qq', type: 'group', chatId: k.chat.chatId, userId: '20001' },
      system: 'base', messages: [], tools: [],
      systemSections: [{ order: 1, text: '别的插件先注入的节' }],
    };
    const outReq = await hooks.beforeLLM!(req);
    assert.equal(outReq.systemSections![0].text, '别的插件先注入的节');
    const sec = outReq.systemSections!.find((s: any) => s.title === 'cover');
    assert.ok(sec, 'beforeLLM 要追加翻唱说明节');
    assert.equal(sec.order, 292);
    assert.match(sec.text, /cover/);
    assert.match(sec.text, /sing/);
    assert.match(sec.text, /还没配置翻唱服务地址/);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});
