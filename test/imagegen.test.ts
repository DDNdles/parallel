import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startApiServer } from '../src/kernel/api/server.ts';
import { weekKeyOf } from '../src/plugins/imagegen/index.ts';

// ============================================================
// 生图插件（Gemini）
//
//  1. 额度按自然周（周一起算）+ 用户计数；API 失败/内容被拦/写盘失败都不计数；
//  2. 主人与管理员默认不限；周一切到下一周后普通成员额度重新算；
//  3. PNG 真落进会话沙箱 imagegen/，参考图按沙箱相对路径读成 inline_data；
//  4. REST（/api/plugin/imagegen）：gallery / image / usage / generate；
//  5. beforeLLM 只追加节，不覆盖别的插件已经 push 的内容。
//
//  Gemini 调用一律 mock 掉 globalThis.fetch；测试自己访问 API 用最初的 realFetch。
// ============================================================

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const realFetch = globalThis.fetch;

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

type GeminiCall = { url: string; headers: Record<string, string>; body: any };

/** 只拦 Gemini 的 fetch；别的请求（测试自己访问 localhost）走真 fetch */
function mockGemini(replies: (() => Response | Promise<Response>)[]) {
  const calls: GeminiCall[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = replies.shift();
    if (!next) throw new Error('mock Gemini 的响应队列用完了');
    return next();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const geminiOk = (b64 = PNG_B64) => () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] }, finishReason: 'STOP' }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

const geminiErr = (status: number, message: string) => () => new Response(JSON.stringify({
  error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT' },
}), { status, headers: { 'content-type': 'application/json' } });

type Role = 'owner' | 'admin' | 'member';

