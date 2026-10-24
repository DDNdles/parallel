import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ChatRef, PluginContext, Role, ToolResult } from '../../kernel/types.ts';
import { newId } from '../../kernel/util/misc.ts';

// ============================================================
// imagegen —— 用户自己的 Gemini API Key 生图
//
//  - 文生图：prompt → gemini-3-pro-image:generateContent
//  - 参考图：把会话沙箱里的本地图片读成 base64，放进 inline_data
//  - 产物：写进当前会话沙箱 imagegen/，扩展名按返回字节的真实格式（PNG/JPEG/WebP）
//  - 额度：普通成员每个自然周（周一起算）N 张；主人/管理员默认不限
//  - 失败不计数：先占额度，API/写盘失败再退回去
//  - REST：/api/plugin/imagegen/{gallery,image,usage,generate}（桌面端「生图」页）
// ============================================================

/** 单张参考图的体积上限（base64 之后还要再涨 1/3，太大只会白白超时） */
const REF_MAX_BYTES = 8 * 1024 * 1024;
/** 参考图张数上限：够表达"这张脸/这个构图"就行，再多模型也吃不下 */
const REF_MAX_COUNT = 4;
/** prompt 长度上限（防一次调用把请求体撑爆） */
const PROMPT_MAX_CHARS = 4000;
/** 画廊保留条数：只留最近的，state 不随使用无限增长 */
const GALLERY_MAX = 100;
const GALLERY_KEY = 'gallery';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GalleryImage {
  id: string;
  /** 会话沙箱内相对路径（如 imagegen/img_xxx.png） */
  file: string;
  prompt: string;
  model: string;
  userId: string;
  chatId: string;
  ts: number;
  /** 落盘时嗅探出的真实格式（Gemini 可能回 JPEG/WebP 而不是 PNG）；旧记录缺失时回退嗅探 */
  mime?: string;
  /**
   * 内部定位信息：REST /image 要按「当时那个会话的沙箱」把文件读出来。
   * /gallery 不返回这一项（对外字段与接口约定一致）。
   */
  chatRef?: ChatRef;
}

type GenResult =
  | { ok: true; id: string; path: string; size: number }
  | { ok: false; error: string; code: 'config' | 'quota' | 'input' | 'api' | 'storage' };

/**
 * 自然周键（周一起算）：`yyyy-Www`（ISO 周）。
 * 以本周四所在的年份为准——跨年那几天（12/29 属于次年 W01）才不会算错。
 */
export function weekKeyOf(ts = Date.now()): string {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7;                 // 周一=0 … 周日=6
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(year, 0, 4 - jan4Day);
  // 本地时区可能有夏令时，按天数取整而不是整除小时
  const week = Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 下一个周一零点（额度重置时刻） */
function nextWeekStart(ts = Date.now()): Date {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 7);
}

/** 按文件头识别图片类型（不认扩展名：QQ 收来的图常被改名） */
function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return undefined;
}

/** 落盘文件名：只留最后一段、去掉非法字符，扩展名跟真实格式走（Gemini 可能回 JPEG/WebP） */
function safeFilename(raw: string, id: string, mime: string): string {
  const last = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  let name = last
    .replace(/[\\/:*?"<>|\x00-\x1f\s]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/\.[^.]{1,8}$/, '')
    .slice(0, 80)
    .trim();
  if (!name) name = id;
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
  return `${name}.${ext}`;
}

/** Gemini 的 HTTP 错误 → 一句能给普通用户看的中文（不泄露内部路径/代码） */
function geminiHttpError(status: number, raw: string): string {
  let msg = '';
  try { msg = String((JSON.parse(raw) as any)?.error?.message ?? ''); } catch { msg = raw; }
  const brief = msg.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 400 && /safety|block|policy|prohibited/i.test(msg)) {
    return '生图失败：描述或参考图被 Gemini 的安全策略拦截了，换个说法或换张参考图再试。';
  }
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key|credential|permission|unauth/i.test(msg))) {
    return '生图失败：Gemini API Key 无效，或这个 Key 没有该模型的权限。请到桌面端「插件 → 生图」里检查 Key。';
  }
  if (status === 404) {
    return '生图失败：这个生图模型不存在或当前 Key 用不了它（HTTP 404），请到插件设置里核对模型名。';
  }
  if (status === 429) {
    return '生图失败：Gemini 说额度或调用频率受限（HTTP 429），过一会儿再试。';
  }
  if (status >= 500) {
    return `生图失败：Gemini 服务暂时不可用（HTTP ${status}），稍后再试。`;
  }
  return `生图失败：Gemini 返回 HTTP ${status}${brief ? `（${brief}）` : ''}。`;
}

