import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busEvents } from '../src/kernel/bus.ts';

// ============================================================
// 表情包插件（2026-10-24 重写）
//
//  1. onChatMessage 自动收图：内容去重、每群每日上限、跳过 bot 自己；
//  2. send_sticker：按描述/标签挑图、发出去、计数、冷却；空库不注入提示；
//  3. steal_sticker：消息内与引用消息里的图都能收，没图明说；
//  4. REST：列表/改描述/上传（原始字节或 base64）/取图/删除/库容；
//  5. reload 后数据仍在（plugin_kv 与 data/stickers 都不是进程内存）；
//  6. 真实 HTTP 的原始字节上传（前端 postRaw 走的就是这条）。
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

async function boot(opts: { api?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-sticker-'));
  const { Kernel } = await import('../src/kernel/kernel.ts');
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  if (opts.api) cfg.ui.port = await freePort();
  await kernel.boot();

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
  return { kernel, dataDir, chat, plugin, toolOf, tctx, rest, restJson, library, configure, cleanup };
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

test('onChatMessage：自动收图去重、每日上限、跳过 bot 自己', async () => {
  const k = await boot();
  try {
    await k.configure({ autoSteal: true, stealDailyCap: 2 });
    const dir = join(k.dataDir, 'src');
    mkdirSync(dir, { recursive: true });
    const write = (name: string, seed: number) => {
      const p = join(dir, name);
      writeFileSync(p, png(seed));
      return p;
    };
    const a = write('a.png', 1);
    const aCopy = write('a-copy.png', 1);
    const b = write('b.png', 2);
    const c = write('c.png', 3);
    const d = write('d.png', 4);

    await k.plugin().hooks.onChatMessage!(eventOf(k.chat, [{ name: 'a.png', path: a }]));
    let lib = await k.library();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].source.nickname, '小明');
    assert.equal(lib[0].desc, '来自小明的图');
    assert.equal(lib[0].count, 0);

    // bot 自己发的图：即便内容全新也不收
    await k.plugin().hooks.onChatMessage!(eventOf(k.chat, [{ name: 'd.png', path: d }], {
      userId: '3344', nickname: 'bot', raw: { self_id: '3344' },
    }));
    assert.equal((await k.library()).length, 1, 'bot 自己的图不能收');

    // 同一张图换个文件名：按内容 hash 去重，且不占每日额度
    await k.plugin().hooks.onChatMessage!(eventOf(k.chat, [{ name: 'a-copy.png', path: aCopy }]));
    assert.equal((await k.library()).length, 1, '同图换文件名要去重');

    await k.plugin().hooks.onChatMessage!(eventOf(k.chat, [{ name: 'b.png', path: b }]));
    assert.equal((await k.library()).length, 2);

    await k.plugin().hooks.onChatMessage!(eventOf(k.chat, [{ name: 'c.png', path: c }]));
    assert.equal((await k.library()).length, 2, '每群每日上限 2：第三张不收');

    // 图片落在 <data>/stickers/，id 是内容 hash
    const stored = readdirSync(join(k.dataDir, 'stickers'));
    assert.equal(stored.length, 2);
    assert.ok(stored.every((f) => /^[0-9a-f]{16}\.png$/.test(f)), `文件名应是 hash.png：${stored.join(',')}`);
    // 键全部 v2: 前缀（旧版索引不会混进来）
    const keys = k.kernel.db.all<{ key: string }>("SELECT key FROM plugin_kv WHERE plugin_id='sticker'").map((r) => r.key);
    assert.ok(keys.includes('v2:library'));
    assert.ok(keys.every((x) => x.startsWith('v2:')), `出现了不带 v2: 前缀的键：${keys.join(',')}`);
  } finally {
    await k.cleanup();
  }
});

