import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Bus, busEvents } from './bus.ts';
import { Db } from './db.ts';
import { ConfigStore } from './config.ts';
import { ErrorCenter } from './errors.ts';
import { SessionLog } from './sessionlog.ts';
import { Scheduler } from './scheduler.ts';
import { MemoryService } from './services/memory.ts';
import { SandboxService } from './services/sandbox.ts';
import { SessionContainers } from './services/session.ts';
import { WorkRunner } from './services/work.ts';
import { ChatService } from './services/chat.ts';
import { LlmService } from './services/llm.ts';
import { LLBotManager } from './services/llbot.ts';
import { NapCatManager } from './services/napcat.ts';
import { PluginContainer } from './container.ts';
import { AgentLoop, HistoryStore } from './agentloop.ts';
import { Pipeline, roleAtLeastRole } from './pipeline.ts';
import { OneBot11Adapter } from './adapters/onebot11.ts';
import { startApiServer } from './api/server.ts';
import type { ChatEvent, Logger, ProtocolEnd, Role } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 启动后用系统默认浏览器打开桌面端（失败静默，不影响内核） */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* headless 环境无浏览器，忽略 */ }
}

export interface KernelOptions {
  dataDir?: string;
  port?: number;
  /** 测试模式：不启动 HTTP/API（部分单测） */
  noApi?: boolean;
}

/**
 * 内核装配：把总线、存储、配置、服务、容器、流水线、适配器、API 全部接起来。
 */
export class Kernel {
  bus: Bus;
  db: Db;
  config: ConfigStore;
  errors: ErrorCenter;
  sessionLog: SessionLog;
  scheduler: Scheduler;
  memory: MemoryService;
  sandbox: SandboxService;
  session: SessionContainers;
  workRunner: WorkRunner;
  chat: ChatService;
  llm: LlmService;
  llbot: LLBotManager;
  napcat: NapCatManager;
  container: PluginContainer;
  agentLoop: AgentLoop;
  history: HistoryStore;
  pipeline: Pipeline;
  adapter: OneBot11Adapter;
  dataDir: string;
  private log: Logger;

  opts: KernelOptions;

  constructor(opts: KernelOptions = {}) {
    this.opts = opts;
    const root = join(here, '..', '..');
    this.dataDir = opts.dataDir ?? join(root, 'data');
    mkdirSync(this.dataDir, { recursive: true });
    this.log = makeLogger('kernel');

    this.bus = new Bus();
    this.db = new Db(this.dataDir);
    this.errors = new ErrorCenter(this.bus, {
      dataDir: this.dataDir,
      notifyOwner: (text) => this.notifyOwner(text),
    });
    this.config = new ConfigStore(this.dataDir, this.bus, this.errors);
    if (opts.port) this.config.config.ui.port = opts.port;

    this.sessionLog = new SessionLog(this.dataDir, this.bus);
    this.scheduler = new Scheduler(this.bus, (pluginId) => !!this.config.config.risk.proactive[pluginId]);
    this.memory = new MemoryService(this.db, this.bus, this.errors);
    this.sandbox = new SandboxService(this.dataDir, this.db, this.config, this.errors);
    this.session = new SessionContainers(this.dataDir, this.config, this.errors);
    this.chat = new ChatService(this.bus, {
      ratePerMin: this.config.config.risk.replyRatePerMin,
      jitterMinMs: this.config.config.risk.jitterMinMs,
      jitterMaxMs: this.config.config.risk.jitterMaxMs,
      sandboxRoot: (c) => this.sandbox.root(c),
      sessionLog: this.sessionLog,
      onUsage: () => {},
    });
    this.llm = new LlmService(this.config, this.errors, this.db, this.bus);
    this.llbot = new LLBotManager(this.config, this.errors, this.bus, makeLogger);
    // agent loop 与 work 子代理执行器需先于插件容器创建（插件 setup 时会取 ctx.work.modelLabel）
    this.agentLoop = new AgentLoop(this.llm, this.sessionLog, this.bus, this.config, this.errors);
    this.workRunner = new WorkRunner(this.agentLoop, this.llm, this.bus, this.db, this.config, this.errors);
    this.container = new PluginContainer(
      {
        builtin: join(root, 'src', 'plugins'),
        example: join(root, 'examples'),
        user: join(this.dataDir, 'plugins'),
        dataDir: this.dataDir,
      },
      {
        db: this.db, bus: this.bus, errors: this.errors, config: this.config,
        memory: this.memory, sandbox: this.sandbox, session: this.session, work: this.workRunner,
        chat: this.chat, llm: this.llm,
        scheduler: this.scheduler,
        loggerFactory: makeLogger,
        notifyOwner: (t) => this.notifyOwner(t),
      },
    );
    this.history = new HistoryStore(this.sessionLog, this.config.config.storage.historyLimit);
    this.adapter = new OneBot11Adapter(
      this.config, this.errors, this.bus, this.sandbox,
      (e) => this.pipeline.submit(e),
      makeLogger,
    );
    this.chat.attachAdapter(this.adapter);
    // NapCat 的"在线"就看反向 WS 有没有连上（注入模式下登录发生在 QQ 窗口里）
    this.napcat = new NapCatManager(this.config, this.errors, makeLogger, () => {
      const s = this.adapter.status() as { connected?: boolean; selfId?: string; selfNickname?: string };
      return { connected: !!s.connected, selfId: s.selfId ?? '', nickname: s.selfNickname ?? '' };
    });
    this.pipeline = new Pipeline(
      this.container, this.agentLoop, this.history, this.chat, this.memory, this.sessionLog,
      this.config, this.errors, this.bus, this.db, this.workRunner,
      (event) => this.resolveRole(event),
      (chatId) => this.adapter.groupName(chatId) || `群${chatId}`,
    );

    // 配置限速热更新
    this.bus.on(busEvents.configChanged, () => {
      this.chat.setRatePerMin(this.config.config.risk.replyRatePerMin);
    });
  }

