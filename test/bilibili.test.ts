import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

import {
  setup, mixinKeyOf, signWbiQuery, parseVideoRef, parseDuration,
} from '../src/plugins/bilibili/index.ts';

// ============================================================
// bilibili 插件（2026-10-24）
//
//  1. wbi 签名用官方文档的测试向量复算（mixinKey 与 w_rid 都能对上）；
//  2. b23.tv 短链跟随重定向解析出 bvid；
//  3. 搜索/评论/视频的字段映射（去 <em> 高亮、时长转秒、pic 补协议）；
//  4. requestDelayMs 真的把相邻 fetch 拉开；
//  5. REST 三端点与 work 面工具走同一份取数逻辑；
//  6. 失败/风控返回中文结构化文本，不抛栈。
// ============================================================

const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';
const BVID = 'BV1xx411c7mD';

const NAV = {
  // 未登录时 nav 就是 -101，但仍带 wbi_img；客户端不能把它当普通错误拦掉
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
    },
  },
};

const SEARCH = {
  code: 0,
  message: '0',
  data: {
    numResults: 3,
    result: [
      {
        bvid: BVID, aid: 123456, title: '<em class="keyword">测试</em>视频 &amp; 标题',
        author: '测试UP', mid: 42, pic: '//i2.hdslb.com/bfs/archive/cover.jpg',
        duration: '05:12', play: 12345, video_review: 67, description: '简介<em>高亮</em>',
      },
      {
        bvid: 'BV1yy411c7mE', aid: 123457, title: '第二个视频', author: '另一个UP', mid: 43,
        pic: '', duration: '1:02:03', play: 100, danmaku: 2, description: '',
      },
      { title: '没有 BV 号的条目' },
    ],
  },
};

const VIEW = {
  code: 0,
  message: '0',
  data: {
    bvid: BVID, aid: 123456, cid: 789012,
    title: '测试视频 &amp; 标题', desc: '这是简介\n第二行',
    owner: { mid: 42, name: '测试UP' },
    stat: { view: 1234567, danmaku: 2345, reply: 10, favorite: 3456, coin: 456, share: 78, like: 6789 },
    duration: 312,
    pic: '//i2.hdslb.com/cover.jpg',
    pages: [
      { page: 1, cid: 789012, part: 'P1 正片', duration: 312 },
      { page: 2, cid: 789013, part: 'P2 花絮', duration: 60 },
    ],
  },
};

