// ============================================================
// parallel 内核共享类型 —— 插件与内核之间的全部契约
// ============================================================

/** 发送段（OneBot 风格的归一化消息段） */
export interface MsgSegment {
  type: 'text' | 'at' | 'image' | 'face' | 'reply' | 'file' | 'record' | 'video' | 'json' | 'forward';
  data: Record<string, unknown>;
}

/** 聊天引用：platform + 类型 + 会话 id 唯一定位一个聊天 */
export interface ChatRef {
  platform: string;          // 'qq' | 'mock' | ...
  type: 'group' | 'private';
  chatId: string;            // 群号 或 对方 QQ 号
}

/** 归一化的入站聊天事件（适配器产出，Pipeline 消费） */
export interface ChatEvent {
  id: string;                // 内部事件 id
  platform: string;
  type: 'group' | 'private';
  chatId: string;
  userId: string;
  nickname: string;
  senderRole: 'owner' | 'admin' | 'member' | 'unknown';
  segments: MsgSegment[];
  text: string;              // 纯文本拼接（at 展开为 @昵称）
  isAtMe: boolean;
  isReplyToMe: boolean;
  messageId?: string;
  /** 引用链快照：适配器给出 reply 段的原消息 id，内核在落账前把它查出来钉在这（桌面端画气泡内的引用块）。
   *  files 一起带上：被引用的常常是一张图，只给 text="[图片]" 桌面端就没法出预览。 */
  replyTo?: { userId: string; nickname: string; text: string; files?: { name: string; rel: string }[] };
  files?: IncomingFile[];    // 消息内文件/图片（由适配器落盘到沙箱 inbox 后挂上来）
  /** 消息里的「聊天记录」合集（合并转发）：段里只有一个 resId，正文靠适配器向协议端现取 */
  forward?: ForwardRecord;
  raw: unknown;
  ts: number;
  /** 内核解析后的三级角色（owner/admin/member），工具与命令边界用 */
  role?: Role;
}

export interface IncomingFile {
  name: string;
  rel: string;               // 沙箱内相对路径（inbox/xxx；重名时 saveInbox 会加 _1 后缀，只有这个是真落盘的）
  sandboxPath: string;       // 已落入沙箱 inbox 的绝对路径
  size: number;
  /** 下载时那份协议端临时 URL：**只活在本次事件里，不落盘**（带 rkey，且几小时就过期）。
   *  视频进模型必须靠它——对端取不了我们本机路径，而语音能本机转码所以不看这个字段。 */
  url?: string;
}

/** 聊天记录合集里的一条（合并转发的一个节点） */
export interface ForwardNode {
  nickname: string;
  userId: string;
  text: string;              // 节点正文；语音/视频仍是 [语音]/[视频] 占位
  ts: number;
  /** 记录套记录时它在第几层（0 = 最外面那份）；界面据此缩进，模型那边按层加前缀 */
  depth?: number;
  /** 记录里的图片：与顶层图片同一套口径落进沙箱 inbox，桌面端据此出缩略图 */
  files?: IncomingFile[];
}

/**
 * 「聊天记录」合集本体（QQ 的合并转发）。
 * 入站段里只给一个 resId，节点要靠 get_forward_msg 现取一次；取不到就是 failed，
 * 界面留着 [聊天记录] 占位、模型也只看到占位，不编内容。
 */
export interface ForwardRecord {
  id: string;
  title: string;             // 协议端有时带（如「群聊的聊天记录」），没带就空着由界面写「聊天记录」
  nodes: ForwardNode[];
  /** 节点总数超过上限时，被丢掉的那部分条数（0 = 全拿到了） */
  dropped: number;
  failed: boolean;
}

// ---------------- 权限 ----------------

/** 三级角色：主人 > 群管理员/群主 > 普通用户 */
export type Role = 'owner' | 'admin' | 'member';

