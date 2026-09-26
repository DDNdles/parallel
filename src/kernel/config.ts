import { join } from 'node:path';
import { readJson, atomicWriteJson } from './util/fsutil.ts';
import { coerceLike, deepMerge } from './util/misc.ts';
import { randomBytes } from 'node:crypto';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';
import type { ErrorCenter } from './errors.ts';

/** 供应商下的单个模型（模型列表里的一行）：id 是发给 API 的模型名，其余为调用与展示元数据 */
export interface ProviderModelCfg {
  id: string;
  contextWindow?: number;                   // 上下文窗口（token）
  maxOutput?: number;                       // 最大输出（作为请求体的输出上限发出）
  inputTypes?: string[];                    // text | image | video | audio（声明了的媒体才会转成多模态入参）
  capabilities?: string[];                  // webSearch = 模型自带联网搜索：内核不再给它 Tavily 的 web_search 工具
  reasoningLevels?: string[];               // 推理等级（从低到高）
  enabled?: boolean;                        // 关闭 = 不出现在聊天模型菜单里
}

/** 优先级链上的一条：某个供应商下的某个模型 */
export interface ModelRef { provider: string; model: string }

/** 单个供应商配置。custom=true 的条目由模型页创建，内核按 openai-compatible 动态注册 Provider */
export interface ProviderCfg {
  label: string;
  model: string;                            // 当前使用的模型名
  enabled: boolean;
  baseUrl: string;
  protocol: string;                         // openai-compatible | mock
  custom?: boolean;
  models?: ProviderModelCfg[];
}