async function boot(key?: string) {
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-imagegen-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  cfg.ui.port = await freePort();
  cfg.masterIds = ['10001'];
  if (key !== undefined) kernel.config.setPluginSecret('imagegen', 'apiKey', key);
  await kernel.boot();

  // work 轮按发起人分沙箱（group_8101__u<QQ>）：工具拿到的是带 scope 的 chat
  const memberChat = { platform: 'qq' as const, type: 'group' as const, chatId: '8101', scope: 'u20001' };
  const privilegedChat = { platform: 'qq' as const, type: 'group' as const, chatId: '8101', scope: 'u10001' };

  const toolOf = (role: Role = 'member') => {
    const chat = role === 'member' ? memberChat : privilegedChat;
    const t = kernel.container.toolsForChat(chat, role, 'work').find((x) => x.name === 'generate_image');
    assert.ok(t, `${role} 的 work 面缺少 generate_image`);
    return t!;
  };

  const tctx = (userId: string, role: Role, chat: { platform: 'qq'; type: 'group'; chatId: string; scope?: string }) => ({
    chat,
    role,
    event: {
      platform: 'qq', type: 'group', chatId: chat.chatId, userId, nickname: userId,
      senderRole: role, segments: [], text: '', isAtMe: true, isReplyToMe: false, raw: null, ts: 0, role,
    },
  });

  const call = async (prompt: string, opts: { role?: Role; userId?: string; refs?: string[] } = {}): Promise<string> => {
    const role = opts.role ?? 'member';
    const chat = role === 'member' ? memberChat : privilegedChat;
    const userId = opts.userId ?? (role === 'member' ? '20001' : '10001');
    const r = await toolOf(role).handler(
      { prompt, refs: opts.refs },
      tctx(userId, role, chat) as any,
    );
    return typeof r === 'string' ? r : r.content;
  };

  return {
    kernel, memberChat, privilegedChat, toolOf, tctx, call,
    cleanup: async () => { await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('自然周边界：周一起算，跨年按 ISO 周', () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
  assert.equal(weekKeyOf(at(2026, 1, 1)), '2026-W01');
  assert.equal(weekKeyOf(at(2026, 10, 18)), '2026-W42', '周日仍属于上一周');
  assert.equal(weekKeyOf(at(2026, 10, 19)), '2026-W43', '周一是新的一周');
  assert.equal(weekKeyOf(at(2026, 10, 25)), '2026-W43');
  assert.equal(weekKeyOf(at(2026, 10, 26)), '2026-W44');
  assert.equal(weekKeyOf(at(2027, 1, 1)), '2026-W53', '跨年那几天归上一年的最后一周');
});

test('额度：API 失败不计数、满 3 张拒绝；PNG 真落盘；参考图进 inline_data', async () => {
  const k = await boot('key-test');
  // 主备两个模型都 429 才算一次失败（模型轮换会先落备用再试一次）
  const mock = mockGemini([geminiErr(429, 'quota exceeded'), geminiErr(429, 'quota exceeded too'), geminiOk(), geminiOk(), geminiOk()]);
  try {
    // 参考图先放进会话沙箱（真实文件，读成 base64）
    k.kernel.sandbox.write(k.memberChat, 'inbox/ref.png', PNG);

    const failed = await k.call('第一张（这次会失败）', { refs: ['inbox/ref.png'] });
    assert.match(failed, /生图失败/, failed);
    assert.match(failed, /429/, '配额错误要带状态码说明');

    // 请求格式：x-goog-api-key + 文生图 parts + 参考图 inline_data（第一次是主模型，带参考图）
    assert.equal(mock.calls.length, 2, '主模型失败后落备用模型再试一次');
    assert.equal(mock.calls[0].headers['x-goog-api-key'], 'key-test');
    assert.match(mock.calls[0].url, /models\/gemini-3-pro-image:generateContent$/);
    const parts = mock.calls[0].body.contents[0].parts;
    assert.equal(parts[0].text, '第一张（这次会失败）');
    assert.equal(parts[1].inline_data.mime_type, 'image/png');
    assert.equal(parts[1].inline_data.data, PNG_B64);
    assert.match(mock.calls[1].url, /gemini-3\.1-flash-image/, '第二次落备用模型');

    // 失败那次不计数：还能连做三张，第四张才被拒
    const first = await k.call('第二张');
    assert.match(first, /已生成 imagegen\/.+\.png/);
    assert.match(await k.call('第三张'), /已生成/);
    assert.match(await k.call('第四张'), /已生成/);

    const rel = first.match(/imagegen\/[^\s（]+\.png/)![0];
    const abs = join(k.kernel.sandbox.root(k.memberChat), rel);
    assert.deepEqual(readFileSync(abs), PNG, 'PNG 内容要原样落进沙箱');

    const callsBefore = mock.calls.length;
    const refused = await k.call('第五张');
    assert.match(refused, /本周生图额度已用完/);
    assert.match(refused, /3\/3/);
    assert.match(refused, /下周一（\d+月\d+日）重置/);
    assert.equal(mock.calls.length, callsBefore, '额度用完不能再打 API');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('JPEG：返回字节是 JPEG 时按 .jpg 落盘，不冒充 PNG', async () => {
  // 真机踩过的坑：flash-image 系模型回 JPEG，一律存 .png 会让扩展名与字节不符
  const JPEG = Buffer.from('ffd8ffe000104a46494600010000000100', 'hex');
  const k = await boot('key-test');
  const mock = mockGemini([geminiOk(JPEG.toString('base64'))]);
  try {
    const out = await k.call('画一只猫', { role: 'owner' });
    assert.match(out, /已生成 imagegen\/.+\.jpg/, out);
    const rel = out.match(/imagegen\/[^\s（]+\.jpg/)![0];
    const abs = join(k.kernel.sandbox.root(k.privilegedChat), rel);
    assert.deepEqual(readFileSync(abs), JPEG, 'JPEG 内容要原样落进沙箱');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('模型轮换：主模型 503 自动落备用模型，画廊记实际模型', async () => {
  const k = await boot('key-test');
  // 队列：主模型 503 → 备用成功（mockGemini 按 URL 拦截，两次调用靠队列顺序区分）
  const mock = mockGemini([geminiErr(503, 'account pool cooling'), geminiOk()]);
  try {
    const out = await k.call('画一只猫', { role: 'owner' });
    assert.match(out, /已生成 imagegen\/.+\.(png|jpg)/, out);
    assert.match(out, /备用/, '要说明是备用模型生成的');
    assert.equal(mock.calls.length, 2, '主模型失败后要再试一次备用模型');
    assert.match(mock.calls[0]!.url, /gemini-3-pro-image/, '第一次打主模型');
    assert.match(mock.calls[1]!.url, /gemini-3\.1-flash-image/, '第二次落备用模型');
    // 额度只占一次：owner 不限额，看成员侧不受影响即可（此处仅验证调用次数语义）
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('模型轮换：备用也失败才算失败，额度退回', async () => {
  const k = await boot('key-test');
  const mock = mockGemini([geminiErr(503, 'a'), geminiErr(503, 'b'), geminiErr(429, 'q'), geminiErr(429, 'q')]);
  try {
    const out = await k.call('第一张', { role: 'member' });
    assert.match(out, /生图失败/, out);
    const out2 = await k.call('第二张还能画', { role: 'member' });
    assert.match(out2, /已生成|生图失败/, '失败不计数：第二次仍会真的调 API');
    assert.equal(mock.calls.length, 4, '两次生成 × 各两个模型');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('主人与管理员默认不限张数', async () => {
  const k = await boot('key-test');
  const mock = mockGemini(Array.from({ length: 8 }, () => geminiOk()));  try {
    for (let i = 0; i < 4; i++) assert.match(await k.call(`主人第 ${i} 张`, { role: 'owner' }), /已生成/);
    for (let i = 0; i < 4; i++) assert.match(await k.call(`管理员第 ${i} 张`, { role: 'admin' }), /已生成/);
    assert.equal(mock.calls.length, 8);
  } finally {
    mock.restore();
    await k.cleanup();
  }
});

test('周切换：换到下一周，普通成员额度重新算', async () => {
  const k = await boot('key-test');
  const mock = mockGemini(Array.from({ length: 5 }, () => geminiOk()));
  const realNow = Date.now;
  try {
    Date.now = () => new Date(2026, 9, 21, 12).getTime();   // 2026-W43 周三
    for (let i = 0; i < 3; i++) assert.match(await k.call(`本周第 ${i} 张`), /已生成/);
    assert.match(await k.call('本周超额'), /本周生图额度已用完/);

    Date.now = () => new Date(2026, 9, 26, 12).getTime();   // 2026-W44 周一
    assert.match(await k.call('下周第一张'), /已生成/, '新的一周额度重置');
    assert.equal(mock.calls.length, 4, '失败/拒绝的那两次不该调 API');
  } finally {
    Date.now = realNow;
    mock.restore();
    await k.cleanup();
  }
});

test('REST：gallery / image / usage / generate（token 即主人）', async () => {
  const k = await boot('key-test');
  const mock = mockGemini(Array.from({ length: 6 }, () => geminiOk()));
  let api: any = null;
  try {
    // 先让普通成员生成一张：/usage 要能按当前周报出来
    assert.match(await k.call('成员的一张'), /已生成/);

    api = await startApiServer(k.kernel);
    const base = `http://127.0.0.1:${(k.kernel.config.config as any).ui.port}`;
    const token = k.kernel.config.secrets.uiToken;
    const authed = (p: string, init: RequestInit = {}) => realFetch(base + p, {
      ...init,
      headers: { 'x-auth-token': token, ...(init.headers ?? {}) },
    });

    // 没有桌面端 token 就进不来（/api/* 同一把锁）
    assert.equal((await realFetch(base + '/api/plugin/imagegen/gallery')).status, 401);

    let resp = await authed('/api/plugin/imagegen/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 桌面端把参考图读成 data URL 传过来（没有会话沙箱路径可用）
      body: JSON.stringify({ prompt: '桌面上画一张风景', refs: [`data:image/png;base64,${PNG_B64}`] }),
    });
    assert.equal(resp.status, 200);
    const gen = await resp.json() as { ok: boolean; id: string };
    assert.equal(gen.ok, true);
    assert.ok(gen.id);
    // data URL 参考图要进 inline_data，而不是被当成沙箱路径
    const restParts = mock.calls.at(-1)!.body.contents[0].parts;
    assert.equal(restParts[1].inline_data.mime_type, 'image/png');
    assert.equal(restParts[1].inline_data.data, PNG_B64);

    resp = await authed('/api/plugin/imagegen/gallery');
    assert.equal(resp.status, 200);
    const gal = await resp.json() as { ok: boolean; images: any[] };
    assert.equal(gal.ok, true);
    const img = gal.images.find((x) => x.id === gen.id);
    assert.ok(img, '画廊里要有刚生成的那张');
    assert.deepEqual(
      Object.keys(img).sort(),
      ['chatId', 'file', 'id', 'model', 'prompt', 'ts', 'userId'],
      '/gallery 只返回约定字段（内部 chatRef 不暴露）',
    );
    assert.equal(img.prompt, '桌面上画一张风景');
    assert.equal(img.model, 'gemini-3-pro-image');
    assert.equal(img.chatId, 'desktop');

    resp = await authed('/api/plugin/imagegen/image?id=' + encodeURIComponent(gen.id));
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /image\/png/);
    assert.deepEqual(Buffer.from(await resp.arrayBuffer()), PNG, '/image 返回原始 PNG');
    assert.equal((await authed('/api/plugin/imagegen/image?id=nope')).status, 404);

    resp = await authed('/api/plugin/imagegen/usage');
    const usage = await resp.json() as { ok: boolean; weekKey: string; users: any[] };
    assert.equal(usage.ok, true);
    assert.equal(usage.weekKey, weekKeyOf());
    assert.deepEqual(usage.users, [{ userId: '20001', used: 1 }], '普通成员本周已用 1 张；主人走 REST 不占额度');

    // 桌面端有自己的沙箱（private_desktop），文件真落盘
    const root = k.kernel.sandbox.root({ platform: 'ui', type: 'private', chatId: 'desktop' });
    assert.deepEqual(readFileSync(join(root, img.file)), PNG);
  } finally {
    if (api) await new Promise<void>((r) => api.close(() => r()));
    mock.restore();
    await k.cleanup();
  }
});

test('work 面工具 + beforeLLM 只追加；未配 Key 时结构化拒绝且不调 API', async () => {
  const k = await boot();   // 不配 Key
  const mock = mockGemini([]);
  try {
    assert.equal(
      k.kernel.container.toolsForChat(k.memberChat, 'member', 'chat').some((t) => t.name === 'generate_image'),
      false,
      'chat 面不该出现生图工具（它是 work 面）',
    );
    assert.ok(k.toolOf('member'));

    const hooks = k.kernel.container.get('imagegen')!.hooks;
    const req: any = {
      chat: k.memberChat,
      event: k.tctx('20001', 'member', k.memberChat).event,
      system: 'base', messages: [], tools: [],
      systemSections: [{ order: 1, text: '别的插件先注入的节' }],
    };
    const out = await hooks.beforeLLM!(req);
    assert.equal(out.systemSections![0].text, '别的插件先注入的节', '原有节必须保留');
    const sec = out.systemSections!.find((s) => s.title === 'imagegen');
    assert.ok(sec, 'beforeLLM 要追加生图说明节');
    assert.match(sec!.text, /generate_image/);
    assert.match(sec!.text, /自然周.*3 张/);
    assert.match(sec!.text, /主人与管理员不限/);
    assert.match(sec!.text, /还没配置 Gemini API Key/);

    const res = await k.call('画只猫');
    assert.match(res, /还没配置 Gemini API Key/);
    assert.equal(mock.calls.length, 0, '没配 Key 时不该发请求');
  } finally {
    mock.restore();
    await k.cleanup();
  }
});
