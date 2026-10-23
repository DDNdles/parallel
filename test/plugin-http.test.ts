import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startApiServer } from '../src/kernel/api/server.ts';

// ============================================================
// 插件自带 HTTP 端点（2026-10-24）
//
//  契约：ctx.http.on(method, path, handler) → 对外 /api/plugin/<pluginId><path>
//  1. 注册即可用（200，query / JSON body / 自定义状态与响应头都透传）；
//  2. 未注册路径、未加载插件 → 404；
//  3. unload 即摘除（404），reload 后新实例重新注册生效；
//  4. 鉴权与其它 /api/* 完全一致：无 uiToken → 401；
//  5. 运行时停用（disabled）→ 404（端点是插件的贡献面，停用即整体消失）。
// ============================================================

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

/** 在临时 dataDir 里放一个用户插件：只用 ctx.http，不碰其它能力 */
function writeHttpPlugin(dataDir: string): void {
  const dir = join(dataDir, 'plugins', 'http-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    id: 'http-demo',
    name: 'HTTP 端点测试插件',
    version: '1.0.0',
    description: '内核插件 HTTP 端点测试用',
    category: 'tool',
    trust: 'user',
    permissions: [],
    defaultGroupState: 'on',
  }));
  // 临时目录没有 package.json，Node 会把 .ts 当 CJS；显式声明 ESM 才能用 export
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'index.ts'), `
export function setup(ctx) {
  // 每次载入 +1：reload 后能证明跑的是新模块实例
  const loads = (ctx.state.get('loads') ?? 0) + 1;
  ctx.state.set('loads', loads);
  ctx.http.on('GET', '/hello', (req) => ({ body: { ok: true, loads, q: req.query.q ?? null } }));
  ctx.http.on('POST', '/echo', (req) => ({
    status: 201,
    headers: { 'x-plugin': 'http-demo' },
    body: { got: req.body },
  }));
  ctx.http.on('GET', '/pixel.png', () => ({
    headers: { 'content-type': 'image/png' },
    body: Buffer.from([137, 80, 78, 71]),
  }));
  ctx.http.on('GET', '/text', () => '纯文本');
}
`);
}

test('插件 HTTP 端点：注册/未注册/卸载/重载/鉴权/停用', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-plugin-http-'));
  writeHttpPlugin(dataDir);

  const { Kernel } = await import('../src/kernel/kernel.ts');
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  cfg.ui.port = await freePort();

  await kernel.boot();
  let api: any = null;
  try {
    api = await startApiServer(kernel);
    const base = `http://127.0.0.1:${cfg.ui.port}`;
    const token = kernel.config.secrets.uiToken;
    const authed = (p: string, init: RequestInit = {}) => fetch(base + p, {
      ...init,
      headers: { 'x-auth-token': token, ...(init.headers ?? {}) },
    });

    // ① 注册即可用：query 透传，默认 JSON + no-store
    let resp = await authed('/api/plugin/http-demo/hello?q=' + encodeURIComponent('你好'));
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await resp.json(), { ok: true, loads: 1, q: '你好' });

    // ② 未注册路径 / 未知插件 → 404（两者对外不可区分）
    assert.equal((await authed('/api/plugin/http-demo/nope')).status, 404);
    assert.equal((await authed('/api/plugin/no-such-plugin/hello')).status, 404);

    // ③ POST 的 JSON body、自定义状态码与响应头
    resp = await authed('/api/plugin/http-demo/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1, s: '二' }),
    });
    assert.equal(resp.status, 201);
    assert.equal(resp.headers.get('x-plugin'), 'http-demo');
    assert.deepEqual(await resp.json(), { got: { n: 1, s: '二' } });

    // ④ 二进制响应：content-type 由插件指定，字节原样写出
    resp = await authed('/api/plugin/http-demo/pixel.png');
    assert.equal(resp.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await resp.arrayBuffer())], [137, 80, 78, 71]);

    // ⑤ 字符串响应默认 text/plain
    resp = await authed('/api/plugin/http-demo/text');
    assert.match(resp.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(await resp.text(), '纯文本');

    // ⑥ 无 token → 401：与其它 /api/* 同一把锁，不另开门
    assert.equal((await fetch(base + '/api/plugin/http-demo/hello')).status, 401);

    // ⑦ unload 即摘除
    await kernel.container.unload('http-demo');
    assert.equal((await authed('/api/plugin/http-demo/hello')).status, 404);

    // ⑧ 重新载入 + reload：新实例重新注册（loads 继续累加），端点仍然可用
    await kernel.container.load(join(dataDir, 'plugins', 'http-demo'), 'user');
    assert.equal((await (await authed('/api/plugin/http-demo/hello')).json()).loads, 2);
    await kernel.container.reload('http-demo');
    resp = await authed('/api/plugin/http-demo/hello');
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).loads, 3, 'reload 要跑新实例（?t= 破缓存）并重新注册路由');

    // ⑨ 运行时停用 → 404；重新启用 → 恢复
    await kernel.container.setRuntimeEnabled('http-demo', false);
    assert.equal((await authed('/api/plugin/http-demo/hello')).status, 404);
    await kernel.container.setRuntimeEnabled('http-demo', true);
    assert.equal((await authed('/api/plugin/http-demo/hello')).status, 200);
  } finally {
    if (api) await new Promise<void>((r) => api.close(() => r()));
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