/** 内核默认配置（data/config.json 的骨架） */
export const DEFAULT_CONFIG = {
  masterIds: [] as string[],              // 主人 QQ 白名单（红线 §3.5：主人专属能力）
  extraAdminIds: [] as string[],          // 追加管理员（跨群）
  ui: {
    port: 3080, host: '127.0.0.1',
    lastLogin: null as { qq: string; nickname: string; ts: number } | null,  // 最近一次登录的 QQ 账号（登录页展示用）
    // 本 bot 预期的 QQ 号。有头模式（PMHQ）下必填：那时协议端寄生在本机 QQ 客户端上，
    // 客户端登着哪个号它就会顶着哪个号发言，所以登录号与它不符时内核拒绝代发（见 adapter 账号守卫）。
    expectedQq: '',
    // 会话列表偏好（按 bot 登录号区分，随 QQ 账号走）
    chatPrefs: {} as Record<string, { pinned: string[]; hidden: string[]; listWidth?: number }>, // qq -> { pinned, hidden, listWidth(会话列表宽 px) }
  },
  onebot: {
    reverseWsPath: '/onebot',             // 协议端反向 WS 上报地址
    port: 3001,                           // 反向 WS 服务端口
    host: '127.0.0.1',
    /** 协议端（两者都只说 OneBot 11 反向 WS，接入侧无差别；差别在内核托管哪一个）。
     *  托管常驻开启：桌面内核启动即自动下载/拉起/守护，界面上不再有开关。 */
    flavor: 'llbot' as 'llbot' | 'napcat',
    llbot: {
      // 接入方式：'pmhq' = 有头模式（PMHQ 注入本机 QQNT；官方文档明示「无头模式有掉线风险」，PMHQ 是稳的那条路）
      //           'direct' = 无头模式（纯协议直连 + 签名服务 Auth Token）
      mode: 'pmhq' as 'pmhq' | 'direct',
      webuiPort: 15173,                   // LLBot WebUI 端口（CLI 包内置默认；实际以 stdout 解析为准，登录二维码经内核代理）
      qqPath: '',                         // 本机 QQ.exe 路径（有头模式用；空 = 自动探测）
      qqProfileDir: '',                   // bot 专用 QQ 档案目录（空 = <data>/qq-bot-profile，不碰你正在用的 QQ；'-' = 用本机默认档案）
    },
    napcat: {
      webuiPort: 6099,                    // NapCat WebUI 默认端口（登录页与控制台都在这）
      qqPath: '',                         // 本机 QQNT 路径（空 = 自动探测：注册表 → 常见安装位置）
    },
  },
  llm: {
    activeProvider: 'gemini-3.8-flash',   // 镜像值：始终等于 chatChain 首条的供应商（人设绑定与状态展示读它）
    modelByProvider: {
      'deepseek': 'deepseek-chat',
      'openai-compatible': 'gpt-4o-mini',
    } as Record<string, string>,
    maxToolRounds: 8,
    // 供应商不再分聊天/工作用途：两条有序链各自列「供应商 + 模型」，靠前的优先，掉线自动接后一个
    chatChain: [] as ModelRef[],
    workChain: [] as ModelRef[],          // 空 = 工作跟随聊天链
    failoverThreshold: 2,                 // 同一条链上连续掉线 N 次才切到下一个模型
    historyLimit: 24,
  },
  providers: {
    'gemini-3.8-flash': {
      label: 'Gemini 3.8 Flash',
      model: 'gemini-3.8-flash',
      enabled: false,                     // 红线 §2.2：只留接口不接入
      baseUrl: '',                        // TODO: 接入时填写
      protocol: 'openai-compatible',
      models: [{ id: 'gemini-3.8-flash', contextWindow: 1048576, inputTypes: ['text', 'image'], enabled: true }],
    },
    'deepseek': {
      label: 'DeepSeek',
      model: 'deepseek-chat',
      enabled: false,
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai-compatible',
      models: [
        { id: 'deepseek-chat', contextWindow: 65536, inputTypes: ['text'], enabled: true },
        { id: 'deepseek-reasoner', contextWindow: 65536, inputTypes: ['text'], reasoningLevels: ['low', 'high'], enabled: true },
      ],
    },
    'openai-compatible': {
      label: 'OpenAI 兼容（自定义）',
      model: 'gpt-4o-mini',
      enabled: false,
      baseUrl: '',
      protocol: 'openai-compatible',
      models: [{ id: 'gpt-4o-mini', contextWindow: 128000, inputTypes: ['text', 'image'], enabled: true }],
    },
  } as Record<string, ProviderCfg>,
  risk: {
    groupWake: 'at_or_reply',             // at_or_reply | at_reply_or_wakeword
    wakeWords: [] as string[],
    replyRatePerMin: 12,                  // 每会话回复上限
    jitterMinMs: 400,                     // 回复随机抖动下限
    jitterMaxMs: 1600,
    silentWhenNothingEnabled: true,       // 空插件群被 @ 时是否给管理员提示
    proactive: {} as Record<string, boolean>,  // 插件主动推送开关，默认全关（风控）
    // 清除记忆的权限口径：self_and_admin = 本人可清自己、管理员/主人可清指定的人；admin_only = 一律要管理员/主人
    forgetScope: 'self_and_admin' as 'self_and_admin' | 'admin_only',
  },
  sandbox: {
    runtime: 'auto',                      // 执行运行时：'docker'=容器强隔离（断网+文件隔离）| 'subprocess'=本机子进程 | 'auto'=docker 可用则用之，否则回落 subprocess
    dockerImagePython: 'python:3.12-slim',
    dockerImageNode: 'node:24-slim',
    dockerImageBash: 'debian:12-slim',
    ttlHours: 24,                         // chat 临时文件 TTL（最后一次访问起算）
    inboxTtlHours: 6,                     // 聊天收件文件 TTL（更短：通常看完即弃）
    workTtlHours: 168,                    // work 产物 TTL（7 天：交付物值得多留）
    workInboxTtlHours: 24,                // work 会话的收件文件 TTL
    maxFileBytes: 10 * 1024 * 1024,       // 单文件上限
    maxSessionBytes: 200 * 1024 * 1024,   // 单会话总占用上限
    execTimeoutPythonMs: 20000,
    execTimeoutJsMs: 10000,
    execTimeoutShellMs: 60000,            // work 模式 shell 执行超时（powershell/bash）
    workMaxRunsPerMin: 15,                // work 模式执行频率上限（比 chat 宽）
    workMaxSessionBytes: 1024 * 1024 * 1024, // work 模式会话沙箱容量上限（1GB）
    workExecTimeoutMs: 300000,            // work 档单次执行上限（5 分钟：长任务/构建）
    maxOutputBytes: 4096,
    maxRunsPerMin: 5,
    // 状态化会话容器（常驻，变量跨调用保留；空闲回收）
    session: {
      enabled: true,                      // Python 会话容器：常驻 ipykernel，变量跨调用保留
      idleTtlMs: 20 * 60_000,             // 空闲多久回收容器
      image: 'parallel-sandbox-python:latest',
      maxPerHost: 8,                      // 同时常驻的会话容器上限（超出按 LRU 回收）
    },
    // 浏览器容器（有网；Playwright + Chromium）
    browser: {
      enabled: true,
      idleTtlMs: 10 * 60_000,
      image: 'parallel-sandbox-browser:latest',
      maxPerHost: 4,
    },
  },
  persona: {
    default: 'whale-girl',                 // 唯一人格：没有 /人格 锁定时的默认人设
    affection: {
      min: 0, max: 100,
      dailyDeltaCap: 15,                  // 防刷：单用户单日 ±15 封顶
      minIntervalMs: 60_000,
      stages: [
        { min: 81, label: '主人的宝', tone: '极亲昵，主动撒娇，称呼“主人”' },
        { min: 51, label: '亲近', tone: '亲近自然，称呼“主人”或名字' },
        { min: 21, label: '熟悉', tone: '友好熟络，直呼昵称' },
        { min: 0, label: '陌生', tone: '礼貌略带警惕，称呼“你”' },
      ],
    },
    memoryFactsTopK: 5,
  },
  storage: {
    historyLimit: 200,                    // 每会话保留的近端历史条数
  },
} as const;

