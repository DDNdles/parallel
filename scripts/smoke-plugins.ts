/**
 * 三插件冒烟：真实内核 + 真实 HTTP API + 临时 dataDir（绝不碰真实 data/）。
 *
 * 用法：node --experimental-transform-types --no-warnings scripts/smoke-plugins.ts
 *
 * 覆盖：
 *  - sticker / bilibili / imagegen 真的载入，且出现在 GET /api/plugins（hidden 未设 = false）；
 *  - chat 面只拿到表情包工具（send_sticker / steal_sticker），bili_* 与 generate_image 不在 chat 面；
 *  - work 面（work.md 白名单）拿到 bili_search / bili_video / bili_comments / generate_image；
 *  - 三个插件的 ctx.http 端点：正常 200、无 token 401、未知路径 404；
 *  - POST /api/plugins/sticker/reload 后工具与端点仍可用；
 *  - setRuntimeEnabled 停用 sticker 后 chat 面工具与端点一起消失（可插拔）。
 *
 * B 站与 Gemini 的外网请求打桩（验证端点与响应契约，不依赖真实网络）；
 * 访问内核自己的 HTTP 走真 fetch。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel/kernel.ts';
import { startApiServer } from '../src/kernel/api/server.ts';

type Status = 'PASS' | 'FAIL';
interface Row { name: string; status: Status; detail: string }
const rows: Row[] = [];
const add = (name: string, status: Status, detail: string): void => {
  rows.push({ name, status, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 200) });
};

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const PNG2 = Buffer.concat([PNG, Buffer.from([0x01])]);
const BVID = 'BV1xx411c7mD';

const freePort = (): Promise<number> => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => res(p));
  });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 只拦 B 站与 Gemini；其余（包括内核自己的 127.0.0.1）走真 fetch */