export type PluginPermission =
  | 'network'        // 允许出网（含 MCP servers）
  | 'memory.read'
  | 'memory.write'
  | 'sandbox.exec'   // 执行沙箱脚本
  | 'fs.sandbox'     // 读写沙箱文件
  | 'container'      // 使用常驻会话容器（状态化 Python / 浏览器）
  | 'work.delegate'  // 把任务委派给 work 子代理（work 模型）
  | 'history.search' // 检索会话历史消息（仅限当前会话）
  | 'schedule';      // 注册定时任务

// ---------------- 插件清单 ----------------

export interface UserConfigField {
  type: 'string' | 'number' | 'boolean' | 'text';
  default: string | number | boolean;
  description: string;
  secret?: boolean;        // 敏感项：存 secrets、UI 脱敏
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: { name: string; url?: string };
  license?: string;
  keywords?: string[];
  category: 'core' | 'persona' | 'tool' | 'fun' | 'info' | 'system';
  trust: 'builtin' | 'example' | 'user';
  permissions: PluginPermission[];
  personas?: string[];           // persona 类插件：提供的人格 id
  locked?: boolean;              // 锁定：仅主人可开关/查看详情（persona 类默认 true）
  core?: boolean;                // core：不可被卸载/运行时停用（如 plugin-manager）
  /** 不在插件页/`/插件 列表`里出现：能力已集成到别的页面（人格/设置/沙箱/工作），插件本身照常运行 */
  hidden?: boolean;
  defaultGroupState: 'on' | 'off';
  userConfig?: Record<string, UserConfigField>;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

// ---------------- LLM 工具 ----------------

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolContext {
  event: ChatEvent;            // 触发本轮对话的事件
  chat: ChatRef;
  role: Role;                  // 调用者角色
  /** work 轮才有：本层的嵌套深度与运行 id（子代理委派工具据此算下一层的深度与父 id） */
  work?: { depth: number; runId?: string; agent?: string };
}

/**
 * 工具在哪个面上可见（pi 的 tool surface 思想）：
 *  - `both`（默认）：chat 轮与 work 轮都能用；
 *  - `work`：只属于 work 子代理（常驻 Python 会话、浏览器、shell 这类重工具），chat 轮严格看不见。
 * 由 `toolsForChat(chat, role, surface)` 在收集阶段就过滤掉，不是"注册了但调用时拒绝"。
 */
export type ToolSurface = 'both' | 'work';

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  /** 可选：工具要求的最低角色，默认 member */
  minRole?: Role;
  /** 是否向普通用户隐藏该工具的存在（仅主人可见可用） */
  ownerOnly?: boolean;
  /** 可见面，默认 both */
  surface?: ToolSurface;
  /**
   * 「可用工具」清单里的一行说明（pi 的 promptSnippet）。
   * 缺省时该工具不出现在 work system 的工具清单里。
   */
  promptSnippet?: string;
  /**
   * 使用该工具时要遵守的规则条目（pi 的 promptGuidelines）。
   * 由内核按「本轮实际生效的工具」汇总去重成 work system 的规则节——
   * 工具面一变规则自动跟着变，不会像手写 prompt 那样漂移。
   */
  promptGuidelines?: string[];
  handler(args: Record<string, unknown>, tctx: ToolContext): Promise<string | ToolResult> | string | ToolResult;
}

export interface ToolResult {
  content: string;
  /** 需要主人注意的通知（进报错中心） */
  notify?: string;
  /** 只给桌面端「工作」面板的结构化信息，不进模型上下文 */
  meta?: ToolMeta;
  /**
   * 本批工具调用完成后即可收尾（pi 的 terminate）：work 轮用，
   * 表达"活干完了、不必再要一轮"。同一批全部为真才生效。
   */
  terminate?: boolean;
  /**
   * 直接作为本轮的最终回答（与 terminate 搭配）。
   * 用于「收尾类工具」：模型把交付内容交给工具，工具把它变成最终回答，
   * 避免再耗一轮让模型复述一遍（也就避免了复述时的走样）。
   */
  finalReply?: string;
}

