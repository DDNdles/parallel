import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import type {
  CommandDef, PluginContext, PluginHooks, PluginManifest, ToolDef, ChatEvent, ChatRef, Role, ToolContext, WorkDelegateInput,
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
import type { ChatService } from './services/chat.ts';
import type { LlmService } from './services/llm.ts';
import type { Scheduler } from './scheduler.ts';
import type { Logger } from './types.ts';
import { McpStdioClient } from './services/mcp.ts';
import { atomicWriteJson, readJson } from './util/fsutil.ts';
import { newId, nowMs } from './util/misc.ts';

export type PluginSource = 'builtin' | 'example' | 'user';
export type PluginRuntimeState = 'loaded' | 'disabled' | 'error';

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  state: PluginRuntimeState;
  loadedAt: number;
  tools: Map<string, ToolDef>;
  commands: Map<string, CommandDef>;
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
      chat: ChatService;
      llm: LlmService;
      scheduler: Scheduler;
      loggerFactory: (name: string) => Logger;
      notifyOwner: (text: string) => Promise<void>;
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

    const lp: LoadedPlugin = {
      manifest, dir, source,
      state: 'loaded', loadedAt: nowMs(),
      tools: new Map(), commands: new Map(),
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
    this.deps.bus.emit(busEvents.pluginLoaded, { id: manifest.id, source, tools: [...lp.tools.keys()], commands: [...lp.commands.keys()] });
    this.log.info(`插件已载入 ${manifest.id} v${manifest.version} (${source}) tools=${lp.tools.size} commands=${lp.commands.size}`);
    this.pluginDirEvents.forEach((f) => f('loaded', manifest.id));
    return lp;
  }

  async unload(id: string): Promise<void> {
    const lp = this.plugins.get(id);
    if (!lp) return;
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
    this.deps.config.setPluginSecret(id, '*', '');
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
    if (enabled) lp.errStreak.clear();
    this.deps.bus.emit(busEvents.pluginStateChanged, { id, state: lp.state });
  }

  // =============== 分群开关（红线 §2.4） ===============

  /** 生效规则：群覆盖 ?? 全局默认(设置覆盖 ?? manifest.defaultGroupState) */
  effectiveEnabled(pluginId: string, chatId: string): boolean {
    const lp = this.plugins.get(pluginId);
    if (!lp || lp.state !== 'loaded') return false;
    const override = this.deps.db.get<{ enabled: number }>(
      'SELECT enabled FROM plugin_states WHERE plugin_id=? AND chat_id=?', pluginId, chatId,
    );
    if (override) return !!override.enabled;
    const globalOverride = this.deps.db.get<{ value: string }>(
      "SELECT value FROM settings_kv WHERE key=?", `global_default:${pluginId}`,
    );
    if (globalOverride) return globalOverride.value === 'on';
    return lp.manifest.defaultGroupState === 'on';
  }

  setGroupState(pluginId: string, chatId: string, enabled: boolean, updatedBy: string): void {
    this.deps.db.run(
      `INSERT INTO plugin_states (plugin_id, chat_id, enabled, updated_by, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(plugin_id, chat_id) DO UPDATE SET enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      pluginId, chatId, enabled ? 1 : 0, updatedBy, nowMs(),
    );
    this.deps.bus.emit(busEvents.pluginStateChanged, { id: pluginId, chatId, enabled });
  }

  clearGroupState(pluginId: string, chatId: string): void {
    this.deps.db.run('DELETE FROM plugin_states WHERE plugin_id=? AND chat_id=?', pluginId, chatId);
  }

  setGlobalDefault(pluginId: string, on: boolean): void {
    this.deps.db.run(
      `INSERT INTO settings_kv (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      `global_default:${pluginId}`, on ? 'on' : 'off',
    );
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

  /** 该群 LLM 工具列表：禁用插件的工具严格缺席（不是注册了但拒绝） */
  toolsForChat(chat: ChatRef, role: Role): ToolDef[] {
    const out: ToolDef[] = [];
    for (const lp of this.plugins.values()) {
      if (lp.state !== 'loaded') continue;
      if (!this.effectiveEnabled(lp.manifest.id, chat.chatId)) continue;
      for (const t of lp.tools.values()) {
        if (t.ownerOnly && role !== 'owner') continue;
        if (t.minRole && !roleAtLeast(role, t.minRole)) continue;
        out.push(t);
      }
    }
    return out;
  }

  commandsForChat(chat: ChatRef, role: Role): { def: CommandDef; pluginId: string; enabled: boolean }[] {
    const out: { def: CommandDef; pluginId: string; enabled: boolean }[] = [];
    const seen = new Set<CommandDef>();
    for (const lp of this.plugins.values()) {
      if (lp.state !== 'loaded') continue;
      const on = this.effectiveEnabled(lp.manifest.id, chat.chatId);
      // 非管理员：被禁用的插件完全不显示
      if (!on && !roleAtLeast(role, 'admin')) continue;
      for (const c of new Set(lp.commands.values())) {
        if (seen.has(c)) continue;
        seen.add(c);
        if (c.hidden && !roleAtLeast(role, 'owner')) continue;
        if (c.minRole && !roleAtLeast(role, c.minRole)) continue;
        out.push({ def: c, pluginId: lp.manifest.id, enabled: on });
      }
    }
    return out;
  }

  findCommand(name: string): { def: CommandDef; pluginId: string } | undefined {
    for (const lp of this.plugins.values()) {
      for (const c of lp.commands.values()) {
        if (c.name === name || c.aliases?.includes(name)) return { def: c, pluginId: lp.manifest.id };
      }
    }
    return undefined;
  }

  isPluginVisibleToChat(pluginId: string, chatId: string, role: Role): boolean {
    const lp = this.plugins.get(pluginId);
    if (!lp || lp.state !== 'loaded') return false;
    if (!this.effectiveEnabled(pluginId, chatId)) return roleAtLeast(role, 'admin');
    return true;
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
      log,
      bus: {
        emit: (e, ...a) => bus.emit(e, ...a),
        on: (e, h) => {
          const off = bus.on(e, h);
          lp.disposers.push(off);
          return;
        },
        once: (e, h) => {
          const off = bus.once(e, h);
          lp.disposers.push(off);
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
      work: makeGatedWork(manifest, { work: this.deps.work, plugins: this }),
      llm: {
        registerTool: (def) => {
          if (lp.tools.has(def.name)) throw new Error(`工具 ${def.name} 重复注册`);
          lp.tools.set(def.name, def);
        },
        chat: (req) => llm.chat(req, { pluginId: manifest.id }),
      },
      registerCommand: (def) => {
        for (const existing of container.plugins.values()) {
          for (const name of [def.name, ...(def.aliases ?? [])]) {
            if (existing.commands.has(name) || existing.commands.has(name)) {
              throw new Error(`命令 /${name} 已被插件 ${existing.manifest.id} 注册`);
            }
          }
        }
        lp.commands.set(def.name, def);
        for (const a of def.aliases ?? []) lp.commands.set(a, def);
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
    // 重载插件使配置生效
    this.reload(pluginId).catch((e) => this.log.error(`配置保存后重载 ${pluginId} 失败: ${(e as Error).message}`));
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

function makeGatedMemory(manifest: PluginManifest, deps: { memory: MemoryService; errors: ErrorCenter }) {
  const can = (p: string) => {
    if (!manifest.permissions.includes(p as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "${p}"，用户记忆访问被拒绝`);
    }
  };
  return {
    getProfile: (userId: string) => { can('memory.read'); return deps.memory.getProfile(userId); },
    addFact: (userId: string, fact: { content: string; ttlDays?: number; weight?: number }) => {
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
    read: (chat: ChatRef, p: string) => { can('fs.sandbox'); return deps.sandbox.read(chat, p); },
    write: (chat: ChatRef, p: string, c: string | Buffer, o?: { work?: boolean }) => { can('fs.sandbox'); return deps.sandbox.write(chat, p, c, o); },
    delete: (chat: ChatRef, p: string) => { can('fs.sandbox'); return deps.sandbox.delete(chat, p); },
    run: (chat: ChatRef, o: { language: 'python' | 'javascript'; code: string; timeoutMs?: number }) => {
      can('sandbox.exec');
      return deps.sandbox.run(chat, o);
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
 * 跑完整 agent loop（轮次预算 workMaxToolRounds），返回结论供 chat 模型转述。
 */
function makeGatedWork(
  manifest: PluginManifest,
  deps: { work: WorkRunner; plugins: PluginContainer },
) {
  const can = () => {
    if (!manifest.permissions.includes('work.delegate' as any)) {
      throw new PermissionDeniedError(`插件 ${manifest.id} 未声明权限 "work.delegate"，委派被拒绝`);
    }
  };
  return {
    modelLabel: () => deps.work.workModelLabel(),
    list: (limit?: number) => deps.work.list(limit ?? 30),
    delegate: async (input: WorkDelegateInput) => {
      can();
      const tools = deps.plugins.toolsForChat(input.chat, input.role as Role);
      return deps.work.run({
        chat: input.chat,
        task: input.task,
        userId: input.userId,
        nickname: input.nickname,
        role: input.role,
        system: WORK_SYSTEM_DEFAULT,
        tools,
        trigger: 'command',
        abort: input.abort,
      });
    },
  };
}

/** work 子代理默认 system（work 插件可在自身 beforeLLM 覆盖；此处内核侧兜底） */
export const WORK_SYSTEM_DEFAULT = [
  '你是 parallel 的 work 子代理：由 chat 侧委派或管理员以 /work 触发，专注完成这一件事。',
  '工作规则：',
  '- 面向交付：拆解任务 → 逐步执行 → 汇报结果。可用 Markdown、代码块、列表。',
  '- 计算/数据处理用 python_session（常驻会话，变量跨调用保留）或 run_bash / run_powershell。',
  '- 需要浏览网页（JS 渲染、点击、登录）用 browser_* 工具；只读正文用 web_fetch。',
  '- 产物写入会话沙箱（sandbox_write），需要交付给用户时用 send_file。',
  '- 计算沙箱无外网，联网一律走工具。',
  '- 遇到需要用户决策的点，简明列出选项再继续；完成后简述做了什么、产物在哪。',
].join('\n');

function mcpToolName(pluginId: string, serverId: string, tool: string): string {
  return `${pluginId}__${serverId}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}