function installStubs(): { restore: () => void; geminiCalls: () => number } {
  const realFetch = globalThis.fetch;
  let gemini = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.includes('generativelanguage.googleapis.com')) {
      gemini += 1;
      return json({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] },
          finishReason: 'STOP',
        }],
      });
    }
    if (url.includes('api.bilibili.com')) {
      if (url.includes('/x/web-interface/nav')) {
        return json({
          code: -101,
          message: '账号未登录',
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        });
      }
      if (url.includes('/x/web-interface/wbi/search/type')) {
        return json({
          code: 0,
          data: {
            numResults: 1,
            result: [{
              bvid: BVID, aid: 123456, title: '<em>冒烟</em>视频', author: 'UP主', mid: 42,
              pic: '//i0.hdslb.com/cover.jpg', duration: '01:23', play: 100, video_review: 2,
              description: '简介<em>高亮</em>',
            }],
          },
        });
      }
      if (url.includes('/x/web-interface/view')) {
        return json({
          code: 0,
          data: {
            bvid: BVID, aid: 123456, cid: 789012, title: '冒烟视频', desc: '简介',
            owner: { mid: 42, name: 'UP主' },
            stat: { view: 1000, danmaku: 5, favorite: 6, coin: 7, share: 8, like: 9 },
            duration: 83, pic: '//i0.hdslb.com/cover.jpg',
            pages: [{ page: 1, cid: 789012, part: '正片', duration: 83 }],
          },
        });
      }
      if (url.includes('/x/player/wbi/v2')) {
        return json({ code: 0, data: { subtitle: { subtitles: [] } } });
      }
      if (url.includes('/x/v2/reply')) {
        return json({
          code: 0,
          data: { replies: [{ rpid: 1, member: { uname: '观众' }, content: { message: '好看' }, like: 3, ctime: 1_700_000_000 }], page: { count: 1 } },
        });
      }
      return json({ code: -404, message: `smoke 未打桩：${url}` });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = realFetch; }, geminiCalls: () => gemini };
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-smoke-plugins-'));
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  cfg.ui.port = await freePort();
  cfg.masterIds = ['10001'];
  kernel.config.setPluginSecret('imagegen', 'apiKey', 'smoke-key');
  await kernel.boot();

  const stub = installStubs();
  const api = await startApiServer(kernel);
  const base = `http://127.0.0.1:${cfg.ui.port}`;
  const token = kernel.config.secrets.uiToken;
  // 401 检查也走 fetch：桩只拦 B 站/Gemini，本地请求原样透传
  const authed = (p: string, init: RequestInit = {}): Promise<Response> => fetch(base + p, {
    ...init,
    headers: { 'x-auth-token': token, ...(init.headers ?? {}) },
  });

  const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9500' };
  const wanted = ['sticker', 'bilibili', 'imagegen'];
  const names = (ts: { name: string }[]): string[] => ts.map((t) => t.name);

  try {
    // ---------- 1) 载入与插件列表 ----------
    const missing = wanted.filter((id) => !kernel.container.get(id));
    const notLoaded = wanted.filter((id) => kernel.container.get(id)?.state !== 'loaded');
    add('插件加载', missing.length || notLoaded.length ? 'FAIL' : 'PASS',
      `${wanted.map((id) => `${id}@${kernel.container.get(id)?.manifest.version}`).join(' / ')}；缺 ${missing.join(',') || '无'}`);

    const pluginsResp = await authed('/api/plugins');
    const plugins = (await pluginsResp.json()) as any[];
    const invisible = wanted.filter((id) => !plugins.some((p) => p.id === id));
    const hidden = wanted.filter((id) => kernel.container.get(id)!.manifest.hidden === true);
    add('GET /api/plugins', pluginsResp.status !== 200 || invisible.length || hidden.length ? 'FAIL' : 'PASS',
      `状态 ${pluginsResp.status}；可见 ${wanted.filter((id) => plugins.some((p) => p.id === id)).join(',') || '无'}；hidden=true ${hidden.join(',') || '无'}`);

    // ---------- 2) 工具面 ----------
    const chatTools = names(kernel.container.toolsForChat(chat, 'owner', 'chat'));
    const missingChat = ['send_sticker', 'steal_sticker'].filter((n) => !chatTools.includes(n));
    const leakedChat = ['bili_search', 'bili_video', 'bili_comments', 'generate_image'].filter((n) => chatTools.includes(n));
    add('chat 工具面', missingChat.length || leakedChat.length ? 'FAIL' : 'PASS',
      missingChat.length ? `缺 ${missingChat.join(',')}` : leakedChat.length ? `work 工具漏进 chat：${leakedChat.join(',')}` : `send_sticker/steal_sticker 都在；chat 共 ${chatTools.length} 个工具`);

    const agent = kernel.container.workAgent();
    const workTools = names(kernel.container.workToolsFor(chat, 'owner', agent, 0));
    const workWanted = ['bili_search', 'bili_video', 'bili_comments', 'generate_image'];
    const missingWork = workWanted.filter((n) => !workTools.includes(n));
    add('work 工具面', missingWork.length ? 'FAIL' : 'PASS',
      missingWork.length ? `缺 ${missingWork.join(',')}` : `${workWanted.join(' / ')} 都在（agent=${agent.name}，白名单 ${agent.tools?.length ?? 0} 项）`);

    // ---------- 3) 表情包端点 ----------
    const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; ct: string; json: any }> => {
      const r = await authed(p, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch { /* 二进制分支不解析 */ }
      return { status: r.status, ct: r.headers.get('content-type') ?? '', json: parsed };
    };

    let r = await call('GET', '/api/plugin/sticker/library');
    add('sticker /library', r.status === 200 && r.json?.ok === true ? 'PASS' : 'FAIL',
      `HTTP ${r.status}；ok=${r.json?.ok}；${Array.isArray(r.json?.stickers) ? `${r.json.stickers.length} 张` : '没有 stickers 数组'}`);

    const up1 = await call('POST', '/api/plugin/sticker/upload', { name: '冒烟一.png', data: PNG.toString('base64') });
    const up2 = await call('POST', '/api/plugin/sticker/upload', { name: '冒烟二.png', data: PNG2.toString('base64') });
    add('sticker /upload', up1.status === 200 && up1.json?.ok && up2.status === 200 && up2.json?.ok ? 'PASS' : 'FAIL',
      `HTTP ${up1.status}/${up2.status}；id=${up1.json?.id ?? '—'}/${up2.json?.id ?? '—'}`);

    const desc = await call('POST', '/api/plugin/sticker/desc', { id: up1.json?.id, desc: '冒烟图', tags: ['冒烟', '测试'] });
    add('sticker /desc', desc.status === 200 && desc.json?.sticker?.desc === '冒烟图' ? 'PASS' : 'FAIL',
      `HTTP ${desc.status}；desc=${desc.json?.sticker?.desc}；tags=${JSON.stringify(desc.json?.sticker?.tags)}`);

    const imgResp = await authed('/api/plugin/sticker/image?id=' + encodeURIComponent(String(up1.json?.id ?? '')));
    const imgBytes = Buffer.from(await imgResp.arrayBuffer());
    add('sticker /image', imgResp.status === 200 && /image\/png/.test(imgResp.headers.get('content-type') ?? '') && imgBytes.equals(PNG) ? 'PASS' : 'FAIL',
      `HTTP ${imgResp.status}；${imgResp.headers.get('content-type')}；${imgBytes.length} 字节`);

    const del = await call('POST', '/api/plugin/sticker/delete', { id: up2.json?.id });
    add('sticker /delete', del.status === 200 && del.json?.ok === true ? 'PASS' : 'FAIL',
      `HTTP ${del.status}；ok=${del.json?.ok}`);

    // ---------- 4) B 站端点（外网打桩，HTTP 链路是真的） ----------
    r = await call('GET', '/api/plugin/bilibili/search?kw=' + encodeURIComponent('冒烟') + '&page=1');
    add('bilibili /search', r.status === 200 && r.json?.ok === true && r.json?.videos?.[0]?.bvid === BVID ? 'PASS' : 'FAIL',
      `HTTP ${r.status}；${r.json?.ok ? `${r.json.videos?.length} 条，首条 ${r.json.videos?.[0]?.title}` : r.json?.error ?? '无 JSON'}`);

    r = await call('GET', '/api/plugin/bilibili/video?bvid=' + BVID);
    add('bilibili /video', r.status === 200 && r.json?.ok === true && r.json?.video?.bvid === BVID ? 'PASS' : 'FAIL',
      `HTTP ${r.status}；${r.json?.ok ? `${r.json.video?.title}，字幕 ${r.json.video?.subtitleAvailable}` : r.json?.error ?? '无 JSON'}`);

    r = await call('GET', '/api/plugin/bilibili/comments?bvid=' + BVID + '&page=1&sort=hot');
    add('bilibili /comments', r.status === 200 && r.json?.ok === true && Array.isArray(r.json?.comments) ? 'PASS' : 'FAIL',
      `HTTP ${r.status}；${r.json?.ok ? `${r.json.comments?.length} 条评论，time=${r.json.comments?.[0]?.time}` : r.json?.error ?? '无 JSON'}`);

    // ---------- 5) 生图端点（Gemini 打桩；带 data URL 参考图 = 桌面端实际传法） ----------
    r = await call('GET', '/api/plugin/imagegen/gallery');
    add('imagegen /gallery', r.status === 200 && r.json?.ok === true && Array.isArray(r.json?.images) ? 'PASS' : 'FAIL',
      `HTTP ${r.status}；ok=${r.json?.ok}；${Array.isArray(r.json?.images) ? `${r.json.images.length} 张` : '没有 images 数组'}`);

    r = await call('GET', '/api/plugin/imagegen/usage');
    add('imagegen /usage', r.status === 200 && r.json?.ok === true && typeof r.json?.weekKey === 'string' ? 'PASS' : 'FAIL',
      `HTTP ${r.status}；week=${r.json?.weekKey}；${r.json?.users?.length ?? 0} 人`);

    const gen = await call('POST', '/api/plugin/imagegen/generate', {
      prompt: '冒烟画一张',
      refs: [`data:image/png;base64,${PNG_B64}`],
    });
    add('imagegen /generate', gen.status === 200 && gen.json?.ok === true && gen.json?.id ? 'PASS' : 'FAIL',
      `HTTP ${gen.status}；${gen.json?.ok ? `id=${gen.json.id}` : gen.json?.error ?? '无 JSON'}；Gemini 调用 ${stub.geminiCalls()} 次`);

    const gal = await call('GET', '/api/plugin/imagegen/gallery');
    const shown = Array.isArray(gal.json?.images) ? gal.json.images.find((x: any) => x.id === gen.json?.id) : undefined;
    const genImg = await authed('/api/plugin/imagegen/image?id=' + encodeURIComponent(String(gen.json?.id ?? '')));
    const genBytes = Buffer.from(await genImg.arrayBuffer());
    add('imagegen /image', genImg.status === 200 && genBytes.equals(PNG) && !!shown ? 'PASS' : 'FAIL',
      `HTTP ${genImg.status}；${genBytes.length} 字节；画廊${shown ? '可见' : '不可见'}`);

    // ---------- 6) 鉴权与 404 ----------
    const noToken = await fetch(base + '/api/plugin/sticker/library');
    add('无 token → 401', noToken.status === 401 ? 'PASS' : 'FAIL', `HTTP ${noToken.status}`);
    const noRoute = await call('GET', '/api/plugin/sticker/nope');
    const noRoute2 = await call('GET', '/api/plugin/bilibili/nope');
    add('未知路径 → 404', noRoute.status === 404 && noRoute2.status === 404 ? 'PASS' : 'FAIL',
      `sticker ${noRoute.status} / bilibili ${noRoute2.status}`);

    // ---------- 7) 热重载 ----------
    const reload = await call('POST', '/api/plugins/sticker/reload');
    const chatAfter = names(kernel.container.toolsForChat(chat, 'owner', 'chat'));
    const libAfter = await call('GET', '/api/plugin/sticker/library');
    const reloadOk = reload.status === 200 && reload.json?.ok === true
      && chatAfter.includes('send_sticker') && chatAfter.includes('steal_sticker')
      && libAfter.status === 200 && libAfter.json?.ok === true;
    add('reload 后仍可用', reloadOk ? 'PASS' : 'FAIL',
      `reload HTTP ${reload.status}；工具 ${chatAfter.includes('send_sticker') ? '在' : '缺'}；/library HTTP ${libAfter.status}，${libAfter.json?.stickers?.length ?? '—'} 张`);

    // ---------- 8) 运行态停用 ----------
    await kernel.container.setRuntimeEnabled('sticker', false);
    const chatOff = names(kernel.container.toolsForChat(chat, 'owner', 'chat'));
    const gone = ['send_sticker', 'steal_sticker'].filter((n) => !chatOff.includes(n));
    const endpointOff = await call('GET', '/api/plugin/sticker/library');
    add('停用 sticker', gone.length === 2 && endpointOff.status === 404 ? 'PASS' : 'FAIL',
      `chat 面缺席 ${gone.join(',') || '无'}；端点 HTTP ${endpointOff.status}`);
    // 恢复，保证 shutdown 前插件状态一致
    await kernel.container.setRuntimeEnabled('sticker', true);
  } finally {
    try { stub.restore(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // 报表
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  console.log('\n===== 插件冒烟 =====');
  for (const row of rows) console.log(`${row.status} ${pad(row.name, 22)} ${row.detail}`);
  const fails = rows.filter((row) => row.status === 'FAIL');
  console.log(`\n合计 ${rows.length}：PASS ${rows.length - fails.length} / FAIL ${fails.length}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('插件冒烟脚本异常：', e);
  process.exitCode = 1;
});