/** 工具动作的结构化说明（UI 用来画 +N -M 与文件主体） */
export interface ToolMeta {
  path?: string;
  added?: number;
  removed?: number;
  /** 本次调用产出的文件（会话沙箱内相对路径）：work 侧据此汇总产物清单 */
  artifacts?: string[];
  /** 收尾类工具：这次不是"干完了"，而是停下来等发起者回答（work_ask） */
  awaiting?: boolean;
  /** awaiting 时要问发起者的那句话 */
  question?: string;
  /** awaiting 时附的"已经做到哪一步" */
  notes?: string;
}

// ---------------- 聊天命令 ----------------

export interface CommandDef {
  name: string;                 // '/插件' 的 '插件'，不带斜杠
  aliases?: string[];
  description: string;
  usage?: string;
  minRole?: Role;
  hidden?: boolean;             // 不出现在帮助里（如 owner 专属工具命令）
  handler(args: string[], event: ChatEvent): Promise<CommandReply> | CommandReply;
}

export interface CommandReply {
  text?: string;
  segments?: MsgSegment[];
  /** 以文件回复（必须是当前会话沙箱内路径） */
  sandboxFile?: string;
}

// ---------------- 生命周期钩子 ----------------

export interface PluginHooks {
  /** Pipeline 早期（唤醒判定后、命令分发前） */
  onChatMessage?(event: ChatEvent): void | Promise<void>;
  /** LLM 请求发出前：可修改 system/messages（人格插件的核心插槽） */
  beforeLLM?(req: LLMRequestContext): Promise<LLMRequestContext> | LLMRequestContext;
  /**
   * work 轮（workTurn）的 system 组装插槽：与 beforeLLM 分开，两边互不干扰。
   * 只有 work 轮会跑这条链；chat 轮跑 beforeLLM。插件往 req.systemSections 里 push 自己的节。
   */
  beforeWorkLLM?(req: LLMRequestContext): Promise<LLMRequestContext> | LLMRequestContext;
  /** 模型产出后、发送前：可校验/改写 */
  afterLLM?(req: LLMRequestContext, reply: string): Promise<string> | string;
  /** 插件卸载前最后清理机会 */
  onUnload?(): void | Promise<void>;
}

export interface LLMRequestContext {
  chat: ChatRef;
  event: ChatEvent;
  system: string;
  /**
   * 分节注入（dsh 式 section 组装）：插件在 beforeLLM / beforeWorkLLM 里往这里 push 自己的节，
   * 不再整体覆盖 system。AgentLoop 组装时把 system 与 systemSections 按 order 稳定排序合并；
   * 带 `name` 的节渲染成 `<name>…</name>`（pi 式具名节，便于按节定位与差分）。
   * order 参考：内核固定节 0-999（身份 0 / 会话 100 / 风格 200 / 安全 300 / 压缩 400，
   * work 轮另有 任务 420 / 工具 600 / 规则 620 / 沙箱 700 / 交付 800），
   * 插件节建议从 1000 起（人格 1000 / 世界书 1100 / 状态 1200 / 记忆 1300 / 子代理身份 1400）。
   */
  systemSections?: SystemSection[];
  messages: ChatMessage[];     // 不含 system
  tools: ToolDef[];            // 本群生效的工具集合
  /** 本轮消息携带的媒体（从消息段解析）；是否真发给模型取决于当前模型的 inputTypes */
  attachments?: MessageAttachment[];
  /** 本轮由 /work <任务> 触发（work 子代理轮）：插件可据此接管 system；仅本轮有效 */
  workTurn?: boolean;
  /** /work 命令携带的任务原文（workTurn 时存在） */
  workTask?: string;
  /** 本轮的 work 子代理定义（workTurn 时存在；内核按它筛工具面、插件按它写身份节） */
  workAgent?: WorkAgentDef;
  /** 触发来源（workTurn 时存在；目前只有 command） */
  workTrigger?: 'command';
  /** 本次 work 轮的嵌套深度（入口 = 0）；达到上限时子代理工具面里不再有 delegate */
  workDepth?: number;
  /** 本次 work 运行的 id（子代理委派时作为 parentId 透传，桌面端表达嵌套） */
  workRunId?: string;
}

