import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Kernel } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';
import { depsReady, probeDeps, invalidateDepCache, type DepItem } from '../src/kernel/services/deps.ts';
import { DEP_FETCHES, startDepFetch } from '../src/kernel/services/downloads.ts';

/**
 * 现挑没人听的端口。旧写法用 pid 推端口（30000+pid%20000 / 42000+pid%6000），
 * 有些 pid 两个算式会撞同一个号：OneBot 先绑、API 再绑就 EADDRINUSE；
 * 而 startApiServer 原本在 try 之外，一抛错 kernel.shutdown() 永远执行不到，
 * 内核句柄泄漏把整个测试进程挂死（2026-10-24 真机复现过两次）。
 */
const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

/**
 * 初始环境检查页的后端契约：
 * 页面靠这份清单告诉用户「缺什么、去哪儿下」，所以每一项都必须自带可操作的落点。
 */
const DEPS_IDS = ['node', 'data', 'qq', 'llbot', 'docker', 'python', 'bash', 'ffmpeg'];

test('依赖探测：每项都带名称/状态，缺失项必须给出下载或自装入口', async () => {
  invalidateDepCache();
  const items = await probeDeps({
    dataDir: mkdtempSync(join(tmpdir(), 'parallel-deps-')),
    headed: true, endFlavor: 'llbot', endDownloaded: false, endConnected: false, qqPathCfg: '',
  }, true);
  assert.deepEqual(items.map((i) => i.id), DEPS_IDS);
  for (const i of items) {
    assert.ok(i.label && i.detail, `${i.id} 缺文案`);
    assert.ok(['ok', 'idle', 'missing'].includes(i.state), `${i.id} 状态非法`);
    assert.equal(typeof i.required, 'boolean');
    if (i.state === 'missing' && i.id !== 'data') {
      assert.ok(i.download || i.install, `${i.id} 缺失却没给下载/自装入口`);
    }
    if (i.state === 'idle') {
      assert.ok(i.launch, `${i.id} 装了没启动，就该给「启动」而不是下载`);
      assert.ok(!i.download, `${i.id} 已经装了，不许再给下载链接`);
    }
  }
  const node = items.find((i) => i.id === 'node')!;
  assert.equal(node.state, 'ok', '内核就跑在 node 上，这一项不可能不 OK');
  assert.equal(node.required, true);
  for (const id of ['docker', 'python', 'bash']) {
    assert.equal(items.find((i) => i.id === id)!.required, true, `${id} 是必备项`);
  }
  assert.equal(items.find((i) => i.id === 'ffmpeg')!.required, false, 'ffmpeg 只影响语音，可选');
  const llbot = items.find((i) => i.id === 'llbot')!;
  assert.equal(llbot.label, 'LuckyLillia', '这一项按产品名叫，不叫「协议端发行包」');
  assert.equal(llbot.install, 'llbot', '发行包由内核自下载（install 是路由键，不是名字）');
  assert.match(String(llbot.download), /^https:\/\/github\.com\//, '两个渠道：代下载之外还要给官方 releases 链接');
  assert.equal(llbot.state, 'missing', '本内核没下载、也没有外部协议端连入 → 才算缺');
  // 缺的那两项同样要两个渠道都在（本机装了就走 ok，不硬断言 missing）
  for (const id of ['docker', 'ffmpeg']) {
    const it = items.find((i) => i.id === id)!;
    if (it.state !== 'missing') continue;
    assert.ok(it.install, `${id} 缺失时要有「点击就下载」`);
    assert.ok(it.download, `${id} 缺失时还要留官网链接（第二个渠道）`);
  }

  // 用户自己起协议端（不走托管）时：反向 WS 连着就不能报"必备项缺失"
  const hosted = await probeDeps({
    dataDir: mkdtempSync(join(tmpdir(), 'parallel-deps2-')),
    headed: true, endFlavor: 'llbot', endDownloaded: false, endConnected: true, qqPathCfg: '',
  }, true);
  const ext = hosted.find((i) => i.id === 'llbot')!;
  assert.equal(ext.state, 'ok');
  assert.match(ext.detail, /外部协议端/);

  // 切成 NapCat 那一档：名字、落点目录、官网链接都要跟着换（这一项探的是"当前所选协议端"，不是写死 LLBot）
  invalidateDepCache();
  const nap = await probeDeps({
    dataDir: mkdtempSync(join(tmpdir(), 'parallel-deps3-')),
    headed: true, endFlavor: 'napcat', endDownloaded: true, endConnected: false, qqPathCfg: '',
  }, true);
  const nc = nap.find((i) => i.id === 'llbot')!;
  assert.equal(nc.label, 'NapCat');
  assert.equal(nc.state, 'ok');
  assert.equal(nc.detail, '已就位（data/napcat）', '详情里的目录不能还写 data/llbot');
  assert.match(String(nc.download), /NapNeko\/NapCatQQ/, '官网链接指向该档自己的 releases');
});

test('代下载只认白名单：不在表里的 id 一律拒绝，绝不拿前端传来的 URL 去 fetch', () => {
  assert.throws(() => startDepFetch('evil', mkdtempSync(join(tmpdir(), 'parallel-dl-'))), /白名单/);
  assert.match(DEP_FETCHES.docker.url, /^https:\/\/desktop\.docker\.com\//);
  assert.equal(DEP_FETCHES.ffmpeg.unpackBin, 'ffmpeg.exe', 'ffmpeg 是唯一"下完顺手解出来就能用"的');
});

test('depsReady：只看必备项', () => {  const mk = (over: Partial<DepItem> & { id: string }, required = true): DepItem => ({
    label: over.id, required, state: 'ok', detail: '', ...over,
  });
  assert.equal(depsReady([mk({ id: 'node' }), mk({ id: 'qq' })]), true);
  assert.equal(depsReady([mk({ id: 'node' }), mk({ id: 'qq', state: 'missing' })]), false);
  assert.equal(depsReady([mk({ id: 'node' }), mk({ id: 'docker', state: 'missing' }, false)]), true, '可选项不拦路');
});

test('API：/api/setup/deps 免 token、不碰协议端；install 在 noApi 内核里必须拒绝', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-setup-api-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const ob = kernel.config.config.onebot as unknown as Record<string, unknown>;
  ob.port = await freePort();
  kernel.config.config.ui.port = await freePort();
  await kernel.boot();
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;
  const base = `http://127.0.0.1:${kernel.config.config.ui.port}`;
  try {
    server = await startApiServer(kernel);
    // 不带 token 也要能读：这页排在拿到 token 之前
    const r = await fetch(`${base}/api/setup/deps`);
    assert.equal(r.status, 200);
    const body = await r.json() as { items: DepItem[]; ready: boolean; setupDoneAt: number; managesEnd: boolean };
    assert.equal(body.items.length, DEPS_IDS.length);
    assert.equal(body.setupDoneAt, 0, '首次运行没走过初始页');
    assert.equal(body.managesEnd, false, 'noApi 内核不托管，页面不该给「下载协议端」按钮');
    const text = JSON.stringify(body);
    assert.ok(!text.includes(kernel.config.secrets.uiToken), '响应里不许出现令牌');
    assert.ok(!text.includes(kernel.config.secrets.onebotAccessToken), '响应里不许出现 OneBot token');

    // 探测本身不许把协议端拉起来（noApi 红线：不下载、不注入）
    assert.equal(kernel.llbot.running(), false);

    const inst = await fetch(`${base}/api/setup/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(inst.status, 409, '不托管的内核拒绝下载发行包');
    assert.equal(kernel.llbot.running(), false);

    // 走过初始页要落盘，否则每次启动都拦一遍
    const done = await fetch(`${base}/api/setup/done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(done.status, 200);
    assert.ok(Number(((await done.json()) as { setupDoneAt: number }).setupDoneAt) > 0);
    assert.ok(Number(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8')).ui.setupDoneAt) > 0, '必须落盘');
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await kernel.shutdown();
  }
});
