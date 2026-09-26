/**
 * 浏览器沙箱桥（容器内常驻）。
 *
 * 与 Python 沙箱对称：容器内 loopback HTTP 服务 + 宿主机经 docker exec 驱动。
 * 差别在于本容器**有网络**（浏览网页是它的职责），因此渲染出的页面内容会被
 * 当作不可信输入回传——工具描述里要明确这一点。
 *
 * 持有长期存活的 Chromium 与 page 上下文：登录态、Cookie、当前页面在多次调用间保留。
 */
import http from 'node:http';
import { chromium } from 'playwright';

const PORT = Number(process.env.BRIDGE_PORT || 8900);
const IDLE_EXIT_MS = Number(process.env.BRIDGE_IDLE_EXIT_SEC || 600) * 1000;
const MAX_TEXT = 12000;      // 页面正文/快照回传上限
const NAV_TIMEOUT = 30000;

let browser = null;
let context = null;
let page = null;
let lastUse = Date.now();
let actions = 0;

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
  }
  if (!context) {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    });
  }
  page = await context.newPage();
  return page;
}

function trim(s, n = MAX_TEXT) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '\n…(截断)' : t;
}

/** 收集页面上的可交互元素，供模型决定点击目标（对齐 Kimi browser 的索引式元素列表） */
async function collectElements(p) {
  return p.evaluate(() => {
    const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick]';
    const els = Array.from(document.querySelectorAll(sel)).slice(0, 60);
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || el.href || '').trim().slice(0, 60);
      return { i, tag: el.tagName.toLowerCase(), label, visible, kind: el.type || '' };
    }).filter((e) => e.visible && e.label);
  });
}

async function snapshot(p) {
  const title = await p.title().catch(() => '');
  const url = p.url();
  const text = await p.evaluate(() => {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (clone) clone.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());
    return clone ? clone.innerText : '';
  }).catch(() => '');
  const elements = await collectElements(p).catch(() => []);
  return {
    url,
    title,
    text: trim(text),
    elements,
    elementsText: elements.map((e) => `[${e.i}] <${e.tag}${e.kind ? ' ' + e.kind : ''}> ${e.label}`).join('\n'),
  };
}

const ACTIONS = {
  async goto(p, args) {
    if (!args.url) throw new Error('goto 需要 url');
    const resp = await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await p.waitForTimeout(600); // 给 SPA 一点渲染时间
    const s = await snapshot(p);
    return { status: resp ? resp.status() : null, ...s };
  },
  async snapshot(p) {
    return await snapshot(p);
  },
  /** 按元素索引点击（索引来自上一次 snapshot 的 elementsText） */
  async click(p, args) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx)) throw new Error('click 需要 index（来自 snapshot 的元素编号）');
    const handle = await p.evaluateHandle((i) => {
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick]';
      const els = Array.from(document.querySelectorAll(sel));
      return els[i] || null;
    }, idx);
    const el = handle.asElement();
    if (!el) throw new Error(`找不到元素 [${idx}]（页面可能已变化，请先 snapshot）`);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 10000 });
    await p.waitForTimeout(800);
    return await snapshot(p);
  },
  /** 选择器点击（索引不好使时的兜底） */
  async click_selector(p, args) {
    if (!args.selector) throw new Error('click_selector 需要 selector');
    await p.click(args.selector, { timeout: 10000 });
    await p.waitForTimeout(800);
    return await snapshot(p);
  },
  async type(p, args) {
    const text = String(args.text ?? '');
    if (args.index !== undefined) {
      const handle = await p.evaluateHandle((i) => {
        const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick]';
        return Array.from(document.querySelectorAll(sel))[i] || null;
      }, Number(args.index));
      const el = handle.asElement();
      if (!el) throw new Error(`找不到元素 [${args.index}]`);
      await el.fill(text, { timeout: 10000 });
    } else if (args.selector) {
      await p.fill(args.selector, text, { timeout: 10000 });
    } else {
      await p.keyboard.type(text);
    }
    if (args.enter) await p.keyboard.press('Enter');
    await p.waitForTimeout(600);
    return await snapshot(p);
  },
  async press(p, args) {
    await p.keyboard.press(String(args.key || 'Enter'));
    await p.waitForTimeout(600);
    return await snapshot(p);
  },
  async screenshot(p) {
    const buf = await p.screenshot({ fullPage: !!arguments[1]?.fullPage, type: 'png' });
    return { image: buf.toString('base64'), url: p.url() };
  },
  async scroll(p, args) {
    const dy = Number(args.dy ?? 600);
    await p.mouse.wheel(0, dy);
    await p.waitForTimeout(500);
    return await snapshot(p);
  },
  async back(p) {
    await p.goBack({ timeout: NAV_TIMEOUT }).catch(() => {});
    await p.waitForTimeout(600);
    return await snapshot(p);
  },
  async links(p) {
    const links = await p.evaluate(() => Array.from(document.querySelectorAll('a[href]')).slice(0, 50)
      .map((a) => ({ text: (a.innerText || '').trim().slice(0, 60), href: a.href }))
      .filter((l) => l.text));
    return { links, url: p.url() };
  },
};

function renderResult(r) {
  if (r.image) return { text: `（截图已保存）`, image: r.image, url: r.url };
  const parts = [];
  if (r.url) parts.push(`URL: ${r.url}`);
  if (r.title) parts.push(`标题: ${r.title}`);
  if (r.status !== undefined && r.status !== null) parts.push(`HTTP: ${r.status}`);
  if (r.elementsText) parts.push(`可交互元素:\n${r.elementsText}`);
  if (r.links) parts.push(`链接:\n${r.links.map((l) => `${l.text} -> ${l.href}`).join('\n')}`);
  if (r.text) parts.push(`正文:\n${r.text}`);
  return { text: trim(parts.join('\n\n'), MAX_TEXT + 4000) };
}

const server = http.createServer((req, res) => {
  lastUse = Date.now();
  const send = (obj, code = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send({ ok: true, browser: !!browser?.isConnected(), page: page?.url() ?? '', actions });
  }
  if (req.method !== 'POST') return send({ error: 'not found' }, 404);
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { return send({ error: 'bad json' }, 400); }
    const action = String(payload.action || '');
    const fn = ACTIONS[action];
    if (!fn) return send({ error: `未知动作 ${action}；可用: ${Object.keys(ACTIONS).join(', ')}` }, 400);
    try {
      const p = await ensurePage();
      const r = await fn(p, payload.args || {}, payload.args || {});
      actions++;
      return send({ ok: true, ...renderResult(r) });
    } catch (e) {
      return send({ ok: false, error: String(e.message || e) }, 200);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ bridge: 'ready', kind: 'browser', port: PORT }));
});

setInterval(() => {
  if (Date.now() - lastUse > IDLE_EXIT_MS) process.exit(0);
}, 30000).unref();