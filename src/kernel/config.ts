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

/** 思考强度（pi-ai 的 ThinkingLevel；空串 = 默认，由模型/供应商决定） */
export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** 单个供应商配置。custom=true 的条目由模型页创建，内核按 openai-compatible 动态注册 Provider */
export interface ProviderCfg {
  label: string;
  model: string;                            // 当前使用的模型名
  enabled: boolean;
  baseUrl: string;
  protocol: string;                         // openai-compatible | openai-responses | anthropic | gemini | mock
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
    /** 初始环境检查页已走过的时间戳：走过就直接进登录门，没走过（首次运行）先看依赖页 */
    setupDoneAt: 0,
    /** 会话页预览：群友头像 + 收来的图片缩略图（关掉就不发这些图片请求） */
    chatPreview: true,
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
      //           'direct' = 无头模式（纯协议直连 + 签名服务 Auth Token）——**2026-10-11 起放弃**：
      //           token 要向作者申请（见 services/llbot.ts 的 authState），且有头本来就更稳，界面上没有切过去的入口
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
    activeProvider: '',                   // 镜像值：始终等于 chatChain 首条的供应商（状态展示读它）
    modelByProvider: {
      'deepseek': 'deepseek-chat',
      'openai-compatible': 'gpt-4o-mini',
    } as Record<string, string>,
    // 供应商不再分聊天/工作用途：两条有序链各自列「供应商 + 模型」，靠前的优先，掉线自动接后一个
    chatChain: [] as ModelRef[],
    workChain: [] as ModelRef[],          // 工作链独立于聊天链（不跟随）；空 = /work 没有可用模型
    /** 每个模型单独的思考强度：键 = `${provider}|${model}`，值 = 该模型声明过的档位；空/缺省 = 默认 */
    modelReasoning: {} as Record<string, string>,
    failoverThreshold: 2,                 // 同一条链上连续掉线 N 次才切到下一个模型
  },
  // work 子代理（/work 链路）。定义与压缩口径都放在这里，改配置即可调整，不必改代码。
  work: {
    agent: '',                            // 入口 agent 定义文件或名字（空 = agents 目录里的 work）
    agentsDir: '',                        // 用户自加的子代理目录（空 = <data>/agents；同名覆盖内置）
    maxDepth: 2,                          // 子代理嵌套上限（入口 0；达到上限那层不再有 delegate）
    compaction: {                          // 上下文压缩（对齐 pi 的 compaction 口径）
      enabled: true,
      reserveTokens: 16384,               // 为模型回复预留的 token（也是触发阈值的一部分）
      keepRecentTokens: 20000,            // 保留最近多少 token 的原文不摘要
    },
  },
  // 拟人化层（chat 区行为本身，不是插件）。两侧来源分工明确：
  // 「什么时候开口」对齐 MaiBot 的 ChatReplyTimingConfig / idle_backoff；
  // 「怎么说 / 拆几条 / 隔多久」是**纯程序**出站（见 humanlike/delivery.ts）——
  // 2026-10-17 起 HDSI 的小说格式层（script）与 Alter 情绪偏移整层已删。
  // 这里没有总开关：说几句、拆几条、隔多久、要不要理都调，但"她是不是这样活着"没有 off 档。
  humanlike: {
    // 圈内黑话（表达学习，humanlike/jargon.ts）：挖本群高频词，判定为圈内含意时
    // 进 prompt 的「圈内黑话」参考——帮 bot 听懂，不改说话风格、不产数值
    jargon: { enable: true },
    // 重复惩罚（humanlike/repetition.ts）：最近若干轮 bot 发言里反复出现的词/人设名，
    // 注入提醒；命中后可用一次重写把它去掉。窗口/判定条数/冷却可在设置页调。
    repetition: {
      enable: true,
      windowMessages: 20,
      minMessages: 3,
      cooldownMinutes: 30,
      maxPhrases: 3,
      retry: true,
      maxStrikes: 3,
    },
    // 表达学习（chat 插件后台，humanlike/expression 的语料只来自群聊）：
    // 学「什么情境下大家怎么说」，作为语气参考注入；只学说法，不照抄、不改人设
    expression: { enable: true, minMessages: 20, idleSeconds: 120, maxPerChat: 24, injectMax: 4 },
    // 跟屏复读（humanlike/repeat.ts）：>=N 位群友接连说同一句就完整跟一条；纯程序不走模型
    repeat: { enable: true, minPeople: 4, delayMaxSec: 4, cooldownMin: 3 },
    // 戳一戳（chat 工具）：模型在有明确指向/犯贱时调用；冷却与小时上限是硬护栏
    poke: { enable: true, minIntervalSeconds: 30, maxPerHour: 6 },
    // ① 出站投递（纯程序）：按句分条 + 句边截断 + 打字节奏 + 单条长度上限
    outgoing: {
      splitReplyMessages: true,           // 是否把回复按换行/句子拆成多条 QQ 消息
      replyMaxCharacters: 100,            // 回复总长硬上限（提示里推荐 50）：超了在最后一个句末标点处截断
      maxReplyTokens: 400,                // chat 轮单次请求的输出 token 硬顶（<=0 = 不设）
      bubbleSoftMaxCharacters: 24,        // 单条气泡目标字数：超了在逗号/顿号处补切
      typingEnabled: false,               // 默认不模拟打字停顿（气泡之间立即发）
      typingBaseDelaySeconds: 1,          // 第二条及后续气泡前的基础打字等待（秒）
      typingCharactersPerSecond: 8,       // 模拟打字速度（字符/秒），越小长消息等得越久
      typingMaxDelaySeconds: 12,          // 单条后续气泡的最长打字等待（秒）
      typingJitterRatio: 0.3,             // 打字延迟随机浮动比例（0 = 固定）；整体下限固定 250ms
      maxMessageCharacters: 2000,         // 单条可见消息最大字符数（平台硬上限的安全垫）
    },
    // ② 什么时候开口（frequency：攒够积压条数就进一轮）
    timing: {
      pendingThreshold: 12,               // 攒够几条消息才进模型（开口门槛）
      talkValue: 1,                       // 群聊频率开关：0 = 静默；>0 不改变条数门槛
      privateTalkValue: 1,
      enableRules: false,                 // 按群/时段单独调频率
      rules: [
        { platform: '', itemId: '', ruleType: 'group' as const, time: '00:00-08:59', value: 0.8 },
        { platform: '', itemId: '', ruleType: 'group' as const, time: '09:00-18:59', value: 1 },
      ],
      mentionedBotReply: false,           // 提到名字就更想回（默认关）
      inevitableAtReply: true,            // 被 @ 必回（默认开）
      focusMode: false,                   // 专注模式：只认强相关，不参与群聊激活度
    },
    // ③ 出站打断（纯程序，见 humanlike/interrupt.ts）：她还在发气泡时对面又开口，
    //    按概率把剩下的气泡砍掉；模型还在生成时则直接 abort 这一轮。命令插话必断。
    interrupt: {
      enable: true,
      probability: 0.8,                   // 插话打断概率（0~1）
    },
    // ④ 消息防抖合并（关窗后按随机延时起跳，见 service.ts）。
    //    群聊与私聊共用这把尺子：私聊不打分（必回），但同样攒批 —— 对面连发几句是一个请求。
    merge: {
      enable: true,
      windowMs: 2000,                     // 静默这么久就把攒着的消息一起处理
      maxWaitMs: 6000,                    // 刷屏/连发时的兜底上限（群聊与私聊同一把尺子）
      bufferTtlMs: 120000,                // 攒着的消息超过 2 分钟就丢掉（老话不值得再接）
      fireDelayMinMs: 500,                // 关窗后的随机起跳延时下限
      fireDelayMaxMs: 2000,               // 关窗后的随机起跳延时上限（0/0 = 关掉随机延时）
    },
    // ⑤ 空闲退避（MaiBot idle_backoff）
    backoff: {
      baseSeconds: 15,
      capSeconds: 300,
      startCount: 2,
      bypassPendingCount: 6,
    },
    // ⑥ 真正的主动发言：没人说话也起话头。默认关（主动发言属于主动推送，要显式开启）
    proactive: {
      enable: false,
      idleSeconds: 3600,
    },
    // ⑦ 聊天节奏反定型（HDSI ChatRhythm）：回复结构定型时，以角色视角注入纠偏
    rhythm: {
      enable: true,
      mode: 'balanced' as 'gentle' | 'balanced' | 'aggressive',
      historyLimit: 12,                 // 节奏签名窗口（HDSI 5~20）
      collapseMinSamples: 5,            // 判定定型所需最少样本（宽限期，HDSI 3~10）
      exhaustLimit: 6,                  // 连续注入失败几次熔断（HDSI 3~12）
    },
    // ⑧ 主体行动窗口（HDSI Agency）：日程/隐私/设备构成主动开口的容量
    agency: {
      enable: true,
      quietHours: '00:30-07:30',        // 安静时段（她睡着，不主动开口）
      minimumProactiveIntervalMinutes: 60,
      maxWindowMinutes: 240,
      maxCandidateHours: 24,
    },
    // ⑨ 日程（HDSI Schedule Preplan）：周规律 + 日期例外；只作计划，不当已发生的事实
    // （模型与 QQ 侧的读写入口都已删除，现在只剩主动开口的行动容量判断在用）
    schedule: {
      enable: false,
      horizonHours: 12,                 // 主动轮能看到的未来时长（HDSI 约半天）
      maxRules: 12,
      maxExceptions: 32,
    },
  },
  providers: {
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
  /**
   * 风控 —— 只管内核红线（防刷屏、防隐私），**不描述她的性格**。
   * 与 `humanlike` 的分工：这里设天花板，"什么时候说、说几句、隔多久"在那里。
   * 两边刻意不重复同一个旋钮 —— 原本放在这里的「随机抖动」和「唤醒方式/唤醒词」
   * 都属于行为，已随拟人化一起收进那一页，这里不再留影子。
   */
  risk: {
    replyRatePerMin: 12,                  // 每会话发言上限（条/分钟）：一轮拆成几条就按几条计
    silentWhenNothingEnabled: true,       // 空插件群被 @ 时是否给管理员提示
    proactive: {} as Record<string, boolean>,  // 插件定时推送开关，默认全关（≠ 角色主动开口，那是 humanlike.agency）
    // 清除记忆的权限口径：self_and_admin = 本人可清自己、管理员/主人可清指定的人；admin_only = 一律要管理员/主人。
    // 2026-10-03 起默认 admin_only（界面入口已删，改这里需手改 config.json + 重启）。
    forgetScope: 'admin_only' as 'self_and_admin' | 'admin_only',
  },
  sandbox: {
    runtime: 'auto',                      // 执行运行时：'docker'=容器强隔离（断网+文件隔离）| 'subprocess'=本机子进程 | 'auto'=docker 可用则用之，否则回落 subprocess
    dockerImagePython: 'python:3.12-slim',
    // work 档的一次性 Python 换成带库镜像（numpy/pandas/matplotlib/PIL/opencv…）：
    // 实测 slim 镜像里模型 import PIL/numpy 全部失败，便转去宿主机命令绕路——那也是隔离漏口。
    dockerImagePythonWork: 'parallel-sandbox-python:latest',
    dockerImageNode: 'node:24-slim',
    dockerImageNodeWork: 'node:24-slim',
    // work 的 bash 与一次性 Python 同镜像：debian:12-slim 里连 python3 都没有（实测）
    dockerImageBash: 'parallel-sandbox-python:latest',
    ttlHours: 24,                         // chat 临时文件 TTL（最后一次访问起算）
    inboxTtlHours: 360,                   // 聊天收件文件 TTL（15 天：图片要能回看，设置页「沙箱」按天调）
    workTtlHours: 168,                    // work 产物 TTL（7 天：交付物值得多留）
    workInboxTtlHours: 360,               // work 会话的收件文件 TTL（与 chat 档一致，别悄悄更早删图）
    maxFileBytes: 10 * 1024 * 1024,       // 单文件上限
    maxSessionBytes: 200 * 1024 * 1024,   // 单会话总占用上限
    execTimeoutPythonMs: 20000,
    execTimeoutJsMs: 10000,
    execTimeoutShellMs: 60000,            // work 模式 shell 执行超时（bash）
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
    default: 'whale-girl',                 // 唯一人格：没被手动锁定（active_persona 状态）时的默认人设
    // 自动记忆提炼：攒够 minTurns 轮、且对话安静满 idleSeconds，才单独发一次「记忆整理」请求。
    // 提炼结果只落进 user_facts（不进上下文），模型经 recall_facts 现查。
    memoryAutoSave: true,
    memoryMinTurns: 6,
    memoryIdleSeconds: 180,
    memoryMaxFacts: 5,
    // 后台画像：从长期事实生成一段短画像，随本轮发言者注入（背景，不逐条念）
    profileAuto: true,
    // 中期聊天摘要：把已经滑出上下文时间窗的那段聊天压成「聊天回想」，带召回线索注入
    midtermSummary: true,
  },
  storage: {
    historyLimit: 200,                    // 每会话保留并传给模型的近端历史条数
    // 上下文时间窗（分钟）：agentTurn 按 now-contextMinutes 过滤历史快照；条数上限 storage.historyLimit 同时生效
    contextMinutes: 10,
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
    this.migrateModelReasoning();
    // 上下文时间窗（contextMinutes）2026-10-23 恢复：与 historyLimit 条数上限同时生效。
    // 旧配置文件里没有这个键时由 deepMerge 补默认值（10 分钟），这里不做删除。
    // 迁移：风控里的「随机抖动」与「唤醒方式/唤醒词」已并入拟人化（回复前的等待归打字节奏，
    // 要不要理人归拟人层门控），配置里残留的旧键在这里清掉，别让它们一直躺在文件里当死配置。
    for (const k of ['jitterMinMs', 'jitterMaxMs', 'groupWake', 'wakeWords'] as const) {
      delete (this.config.risk as any)[k];
    }
    // 拟人化不再有总开关（她不是可关的功能），旧配置里那个键同样清掉
    delete (this.config.humanlike as any).enabled;
    // 输出侧改用 HDSI 的 outgoing：MaiBot 的分段器/错字/打字速度与表达风格这四个旧键清掉，
    // 别让它们一直躺在文件里当死配置（老桌面端标签页回放的旧表单也写不回来 —— 白名单已同步）。
    for (const k of ['splitter', 'typo', 'typing'] as const) delete (this.config.humanlike as any)[k];
    // 输出侧 2026-10-17 起全部改纯程序：剧本体（script）与情绪偏移（alter）整层删除、
    // 分隔标记键（outgoing.messageSeparator）没人读、chat 工具轮上限（llm.maxToolRounds）
    // 换成两轮硬上限 —— 老配置里这几个键一并清掉，白名单已同步。
    delete (this.config.humanlike as any).script;
    delete (this.config.humanlike as any).alter;
    delete ((this.config.humanlike as any).outgoing ?? {}).messageSeparator;
    delete (this.config.llm as any).maxToolRounds;
    const hlTiming = (this.config.humanlike as any).timing;
    if (hlTiming && typeof hlTiming === 'object') {
      // 拟合概率 / 必要性两种触发方式已删（2026-10-23 用户定）：老配置里的选择与专用阈值清掉
      delete hlTiming.replyTriggerMode;
      delete hlTiming.necessityThreshold;
      delete hlTiming.replyStyle;
    }
    // 每会话历史条数统一在 storage.historyLimit（历史环形缓冲真正读的键）；llm 下那个从来没人消费
    delete (this.config.llm as any).historyLimit;
    // 好感度与心情整套删除（2026-10-16）：老配置里那个 affection 块（含段位表）清掉，别留死配置
    delete (this.config.persona as any).affection;
    // 记忆不再随上下文注入（改成后台提炼 + recall_facts 现查），那个"注入条数 Top-K"从此没人读
    delete (this.config.persona as any).memoryFactsTopK;
    atomicWriteJson(this.configFile, this.config);
    atomicWriteJson(this.secretsFile, this.secrets, { rotate: false });
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
    // ③ 预置的 Gemini 占位供应商已删（内核从未实现它的请求逻辑），旧配置里残留的条目一并清掉
    if (providers['gemini-3.8-flash'] && !providers['gemini-3.8-flash'].custom) {
      delete providers['gemini-3.8-flash'];
      delete llm.modelByProvider['gemini-3.8-flash'];
      llm.chatChain = llm.chatChain.filter((x: ModelRef) => x.provider !== 'gemini-3.8-flash');
      llm.workChain = llm.workChain.filter((x: ModelRef) => x.provider !== 'gemini-3.8-flash');
      if (llm.activeProvider === 'gemini-3.8-flash') llm.activeProvider = llm.chatChain[0]?.provider ?? '';
    }
  }

  /**
   * 迁移：链级思考强度（chatReasoning / workReasoning）→ 每个模型单独的 modelReasoning。
   * 旧值只迁给实际声明过该档位的链上模型；迁完删掉旧键，避免死配置继续躺在文件里。
   */
  private migrateModelReasoning(): void {
    const llm = this.config.llm as any;
    const providers = this.config.providers as Record<string, any>;
    if (!llm.modelReasoning || typeof llm.modelReasoning !== 'object' || Array.isArray(llm.modelReasoning)) {
      llm.modelReasoning = {};
    }
    const levelsOf = (pid: string, model: string): string[] => {
      const p = providers[pid];
      const m = (Array.isArray(p?.models) ? p.models : []).find((x: any) => x?.id === model);
      return (Array.isArray(m?.reasoningLevels) ? m.reasoningLevels : [])
        .map(String)
        .filter((v: string) => (REASONING_LEVELS as readonly string[]).includes(v));
    };
    for (const [kind, field] of [['chat', 'chatReasoning'], ['work', 'workReasoning']] as const) {
      const v = String(llm[field] ?? '');
      if ((REASONING_LEVELS as readonly string[]).includes(v)) {
        for (const ref of (kind === 'chat' ? llm.chatChain : llm.workChain) ?? []) {
          if (ref?.provider && ref?.model && levelsOf(ref.provider, ref.model).includes(v)) {
            llm.modelReasoning[`${ref.provider}|${ref.model}`] = v;
          }
        }
      }
      delete llm[field];
    }
  }

  /** 桌面端「已隐藏」的会话：内核在这一路上收不到任何东西——消息不落账、附件不落盘。
   *  chatPrefs 按 bot 登录号存；桌面端只有一个 bot 号，事实上的全局口径。 */
  chatHidden(selfId: string, type: 'group' | 'private', chatId: string): boolean {
    return !!this.config.ui.chatPrefs[selfId]?.hidden?.includes(`${type}_${chatId}`);
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
    // 密钥文件不留轮转副本：.bak 会把改掉/清掉的密钥长期留在盘上
    atomicWriteJson(this.secretsFile, this.secrets, { rotate: false });
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
