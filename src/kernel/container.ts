import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import type {
  PluginContext, PluginHooks, PluginManifest, ToolDef, ChatEvent, ChatRef, Role, ToolContext,
  WorkDelegateInput, WorkDispatchInput, GatedHumanlike, LLMRequestContext, WorkAgentDef, PluginHttpHandler,
  PluginHttpResponse, HistoryHit,
} from './types.ts';
import type { Db } from './db.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';
import type { ErrorCenter } from './errors.ts';
import type { ConfigStore } from './config.ts';
import type { MemoryService } from './services/memory.ts';
import { SandboxService, SandboxError } from './services/sandbox.ts';
import type { SessionContainers } from './services/session.ts';
import type { WorkRunner } from './services/work.ts';
import type { HumanlikeService } from './humanlike/index.ts';
import type { ChatService } from './services/chat.ts';
import type { LlmService } from './services/llm.ts';
import type { SessionLog } from './sessionlog.ts';
import type { Scheduler } from './scheduler.ts';
import type { Logger } from './types.ts';
import { McpStdioClient } from './services/mcp.ts';
import { resolveWorkAgent, discoverWorkAgents, resolveWorkAgentByName, ENTRY_AGENT_NAME } from './work-agent.ts';
import { composeContinueTask, composeTaskResume } from './work-prompt.ts';
import { sandboxRefOfKey } from './services/work.ts';
import { atomicWriteJson, readJson } from './util/fsutil.ts';
import { clip, newId, nowMs } from './util/misc.ts';

export type PluginSource = 'builtin' | 'example' | 'user';
export type PluginRuntimeState = 'loaded' | 'disabled' | 'error';

/** 插件端点交给 API 层的最终响应（body 已是可直接写出的文本/字节） */
export interface PluginHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  state: PluginRuntimeState;
  loadedAt: number;
  tools: Map<string, ToolDef>;
  /** 插件自定义 HTTP 端点：键 = "METHOD 规范化路径"（见 httpRouteKey） */
  httpRoutes: Map<string, PluginHttpHandler>;
  disposers: (() => void)[];
  mcpClients: McpStdioClient[];
  /** 连续同错计数（自动停用阈值） */
  errStreak: Map<string, { count: number; message: string }>;
  hooks: PluginHooks;
}

const AUTO_DISABLE_THRESHOLD = 3;

export class PluginContainer {
  private plugins = new Map<string, LoadedPlugin>();
  private log: Logger;
  /** 桌面端/BUS 通知用 */
  pluginDirEvents: ((kind: string, pluginId: string) => void)[] = [];

  constructor(
    private dirs: { builtin: string; example: string; user: string; dataDir: string },
    private deps: {
      db: Db;
      bus: Bus;
      errors: ErrorCenter;
      config: ConfigStore;
      memory: MemoryService;
      sandbox: SandboxService;
      session: SessionContainers;
      work: WorkRunner;
      humanlike: HumanlikeService;
      sessionLog: SessionLog;
      chat: ChatService;
      llm: LlmService;
      scheduler: Scheduler;
      loggerFactory: (name: string) => Logger;
      notifyOwner: (text: string) => Promise<void>;
      /** 群名解析（work 会话节里展示"QQ 群聊「名字」"用） */
      groupTitle: (chatId: string) => string;
    },
  ) {
    this.log = deps.loggerFactory('container');
  }

  // =============== 清单与发现 ===============

  validateManifest(raw: unknown, source: PluginSource): PluginManifest {
    const m = raw as PluginManifest;
    if (!m || typeof m !== 'object') throw new Error('plugin.json 缺失或不是对象');
    if (!m.id || !/^[a-z0-9][a-z0-9-_.]*$/.test(m.id)) throw new Error('manifest.id 缺失或非法（需 kebab-case）');
    if (!m.name) throw new Error('manifest.name 缺失');
    if (!m.version) throw new Error('manifest.version 缺失');
    const cats = ['core', 'persona', 'tool', 'fun', 'info', 'system'];
    if (!cats.includes(m.category)) throw new Error(`manifest.category 非法（应为 ${cats.join('/')})`);
    if (!m.permissions) m.permissions = [];
    m.trust = m.trust ?? source;
    if (m.category === 'persona') m.locked = m.locked ?? true;
    if (m.defaultGroupState !== 'on' && m.defaultGroupState !== 'off') {
      throw new Error('manifest.defaultGroupState 必须是 on/off（本系统默认全部关闭）');
    }
    // 红线 §3.7：敏感信息不允许写进清单
    for (const [k, v] of Object.entries(m.userConfig ?? {})) {
      void k;
      if ((v as any)?.secret) continue;
    }
    return m;
  }

