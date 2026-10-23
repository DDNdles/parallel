import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ChatEvent, ChatRef, LLMRequestContext, PluginContext, PluginHttpHandler, PluginHttpRequest,
  PluginHttpResponse,
} from '../../kernel/types.ts';

// ============================================================
// sticker —— bot 的表情包库（2026-10-24 重写）
//
//  - 全 bot 一份库：图片平铺在 <data>/stickers/，索引与计数进 plugin_kv；
//    旧版按 <chatKey>/ 存的图不迁移、不删除、不读取（那边是 v1，键与目录都换了位置）；
//  - id = 图片内容的 sha256 前 16 位：同一张图换个文件名再发也不会收重；
//  - 键全部带 v2: 前缀，防与旧版撞名；
//  - 工具只走 chat 面：send_sticker 按描述/标签挑一张发，steal_sticker 把这条消息里的图收下；
//  - 自动收图默认关（autoSteal）：开了也只收群聊、跳过 bot 自己、每群每天有硬上限；
//  - 桌面端「表情包」页走本插件的 REST 端点（列表/看图/改描述/删除/上传）。
// ============================================================

const LIB_KEY = 'v2:library';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DESC = 80;
const MAX_TAGS = 8;
const TAG_MAX = 12;

interface StickerSource { userId: string; nickname: string }

interface Sticker {
  id: string;
  /** 图片文件名（平铺在 storeDir 下，不含目录） */
  file: string;
  desc: string;
  tags: string[];
  count: number;
  lastUsed: number;
  addedAt: number;
  source?: StickerSource;
}

interface ImageKind { mime: string; ext: string }

type AddResult =
  | { ok: true; id: string; sticker: Sticker; duplicate: boolean }
  | { ok: false; error: string; status: number };

/** 只看文件头：插件没有 mime 探测依赖，收到什么字节就按魔数认 */
function sniffImage(buf: Buffer): ImageKind | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buf.length >= 2 && buf.toString('ascii', 0, 2) === 'BM') {
    return { mime: 'image/bmp', ext: 'bmp' };
  }
  return undefined;
}

function mimeOfFile(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 标签：接受数组或「逗号/顿号/空格」分隔的字符串，去重、限量 */
function cleanTags(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === 'string' ? v.split(/[,，、;；\s]+/) : [];
  const out: string[] = [];
  for (const x of raw) {
    const t = cleanText(x, TAG_MAX).replace(/^#+/, '');
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 中文不分词：用最长公共子串让「笑得打滚」也命中「笑」 */
function commonLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const saved = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) best = prev[j];
      } else {
        prev[j] = 0;
      }
      diag = saved;
    }
  }
  return best;
}

/** 关键词打分：描述 > 标签 > 片段重合；id 可直接点名 */
function scoreOf(s: Sticker, q: string): number {
  const query = q.toLowerCase();
  if (!query) return 0;
  if (s.id === query || `#${s.id}` === query) return 1000;
  let score = 0;
  const desc = s.desc.toLowerCase();
  if (desc) {
    if (desc === query) score += 40;
    else if (desc.includes(query)) score += 20;
    else if (query.includes(desc)) score += 16;
    else {
      const common = commonLen(query, desc);
      if (common >= 2) score += Math.min(common, 6) * 3;
    }
  }
  for (const tag of s.tags) {
    const t = tag.toLowerCase();
    if (t === query) score += 24;
    else if (t.includes(query)) score += 12;
    else if (query.includes(t)) score += 10;
    else {
      const common = commonLen(query, t);
      if (common >= 1) score += Math.min(common, 4) * 2;
    }
  }
  return score;
}

/** 命中里挑分数最高的；同分优先用得少的（轮换），再优先久没用的 */
function pickSticker(list: Sticker[], query: string): Sticker | undefined {
  let best: Sticker | undefined;
  let bestScore = 0;
  for (const s of list) {
    const score = scoreOf(s, query);
    if (score <= 0) continue;
    if (!best || score > bestScore) {
      best = s;
      bestScore = score;
      continue;
    }
    if (score === bestScore
      && (s.count < best.count || (s.count === best.count && (s.lastUsed || 0) < (best.lastUsed || 0)))) {
      best = s;
    }
  }
  return best;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 请求体里的图片字节：原始 Buffer/Uint8Array 优先，也接受 JSON 里的 base64（真实 HTTP 的 JSON 分支） */
function bytesOf(body: unknown): Buffer | undefined {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  const decode = (s: string): Buffer | undefined => {
    const b64 = s.replace(/^data:[^,]*,/, '').trim();
    if (!b64) return undefined;
    const buf = Buffer.from(b64, 'base64');
    return buf.length ? buf : undefined;
  };
  if (typeof body === 'string') return decode(body);
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const v of [o.data, o.base64, o.image]) {
      if (typeof v === 'string') {
        const buf = decode(v);
        if (buf) return buf;
      }
    }
  }
  return undefined;
}