// ---------------- work 子代理 ----------------

/**
 * work 子代理的 agent 定义（对齐 pi 的 `agents/*.md`：frontmatter 声明能力 + 正文写身份）。
 * 定义来自 `src/plugins/work/agents/*.md`（内置）与 `<data>/agents/*.md`（用户自加，同名覆盖），
 * 内核侧有内置兜底。关键点：正文只是 system 的一个分节，不是整张 prompt——
 * 内核固定节与按实际工具面生成的规则仍然生效。
 */
export interface WorkAgentDef {
  name: string;
  description: string;
  /** 工具白名单（缺省 = 全部 work 面工具） */
  tools?: string[];
  /** 轮次上限（缺省 = 无上限，用户定稿的 work 语义） */
  maxRounds?: number;
  /** 跑哪条模型链（缺省 work；子代理可声明走 chat 链） */
  chain?: 'work' | 'chat';
  /** 来源：内置（随仓库）或用户自加 */
  source?: 'builtin' | 'user';
  /** 身份与人设正文 */
  instructions: string;
}

/** 一节 system 提示：order 决定拼接顺序（小的在前）。
 *  `name` 给了就渲染成 `<name>…</name>`（pi 式具名节）；只给 `title` 则是纯文本节（chat 现状）。 */
export interface SystemSection {
  order: number;
  text: string;
  /** 具名节的标签名（小写字母/数字/下划线/连字符）；不给则不加标签 */
  name?: string;
  /** 仅日志诊断用 */
  title?: string;
}

/** 具名节的合法标签名（对齐 pi 的 section name 规则） */
const SECTION_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** 把主 system 与分节按 order 合并成最终 system 文本（order 相同按插入序稳定排序）。
 *  带 `name` 的节渲染成 `<name>\n…\n</name>`；不带的原样拼接（保持 chat 侧输出不变）。
 *  `tail` 永远排在最后：人格插件那种"尾部强化"靠位置取胜，不该被 order 挪到中间。 */
export function composeSystem(main: string, sections?: SystemSection[], tail?: string): string {
  const sorted = (sections ?? [])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order - b.s.order) || (a.i - b.i))
    .map((x) => x.s);
  const parts: string[] = [];
  if (main.trim()) parts.push(main.trim());
  for (const s of sorted) {
    const text = s.text?.trim();
    if (!text) continue;
    if (s.name && SECTION_NAME_RE.test(s.name)) parts.push(`<${s.name}>\n${text}\n</${s.name}>`);
    else parts.push(text);
  }
  if (tail?.trim()) parts.push(tail.trim());
  return parts.join('\n\n');
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 这条消息的入账时刻（毫秒）。上下文时间窗（storage.contextMinutes）按它筛历史快照 */
  ts?: number;
  /** 这条消息带的媒体（图/语音/视频）：窗口内重放历史时与文本一起交回模型 */
  attachments?: MessageAttachment[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ---------------- LLM Provider ----------------

/** 本轮消息携带的媒体。pipeline 从协议端消息段解析出来，
 *  LlmService 再按当前模型声明的 inputTypes 过滤，最后由各线格式拼成多模态 content。 */
export interface MessageAttachment {
  kind: 'image' | 'audio' | 'video';
  /** 远端可直接取的地址（QQ 图片/语音段常带 url） */
  url?: string;
  /** 本机文件路径（没有 url 时读出来转 base64） */
  path?: string;
  name?: string;
  /** 转 base64 时的媒体类型；缺省按 kind 兜底 */
  mime?: string;
}

export interface LLMChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[];
  /** 输出上限（Anthropic Messages 必填；取自模型行的「最大输出」；测试连接时压到 1） */
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  // —— 以下两项由 LlmService 解析模型配置后注入，插件/调用方不要手填 ——
  /** 本轮附件（已按该模型 inputTypes 筛过） */
  attachments?: MessageAttachment[];
  /** 该模型自带联网搜索：线格式据此发出原生搜索开关 */
  nativeSearch?: boolean;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  /** 命中提示词缓存的 token（DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens）；协议端不给则为 0 */
  cacheHitTokens?: number;
  /** 未命中的提示词 token；协议端只给 prompt_tokens 时由前者推算 */
  cacheMissTokens?: number;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: LLMUsage;
  finishReason?: string;
}

