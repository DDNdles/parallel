import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Kernel } from '../kernel.ts';
import type { ModelRef, ProviderModelCfg } from '../config.ts';
import { newId } from '../util/misc.ts';
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

const PROVIDER_PROTOCOLS = ['openai-compatible', 'openai-responses', 'anthropic', 'mock'];
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
async function listRemoteModels(base: string, key: string) {
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

async function handle(kernel: Kernel, uiRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // ---- 静态 UI ----
  if (!path.startsWith('/api/') && !path.startsWith('/ws')) {
    serveStatic(uiRoot, path, res);
    return;
  }

  // ---- 鉴权 ----
  // 登录页接口免 uiToken：浏览器尚未持有 token 时就要用（status/qrcode/avatar），
  // 仅暴露登录状态与二维码，不含会话/配置等敏感数据；其余 /api/* 一律要求 token。
  const pathIsLoginApi = path.startsWith('/api/login/');
  const token = req.headers['x-auth-token'] ?? url.searchParams.get('token') ?? '';
  if (!pathIsLoginApi && token !== kernel.config.secrets.uiToken) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const body = await readBody(req).catch(() => ({}));
  const segments = path.split('/').filter(Boolean); // ['api', ...]
  const send = (data: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
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
      if (b === 'status') {
        return send({
          // 登错号（见 adapter 账号守卫）不算"可用"：登录页据此把原因显示出来，而不是当作已登录
          connected: !!st.connected && !st.accountBlocked,
          qq: selfId,
          nickname: selfNickname,
          avatar: selfId ? avatarUrl(selfId) : '',
          lastLogin: kernel.config.config.ui.lastLogin,
          expectedQq: st.expectedQq || '',
          accountBlocked: st.accountBlocked,
          protocol: kernel.config.config.onebot.flavor ?? 'llbot',
          end: kernel.protocolEnd().status(),
        });
      }
      if (b === 'protocol' && req.method === 'POST') {
        const to = String(body.flavor ?? '');
        if (to !== 'llbot' && to !== 'napcat') return send({ error: 'flavor 只能是 llbot 或 napcat' }, 400);
        const other = to === 'napcat' ? kernel.llbot : kernel.napcat;
        kernel.config.config.onebot.flavor = to;
        kernel.config.saveConfig();
        // 换端必须先把上一个停掉：两个协议端注入同一个 QQ / 抢同一条反向 WS 只会互相踩登录态
        await other.stop().catch(() => {});
        const end = kernel.protocolEnd();
        if (kernel.managesEnd()) void end.start().catch((e) => {
          kernel.errors.record('error', 'adapter', `${end.id} 托管启动失败: ${(e as Error).message}`, { notifyOwner: true });
        });
        return send({ ok: true, protocol: to, status: end.status() });
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
        // 双模型架构：chat 用哪个、work 用哪个（桌面端「工作」页展示）
        workModel: kernel.llm.workModelSplit(),
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
      if (c === 'log') {
        const limit = Number(url.searchParams.get('limit') ?? 800);
        return send({ entries: kernel.sessionLog.readFromDisk(b, limit) });
      }
      if (c === 'send' && req.method === 'POST') {
        // 以 bot 身份发言
        await kernel.chat.sendText(chat, String(body.text ?? ''));
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
              personas.push({
                id, pluginId: lp.manifest.id,
                card: safeJson(read('card.json')), fewshot: safeJson(read('fewshot.json')), lore: safeJson(read('lorebook.json')),
                raw: {
                  'card.json': read('card.json'), 'fewshot.json': read('fewshot.json'), 'lorebook.json': read('lorebook.json'),
                },
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
          // 两条模型优先级链（靠前的优先，掉线自动接后一个）；work 为空 = 跟随 chat
          chains: kernel.llm.chainsView(),
          failoverThreshold: kernel.config.config.llm.failoverThreshold,
        });
      }
      if (b === 'chain' && req.method === 'POST') {
        const kind = String(body.kind ?? '');
        if (kind !== 'chat' && kind !== 'work') return send({ error: 'kind 需要是 chat 或 work' }, 400);
        const raw = Array.isArray(body.entries) ? body.entries.slice(0, 20) : [];
        const entries: ModelRef[] = [];
        for (const e of raw) {
          const pid = String((e as any)?.provider ?? '').trim().slice(0, 80);
          const model = String((e as any)?.model ?? '').trim().slice(0, 120);
          if (!pid || !model) return send({ error: '链上的每条都要有供应商与模型名' }, 400);
          if (!allProviders[pid]) return send({ error: `未知供应商 ${pid}` }, 400);
          if (!entries.some((x) => x.provider === pid && x.model === model)) entries.push({ provider: pid, model });
        }
        if (kind === 'chat' && !entries.length) return send({ error: '聊天模型至少要留一条' }, 400);
        const llm = kernel.config.config.llm;
        if (kind === 'chat') {
          llm.chatChain = entries;
          if (entries.length) llm.activeProvider = entries[0].provider;   // 人设绑定/状态展示读这个镜像
        } else {
          llm.workChain = entries;
        }
        kernel.llm.resetFailover();
        kernel.config.saveConfig();
        return send({ ok: true, chains: kernel.llm.chainsView() });
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
        return send(await listRemoteModels(baseUrl, String(body.apiKey ?? '').trim().slice(0, 400)));
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
          return send(await listRemoteModels(base, key));
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
            if (k !== 'affection_daily' && k !== 'affection_last_ts') kernel.memory.setAttr(u.userId, k, v);
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
    if (area === 'api' && a === 'users' && !b && req.method === 'GET') {
      const users = kernel.memory.listUsers().map((u) => ({
        ...u,
        affection: kernel.memory.getAttr<number>(u.userId, 'affection') ?? null,
        mood: kernel.memory.getAttr<string>(u.userId, 'mood') ?? null,
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

    // ================= 沙箱 =================
    if (area === 'api' && a === 'work') {
      // 「工作」页：任务运行记录 + 双模型标识 + 常驻容器状态
      if (!b) {
        // chatKey 给了就只回该会话的任务（会话页右侧「工作」抽屉按当前会话拉）
        const chatKey = url.searchParams.get('chatKey') || undefined;
        return send({
          runs: kernel.workRunner.list(Number(url.searchParams.get('limit') ?? 40), chatKey),
          models: kernel.llm.workModelSplit(),
          maxToolRounds: {
            chat: kernel.config.config.llm.maxToolRounds,
            work: '∞',
          },
          containers: kernel.session.status(),
          images: {
            python: (kernel.config.config.sandbox as any).session?.image,
            browser: (kernel.config.config.sandbox as any).browser?.image,
          },
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
        const rel = url.searchParams.get('path') || '.';
        if (b === 'files') return send({ path: rel, entries: kernel.sandbox.list(chat, rel) });
        const r = kernel.sandbox.preview(chat, rel);
        return send(r ? { kind: 'text', ...r } : { kind: 'binary' });
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
        });
      }
      if (!b && req.method === 'POST') {
        const cfg = kernel.config.config as any;
        for (const section of ['risk', 'onebot', 'persona'] as const) {
          if (body[section] && typeof body[section] === 'object') {
            // onebot.llbot / onebot.napcat 嵌套合并，避免浅覆盖丢字段；
            // flavor（协议端）不走这里——换端要连带停/起进程，只认 POST /api/login/protocol
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
              Object.assign(cfg[section], body[section]);
            }
          }
        }
        // ui 只放行预期 bot 账号（有头模式的安全开关，见 adapter 账号守卫）；端口/偏好等不走这里
        if (typeof body.expectedQq === 'string') {
          const qq = body.expectedQq.trim();
          if (qq && !/^\d{5,12}$/.test(qq)) return send({ error: 'expectedQq 必须是 QQ 号' }, 400);
          cfg.ui.expectedQq = qq;
        }
        // llm 段只放行掉线阈值：模型链本身走 /api/providers/chain
        if (body.llm && typeof body.llm === 'object') {
          const n = Number((body.llm as any).failoverThreshold);
          if (!Number.isFinite(n) || n < 1 || n > 10) return send({ error: '掉线阈值需要是 1~10 的整数' }, 400);
          cfg.llm.failoverThreshold = Math.round(n);
          kernel.llm.resetFailover();
        }
        kernel.config.saveConfig();
        kernel.chat.setRatePerMin(kernel.config.config.risk.replyRatePerMin);
        return send({ ok: true });
      }
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

function serveStatic(root: string, path: string, res: ServerResponse): void {
  let rel = path === '/' ? '/index.html' : path;
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
