import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busEvents } from '../src/kernel/bus.ts';
import type { MockEngine } from '../src/kernel/services/mock-engine.ts';

// ============================================================
// 表情包插件（2026-10-24 v0.3：明确要求才收 + 模型看图打标）
//
//  1. steal_sticker：消息内与引用消息里的图都能收；模型打标写入 desc/tags/timing；
//     打标失败不拦收录（描述退回消息文字）；不记来源；
//  2. send_sticker：按描述/标签/时机挑图、发出去、计数、冷却；空库不注入提示；
//  3. REST：列表/改三项/上传（原始字节或 base64，可点名字段）/取图/删除/库容/补打标签；
//  4. reload 后数据仍在（plugin_kv 与 data/stickers 都不是进程内存）；
//  5. 真实 HTTP 的原始字节上传（前端 postRaw 走的就是这条）。
// 模型打标走 mock 引擎的 script 队列；队列空 = 打标失败路径。
// ============================================================

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 每个 seed 一张内容不同的「png」（插件只认文件头，不解码） */
function png(seed: number): Buffer {
  return Buffer.concat([PNG_HEAD, Buffer.from([seed, seed, seed, seed])]);
}

/** mock 引擎下一步要回的打标 JSON */
const tagStep = (desc: string, tags: string[], timing: string): { content: string } => ({
  content: JSON.stringify({ desc, tags, timing }),
});