export interface LLMProvider {
  id: string;                  // 'deepseek' | 'openai-compatible' | ...
  label: string;
  /** false = 仅注册未实现请求逻辑，调用时报"未接入"（预置供应商当前全部已实现） */
  implemented: boolean;
  /** 支持流式 */
  streaming: boolean;
  chat(req: LLMChatRequest): Promise<LLMResponse>;
  /** 流式接口：逐 delta 回调（文本与工具调用增量），最终 resolve 完整结果 */
  chatStream?(
    req: LLMChatRequest,
    onDelta: (delta: { text?: string; toolCall?: Partial<ToolCall> & { index: number } }) => void,
  ): Promise<LLMResponse>;
}

// ---------------- 定时任务 ----------------

export interface ScheduleJob {
  id: string;
  /** 'HH:MM' 每日触发，或 intervalMs 毫秒间隔 */
  dailyAt?: string;
  intervalMs?: number;
  /** 主动推送类任务必须声明；默认关闭，仅主人可在 UI 开启 */
  proactive?: boolean;
  handler(): void | Promise<void>;
}

// ---------------- 用户记忆 ----------------

export interface UserProfile {
  userId: string;
  nickname: string;
  remark?: string;
  firstSeen: number;
  lastSeen: number;
  blocked: boolean;
}

export interface UserFact {
  id: string;
  userId: string;
  content: string;
  sourcePlugin: string;
  sourceChat: string;
  weight: number;
  ts: number;
  expiresAt?: number;
}

// ---------------- 插件上下文（容器注入） ----------------

export interface PluginContext {
  manifest: PluginManifest;
  /** 插件专属数据目录（卸载时不删除，重装沿用） */
  pluginDataDir: string;
  log: Logger;
  /** 结构化事件总线 */
  bus: Bus;
  /** 读内核配置（只读副本） */
  config: Readonly<Record<string, unknown>>;
  /** 本插件 userConfig 实例化值（secret 字段返回真实值） */
  userConfig: Record<string, unknown>;
  /** 插件专属持久化 KV */
  state: {
    get<T = unknown>(key: string, def?: T): T;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    all(): Record<string, unknown>;
  };
  /** 发消息（自动分段 + 节流 + 抖动） */
  chat: ChatSendService;
  /** 用户记忆（按 manifest 权限门控） */
  memory: GatedMemory;
  /** 沙箱（按 manifest 权限门控） */
  sandbox: GatedSandbox;
  /** 会话容器（状态化 Python / 浏览器；需 container 权限） */
  session: GatedSession;
  /** work 子代理委派（chat 模型把任务交给 work 模型执行；需 work.delegate 权限） */
  work: GatedWork;
  /** 拟人层（内核自有）：日程读写 + 状态查询（HDSI Schedule/Alter/Rhythm） */
  humanlike: GatedHumanlike;
  /** 会话历史检索（需 history.search 权限）：只能搜当前会话，不是全库 */
  history: GatedHistory;
  /** LLM：注册工具 + 直连补全（需在 manifest 声明 llm 能力即默认可用） */
  llm: {
    registerTool(def: ToolDef): void;
    chat(req: LLMChatRequest): Promise<LLMResponse>;
  };
  /** 注册 QQ/桌面命令 */
  registerCommand(def: CommandDef): void;
  /** 定时任务（需 schedule 权限） */
  schedule: {
    register(job: ScheduleJob): void;
  };
  /** 事件订阅（自动跟踪，卸载时清理） */
  on(event: string, handler: (...args: any[]) => void): void;
  /** 跟踪资源的定时器（卸载时自动清理） */
  setInterval(fn: () => void, ms: number): void;
  setTimeout(fn: () => void, ms: number): void;
  /** 手工登记清理函数（子进程、连接等），卸载时逆序调用 */
  onDispose(fn: () => void): void;
  hooks: PluginHooks;
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  debug(msg: string, extra?: Record<string, unknown>): void;
}

