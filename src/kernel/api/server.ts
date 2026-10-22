import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Kernel } from '../kernel.ts';
import { REASONING_LEVELS, type ModelRef, type ProviderModelCfg } from '../config.ts';
import { newId, nowMs } from '../util/misc.ts';
import { usageReport } from '../services/usage.ts';
import { depsReady, dockerDesktopExe, invalidateDepCache, probeDeps, type DepProbe } from '../services/deps.ts';
import { DEP_FETCHES, fetchState, startDepFetch } from '../services/downloads.ts';
import { geminiApiBase } from '../services/pi-ai.ts';
import { LLBotManager } from '../services/llbot.ts';
import { busEvents } from '../bus.ts';
import type { ChatEvent, ChatRef } from '../types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ui');

/** 入口 html 的 mtime：前端拿它发现自己跑的是不是上次构建的旧界面（站内换页不会重新下载 JS） */
function uiBuildStamp(): number {
  const index = join(UI_ROOT, 'index.html');
  return existsSync(index) ? Math.round(statSync(index).mtimeMs) : 0;
}

/**
 * REST API + 静态 UI + 事件 WS。
 * 鉴权：除静态文件外，全部 /api 与 /ws 需要 uiToken（header X-Auth-Token / ?token=）。
 * 桌面端与 QQ 侧操作同一份状态（单一写入者：本 API + Pipeline）。
 */
export function startApiServer(kernel: Kernel): Promise<ReturnType<typeof createServer>> {
  const { ui } = kernel.config.config;
  const uiRoot = UI_ROOT;

  const server = createServer((req, res) => {
    void handle(kernel, uiRoot, req, res).catch((e) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    });
  });

  // 事件 WS（实时推送）
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('token') !== kernel.config.secrets.uiToken) {
      ws.close(1008, 'unauthorized');
      return;
    }
    const events = [
      'session.log', busEvents.toolCall, busEvents.toolResult, busEvents.llmDelta,
      busEvents.agentStart, busEvents.agentEnd, busEvents.adapterStatus,
      busEvents.pluginLoaded, busEvents.pluginUnloaded, busEvents.pluginStateChanged,
      busEvents.errorRecorded, busEvents.configChanged, busEvents.chatOut,
      busEvents.memoryChanged, busEvents.providerChanged, busEvents.modelFailover,
      // 会话页右侧「工作」抽屉的实时 loop
      busEvents.workStart, busEvents.workEvent, busEvents.workStep,
      busEvents.workDone, busEvents.workError,
    ];
    const offs = events.map((ev) => kernel.bus.on(ev, (data: unknown) => {
      try { ws.send(JSON.stringify({ ev, data })); } catch { /* ignore */ }
    }));
    ws.on('close', () => offs.forEach((off) => off()));
  });

  return new Promise((resolveP) => server.listen(ui.port, ui.host, () => resolveP(server)));
}

/** 供应商 id：取名称里的 ascii 片段做 slug，中文/空名回落到随机 id */
function uniqueProviderId(label: string, existing: Record<string, unknown>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const base = slug || `provider-${newId().slice(-6)}`;
  let id = base, i = 2;
  while (existing[id] !== undefined || RESERVED_IDS.includes(id)) id = `${base}-${i++}`;
  return id;
}

const PROVIDER_PROTOCOLS = ['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'mock'];
const RESERVED_IDS = ['chain', 'create', 'probe'];
/** 模型行可选值：内核会按这些语义去整形请求，收不认识的键没有意义 */
const MODEL_INPUT_TYPES = ['text', 'image', 'video', 'audio'];
const MODEL_CAPABILITIES = ['webSearch'];

/** 模型行白名单：只收 UI 认识的字段，数字必须有限 */
function sanitizeModels(list: unknown[]): ProviderModelCfg[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 12) : undefined);
  const only = (v: unknown, allow: string[]) => {
    const s = strs(v);
    return s ? s.filter((x) => allow.includes(x)) : undefined;
  };
  const out: ProviderModelCfg[] = [];
  for (const raw of list.slice(0, 60)) {
    const m = raw as Record<string, unknown>;
    const id = String(m?.id ?? '').trim().slice(0, 120);
    if (!id || out.some((o) => o.id === id)) continue;
    out.push({
      id,
      contextWindow: num(m.contextWindow),
      maxOutput: num(m.maxOutput),
      inputTypes: only(m.inputTypes, MODEL_INPUT_TYPES),
      capabilities: only(m.capabilities, MODEL_CAPABILITIES),
      reasoningLevels: strs(m.reasoningLevels),
      enabled: m.enabled === false ? false : true,
    });
  }
  return out;
}

/** 探一次供应商的 GET {base}/models（test 与创建前的 probe 共用） */
/** 远端模型列表按连接方式分家：Anthropic 没有这个接口（调用方提前挡掉），其余两家路径与鉴权头都不同 */
async function listRemoteModels(base: string, key: string, protocol = 'openai-compatible') {
  return protocol === 'gemini' ? listGeminiModels(base, key) : listOpenAiModels(base, key);
}