export function setup(ctx: PluginContext): void {
  // 规格钉死图片放 <data>/stickers/；pluginDataDir 是 <data>/plugin-data/sticker，向上两级就是内核 data 根。
  const storeDir = join(ctx.pluginDataDir, '..', '..', 'stickers');
  mkdirSync(storeDir, { recursive: true });

  // ---------- userConfig（惰性读取：改完配置重载插件即生效） ----------

  const cfgNum = (key: string, def: number, min: number, max: number): number => {
    const n = Number((ctx.userConfig as Record<string, unknown>)[key]);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const cfgBool = (key: string, def: boolean): boolean => {
    const v = (ctx.userConfig as Record<string, unknown>)[key];
    return typeof v === 'boolean' ? v : def;
  };

  // ---------- 库 ----------

  function loadLibrary(): Sticker[] {
    const raw = ctx.state.get<unknown>(LIB_KEY, []);
    if (!Array.isArray(raw)) return [];
    const out: Sticker[] = [];
    for (const x of raw) {
      if (!x || typeof x !== 'object') continue;
      const r = x as Partial<Sticker>;
      if (typeof r.id !== 'string' || !r.id) continue;
      if (typeof r.file !== 'string' || !r.file) continue;
      out.push({
        id: r.id,
        file: basename(r.file),
        desc: cleanText(r.desc, MAX_DESC),
        tags: cleanTags(r.tags),
        count: Number.isFinite(r.count) ? Math.max(0, Math.trunc(Number(r.count))) : 0,
        lastUsed: Number(r.lastUsed) || 0,
        addedAt: Number(r.addedAt) || 0,
        ...(r.source && typeof r.source === 'object'
          ? { source: { userId: String(r.source.userId ?? ''), nickname: String(r.source.nickname ?? '') } }
          : {}),
      });
    }
    return out;
  }

  function saveLibrary(list: Sticker[]): void {
    ctx.state.set(LIB_KEY, list);
  }

  function viewOf(s: Sticker): Record<string, unknown> {
    return {
      id: s.id, desc: s.desc, tags: s.tags, count: s.count,
      lastUsed: s.lastUsed, addedAt: s.addedAt, source: s.source,
    };
  }

  /** 收一张图：内容 hash 去重、只认图片、单张 2MB、库满拒收 */
  function addBytes(buf: Buffer, meta: { desc?: string; tags?: string[]; source?: StickerSource }): AddResult {
    if (!buf.length) return { ok: false, error: '没有收到图片数据', status: 400 };
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片超过 2MB（${Math.round(buf.length / 1024)}KB），不收`, status: 413 };
    }
    const kind = sniffImage(buf);
    if (!kind) return { ok: false, error: '只收图片（png/jpg/gif/webp/bmp）', status: 415 };

    const id = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const list = loadLibrary();
    const existing = list.find((s) => s.id === id);
    if (existing) return { ok: true, id, sticker: existing, duplicate: true };

    const maxLibrary = cfgNum('maxLibrary', 500, 1, 5000);
    if (list.length >= maxLibrary) {
      return { ok: false, error: `表情包库满了（上限 ${maxLibrary} 张），先删几张再收`, status: 409 };
    }

    const file = `${id}.${kind.ext}`;
    writeFileSync(join(storeDir, file), buf);
    const sticker: Sticker = {
      id, file,
      desc: cleanText(meta.desc, MAX_DESC),
      tags: cleanTags(meta.tags),
      count: 0,
      lastUsed: 0,
      addedAt: Date.now(),
      ...(meta.source ? { source: { ...meta.source } } : {}),
    };
    list.push(sticker);
    saveLibrary(list);
    return { ok: true, id, sticker, duplicate: false };
  }

  function addFromPath(abs: string, meta: { desc?: string; tags?: string[]; source?: StickerSource }): AddResult {
    try {
      const st = statSync(abs);
      if (!st.isFile()) return { ok: false, error: '不是文件', status: 400 };
      if (st.size > MAX_IMAGE_BYTES) {
        return { ok: false, error: `超过 2MB（${Math.round(st.size / 1024)}KB），不收`, status: 413 };
      }
      return addBytes(readFileSync(abs), meta);
    } catch {
      return { ok: false, error: '图片文件读不到', status: 400 };
    }
  }

  // ---------- 收图来源 ----------

  const chatKeyOf = (chat: ChatRef): string => `${chat.type}_${chat.chatId}`;

  /** 这条消息里可收的图：消息内 files、引用消息的文件、段里带本地路径的图（远端 URL 不在这里下） */
  function imagePathsOf(event: ChatEvent, chat: ChatRef): { path: string; name: string; source: StickerSource }[] {
    const out: { path: string; name: string; source: StickerSource }[] = [];
    const self: StickerSource = { userId: event.userId, nickname: event.nickname };
    const push = (path: string, name: string, source: StickerSource): void => {
      if (path && !out.some((x) => x.path === path)) out.push({ path, name, source });
    };
    for (const f of event.files ?? []) {
      const path = f.sandboxPath || (f.rel ? join(ctx.sandbox.root(chat), f.rel) : '');
      push(path, f.name, self);
    }
    for (const f of event.replyTo?.files ?? []) {
      if (!f.rel) continue;
      // 引用快照只带沙箱相对路径；fs.sandbox 权限就是为这一处要的
      const source = { userId: event.replyTo?.userId ?? '', nickname: event.replyTo?.nickname ?? '' };
      try { push(join(ctx.sandbox.root(chat), f.rel), f.name, source); } catch { /* 沙箱不可用就跳过 */ }
    }
    for (const seg of event.segments ?? []) {
      if (seg.type !== 'image') continue;
      const f = String(seg.data?.file ?? seg.data?.path ?? '');
      if (f && !/^https?:/i.test(f) && existsSync(f)) push(f, basename(f), self);
    }
    return out;
  }

  /** 描述优先用这条消息的文字（常是对图的吐槽），没有就按来源昵称 */
  function descFor(event: ChatEvent, source: StickerSource): string {
    const text = cleanText(String(event.text ?? '').replace(/\[[^\]]*\]/g, ' '), 40);
    return text || `来自${source.nickname || source.userId || '群友'}的图`;
  }

  /** bot 自己的消息不自动收：协议端回包的 self_id 与登录号都对一遍 */
  function isSelfEvent(event: ChatEvent): boolean {
    const raw = (event.raw ?? {}) as Record<string, unknown>;
    const ui = ((ctx.config as Record<string, unknown>).ui ?? {}) as { lastLogin?: { qq?: string } };
    const ids = [String(raw.self_id ?? ''), String(ui.lastLogin?.qq ?? '')].filter(Boolean);
    return ids.includes(String(event.userId));
  }

  // ---------- 每日自动收图计数（每群一个，跨天自动归零） ----------

  const dailyKeyOf = (chatKey: string): string => `v2:daily:${chatKey}`;

  function dailyUsed(chatKey: string): { day: string; n: number } {
    const v = ctx.state.get<{ day?: string; n?: number }>(dailyKeyOf(chatKey), {});
    const n = typeof v?.n === 'number' && v.n > 0 ? Math.trunc(v.n) : 0;
    return { day: v?.day === today() ? v.day : today(), n: v?.day === today() ? n : 0 };
  }

  function setDaily(chatKey: string, used: { day: string; n: number }): void {
    ctx.state.set(dailyKeyOf(chatKey), used);
  }

  // ---------- 发送冷却（进程内存；重启只是少一层护栏，不影响正确性） ----------

  const lastSent = new Map<string, number>();

  // ---------- LLM 工具 ----------

  ctx.llm.registerTool({
    name: 'send_sticker',
    description: '从表情包库里挑一张最合适的图发出去。query 填描述或标签里的词（如「笑」「无语」「猫」）；是接话的一部分，不是每句都要配图。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想发的表情：描述或标签关键词，也可以填清单里的 id' },
      },
      required: ['query'],
    },
    surface: 'chat',
    promptSnippet: '从表情包库发一张图（接话用，别刷屏）',
    promptGuidelines: [
      '看情况发：气氛到位、图对得上才发一张；别每句都配图，别连着发同一类。',
      'query 用描述或标签里的词；库里没有对得上的就正常说话，不要硬发。',
      '发送冷却由程序管；被拒（冷却中/没匹配）就照常接话，不要向对方解释工具调用。',
    ],
    handler: async (args, tctx) => {
      const query = cleanText(args.query, 60);
      if (!query) return '（query 是空的；想发图就把描述或标签里的词填进来，不想发就正常说话。）';

      const cooldown = cfgNum('sendCooldownSec', 60, 0, 3600);
      const key = chatKeyOf(tctx.chat);
      const now = Date.now();
      const last = lastSent.get(key) ?? 0;
      if (cooldown > 0 && last && now - last < cooldown * 1000) {
        const wait = Math.ceil((cooldown * 1000 - (now - last)) / 1000);
        return `（刚发过表情，冷却还剩 ${wait} 秒；这次别发，正常接话。）`;
      }

      const list = loadLibrary();
      if (!list.length) return '（表情包库还是空的；这次别发图，用文字接话。）';
      const item = pickSticker(list, query);
      if (!item) return `（表情库里没有和「${query}」对得上的图；别硬发，用文字接话。）`;

      const abs = join(storeDir, basename(item.file));
      if (!existsSync(abs)) {
        return `（「${item.desc || item.id}」的图片文件不见了，这次别发；可以提醒主人清理一下表情包库。）`;
      }
      try {
        await ctx.chat.send(tctx.chat, [{ type: 'image', data: { file: abs } }]);
      } catch (e) {
        return `（没发出去：${(e as Error).message}。不要向对方提这个错误，用文字接话。）`;
      }
      item.count += 1;
      item.lastUsed = Date.now();
      saveLibrary(list);
      if (cooldown > 0) lastSent.set(key, Date.now());
      return `（已发了一张「${item.desc || item.tags[0] || item.id}」的表情。这一轮不用再发，正常把话说完。）`;
    },
  });

  ctx.llm.registerTool({
    name: 'steal_sticker',
    description: '把这条消息里的图片（含被引用消息里的图）收进表情包库。对方发了图、或说「收下这个表情」时用。',
    parameters: { type: 'object', properties: {} },
    surface: 'chat',
    promptSnippet: '收下消息里的图进表情包库',
    promptGuidelines: [
      '只在对方发了图、或明确让你收下时用；消息里没有图就直说没有，不要编。',
      '收下的图默认用消息原文当描述；不合适就提醒主人到桌面端改描述与标签，别自己乱猜内容。',
    ],
    handler: (_args, tctx) => {
      const images = imagePathsOf(tctx.event, tctx.chat);
      if (!images.length) return '（这条消息里没有图片可收。让对方再发一张，或者引用那张图再试。）';

      const nick = tctx.event.nickname || tctx.event.userId || '对方';
      const notes: string[] = [];
      let added = 0;
      for (const img of images) {
        const source = img.source;
        const from = source.nickname || source.userId || nick;
        const r = addFromPath(img.path, { desc: descFor(tctx.event, source), source });
        if (!r.ok) {
          notes.push(`没收成：${r.error}`);
        } else if (r.duplicate) {
          notes.push('这张图已经在库里了');
        } else {
          added += 1;
          notes.push(`已收下${from}的图（${r.sticker.desc}）`);
        }
      }
      if (added) notes.push(`库里现在有 ${loadLibrary().length} 张。`);
      return notes.join('\n');
    },
  });

  // ---------- 钩子 ----------

  ctx.hooks.onChatMessage = (event: ChatEvent): void => {
    if (!cfgBool('autoSteal', false)) return;
    // 只收群里的图：私聊图片不替用户做主
    if (event.type !== 'group') return;
    if (isSelfEvent(event)) return;

    const cap = cfgNum('stealDailyCap', 50, 0, 1000);
    if (cap <= 0) return;

    const chat: ChatRef = { platform: event.platform, type: event.type, chatId: event.chatId };
    const used = dailyUsed(chatKeyOf(chat));
    if (used.n >= cap) return;

    let n = used.n;
    for (const img of imagePathsOf(event, chat)) {
      if (n >= cap) break;
      const r = addFromPath(img.path, { desc: descFor(event, img.source), source: img.source });
      // 重复（同一张图再发一次）不占每日额度
      if (r.ok && !r.duplicate) n += 1;
    }
    if (n !== used.n) setDaily(chatKeyOf(chat), { day: used.day, n });
  };

  // 库清单注入 chat 轮的提示词：给模型「有什么图」的地图，分寸另说一句。
  // 空库、或这一轮根本没有 send_sticker（比如 work 轮/插件被停用）都不注入。
  ctx.hooks.beforeLLM = (req: LLMRequestContext): LLMRequestContext => {
    if (!req.tools?.some((t) => t.name === 'send_sticker')) return req;
    const list = loadLibrary();
    if (!list.length) return req;
    const max = cfgNum('promptListMax', 40, 0, 200);
    if (max <= 0) return req;

    const shown = [...list]
      .sort((a, b) => b.count - a.count || b.addedAt - a.addedAt)
      .slice(0, max);
    const lines = shown.map((s) => {
      const tags = s.tags.length ? `［${s.tags.join('/')}］` : '';
      return `- ${s.id}｜${s.desc || '（没写描述）'}${tags}`;
    });
    const sections = (req.systemSections ??= []);
    sections.push({
      order: 455,
      name: 'sticker',
      title: 'sticker',
      text: [
        '表情包库（要发图时调用 send_sticker，query 填描述或标签里的词）：',
        ...lines,
        list.length > shown.length ? `（共 ${list.length} 张，这里只列常用的 ${shown.length} 张）` : '',
        '分寸：看情况发——气氛合适、图对得上才发一张，别刷屏、别每句都配图；冷却时间由程序管，被拒就照常接话，不要向对方解释这个工具。',
      ].filter(Boolean).join('\n'),
    });
    return req;
  };

  // ---------- REST：/api/plugin/sticker/... ----------

  const json = (body: unknown, status = 200): PluginHttpResponse => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  });
  const fail = (status: number, error: string): PluginHttpResponse => json({ ok: false, error }, status);

  /** handler 抛错也要回统一错误体（内核那边会包成 500 纯文本，桌面端读不出原因） */
  const serve = (fn: (req: PluginHttpRequest) => PluginHttpResponse | Promise<PluginHttpResponse>): PluginHttpHandler =>
    async (req) => {
      try {
        return await fn(req);
      } catch (e) {
        ctx.log.warn(`表情包端点 ${req.method} ${req.path} 出错: ${(e as Error).message}`);
        return fail(500, `表情包库操作失败：${(e as Error).message}`);
      }
    };

  ctx.http.on('GET', '/library', serve(() => {
    const stickers = loadLibrary()
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((s) => viewOf(s));
    return json({ ok: true, stickers });
  }));

  ctx.http.on('GET', '/image', serve((req) => {
    const id = String(req.query.id ?? '').trim();
    if (!id) return fail(400, '缺少 id');
    const item = loadLibrary().find((s) => s.id === id);
    if (!item) return fail(404, '没有这张表情');
    const abs = join(storeDir, basename(item.file));
    if (!existsSync(abs)) return fail(404, '图片文件不见了');
    return {
      status: 200,
      headers: {
        'content-type': mimeOfFile(item.file),
        // 内容寻址：同一 id 的字节永不变化，可以放心长缓存
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: readFileSync(abs),
    };
  }));

  ctx.http.on('POST', '/desc', serve((req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    if (!id) return fail(400, '缺少 id');
    if (!('desc' in body) && !('tags' in body)) return fail(400, '没有要改的内容（desc/tags）');
    const list = loadLibrary();
    const item = list.find((s) => s.id === id);
    if (!item) return fail(404, '没有这张表情');
    if ('desc' in body) {
      if (typeof body.desc !== 'string') return fail(400, 'desc 需要是字符串');
      item.desc = cleanText(body.desc, MAX_DESC);
    }
    if ('tags' in body) {
      if (!Array.isArray(body.tags) && typeof body.tags !== 'string') return fail(400, 'tags 需要是数组或逗号分隔的字符串');
      item.tags = cleanTags(body.tags);
    }
    saveLibrary(list);
    return json({ ok: true, sticker: viewOf(item) });
  }));

  ctx.http.on('POST', '/delete', serve((req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    if (!id) return fail(400, '缺少 id');
    const list = loadLibrary();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return fail(404, '没有这张表情');
    const [item] = list.splice(idx, 1);
    saveLibrary(list);
    try { unlinkSync(join(storeDir, basename(item.file))); } catch { /* 文件已不在就算了，记录才是真身 */ }
    return json({ ok: true, id });
  }));

  ctx.http.on('POST', '/upload', serve((req) => {
    const name = cleanText(req.query.name, 80);
    const buf = bytesOf(req.body);
    if (!buf || !buf.length) {
      return fail(400, '没收到图片字节：请用原始字节 POST（content-type 非 JSON），或传 {"data":"<base64>"}');
    }
    // 文件名当初始描述：上传「狂笑.png」就能用「狂笑」匹配到
    const desc = name ? cleanText(basename(name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), MAX_DESC) : '';
    const r = addBytes(buf, { desc });
    if (!r.ok) return fail(r.status, r.error);
    return json({ ok: true, id: r.id, ...(r.duplicate ? { duplicate: true } : {}) });
  }));

  ctx.log.info(`表情包库就绪：${loadLibrary().length} 张（${storeDir}）`);
}