export interface Bus {
  emit(event: string, ...args: any[]): void;
  on(event: string, handler: (...args: any[]) => void): () => void;
  once(event: string, handler: (...args: any[]) => void): () => void;
}

export interface ChatSendService {
  send(chat: ChatRef, segments: MsgSegment[]): Promise<void>;
  sendText(chat: ChatRef, text: string): Promise<void>;
  /** 发送文件：仅允许沙箱内路径（内核强校验） */
  sendFile(chat: ChatRef, sandboxPath: string): Promise<void>;
  /** 直接回复某个事件（省去构造 ChatRef） */
  reply(event: ChatEvent, text: string): Promise<void>;
}

/** 协议端给出的登录二维码（WebUI 代理或 OneBot 扩展动作） */
export interface LoginQrcode { png: string; url: string; expireSec: number; pollMs: number }

/** 协议端完整性检查的一条结果 */
export interface EndCheck {
  state: 'pass' | 'warn' | 'fail';
  label: string;
  detail: string;
}

/**
 * 内核托管的协议端（LLBot 与 NapCat 各自实现）。
 * 对内核来说两者只是同一个 OneBot 11 反向 WS 的两个来源，差别全在"谁被下载、拉起、守护、代理登录"。
 * 托管常驻开启：桌面内核启动即 start()，没有关的入口。
 */
export interface ProtocolEnd {
  readonly id: 'llbot' | 'napcat';
  running(): boolean;
  /** 给桌面端与登录页看的状态包：各端字段不同，前端按 protocol 分支渲染 */
  status(): Record<string, unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 完整性与可用性逐项检查（发行包在不在、QQ 探到没探到、进程、控制台可达…） */
  check(): Promise<EndCheck[]>;
  webuiUrl(): string;
  fetchQrcode(): Promise<LoginQrcode | null>;
  loginInfo(): Promise<{ online: boolean; uin: string; nick: string } | null>;
}

export interface GatedMemory {
  getProfile(userId: string): UserProfile;
  addFact(userId: string, fact: { content: string; ttlDays?: number; weight?: number }): void;
  searchFacts(userId: string, query: string, limit?: number): UserFact[];
  topFacts(userId: string, limit?: number): UserFact[];
  getAttr<T = unknown>(userId: string, key: string): T | undefined;
  setAttr(userId: string, key: string, value: unknown): void;
  /** 清空某用户全部记忆（"忘记我"） */
  forget(userId: string, opts?: { keepBlocked?: boolean }): void;
  listUsers(filter?: { blocked?: boolean }): UserProfile[];
  deleteFacts(userId: string, ids: string[]): void;
  recentOps(limit?: number, userId?: string): MemoryOp[];
}

export interface MemoryOp {
  id: string;
  userId: string;
  op: string;
  payload: string;
  source: string;
  ts: number;
}

export interface GatedSandbox {
  /** 当前会话沙箱根目录 */
  root(chat: ChatRef): string;
  list(chat: ChatRef, relPath?: string): SandboxEntry[];
  read(chat: ChatRef, relPath: string): string;
  write(chat: ChatRef, relPath: string, content: string | Buffer, opts?: { work?: boolean }): SandboxWriteResult;
  delete(chat: ChatRef, relPath: string): void;
  run(chat: ChatRef, opts: { language: 'python' | 'javascript'; code: string; timeoutMs?: number }): SandboxRunResult;
  /** work 模式扩展：powershell/bash + work 档配额（工具层负责 minRole 门槛） */
  runAny(chat: ChatRef, opts: { language: 'python' | 'javascript' | 'powershell' | 'bash'; code: string; timeoutMs?: number; work?: boolean }): SandboxRunResult;
  stats(): SandboxStat[];
  clear(chat: ChatRef): void;
}