async function listOpenAiModels(base: string, key: string) {
  try {
    const resp = await fetch(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    const j = (await resp.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = (j?.data ?? []).map((m) => String(m?.id ?? '')).filter(Boolean).slice(0, 300);
    return { ok: resp.ok, status: resp.status, models: ids, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Gemini：GET <base>/v1beta/models + `x-goog-api-key`。同目录里还挂着 embedding / tuning 那些
 *  不能对话的模型，只留 supportedGenerationMethods 里有 generateContent 的，否则候选列表全是噪音。 */
async function listGeminiModels(base: string, key: string) {
  try {
    const resp = await fetch(`${geminiApiBase(base)}/models`, {
      headers: key ? { 'x-goog-api-key': key } : {},
      signal: AbortSignal.timeout(8000),
    });
    const j = (await resp.json().catch(() => null)) as {
      models?: { name?: unknown; supportedGenerationMethods?: unknown }[];
    } | null;
    const ids = (j?.models ?? [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods)
        && (m.supportedGenerationMethods as unknown[]).some((g) => g === 'generateContent' || g === 'streamGenerateContent'))
      .map((m) => String(m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean).slice(0, 300);
    return { ok: resp.ok, status: resp.status, models: ids, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function handle(kernel: Kernel, uiRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // ---- 静态 UI ----
  if (!path.startsWith('/api/') && !path.startsWith('/ws')) {
    serveStatic(uiRoot, path, res);
    return;
  }

  // ---- 鉴权 ----
  // 免 uiToken 的两组：登录页接口（浏览器还没拿到 token 时就要用 status/qrcode/avatar），
  // 以及初始环境检查页（它排在登录之前，且只报本机装了哪些软件/在哪，不含会话与配置）。
  // 两者都只在 127.0.0.1 上提供，其余 /api/* 一律要求 token。
  const pathIsLoginApi = path.startsWith('/api/login/') || path.startsWith('/api/setup/');
  const token = req.headers['x-auth-token'] ?? url.searchParams.get('token') ?? '';
  if (!pathIsLoginApi && token !== kernel.config.secrets.uiToken) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const body = await readBody(req).catch(() => ({}));
  const segments = path.split('/').filter(Boolean); // ['api', ...]
  const send = (data: unknown, status = 200) => {
    // API 一律 no-store：清掉的 key / 改完的配置不许被浏览器缓存端回来（静态资源在 serveStatic 另有缓存头）
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  try {
    const [area, a, b, c] = segments; // segments[0]='api'

    // ================= 登录页（QQ 账号登录状态） =================
    if (area === 'api' && a === 'login') {
      const st = kernel.adapter.status() as {
        connected?: boolean; selfId?: string; selfNickname?: string;
        expectedQq?: string; accountBlocked?: { got: string; expected: string };
      };
      const selfId = st.selfId || kernel.config.config.ui.lastLogin?.qq || '';
      const selfNickname = st.selfNickname || kernel.config.config.ui.lastLogin?.nickname || '';
      const end = kernel.protocolEnd().status() as { online?: boolean };
      if (b === 'status') {
        return send({
          // 登错号（见 adapter 账号守卫）不算"可用"：登录页据此把原因显示出来，而不是当作已登录
          // 反向 WS 连着 ≠ QQ 在线（协议端掉线后仍照常上报心跳，与 llbot 在线看门狗同源），
          // 所以只要协议端自己报了在线判据（end.online），就必须它也为真才算登录。
          connected: !!st.connected && !st.accountBlocked && end.online !== false,
          qq: selfId,
          nickname: selfNickname,
          avatar: selfId ? avatarUrl(selfId) : '',
          lastLogin: kernel.config.config.ui.lastLogin,
          expectedQq: st.expectedQq || '',
          accountBlocked: st.accountBlocked,
          protocol: kernel.config.config.onebot.flavor ?? 'llbot',
          end,
        });
      }
      if (b === 'qrcode' && req.method === 'POST') {
        // 二维码：当前协议端的 WebUI 代理（拿不到再回退协议端扩展动作）
        const qr = await kernel.protocolEnd().fetchQrcode().catch(() => null);
        if (qr?.png) return send({ image: qr.png, url: qr.url, expireSec: qr.expireSec, source: kernel.protocolEnd().id });
        const fb = await kernel.adapter.tryFetchQrcode().catch(() => null);
        return send({ image: fb?.image ?? null, source: 'adapter-actions' });
      }
      if (b === 'avatar' && c) {
        // 头像代理：qlogo 偶有跨域/防盗链问题，经内核转发
        try {
          const resp = await fetch(avatarUrl(c));
          const buf = Buffer.from(await resp.arrayBuffer());
          res.writeHead(200, { 'content-type': resp.headers.get('content-type') ?? 'image/png', 'cache-control': 'public, max-age=86400' });
          res.end(buf);
        } catch {
          res.writeHead(404); res.end();
        }
        return;
      }
      if (b === 'end' && c === 'restart' && req.method === 'POST') {
        const end = kernel.protocolEnd();
        await end.stop();
        if (kernel.managesEnd()) await end.start();
        return send({ ok: true, status: end.status() });
      }
      if (b === 'end' && c === 'check' && req.method === 'POST') {
        const end = kernel.protocolEnd();
        const ob = kernel.config.config.onebot;
        const checks = await end.check();
        if (st.accountBlocked) {
          checks.push({ state: 'fail', label: '反向 WS', detail: `登录号 ${st.accountBlocked.got} 不是预期 ${st.accountBlocked.expected}，已停止代发` });
        } else if (st.connected) {
          checks.push({ state: 'pass', label: '反向 WS', detail: `ws://${ob.host}:${ob.port}${ob.reverseWsPath}` });
        } else {
          checks.push({ state: 'fail', label: '反向 WS', detail: '未连接' });
        }
        return send({ protocol: end.id, checks });
      }
    }

    // ================= 初始环境检查（依赖探测） =================
    if (area === 'api' && a === 'setup') {
      const ob = kernel.config.config.onebot as unknown as Record<string, Record<string, unknown>>;
      const ctx = (): DepProbe => {
        const end = kernel.protocolEnd();
        return {
          dataDir: kernel.dataDir,
          // 有头模式（PMHQ / NapCat 注入）必须有本机 QQNT；无头直连不需要
          headed: kernel.config.config.onebot.flavor === 'napcat' || String(ob.llbot?.mode ?? 'pmhq') === 'pmhq',
          // 这一项对外的名字与落点跟着当前那一档走（LuckyLillia / NapCat）
          endFlavor: end.id,
          endDownloaded: !!end.status().downloaded,
          // 用户自己起的协议端（不走托管）也算在跑：别让这页报"必备项缺失"
          endConnected: !!(kernel.adapter.status() as { connected?: boolean }).connected,
          qqPathCfg: String(ob.llbot?.qqPath ?? ob.napcat?.qqPath ?? ''),
        };
      };
      if (b === 'deps') {
        const fresh = url.searchParams.get('fresh') === '1' || req.method === 'POST';
        if (fresh) invalidateDepCache();
        const items = await probeDeps(ctx(), fresh);
        return send({
          items, ready: depsReady(items),
          setupDoneAt: kernel.config.config.ui.setupDoneAt ?? 0,
          managesEnd: kernel.managesEnd(),
        });
      }
      // 「点击就下载」这一渠道：协议端发行包由 manager 全权处理（下载+解包+就位），
      // 其余按 DEP_FETCHES 白名单把官方包拉到 data/downloads——装不装由人，内核不静默跑别人的安装程序。
      // 下载要跑几分钟，不能把 HTTP 请求挂在那儿：后台起流，前端轮 /api/setup/fetch 看进度。
      if (b === 'install' && req.method === 'POST') {
        const id = String(body.id ?? 'llbot');
        if (id === 'llbot') {
          if (!kernel.managesEnd()) return send({ error: '这个内核不托管协议端（noApi），不该由它下载发行包' }, 409);
          const end = kernel.protocolEnd();
          if (end.status().downloaded) return send({ ok: true, already: true, status: end.status() });
          void end.start().catch((e) => kernel.errors.record('error', 'adapter', `协议端发行包下载失败：${(e as Error).message}`, { notifyOwner: false }));
          return send({ ok: true, started: true });
        }
        if (!DEP_FETCHES[id]) return send({ error: `这一项不由内核代下载：${id}` }, 400);
        try {
          return send({ ok: true, state: startDepFetch(id, kernel.dataDir) });
        } catch (e) {
          return send({ error: (e as Error).message }, 400);
        }
      }
      if (b === 'fetch' && req.method === 'GET') {
        return send({ state: fetchState(String(url.searchParams.get('id') ?? '')) });
      }
      // 协议端使用授权（LLBot 的签名 Auth Token）：状态 + 录入。这页排在登录之前，所以跟着 /api/setup/* 免 token；
      // 它只报"授权到哪一步了"，不回 token 内容（日志同理）。NapCat 那一档没有这套机制 → supported:false。
      if (b === 'auth') {
        const end = kernel.protocolEnd();
        if (!(end instanceof LLBotManager)) return send({ supported: false });
        if (req.method === 'POST') {
          const token = String(body.token ?? '').trim().slice(0, 4096);
          end.setAuthToken(token);
        }
        return send({ supported: true, ...(await end.authState()) });
      }
      // 只允许拉 Docker Desktop（装了就绪不了的那种「没启动」）：按 id 白名单，绝不拿 body 里的路径去 spawn
      if (b === 'start' && req.method === 'POST') {
        const exe = String(body.id ?? '') === 'docker' ? dockerDesktopExe() : '';
        if (!exe) return send({ error: '没探到 Docker Desktop，请自己启动它后再重新检测' }, 409);
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        return send({ ok: true, exe });
      }
      if (b === 'done' && req.method === 'POST') {
        kernel.config.config.ui.setupDoneAt = nowMs();
        kernel.config.saveConfig();
        return send({ ok: true, setupDoneAt: kernel.config.config.ui.setupDoneAt });
      }
    }

    // ================= 会话列表偏好（置顶/隐藏/列表宽，按 bot 登录号存储） =================
    if (area === 'api' && a === 'chat-prefs') {
      const qq = (kernel.adapter.status() as { selfId?: string }).selfId || 'default';
      const prefs = kernel.config.config.ui.chatPrefs[qq] ??= { pinned: [], hidden: [] };
      if (req.method === 'GET') return send(prefs);
      if (req.method === 'PUT' || req.method === 'POST') {
        if (Array.isArray(body.pinned)) prefs.pinned = body.pinned.map(String).slice(0, 200);
        if (Array.isArray(body.hidden)) prefs.hidden = body.hidden.map(String).slice(0, 500);
        if (Number.isFinite(body.listWidth)) prefs.listWidth = Math.min(Math.max(Math.round(body.listWidth), 160), 600);
        kernel.config.saveConfig();
        return send({ ok: true });
      }
    }

    // ================= RPC（UI 用） =================
    if (area === 'api' && a === 'rpc' && b === 'commands_visible') {
      const chat = { platform: 'ui', type: body.chatType === 'private' ? 'private' : 'group', chatId: String(body.chatId ?? '') };
      return send(kernel.container.commandsForChat(chat, body.role ?? 'owner').map((cm) => ({
        name: cm.def.name, pluginId: cm.pluginId, description: cm.def.description, enabled: cm.enabled, minRole: cm.def.minRole,
      })));
    }

    // ================= 状态总览 =================
    if (area === 'api' && a === 'state') {
      const usage = kernel.llm.todayUsage();
      return send({
        adapter: kernel.adapter.status(),
        model: { provider: kernel.llm.activeProviderId(), model: kernel.llm.activeModel(), usable: kernel.llm.isActiveUsable() },
        providers: kernel.llm.listProviders(),
        usage,
        plugins: {
          total: kernel.container.list().length,
          loaded: kernel.container.list().filter((p) => p.state === 'loaded').length,
        },
        errors: kernel.errors.list().filter((e) => e.level === 'error').length,
        masterIds: kernel.config.config.masterIds,
        uptimeMs: Math.round(process.uptime() * 1000),
        // 入口 html 的落盘时间：桌面端拿它判断"标签页里跑的还是上次构建的旧界面"
        uiBuild: uiBuildStamp(),
      });
    }

    // ================= 用量（桌面端「用量」页：整份报表，前端按指标/时间窗切片） =================
    if (area === 'api' && a === 'usage' && !b && req.method === 'GET') {
      return send(usageReport(kernel.db));
    }

    // ================= 插件 =================
    if (area === 'api' && a === 'plugins' && !b) {
      const chats = [...new Set([
        ...kernel.container.list().flatMap((lp) => kernel.container.groupStates(lp.manifest.id).map((s) => s.chatId)),
      ])];
      return send(kernel.container.list().filter((lp) => !lp.manifest.hidden).map((lp) => ({
        id: lp.manifest.id, name: lp.manifest.name, version: lp.manifest.version,
        description: lp.manifest.description, category: lp.manifest.category, trust: lp.manifest.trust,
        permissions: lp.manifest.permissions, core: !!lp.manifest.core, locked: !!lp.manifest.locked,
        personas: lp.manifest.personas ?? [],
        state: lp.state, source: lp.source, loadedAt: lp.loadedAt,
        defaultGroupState: lp.manifest.defaultGroupState,
        globalDefault: kernel.container.getGlobalDefault(lp.manifest.id) ?? (lp.manifest.defaultGroupState === 'on'),
        globalDefaultOverridden: kernel.container.getGlobalDefault(lp.manifest.id) !== undefined,
        tools: [...lp.tools.keys()], commands: [...new Set([...lp.commands.values()].map((x) => x.name))],
        groupStates: kernel.container.groupStates(lp.manifest.id),
        userConfigSchema: lp.manifest.userConfig ?? {},
        hasMcp: !!lp.manifest.mcpServers && Object.keys(lp.manifest.mcpServers).length > 0,
      })));
    }
    if (area === 'api' && a === 'plugins' && b && !c) {
      // POST /api/plugins/install 触发扫描
      if (b === 'install' && req.method === 'POST') {
        return send({ installed: await kernel.container.installUserPlugins() });
      }
    }
    if (area === 'api' && a === 'plugins' && b && c) {
      const lp = kernel.container.get(b);
      if (!lp) return send({ error: `插件 ${b} 不存在` }, 404);
      if (c === 'enable' || c === 'disable') {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        await kernel.container.setRuntimeEnabled(b, c === 'enable');
        return send({ ok: true, state: lp.state });
      }
      if (c === 'reload' && req.method === 'POST') {
        await kernel.container.reload(b);
        return send({ ok: true });
      }
      if (c === 'uninstall' && req.method === 'DELETE') {
        await kernel.container.uninstallUserPlugin(b);
        return send({ ok: true });
      }
      if (c === 'config') {
        if (req.method === 'GET') {
          // secret 字段照实回显（跟 /api/providers 同一口径：只听 127.0.0.1 + uiToken），
          // 免得页面上留个空框让人以为没配
          const values = kernel.container.resolveUserConfig(lp);
          // globalDefault 一并回：hidden 插件的分群开关在各自的设置页里改，不再经插件页
          return send({
            values, schema: lp.manifest.userConfig ?? {},
            globalDefault: kernel.container.getGlobalDefault(lp.manifest.id) ?? (lp.manifest.defaultGroupState === 'on'),
          });
        }
        if (req.method === 'POST') {
          for (const [k, v] of Object.entries(body.values ?? {})) {
            const schemaField = lp.manifest.userConfig?.[k];
            if (!schemaField) continue;
            // 含 • 的是旧标签页回传的脱敏值，忽略；空串是用户主动清空，要真删
            if (schemaField.secret && typeof v === 'string' && v.includes('•')) continue;
            kernel.container.setUserConfigValue(b, k, v);
          }
          return send({ ok: true });
        }
      }
      if (c === 'global-default' && req.method === 'POST') {
        kernel.container.setGlobalDefault(b, !!body.enabled);
        return send({ ok: true });
      }
      if (c === 'group-state' && req.method === 'POST') {
        kernel.container.setGroupState(b, String(body.chatId), !!body.enabled, 'ui');
        return send({ ok: true });
      }
      if (c === 'group-state-clear' && req.method === 'POST') {
        kernel.container.clearGroupState(b, String(body.chatId));
        return send({ ok: true });
      }
    }

    // ================= 会话 =================
    if (area === 'api' && a === 'chats' && !b) {
      // 会话列表带标题：群聊=群名 / 私聊=好友昵称（协议端离线时回落空串，前端显示号码）
      const chats = kernel.sessionLog.listChats();
      return send(chats.map((c) => ({ ...c, title: kernel.adapter.chatTitle(c.chatType, c.chatId) })));
    }
    if (area === 'api' && a === 'chats' && b) {
      const m = b.match(/^(group|private)_(.+)$/);
      if (!m) return send({ error: 'bad chatKey' }, 400);
      const chat = { platform: 'ui', type: m[1] as 'group' | 'private', chatId: m[2] };
      if (!c || c === 'tail') {
        // 会话流：tail + 群信息
        const limit = Number(url.searchParams.get('limit') ?? 200);
        return send({ chatKey: b, entries: kernel.sessionLog.tail(m[2], m[1], limit) });
      }
      if (c === 'days') {
        // 日轨：这个会话有哪些日子、各有几条（不受 tail 的 300 条内存缓冲限制，扫的是整份盘）
        return send({ chatKey: b, days: kernel.sessionLog.days(m[2], m[1]) });
      }
      if (c === 'day') {
        const day = String(url.searchParams.get('day') ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send({ error: 'bad day' }, 400);
        return send({ chatKey: b, day, entries: kernel.sessionLog.dayEntries(m[2], m[1], day) });
      }
      if (c === 'log') {
        const limit = Number(url.searchParams.get('limit') ?? 800);
        return send({ entries: kernel.sessionLog.readFromDisk(b, limit) });
      }
      if (c === 'send' && req.method === 'POST') {
        // 以 bot 身份发言：**真实发出**（platform=qq 走协议端），限速与会话日志照常，
        // 发完按 role=model 回灌历史。测试用户注入走 /inject（platform=ui，
        // 模型回复只在桌面端模拟落日志）——两条路不混，别把这里的平台改回 ui。
        await kernel.pipeline.sendAsBot(
          { platform: 'qq', type: m[1] as 'group' | 'private', chatId: m[2] },
          String(body.text ?? ''),
        );
        return send({ ok: true });
      }
      if (c === 'inject' && req.method === 'POST') {
        // 注入模拟用户消息（不插真 QQ 验证主流程的入口，红线 §3.6）
        const ev: ChatEvent = {
          id: newId('ev_'),
          platform: 'ui',
          type: m[1] as 'group' | 'private',
          chatId: m[2],
          userId: String(body.userId ?? '10000'),
          nickname: String(body.nickname ?? '桌面访客'),
          senderRole: 'unknown',
          segments: [{ type: 'text', data: { text: String(body.text ?? '') } }],
          text: String(body.text ?? ''),
          isAtMe: true,
          isReplyToMe: false,
          raw: { injected: true },
          ts: Date.now(),
        };
        kernel.pipeline.submit(ev);
        return send({ ok: true, eventId: ev.id });
      }
      if (c === 'abort' && req.method === 'POST') {
        kernel.pipeline.abortChat(m[2]);
        return send({ ok: true });
      }
    }

    // ================= 人格 =================
    if (area === 'api' && a === 'personas' && b === 'overlay') {
      // 演化层存在 chat 插件的 state 里，内核读不到 → 走 bus 一问一答
      const ask = (op: string, personaId: string, layer?: string): Promise<any> => new Promise((resolve) => {
        const requestId = `ov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const off = kernel.bus.on('persona.overlay_reply', (d: any) => {
          if (d?.requestId !== requestId) return;
          off(); clearTimeout(timer); resolve(d);
        });
        const timer = setTimeout(() => { off(); resolve(null); }, 2000);
        kernel.bus.emit('persona.overlay_request', { requestId, personaId, op, layer, requesterRole: 'owner' });
      });
      const personaId = String(url.searchParams.get('personaId') ?? body?.personaId ?? '');
      if (req.method === 'GET') {
        const r = await ask('list', personaId);
        return send({ personaId: r?.personaId ?? personaId, entries: r?.entries ?? [] });
      }
      if (req.method === 'POST') {
        const r = await ask('clear', personaId, typeof body?.layer === 'string' ? body.layer : undefined);
        if (!r) return send({ error: '人格插件未响应（chat 插件可能未载入）' }, 503);
        return send({ ok: true, removed: r.removed ?? 0, entries: r.entries ?? [] });
      }
    }
    if (area === 'api' && a === 'personas') {
      const personaPlugins = kernel.container.list().filter((lp) => lp.manifest.category === 'persona');
      if (!b) {
        const out: unknown[] = [];
        for (const lp of personaPlugins) {
          const personas: unknown[] = [];
          const dir = join(lp.dir, 'personas');
          if (existsSync(dir)) {
            for (const id of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name)) {
              const read = (f: string) => existsSync(join(dir, id, f)) ? readFileSync(join(dir, id, f), 'utf-8') : '';
              const canonRaw = read('canon.json');
              personas.push({
                id, pluginId: lp.manifest.id,
                // HDSI 式剧本：canon（初始设定）/ perspective（个体价值观）/ voice（语气样例）/ lore（世界事实）
                canon: safeJson(canonRaw),
                raw: { 'canon.json': canonRaw },
              });
            }
          }
          out.push({ pluginId: lp.manifest.id, pluginName: lp.manifest.name, personas });
        }
        return send({ default: kernel.config.config.persona.default, plugins: out });
      }
      if (b === 'edit' && req.method === 'POST') {
        // 经 chat 插件的 persona.edit_request 事件（仅 owner；UI 鉴权即视为 owner）
        const result = await new Promise<{ ok: boolean; error?: string }>((resolveP) => {
          kernel.bus.once('persona.edit_done', (r: { ok: boolean; error?: string }) => resolveP(r));
          kernel.bus.emit('persona.edit_request', { personaId: body.personaId, file: body.file, content: body.content, requesterRole: 'owner' });
          setTimeout(() => resolveP({ ok: false, error: '没有收到插件响应（人格插件未载入？）' }), 3000);
        });
        return send(result, result.ok ? 200 : 400);
      }
      if (b === 'create' && req.method === 'POST') {
        const result = await new Promise<{ ok: boolean; error?: string }>((resolveP) => {
          kernel.bus.once('persona.create_done', (r: { ok: boolean; error?: string }) => resolveP(r));
          kernel.bus.emit('persona.create_request', { personaId: body.personaId, name: body.name, requesterRole: 'owner' });
          setTimeout(() => resolveP({ ok: false, error: '没有收到插件响应（人格插件未载入？）' }), 3000);
        });
        return send(result, result.ok ? 200 : 400);
      }
    }

    // ================= 模型 =================
    if (area === 'api' && a === 'providers') {
      const allProviders = kernel.config.config.providers as Record<string, any>;
      if (!b) {
        return send({
          active: kernel.llm.activeProviderId(),
          activeModel: kernel.llm.activeModel(),
          providers: kernel.llm.listProviders().map((p) => ({
            ...p,
            config: allProviders[p.id] ?? {},
            hasKey: !!kernel.config.getProviderKey(p.id),
            // 桌面端要把已配的密钥显示出来（本 API 只听 127.0.0.1 且带 uiToken）
            apiKey: kernel.config.getProviderKey(p.id),
          })),
          usage: kernel.llm.todayUsage(),
          // 两条模型优先级链（靠前的优先，掉线自动接后一个）；两条各自独立，谁都不跟随谁
          chains: kernel.llm.chainsView(),
          reasoning: { chat: kernel.llm.reasoningFor('chat'), work: kernel.llm.reasoningFor('work') },
          failoverThreshold: kernel.config.config.llm.failoverThreshold,
        });
      }
      if (b === 'chain' && req.method === 'POST') {
        const kind = String(body.kind ?? '');
        if (kind !== 'chat' && kind !== 'work') return send({ error: 'kind 需要是 chat 或 work' }, 400);
        const hasEntries = Array.isArray(body.entries);
        const hasReasoning = body.reasoning !== undefined;
        if (!hasEntries && !hasReasoning) return send({ error: '没有要改的内容（entries / reasoning 至少给一个）' }, 400);

        let entries: ModelRef[] | null = null;
        if (hasEntries) {
          const raw = (body.entries as unknown[]).slice(0, 20);
          entries = [];
          for (const e of raw) {
            const pid = String((e as any)?.provider ?? '').trim().slice(0, 80);
            const model = String((e as any)?.model ?? '').trim().slice(0, 120);
            if (!pid || !model) return send({ error: '链上的每条都要有供应商与模型名' }, 400);
            if (!allProviders[pid]) return send({ error: `未知供应商 ${pid}` }, 400);
            if (!entries.some((x) => x.provider === pid && x.model === model)) entries.push({ provider: pid, model });
          }
          if (kind === 'chat' && !entries.length) return send({ error: '聊天模型至少要留一条' }, 400);
        }

        let level: string | undefined;
        if (hasReasoning) {
          const v = String(body.reasoning ?? '').trim();
          if (v && !(REASONING_LEVELS as readonly string[]).includes(v)) {
            return send({ error: `思考强度需要是空或 ${REASONING_LEVELS.join(' / ')}` }, 400);
          }
          level = v;
        }

        const llm = kernel.config.config.llm;
        if (entries) {
          if (kind === 'chat') {
            llm.chatChain = entries;
            if (entries.length) llm.activeProvider = entries[0].provider;   // 人设绑定/状态展示读这个镜像
          } else {
            llm.workChain = entries;
          }
        }
        if (level !== undefined) {
          if (kind === 'chat') llm.chatReasoning = level;
          else llm.workReasoning = level;
        }
        if (entries) kernel.llm.resetFailover();
        kernel.config.saveConfig();
        return send({
          ok: true,
          chains: kernel.llm.chainsView(),
          reasoning: { chat: kernel.llm.reasoningFor('chat'), work: kernel.llm.reasoningFor('work') },
        });
      }
      if (b === 'create' && req.method === 'POST') {
        const label = String(body.label ?? '').trim().slice(0, 40);
        const baseUrl = String(body.baseUrl ?? '').trim().slice(0, 300);
        if (!label) return send({ error: '请填写供应商名称' }, 400);
        if (baseUrl && !/^https?:\/\//.test(baseUrl)) return send({ error: 'Base URL 需以 http(s):// 开头' }, 400);
        const want = String(body.model ?? '').trim().slice(0, 120);
        const proto = PROVIDER_PROTOCOLS.includes(String(body.protocol)) ? String(body.protocol) : 'openai-compatible';
        const models = Array.isArray(body.models) ? sanitizeModels(body.models) : [];
        if (!models.length && want) models.push({ id: want, enabled: true });
        // 默认使用哪条：显式点名的（且未停用）优先，否则取第一条启用的
        const picked = models.find((m) => m.id === want && m.enabled !== false) ?? models.find((m) => m.enabled !== false);
        const id = uniqueProviderId(label, allProviders);
        allProviders[id] = {
          label, model: picked?.id ?? '', enabled: true, baseUrl, protocol: proto, custom: true, models,
        };
        kernel.llm.syncCustomProviders();
        kernel.config.saveConfig();
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) kernel.config.setProviderKey(id, body.apiKey.trim());
        return send({ ok: true, id });
      }
      // 创建前探一次远端模型列表：此刻还没有供应商 id，baseUrl/key 都从请求体拿
      if (b === 'probe' && req.method === 'POST') {
        const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '').slice(0, 300);
        const proto = PROVIDER_PROTOCOLS.includes(String(body.protocol)) ? String(body.protocol) : 'openai-compatible';
        if (!/^https?:\/\//.test(baseUrl)) return send({ ok: false, error: 'Base URL 需以 http(s):// 开头' });
        if (proto === 'anthropic') {
          return send({ ok: false, error: 'Anthropic 没有模型列表接口，创建后可用模型行上的「测试连接」逐个验证' });
        }
        return send(await listRemoteModels(baseUrl, String(body.apiKey ?? '').trim().slice(0, 400), proto));
      }
      if (req.method === 'POST') {
        const pc = allProviders[b];
        if (!pc) return send({ error: '未知供应商' }, 404);
        if (c === 'remove') {
          if (!pc.custom) return send({ error: '内置供应商不可删除' }, 400);
          delete allProviders[b];
          delete (kernel.config.config.llm as any).modelByProvider[b];
          const llm = kernel.config.config.llm;
          llm.chatChain = llm.chatChain.filter((x) => x.provider !== b);
          llm.workChain = llm.workChain.filter((x) => x.provider !== b);
          if (llm.activeProvider === b) llm.activeProvider = llm.chatChain[0]?.provider ?? Object.keys(allProviders)[0] ?? '';
          kernel.llm.removeProvider(b);
          kernel.llm.resetFailover();
          kernel.config.setProviderKey(b, '');
          kernel.config.saveConfig();
          return send({ ok: true });
        }
        if (c === 'test') {
          const model = String(body.model ?? '').trim().slice(0, 120);
          if (model) return send(await kernel.llm.ping(b, model));
          const base = String(pc.baseUrl ?? '').trim().replace(/\/+$/, '');
          if (!base) return send({ ok: false, error: '未配置 Base URL' });
          if (pc.protocol === 'anthropic') {
            return send({ ok: false, error: 'Anthropic 没有模型列表接口，请用模型行上的「测试连接」逐个验证' });
          }
          const key = kernel.config.getProviderKey(b);
          return send(await listRemoteModels(base, key, String(pc.protocol ?? 'openai-compatible')));
        }
        if (typeof body.model === 'string' && body.model) {
          const want = (pc.models ?? []).find((x: any) => x.id === body.model.trim());
          if (want?.enabled === false) return send({ error: '该模型已停用，先启用才能设为当前使用' }, 400);
        }
        if (typeof body.enabled === 'boolean') pc.enabled = body.enabled;
        if (typeof body.baseUrl === 'string') pc.baseUrl = body.baseUrl.trim().slice(0, 300);
        if (typeof body.label === 'string' && body.label.trim()) pc.label = body.label.trim().slice(0, 40);
        if (typeof body.protocol === 'string' && PROVIDER_PROTOCOLS.includes(body.protocol)) pc.protocol = body.protocol;
        if (Array.isArray(body.models)) {
          pc.models = sanitizeModels(body.models);
          const usable = pc.models.filter((m) => m.enabled !== false).map((m) => m.id);
          if (pc.model && !usable.includes(pc.model)) pc.model = usable[0] ?? pc.model;
        }
        if (typeof body.model === 'string' && body.model) pc.model = body.model.trim().slice(0, 120);
        if (pc.model) kernel.config.config.llm.modelByProvider[b] = pc.model;
        kernel.config.saveConfig();
        if (typeof body.apiKey === 'string') kernel.config.setProviderKey(b, body.apiKey.trim());
        return send({ ok: true });
      }
    }

    // ================= 记忆 =================
    if (area === 'api' && a === 'memory') {
      if (!b) return send(kernel.memory.listUsers());
      if (b === 'export') {
        const users = kernel.memory.listUsers();
        return send({
          exportedAt: new Date().toISOString(),
          users: users.map((u) => ({
            ...u,
            facts: kernel.memory.topFacts(u.userId, 1000),
            attrs: kernel.memory.allAttrs(u.userId),
          })),
        });
      }
      if (b === 'import' && req.method === 'POST') {
        let n = 0;
        for (const u of (body.users ?? []) as any[]) {
          if (!u.userId) continue;
          kernel.memory.touchUser(u.userId, u.nickname);
          for (const f of u.facts ?? []) kernel.memory.addFact(u.userId, { content: f.content, weight: f.weight });
          for (const [k, v] of Object.entries(u.attrs ?? {})) {
            // 好感度那套属性键（含心情）已从系统里删除，老导出文件里可能还带着，导进来也没人读
            if (k !== 'affection' && k !== 'affection_daily' && k !== 'affection_last_ts' && k !== 'mood') {
              kernel.memory.setAttr(u.userId, k, v);
            }
          }
          n++;
        }
        return send({ ok: true, users: n });
      }
      if (b === 'user' && c) {
        const id = c;
        if (req.method === 'GET') {
          const q = url.searchParams.get('q');
          return send({
            profile: kernel.memory.getProfile(id),
            facts: q ? kernel.memory.searchFacts(id, q, 50) : kernel.memory.topFacts(id, 100),
            attrs: kernel.memory.allAttrs(id),
          });
        }
        if (url.pathname.endsWith('/forget') && req.method === 'POST') {
          kernel.memory.forget(id);
          return send({ ok: true });
        }
        if (req.method === 'POST' && body.content) {
          kernel.memory.addFact(id, { content: String(body.content), sourcePlugin: 'ui' });
          return send({ ok: true });
        }
      }
      if (b === 'fact' && req.method === 'POST') {
        const { userId, id, content } = body;
        if (content !== undefined && id) kernel.memory.updateFact(String(userId), String(id), String(content));
        else if (id) kernel.memory.deleteFacts(String(userId), [String(id)]);
        return send({ ok: true });
      }
      if (b === 'ops') {
        const who = url.searchParams.get('user');
        return send(kernel.memory.recentOps(who ? 500 : 200, who ?? undefined));
      }
    }

    // ================= 用户 =================
    // 权限名单的群聊批量添加：群列表 / 群成员（都走协议端现拉，不落库）
    if (area === 'api' && a === 'groups' && !b && req.method === 'GET') {
      return send({ groups: await kernel.adapter.listGroups() });
    }
    if (area === 'api' && a === 'groups' && b && c === 'members' && req.method === 'GET') {
      return send({ members: await kernel.adapter.listGroupMembers(String(b)) });
    }
    if (area === 'api' && a === 'users' && !b && req.method === 'GET') {
      const users = kernel.memory.listUsers().map((u) => ({
        ...u,
        isMaster: kernel.config.isOwner(u.userId),
        isAdmin: kernel.config.isAdmin(u.userId),
      }));
      return send({ users, masterIds: kernel.config.config.masterIds, extraAdminIds: kernel.config.config.extraAdminIds });
    }
    if (area === 'api' && a === 'users' && b && c) {
      if (c === 'block') { kernel.memory.setBlocked(String(b), !!body.blocked); return send({ ok: true }); }
      if (c === 'remark') { kernel.memory.setRemark(String(b), String(body.remark ?? '')); return send({ ok: true }); }
    }
    if (area === 'api' && a === 'users' && req.method === 'POST') {
      // masterIds / extraAdminIds 管理
      if (Array.isArray(body.masterIds)) kernel.config.config.masterIds = body.masterIds.map(String);
      if (Array.isArray(body.extraAdminIds)) kernel.config.config.extraAdminIds = body.extraAdminIds.map(String);
      kernel.config.saveConfig();
      return send({ ok: true });
    }

    // ================= 报错中心 =================
    if (area === 'api' && a === 'errors') {
      if (!b && req.method === 'GET') return send(kernel.errors.list());
      if (b === 'clear' && req.method === 'POST') { kernel.errors.clear(); return send({ ok: true }); }
    }

    // ================= work 子代理 =================
    if (area === 'api' && a === 'work') {
      // 「工作」页：任务运行记录 + 模型链标识 + 常驻容器状态
      if (!b) {
        // chatKey 给了就只回该会话的任务（会话页右侧「工作」抽屉按当前会话拉）
        const chatKey = url.searchParams.get('chatKey') || undefined;
        const userId = url.searchParams.get('userId') || undefined;
        const runs = kernel.workRunner.list(Number(url.searchParams.get('limit') ?? 40), chatKey);
        return send({
          // userId 只筛该发起人自己的运行（同一个群里每个人是独立的 work 会话）；不传 = 本群全部
          runs: userId ? runs.filter((r: any) => String(r.userId ?? '') === userId) : runs,
          models: { chat: kernel.llm.servingLabel('chat'), work: kernel.llm.servingLabel('work') },
          containers: kernel.session.status(),
          images: kernel.session.imagesAvailable(),
          docker: kernel.session.available(),
        });
      }
      if (b === 'reset' && req.method === 'POST') {
        // 重置某会话的常驻容器（状态化 Python / 浏览器）
        const m = String(body.chatKey ?? '').match(/^(group|private)_(.+)$/);
        if (m) await kernel.session.reset({ platform: 'qq', type: m[1] as 'group', chatId: m[2] });
        return send({ ok: true });
      }
      return send({ error: 'not found' }, 404);
    }

    if (area === 'api' && a === 'sandbox') {
      const ref = (key: unknown): ChatRef | null => {
        const m = String(key ?? '').match(/^(group|private)_(.+)$/);
        return m ? { platform: 'qq', type: m[1] as 'group' | 'private', chatId: m[2] } : null;
      };
      if (!b) return send({ stats: kernel.sandbox.stats(), config: kernel.config.config.sandbox });
      if (b === 'files' || b === 'read') {
        const chat = ref(url.searchParams.get('chat'));
        if (!chat) return send({ error: 'chatKey 不合法' }, 400);
        if (b === 'files') {
          const w = kernel.sandbox.walkFiles(chat);
          return send({ entries: w.files, truncated: w.truncated });
        }
        const r = kernel.sandbox.preview(chat, url.searchParams.get('path') || '.');
        return send(r ? { kind: 'text', ...r } : { kind: 'binary' });
      }
      if (b === 'raw') {
        const chat = ref(url.searchParams.get('chat'));
        if (!chat) return send({ error: 'chatKey 不合法' }, 400);
        let f;
        try {
          f = kernel.sandbox.rawInline(chat, url.searchParams.get('path') || '');
        } catch (e) {
          const m = (e as Error).message;
          // 会话流里的消息会一直留着，图却早被 TTL 清掉了：取不到是正常结局（前端静默不占位），
          // 别让它进报错中心——开一次会话页就能灌十几条。越界与非法类型仍照原样抛。
          if (m.startsWith('文件不存在') || m.startsWith('不支持内联预览的类型')) return send({ error: m }, 404);
          throw e;
        }
        // 内联只给白名单类型；nosniff + 空 CSP 兜住「把这个文件当文档解析」的走法
        const heads: Record<string, string | number> = {
          'content-type': f.mime,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; script-src 'none'",
          'content-disposition': 'inline',
          // 语音/视频要能拖进度条（<video>/<audio> 靠 Range 分段取），图片也一并声明
          'accept-ranges': 'bytes',
        };
        if (!f.stream) {
          res.writeHead(200, { ...heads, 'content-length': f.size });
          res.end(readFileSync(f.abs));
          return;
        }
        const rng = typeof req.headers.range === 'string' ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
        if (rng && (rng[1] || rng[2])) {
          const start = rng[1] ? Number(rng[1]) : 0;
          const end = Math.min(rng[2] ? Number(rng[2]) : f.size - 1, f.size - 1);
          if (Number.isNaN(start) || start < 0 || start > end || end >= f.size) {
            res.writeHead(416, { 'content-range': `bytes */${f.size}` });
            res.end();
            return;
          }
          res.writeHead(206, { ...heads, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${f.size}` });
          createReadStream(f.abs, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, { ...heads, 'content-length': f.size });
        createReadStream(f.abs).pipe(res);
        return;
      }
      if (b === 'clear' && req.method === 'POST') {
        const chat = ref(body.chatKey);
        if (chat) kernel.sandbox.clear(chat);
        return send({ ok: true });
      }
      if (b === 'open' && req.method === 'POST') {
        const chat = ref(body.chatKey);
        if (!chat) return send({ error: 'chatKey 不合法' }, 400);
        return send({ ok: true, action: kernel.sandbox.handOff(chat, String(body.path ?? '')) });
      }
      if (b === 'config' && req.method === 'POST') {
        const s = kernel.config.config.sandbox as any;
        for (const k of ['ttlHours', 'inboxTtlHours', 'maxFileBytes', 'maxSessionBytes', 'execTimeoutPythonMs', 'execTimeoutJsMs', 'maxRunsPerMin']) {
          if (typeof body[k] === 'number') s[k] = body[k];
        }
        kernel.config.saveConfig();
        return send({ ok: true });
      }
    }

    // ================= 内核配置（风控/接入） =================
    if (area === 'api' && a === 'config') {
      if (!b && req.method === 'GET') {
        return send({
          risk: kernel.config.config.risk,
          llm: kernel.config.config.llm,
          onebot: { ...kernel.config.config.onebot, hasToken: !!kernel.config.secrets.onebotAccessToken, llbot: kernel.config.config.onebot.llbot },
          ui: kernel.config.config.ui,
          persona: kernel.config.config.persona,
          humanlike: kernel.config.config.humanlike,
          // work 子代理（pi 内核那套）：agent 定义 / 子代理目录 / 嵌套上限 / 上下文压缩
          work: kernel.config.config.work,
          storage: kernel.config.config.storage,
          // 收件文件保留：内核按小时存（sweep 用），界面按天给
          sandbox: { inboxKeepDays: Math.max(1, Math.round(kernel.config.config.sandbox.inboxTtlHours / 24)) },
        });
      }
      if (!b && req.method === 'POST') {
        const cfg = kernel.config.config as any;
        // 风控走白名单：这一段只剩 3 个键，逐项收。曾删掉的 jitter / groupWake / wakeWords / forgetScope
        // 要是被旧页面或脚本带回来，整段 Object.assign 会把它们写回配置文件变成死配置。
        if (body.risk && typeof body.risk === 'object') {
          const r = body.risk as Record<string, unknown>;
          if ('replyRatePerMin' in r) {
            const n = Number(r.replyRatePerMin);
            if (!Number.isInteger(n) || n < 1 || n > 600) return send({ error: '每会话发言上限需要是 1~600 的整数' }, 400);
            cfg.risk.replyRatePerMin = n;
          }
          if ('silentWhenNothingEnabled' in r) cfg.risk.silentWhenNothingEnabled = !!r.silentWhenNothingEnabled;
          // forgetScope（忘记记忆权限）不走这里——界面入口已删、默认 admin_only，只认 config.json 手改（重启生效）
          // proactive 是插件定时推送的显式开启，逐个插件 id 收；其它键一律忽略
          if (r.proactive && typeof r.proactive === 'object') {
            for (const [id, on] of Object.entries(r.proactive as Record<string, unknown>)) {
              if (!/^[\w-]{1,64}$/.test(id)) continue;
              cfg.risk.proactive[id] = !!on;
            }
          }
        }
        for (const section of ['onebot', 'persona'] as const) {
          if (body[section] && typeof body[section] === 'object') {
            // onebot.llbot / onebot.napcat 嵌套合并，避免浅覆盖丢字段；
            // flavor（协议端）不走这里——换端只认 config.json 手改（重启内核生效），API/界面都没有切换入口
            if (section === 'onebot') {
              const { llbot, napcat, flavor, ...rest } = body.onebot;
              Object.assign(cfg.onebot, rest);
              // 两端各自的子块只收这几项，端口必须是数（拼进 URL 用），路径去空白
              for (const [key, patch] of [['llbot', llbot], ['napcat', napcat]] as const) {
                if (!patch || typeof patch !== 'object') continue;
                const cur = cfg.onebot[key] as Record<string, unknown>;
                const p = patch as Record<string, unknown>;
                if (typeof p.qqPath === 'string') cur.qqPath = p.qqPath.trim().slice(0, 260);
                if (key === 'llbot' && (p.mode === 'pmhq' || p.mode === 'direct')) cur.mode = p.mode;
                if (key === 'napcat' && Number.isInteger(p.webuiPort) && (p.webuiPort as number) > 0 && (p.webuiPort as number) < 65536) {
                  cur.webuiPort = p.webuiPort;
                }
              }
            } else {
              // persona 走逐键白名单：整段 assign 会让过期页面把已删除的键（好感度那套、注入 Top-K）写回配置
              const p = body[section] as Record<string, unknown>;
              if (typeof p.default === 'string' && /^[\w-]{1,64}$/.test(p.default.trim())) cfg.persona.default = p.default.trim();
              if (typeof p.memoryAutoSave === 'boolean') (cfg.persona as any).memoryAutoSave = p.memoryAutoSave;
              for (const [k, lo, hi] of [['memoryMinTurns', 2, 40], ['memoryIdleSeconds', 10, 3600], ['memoryMaxFacts', 1, 10]] as const) {
                const n = Number(p[k]);
                if (Number.isFinite(n)) (cfg.persona as any)[k] = Math.min(hi, Math.max(lo, Math.round(n)));
              }
              if (typeof p.profileAuto === 'boolean') (cfg.persona as any).profileAuto = p.profileAuto;
              if (typeof p.midtermSummary === 'boolean') (cfg.persona as any).midtermSummary = p.midtermSummary;
            }
          }
        }
        // ui 只放行预期 bot 账号（有头模式的安全开关，见 adapter 账号守卫）；端口/偏好等不走这里
        if (typeof body.expectedQq === 'string') {
          const qq = body.expectedQq.trim();
          if (qq && !/^\d{5,12}$/.test(qq)) return send({ error: 'expectedQq 必须是 QQ 号' }, 400);
          cfg.ui.expectedQq = qq;
        }
        // ui 段只放行会话页预览开关；端口/登录号/会话偏好不走这里
        if (body.ui && typeof body.ui === 'object' && 'chatPreview' in (body.ui as object)) {
          cfg.ui.chatPreview = !!(body.ui as Record<string, unknown>).chatPreview;
        }
        // llm 段只放行掉线阈值：模型链本身走 /api/providers/chain。
        // （chat 工具轮上限 maxToolRounds 已删——chat 轮两轮硬上限是产品决定，不是旋钮。）
        if (body.llm && typeof body.llm === 'object') {
          if ((body.llm as any).failoverThreshold !== undefined) {
            const n = Number((body.llm as any).failoverThreshold);
            if (!Number.isFinite(n) || n < 1 || n > 10) return send({ error: '掉线阈值需要是 1~10 的整数' }, 400);
            cfg.llm.failoverThreshold = Math.round(n);
            kernel.llm.resetFailover();
          }
        }
        // storage 段：每会话历史条数（HistoryStore 环形缓冲真正读的键），保存后立即生效
        if (body.storage && typeof body.storage === 'object') {
          const st = body.storage as Record<string, unknown>;
          if (st.historyLimit !== undefined) {
            const n = Number(st.historyLimit);
            if (!Number.isInteger(n) || n < 1 || n > 500) return send({ error: '每会话历史条数需要是 1~500 的整数' }, 400);
            cfg.storage.historyLimit = n;
            kernel.history.setLimit(n);
          }
          // 上下文时间窗（分钟）：模型只看最近这么多分钟的消息，与 historyLimit 条数上限同时生效。
          // 这里只挡非有限数；范围交给 round+clamp，好让旧配置与页面控件的越界值都能安全落库而不必 400
          if (st.contextMinutes !== undefined) {
            const n = Number(st.contextMinutes);
            if (!Number.isFinite(n)) return send({ error: '上下文时间窗需要是 1~720 的整数' }, 400);
            cfg.storage.contextMinutes = Math.min(720, Math.max(1, Math.round(n)));
          }
        }
        // sandbox 段：只放收件文件保留天数（内核存小时，sweep 每 10 分钟读一次配置，存完即生效）；
        // 其余限额（单文件/会话上限、执行超时等）仍走沙箱页「限额与清理」弹窗
        if (body.sandbox && typeof body.sandbox === 'object') {
          const s = body.sandbox as Record<string, unknown>;
          if (s.inboxKeepDays !== undefined) {
            const n = Number(s.inboxKeepDays);
            if (!Number.isInteger(n) || n < 1 || n > 90) return send({ error: '收件文件保留天数需要是 1~90 的整数' }, 400);
            cfg.sandbox.inboxTtlHours = n * 24;
            // work 档的收件文件跟着同一天数：一个旋钮说"收进来的文件留 N 天"，就别让另一档悄悄更早删
            cfg.sandbox.workInboxTtlHours = n * 24;
          }
        }
        // humanlike 段：逐字段白名单 + 范围钳制（页面控件的取值范围在服务端也要成立）
        if (body.humanlike && typeof body.humanlike === 'object') {
          const err = applyHumanlikeConfig(cfg.humanlike, body.humanlike as Record<string, unknown>);
          if (err) return send({ error: err }, 400);
        }
        // work 段（pi 内核那套）：只是几个数字与路径，逐项校验
        if (body.work && typeof body.work === 'object') {
          const w = body.work as Record<string, unknown>;
          if (typeof w.agent === 'string') cfg.work.agent = w.agent.trim().slice(0, 120);
          if (typeof w.agentsDir === 'string') cfg.work.agentsDir = w.agentsDir.trim().slice(0, 260);
          if ('maxDepth' in w) {
            const n = Number(w.maxDepth);
            if (!Number.isInteger(n) || n < 0 || n > 5) return send({ error: '子代理嵌套上限需要是 0~5 的整数' }, 400);
            cfg.work.maxDepth = n;
          }
          const comp = w.compaction as Record<string, unknown> | undefined;
          if (comp && typeof comp === 'object') {
            if ('enabled' in comp) cfg.work.compaction.enabled = !!comp.enabled;
            for (const [k, min, max, label] of [
              ['reserveTokens', 1024, 200000, '预留 token'],
              ['keepRecentTokens', 0, 400000, '保留原文 token'],
            ] as const) {
              if (!(k in comp)) continue;
              const n = Number(comp[k]);
              if (!Number.isFinite(n) || n < min || n > max) return send({ error: `${label}需要是 ${min}~${max}` }, 400);
              cfg.work.compaction[k] = Math.round(n);
            }
          }
        }
        kernel.config.saveConfig();
        kernel.chat.setRatePerMin(kernel.config.config.risk.replyRatePerMin);
        return send({ ok: true });
      }
    }

    // ================= 拟人层状态（排障：这个群现在为什么不出声） =================
    if (area === 'api' && a === 'humanlike' && b === 'status' && req.method === 'GET') {
      const m = String(url.searchParams.get('chatKey') ?? '').match(/^(group|private)_(.+)$/);
      if (!m) return send({ error: 'chatKey 不合法' }, 400);
      const chat = { platform: 'qq', type: m[1] as 'group' | 'private', chatId: m[2] };
      return send({
        chatKey: m[0],
        ...kernel.humanlike.snapshot(chat),
        config: kernel.config.config.humanlike,
      });
    }

    // ================= 适配器动作 =================
    if (area === 'api' && a === 'adapter' && b === 'refresh-groups' && req.method === 'POST') {
      await kernel.adapter.refreshGroupNames().catch((e) => send({ error: (e as Error).message }, 500));
      return send({ groups: Object.fromEntries([...(kernel.adapter as any).groupNames?.entries?.() ?? []]) });
    }

    return send({ error: `未找到接口 ${path}` }, 404);
  } catch (e) {
    kernel.errors.record('error', 'kernel', `API ${path} 失败: ${(e as Error).message}`, { stack: (e as Error).stack });
    return send({ error: (e as Error).message }, 500);
  }
}

/** 拟人化配置的入参白名单：逐字段校验 + 范围钳制，非法值直接拒绝（不静默取默认）。 */
function applyHumanlikeConfig(target: Record<string, any>, body: Record<string, unknown>): string | undefined {
  const num = (v: unknown, min: number, max: number, label: string): number | string => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return `${label}需要是 ${min}~${max} 之间的数`;
    return n;
  };
  const applyNum = (obj: Record<string, any>, src: Record<string, unknown>, key: string, min: number, max: number, label: string): string | undefined => {
    if (!(key in src)) return;
    const r = num(src[key], min, max, label);
    if (typeof r === 'string') return r;
    obj[key] = r;
  };
  const applyBool = (obj: Record<string, any>, src: Record<string, unknown>, key: string): void => {
    if (key in src) obj[key] = !!src[key];
  };

  // 刻意没有 `enabled` 总开关：拟人化不是可关的功能，POST 里带这个键也不认（直接忽略）。
  // 各子项（节奏/行动容量/日程…）仍是独立开关，逐项收；2026-10-17 删掉的剧本体与情绪偏移
  // 不再收任何键——老桌面端标签页回放旧表单也写不回来。

  // 圈内黑话（表达学习）
  const jargon = body.jargon as Record<string, unknown> | undefined;
  if (jargon && typeof jargon === 'object') applyBool(target.jargon, jargon, 'enable');

  // 表达学习（chat 插件后台）：页面只给开关，批次阈值走代码默认值
  const expression = body.expression as Record<string, unknown> | undefined;
  if (expression && typeof expression === 'object') applyBool(target.expression, expression, 'enable');

  // 重复惩罚：开关 + 三个数值（窗口/判定条数/冷却）；重写与熔断走代码默认
  const repetition = body.repetition as Record<string, unknown> | undefined;
  if (repetition && typeof repetition === 'object') {
    const t = target.repetition;
    applyBool(t, repetition, 'enable');
    let e = applyNum(t, repetition, 'windowMessages', 5, 100, '重复判定窗口'); if (e) return e;
    e = applyNum(t, repetition, 'minMessages', 2, 10, '重复判定条数'); if (e) return e;
    e = applyNum(t, repetition, 'cooldownMinutes', 5, 240, '重复冷却分钟'); if (e) return e;
    if (t.minMessages > t.windowMessages) t.minMessages = t.windowMessages;
  }

  // 跟屏复读（纯程序段）：开关 + 条数/秒数/冷却逐键收，范围在服务端也成立
  const repeat = body.repeat as Record<string, unknown> | undefined;
  if (repeat && typeof repeat === 'object') {
    const t = target.repeat as {
      enable: boolean; minPeople: number; delayMaxSec: number; cooldownMin: number;
    };
    applyBool(t, repeat, 'enable');
    if ('minPeople' in repeat) t.minPeople = Math.min(20, Math.max(2, Math.round(Number(repeat.minPeople) || 4)));
    if ('delayMaxSec' in repeat) t.delayMaxSec = Math.min(30, Math.max(1, Math.round(Number(repeat.delayMaxSec) || 4)));
    if ('cooldownMin' in repeat) t.cooldownMin = Math.min(120, Math.max(0, Math.round(Number(repeat.cooldownMin) || 3)));
  }

  // 戳一戳（chat 工具）：开关 + 最小间隔/小时上限
  const poke = body.poke as Record<string, unknown> | undefined;
  if (poke && typeof poke === 'object') {
    const t = target.poke as { enable: boolean; minIntervalSeconds: number; maxPerHour: number };
    applyBool(t, poke, 'enable');
    if ('minIntervalSeconds' in poke) t.minIntervalSeconds = Math.min(3600, Math.max(0, Math.round(Number(poke.minIntervalSeconds) || 0)));
    if ('maxPerHour' in poke) t.maxPerHour = Math.min(120, Math.max(0, Math.round(Number(poke.maxPerHour) || 0)));
  }

  // 节奏反定型（HDSI ChatRhythm）
  const rhythm = body.rhythm as Record<string, unknown> | undefined;
  if (rhythm && typeof rhythm === 'object') {
    const t = target.rhythm;
    applyBool(t, rhythm, 'enable');
    if ('mode' in rhythm) {
      if (!['gentle', 'balanced', 'aggressive'].includes(String(rhythm.mode))) return '节奏反定型档位只能是 gentle/balanced/aggressive';
      t.mode = rhythm.mode;
    }
    let e = applyNum(t, rhythm, 'historyLimit', 5, 20, '节奏窗口轮数'); if (e) return e;
    e = applyNum(t, rhythm, 'collapseMinSamples', 3, 10, '定型判定样本数'); if (e) return e;
    e = applyNum(t, rhythm, 'exhaustLimit', 3, 12, '熔断轮数'); if (e) return e;
  }

  // 行动窗口（HDSI Agency）
  const agency = body.agency as Record<string, unknown> | undefined;
  if (agency && typeof agency === 'object') {
    const t = target.agency;
    applyBool(t, agency, 'enable');
    if ('quietHours' in agency) {
      const q = String(agency.quietHours ?? '').trim();
      if (q && !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(q)) return '安静时段要写成 HH:MM-HH:MM';
      t.quietHours = q;
    }
    let e = applyNum(t, agency, 'minimumProactiveIntervalMinutes', 0, 1440, '主动最小间隔'); if (e) return e;
    e = applyNum(t, agency, 'maxWindowMinutes', 5, 1440, '窗口有效期'); if (e) return e;
    e = applyNum(t, agency, 'maxCandidateHours', 1, 168, '候选前瞻时长'); if (e) return e;
  }

  // 日程（HDSI Schedule Preplan）
  const schedule = body.schedule as Record<string, unknown> | undefined;
  if (schedule && typeof schedule === 'object') {
    const t = target.schedule;
    applyBool(t, schedule, 'enable');
    let e = applyNum(t, schedule, 'horizonHours', 1, 72, '日程前瞻时长'); if (e) return e;
    e = applyNum(t, schedule, 'maxRules', 1, 100, '周规律上限'); if (e) return e;
    e = applyNum(t, schedule, 'maxExceptions', 1, 200, '例外上限'); if (e) return e;
  }

  // 出站投递（纯程序）：按句分条 + 句边截断 + 打字节奏 + 单条长度上限
  const outgoing = body.outgoing as Record<string, unknown> | undefined;
  if (outgoing && typeof outgoing === 'object') {
    const t = target.outgoing;
    applyBool(t, outgoing, 'splitReplyMessages');
    applyBool(t, outgoing, 'typingEnabled');
    let e = applyNum(t, outgoing, 'replyMaxCharacters', 20, 2000, '回复最长字符数'); if (e) return e;
    e = applyNum(t, outgoing, 'maxReplyTokens', 0, 8000, '回复 token 上限'); if (e) return e;
    e = applyNum(t, outgoing, 'bubbleSoftMaxCharacters', 10, 80, '单条气泡目标字数'); if (e) return e;
    e = applyNum(t, outgoing, 'typingBaseDelaySeconds', 0, 60, '打字基础延迟'); if (e) return e;
    e = applyNum(t, outgoing, 'typingCharactersPerSecond', 1, 100, '打字速度'); if (e) return e;
    e = applyNum(t, outgoing, 'typingMaxDelaySeconds', 0, 120, '单条最长打字等待'); if (e) return e;
    e = applyNum(t, outgoing, 'typingJitterRatio', 0, 0.5, '打字抖动比例'); if (e) return e;
    e = applyNum(t, outgoing, 'maxMessageCharacters', 1, 12000, '单条最大字符数'); if (e) return e;
  }

  const timing = body.timing as Record<string, unknown> | undefined;
  if (timing && typeof timing === 'object') {
    const t = target.timing;
    if ('replyTriggerMode' in timing) {
      if (timing.replyTriggerMode !== 'likelihood' && timing.replyTriggerMode !== 'necessity' && timing.replyTriggerMode !== 'frequency') {
        return '回复触发模式只能是 likelihood 或 necessity 或 frequency';
      }
      t.replyTriggerMode = timing.replyTriggerMode;
    }
    applyBool(t, timing, 'mentionedBotReply');
    applyBool(t, timing, 'inevitableAtReply');
    applyBool(t, timing, 'focusMode');
    applyBool(t, timing, 'enableRules');
    let e = applyNum(t, timing, 'pendingThreshold', 1, 100, '条数阈值'); if (e) return e;
    e = applyNum(t, timing, 'necessityThreshold', 0, 200, '必要性阈值'); if (e) return e;
    e = applyNum(t, timing, 'talkValue', 0, 1, '群聊频率'); if (e) return e;
    e = applyNum(t, timing, 'privateTalkValue', 0, 1, '私聊频率'); if (e) return e;
    if (Array.isArray(timing.rules)) {
      const rules: Record<string, unknown>[] = [];
      for (const raw of timing.rules as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const type = String(r.ruleType ?? 'any');
        if (!['group', 'private', 'any'].includes(type)) return '频率规则的聊天类型只能是 group/private/any';
        const value = Number(r.value);
        if (!Number.isFinite(value) || value < 0 || value > 1) return '频率规则的频率需要是 0~1';
        const time = String(r.time ?? '').trim();
        if (time && time !== '*' && !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(time)) {
          return '频率规则的时段要写成 HH:MM-HH:MM、* 或留空';
        }
        rules.push({
          platform: String(r.platform ?? '').trim().slice(0, 32),
          itemId: String(r.itemId ?? '').trim().slice(0, 64),
          ruleType: type as 'group' | 'private' | 'any',
          time,
          value,
        });
      }
      t.rules = rules;
    }
  }

  // 出站打断（纯程序）：她还在发气泡时对面又开口，按概率把剩下的气泡砍掉
  const interrupt = body.interrupt as Record<string, unknown> | undefined;
  if (interrupt && typeof interrupt === 'object') {
    const t = target.interrupt;
    applyBool(t, interrupt, 'enable');
    const e = applyNum(t, interrupt, 'probability', 0, 1, '打断概率'); if (e) return e;
  }

  const merge = body.merge as Record<string, unknown> | undefined;
  if (merge && typeof merge === 'object') {
    const t = target.merge;
    applyBool(t, merge, 'enable');
    let e = applyNum(t, merge, 'windowMs', 0, 60_000, '合并窗口'); if (e) return e;
    e = applyNum(t, merge, 'maxWaitMs', 0, 300_000, '合并兜底上限'); if (e) return e;
    e = applyNum(t, merge, 'bufferTtlMs', 0, 3_600_000, '攒货过期时间'); if (e) return e;
    e = applyNum(t, merge, 'fireDelayMinMs', 0, 10_000, '起跳随机延时下限'); if (e) return e;
    e = applyNum(t, merge, 'fireDelayMaxMs', 0, 10_000, '起跳随机延时上限'); if (e) return e;
    if (t.fireDelayMaxMs < t.fireDelayMinMs) t.fireDelayMaxMs = t.fireDelayMinMs;
  }

  const backoff = body.backoff as Record<string, unknown> | undefined;
  if (backoff && typeof backoff === 'object') {
    const t = target.backoff;
    let e = applyNum(t, backoff, 'baseSeconds', 0, 600, '退避基准'); if (e) return e;
    e = applyNum(t, backoff, 'capSeconds', 0, 3600, '退避上限'); if (e) return e;
    e = applyNum(t, backoff, 'startCount', 1, 50, '退避起点'); if (e) return e;
    e = applyNum(t, backoff, 'bypassPendingCount', 0, 200, '退避绕过条数'); if (e) return e;
  }

  const proactive = body.proactive as Record<string, unknown> | undefined;
  if (proactive && typeof proactive === 'object') {
    const t = target.proactive;
    applyBool(t, proactive, 'enable');
    const e = applyNum(t, proactive, 'idleSeconds', 60, 86_400, '主动发言静默时长'); if (e) return e;
  }
  return undefined;
}

function serveStatic(root: string, path: string, res: ServerResponse): void {  let rel = path === '/' ? '/index.html' : path;
  const file = normalize(join(root, rel));
  if (!file.startsWith(normalize(root))) {
    res.writeHead(403); res.end(); return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback
    const index = join(root, 'index.html');
    if (existsSync(index)) { sendHtml(res, index); return; }
    res.writeHead(404); res.end('UI 未找到（ui/index.html 缺失）');
    return;
  }
  if (extname(file) === '.html') { sendHtml(res, file); return; }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  // 带内容哈希的 _next 资源长缓存；其余不缓存
  const cache = file.includes('_next') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(file).pipe(res);
}

/** HTML 不缓存，并把这份产物的落盘时间注进页面：前端据此发现"我跑的是旧构建" */
function sendHtml(res: ServerResponse, file: string): void {
  const stamp = Math.round(statSync(file).mtimeMs);
  const tag = `<script>window.__UI_BUILD__=${stamp}</script>`;
  const html = readFileSync(file, 'utf8').replace('<head>', '<head>' + tag);
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
  res.end(html.includes('__UI_BUILD__') ? html : tag + html);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf-8');
      if (!s) return resolveP({});
      try { resolveP(JSON.parse(s)); } catch { resolveP({}); }
    });
    req.on('error', reject);
  });
}

/** QQ 公开头像（40 尺寸：登录卡片展示足够） */
function avatarUrl(qq: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=40`;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