  resolveRole(event: ChatEvent): Role {
    if (this.config.isOwner(event.userId)) return 'owner';
    if (this.config.isAdmin(event.userId)) return 'admin';
    if (event.senderRole === 'owner' || event.senderRole === 'admin') return 'admin';
    return 'member';
  }

  /** 私聊通知所有主人（ErrorCenter / 插件自动停用等） */
  async notifyOwner(text: string): Promise<void> {
    for (const qq of this.config.config.masterIds) {
      try {
        await this.chat.sendText({ platform: 'qq', type: 'private', chatId: qq }, text);
      } catch { /* 协议端不在线时静默 */ }
    }
  }

  /** 当前托管的协议端（onebot.flavor 决定；另一端只会在切换时被显式停掉） */
  protocolEnd(): ProtocolEnd {
    return this.config.config.onebot.flavor === 'napcat' ? this.napcat : this.llbot;
  }

  /** 托管只在带桌面端的内核里跑：noApi（测试/服务模式）不该在后台下载发行包或拉起注入进程 */
  managesEnd(): boolean {
    return !this.opts.noApi;
  }

  async boot(): Promise<void> {
    mkdirSync(join(this.dataDir, 'plugins'), { recursive: true });
    await this.container.scanAndLoadAll();
    await this.adapter.start();
    // 群名/好友昵称在协议端连入时自动拉取（onebot11 handleConnection 内）
    // 内嵌托管常驻开启：桌面内核一起来就把选定的协议端下载/拉起/守好。
    // noApi（无头跑测试或服务模式）不托管：那种场景不该在后台拉百 MB 发行包，协议端由 Mock/外部顶替。
    if (this.managesEnd()) {
      this.protocolEnd().start().catch((e) => {
        this.errors.record('error', 'adapter', `${this.protocolEnd().id} 托管启动失败: ${(e as Error).message}`, { notifyOwner: true });
      });
    }
    if (!this.opts.noApi) {
      await startApiServer(this);
      // 免输 token：启动即打开浏览器，uiToken 经 URL 片段交给前端（片段不进服务器日志/Referer）。
      // 必须只在真的起了 API 服务时执行：无头（noApi，如 e2e 测试）内核若也打开浏览器，
      // 会用测试内核的随机 token 覆盖同一端口上真实 UI 的 localStorage，把用户踢成"未登录"。
      const uiPort = this.config.config.ui.port;
      const uiUrl = `http://127.0.0.1:${uiPort}/#token=${this.config.secrets.uiToken}`;
      this.log.info(`parallel 内核已启动。桌面端: ${uiUrl}（已自动打开浏览器）`);
      openBrowser(uiUrl);
    } else {
      this.log.info('parallel 内核已启动（noApi 模式：不提供桌面端，不打开浏览器）');
    }
    this.setupKernelRpc();
    const masterHint = this.config.config.masterIds.length === 0
      ? '⚠ 尚未配置主人 QQ（config.masterIds），人设切换等主人专属能力将不可用。'
      : '';
    if (masterHint) this.log.warn(masterHint);
  }