export type KernelConfig = typeof DEFAULT_CONFIG;

/** 生成一份可变深拷贝 */
export function freshDefaultConfig(): KernelConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/** secrets：API key / token 集中存放（红线 §3.7），UI 脱敏显示 */
export interface Secrets {
  uiToken: string;                        // 桌面端访问令牌
  onebotAccessToken: string;              // OneBot 反向 WS access token
  llbotAuthToken: string;                 // LLBot 签名服务 Auth Token（写入其 data/auth_token.txt）
  providerKeys: Record<string, string>;   // providerId -> apiKey
  pluginSecrets: Record<string, Record<string, string>>; // pluginId -> {field: value}
}

export function defaultSecrets(): Secrets {
  return {
    uiToken: randomBytes(16).toString('hex'),
    onebotAccessToken: randomBytes(16).toString('hex'),
    llbotAuthToken: '',
    providerKeys: {},
    pluginSecrets: {},
  };
}

/**
 * 单一配置源：config.json + secrets.json，全部写操作原子化，
 * schema 校验失败拒绝写入并报 ErrorCenter。
 */
export class ConfigStore {
  config: KernelConfig;
  secrets: Secrets;
  private configFile: string;
  private secretsFile: string;

  constructor(
    dataDir: string,
    private bus: Bus,
    private errors: ErrorCenter,
  ) {
    this.configFile = join(dataDir, 'config.json');
    this.secretsFile = join(dataDir, 'secrets.json');
    const loaded = readJson<Partial<KernelConfig>>(this.configFile, {});
    this.config = coerceLike(freshDefaultConfig() as unknown as Record<string, unknown>, loaded) as unknown as KernelConfig;
    // 深合并保留新增默认字段
    this.config = deepMerge(freshDefaultConfig() as unknown as Record<string, unknown>, loaded as Record<string, unknown>) as unknown as KernelConfig;
    this.secrets = { ...defaultSecrets(), ...readJson<Partial<Secrets>>(this.secretsFile, {}) };
    this.secrets.providerKeys = this.secrets.providerKeys ?? {};
    this.secrets.pluginSecrets = this.secrets.pluginSecrets ?? {};
    // 迁移：SnowLuma 接入已移除；协议端托管改为常驻，两端配置里的 managed 键一并清掉
    if ((this.config.onebot as any).snowluma) {
      delete (this.config.onebot as any).snowluma;
    }
    for (const end of ['llbot', 'napcat'] as const) {
      const block = (this.config.onebot as any)[end];
      if (block && typeof block === 'object') delete block.managed;
    }
    if (this.config.onebot.llbot && typeof this.config.onebot.llbot === 'object') {
      for (const k of Object.keys(this.config.onebot.llbot)) {
        if (k !== 'webuiPort' && k !== 'mode' && k !== 'qqPath' && k !== 'qqProfileDir') delete (this.config.onebot.llbot as any)[k];
      }
    }
    this.migrateModelChains();
    atomicWriteJson(this.configFile, this.config);
    atomicWriteJson(this.secretsFile, this.secrets);
  }