  listDirs(source: PluginSource): string[] {
    const root = this.dirs[source];
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name))
      .filter((d) => existsSync(join(d, 'plugin.json')));
  }

  // =============== 加载 / 卸载 / 重载 ===============

  async scanAndLoadAll(): Promise<void> {
    // examples/ 只当写法示范留在盘上，不加载：界面不列、QQ 侧也用不到
    for (const source of ['builtin', 'user'] as PluginSource[]) {
      for (const dir of this.listDirs(source)) {
        try {
          const id = (readJson<any>(join(dir, 'plugin.json'), {})).id;
          if (id && this.plugins.has(id)) {
            this.log.warn(`插件 ${id} 重复（${source}），跳过 ${dir}`);
            continue;
          }
          await this.load(dir, source);
        } catch (e) {
          this.deps.errors.record('error', 'plugin', `插件加载失败 ${dir}: ${(e as Error).message}`, { stack: (e as Error).stack });
        }
      }
    }
  }

  async load(dir: string, source: PluginSource): Promise<LoadedPlugin> {
    const manifest = this.validateManifest(readJson<any>(join(dir, 'plugin.json'), {}), source);
    if (this.plugins.has(manifest.id)) await this.unload(manifest.id);
    this.enabledCache.clear();

    const lp: LoadedPlugin = {
      manifest, dir, source,
      state: 'loaded', loadedAt: nowMs(),
      tools: new Map(),
      httpRoutes: new Map(),
      disposers: [], mcpClients: [],
      errStreak: new Map(),
      hooks: {},
    };
    this.plugins.set(manifest.id, lp);

    const ctx = this.createContext(lp);
    try {
      // mcpServers（network 权限门控）
      if (manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0) {
        this.requirePermission(manifest, 'network', 'mcpServers');
        await this.startMcpServers(lp, ctx);
      }
      const entry = join(dir, 'index.ts');
      if (existsSync(entry)) {
        // 时间戳查询参数破缓存实现热重载（ESM 新实例）
        const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`);
        const setup = mod.setup ?? mod.default?.setup ?? mod.default;
        if (typeof setup !== 'function') throw new Error('插件入口缺少 setup(ctx) 导出');
        await setup(ctx);
      }
      // setup 期间对 ctx.hooks 的赋值在此生效
      lp.hooks = ctx.hooks;
    } catch (e) {
      lp.state = 'error';
      this.deps.errors.record('error', 'plugin', `插件 ${manifest.id} 初始化失败: ${(e as Error).message}`, { pluginId: manifest.id, stack: (e as Error).stack });
      await this.unload(manifest.id).catch(() => {});
      throw e;
    }
    this.deps.bus.emit(busEvents.pluginLoaded, { id: manifest.id, source, tools: [...lp.tools.keys()] });
    this.log.info(`插件已载入 ${manifest.id} v${manifest.version} (${source}) tools=${lp.tools.size}`);
    this.pluginDirEvents.forEach((f) => f('loaded', manifest.id));
    return lp;
  }

  async unload(id: string): Promise<void> {
    const lp = this.plugins.get(id);
    if (!lp) return;
    this.enabledCache.clear();
    try {
      await lp.hooks.onUnload?.();
    } catch (e) {
      this.log.warn(`插件 ${id} onUnload 抛错: ${(e as Error).message}`);
    }
    // 统一 deactivate 协议：逆序清理（定时器/子进程/监听器不留孤儿）
    for (let i = lp.disposers.length - 1; i >= 0; i--) {
      try { lp.disposers[i](); } catch { /* ignore */ }
    }
    lp.disposers = [];
    this.deps.scheduler.unregisterPlugin(lp.manifest.id);
    for (const c of lp.mcpClients) c.dispose();
    lp.mcpClients = [];
    this.plugins.delete(id);
    this.deps.bus.emit(busEvents.pluginUnloaded, { id });
    this.pluginDirEvents.forEach((f) => f('unloaded', id));
    this.log.info(`插件已卸载 ${id}`);
  }

  async reload(id: string): Promise<LoadedPlugin> {
    const lp = this.plugins.get(id);
    if (!lp) throw new Error(`插件 ${id} 未载入`);
    const { dir, source } = lp;
    await this.unload(id);
    return this.load(dir, source);
  }

  /** 用户自建插件：运行期放入 data/plugins 后调用此扫描安装 */
  async installUserPlugins(): Promise<string[]> {
    const installed: string[] = [];
    for (const dir of this.listDirs('user')) {
      const id = (readJson<any>(join(dir, 'plugin.json'), {})).id;
      if (id && !this.plugins.has(id)) {
        await this.load(dir, 'user');
        installed.push(id);
      }
    }
    return installed;
  }

  async uninstallUserPlugin(id: string): Promise<void> {
    const lp = this.plugins.get(id);
    if (!lp) throw new Error(`插件 ${id} 未载入`);
    if (lp.manifest.core) throw new Error(`core 插件 ${id} 不可卸载`);
    if (lp.source === 'builtin') throw new Error('内置插件不可卸载（可在插件管理中停用）');
    await this.unload(id);
    // 移除持久化状态
    this.deps.db.run('DELETE FROM plugin_states WHERE plugin_id=?', id);
    this.deps.db.run('DELETE FROM plugin_kv WHERE plugin_id=?', id);
    this.deps.db.run('DELETE FROM plugin_user_config WHERE plugin_id=?', id);
    this.deps.config.clearPluginSecrets(id);
    this.deps.bus.emit(busEvents.pluginStateChanged, { id, state: 'uninstalled' });
  }

  // =============== 运行态启停（全聊天维度） ===============

  list(): LoadedPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  async setRuntimeEnabled(id: string, enabled: boolean): Promise<void> {
    const lp = this.plugins.get(id);
    if (!lp) throw new Error(`插件 ${id} 未载入`);
    if (lp.manifest.core && !enabled) throw new Error(`core 插件 ${id} 不可停用`);
    lp.state = enabled ? 'loaded' : 'disabled';
    this.enabledCache.clear();
    if (enabled) lp.errStreak.clear();
    this.deps.bus.emit(busEvents.pluginStateChanged, { id, state: lp.state });
  }

  // =============== 分群开关（红线 §2.4） ===============

  /** 分群开关的读缓存：消息热路径每轮每插件查 1~2 条同步 SQL，而开关变更极低频。
   *  所有写入口与插件启停都清空；上限 5000 条（会话数无界，防长期缓涨）。 */
  private enabledCache = new Map<string, boolean>();

  /** 生效规则：群覆盖 ?? 全局默认(设置覆盖 ?? manifest.defaultGroupState) */
  effectiveEnabled(pluginId: string, chatId: string): boolean {
    const lp = this.plugins.get(pluginId);
    if (!lp || lp.state !== 'loaded') return false;
    const key = `${pluginId}\u0000${chatId}`;
    const hit = this.enabledCache.get(key);
    if (hit !== undefined) return hit;
    const override = this.deps.db.get<{ enabled: number }>(
      'SELECT enabled FROM plugin_states WHERE plugin_id=? AND chat_id=?', pluginId, chatId,
    );
    let value: boolean;
    if (override) value = !!override.enabled;
    else {
      const globalOverride = this.deps.db.get<{ value: string }>(
        "SELECT value FROM settings_kv WHERE key=?", `global_default:${pluginId}`,
      );
      value = globalOverride ? globalOverride.value === 'on' : lp.manifest.defaultGroupState === 'on';
    }
    if (this.enabledCache.size > 5000) this.enabledCache.clear();
    this.enabledCache.set(key, value);
    return value;
  }

  setGroupState(pluginId: string, chatId: string, enabled: boolean, updatedBy: string): void {
    this.deps.db.run(
      `INSERT INTO plugin_states (plugin_id, chat_id, enabled, updated_by, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(plugin_id, chat_id) DO UPDATE SET enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      pluginId, chatId, enabled ? 1 : 0, updatedBy, nowMs(),
    );
    this.enabledCache.clear();
    this.deps.bus.emit(busEvents.pluginStateChanged, { id: pluginId, chatId, enabled });
  }

  clearGroupState(pluginId: string, chatId: string): void {
    this.deps.db.run('DELETE FROM plugin_states WHERE plugin_id=? AND chat_id=?', pluginId, chatId);
    this.enabledCache.clear();
  }

  setGlobalDefault(pluginId: string, on: boolean): void {
    this.deps.db.run(
      `INSERT INTO settings_kv (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      `global_default:${pluginId}`, on ? 'on' : 'off',
    );
    this.enabledCache.clear();
    this.deps.bus.emit(busEvents.pluginStateChanged, { id: pluginId, globalDefault: on });
  }

  getGlobalDefault(pluginId: string): boolean | undefined {
    const row = this.deps.db.get<{ value: string }>('SELECT value FROM settings_kv WHERE key=?', `global_default:${pluginId}`);
    return row ? row.value === 'on' : undefined;
  }

  groupStates(pluginId: string): { chatId: string; enabled: boolean; updatedBy: string; updatedAt: number }[] {
    return this.deps.db.all(
      'SELECT chat_id, enabled, updated_by, updated_at FROM plugin_states WHERE plugin_id=?', pluginId,
    ).map((r: any) => ({ chatId: r.chat_id, enabled: !!r.enabled, updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  // =============== 贡献面：按群过滤 ===============

  /**
   * 该群 LLM 工具列表：禁用插件的工具严格缺席（不是注册了但拒绝）。
   *
   * `surface` 决定收集哪一面（pi 的 tool surface）：
   *  - `'chat'`（默认）：**白名单口径（2026-10-17 起）**——chat 轮只收 `surface:'memory'`
   *    的记忆类工具与 `surface:'chat'` 的 chat 专用工具；回复本身是一次普通生成，
   *    最多一轮记忆读写，不给任何行为型工具；
   *  - `'work'`：work 子代理取工具，含 work 面工具（仍受角色与 minRole 约束）。
   * 可选 `allow` 给出工具白名单（work agent 定义里的 `tools:`），不在名单里的严格缺席。
   */
  toolsForChat(chat: ChatRef, role: Role, surface: 'chat' | 'work' = 'chat', allow?: string[]): ToolDef[] {
    const out: ToolDef[] = [];
    const allowSet = allow ? new Set(allow) : undefined;
    for (const lp of this.plugins.values()) {
      if (lp.state !== 'loaded') continue;
      if (!this.effectiveEnabled(lp.manifest.id, chat.chatId)) continue;
      for (const t of lp.tools.values()) {
        if (allowSet && !allowSet.has(t.name)) continue;
        // chat 面只认记忆类与 chat 专用工具（2026-10-17 白名单口径）；work 面拿不到 chat 面工具
        if (surface === 'chat' && t.surface !== 'memory' && t.surface !== 'chat') continue;
        if (surface === 'work' && t.surface === 'chat') continue;
        if (t.ownerOnly && role !== 'owner') continue;
        if (t.minRole && !roleAtLeast(role, t.minRole)) continue;
        out.push(t);
      }
    }
    return out;
  }

  /**
   * 生效的 work **入口** agent 定义：`config.work.agent` 指向的文件/名字优先，
   * 否则取 agents 目录里的入口条目，都没有则用内置兜底。
   */
  workAgent(): WorkAgentDef {
    const cfg = this.configCfg();
    return resolveWorkAgent({
      agentFile: cfg.work?.agent,
      pluginDir: join(this.dirs.builtin, 'work'),
      userDir: cfg.work?.agentsDir || join(this.dirs.dataDir, 'agents'),
    });
  }

  /**
   * 可委派的子代理清单（每次调用重新扫目录 —— pi 的口径：允许中途加/改 agent 不必重启）。
   */
  listWorkAgents(): WorkAgentDef[] {
    const cfg = this.configCfg();
    return discoverWorkAgents({
      pluginDir: join(this.dirs.builtin, 'work'),
      userDir: cfg.work?.agentsDir || join(this.dirs.dataDir, 'agents'),
    });
  }

  private configCfg(): { work?: { agent?: string; agentsDir?: string; maxDepth?: number } } {
    return this.deps.config.config as unknown as { work?: { agent?: string; agentsDir?: string; maxDepth?: number } };
  }

  /** 子代理嵌套上限（入口 depth=0；达到上限的那一层工具面里不再有 delegate） */
  workMaxDepth(): number {
    const n = this.configCfg().work?.maxDepth;
    return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : 2;
  }

  /**
   * 某一层 work 轮实际可用的工具：agent 定义白名单 ∩（本群生效 ∩ 角色允许）。
   *
   * 白名单**没声明**（`tools:` 缺省或空）= 不设白名单，拿到全部 work 面工具：
   * 内置兜底 agent 与"忘了写这一行"的自定义 agent 都属于这种，把空数组当白名单用
   * 会让它们一个工具都拿不到（模型收到「可用工具：(none)」，还查不出为什么）。
   *
   * 到深度上限时 `delegate` 一律缺席 —— 工具**在收集阶段就不存在**，
   * 而不是"注册了但调用时拒绝"（与 surface 同一条口径）。
   */
  workToolsFor(chat: ChatRef, role: Role, agent: WorkAgentDef, depth: number): ToolDef[] {
    const allow = agent.tools?.length ? agent.tools : undefined;
    const tools = this.toolsForChat(chat, role, 'work', allow);
    if (depth < this.workMaxDepth()) return tools;
    return tools.filter((t) => t.name !== 'delegate');
  }

  /**
   * 继续一次被打断的 work：按原任务重开一轮（同一发起人的沙箱还在，产物不用重做）。
   * 汇报仍由 WorkRunner 的 work.done 触发 pipeline 的 chat 汇报轮（trigger='chat'）；
   * 正常派活仍走 work_dispatch，这条只给桌面端/内核自用（例如内核重启后接着跑）。
   */
  async resumeWork(input: {
    chatKey: string;
    runId?: string;
    task: string;
    userId: string;
    nickname?: string;
    role: Role;
    trigger?: 'chat' | 'subagent';
  }): Promise<{ ok: boolean; reason?: string }> {
    // chatId 会参与沙箱/会话目录名：只收安全字符，`..`、分隔符一律判非法
    const m = String(input.chatKey ?? '').match(/^(group|private)_([A-Za-z0-9._-]{1,128})$/);
    if (!m) return { ok: false, reason: 'chatKey 不合法' };
    if (this.deps.work.workModelLabel() === '—') return { ok: false, reason: '工作模型还没配置' };
    const chat: ChatRef = { platform: 'qq', type: m[1] as 'group' | 'private', chatId: m[2] };
    const agent = this.workAgent();
    const all = this.listWorkAgents();
    const role = input.role;
    // 2026-10-25 任务隔离：续跑要沿用原任务的沙箱（桌面端/内核自用的续跑入口）。
    // 找不到原沙箱（老行）就按新任务开——文件在新沙箱里没有，但任务原文还在。
    const prev = input.runId ? this.deps.work.runForUser(input.runId, input.userId) : this.deps.work.runForUser(undefined, input.userId);
    const sandboxRef = prev?.sandboxKey ? sandboxRefOfKey(prev.sandboxKey) : undefined;
    void this.deps.work.run({
      chat,
      task: input.task,
      userId: input.userId,
      nickname: input.nickname,
      role,
      agent,
      tools: this.workToolsFor(chat, role, agent, 0),
      subagents: all.map((a) => ({ name: a.name, description: a.description, tools: a.tools, source: a.source })),
      trigger: input.trigger ?? 'chat',
      depth: 0,
      groupTitle: this.deps.groupTitle(chat.chatId),
      runHooks: (req) => this.runWorkHooks(req),
      sandboxRef,
    }).catch(() => { /* run() 内部已把失败落进事件与报错中心 */ });
    return { ok: true };
  }

  /**
   * work 轮的插件钩子链（beforeWorkLLM）。与 chat 的 beforeLLM 是两条独立链：
   * chat 轮的人格/世界书注入不会漏进 work，work 的子代理身份也不会污染 chat。
   */
  async runWorkHooks(req: LLMRequestContext): Promise<LLMRequestContext> {
    let ctx = req;
    for (const lp of this.plugins.values()) {
      if (lp.state !== 'loaded') continue;
      if (!this.effectiveEnabled(lp.manifest.id, ctx.chat.chatId)) continue;
      if (!lp.hooks.beforeWorkLLM) continue;
      try {
        ctx = await lp.hooks.beforeWorkLLM(ctx);
      } catch (e) {
        this.deps.errors.record('warn', 'plugin', `beforeWorkLLM 出错（${lp.manifest.id}）: ${(e as Error).message}`, { pluginId: lp.manifest.id });
      }
    }
    return ctx;
  }

  isPluginVisibleToChat(pluginId: string, chatId: string, role: Role): boolean {
    const lp = this.plugins.get(pluginId);
    if (!lp || lp.state !== 'loaded') return false;
    if (!this.effectiveEnabled(pluginId, chatId)) return roleAtLeast(role, 'admin');
    return true;
  }

  // =============== 插件 HTTP 端点 ===============

  /**
   * 把 `/api/plugin/<id><path>` 交给插件处理。
   * 返回 undefined = 这个请求不该由插件应答（插件未载入 / 已停用 / 没有这条路由），
   * 由 API 层统一回 404（插件未加载与"没有这条路由"对外不可区分，不暴露插件清单）。
   *
   * 停用态也归入 404：端点与工具同属插件的贡献面，插件事务性停用后应当整体消失，
   * 而不是留一个 403 让外部脚本以为"端点还在、只是这次没权限"。
   */
  async dispatchHttp(
    pluginId: string,
    method: string,
    path: string,
    query: Record<string, string>,
    body: unknown,
  ): Promise<PluginHttpResult | undefined> {
    const lp = this.plugins.get(pluginId);
    if (!lp || lp.state !== 'loaded') return undefined;
    const m = method.toUpperCase();
    const handler = lp.httpRoutes.get(httpRouteKey(m, path));
    if (!handler) return undefined;

    // handler 抛错不在这里吞：交给 API 层统一记进报错中心并回 500（与其它内核端点同一条兜底）
    const raw = await handler({ method: m, path, query, body });
    // 裸 string/Buffer 直接当 body
    const out: PluginHttpResponse = typeof raw === 'string' || Buffer.isBuffer(raw) ? { body: raw } : (raw ?? {});
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    for (const [k, v] of Object.entries(out.headers ?? {})) headers[k.toLowerCase()] = String(v);

    let payload: string | Buffer = '';
    let kind: 'json' | 'text' | 'bytes' = 'text';
    if (out.body !== undefined) {
      if (Buffer.isBuffer(out.body)) { payload = out.body; kind = 'bytes'; }
      else if (typeof out.body === 'string') { payload = out.body; kind = 'text'; }
      else { payload = JSON.stringify(out.body) ?? ''; kind = 'json'; }
    }
    if (!headers['content-type']) {
      headers['content-type'] = kind === 'json' ? 'application/json; charset=utf-8'
        : kind === 'bytes' ? 'application/octet-stream'
        : 'text/plain; charset=utf-8';
    }
    const status = typeof out.status === 'number' && out.status >= 100 && out.status <= 599
      ? Math.trunc(out.status) : 200;
    return { status, headers, body: payload };
  }

  // =============== 错误隔离（红线 §3.4） ===============

  /** 包装任意插件回调：崩溃不外泄；连续同错 3 次自动停用并通知主人 */
  async guarded<T>(lp: LoadedPlugin, what: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      const r = await fn();
      // 成功则清零该插件的错误连击
      lp.errStreak.clear();
      return r;
    } catch (e) {
      const err = e as Error;
      if (err instanceof PermissionDeniedError || err instanceof SandboxError) {
        // 权限/边界拒绝是正常防御，不算崩溃
        throw err;
      }
      const key = `${what}:${err.name}`;
      const streak = (lp.errStreak.get(key) ?? { count: 0, message: err.message })!;
      streak.count += 1;
      streak.message = err.message;
      lp.errStreak.set(key, streak);
      this.deps.errors.record('error', 'plugin', `插件 ${lp.manifest.id} ${what} 出错: ${err.message}`, {
        pluginId: lp.manifest.id, stack: err.stack,
      });
      if (streak.count >= AUTO_DISABLE_THRESHOLD) {
        // 自动停用（state=disabled，报错中心与主人通知记录原因）
        await this.setRuntimeEnabled(lp.manifest.id, false).catch(() => {});
        this.deps.errors.record('error', 'plugin', `插件 ${lp.manifest.id} 连续 ${AUTO_DISABLE_THRESHOLD} 次同错，已自动停用: ${err.message}`, { pluginId: lp.manifest.id });
        this.deps.notifyOwner(`[parallel] 插件「${lp.manifest.name}(${lp.manifest.id})」连续 ${AUTO_DISABLE_THRESHOLD} 次出现同类错误，已自动停用：\n${err.message}\n请在桌面端报错中心处理后重载。`).catch(() => {});
      }
      return undefined;
    }
  }

  // =============== 插件上下文 ===============

  private createContext(lp: LoadedPlugin): PluginContext {
    const manifest = lp.manifest;
    const container = this;
    const { db, bus, config, chat, llm, scheduler, errors } = this.deps;

    const log: Logger = this.deps.loggerFactory(`plugin:${manifest.id}`);
    const userConfig = this.resolveUserConfig(lp);

    const ctx: PluginContext = {
      manifest,
      pluginDataDir: this.pluginDataDir(manifest.id),
      dataDir: this.dirs.dataDir,
      log,
      bus: {
        emit: (e, ...a) => bus.emit(e, ...a),
        // 返回退订函数（Bus 契约如此）；插件不用它也没关系——卸载时 disposers 照样统一清理
        on: (e, h) => {
          const off = bus.on(e, h);
          lp.disposers.push(off);
          return off;
        },
        once: (e, h) => {
          const off = bus.once(e, h);
          lp.disposers.push(off);
          return off;
        },
      },
      config: config.config as unknown as Record<string, unknown>,
      userConfig,
      state: {
        get: <T>(key: string, def?: T) => {
          const row = db.get<{ value: string }>('SELECT value FROM plugin_kv WHERE plugin_id=? AND key=?', manifest.id, key);
          if (!row) return def as T;
          try { return JSON.parse(row.value) as T; } catch { return def as T; }
        },
        set: (key, value) => {
          db.run(
            `INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?,?,?,?)
             ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            manifest.id, key, JSON.stringify(value ?? null), nowMs(),
          );
        },
        delete: (key) => db.run('DELETE FROM plugin_kv WHERE plugin_id=? AND key=?', manifest.id, key),
        all: () => Object.fromEntries(db.all('SELECT key, value FROM plugin_kv WHERE plugin_id=?', manifest.id).map((r: any) => [r.key, JSON.parse(r.value)])),
      },
      chat,
      memory: makeGatedMemory(manifest, this.deps),
      sandbox: makeGatedSandbox(manifest, this.deps),
      session: makeGatedSession(manifest, this.deps),
      work: makeGatedWork(manifest, { work: this.deps.work, plugins: this, groupTitle: this.deps.groupTitle }),
      humanlike: makeGatedHumanlike(this.deps.humanlike),
      history: makeGatedHistory(manifest, { sessionLog: this.deps.sessionLog, sandbox: this.deps.sandbox }),
      http: {
        on: (method, path, handler) => {
          const m = String(method ?? '').toUpperCase();
          if (!/^[A-Z]+$/.test(m)) throw new Error(`HTTP 端点方法非法：${method}`);
          if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
            throw new Error(`HTTP 端点路径需以 / 开头且不带查询串：${path}`);
          }
          const key = httpRouteKey(m, path);
          // 重复注册直接抛错（与 llm.registerTool 重名同口径）：写错路径应当启动即失败，不静默覆盖
          if (lp.httpRoutes.has(key)) throw new Error(`HTTP 端点 ${m} ${path} 重复注册`);
          lp.httpRoutes.set(key, handler);
          // 卸载即摘除：reload 时旧路由先清掉，新实例重新注册（不会残留指向旧闭包）
          lp.disposers.push(() => { lp.httpRoutes.delete(key); });
        },
      },
      llm: {
        registerTool: (def) => {
          if (lp.tools.has(def.name)) throw new Error(`工具 ${def.name} 重复注册`);
          lp.tools.set(def.name, def);
        },
        chat: (req) => llm.chat(req, { pluginId: manifest.id }),
      },
      schedule: {
        register: (job) => {
          this.requirePermission(manifest, 'schedule', 'schedule.register');
          scheduler.register(manifest.id, job);
          lp.disposers.push(() => { /* 调度器统一 dispose */ });
        },
      },
      on: (event, handler) => {
        const off = bus.on(event, handler);
        lp.disposers.push(off);
      },
      setInterval: (fn, ms) => {
        const t = setInterval(() => { Promise.resolve(fn()).catch(() => {}); }, ms);
        t.unref();
        lp.disposers.push(() => clearInterval(t));
      },
      setTimeout: (fn, ms) => {
        const t = setTimeout(() => { Promise.resolve(fn()).catch(() => {}); }, ms);
        t.unref();
        lp.disposers.push(() => clearTimeout(t));
      },
      onDispose: (fn) => lp.disposers.push(fn),
      hooks: {},
    };
    return ctx;
  }

  resolveUserConfig(lp: LoadedPlugin): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, field] of Object.entries(lp.manifest.userConfig ?? {})) {
      if (field.secret) {
        out[k] = this.deps.config.pluginSecret(lp.manifest.id, k);
      } else {
        const row = this.deps.db.get<{ value: string }>(
          'SELECT value FROM plugin_user_config WHERE plugin_id=? AND key=?', lp.manifest.id, k,
        );
        if (row === undefined) out[k] = field.default;
        else {
          try { out[k] = JSON.parse(row.value); } catch { out[k] = field.default; }
        }
      }
    }
    return out;
  }

  /** 只落库，不重载：一次保存多个键时由 saveUserConfig 统一重载一次 */
  setUserConfigValue(pluginId: string, key: string, value: unknown): void {
    const lp = this.plugins.get(pluginId);
    if (!lp) throw new Error(`插件 ${pluginId} 未载入`);
    const field = lp.manifest.userConfig?.[key];
    if (!field) throw new Error(`未知配置项 ${key}`);
    if (field.secret) {
      this.deps.config.setPluginSecret(pluginId, key, String(value ?? ''));
    } else {
      // 类型校验
      if (field.type === 'number' && typeof value !== 'number') throw new Error(`${key} 需要数字`);
      if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} 需要布尔值`);
      if ((field.type === 'string' || field.type === 'text') && typeof value !== 'string') throw new Error(`${key} 需要字符串`);
      this.deps.db.run(
        `INSERT INTO plugin_user_config (plugin_id, key, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId, key, JSON.stringify(value ?? null), nowMs(),
      );
    }
  }

  /** 批量保存插件配置：全部落库后**只重载一次**（以前每个键 reload 一次且不 await） */
  async saveUserConfig(pluginId: string, values: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(values ?? {})) this.setUserConfigValue(pluginId, k, v);
    await this.reload(pluginId);
  }

  private async startMcpServers(lp: LoadedPlugin, ctx: PluginContext): Promise<void> {
    for (const [serverId, spec] of Object.entries(lp.manifest.mcpServers ?? {})) {
      const interp = (s: string) => s.replace(/\$\{userConfig\.([^}]+)\}/g, (_, k) => String(ctx.userConfig[k] ?? ''));
      // 相对路径的 args 相对插件目录解析（cwd 是内核进程，不是插件目录）
      const args = (spec.args ?? []).map((a) => {
        const s = interp(a);
        if (!s.startsWith('-')) {
          const cand = join(lp.dir, s);
          if (existsSync(cand)) return cand;
        }
        return s;
      });
      const client = new McpStdioClient(
        `${lp.manifest.id}:${serverId}`,
        interp(spec.command),
        args,
        Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, interp(v)])),
        ctx.log,
      );
      try {
        await client.start();
        for (const t of client.tools) {
          const toolName = mcpToolName(lp.manifest.id, serverId, t.name);
          lp.tools.set(toolName, {
            name: toolName,
            description: `[MCP] ${t.description || t.name}`,
            parameters: (t.inputSchema as any) ?? { type: 'object', properties: {} },
            handler: async (args) => client.callTool(t.name, args),
          });
        }
        lp.mcpClients.push(client);
        ctx.log.info(`MCP ${serverId} 已连接，暴露 ${client.tools.length} 个工具`);
      } catch (e) {
        ctx.log.error(`MCP ${serverId} 启动失败: ${(e as Error).message}`);
        this.deps.errors.record('warn', 'plugin', `插件 ${lp.manifest.id} 的 MCP ${serverId} 启动失败: ${(e as Error).message}`, { pluginId: lp.manifest.id });
        client.dispose();
      }
    }
  }

  private requirePermission(manifest: PluginManifest, perm: string, what: string): void {
    if (!manifest.permissions.includes(perm as any)) {
      const e = new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "${perm}"，拒绝执行 ${what}（边界拒绝而非提示词自觉）`);
      throw e;
    }
  }

  private pluginDataDir(pluginId: string): string {
    const dir = join(this.dirs.dataDir, 'plugin-data', pluginId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

// =============== 权限门控包装 ===============

export class PermissionDeniedError extends Error {}

function roleAtLeast(role: Role, min: Role): boolean {
  const rank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
  return rank[role] >= rank[min];
}

/**
 * 拟人层的门面。日程/氛围/节奏都属于"角色状态"，插件读写它就是改角色本身，
 * 所以只开最小面：读快照、读日程、写日程；不开放直接改氛围权重之类的内部量。
 */
function makeGatedHumanlike(humanlike: HumanlikeService): GatedHumanlike {
  return {
    scheduleOf: (chat) => humanlike.scheduleOf(chat),
    planSchedule: (chat, plan) => humanlike.planSchedule(chat, {
      rules: Array.isArray(plan?.rules) ? (plan.rules as never[]) : [],
      exceptions: Array.isArray(plan?.exceptions) ? (plan.exceptions as never[]) : [],
    }),
    snapshot: (chat) => humanlike.snapshot(chat),
  };
}

/** 会话历史检索门控：权限来自 manifest（history.search）；范围钉死在调用方给的会话上，插件拿不到全库。
 *  2026-10-26：命中的消息如果带了图片，顺手读成视觉输入一起交回（最多 3 张）——
 *  翻旧账找「上次那张图」时，模型要看见图本身，而不只是 `[图片]` 三个字。 */
function makeGatedHistory(manifest: PluginManifest, deps: { sessionLog: SessionLog; sandbox: SandboxService }) {
  const can = () => {
    if (!manifest.permissions.includes('history.search' as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "history.search"，会话历史检索被拒绝`);
    }
  };
  return {
    searchMessages: (chat: ChatRef, q: string, limit?: number, beforeTs?: number) => {
      can();
      const hits: HistoryHit[] = deps.sessionLog.searchMessages(chat.chatId, chat.type, { q, limit, beforeTs });
      let left = 3;
      for (const h of hits) {
        if (left <= 0) break;
        for (const f of h.files ?? []) {
          if (left <= 0) break;
          try {
            const img = deps.sandbox.readImage(chat, f.rel);
            if (!img) continue;
            (h.images ??= []).push({ data: img.data, mimeType: img.mime, name: f.name });
            left--;
          } catch { /* 文件已被清理 / 太大：跳过这一张，检索本身照常返回 */ }
        }
      }
      return hits;
    },
  };
}