test('send_sticker：按描述匹配、冷却、空库不注入提示', async () => {
  const k = await boot();
  try {
    await k.configure({ sendCooldownSec: 60 });
    const sendTool = k.toolOf('send_sticker');

    // 空库：beforeLLM 不注入清单节
    const empty = await k.plugin().hooks.beforeLLM!({
      chat: k.chat, event: eventOf(k.chat, []), system: '', messages: [], tools: [sendTool],
    } as any);
    assert.ok(!(empty.systemSections ?? []).some((s: any) => s.name === 'sticker'), '空库不注入清单');

    const up1 = await k.restJson('POST', '/upload', { name: '狂笑.png' }, png(11));
    const up2 = await k.restJson('POST', '/upload', { name: '大哭.png' }, png(12));
    assert.equal(up1.ok, true);
    assert.equal(up2.ok, true);

    // 有库：清单进 systemSections，带描述与分寸
    const injected = await k.plugin().hooks.beforeLLM!({
      chat: k.chat, event: eventOf(k.chat, []), system: '', messages: [], tools: [sendTool], systemSections: [],
    } as any);
    const sec = (injected.systemSections ?? []).find((s: any) => s.name === 'sticker');
    assert.ok(sec, '有图时要注入表情包节');
    assert.match(sec.text, /狂笑/);
    assert.match(sec.text, /看情况发/);
    assert.match(sec.text, /冷却/);

    const outs: any[] = [];
    const off = k.kernel.bus.on(busEvents.chatOut, (e: any) => outs.push(e));
    try {
      const r1 = asText(await sendTool.handler({ query: '笑' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r1, /已发了一张「狂笑」/);
      assert.equal(outs.length, 1);
      const seg = outs[0].segments[0];
      assert.equal(seg.type, 'image');
      assert.deepEqual(readFileSync(String(seg.data.file)), png(11), '挑中的应是「狂笑」那张');
      let lib = await k.library();
      assert.equal(lib.find((s: any) => s.id === up1.id).count, 1);
      assert.ok(lib.find((s: any) => s.id === up1.id).lastUsed > 0);

      // 冷却中：不发、不计数、给模型一句中文提示
      const r2 = asText(await sendTool.handler({ query: '哭' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r2, /冷却/);
      assert.equal(outs.length, 1, '冷却中不许再发');
      assert.equal((await k.library()).find((s: any) => s.id === up2.id).count, 0, '冷却中不改计数');

      // 关掉冷却（重载 = 新实例）：第二张能发
      await k.configure({ sendCooldownSec: 0 });
      const sendTool2 = k.toolOf('send_sticker');
      const r3 = asText(await sendTool2.handler({ query: '哭' }, k.tctx(eventOf(k.chat, [])) as any));
      assert.match(r3, /已发了一张「大哭」/);
      assert.equal(outs.length, 2);
      assert.deepEqual(readFileSync(String(outs[1].segments[0].data.file)), png(12));
      assert.equal((await k.library()).find((s: any) => s.id === up2.id).count, 1);

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

test('steal_sticker：消息内的图与引用消息里的图都能收，没图明说', async () => {
  const k = await boot();
  try {
    const dir = join(k.dataDir, 'src');
    mkdirSync(dir, { recursive: true });
    const a = join(dir, 'a.png');
    writeFileSync(a, png(41));
    const steal = k.toolOf('steal_sticker');

    let r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [{ name: 'a.png', path: a }], { text: '笑死 这个好' })) as any));
    assert.match(r, /已收下小明的图（笑死 这个好）/);
    let lib = await k.library();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].desc, '笑死 这个好');

    r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [{ name: 'a2.png', path: a }])) as any));
    assert.match(r, /已经在库里/);
    assert.equal((await k.library()).length, 1);

    // 引用消息：replyTo.files 只有沙箱相对路径，靠 fs.sandbox 解析
    const inbox = join(k.kernel.sandbox.root(k.chat), 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'reply.png'), png(42));
    const replyEvent = eventOf(k.chat, [], {
      files: undefined,
      text: '看这个',
      replyTo: { userId: '20002', nickname: '小红', text: '[图片]', files: [{ name: 'reply.png', rel: 'inbox/reply.png' }] },
      segments: [{ type: 'reply', data: { id: 'm1' } }],
    });
    r = asText(await steal.handler({}, k.tctx(replyEvent) as any));
    assert.match(r, /已收下小红/);
    lib = await k.library();
    assert.equal(lib.length, 2);
    assert.equal(lib.find((s: any) => s.source?.nickname === '小红').desc, '看这个');

    r = asText(await steal.handler({}, k.tctx(eventOf(k.chat, [], { text: '只有字没有图' })) as any));
    assert.match(r, /没有图片/);
  } finally {
    await k.cleanup();
  }
});

test('REST：列表/改描述/上传/取图/删除/库容', async () => {
  const k = await boot();
  try {
    const bytes = png(21);
    const up = await k.restJson('POST', '/upload', { name: '开心_猫.png' }, bytes);
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.match(up.id, /^[0-9a-f]{16}$/);

    // 同一张图再传：id 相同，不新增
    const dup = await k.restJson('POST', '/upload', { name: '换个名字.png' }, bytes);
    assert.equal(dup.id, up.id);
    assert.equal(dup.duplicate, true);

    let lib = await k.library();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].desc, '开心 猫');
    assert.deepEqual(lib[0].tags, []);
    assert.equal(lib[0].count, 0);
    assert.equal(lib[0].lastUsed, 0);
    assert.ok(lib[0].addedAt > 0);

    // 改描述与标签（标签也接受逗号字符串）
    const upd = await k.restJson('POST', '/desc', {}, { id: up.id, desc: '开心猫猫', tags: '开心, 猫' });
    assert.equal(upd.ok, true);
    lib = await k.library();
    assert.equal(lib[0].desc, '开心猫猫');
    assert.deepEqual(lib[0].tags, ['开心', '猫']);

    // 取图：类型、缓存头、字节
    const img = await k.rest('GET', '/image', { id: up.id });
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(String(img.headers['cache-control']), /max-age/);
    assert.deepEqual(Buffer.from(img.body as Buffer), bytes);

    const missing = await k.rest('GET', '/image', { id: 'deadbeefdeadbeef' });
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(String(missing.body)).ok, false);

    // 非图片 / 超 2MB：都拒收
    assert.equal((await k.rest('POST', '/upload', { name: 'x.txt' }, Buffer.from('not an image'))).status, 415);
    assert.equal((await k.rest('POST', '/upload', { name: 'big.png' }, Buffer.concat([png(22), Buffer.alloc(2 * 1024 * 1024)]))).status, 413);

    // 真实 HTTP 的 JSON 分支也能用：{"data":"<base64>"}
    const b64 = await k.restJson('POST', '/upload', { name: 'base64.png' }, { data: png(23).toString('base64') });
    assert.equal(b64.ok, true);
    assert.equal((await k.library()).length, 2);

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

test('reload 后库与图片仍在（数据在 plugin_kv 与 data/stickers，不在进程内存）', async () => {
  const k = await boot();
  try {
    const up = await k.restJson('POST', '/upload', { name: '存住.png' }, png(31));
    await k.kernel.container.reload('sticker');

    const lib = await k.library();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].id, up.id);
    assert.equal(lib[0].desc, '存住');

    const img = await k.rest('GET', '/image', { id: up.id });
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(img.body as Buffer), png(31));

    k.toolOf('send_sticker');
    const keys = k.kernel.db.all<{ key: string }>("SELECT key FROM plugin_kv WHERE plugin_id='sticker'").map((r) => r.key);
    assert.ok(keys.includes('v2:library'));
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
      body: png(51),
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
