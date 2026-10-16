import type { ChatEvent, CommandReply, LLMRequestContext, MessageAttachment, Role, SystemSection } from './types.ts';
import type { PluginContainer } from './container.ts';
import type { AgentLoop, HistoryStore } from './agentloop.ts';
import type { ChatService } from './services/chat.ts';
import type { MemoryService } from './services/memory.ts';
import type { SessionLog } from './sessionlog.ts';
import type { WorkRunner } from './services/work.ts';
import type { ConfigStore } from './config.ts';
import type { ErrorCenter } from './errors.ts';
import type { Bus } from './bus.ts';
import type { Db } from './db.ts';
import type { HumanlikeService } from './humanlike/index.ts';
import type { TriggerBatch } from './humanlike/types.ts';
import { scriptFormatText, SILENT_MARKER, isSilentScene } from './humanlike/script.ts';

/** 圈内黑话（表达学习）的 hook 面；可选依赖——没接（测试/降级）就整个旁路 */
interface JargonHook {
  observe(event: ChatEvent): void;
  sections(chat: import('./types.ts').ChatRef): string | null;
}
import { AGENCY_REASON_ZH } from './humanlike/agency.ts';
import { todayKey, newId } from './util/misc.ts';
import { inboundModelText } from './util/modeltext.ts';
import { CONTEXT_CONTINUITY_TEXT, TRUST_BOUNDARY_TEXT, chatIdentitySystem } from './prompt-sections.ts';
import { composeContinueTask, type PendingAsk } from './work-prompt.ts';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

/** 按扩展名猜媒体类型；猜不出来返回 undefined，由线格式按 kind 兜底 */
function mimeOf(hint: string): string | undefined {
  const ext = (hint.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
    amr: 'audio/amr', slk: 'audio/silk', silk: 'audio/silk', m4a: 'audio/mp4', aac: 'audio/aac',
    webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    mp4: 'video/mp4', mov: 'video/quicktime',
  } as Record<string, string>)[ext];
}

/** 本轮消息里的媒体：优先用适配器已经落进沙箱的那份（语音在那一步顺手转成了 wav，模型直接吃这份），
 *  没有落盘件才退回段里的原始字段。正文里的 [图片]/[语音] 占位与历史存储都不受影响。
 *  聊天记录（合并转发）里的图也算本轮的图：适配器已把它们落进沙箱，模型看得见图才叫"读到了那份记录"。 */