  /** 迁移：① 旧的「工作供应商」指针 → work 链的一条（聊天链不预填：空链在 LlmService 里按
   *  activeProvider 兜底，手改 config.json 的 activeProvider 依然生效，模型页写过的链优先）；
   *  ② 清掉预置的 Mock 供应商与指向它的链/指针（模型页不再有"测试用"这种预制项）。 */
  private migrateModelChains(): void {
    const llm = this.config.llm as any;
    const providers = this.config.providers as Record<string, any>;
    const pid = String(llm.workProvider ?? '');
    if (!Array.isArray(llm.chatChain)) llm.chatChain = [];
    if (!Array.isArray(llm.workChain)) llm.workChain = [];
    if (!llm.workChain.length && providers[pid]) {
      llm.workChain = [{ provider: pid, model: llm.workModel?.[pid] ?? llm.modelByProvider?.[pid] ?? providers[pid].model ?? pid }];
    }
    delete llm.workProvider;
    delete llm.workModel;
    delete llm.workMaxToolRounds;
    if (!Number.isFinite(Number(llm.failoverThreshold)) || Number(llm.failoverThreshold) < 1) llm.failoverThreshold = 1;

    if (this.config.persona.default === 'parallel') this.config.persona.default = 'whale-girl';
    delete (this.config.llm as any).providerPersonaBinding;
    if (providers.mock && !providers.mock.custom) {
      delete providers.mock;
      delete llm.modelByProvider.mock;
      llm.chatChain = llm.chatChain.filter((x: ModelRef) => x.provider !== 'mock');
      llm.workChain = llm.workChain.filter((x: ModelRef) => x.provider !== 'mock');
      if (llm.activeProvider === 'mock') llm.activeProvider = llm.chatChain[0]?.provider ?? Object.keys(providers)[0] ?? '';
    }
  }

  saveConfig(): void {
    try {
      JSON.stringify(this.config);
      atomicWriteJson(this.configFile, this.config);
      this.bus.emit(busEvents.configChanged, 'config');
    } catch (e) {
      this.errors.record('error', 'storage', `配置校验失败，拒绝写入: ${(e as Error).message}`);
      throw e;
    }
  }

  saveSecrets(): void {
    atomicWriteJson(this.secretsFile, this.secrets);
    this.bus.emit(busEvents.configChanged, 'secrets');
  }

  /** provider API key 存取（secrets 集中管理） */
  getProviderKey(providerId: string): string {
    return this.secrets.providerKeys[providerId] ?? '';
  }

  setProviderKey(providerId: string, key: string): void {
    if (key) this.secrets.providerKeys[providerId] = key;
    else delete this.secrets.providerKeys[providerId];
    this.saveSecrets();
  }

  pluginSecret(pluginId: string, field: string): string {
    return this.secrets.pluginSecrets[pluginId]?.[field] ?? '';
  }

  setPluginSecret(pluginId: string, field: string, value: string): void {
    const m = (this.secrets.pluginSecrets[pluginId] ??= {});
    if (value) m[field] = value;
    else delete m[field];
    this.saveSecrets();
  }

  /** 内核数据目录（config.json 所在目录） */
  get dataDir(): string {
    return join(this.configFile, '..');
  }

  /** 插件 userConfig 非敏感部分的持久化文件 */
  pluginConfigFile(pluginId: string): string {
    return join(join(this.configFile, '..'), 'plugins', pluginId, 'config.json');
  }

  isOwner(userId: string): boolean {
    return this.config.masterIds.includes(String(userId));
  }

  isAdmin(userId: string): boolean {
    return this.isOwner(userId) || this.config.extraAdminIds.includes(String(userId));
  }
}