export interface GatedSession {
  /** 常驻 Python 会话是否可用（Docker 就绪） */
  available(): boolean;
  /** 在常驻会话容器里执行 Python（变量跨调用保留；restart 重置内核） */
  runPython(chat: ChatRef, code: string, timeoutMs?: number, restart?: boolean): Promise<{ status: string; outputs: SandboxOutput[]; executionCount?: number }>;
  /** 浏览器动作（有网、页面/登录态跨调用保留） */
  browser(chat: ChatRef, action: string, args?: Record<string, unknown>): Promise<{ ok: boolean; text?: string; image?: string; error?: string }>;
  /** 常驻容器状态（桌面端展示） */
  status(): { kind: string; chat: string; id: string; idleMs: number }[];
  /** 重置某会话的容器（沙箱清空时联动） */
  reset(chat: ChatRef): Promise<void>;
}

export interface SandboxOutput {
  type: string;
  name?: string;
  text?: string;
}

export interface WorkDelegateInput {
  chat: ChatRef;
  task: string;
  userId: string;
  nickname?: string;
  role: string;
  /** 目标子代理名（缺省 = 入口 agent）；取 agents 注册表里的条目 */
  agent?: string;
  /** 触发来源：/work 命令或上一层 work 子代理的 delegate 工具 */
  trigger?: 'command' | 'subagent';
  /** 嵌套深度（入口 0，子代理逐层 +1） */
  depth?: number;
  /** 发起这次委派的父运行 id（桌面端「工作」页表达嵌套） */
  parentId?: string;
  abort?: AbortSignal;
}

export interface GatedHumanlike {
  /** 读某会话的日程计划（周规律 + 日期例外） */
  scheduleOf(chat: ChatRef): { rules: { days: number[]; from: string; to: string; label: string; busy?: boolean }[]; exceptions: { date: string; from: string; to: string; label: string; busy?: boolean }[] };
  /** 写某会话的日程计划（会顺手清过期项并截断容量） */
  planSchedule(chat: ChatRef, plan: { rules?: unknown[]; exceptions?: unknown[] }): { rules: unknown[]; exceptions: unknown[] };
  /** 拟人层当前状态快照（排障：为什么不出声 / 氛围 / 节奏） */
  snapshot(chat: ChatRef): Record<string, unknown>;
}

/** 会话历史检索的一条命中 */
export interface HistoryHit {
  ts: number;
  role: 'user' | 'assistant';
  nickname?: string;
  text: string;
}

export interface GatedHistory {
  /** 关键词检索**当前会话**的历史消息（入站+出站原文），按时间正序返回最近 limit 条命中 */
  searchMessages(chat: ChatRef, q: string, limit?: number): HistoryHit[];
}

export interface GatedWork {
  /** work 模型标识（如 'deepseek:deepseek-reasoner'），桌面端展示 chat/work 双模型 */
  modelLabel(): string;
  /** 可委派的子代理清单（delegate 工具的描述与 work system 的子代理节用） */
  agents(): { name: string; description: string; tools?: string[]; source?: string }[];
  /** 委派一个任务给 work 模型执行（阻塞直到完成；返回结论 + 产物） */
  delegate(input: WorkDelegateInput): Promise<{ id: string; ok: boolean; summary: string; artifacts: string[]; rounds: number; toolCalls: number; durationMs: number; notes?: string; error?: string }>;
  /** 最近任务（桌面端「工作」页） */
  list(limit?: number): unknown[];
}

export interface SandboxEntry {
  name: string;
  relPath: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

export interface SandboxWriteResult {
  relPath: string;
  size: number;
  /** 文本写入时的行增减（新建文件 removed=0；二进制/Buffer 写入不计算） */
  added?: number;
  removed?: number;
}

export interface SandboxRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxStat {
  chat: string;         // 'group_123' | 'private_456'
  root: string;
  files: number;
  bytes: number;
  lastActivity: number;
}