export function attachmentsOf(event: ChatEvent): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const push = (kind: MessageAttachment['kind'], cand: Record<string, unknown>, name: string | undefined) => {
    const cands = [cand.url, cand.file].map((v) => String(v ?? '')).filter(Boolean);
    const url = cands.find((v) => /^https?:\/\//.test(v));
    // 段里的 file 常常是协议端的文件号（"xxx.amr" 这种裸名），那不是路径：当成路径会让内核去读一个
    // 并不存在的文件，还把 url 那条回退顶掉——顶层图片/语音就是这么一声不吭地进不了模型的。
    const local = cands.find((v) => !/^https?:\/\//.test(v) && (v.startsWith('file://') || isAbsolute(v)));
    const path = local ? (local.startsWith('file://') ? fileURLToPath(local) : local) : undefined;
    if (!url && !path) return;
    // QQ 的下载地址是 `.../download?appid=...`，扩展名只在文件名上，所以按 路径→名字→URL 依次猜
    const mime = [path, name, url].map((v) => (v ? mimeOf(String(v)) : undefined)).find((m) => m !== undefined);
    out.push({ kind, url, path, name, mime });
  };
  for (const s of event.segments) {
    const kind = s.type === 'image' ? 'image' : s.type === 'record' ? 'audio' : s.type === 'video' ? 'video' : null;
    if (!kind) continue;
    // 落盘件与段靠下载时那个 URL 对上号（取法与 pullMedia 一致：url 优先、temp_url 次之）
    const segUrl = String(s.data.url ?? s.data.temp_url ?? '');
    const f = segUrl ? event.files?.find((x) => x.url === segUrl) : undefined;
    push(kind, f ? { url: f.url, file: f.sandboxPath } : s.data,
      String(f?.name ?? s.data.voice_name ?? s.data.file ?? '') || undefined);
  }
  // 记录里的媒体按扩展名分回三类。补传口径 = 下载口径：适配器取回时已按 FORWARD_MAX_NODE_IMAGES /
  // FORWARD_MAX_NODE_MEDIA 守住预算，这里照单全收、不再二次砍（砍过就会"下了图却不给模型看"）
  for (const n of event.forward?.nodes ?? []) {
    for (const f of n.files ?? []) {
      const mime = mimeOf(f.name) ?? '';
      const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'image';
      push(kind, f.url ? { file: f.sandboxPath, url: f.url } : { file: f.sandboxPath }, f.name);
    }
  }
  return out;
}

/**
 * 模型是否选择了沉默。
 * 判据统一交给剧本体的 `isSilentScene`（`[silent]`，兼容旧的 `SKIP`），
 * 这样"这轮不说话"在普通轮和主动轮里是同一个语义。
 */
export function isSilentReply(reply: string): boolean {
  return isSilentScene(reply);
}

/** 把一批被合并的消息渲染成模型看到的用户输入（说话人前缀统一走 modelTextOf，见下） */
function renderBatch(events: ChatEvent[]): string {
  if (events.length === 1) return modelTextOf(events[0]);
  return events.map(modelTextOf).join('\n');
}

/**
 * 模型看到的入站正文。净化规则与历史回读共用同一个函数（`util/modeltext`）：
 * 引用占位换成被引用的原文，`[聊天记录]` 换成展开后的正文——占位是给界面看的，
 * 模型那边必须读到内容，否则群友递过来一份记录它等于什么都没看见。
 */
function modelTextOf(event: ChatEvent): string {
  // 群聊把说话人放进正文：昵称优先、无昵称给 QQ 号——模型本来拿不到账号（ChatMessage 不存昵称），
  // 这是它「群里谁在说话」的唯一来源；私聊对面是谁 system 已写明，不画蛇添足。
  return inboundModelText({
    text: event.text,
    replyTo: event.replyTo,
    forward: event.forward,
    nickname: event.type === 'group' ? (event.nickname || event.userId) : undefined,
  });
}

/**
 * 上下文窗口的梳理点对齐（tumbling 网格，2026-10-16 用户裁定②）：
 * 起点只在整格边界上动——两次梳理之间消息只增不减，供应商前缀缓存跨轮复用；
 * 跨格那一刻整段裁一次。实际覆盖 = 起点（≤ now - N 分钟）到 now，在 N~2N 分钟之间。
 * 网格以 epoch 起算、全体会话共用一把尺子，无需按群错峰。
 */
export function windowAnchorTs(nowMs: number, minutes: number): number {
  const span = Math.max(1, Math.round(minutes)) * 60_000;
  return Math.max(0, Math.floor((Math.max(0, nowMs) - span) / span) * span);
}

/** 「本轮媒体补传」分节里的媒体名（与 chainStreamFn 的 warn 用同一套中文写法） */
const MEDIA_KIND_ZH: Record<MessageAttachment['kind'], string> = { image: '图片', audio: '语音', video: '视频' };

/**
 * 一条来源的媒体清单：「HH:MM 昵称或号码：图片×n / 语音×n / 视频×n」；这条来源没有媒体就返回 undefined。
 * 只有窗口内的历史消息拿不到作者（ChatMessage 不带昵称），调用方按"更早的消息"标注。
 */
function mediaLineOf(who: string, ts: number | undefined, atts: MessageAttachment[] | undefined): string | undefined {
  const count: Record<MessageAttachment['kind'], number> = { image: 0, audio: 0, video: 0 };
  for (const a of atts ?? []) count[a.kind]++;
  const parts = (['image', 'audio', 'video'] as const)
    .filter((k) => count[k] > 0)
    .map((k) => `${MEDIA_KIND_ZH[k]}×${count[k]}`);
  if (!parts.length) return undefined;
  const d = ts ? new Date(ts) : undefined;
  const hhmm = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '--:--';
  return `${hhmm} ${who}：${parts.join(' / ')}`;
}

/**
 * 消息流水线（AstrBot 式分层 + 内置拟人层）：
 * 入站归一化 → 黑名单 → **拟人层门控**（@/私聊直通；群聊按必要性打分 + 防抖合并）→ 插件钩子
 * → 命令分发 / AgentLoop → **逐条分段发送**。
 *
 * 与重构前的差别只在 chat 区：唤醒判定从「@ 或唤醒词」换成 MaiBot 那套打分，
 * 出站从「整条发」换成「按语义拆成几条短消息 + 打字停顿」。命令与 work 链路一行未动。
 */
/**
 * 「work 停下来提问」等回答的有效期：超过这么久，旧问题不再自动接续
 * （隔一天回来随手发一句 /work，不该把老任务又拉起来）。
 */
const PENDING_WORK_TTL_MS = 30 * 60_000;

export class Pipeline {
  private queues = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  private activeTurns = new Map<string, number>();
  private adminHintAt = new Map<string, number>();
  private queueLens = new Map<string, number>();
  /** 每个会话一条"work 问了还没答"的现场（chatKey → 现场） */
  private pendingWork = new Map<string, PendingAsk>();

  constructor(
    private plugins: PluginContainer,
    private agentLoop: AgentLoop,
    private history: HistoryStore,
    private chat: ChatService,
    private memory: MemoryService,
    private sessionLog: SessionLog,
    private config: ConfigStore,
    private errors: ErrorCenter,
    private bus: Bus,
    private db: Db,
    private workRunner: WorkRunner,
    private humanlike: HumanlikeService,
    private resolveRole: (event: ChatEvent) => Role,
    private groupTitle: (chatId: string) => string,
    private selfNickname: () => string,
    private selfId: () => string,
    private jargon?: JargonHook,
  ) {}

  // ---------------------------------------------------------------- 入站

  /** 适配器统一入口 */
  submit(event: ChatEvent): void {
    // 隐藏会话（桌面端「已隐藏」）：当成没说过——不落账、不记用量、不进拟人层。
    // 附件的下载也在适配器那头就挡掉了；解除隐藏后只恢复"此后的"入站，不补历史。
    if (this.chatHidden(event)) return;
    const chat = { platform: event.platform, type: event.type, chatId: event.chatId };
    // 先把该会话的历史缓存暖起来（首次会从会话日志重建）。**必须在 logInbound 之前**：
    // 否则重建时会把本条消息也读成"历史"，而 agentTurn 又会把它当"本轮输入"再追加一次，
    // 于是首轮请求里同一条用户消息出现两遍（抓报文时肉眼可见）。
    this.history.get(chat);
    // 入站一律先落账：拟人层可能决定不回，但"群里说了什么"必须留在会话流里，
    // 「为什么没回」由紧跟着的 gate 条目解释。
    // 引用段只带原消息号，落账前查回原文钉进条目（桌面端气泡里的引用块用它）
    this.attachReply(event);
    this.sessionLog.logInbound(event);
    this.memory.touchUser(event.userId, event.nickname);
    this.bumpUsage('messages_in');

    if (event.type === 'group') {
      const r = this.humanlike.ingest(event, { isCommand: isCommandText(event.text) });
      if (r.action === 'handled') return;                    // 拟人层接管：攒着，攒够了它会回调 enqueueBatch
      this.enqueue(r.events);
      return;
    }
    // 私聊无条件立即处理（拟人层只更新它的统计，不做门控）
    this.humanlike.ingest(event, { isCommand: isCommandText(event.text) });
    this.enqueue([event]);
  }

  /** 拟人层攒够消息后的回调（也用于主动发言轮：events 为空） */
  enqueueBatch(batch: TriggerBatch): void {
    if (!batch.events.length) {
      this.enqueue([this.syntheticEvent(batch.chat)], { proactive: batch.detail });
      return;
    }
    this.enqueue(batch.events);
  }

  /** 主动发言轮没有真实消息，构造一个只用来承载"哪个会话"的空事件 */
  private syntheticEvent(chat: { platform: string; type: 'group' | 'private'; chatId: string }): ChatEvent {
    return {
      id: newId('pro_'),
      platform: chat.platform, type: chat.type, chatId: chat.chatId,
      userId: '', nickname: '', senderRole: 'unknown',
      segments: [], text: '', isAtMe: false, isReplyToMe: false,
      raw: { proactive: true }, ts: Date.now(),
    };
  }

  private enqueue(events: ChatEvent[], opts: { proactive?: string } = {}): void {
    const carrier = events[events.length - 1];
    if (!carrier) return;
    const key = `${carrier.type}_${carrier.chatId}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    if (this.activeTurns.get(key) ?? 0) {
      // 已有轮次在跑：入队（队列长度受限防堆积）
      if (this.queueLen(key) > 5) {
        this.sessionLog.append(carrier.chatId, carrier.type, { type: 'system', role: 'system', text: '消息积压，已丢弃' });
        return;
      }
    }
    const job = prev
      .then(() => this.process(events, opts))
      .catch((e) => {
        this.errors.record('error', 'kernel', `pipeline 处理异常: ${(e as Error).message}`, { chatId: carrier.chatId, stack: (e as Error).stack });
      })
      .finally(() => {
        if (this.queues.get(key) === job) this.queues.delete(key);
      });
    this.queues.set(key, job as Promise<void>);
  }

  /** 中断当前轮（桌面端按钮） */
  abortChat(chatId: string): void {
    this.aborts.get(chatId)?.abort();
  }

  /** 桌面端「已隐藏」的会话 = bot 收不到它（口径与实现在 ConfigStore.chatHidden） */
  private chatHidden(event: ChatEvent): boolean {
    return this.config.chatHidden(this.selfId(), event.type, event.chatId);
  }

  /** 引用一条消息：协议端给的 reply 段里只有原消息号，把它查回原文存成快照。
   *  只查本会话的内存尾（引用基本都是刚刚那几条），查不到就留着 [回复:id] 占位，不编内容。 */
  private attachReply(event: ChatEvent): void {
    const rid = String(event.segments.find((s) => s.type === 'reply')?.data?.id ?? '');
    if (!rid) return;
    const src = this.sessionLog.findByMessageId(event.chatId, event.type, rid);
    if (!src || src.type !== 'message_in') return;
    const raw = Array.isArray((src.data as { files?: unknown } | undefined)?.files)
      ? (src.data as { files: unknown[] }).files : [];
    const files = raw
      .map((f): { name: string; rel: string } => (typeof f === 'string'
        ? { name: f, rel: 'inbox/' + f }
        : { name: String((f as { name?: unknown })?.name ?? ''), rel: String((f as { rel?: unknown })?.rel ?? '') }))
      .filter((f) => f.rel);
    event.replyTo = {
      userId: src.userId ?? '', nickname: src.nickname ?? '', text: src.text ?? '',
      files: files.length ? files : undefined,
    };
  }

  private queueLen(key: string): number {
    return this.queueLens.get(key) ?? 0;
  }

  // ---------------------------------------------------------------- 处理

  private async process(events: ChatEvent[], opts: { proactive?: string } = {}): Promise<void> {
    if (!events.length) return;
    const event = events[events.length - 1];
    const chatKey = `${event.type}_${event.chatId}`;

    // 隐藏会话兜底：主动发言轮不经过 submit()，隐藏之前攒下的批次也会流到这里。
    // 静默丢弃、不写会话流（隐藏是主人自己的动作，不需要每轮解释"为什么没说话"）。
    if (this.chatHidden(event)) return;

    // ---- 主动发言轮：先过一遍行动容量（HDSI Agency），再进对话轮 ----
    // 容量不足（她在睡觉 / 日程忙 / 距上次主动还没到最小间隔）就不叫模型，省一次调用也少一次打扰。
    if (opts.proactive) {
      const cap = this.humanlike.proactiveCapacity(
        { platform: event.platform, type: event.type, chatId: event.chatId },
        { origin: 'chat', reason: opts.proactive },
      );
      if (!cap.allowed) {
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system',
          text: `主动开口被行动容量挡下：${AGENCY_REASON_ZH[cap.reason] ?? cap.reason}`,
          data: { decision: 'agency_blocked', reason: cap.reason, recheckAt: cap.recheckAt },
        });
        return;
      }
      await this.agentTurn(event, 'member', chatKey, { proactive: true });
      return;
    }

    // ---- 入站早已在 submit() 落账（拟人层不回也要留在会话流里），这里只做过滤 ----

    // 黑名单：整批都被拉黑才静默（不能因为一个人刷屏就让整批沉掉）
    const allowed = events.filter((e) => !this.memory.getProfile(e.userId).blocked);
    if (!allowed.length) {
      this.sessionLog.append(event.chatId, event.type, { type: 'system', role: 'system', text: `黑名单用户 ${event.userId}，忽略` });
      return;
    }

    // 圈内黑话（表达学习）：本群高频词的频次记账在这边走（判定是异步侧端，不阻塞回话）
    if (this.jargon) {
      for (const e of allowed) {
        try { this.jargon.observe(e); } catch { /* 挖词失败不影响消息主流程 */ }
      }
    }

    const role = this.resolveRole(event);
    event.role = role;
    const text = event.text.trim();
    const isCommand = isCommandText(text);

    // 「要不要理这条」只有拟人层一处判（群聊：必要性打分 / @必回；私聊与命令直通）。
    // 这里不再补第二套唤醒判定 —— 两处判同一件事时，总有一处是死的。

    // ---- 插件 onChatMessage 钩子（仅本群生效中的插件） ----
    for (const lp of this.plugins.list()) {
      if (lp.state !== 'loaded') continue;
      if (!this.plugins.effectiveEnabled(lp.manifest.id, event.chatId)) continue;
      try {
        await lp.hooks.onChatMessage?.(event);
      } catch (e) {
        this.errors.record('warn', 'plugin', `onChatMessage 钩子出错（${lp.manifest.id}）: ${(e as Error).message}`, { pluginId: lp.manifest.id });
      }
    }

    // ---- 命令分发 ----
    const cmdText = text.startsWith('/') ? text.slice(1) : text.startsWith('／') ? text.slice(1) : null;
    if (cmdText !== null) {
      // /work 是“任务触发器”：/work <任务描述> 交给 work 模型执行，再由 chat 模型转述给用户
      const workMatch = cmdText.match(/^work(?:\s+([\s\S]+))?$/);
      if (workMatch) {
        const task = (workMatch[1] ?? '').trim();
        if (!roleAtLeastRole(role, 'admin')) {
          await this.chat.reply(event, '权限不足：/work 需要管理员。');
          return;
        }
        if (!task) {
          await this.chat.reply(event, '用法：/work <任务描述>\n例如：/work 分析 inbox 里的报表并生成摘要');
          return;
        }
        await this.runWorkCommand(event, role, chatKey, task);
        return;
      }
      await this.dispatchCommand(event, role, cmdText);
      return;
    }

    // ---- Agent 对话轮（多用户消息合并进来时，把它们一起交给模型） ----
    // 整批事件一起带进去：文本由 renderBatch 拼，媒体按各自的来源聚合（附件要跟着批次走，不能只看 carrier）
    await this.agentTurn(event, role, chatKey, { userText: renderBatch(allowed), batch: allowed });
  }

  // ---------------- 命令 ----------------

  /**
   * /work <任务>：work 模型执行 → chat 模型转述（双模型架构，报告 11）。
   * work 的唯一触发入口就是这里（管理员命令）；chat 模型不判断任务复杂度、不自主委派。
   */
  private async runWorkCommand(event: ChatEvent, role: Role, chatKey: string, task: string): Promise<void> {
    const chat = { platform: event.platform, type: event.type, chatId: event.chatId };
    // 上一次停下来问的事还没答？那这次的 /work 就是他给的回答：拼成新任务交回去（沙箱里的产物还在）。
    const pending = this.takePendingWork(chatKey);
    const effectiveTask = pending ? composeContinueTask(pending, task) : task;
    const label = pending ? `${pending.label}（续）` : task;
    await this.chat.reply(event, pending
      ? `收到，把上次那个问题的答案交回工作子代理（${this.workRunner.workModelLabel()}）了，它接着干…`
      : `收到，已交给工作子代理（${this.workRunner.workModelLabel()}）执行…`);
    // 工具面 = work agent 定义的白名单 ∩ （本群生效 ∩ 角色允许）；到深度上限时 delegate 自动缺席。
    // system 由 WorkRunner 按「agent 定义 + 内核具名分节」组装，插件再经 beforeWorkLLM 追加自己的节。
    const agent = this.plugins.workAgent();
    const tools = this.plugins.workToolsFor(chat, role, agent, 0);
    let result: Awaited<ReturnType<WorkRunner['run']>>;
    try {
      result = await this.workRunner.run({
        chat,
        task: effectiveTask,
        taskLabel: label,
        userId: event.userId,
        nickname: event.nickname,
        role,
        agent,
        tools,
        trigger: 'command',
        depth: 0,
        subagents: this.plugins.listWorkAgents().map((a) => ({ name: a.name, description: a.description, tools: a.tools, source: a.source })),
        groupTitle: this.groupTitle(event.chatId),
        runHooks: (req) => this.plugins.runWorkHooks(req),
      });
    } catch (e) {
      await this.chat.reply(event, `工作子代理执行失败：${(e as Error).message}`);
      return;
    }
    // 它停下来提问了：记下现场，等他回答（下一次 /work 会接着这份现场往下干）
    if (result.awaiting) {
      this.pendingWork.set(chatKey, {
        task: effectiveTask, label, question: result.awaiting.question, notes: result.awaiting.notes,
        at: Date.now(), userId: event.userId,
      });
    }
    // 由 chat 模型用自己的人格把结论讲给用户
    await this.agentTurn(event, role, chatKey, { relay: { task: label, result } });
  }

  /** 取出并消费该会话的待答复（过期视为没有）；一次 /work 只接一条 */
  private takePendingWork(chatKey: string): PendingAsk | undefined {
    const p = this.pendingWork.get(chatKey);
    if (!p) return undefined;
    this.pendingWork.delete(chatKey);
    return Date.now() - p.at > PENDING_WORK_TTL_MS ? undefined : p;
  }

  /** 只读：还在有效期内的待答复（chat 侧提醒用，不消费） */
  private livePendingWork(chatKey: string): PendingAsk | undefined {
    const p = this.pendingWork.get(chatKey);
    return p && Date.now() - p.at <= PENDING_WORK_TTL_MS ? p : undefined;
  }

  private async dispatchCommand(event: ChatEvent, role: Role, cmdText: string): Promise<void> {
    const parts = cmdText.trim().split(/\s+/);
    const name = parts[0] ?? '';
    const args = parts.slice(1);
    const found = this.plugins.findCommand(name);

    this.sessionLog.append(event.chatId, event.type, { type: 'command', role: 'user', userId: event.userId, text: `/${cmdText}` });

    if (!found) {
      // 不泄露命令是否存在：统一未知命令
      await this.chat.reply(event, roleAtLeastRole(role, 'admin')
        ? `未知命令：/${name}。发送 /帮助 查看可用命令。`
        : '未知命令，发送 /帮助 查看可用命令。');
      return;
    }

    // 后果严格成立：本群未生效 → 命令不可用；管理员可看到"未开启"提示，普通成员当未知命令
    if (!this.plugins.effectiveEnabled(found.pluginId, event.chatId)) {
      if (roleAtLeastRole(role, 'admin')) {
        const lp = this.plugins.get(found.pluginId)!;
        if (lp.manifest.locked && !roleAtLeastRole(role, 'owner')) {
          await this.chat.reply(event, `插件 ${lp.manifest.name} 在本群未开启，人设类插件仅主人可操作。`);
        } else {
          await this.chat.reply(event, `插件「${lp.manifest.name}」在本群未开启。管理员可发送 /插件 开启 ${found.pluginId}`);
        }
      } else {
        await this.chat.reply(event, '未知命令，发送 /帮助 查看可用命令。');
      }
      return;
    }

    if (found.def.minRole && !roleAtLeastRole(role, found.def.minRole)) {
      await this.chat.reply(event, '权限不足：该命令需要更高权限。');
      return;
    }

    try {
      // 命令执行与工具调用同样纳入插件崩溃隔离（连续同错自动停用）
      const lp = this.plugins.get(found.pluginId)!;
      let reply: CommandReply | undefined;
      try {
        reply = await this.plugins.guarded(lp, 'command', () => found.def.handler(args, event));
      } catch (e) {
        // 权限/边界类拒绝：如实回给用户
        await this.chat.reply(event, `命令被拒绝：${(e as Error).message}`);
        return;
      }
      if (reply === undefined) {
        // guarded 已记录错误（可能触发自动停用）
        await this.chat.reply(event, '命令执行出错：请稍后再试，连续出错时插件会被自动停用。');
        return;
      }
      if (reply.sandboxFile) {
        await this.chat.sendFile({ platform: event.platform, type: event.type, chatId: event.chatId }, reply.sandboxFile);
      }
      if (reply.segments?.length) {
        await this.chat.send({ platform: event.platform, type: event.type, chatId: event.chatId }, reply.segments);
      } else if (reply.text) {
        await this.chat.reply(event, reply.text);
      }
      this.sessionLog.append(event.chatId, event.type, {
        type: 'command_result', role: 'assistant', text: reply.text ?? `[segments:${reply.segments?.length ?? 0}]${reply.sandboxFile ? ' +文件' : ''}`,
        data: { pluginId: found.pluginId, command: name },
      });
    } catch (e) {
      const msg = (e as Error).message;
      this.errors.record('warn', 'command', `命令 /${name} 失败: ${msg}`, { chatId: event.chatId, stack: (e as Error).stack });
      await this.chat.reply(event, `命令执行出错：${msg}`);
    }
  }

  // ---------------- Agent 对话 ----------------

  private async agentTurn(
    event: ChatEvent,
    role: Role,
    chatKey: string,
    opts?: {
      relay?: { task: string; result: Awaited<ReturnType<WorkRunner['run']>> };
      /** 覆盖本轮的用户输入（多用户消息合并 / 主动发言） */
      userText?: string;
      /** 主动发言轮：允许模型用沉默标记保持安静，且不往历史里塞一条假用户消息 */
      proactive?: boolean;
      /** 本轮合并进来的整批事件（媒体按各自的来源聚合；不给就按 carrier 单事件取） */
      batch?: ChatEvent[];
    },
  ): Promise<void> {
    const chat = { platform: event.platform, type: event.type, chatId: event.chatId };
    const active = this.activeTurns.get(chatKey) ?? 0;

    // 检查本群是否有任何生效中的插件能提供工具/人格；全关时按配置提示管理员
    const tools = this.plugins.toolsForChat(chat, role);
    // 「本群还没开启任何插件」的判据沿用重构前口径：work 面工具也算"本群有开启的插件"。
    const anyToolsInGroup = this.plugins.toolsForChat(chat, role, 'work').length > 0;
    const anyChatPersona = [...this.plugins.list()].some(
      (lp) => lp.manifest.category === 'persona' && lp.state === 'loaded' && this.plugins.effectiveEnabled(lp.manifest.id, event.chatId),
    );
    if (tools.length === 0 && !anyToolsInGroup && !anyChatPersona) {
      if (event.type === 'group' && this.config.config.risk.silentWhenNothingEnabled) {
        if (roleAtLeastRole(role, 'admin')) {
          const last = this.adminHintAt.get(chatKey) ?? 0;
          if (Date.now() - last > 10 * 60_000) {
            this.adminHintAt.set(chatKey, Date.now());
            await this.chat.reply(event, '本群还没有开启任何插件。管理员可发送 /插件 查看并开启（如：/插件 开启 chat）。');
          }
        }
        // 普通成员：完全静默（严格不可见性）
      }
      return;
    }

    const ac = new AbortController();
    this.aborts.set(event.chatId, ac);
    this.activeTurns.set(chatKey, active + 1);

    try {
      // 基础 system（内核固定节；插件在 beforeLLM 中以 systemSections 追加各自的节，不再整体覆盖）
      const system = chatIdentitySystem({
        type: event.type,
        chatId: event.chatId,
        groupTitle: this.groupTitle(event.chatId),
        nickname: event.nickname,
        userId: event.userId,
        role,
      });
      // 信任边界 + 压缩连续性说明：chat/work 两轮共用，夹在内核节（0-999）与插件节（1000+）之间
      const systemSections: SystemSection[] = [
        { order: 300, title: 'trust-boundary', text: TRUST_BOUNDARY_TEXT },
        { order: 400, title: 'context-continuity', text: CONTEXT_CONTINUITY_TEXT },
      ];
      // ---- 上下文时间窗（storage.contextMinutes）：模型只看得到窗口内的消息 ----
      // 更早的消息并没有丢：它们仍在历史缓存与会话日志里，由 search_history / recall_facts 现查。
      // 缓存口径（2026-10-16 用户裁定②）：窗口起点**对齐梳理点**（tumbling 网格）——
      //   两次梳理之间消息只增不减，供应商前缀缓存才吃得动；跨格那一刻整段裁一次，
      //   实际覆盖在 N~2N 分钟之间。语义与"严格每轮 N 分钟"不同，这是用户点头换来的。
      const minutes = Math.max(1, Math.round(Number(this.config.config.storage.contextMinutes) || 5));
      const span = Math.max(1, minutes) * 60_000;
      const sinceTs = windowAnchorTs(Date.now(), minutes);
      const windowHistory = this.history.snapshot(chat, sinceTs);
      if (!opts?.relay) {
        systemSections.push({
          order: 405, title: 'context-window',
          text: [
            `# 上下文时限`,
            `- 你看得到最近这段会话的记录（按 ${minutes} 分钟的窗口对齐梳理点裁剪，实际覆盖最近 ${minutes}~${minutes * 2} 分钟）。`,
            `- 更早的消息不在上下文里（当时的图片、语音、视频也不会出现）；只有非常久远的话题才可能需要回查。`,
            `- 回话前先掂量现有信息够不够：不够就用 search_history（翻本会话更早的原文）或 recall_facts（翻这位用户的长期记忆）查了再答；一轮之内查完就回，别连环查。`,
            `- 不要向用户提「时限、上下文、梳理、检索记录」这类内部词，查到就自然接上话。`,
          ].join('\n'),
        });
      }
      // ---- 本轮批次的媒体：整批事件一起算 ----
      // 合并轮里 carrier 只是最后那条，只看它会把前面几条的图/语音一起吞掉（事件少时等价于旧行为）。
      const batch = opts?.batch ?? [];
      const batchMedia = batch.map((e) => ({ e, atts: attachmentsOf(e) }));
      const turnAttachments = batch.length ? batchMedia.flatMap((x) => x.atts) : attachmentsOf(event);
      // 本轮媒体补传：说清"这一发请求里带了哪些媒体、分别长在哪条消息上"。
      // 图片由播种区按消息归位；语音/视频块统一补在最新那条用户消息上——两件事都交代清楚，模型才找得到。
      const mediaLines = [
        ...batchMedia.map((x) => mediaLineOf(x.e.nickname || x.e.userId, x.e.ts, x.atts)),
        // 窗口内的历史消息：ChatMessage 不带作者（只有 role/正文/时刻），按"更早的消息"标注
        ...windowHistory.map((m) => mediaLineOf('更早的消息', m.ts, m.attachments)),
      ].filter((l): l is string => !!l);
      if (mediaLines.length) {
        systemSections.push({
          order: 475, title: 'media-handoff',
          text: [
            `# 本轮媒体补传`,
            ...mediaLines.map((l) => `- ${l}`),
            `图片长在各自那条消息上；语音/视频块统一附在最新那条用户消息上。`,
          ].join('\n'),
        });
      }
      // 剧本体（HDSI 的 <say> authored actions）：写小说、只有 <say> 里的台词进 QQ。
      // 「说几条、多长、什么时候分条」也由这一段讲清楚（MaiBot 的 replyStyle 已随输出侧一起删除）。
      // 转述轮不加：那轮要的是把工作结果讲清楚，不是演戏。
      if (this.humanlike.config.script?.enable && !opts?.relay) {
        const out = this.humanlike.config.outgoing;
        systemSections.push({
          order: 440, title: 'script-format',
          text: scriptFormatText({ separator: out.messageSeparator, splitEnabled: out.splitReplyMessages }),
        });
      }
      // HDSI 的三个子系统：Alter 氛围参考(450) / ChatRhythm 节奏提醒(460) / 日程(470)。
      // 转述轮同样不加：那轮不演戏。
      if (!opts?.relay) {
        systemSections.push(...this.humanlike.sceneSections(chat));
      }
      // 圈内黑话（472）：本群学来的词与含意，帮 bot 听懂对方；转述轮同样不加。
      if (!opts?.relay) {
        const jargonSection = this.jargon?.sections(chat);
        if (jargonSection) systemSections.push({ order: 472, title: 'jargon', text: jargonSection });
      }
      // 有一件活停在这位管理员这里（work 停下来提问了）：让她知道，并在主人随口回答时提醒他走 /work。
      // 只说给管理员听：这问题只有他能定，普通成员看到也只是噪声。
      const pendingAsk = opts?.relay ? undefined : this.livePendingWork(chatKey);
      if (pendingAsk && roleAtLeastRole(role, 'admin')) {
        systemSections.push({
          order: 500,
          title: 'work-pending',
          text: [
            `# 有一件活停在你这里`,
            `工作子代理 ${Math.max(1, Math.round((Date.now() - pendingAsk.at) / 60_000))} 分钟前停下来问：${pendingAsk.question}`,
            pendingAsk.notes ? `（它已经做到：${pendingAsk.notes}）` : '',
            `这个问题只有主人能定，别替他猜；他要回答就用 /work <他的回答> 回一句，你收到后会接着干。`,
          ].filter(Boolean).join('\n'),
        });
      }
      // 转述轮：把 work 子代理的结果作为本轮输入交给 chat 模型（它用自己的口吻讲给用户）。
      // 三种口径分开写：停下来提问 ≠ 干完了，不能都用"已完成"糊过去。
      const relayNote = opts?.relay
        ? (opts.relay.result.awaiting
            ? [
                `【工作子代理停下来问你一件事】`,
                `原任务：${opts.relay.task}`,
                `它要问的：${opts.relay.result.awaiting.question}`,
                opts.relay.result.awaiting.notes ? `（它已经做到：${opts.relay.result.awaiting.notes}）` : '',
                `请用你自己的语气把这件事问给用户：说清要他定什么、为什么非他定不可，并告诉他回一句 /work <他的回答> 你就能接着干。`,
                `不要提"子代理""模型""系统提示"这些词，也别把这件事说成"做完了"。`,
              ].filter(Boolean).join('\n')
            : [
                `【工作子代理已完成任务】`,
                `任务：${opts.relay.task}`,
                opts.relay.result.ok
                  ? `结果：\n${opts.relay.result.summary}`
                  : `任务失败：${opts.relay.result.error ?? '未知原因'}`,
                opts.relay.result.artifacts?.length ? `产物（会话沙箱内）：${opts.relay.result.artifacts.join('、')}` : '',
                opts.relay.result.notes ? `需要你知道的备注：${opts.relay.result.notes}` : '',
                `请用你自己的语气把结论讲给用户（不要提"子代理""模型""系统提示"这些词，像你自己干完活汇报一样）。`,
              ].filter(Boolean).join('\n'))
        : '';
      const userText = opts?.relay
        ? `${modelTextOf(event)}\n\n${relayNote}`
        : opts?.proactive
          ? [
              '【群里安静了一阵子】',
              '没有人 @ 你，也没有新的消息等你接。你可以主动说点什么活跃气氛（一句短的就行），也可以什么都不说。',
              `如果决定不说话，只回复 ${SILENT_MARKER}（不要有任何其他内容）。`,
            ].join('\n')
          : (opts?.userText ?? modelTextOf(event));

      let messages = [
        ...windowHistory,
        { role: 'user' as const, content: userText },
      ];
      let ctx: LLMRequestContext = {
        chat, event, system, systemSections, messages, tools,
        attachments: turnAttachments,
      };

      // beforeLLM 钩子（人格插件五插槽注入点）
      for (const lp of this.plugins.list()) {
        if (lp.state !== 'loaded') continue;
        if (!this.plugins.effectiveEnabled(lp.manifest.id, event.chatId)) continue;
        if (!lp.hooks.beforeLLM) continue;
        try {
          ctx = await lp.hooks.beforeLLM(ctx);
        } catch (e) {
          this.errors.record('warn', 'plugin', `beforeLLM 出错（${lp.manifest.id}）: ${(e as Error).message}`, { pluginId: lp.manifest.id });
        }
      }

      // 主动发言轮不往历史里塞这条"假用户消息"（它不是任何人的发言）。
      // 附件跟着入账：窗口内的历史消息要能重放"这条当时带了图/语音/视频"。
      if (!opts?.proactive) this.history.pushUser(chat, userText, ctx.attachments);

      const { reply } = await this.agentLoop.run(ctx, { chatKey, abort: ac.signal });

      // afterLLM 钩子（persona checker 插槽）
      let finalReply = reply;
      for (const lp of this.plugins.list()) {
        if (lp.state !== 'loaded') continue;
        if (!this.plugins.effectiveEnabled(lp.manifest.id, event.chatId)) continue;
        if (!lp.hooks.afterLLM) continue;
        try {
          finalReply = await lp.hooks.afterLLM(ctx, finalReply);
        } catch (e) {
          this.errors.record('warn', 'plugin', `afterLLM 出错（${lp.manifest.id}）: ${(e as Error).message}`, { pluginId: lp.manifest.id });
        }
      }

      // 没接模型 / 额度耗尽 / 链全挂会被吞成空回复：这轮一个字不发，只落 gate 条目。
      // 群里出现"没答好请再问一次"式的托词比沉默更伤人设，失败细节都在报错中心与会话流里。
      if (!finalReply.trim()) {
        this.humanlike.noteSilent(chat);
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system', text: '本轮没有产出内容（模型未接入或请求失败），保持沉默',
          data: { decision: 'empty_reply' },
        });
        return;
      }

      // 主动发言轮允许沉默（剧本体下的沉默就是只写旁白 / 给沉默标记）
      if (opts?.proactive && isSilentScene(finalReply)) {
        this.humanlike.noteSilent(chat);
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system', text: '主动发言：模型选择这次不说话',
          data: { decision: 'proactive_silent' },
        });
        return;
      }

      await this.sendScene(chat, finalReply);
      if (opts?.proactive) this.humanlike.noteProactive(chat);
    } catch (e) {
      const msg = (e as Error).message;
      // 模型请求失败（没接模型/额度不足/链全挂）等异常一律不在群里出声：
      // 原来那句"（处理这条消息时出错了：…）"会把内部报错泄漏给普通群员，改记报错中心。
      this.errors.record('error', 'kernel', `本轮对话处理失败（群里保持沉默）: ${msg}`, {
        chatId: event.chatId, stack: (e as Error).stack,
      });
      if (ac.signal.aborted) {
        // 打断是管理员在桌面端主动点的按钮，这句回执留着确认操作生效
        await this.chat.reply(event, '（已打断本轮回复）').catch(() => {});
      }
    } finally {
      this.activeTurns.set(chatKey, Math.max(0, (this.activeTurns.get(chatKey) ?? 1) - 1));
      this.aborts.delete(event.chatId);
      // 重新武装主动发言计时器：这一轮不管说没说话，都从"现在"重新起算静默时长
      this.humanlike.afterTurn(chat);
    }
  }

  /**
   * 一轮剧本落地：
   *  - **只有 `<say>` 里的台词**会被发出去（剧本体的核心；旁白/动作描写留在剧本里）
   *  - 整段剧本**带标签**回灌历史 —— 模型照着自己上一轮的样子学，摘掉标签它下一轮就不写 `<say>` 了
   *  - 这一轮没说话（只写旁白或给了沉默标记）：不发，但剧本照旧推进
   */
  private async sendScene(chat: { platform: string; type: 'group' | 'private'; chatId: string }, raw: string): Promise<void> {
    const { plans, historyText, spoke } = await this.humanlike.composeScene(raw, chat);
    if (!spoke || !plans.length) {
      this.humanlike.noteSilent(chat);
      if (historyText.trim()) this.history.pushAssistant(chat, historyText);
      return;
    }
    const { sent } = await this.chat.sendPlanned(chat, plans);
    const bubbles = plans.map((p) => String(p.segments[0]?.data?.text ?? '')).filter(Boolean);
    this.humanlike.noteSpoke(chat, sent > 0 ? sent : 1, bubbles);
    if (historyText.trim()) this.history.pushAssistant(chat, historyText);
  }

  /** 按天记消息条数（「用量」页的入站/出站来自这里）。出站由 ChatService 每条回调。
   *  消息不对应模型，所以固定写在 model='' 那行上（主键含 model）。 */
  bumpUsage(field: 'messages_in' | 'messages_out'): void {
    const day = todayKey();
    const provider = this.config.config.llm.activeProvider;
    const row = this.db.get<{ messages_in: number; messages_out: number }>(
      'SELECT messages_in, messages_out FROM usage_stats WHERE day=? AND provider=? AND model=? AND chat_id=?', day, provider, '', '-',
    );
    const cur = field === 'messages_in' ? (row?.messages_in ?? 0) : (row?.messages_out ?? 0);
    if (row) {
      this.db.run(`UPDATE usage_stats SET ${field}=? WHERE day=? AND provider=? AND model=? AND chat_id=?`, cur + 1, day, provider, '', '-');
    } else {
      this.db.run(`INSERT INTO usage_stats (day, provider, model, chat_id, ${field}) VALUES (?,?,?,?,1)`, day, provider, '', '-');
    }
  }
}

function isCommandText(text: string): boolean {
  const t = text.trim();
  return t.startsWith('/') || t.startsWith('／');
}

export function roleAtLeastRole(role: Role, min: Role): boolean {
  const rank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
  return rank[role] >= rank[min];
}