function makeGatedMemory(manifest: PluginManifest, deps: { memory: MemoryService; errors: ErrorCenter }) {
  const can = (p: string) => {
    if (!manifest.permissions.includes(p as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "${p}"，用户记忆访问被拒绝`);
    }
  };
  return {
    getProfile: (userId: string) => { can('memory.read'); return deps.memory.getProfile(userId); },
    addFact: (userId: string, fact: { content: string; sourceChat?: string; ttlDays?: number; weight?: number }) => {
      can('memory.write');
      return deps.memory.addFact(userId, { ...fact, sourcePlugin: manifest.id });
    },
    searchFacts: (userId: string, q: string, limit?: number) => { can('memory.read'); return deps.memory.searchFacts(userId, q, limit); },
    topFacts: (userId: string, limit?: number) => { can('memory.read'); return deps.memory.topFacts(userId, limit); },
    getAttr: <T>(userId: string, key: string) => { can('memory.read'); return deps.memory.getAttr<T>(userId, key); },
    setAttr: (userId: string, key: string, v: unknown) => { can('memory.write'); deps.memory.setAttr(userId, key, v); },
    forget: (userId: string, opts?: { keepBlocked?: boolean }) => { can('memory.write'); deps.memory.forget(userId, { ...opts, source: manifest.id }); },
    listUsers: (f?: { blocked?: boolean }) => { can('memory.read'); return deps.memory.listUsers(f); },
    deleteFacts: (userId: string, ids: string[]) => { can('memory.write'); deps.memory.deleteFacts(userId, ids); },
    recentOps: (limit?: number, userId?: string) => { can('memory.read'); return deps.memory.recentOps(limit, userId); },
  };
}

function makeGatedSandbox(manifest: PluginManifest, deps: { sandbox: SandboxService; errors: ErrorCenter }) {
  const can = (p: string) => {
    if (!manifest.permissions.includes(p as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "${p}"，沙箱访问被拒绝`);
    }
  };
  return {
    root: (chat: ChatRef) => { can('fs.sandbox'); return deps.sandbox.root(chat); },
    list: (chat: ChatRef, p?: string) => { can('fs.sandbox'); return deps.sandbox.list(chat, p); },
    walkFiles: (chat: ChatRef, p?: string, o?: { maxFiles?: number; maxDepth?: number }) => { can('fs.sandbox'); return deps.sandbox.walkFiles(chat, p, o); },
    read: (chat: ChatRef, p: string) => { can('fs.sandbox'); return deps.sandbox.read(chat, p); },
    readImage: (chat: ChatRef, p: string) => { can('fs.sandbox'); return deps.sandbox.readImage(chat, p); },
    write: (chat: ChatRef, p: string, c: string | Buffer, o?: { work?: boolean }) => { can('fs.sandbox'); return deps.sandbox.write(chat, p, c, o); },
    delete: (chat: ChatRef, p: string) => { can('fs.sandbox'); return deps.sandbox.delete(chat, p); },
    run: (chat: ChatRef, o: { language: 'python' | 'javascript'; code: string; timeoutMs?: number }) => {
      can('sandbox.exec');
      return deps.sandbox.run(chat, o);
    },
    // work 档：bash + work 配额。此前漏了这一项，导致 work 插件的 run_bash /
    // run_python_work 两个工具恒不注册（typeof sb.runAny === 'function' 永假），
    // 而 prompt 里还在教模型用它们——工具面与 prompt 漂移的典型。
    runAny: (chat: ChatRef, o: { language: 'python' | 'javascript' | 'bash'; code: string; timeoutMs?: number; work?: boolean }) => {
      can('sandbox.exec');
      return deps.sandbox.runAny(chat, o);
    },
    stats: () => { can('fs.sandbox'); return deps.sandbox.stats(); },
    clear: (chat: ChatRef) => { can('fs.sandbox'); return deps.sandbox.clear(chat); },
  };
}