const PLAYER = {
  code: 0,
  message: '0',
  data: {
    subtitle: {
      subtitles: [
        { lan: 'en-US', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json' },
        { lan: 'ai-zh', lan_doc: '中文（AI生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/zh.json?auth_key=x' },
      ],
    },
  },
};

const SUBTITLE_BODY = {
  body: [
    { from: 0, to: 1.5, content: '第一句' },
    { from: 1.5, to: 3, content: '第二句' },
  ],
};

const REPLY = {
  code: 0,
  message: '0',
  data: {
    replies: [
      { rpid: 111, member: { uname: '甲' }, content: { message: '好看' }, like: 9, ctime: 1_700_000_000 },
      { rpid: 112, member: { uname: '乙' }, content: { message: '<em>哈哈</em>' }, like: 0, ctime: 1_700_000_100 },
    ],
    page: { count: 42, num: 1, size: 20 },
  },
};

// ---------------- 最小插件宿主：只实现本插件用到的那几面 ----------------

interface Harness {
  tools: Map<string, any>;
  routes: Map<string, (req: any) => Promise<any>>;
  hooks: Record<string, any>;
}

function makeHarness(userConfig: Record<string, unknown> = {}): Harness {
  const tools = new Map<string, any>();
  const routes = new Map<string, (req: any) => Promise<any>>();
  const hooks: Record<string, any> = {};
  const ctx: any = {
    manifest: { id: 'bilibili', name: 'B站搜索', version: '1.0.0', permissions: ['network'] },
    userConfig: {
      sessdata: '',
      searchLimit: 20,
      commentLimit: 20,
      requestDelayMs: 0,
      ...userConfig,
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    llm: { registerTool: (def: any) => tools.set(def.name, def) },
    http: { on: (method: string, path: string, handler: any) => routes.set(`${method.toUpperCase()} ${path}`, handler) },
    hooks,
  };
  setup(ctx);
  return { tools, routes, hooks };
}

const getRoute = async (h: Harness, path: string, query: Record<string, string>) => {
  const handler = h.routes.get(`GET ${path}`);
  assert.ok(handler, `缺少端点 GET ${path}`);
  return handler!({ method: 'GET', path, query, body: {} });
};

// ---------------- fetch 桩 ----------------

type FetchCall = { url: string; at: number };

function installFetch(handler: (url: string) => any): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    return handler(url);
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

function jsonResp(body: any, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const status = opts.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: new Headers(opts.headers ?? {}),
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

function biliRoutes() {
  return (url: string) => {
    if (url.includes('b23.tv')) {
      return jsonResp({}, {
        status: 302,
        headers: { location: `https://www.bilibili.com/video/${BVID}?share_source=copy` },
      });
    }
    if (url.includes('/x/web-interface/nav')) return jsonResp(NAV);
    if (url.includes('/x/web-interface/wbi/search/type')) return jsonResp(SEARCH);
    if (url.includes('/x/web-interface/view')) return jsonResp(VIEW);
    if (url.includes('/x/player/wbi/v2')) return jsonResp(PLAYER);
    if (url.includes('aisubtitle.hdslb.com')) return jsonResp(SUBTITLE_BODY);
    if (url.includes('/x/v2/reply')) return jsonResp(REPLY);
    throw new Error(`测试没有为这个地址准备响应：${url}`);
  };
}

// ---------------- 1. wbi 签名 ----------------

test('wbi 签名：mixinKey 与 w_rid 都能用官方测试向量复算', () => {
  assert.equal(mixinKeyOf(IMG_KEY, SUB_KEY), MIXIN_KEY);
  const query = signWbiQuery({ foo: '114', bar: '514', zab: 1919810 }, MIXIN_KEY, 1_702_204_169);
  assert.equal(query, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  // 独立再算一次 md5，确认 w_rid 不是写死的
  const raw = 'bar=514&foo=114&wts=1702204169&zab=1919810' + MIXIN_KEY;
  assert.equal(createHash('md5').update(raw).digest('hex'), '8f6f2b5b3d485fe1886cec6a0be8c5d4');
  // 中文与空格按 encodeURIComponent 编码（空格 %20，不是 +）
  const unicode = signWbiQuery({ bar: '五一四', foo: 'one one four', baz: 1919810 }, MIXIN_KEY, 1_702_204_169);
  assert.match(unicode, /^bar=%E4%BA%94%E4%B8%80%E5%9B%9B&baz=1919810&foo=one%20one%20four&wts=1702204169&w_rid=/);
});

// ---------------- 2. 视频标识与基础解析 ----------------

test('视频标识：BV 号 / av 号 / 链接，短链留给 client 跟随重定向', () => {
  assert.equal(parseVideoRef('BV1xx411c7mD')?.bvid, BVID);
  assert.equal(parseVideoRef(`https://www.bilibili.com/video/${BVID}?spm_id_from=333`)?.bvid, BVID);
  assert.equal(parseVideoRef('https://www.bilibili.com/video/av170001')?.aid, 170001);
  assert.equal(parseVideoRef('av170001')?.aid, 170001);
  assert.equal(parseVideoRef('170001')?.aid, 170001);
  assert.equal(parseVideoRef('https://b23.tv/abc'), null);
  assert.equal(parseVideoRef('随便一句话'), null);
  assert.equal(parseDuration('05:12'), 312);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration(90), 90);
});

test('工具注册：三个 bili_* 都只在 work 面', () => {
  const h = makeHarness();
  for (const name of ['bili_search', 'bili_video', 'bili_comments']) {
    const tool = h.tools.get(name);
    assert.ok(tool, `缺少工具 ${name}`);
    assert.equal(tool.surface, 'work');
  }
});

// ---------------- 3. REST /search ----------------

test('REST /search：去高亮、时长转秒、字段映射', async () => {
  const h = makeHarness();
  const f = installFetch(biliRoutes());
  try {
    const res = await getRoute(h, '/search', { kw: '测试', page: '1' });
    assert.equal(res.status, undefined);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.videos.length, 2, '没有 BV 号的条目要被过滤');
    assert.deepEqual(res.body.videos[0], {
      bvid: BVID,
      aid: 123456,
      title: '测试视频 & 标题',
      author: '测试UP',
      authorMid: 42,
      pic: 'https://i2.hdslb.com/bfs/archive/cover.jpg',
      duration: 312,
      play: 12345,
      danmaku: 67,
      desc: '简介高亮',
    });
    assert.equal(res.body.videos[1].duration, 3723);
    // 缺关键词 → 400 结构化错误
    const bad = await getRoute(h, '/search', {});
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
  } finally {
    f.restore();
  }
});

// ---------------- 4. REST /comments ----------------

test('REST /comments：bvid 换 aid、排序映射、评论字段', async () => {
  const h = makeHarness();
  const f = installFetch(biliRoutes());
  try {
    const res = await getRoute(h, '/comments', { bvid: BVID, page: '2', sort: 'time' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.total, 42);
    assert.deepEqual(res.body.comments, [
      { rpid: 111, user: '甲', content: '好看', likes: 9, time: 1_700_000_000_000 },
      { rpid: 112, user: '乙', content: '哈哈', likes: 0, time: 1_700_000_100_000 },
    ]);
    const reply = f.calls.find((c) => c.url.includes('/x/v2/reply'));
    assert.ok(reply, '应当请求评论接口');
    assert.match(reply!.url, /[?&]oid=123456(&|$)/);
    assert.match(reply!.url, /[?&]pn=2(&|$)/);
    assert.match(reply!.url, /[?&]sort=0(&|$)/, 'time 对应 B 站 sort=0');
    // 默认 hot → sort=1；同一 client 的 aid 缓存命中，不再重复拉 view
    const hot = await getRoute(h, '/comments', { bvid: BVID, page: '1' });
    assert.equal(hot.body.ok, true);
    const hotCall = f.calls.filter((c) => c.url.includes('/x/v2/reply')).at(-1);
    assert.match(hotCall!.url, /[?&]sort=1(&|$)/, 'hot 对应 B 站 sort=1');
  } finally {
    f.restore();
  }
});

// ---------------- 5. REST /video 与字幕 ----------------

test('REST /video：详情字段 + 字幕可用；工具能拿到字幕全文', async () => {
  const h = makeHarness();
  const f = installFetch(biliRoutes());
  try {
    const res = await getRoute(h, '/video', { bvid: BVID });
    assert.deepEqual(res.body, {
      ok: true,
      video: {
        bvid: BVID,
        title: '测试视频 & 标题',
        desc: '这是简介\n第二行',
        author: '测试UP',
        duration: 312,
        view: 1234567,
        like: 6789,
        coin: 456,
        favorite: 3456,
        share: 78,
        subtitleAvailable: true,
      },
    });
    const subCall = f.calls.find((c) => c.url.includes('aisubtitle.hdslb.com'));
    assert.ok(subCall, '应当下载字幕文件');
    assert.match(subCall!.url, /zh\.json/, '优先取 ai-zh，而不是列表第一份英文');

    const text = await h.tools.get('bili_video').handler({ url_or_bvid: BVID });
    assert.match(text, /【测试视频 & 标题】/);
    assert.match(text, /字幕（中文（AI生成））/);
    assert.match(text, /第一句\n第二句/);
  } finally {
    f.restore();
  }
});

// ---------------- 6. b23.tv 短链 ----------------

test('b23 短链：跟随 302 解析出 bvid 并取视频详情', async () => {
  const h = makeHarness();
  const f = installFetch(biliRoutes());
  try {
    const text = await h.tools.get('bili_video').handler({ url_or_bvid: 'https://b23.tv/abc' });
    assert.match(text, /【测试视频 & 标题】/);
    assert.equal(f.calls[0].url, 'https://b23.tv/abc');
    assert.ok(f.calls[1].url.includes(`/x/web-interface/view?bvid=${BVID}`), '跳转后应按 BV 号查详情');
  } finally {
    f.restore();
  }
});

test('链接边界：非 bilibili/b23 的 URL 不发起请求', async () => {
  const h = makeHarness();
  const f = installFetch(() => { throw new Error('不该发出请求'); });
  try {
    const text = await h.tools.get('bili_video').handler({ url_or_bvid: 'https://example.com/video/xxx' });
    assert.match(text, /只支持 bilibili\.com 或 b23\.tv/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

// ---------------- 7. requestDelayMs 限速 ----------------

test('requestDelayMs：相邻 B 站请求之间真的等够间隔', async () => {
  const delay = 80;
  const h = makeHarness({ requestDelayMs: delay, searchLimit: 2 });
  const f = installFetch(biliRoutes());
  try {
    const tool = h.tools.get('bili_search');
    await tool.handler({ keyword: '甲' });
    await tool.handler({ keyword: '乙' });
    assert.ok(f.calls.length >= 3, `应有 nav + 两次搜索，实际 ${f.calls.length} 次`);
    for (let i = 1; i < f.calls.length; i++) {
      const gap = f.calls[i].at - f.calls[i - 1].at;
      assert.ok(gap >= delay - 15, `第 ${i} 次与上一次间隔 ${gap}ms，小于配置的 ${delay}ms`);
    }
  } finally {
    f.restore();
  }
});

// ---------------- 8. 风控错误 ----------------

test('风控错误：返回中文结构化错误，不抛栈', async () => {
  const h = makeHarness();
  const f = installFetch((url) => {
    if (url.includes('/x/web-interface/nav')) return jsonResp(NAV);
    return jsonResp({ code: -412, message: '请求被拦截' });
  });
  try {
    const text = await h.tools.get('bili_search').handler({ keyword: '测试' });
    assert.match(text, /B站风控拦截/);
    assert.match(text, /-412/);
    assert.match(text, /requestDelayMs/);
  } finally {
    f.restore();
  }
});

// ---------------- 9. beforeLLM 指引 ----------------

test('beforeLLM：仅当本轮有 B 站链接且 work_dispatch 可用时注入派活指引', () => {
  const h = makeHarness();
  const base = () => ({
    chat: { platform: 'qq', type: 'group', chatId: '1' },
    event: { text: '', role: 'admin' },
    system: '',
    messages: [],
    tools: [{ name: 'work_dispatch' }],
    batch: [{ text: '看这个 https://www.bilibili.com/video/BV1xx411c7mD' }],
  });
  const hit = h.hooks.beforeLLM(base());
  assert.equal(hit.systemSections?.length, 1);
  assert.match(hit.systemSections![0].text, /work_dispatch/);
  assert.match(hit.systemSections![0].text, /bili_video/);
  assert.match(hit.systemSections![0].text, /bili_comments/);

  assert.equal(h.hooks.beforeLLM({ ...base(), batch: [{ text: '今天天气不错' }] }).systemSections, undefined);
  assert.equal(h.hooks.beforeLLM({ ...base(), tools: [] }).systemSections, undefined);
  assert.equal(h.hooks.beforeLLM({ ...base(), event: { text: '', role: 'member' } }).systemSections, undefined);
});