export function setup(ctx: PluginContext): void {
  const cfg = () => {
    const quota = Number(ctx.userConfig.weeklyQuota);
    return {
      apiKey: String(ctx.userConfig.apiKey ?? '').trim(),
      // 允许用户把模型写成 models/gemini-...（照抄文档时很常见），拼 URL 前去掉前缀
      model: String(ctx.userConfig.model ?? '').trim().replace(/^models\//, '') || 'gemini-3-pro-image',
      // 留空走官方地址；直连不通的环境（典型：国内）可填本地网关/代理，如 http://127.0.0.1:8045
      baseUrl: String(ctx.userConfig.baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com',
      weeklyQuota: Number.isFinite(quota) && quota >= 0 ? Math.floor(quota) : 3,
      ownerUnlimited: ctx.userConfig.ownerUnlimited !== false,
    };
  };

  // ---------- 额度（按自然周 + 用户计数，存在 ctx.state） ----------

  const usageKey = (week: string) => `usage:${week}`;

  function usageOf(week: string): Record<string, number> {
    const v = ctx.state.get<Record<string, number>>(usageKey(week), {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function usedOf(week: string, userId: string): number {
    return Math.max(0, Math.floor(Number(usageOf(week)[userId]) || 0));
  }

  function bumpUsage(week: string, userId: string, delta: number): void {
    const map = usageOf(week);
    map[userId] = Math.max(0, Math.floor(Number(map[userId]) || 0) + delta);
    ctx.state.set(usageKey(week), map);
    // 只留当前周的计数：跨周后旧 key 没有意义，不清理会一直长
    for (const key of Object.keys(ctx.state.all())) {
      if (key.startsWith('usage:') && key !== usageKey(week)) ctx.state.delete(key);
    }
  }

  function quotaMessage(week: string, used: number, quota: number): string {
    const d = nextWeekStart();
    return `本周生图额度已用完（${week} 已用 ${used}/${quota} 张），下周一（${d.getMonth() + 1}月${d.getDate()}日）重置。`;
  }

  // ---------- 画廊 ----------

  function gallery(): GalleryImage[] {
    const v = ctx.state.get<GalleryImage[]>(GALLERY_KEY, []);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string') : [];
  }

  function addGallery(rec: GalleryImage): void {
    const list = gallery();
    list.unshift(rec);
    ctx.state.set(GALLERY_KEY, list.slice(0, GALLERY_MAX));
  }

  // ---------- 沙箱读写（写走门面；读参考图要原始字节，走 root + 自校验边界） ----------

  function insideSandbox(chat: ChatRef, rel: string): string {
    const root = ctx.sandbox.root(chat);
    const abs = resolve(root, rel);
    const normRoot = resolve(root);
    if (abs !== normRoot && !abs.startsWith(normRoot + sep)) {
      throw new Error(`路径越界：只能读当前会话沙箱内的文件（${rel}）`);
    }
    return abs;
  }

  function readRefImage(chat: ChatRef, rel: string): { mime: string; data: string } | { error: string } {
    const path = String(rel ?? '').trim();
    if (!path) return { error: '参考图路径不能为空' };
    // 桌面端没有会话沙箱上下文，参考图是页面里 FileReader 读出的 data URL；
    // 它自带字节、不碰文件系统，仍然走同一套体积与图片头校验。
    const dataUrl = path.match(/^data:([^,]*);base64,([\s\S]+)$/i);
    if (dataUrl) {
      const buf = Buffer.from(dataUrl[2], 'base64');
      if (!buf.length) return { error: '参考图数据是空的' };
      if (buf.length > REF_MAX_BYTES) return { error: `参考图太大（单张上限 8MB）：${dataUrl[1] || 'data URL'}` };
      const mime = sniffImageMime(buf);
      if (!mime) return { error: '参考图不是支持的图片格式（只收 png/jpeg/webp/gif）' };
      return { mime, data: buf.toString('base64') };
    }
    let abs: string;
    try { abs = insideSandbox(chat, path); }
    catch (e) { return { error: (e as Error).message }; }
    let buf: Buffer;
    try {
      const st = statSync(abs);
      if (!st.isFile()) return { error: `参考图不是文件：${path}` };
      if (st.size > REF_MAX_BYTES) return { error: `参考图太大（单张上限 8MB）：${path}` };
      buf = readFileSync(abs);
    } catch {
      return { error: `读不到参考图 ${path}：沙箱里没有这个文件（要写会话沙箱内的相对路径，如 inbox/xxx.png）` };
    }
    const mime = sniffImageMime(buf);
    if (!mime) return { error: `参考图 ${path} 不是支持的图片格式（只收 png/jpeg/webp/gif）` };
    return { mime, data: buf.toString('base64') };
  }

  // ---------- Gemini 调用 ----------

  async function callGemini(input: {
    apiKey: string;
    model: string;
    baseUrl: string;
    prompt: string;
    refs: { mime: string; data: string }[];
  }): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
    const parts: Record<string, unknown>[] = [{ text: input.prompt }];
    for (const r of input.refs) parts.push({ inline_data: { mime_type: r.mime, data: r.data } });

    const url = `${input.baseUrl}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': input.apiKey,
        },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      return { ok: false, error: `生图失败：请求没发出去（${(e as Error).message}），稍后再试。` };
    }

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      return { ok: false, error: geminiHttpError(resp.status, raw) };
    }

    let data: any;
    try { data = await resp.json(); }
    catch { return { ok: false, error: '生图失败：Gemini 回了看不懂的内容（不是 JSON），稍后再试。' }; }

    const blockReason = String(data?.promptFeedback?.blockReason ?? '');
    if (blockReason) {
      return { ok: false, error: `生图失败：描述被 Gemini 的安全策略拦截（${blockReason}），换个说法再试。` };
    }

    const cand = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
    const candParts: any[] = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    const hit = candParts.find((p) => {
      const b64 = p?.inlineData?.data ?? p?.inline_data?.data;
      return typeof b64 === 'string' && b64.length > 0;
    });
    const finish = String(cand?.finishReason ?? '');
    if (!hit) {
      if (/SAFETY|BLOCK|PROHIBITED|IMAGE_SAFETY/i.test(finish)) {
        return { ok: false, error: '生图失败：内容被 Gemini 的安全策略拦截了（可能出在描述或参考图），换个说法再试。' };
      }
      return {
        ok: false,
        error: `生图失败：Gemini 这次没有返回图片${finish ? `（finishReason=${finish}）` : ''}，换个描述再试。`,
      };
    }

    const b64 = String(hit.inlineData?.data ?? hit.inline_data?.data);
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { ok: false, error: '生图失败：Gemini 返回的图片数据是空的，稍后再试。' };
    return { ok: true, data: buf };
  }

  // ---------- 核心：工具与 REST 共用 ----------

  async function generate(opts: {
    chat: ChatRef;
    userId: string;
    role: Role;
    prompt: string;
    refs?: string[];
    filename?: string;
  }): Promise<GenResult> {
    const prompt = String(opts.prompt ?? '').trim();
    if (!prompt) return { ok: false, code: 'input', error: '生图失败：画面描述（prompt）不能为空。' };
    if (prompt.length > PROMPT_MAX_CHARS) {
      return { ok: false, code: 'input', error: `生图失败：画面描述太长了（上限 ${PROMPT_MAX_CHARS} 字），精简一点再试。` };
    }

    const { apiKey, model, baseUrl, weeklyQuota, ownerUnlimited } = cfg();
    if (!apiKey) {
      return { ok: false, code: 'config', error: '生图失败：还没配置 Gemini API Key，请主人在桌面端「插件 → 生图」里填一个。' };
    }

    const refsRaw = Array.isArray(opts.refs) ? opts.refs.map((r) => String(r ?? '').trim()).filter(Boolean) : [];
    if (refsRaw.length > REF_MAX_COUNT) {
      return { ok: false, code: 'input', error: `生图失败：参考图最多 ${REF_MAX_COUNT} 张。` };
    }
    const refs: { mime: string; data: string }[] = [];
    for (const rel of refsRaw) {
      const got = readRefImage(opts.chat, rel);
      if ('error' in got) return { ok: false, code: 'input', error: `生图失败：${got.error}。` };
      refs.push(got);
    }

    const week = weekKeyOf();
    const privileged = opts.role === 'owner' || opts.role === 'admin';
    const limited = !(ownerUnlimited && privileged);
    const used = limited ? usedOf(week, opts.userId) : 0;
    if (limited && used >= weeklyQuota) {
      return { ok: false, code: 'quota', error: quotaMessage(week, used, weeklyQuota) };
    }

    // 先占一张额度：API 失败、内容被拦、写盘失败都要退回去——这三种情况用户没拿到图，不该计数。
    // 占位发生在 await 之前，同一用户的并发调用不会都判定为"还有额度"。
    if (limited) bumpUsage(week, opts.userId, 1);

    const api = await callGemini({ apiKey, model, baseUrl, prompt, refs });
    if (!api.ok) {
      if (limited) bumpUsage(week, opts.userId, -1);
      return { ok: false, code: 'api', error: api.error };
    }

    const id = newId('img_');
    // 按返回字节的真实格式定扩展名（模型可能回 JPEG/WebP，写错扩展名 QQ 端会显示异常）；认不出的按 PNG 兜底
    const mime = sniffImageMime(api.data) ?? 'image/png';
    const relPath = `imagegen/${safeFilename(opts.filename ?? '', id, mime)}`;
    let written: { relPath: string; size: number };
    try {
      written = ctx.sandbox.write(opts.chat, relPath, api.data);
    } catch (e) {
      if (limited) bumpUsage(week, opts.userId, -1);
      return { ok: false, code: 'storage', error: `生图失败：图片写进会话沙箱时出错（${(e as Error).message}）。` };
    }

    addGallery({
      id,
      file: written.relPath,
      prompt,
      model,
      userId: opts.userId,
      chatId: opts.chat.chatId,
      ts: Date.now(),
      chatRef: opts.chat,
      mime,
    });
    return { ok: true, id, path: written.relPath, size: written.size };
  }

  // ---------- LLM 工具（work 面） ----------

  ctx.llm.registerTool({
    name: 'generate_image',
    description: '画一张图（文生图；给了 refs 就用会话沙箱里的图片当参考）。产物落在当前会话沙箱的 imagegen/ 目录（PNG/JPEG 跟随模型返回格式），返回路径与大小。',
    promptSnippet: '用 Gemini 画图（文生图 / 参考图），产物落会话沙箱 imagegen/',
    promptGuidelines: [
      '用户要图（画一张、生成图片、按描述作图、照这张图改）时直接用 generate_image 画，画完把返回的路径用 send_file 发给对方，不要只报路径。',
      '参考图只能给会话沙箱内的相对路径（如 inbox/xxx.png），最多 4 张；图不在沙箱里就先让用户发过来。',
      '生图失败时如实说明原因，不要说已经画好；额度用完就告诉对方下周再来。',
    ],
    surface: 'work',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述：主体、场景、风格、构图，越具体越好（中文即可）' },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图：会话沙箱内的相对路径，最多 4 张（可选）',
        },
        filename: { type: 'string', description: '可选文件名（落在 imagegen/ 下，按实际格式补扩展名）' },
      },
      required: ['prompt'],
    },
    handler: async (args, tctx): Promise<string | ToolResult> => {
      const r = await generate({
        chat: tctx.chat,
        userId: String(tctx.event.userId ?? ''),
        role: tctx.role,
        prompt: String(args.prompt ?? ''),
        refs: Array.isArray(args.refs) ? args.refs.map(String) : undefined,
        filename: args.filename ? String(args.filename) : undefined,
      });
      if (!r.ok) return r.error;
      return {
        content: `已生成 ${r.path}（${r.size} 字节）。要发给用户就用 send_file 传这个路径。`,
        meta: { path: r.path, artifacts: [r.path] },
      };
    },
  });

  // ---------- chat 轮说明（追加一节，不覆盖别的插件注入） ----------

  ctx.hooks.beforeLLM = (req) => {
    const { apiKey, weeklyQuota, ownerUnlimited } = cfg();
    if (!req.systemSections) req.systemSections = [];
    const lines = [
      '# 生图',
      '- 对方要图（画一张、生成图片、按描述作图、照这张图改）时，让 work 去做：work 有 generate_image 工具，支持文生图，也支持拿会话沙箱里的图片当参考。',
      `- 普通成员每个自然周（周一起算）最多 ${weeklyQuota} 张；主人与管理员${ownerUnlimited ? '不限张数' : '同样按这个额度算'}。额度用完就如实告诉对方下周再来，不要用文字假装已经画好。`,
    ];
    if (!apiKey) lines.push('- 这台 bot 目前还没配置 Gemini API Key，画不了图；对方要图时直说现在生不了。');
    req.systemSections.push({ order: 290, title: 'imagegen', text: lines.join('\n') });
    return req;
  };

  // ---------- REST（桌面端「生图」页；/api/* 已由 uiToken 鉴权，能进来的就是主人） ----------

  /** 桌面端没有会话上下文：固定用它自己的沙箱，画廊与 /image 都按这个 ref 找文件 */
  const desktopChat = (): ChatRef => ({ platform: 'ui', type: 'private', chatId: 'desktop' });

  const ownerId = (): string => {
    const ids = (ctx.config as { masterIds?: unknown }).masterIds;
    return Array.isArray(ids) && ids.length ? String(ids[0]) : 'owner';
  };

  ctx.http.on('GET', '/gallery', () => ({
    body: {
      ok: true,
      // chatRef 是内部定位信息，不对外返回（接口字段与约定一致）
      images: gallery().map((g) => ({
        id: g.id, prompt: g.prompt, model: g.model, userId: g.userId, chatId: g.chatId, ts: g.ts, file: g.file,
      })),
    },
  }));

  ctx.http.on('GET', '/image', (req) => {
    const id = String(req.query.id ?? '').trim();
    const rec = gallery().find((g) => g.id === id);
    if (!rec) return { status: 404, body: { ok: false, error: '没有这张图（id 不存在或已被清理）' } };
    try {
      const abs = insideSandbox(rec.chatRef ?? desktopChat(), rec.file);
      const buf = readFileSync(abs);
      // 旧记录没存 mime：现场嗅探，别把 JPEG 当 PNG 发；认不出就按二进制流给
      return { headers: { 'content-type': rec.mime ?? sniffImageMime(buf) ?? 'application/octet-stream' }, body: buf };
    } catch (e) {
      return { status: 404, body: { ok: false, error: `图片读不到：${(e as Error).message}` } };
    }
  });

  ctx.http.on('GET', '/usage', () => {
    const weekKey = weekKeyOf();
    const map = usageOf(weekKey);
    const users = Object.entries(map)
      .map(([userId, used]) => ({ userId, used: Math.max(0, Math.floor(Number(used) || 0)) }))
      .filter((u) => u.used > 0)
      .sort((a, b) => b.used - a.used || a.userId.localeCompare(b.userId));
    return { body: { ok: true, weekKey, users } };
  });

  ctx.http.on('POST', '/generate', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const r = await generate({
      chat: desktopChat(),
      userId: ownerId(),
      role: 'owner',
      prompt: String(body.prompt ?? ''),
      refs: Array.isArray(body.refs) ? body.refs.map(String) : undefined,
    });
    if (!r.ok) return { status: r.code === 'quota' ? 429 : 400, body: { ok: false, code: r.code, error: r.error } };
    return { body: { ok: true, id: r.id } };
  });
}