/** 会话容器门控（状态化 Python / 浏览器）：需 container 权限 */
function makeGatedSession(manifest: PluginManifest, deps: { session: SessionContainers }) {
  const can = (p: string) => {
    if (!manifest.permissions.includes(p as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "${p}"，会话容器访问被拒绝`);
    }
  };
  return {
    available: () => deps.session.available(),
    runPython: (chat: ChatRef, code: string, timeoutMs?: number, restart?: boolean) => {
      can('container');
      return deps.session.runPython(chat, code, timeoutMs ?? 60_000, restart);
    },
    browser: (chat: ChatRef, action: string, args?: Record<string, unknown>) => {
      can('container');
      return deps.session.browserAction(chat, action, args ?? {});
    },
    status: () => deps.session.status(),
    reset: (chat: ChatRef) => { can('container'); return deps.session.reset(chat); },
  };
}

/**
 * work 委派门控：需 work.delegate 权限。
 * 这里是「chat 模型 → work 模型」的桥：调用方给出任务，内核用 work 模型 + work 级工具面
 * 跑完整 agent loop（轮次由 work agent 定义的 max_rounds 决定），返回结论供 chat 模型转述。
 */
/**
 * work 委派门控：需 work.delegate 权限。
 * 「work 模型 → 子代理」的桥（chat 工具派活也走同一条）：
 * 调用方给出目标 agent 名与任务，内核按该 agent 的定义筛工具面、组装具名分节 system，
 * 跑一个**隔离上下文**的 agent loop，返回结论供上层继续（子代理结果回给父代理，或由 chat 转述）。
 */
function makeGatedWork(
  manifest: PluginManifest,
  deps: { work: WorkRunner; plugins: PluginContainer; groupTitle: (chatId: string) => string },
) {
  const plugins = deps.plugins;
  const can = () => {
    if (!manifest.permissions.includes('work.delegate' as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "work.delegate"，委派被拒绝`);
    }
  };
  return {
    modelLabel: () => deps.work.workModelLabel(),
    agents: () => plugins.listWorkAgents().map((a) => ({ name: a.name, description: a.description, tools: a.tools, source: a.source })),
    list: (limit?: number) => deps.work.list(limit ?? 30),
    latestArtifacts: (userId: string) => deps.work.latestArtifacts(userId),
    /** 向正在跑的任务插话（用户改需求）；没有在跑的活返回 false */
    steer: (chat: ChatRef, userId: string, text: string) => {
      can();
      return deps.work.steer(chat, userId, text);
    },
    delegate: async (input: WorkDelegateInput) => {
      can();
      const depth = input.depth ?? 0;
      const all = plugins.listWorkAgents();
      const wanted = (input.agent ?? '').trim();
      // 没点名就用入口 agent；点了名但不存在 → 明确报错（别静默换一个，那会让模型以为调对了）
      const agent = wanted ? resolveWorkAgentByName(wanted, all) : plugins.workAgent();
      if (!agent) {
        throw new Error(`没有名为 ${wanted} 的子代理。可用：${all.map((a) => a.name).join('、') || '（无）'}`);
      }
      const chat = input.chat;
      const role = input.role as Role;
      return deps.work.run({
        chat,
        task: input.task,
        userId: input.userId,
        nickname: input.nickname,
        role,
        agent,
        tools: plugins.workToolsFor(chat, role, agent, depth),
        subagents: all.map((a) => ({ name: a.name, description: a.description, tools: a.tools, source: a.source })),
        trigger: input.trigger ?? 'subagent',
        depth,
        parentId: input.parentId,
        groupTitle: deps.groupTitle(chat.chatId),
        runHooks: (req) => plugins.runWorkHooks(req),
        abort: input.abort,
      });
    },

    /**
     * chat 面派活：**立即返回**，活由 WorkRunner 在后台跑。
     * 上一次停下来提问的现场还没过期时，这次的话就是那个问题的回答（自动拼成续接任务）。
     * 完成/出错由 WorkRunner 发 work.done / work.error，pipeline 再另起一轮人格化汇报。
     */
    dispatch: (input: WorkDispatchInput) => {
      can();
      // 没有 work 链就别装作派出去了：让 chat 如实说现在做不了
      if (deps.work.workModelLabel() === '—') return { ok: false, reason: '工作模型还没配置' };
      const agent = plugins.workAgent();
      const chat = input.chat;
      const role = input.role as Role;
      // 续接的优先级：还在等回答的提问现场 > chat 模型点名的旧任务 > 全新任务。
      // 2026-10-25 任务隔离：续接必须沿用旧任务的沙箱 ref（文件/容器都在那），新任务才开新沙箱。
      const pending = deps.work.takePending(input.userId);
      let task = input.task;
      let label = input.label?.trim() || input.task;
      let sandboxRef: ChatRef | undefined;
      if (pending) {
        task = composeContinueTask(pending, input.task);
        label = `${pending.label}（续）`;
        sandboxRef = pending.sandboxKey ? sandboxRefOfKey(pending.sandboxKey) : undefined;
      } else if (input.continueRun) {
        const prev = deps.work.runForUser(input.continueRun === 'latest' ? undefined : input.continueRun, input.userId);
        if (!prev) return { ok: false, reason: `没找到这个用户能续接的任务（${input.continueRun === 'latest' ? '最近没有任务' : `任务 ${input.continueRun} 不存在或不是他的`}）` };
        task = composeTaskResume(prev, input.task);
        label = `${clip(prev.task, 24)}（续）`;
        sandboxRef = prev.sandboxKey ? sandboxRefOfKey(prev.sandboxKey) : undefined;
      }
      void deps.work.run({
        chat,
        task,
        taskLabel: label,
        userId: input.userId,
        nickname: input.nickname,
        role,
        agent,
        tools: plugins.workToolsFor(chat, role, agent, 0),
        subagents: plugins.listWorkAgents().map((a) => ({ name: a.name, description: a.description, tools: a.tools, source: a.source })),
        trigger: 'chat',
        depth: 0,
        groupTitle: deps.groupTitle(chat.chatId),
        runHooks: (req) => plugins.runWorkHooks(req),
        sandboxRef,
        attachments: input.attachments,
      }).catch(() => { /* run() 内部已把失败落进事件与报错中心 */ });
      return { ok: true, label };
    },

    /** 该会话里这位发起人自己的进度（别人的活不返回） */
    status: (userId: string) => deps.work.liveStatus(userId),
  };
}


function mcpToolName(pluginId: string, serverId: string, tool: string): string {
  return `${pluginId}__${serverId}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

/** 端点路由键：方法大写 + 路径去尾斜杠（查询串不参与精确匹配；注册与查找共用同一口径） */
function httpRouteKey(method: string, path: string): string {
  const m = method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return `${m} ${p}`;
}