async function boot(opts: { api?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-sticker-'));
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  if (opts.api) cfg.ui.port = await freePort();
  // 打标走 mock 引擎：chat 链指到 mock，script 队列按需塞答复
  cfg.providers.mock = {
    label: 'Mock', model: 'mock-1', enabled: true, baseUrl: '', protocol: 'mock',
    models: [{ id: 'mock-1', enabled: true }],
  };
  cfg.llm.activeProvider = 'mock';
  cfg.llm.chatChain = [{ provider: 'mock', model: 'mock-1' }];
  cfg.llm.workChain = [{ provider: 'mock', model: 'mock-1' }];
  await kernel.boot();
  const mockEngine = (kernel.llm as unknown as { providers: Map<string, MockEngine> }).providers.get('mock')!;

  const chat = { platform: 'ui' as const, type: 'group' as const, chatId: '8801' };
  const plugin = () => kernel.container.get('sticker')!;
  const toolOf = (name: string) => {
    const t = kernel.container.toolsForChat(chat, 'owner', 'chat').find((x) => x.name === name);
    assert.ok(t, `chat 面缺少工具 ${name}`);
    return t!;
  };
  const tctx = (event: any) => ({ event, chat, role: 'owner' as const });
  const rest = async (method: string, path: string, query: Record<string, string> = {}, body: unknown = {}) => {
    const r = await kernel.container.dispatchHttp('sticker', method, path, query, body);
    assert.ok(r, `插件端点 ${method} ${path} 应存在`);
    return r!;
  };
  const restJson = async (method: string, path: string, query: Record<string, string> = {}, body: unknown = {}) =>
    JSON.parse(String((await rest(method, path, query, body)).body));
  const library = async () => (await restJson('GET', '/library')).stickers as any[];
  /** 改 userConfig：直接写 plugin_user_config 表再显式 reload，避免 setUserConfigValue 的异步重载竞态 */
  const configure = async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      kernel.db.run(
        `INSERT INTO plugin_user_config (plugin_id, key, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        'sticker', key, JSON.stringify(value), Date.now(),
      );
    }
    await kernel.container.reload('sticker');
  };
  const cleanup = async () => { await kernel.shutdown(); rmSync(dataDir, { recursive: true, force: true }); };
  return { kernel, dataDir, chat, plugin, toolOf, tctx, rest, restJson, library, configure, mockEngine, cleanup };
}

/** 一条带图的群消息；over 可覆盖 userId/nickname/raw/text 等 */
function eventOf(chat: { chatId: string }, imgs: { name: string; path: string }[], over: Record<string, unknown> = {}): any {
  return {
    id: 'ev_' + Math.random().toString(36).slice(2),
    platform: 'ui', type: 'group', chatId: chat.chatId, userId: '20001', nickname: '小明',
    senderRole: 'member',
    segments: imgs.map((f) => ({ type: 'image', data: { file: f.path } })),
    text: '', isAtMe: false, isReplyToMe: false, raw: null, ts: Date.now(), role: 'member',
    files: imgs.map((f) => ({
      name: f.name, rel: 'inbox/' + f.name, sandboxPath: f.path, size: statSync(f.path).size,
    })),
    ...over,
  };
}

const asText = (r: any): string => (typeof r === 'string' ? r : String(r?.content ?? ''));

test('steal_sticker：模型看图打标（desc/tags/timing），失败退回消息文字，不记来源', async () => {
  const k = await boot();
  try {
    const dir = join(k.dataDir, 'src');
    mkdirSync(dir, { recursive: true });
    const write = (name: string, seed: number) => {
      const p = join(dir, name);
      writeFileSync(p, png(seed));
      return p;
    };
    const steal = k.toolOf('steal_sticker');

    // 打标成功：模型回 JSON，库里三项齐全
    k.mockEngine.script.push(tagStep('白猫捂脸笑', ['猫', '爆笑'], '被逗笑的时候'));
    let r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [{ name: 'a.png', path: write('a.png', 41) }], { text: '笑死 这个好' })) as any));
    assert.match(r, /已收下：白猫捂脸笑［猫\/爆笑］（用在被逗笑的时候）/);
    let lib = await k.library();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].desc, '白猫捂脸笑');
    assert.deepEqual(lib[0].tags, ['猫', '爆笑']);
    assert.equal(lib[0].timing, '被逗笑的时候');
    assert.ok(!('source' in lib[0]), '不记来源');

    // 打标失败（队列空 = 回声，不是 JSON）：收录照常，描述退回消息文字
    r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [{ name: 'b.png', path: write('b.png', 42) }], { text: '这张也收下' })) as any));
    assert.match(r, /已收下：这张也收下/);
    lib = await k.library();
    assert.equal(lib.length, 2);
    // 同毫秒收录的两张 addedAt 相同，/library 排序不保证先后：按描述找，别按下标
    const bItem = lib.find((s: any) => s.desc === '这张也收下');
    assert.ok(bItem, `第二张的描述应是消息文字兜底：${JSON.stringify(lib.map((s) => s.desc))}`);
    assert.deepEqual(bItem.tags, []);
    assert.equal(bItem.timing, '');

    // 同图再收：duplicate
    r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [{ name: 'a2.png', path: write('a2.png', 41) }])) as any));
    assert.match(r, /已经在库里/);
    assert.equal((await k.library()).length, 2);

    // 引用消息：replyTo.files 只有沙箱相对路径，靠 fs.sandbox 解析
    const inbox = join(k.kernel.sandbox.root(k.chat), 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'reply.png'), png(43));
    k.mockEngine.script.push(tagStep('小狗歪头', ['狗', '疑惑'], '没听懂的时候'));
    const replyEvent = eventOf(k.chat, [], {
      files: undefined,
      text: '看这个',
      replyTo: { userId: '20002', nickname: '小红', text: '[图片]', files: [{ name: 'reply.png', rel: 'inbox/reply.png' }] },
      segments: [{ type: 'reply', data: { id: 'm1' } }],
    });
    r = asText(await steal.handler({}, k.tctx(replyEvent) as any));
    assert.match(r, /已收下：小狗歪头/);
    lib = await k.library();
    assert.equal(lib.length, 3);

    // 没图明说
    r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [], { text: '只有字没有图' })) as any));
    assert.match(r, /没有图片/);

    // 工具面写明「明确要求才收」
    assert.match(steal.description, /明确要求/);
  } finally {
    await k.cleanup();
  }
});

test('send_sticker：按描述/标签/时机匹配、冷却、空库不注入提示', async () => {
  const k = await boot();
  try {
    await k.configure({ sendCooldownSec: 60 });
    const sendTool = k.toolOf('send_sticker');

    // 空库：beforeLLM 不注入清单节
    const empty = await k.plugin().hooks.beforeLLM!({
      chat: k.chat, event: eventOf(k.chat, []), system: '', messages: [], tools: [sendTool],
    } as any);
    assert.ok(!(empty.systemSections ?? []).some((s: any) => s.name === 'sticker'), '空库不注入清单');

    k.mockEngine.script.push(tagStep('狂笑滚地', ['笑'], '笑到不行的时候'));
    const up1 = await k.restJson('POST', '/upload', { name: '狂笑.png' }, png(11));
    k.mockEngine.script.push(tagStep('大哭', ['哭', '委屈'], '被说哭的时候'));
    const up2 = await k.restJson('POST', '/upload', { name: '大哭.png' }, png(12));
    assert.equal(up1.ok, true);
    assert.equal(up2.ok, true);

    // 有库：清单进 systemSections，带描述/标签/时机与分寸
    const injected = await k.plugin().hooks.beforeLLM!({
      chat: k.chat, event: eventOf(k.chat, []), system: '', messages: [], tools: [sendTool], systemSections: [],
    } as any);
    const sec = (injected.systemSections ?? []).find((s: any) => s.name === 'sticker');
    assert.ok(sec, '有图时要注入表情包节');
    assert.match(sec.text, /狂笑滚地/);
    assert.match(sec.text, /用在笑到不行的时候/);
    assert.match(sec.text, /明确让你收图/);
    assert.match(sec.text, /冷却/);

    // 时机词也能挑中：query「被说哭」→ 大哭那张
    const outs: any[] = [];
    const off = k.kernel.bus.on(busEvents.chatOut, (e: any) => outs.push(e));
    try {
      const r1 = asText(await sendTool.handler({ query: '被说哭' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r1, /已发了一张「大哭」/);
      assert.equal(outs.length, 1);
      assert.deepEqual(readFileSync(String(outs[0].segments[0].data.file)), png(12), '按时机挑中的应是「大哭」');
      let lib = await k.library();
      assert.equal(lib.find((s: any) => s.id === up2.id).count, 1);

      // 冷却中：不发、不计数、给模型一句中文提示
      const r2 = asText(await sendTool.handler({ query: '笑' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r2, /冷却/);
      assert.equal(outs.length, 1, '冷却中不许再发');

      // 关掉冷却（重载 = 新实例）：第二张能发
      await k.configure({ sendCooldownSec: 0 });
      const sendTool2 = k.toolOf('send_sticker');
      const r3 = asText(await sendTool2.handler({ query: '笑' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r3, /已发了一张「狂笑滚地」/);
      assert.equal(outs.length, 2);
      assert.deepEqual(readFileSync(String(outs[1].segments[0].data.file)), png(11));

      // 无命中：明说没有，不硬发
      const r4 = asText(await sendTool2.handler({ query: '完全对不上的东西' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r4, /没有和/);
      assert.equal(outs.length, 2);
    } finally {
      off();
    }
  } finally {
    await k.cleanup();
  }
});

test('REST：列表/改三项/上传/取图/删除/库容/补打标签', async () => {
  const k = await boot();
  try {
    const bytes = png(21);
    // 打标失败路径（队列空）：上传返回仍 ok，desc 用文件名
    const up = await k.restJson('POST', '/upload', { name: '开心_猫.png' }, bytes);
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.match(up.id, /^[0-9a-f]{16}$/);
    assert.equal(up.sticker.desc, '开心 猫');
    assert.deepEqual(up.sticker.tags, []);

    // 同一张图再传：id 相同，不新增（也不消耗一次打标）
    const dup = await k.restJson('POST', '/upload', { name: '换个名字.png' }, bytes);
    assert.equal(dup.id, up.id);
    assert.equal(dup.duplicate, true);

    let lib = await k.library();
    assert.equal(lib.length, 1);

    // 改描述/标签/时机（标签也接受逗号字符串）
    const upd = await k.restJson('POST', '/desc', {}, { id: up.id, desc: '开心猫猫', tags: '开心, 猫', timing: '被夸的时候' });
    assert.equal(upd.ok, true);
    lib = await k.library();
    assert.equal(lib[0].desc, '开心猫猫');
    assert.deepEqual(lib[0].tags, ['开心', '猫']);
    assert.equal(lib[0].timing, '被夸的时候');

    // 取图：类型、缓存头、字节
    const img = await k.rest('GET', '/image', { id: up.id });
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(String(img.headers['cache-control']), /max-age/);
    assert.deepEqual(Buffer.from(img.body as Buffer), bytes);

    const missing = await k.rest('GET', '/image', { id: 'deadbeefdeadbeef' });
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(String(missing.body)).ok, false);

    // 非图片 / 超 4MB：都拒收
    assert.equal((await k.rest('POST', '/upload', { name: 'x.txt' }, Buffer.from('not an image'))).status, 415);
    assert.equal((await k.rest('POST', '/upload', { name: 'big.png' }, Buffer.concat([png(22), Buffer.alloc(4 * 1024 * 1024)]))).status, 413);

    // JSON 分支点名 desc/tags/timing：模型不覆盖点名字段（队列里塞一个不同的答复验证）
    const named = await k.restJson('POST', '/upload', {}, {
      data: png(23).toString('base64'), desc: '手点的描述', tags: ['手点'], timing: '手点的时机',
    });
    assert.equal(named.ok, true);
    lib = await k.library();
    const namedItem = lib.find((s: any) => s.id === named.id);
    assert.equal(namedItem.desc, '手点的描述');
    assert.deepEqual(namedItem.tags, ['手点']);
    assert.equal(namedItem.timing, '手点的时机');

    // 补打标签：库里两张三项都齐全（一张手改过、一张 JSON 点名过），整批补不应动任何一张
    const retag = await k.restJson('POST', '/retag', {}, {});
    assert.equal(retag.ok, true);
    assert.equal(retag.tagged, 0, '三项齐全时补打标签不应动任何一张');

    // 删除：记录与文件一起走
    assert.equal((await k.restJson('POST', '/delete', {}, { id: up.id })).ok, true);
    assert.equal((await k.rest('GET', '/image', { id: up.id })).status, 404);
    const files = existsSync(join(k.dataDir, 'stickers')) ? readdirSync(join(k.dataDir, 'stickers')) : [];
    assert.equal(files.some((f) => f.startsWith(up.id)), false, '删除要连文件一起删');
    assert.equal((await k.library()).length, 1);

    // 库容：maxLibrary=1 时再传就 409（重载后端点仍然可用）
    await k.configure({ maxLibrary: 1 });
    const full = await k.rest('POST', '/upload', { name: '塞不下.png' }, png(24));
    assert.equal(full.status, 409);
    const fullJson = JSON.parse(String(full.body));
    assert.equal(fullJson.ok, false);
    assert.match(fullJson.error, /库满/);
  } finally {
    await k.cleanup();
  }
});

test('/retag：缺标的整批补，点名的强制重打；模型打标关着就 409', async () => {
  const k = await boot();
  try {
    // 两张不打标（队列空）：desc 落文件名兜底，tags/timing 全空
    const u1 = await k.restJson('POST', '/upload', { name: '一.png' }, png(61));
    const u2 = await k.restJson('POST', '/upload', { name: '二.png' }, png(62));
    assert.equal((await k.library()).every((s: any) => !s.tags.length), true);

    k.mockEngine.script.push(tagStep('第一张', ['一'], '第一次'));
    k.mockEngine.script.push(tagStep('第二张', ['二'], '第二次'));
    const r1 = await k.restJson('POST', '/retag', {}, {});
    assert.equal(r1.ok, true);
    assert.equal(r1.tagged, 2);
    let lib = await k.library();
    // 整批补是填空：desc 不覆盖（还是文件名兜底），tags/timing 补上
    assert.equal(lib.find((s: any) => s.id === u1.id).timing, '第一次');
    assert.deepEqual(lib.find((s: any) => s.id === u2.id).tags, ['二']);

    // 再跑一遍：全都齐了，不动
    const r2 = await k.restJson('POST', '/retag', {}, {});
    assert.equal(r2.tagged, 0);

    // 点名强制重打（覆盖已有）
    k.mockEngine.script.push(tagStep('重写描述', ['新的'], '新的时机'));
    const r3 = await k.restJson('POST', '/retag', {}, { id: u1.id });
    assert.equal(r3.ok, true);
    assert.equal(r3.tagged, 1);
    lib = await k.library();
    const item = lib.find((s: any) => s.id === u1.id);
    assert.equal(item.desc, '重写描述');
    assert.deepEqual(item.tags, ['新的']);
    assert.equal(item.timing, '新的时机');

    // 关掉自动打标签：409
    await k.configure({ modelTagging: false });
    const off = await k.rest('POST', '/retag', {}, {});
    assert.equal(off.status, 409);
  } finally {
    await k.cleanup();
  }
});

test('reload 后库与图片仍在（数据在 plugin_kv 与 data/stickers，不在进程内存）', async () => {
  const k = await boot();
  try {
    k.mockEngine.script.push(tagStep('存住', ['持久'], '任何时候'));
    const up = await k.restJson('POST', '/upload', { name: '存住.png' }, png(31));
    await k.kernel.container.reload('sticker');

    const lib = await k.library();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].id, up.id);
    assert.equal(lib[0].desc, '存住');
    assert.equal(lib[0].timing, '任何时候');

    const img = await k.rest('GET', '/image', { id: up.id });
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(img.body as Buffer), png(31));

    k.toolOf('send_sticker');
    const keys = k.kernel.db.all<{ key: string }>("SELECT key FROM plugin_kv WHERE plugin_id='sticker'").map((r) => r.key);
    assert.ok(keys.includes('v2:library'));
    assert.ok(keys.every((x) => x.startsWith('v2:')), `出现了不带 v2: 前缀的键：${keys.join(',')}`);
    // 自动收图的每日计数键不该再出现
    assert.ok(keys.every((x) => !x.startsWith('v2:daily:')), '每日收图计数已随自动收图一起删除');
  } finally {
    await k.cleanup();
  }
});

test('真实 HTTP：原始字节上传可用（桌面端 postRaw 那条路）', async () => {
  const k = await boot({ api: true });
  let api: any = null;
  try {
    const { startApiServer } = await import('../src/kernel/api/server.ts');
    api = await startApiServer(k.kernel);
    const base = `http://127.0.0.1:${(k.kernel.config.config as any).ui.port}`;
    const token = k.kernel.config.secrets.uiToken;

    const resp = await fetch(base + '/api/plugin/sticker/upload?name=' + encodeURIComponent('直传.png'), {
      method: 'POST',
      headers: { 'x-auth-token': token, 'content-type': 'image/png' },
      body: new Uint8Array(png(51)),
    });
    assert.equal(resp.status, 200);
    const data = (await resp.json()) as any;
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.ok(data.id);

    const img = await fetch(base + '/api/plugin/sticker/image?id=' + encodeURIComponent(data.id), {
      headers: { 'x-auth-token': token },
    });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(String(img.headers.get('cache-control')), /max-age/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png(51));
  } finally {
    if (api) await new Promise<void>((r) => api.close(() => r()));
    await k.cleanup();
  }
});