  /** kernel.rpc：插件（如 plugin-manager）经事件总线请求内核能力 */
  private setupKernelRpc(): void {
    this.bus.on('kernel.rpc', (req: any) => {
      void Promise.resolve()
        .then(async () => {
          const role: Role = req.role ?? 'member';
          const chatId: string = req.chatId ?? '';
          switch (req.type) {
            case 'commands_visible': {
              const chat = { platform: 'qq', type: req.chatType ?? 'group', chatId };
              return this.container.commandsForChat(chat, role).map((c) => ({
                name: c.def.name, pluginId: c.pluginId, description: c.def.description,
                enabled: c.enabled, minRole: c.def.minRole,
              }));
            }
            case 'plugins_visible': {
              const chat = { platform: 'qq', type: req.chatType ?? 'group', chatId };
              // hidden 插件只是不在桌面端「插件」页出现；群内 /插件 仍可开关（chat/sandbox/web-search 默认关，
              // 全靠这里启用，滤掉就等于谁也开不了）
              return this.container.list()
                .filter((lp) => this.container.isPluginVisibleToChat(lp.manifest.id, chatId, role))
                .map((lp) => ({
                  id: lp.manifest.id, name: lp.manifest.name, version: lp.manifest.version,
                  category: lp.manifest.category, locked: !!lp.manifest.locked,
                  enabled: this.container.effectiveEnabled(lp.manifest.id, chatId),
                  visible: true,
                }));
            }
            case 'set_group_state': {
              const lp = this.container.get(req.pluginId);
              if (!lp) throw new Error(`插件 ${req.pluginId} 不存在或未载入`);
              if (lp.manifest.locked && role !== 'owner') {
                throw new Error(`「${lp.manifest.name}」是人设类插件，开关仅限主人`);
              }
              if (lp.manifest.category === 'persona' && role !== 'owner') {
                throw new Error('人设类插件仅主人可操作');
              }
              this.container.setGroupState(req.pluginId, chatId, !!req.enabled, String(req.updatedBy ?? ''));
              return { name: lp.manifest.name, category: lp.manifest.category };
            }
            case 'plugin_detail': {
              const lp = this.container.get(req.pluginId);
              if (!lp) throw new Error(`插件 ${req.pluginId} 不存在或未载入`);
              const enabled = this.container.effectiveEnabled(lp.manifest.id, chatId);
              const redacted = !!lp.manifest.locked && role !== 'owner';
              return {
                id: lp.manifest.id, name: lp.manifest.name, version: lp.manifest.version,
                description: redacted ? '（人格插件内容不公开）' : lp.manifest.description,
                category: lp.manifest.category, enabled, locked: !!lp.manifest.locked,
                permissions: redacted ? [] : lp.manifest.permissions,
                commands: [...new Set([...lp.commands.values()])].filter((c) => !c.hidden).map((c) => c.name),
                redacted,
              };
            }
            case 'reload_plugin': {
              if (role !== 'owner') throw new Error('权限不足：重载插件仅主人可用');
              await this.container.reload(req.pluginId);
              return { ok: true };
            }
            case 'set_global_default': {
              if (role !== 'owner') throw new Error('权限不足：全局默认仅主人可用');
              this.container.setGlobalDefault(req.pluginId, !!req.enabled);
              return { ok: true };
            }
            case 'install_user_plugins': {
              if (role !== 'owner') throw new Error('权限不足：安装插件仅主人可用');
              return this.container.installUserPlugins();
            }
            case 'status': {
              const enabled = this.container.list().filter((lp) => lp.state === 'loaded').length;
              return {
                adapter: this.adapter.status(),
                model: `${this.llm.activeProviderId()}/${this.llm.activeModel()}`,
                providerUsable: this.llm.isActiveUsable(),
                uptimeMs: Math.round(process.uptime() * 1000),
                plugins: { total: this.container.list().length, enabled },
              };
            }
            default:
              throw new Error(`未知内核 RPC: ${req.type}`);
          }
        })
        .then((data) => this.bus.emit('kernel.rpc.reply', { ok: true, data }))
        .catch((e) => this.bus.emit('kernel.rpc.reply', { ok: false, error: (e as Error).message }));
    });
  }

  async shutdown(): Promise<void> {
    for (const lp of this.container.list()) {
      await this.container.unload(lp.manifest.id).catch(() => {});
    }
    this.scheduler.dispose();
    await this.adapter.stop();
    await this.llbot.stop().catch(() => {});
    await this.napcat.stop().catch(() => {});
    this.db.close();
  }
}

export function makeLogger(name: string): Logger {
  const fmt = (lvl: string) => `${new Date().toISOString().slice(11, 19)} [${lvl}] [${name}]`;
  return {
    info: (msg, extra) => console.log(`${fmt('INFO')} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    warn: (msg, extra) => console.warn(`${fmt('WARN')} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    error: (msg, extra) => console.error(`${fmt('ERROR')} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    debug: (msg, extra) => { if (process.env.HACHIMI_DEBUG) console.log(`${fmt('DEBUG')} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`); },
  };
}
