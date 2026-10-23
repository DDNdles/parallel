import type { ChatEvent, ChatRef, ChatMessage, CommandReply, LLMRequestContext, MessageAttachment, Role, SystemSection } from './types.ts';
import { composeSystem } from './types.ts';
import type { PluginContainer } from './container.ts';
import type { AgentLoop, HistoryStore } from './agentloop.ts';
import type { ChatService } from './services/chat.ts';
import type { LlmService } from './services/llm.ts';
import type { MemoryService } from './services/memory.ts';
import type { SessionLog } from './sessionlog.ts';
import type { WorkRunner, WorkRunResult } from './services/work.ts';
import { workScopeOf } from './services/work.ts';
import type { ConfigStore } from './config.ts';
import type { ErrorCenter } from './errors.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';
import type { Db } from './db.ts';
import type { HumanlikeService } from './humanlike/index.ts';
import type { TriggerBatch } from './humanlike/types.ts';
import { SILENT_MARKER, isSilentScene } from './humanlike/delivery.ts';
import { shouldInterrupt } from './humanlike/interrupt.ts';
import { repetitionRetryConstraint } from './humanlike/repetition.ts';

/** 圈内黑话（表达学习）的 hook 面；可选依赖——没接（测试/降级）就整个旁路 */
interface JargonHook {
  observe(event: ChatEvent): void;
  /** 给了 recentText 就只注入当前上下文里真出现的词 */
  sections(chat: import('./types.ts').ChatRef, recentText?: string): string | null;
}
/** 跟屏复读（repeat.ts）的 hook 面，同上：没接就旁路 */
interface RepeatHook {
  observe(event: ChatEvent): void;
}
import { AGENCY_REASON_ZH } from './humanlike/agency.ts';
import { todayKey, newId } from './util/misc.ts';
import { inboundModelText } from './util/modeltext.ts';
import { CONTEXT_CONTINUITY_TEXT, TRUST_BOUNDARY_TEXT, chatIdentitySystem, chatOutputStyleText } from './prompt-sections.ts';
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
 * 入站归一化 → 黑名单 → **拟人层门控**（@ 直通；群聊按必要性打分 + 防抖合并；私聊不打分但同样合批）
 * → 插件钩子 → 命令分发 / AgentLoop → **逐条分段发送**。
 *
 * 与重构前的差别只在 chat 区：唤醒判定从「@ 或唤醒词」换成 MaiBot 那套打分，
 * 出站从「整条发」换成「按语义拆成几条短消息 + 打字停顿」。
 */
/** 重复消息的去重窗口：上一轮刚答过同一句，这段时间内一字不差的重发不再另起一轮 */
const DUPLICATE_WINDOW_MS = 2 * 60_000;

/** 去重用的正文口径：去掉首尾空白、把连续空白折成一个空格（表情/标点原样保留，不做语义归一） */
function dupText(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * work 跑完后的汇报输入（只给模型看，不进历史、也不会被当成用户发言）。
 * 三种口径分开写：停下来提问 ≠ 干完了，不能都用"已完成"糊过去。
 */
function workReportNote(report: { task: string; result: WorkRunResult }): string {
  const r = report.result;
  if (r.awaiting) {
    return [
      `【你派出去的活停下来问你一件事】`,
      `任务：${report.task}`,
      `它要问的：${r.awaiting.question}`,
      r.awaiting.notes ? `（它已经做到：${r.awaiting.notes}）` : '',
      `请用你自己的语气把这个问题转达给发起人（@ 已经带上了）：说清要他定什么、为什么非他定不可，并告诉他直接把答案说出来就行，你会接着让活往下干。`,
      `不要提"子代理""模型""系统提示"，也别把这件事说成"做完了"。`,
    ].filter(Boolean).join('\n');
  }
  if (!r.ok) {
    return [
      `【你派出去的活没做成】`,
      `任务：${report.task}`,
      `失败原因：${r.error || '未知原因'}`,
      `请用你自己的语气如实告诉发起人这次没办成（@ 已经带上了），别编造结果；能给出下一步怎么做就顺带说一句。`,
      `不要提"子代理""模型""系统提示"这些词。`,
    ].join('\n');
  }
  return [
    `【你派出去的活做完了】`,
    `任务：${report.task}`,
    `结果：\n${r.summary}`,
    r.artifacts?.length ? `产物（会话沙箱内）：${r.artifacts.join('、')}` : '',
    r.notes ? `需要他知道的备注：${r.notes}` : '',
    r.artifacts?.length
      ? `产物和你的结论会由系统合并成一条「聊天记录」发出：不要再调用 deliver_file，也不要把路径单独发一遍；你只写给自己人看的结论/说明。`
      : '',
    `请用你自己的语气向发起人汇报（@ 已经带上了），像你自己干完活回话一样；不要提"子代理""模型""系统提示"。`,
  ].filter(Boolean).join('\n');
}

/**
 * 出站引用只在「这一轮就是回这一条」时挂：
 *  - 多消息合批（frequency 模式最常见）里，回复是对整批说的，挑哪条都可能是错的 → 不挂；
 *  - 汇报轮/主动发言轮挂的是很早的触发消息 → 不挂；
 *  - 纯 @ / 纯占位没有实质内容 → 不挂；
 *  - 图片/表情/语音/视频/文件/聊天记录算实质内容，可以引用。
 */
export function canQuoteTurn(
  event: ChatEvent,
  opts?: { report?: unknown; proactive?: boolean; batch?: ChatEvent[] },
): boolean {
  if (opts?.report || opts?.proactive) return false;
  if ((opts?.batch?.length ?? 1) !== 1) return false;
  return event.segments.some((s) =>
    (s.type === 'text' && String(s.data?.text ?? '').trim() !== '') ||
    s.type === 'image' || s.type === 'face' || s.type === 'record' ||
    s.type === 'video' || s.type === 'file' || s.type === 'forward',
  );
}

export class Pipeline {
  private queues = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  /**
   * 在途轮次的阶段：`generating` = 模型还没吐完；`sending` = 已经开始发气泡。
   * 生成期打断只 abort 模型（新消息会导致这一轮作废），气泡期打断交给 ChatService。
   */
  private turnMeta = new Map<string, {
    chatKey: string;
    phase: 'generating' | 'sending';
    interruptible: boolean;
    abortReason?: 'user' | 'generation';
  }>();
  private activeTurns = new Map<string, number>();
  private adminHintAt = new Map<string, number>();
  private queueLens = new Map<string, number>();
  /** 每个会话的 work 汇报串行链：两件活同时收尾时别让两轮汇报抢同一份历史 */
  private reportChains = new Map<string, Promise<void>>();
  /**
   * 每个会话上一轮**真正处理过**的用户输入（去重「同一句话又说了一遍」）。
   * 2026-10-18 用户反馈：同样两句隔开 2 秒以上再说时，它会像忘了一样从头重答一遍。
   * 这里记住上一轮的正文与结果，短时间内一字不差的重发不再另起一轮。
   */
  private lastTurn = new Map<string, { text: string; at: number; spoke: boolean }>();
  /**
   * 重复消息去重窗口（毫秒）：上一轮刚答过同一句，这段时间内一字不差的重发不再另起一轮。
   * `0` = 关掉去重（测试里同一个群里反复用同一句话触发时用）。
   */
  duplicateWindowMs = DUPLICATE_WINDOW_MS;

  constructor(
    private plugins: PluginContainer,
    private agentLoop: AgentLoop,
    private llm: LlmService,
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
    private repeat?: RepeatHook,
  ) {
    // work 收尾 → 另起一轮人格化汇报（只认 chat 面工具派的活；子代理的完成不回群）。
    // 这是 /work 删除后的唯一收尾路径：chat 先应下，work 在后台跑，跑完由 chat 带着 @ 汇报。
    this.bus.on(busEvents.workDone, (p: any) => this.scheduleWorkReport(p));
    this.bus.on(busEvents.workError, (p: any) => this.scheduleWorkReport(p));
  }

  // ---------------------------------------------------------------- 入站

  /** 适配器统一入口 */
  submit(event: ChatEvent): void {
    // 隐藏会话（桌面端「已隐藏」）：当成没说过——不落账、不记用量、不进拟人层。
    // 附件的下载也在适配器那头就挡掉了；解除隐藏后只恢复"此后的"入站，不补历史。
    if (this.chatHidden(event)) return;
    const chat = { platform: event.platform, type: event.type, chatId: event.chatId };
    // 她还在发气泡时对面又开口：按打断口径把**剩下的气泡**砍掉（纯程序，零模型调用）。
    // 必须放在落账与门控之前 —— 要求是"对面发完立刻生效"，排在后面就白等了。
    // 这条消息本身照常入账、照常进攒批，成为下一轮的输入；被砍掉的正文不进历史（见 sendScene）。
    this.maybeInterrupt(chat, event);
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
      // 黑话观察放在门控之前：她"没接话"的群消息同样要算进频次，否则只学得到被回复的那一小撮。
      // 观察是同步内存记账，真正的模型判定在后面异步跑。
      try { this.jargon?.observe(event); } catch { /* 挖词失败不影响消息主流程 */ }
      // 跟屏复读只看真实群消息，放在门控之前：拟人层要不要接话是另一件事
      try { this.repeat?.observe(event); } catch { /* 复读观察出错不影响消息主流程 */ }
      const r = this.humanlike.ingest(event, { isCommand: isCommandText(event.text) });
      if (r.action === 'handled') return;                    // 拟人层接管：攒着，攒够了它会回调 enqueueBatch
      this.enqueue(r.events);
      return;
    }
    // 私聊：必回，但同样经拟人层攒批（连发几句合成一个请求；单条时与旧的秒回等价）。
    // 它不评估开口，只借合批那一层，攒够后回调 enqueueBatch。
    const r = this.humanlike.ingest(event, { isCommand: isCommandText(event.text) });
    if (r.action === 'handled') return;
    this.enqueue(r.events);
  }

  /** 拟人层攒够消息后的回调（也用于主动发言轮：events 为空） */
  enqueueBatch(batch: TriggerBatch): void {
    if (!batch.events.length) {
      this.enqueue([this.syntheticEvent(batch.chat)], { proactive: batch.detail, gateId: batch.gateId });
      return;
    }
    this.enqueue(batch.events, { gateId: batch.gateId });
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

  private enqueue(events: ChatEvent[], opts: { proactive?: string; gateId?: string } = {}): void {
    const carrier = events[events.length - 1];
    if (!carrier) return;
    const key = `${carrier.type}_${carrier.chatId}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    if (this.activeTurns.get(key) ?? 0) {
      // 已有轮次在跑：入队（队列长度受限防堆积）
      if (this.queueLen(key) > 5) {
        this.sessionLog.append(carrier.chatId, carrier.type, { type: 'system', role: 'system', text: '消息积压，已丢弃' });
        this.humanlike.dropGate(carrier, opts.gateId);
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

  /**
   * 桌面端会话页输入框以 bot 身份发言。走完整发送链（限速与会话日志照常），发完
   * 按 role=model（assistant）回灌历史——模型读上下文时才知道这句话是自己说的。
   * 旧的测试用户注入（/api/chats/:key/inject）保留作调试，与这里不混用。
   */
  async sendAsBot(chat: ChatRef, text: string): Promise<void> {
    const t = String(text ?? '');
    await this.chat.sendText(chat, t);
    if (t.trim()) {
      this.history.pushAssistant(chat, t.trim());
      this.humanlike.noteSpoke(chat, 1, [t.trim()]);
    }
  }

  /** 中断当前轮（桌面端按钮） */
  abortChat(chatId: string): void {
    const meta = this.turnMeta.get(chatId);
    if (meta) meta.abortReason = 'user';
    this.aborts.get(chatId)?.abort();
  }

  /**
   * 出站打断：她还在一条条发气泡，对面又说话了 —— 把**剩下没发的气泡**砍掉（2026-10-18 用户口径）。
   *
   * 触发条件只有两件：① 还有气泡没发出去；② 按下 `interrupt.probability`（默认 0.8）掷一次。
   * **不看内容语义**（不认制止语、不看是不是 @）、不走模型 —— 要求是"对面发完立刻生效"，
   * 走一趟模型，剩下那几条早就按打字停顿发完了。
   *
   * 命令（`/work`）是显式意图，不掷骰子：它本身就该立刻执行，顺手把没说完的话截断。
   * 只有 chat 轮的回复登记了在途（`sendScene` 传 `interruptible`）：命令回执、跟屏复读、
   * 桌面端手动发言都打断不到 —— 那些是"必须说完"的话。@ 触发的轮次同样传 false：
   * @ 必回，插话打断对它直接失效。
   */
  private maybeInterrupt(chat: ChatRef, event: ChatEvent): void {
    const cfg = this.humanlike.config.interrupt;
    if (!cfg?.enable) return;
    const isCommand = isCommandText(event.text);

    // ① 模型还在生成：新消息直接 abort 这一轮，已经想了一半的回复整段作废。
    //    "对面发完立刻生效"只能走 abort；等模型吐完再丢弃，人已经看到延迟了。
    //    转述轮（work 结果回讲）不登记 interruptible：那是必须说完、也不该被闲聊插掉的话。
    const turn = this.turnMeta.get(chat.chatId);
    if (turn && turn.phase === 'generating' && turn.interruptible) {
      const d = isCommand
        ? { interrupt: true, reason: '命令插话' }
        : shouldInterrupt({ remaining: 1, probability: cfg.probability });
      if (d.interrupt) {
        turn.abortReason = 'generation';
        this.aborts.get(chat.chatId)?.abort();
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system',
          text: `生成期被打断：这一轮回复作废（${d.reason}）`,
          data: { decision: 'generation_interrupted', reason: d.reason, by: event.userId },
        });
        return;
      }
    }

    // ② 已经在发气泡：把剩下没发的砍掉（纯程序，零模型调用）。
    const pending = this.chat.pendingOutbound(chat);
    if (!pending || pending.remaining <= 0) return;
    const d = isCommand
      ? { interrupt: true, reason: '命令插话' }
      : shouldInterrupt({ remaining: pending.remaining, probability: cfg.probability });
    if (!d.interrupt) return;
    const r = this.chat.interrupt(chat);
    if (!r) return;
    this.sessionLog.append(event.chatId, event.type, {
      type: 'gate', role: 'system',
      text: `被打断：还剩 ${r.remaining} 条没发（${d.reason}）`,
      data: { decision: 'interrupted', reason: d.reason, remaining: r.remaining, by: event.userId },
    });
  }

  /** 桌面端「已隐藏」的会话 = bot 收不到它（口径与实现在 ConfigStore.chatHidden） */
  private chatHidden(event: ChatEvent): boolean {
    return this.config.chatHidden(this.selfId(), event.type, event.chatId);
  }

  /** 引用一条消息：协议端给的 reply 段里只有原消息号，把它查回原文存成快照。
   *  只查本会话的内存尾（引用基本都是刚刚那几条），查不到就留着 [回复:id] 占位，不编内容。
   *  bot 自己的出站消息也存了 messageId：群里很常见「引用她上一句 + 这个」，不能漏。 */
  private attachReply(event: ChatEvent): void {
    const rid = String(event.segments.find((s) => s.type === 'reply')?.data?.id ?? '');
    if (!rid) return;
    const src = this.sessionLog.findByMessageId(event.chatId, event.type, rid);
    if (!src || (src.type !== 'message_in' && src.type !== 'message_out')) return;
    const raw = Array.isArray((src.data as { files?: unknown } | undefined)?.files)
      ? (src.data as { files: unknown[] }).files : [];
    const files = raw
      .map((f): { name: string; rel: string } => (typeof f === 'string'
        ? { name: f, rel: 'inbox/' + f }
        : { name: String((f as { name?: unknown })?.name ?? ''), rel: String((f as { rel?: unknown })?.rel ?? '') }))
      .filter((f) => f.rel);
    const fromBot = src.type === 'message_out';
    event.replyTo = {
      userId: fromBot ? this.selfId() : (src.userId ?? ''),
      nickname: fromBot ? (this.selfNickname() || this.selfId()) : (src.nickname ?? ''),
      text: src.text ?? '',
      files: files.length ? files : undefined,
    };
  }

  private queueLen(key: string): number {
    return this.queueLens.get(key) ?? 0;
  }

  // ---------------------------------------------------------------- 处理

  private async process(events: ChatEvent[], opts: { proactive?: string; gateId?: string } = {}): Promise<void> {
    if (!events.length) return;
    const event = events[events.length - 1];
    const chatKey = `${event.type}_${event.chatId}`;

    // 隐藏会话兜底：主动发言轮不经过 submit()，隐藏之前攒下的批次也会流到这里。
    // 静默丢弃、不写会话流（隐藏是主人自己的动作，不需要每轮解释"为什么没说话"）。
    if (this.chatHidden(event)) {
      this.humanlike.dropGate(event, opts.gateId);
      return;
    }

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
      this.humanlike.dropGate(event, opts.gateId);
      return;
    }

    // 圈内黑话（表达学习）：上面 submit() 已在门控之前观察过，这里不再重复记账；
    // 只有真正走到对话轮的群消息才需要把"本群词表"拼进 system。

    const role = this.resolveRole(event);
    event.role = role;
    const text = event.text.trim();

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
    // 2026-10-21：/work 已删除（work 改成 chat 面的 work_dispatch 工具）。
    // QQ 侧不再有任何内建命令；这里只剩用户插件注册的命令。
    const cmdText = text.startsWith('/') ? text.slice(1) : text.startsWith('／') ? text.slice(1) : null;
    if (cmdText !== null) {
      await this.dispatchCommand(event, role, cmdText);
      return;
    }

    // ---- Agent 对话轮（多用户消息合并进来时，把它们一起交给模型） ----
    // 整批事件一起带进去：文本由 renderBatch 拼，媒体按各自的来源聚合（附件要跟着批次走，不能只看 carrier）
    const userText = renderBatch(allowed);
    // 同一句话短时间内又说了一遍（上一轮已经答过）→ 不再另起一轮重答一遍。
    // 2026-10-18 用户反馈：隔开 2 秒以上再说同样的两句时，它会像忘了一样从头重答。
    // 只在上一轮**真说了话**时才拦：上一轮如果没出声（沉默/失败/被打断），重发可能是催它，照常回。
    const prev = this.lastTurn.get(chatKey);
    if (prev && prev.spoke && this.duplicateWindowMs > 0 && Date.now() - prev.at <= this.duplicateWindowMs && dupText(userText) === prev.text) {
      this.sessionLog.append(event.chatId, event.type, {
        type: 'gate', role: 'system',
        text: `重复消息（与 ${Math.max(1, Math.round((Date.now() - prev.at) / 1000))} 秒前那轮一字不差），不再重复回答`,
        data: { decision: 'duplicate_ignored' },
      });
      this.humanlike.dropGate(event, opts.gateId);
      return;
    }
    this.lastTurn.set(chatKey, { text: dupText(userText), at: Date.now(), spoke: false });
    await this.agentTurn(event, role, chatKey, { userText, batch: allowed, gateId: opts.gateId });
  }

  // ---------------- 命令 ----------------

  private async dispatchCommand(event: ChatEvent, role: Role, cmdText: string): Promise<void> {
    const parts = cmdText.trim().split(/\s+/);
    const name = parts[0] ?? '';
    const args = parts.slice(1);
    const found = this.plugins.findCommand(name);

    this.sessionLog.append(event.chatId, event.type, { type: 'command', role: 'user', userId: event.userId, text: `/${cmdText}` });

    if (!found) {
      // 内建指令面已清空（2026-10-21 起 /work 也没了），这里只会是用户插件注册过的命令；
      // 不泄露其存在性：普通成员统一「未知命令」，管理员多带一个命令名（他没在套话）
      await this.chat.reply(event, roleAtLeastRole(role, 'admin') ? `未知命令：/${name}` : '未知命令');
      return;
    }

    // 后果严格成立：本群未生效 → 命令不可用；管理员可看到"未开启"提示，普通成员当未知命令
    if (!this.plugins.effectiveEnabled(found.pluginId, event.chatId)) {
      if (roleAtLeastRole(role, 'admin')) {
        const lp = this.plugins.get(found.pluginId)!;
        if (lp.manifest.locked && !roleAtLeastRole(role, 'owner')) {
          await this.chat.reply(event, `插件 ${lp.manifest.name} 在本群未开启，人设类插件仅主人可操作。`);
        } else {
          await this.chat.reply(event, `插件「${lp.manifest.name}」在本群未开启。管理员可在桌面端「插件」页为本群开启。`);
        }
      } else {
        await this.chat.reply(event, '未知命令');
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

  /**
   * work 收尾 → 排队一轮人格化汇报。
   *
   * 只认 `trigger === 'chat'`（chat 的 work_dispatch 工具派的活）：
   *  - 子代理的完成回给父代理，不发到群里；
   *  - 直接调用 WorkRunner 的内部/测试路径也不打扰用户。
   * 同一会话两件活同时收尾时串行汇报，避免两轮模型请求抢同一份历史上账。
   */
  private scheduleWorkReport(payload: {
    trigger?: string;
    chat?: { platform: string; type: 'group' | 'private'; chatId: string };
    userId?: string;
    nickname?: string;
    /** 派活时的角色：群里被 QQ 认定的管理员不一定在 config.extraAdminIds 里，汇报轮要沿用，否则 deliver_file 会掉 */
    role?: string;
    task?: string;
    result?: WorkRunResult;
  }): void {
    if (!payload || payload.trigger !== 'chat') return;
    const chat = payload.chat;
    const result = payload.result;
    if (!chat || !result || !payload.userId) return;
    const chatKey = `${chat.type}_${chat.chatId}`;
    const prev = this.reportChains.get(chatKey) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        // 派活那一轮的"好，我去弄"可能还在生成/发送：等它收尾再汇报，群里顺序才自然
        await this.waitForTurnsIdle(chatKey);
        await this.reportWork({ chat, userId: payload.userId!, nickname: payload.nickname, role: payload.role, task: payload.task ?? '', result });
      })
      .catch((e) => {
        this.errors.record('warn', 'kernel', `work 汇报失败：${(e as Error).message}`, { chatId: chat.chatId });
      });
    this.reportChains.set(chatKey, next);
    void next.finally(() => {
      if (this.reportChains.get(chatKey) === next) this.reportChains.delete(chatKey);
    });
  }

  /** 等该会话在途的轮次结束（最多 2 分钟；卡死的轮次不能把汇报永久挂住） */
  private async waitForTurnsIdle(chatKey: string, timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while ((this.activeTurns.get(chatKey) ?? 0) > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 以发起人的身份跑一轮汇报：@ 由 sendScene 程序加上，产物由 deliver_file 发出 */
  private async reportWork(input: {
    chat: { platform: string; type: 'group' | 'private'; chatId: string };
    userId: string;
    nickname?: string;
    role?: string;
    task: string;
    result: WorkRunResult;
  }): Promise<void> {
    const event: ChatEvent = {
      id: newId('workrep_'),
      platform: input.chat.platform, type: input.chat.type, chatId: input.chat.chatId,
      userId: input.userId, nickname: input.nickname ?? '', senderRole: 'member',
      segments: [], text: '', isAtMe: false, isReplyToMe: false,
      raw: { workReport: true }, ts: Date.now(),
    };
    // 会话在跑的过程中被主人隐藏了：汇报也不发（隐藏 = 这个会话对 bot 静默）
    if (this.chatHidden(event)) return;
    // 派活时能过权限，汇报时就该还是那个身份（群管理员不一定在 extraAdminIds 里）
    const role = (input.role === 'owner' || input.role === 'admin' ? input.role : this.resolveRole(event)) as Role;
    event.senderRole = role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : 'member';
    event.role = role;
    await this.agentTurn(event, role, `${event.type}_${event.chatId}`, {
      report: { task: input.task, result: input.result },
      mention: event.type === 'group' ? { userId: input.userId, nickname: input.nickname } : undefined,
    });
  }

  private async agentTurn(
    event: ChatEvent,
    role: Role,
    chatKey: string,
    opts?: {
      /** work 跑完后的异步汇报轮：不塞历史、不套聊天风格，@ 由程序带上 */
      report?: { task: string; result: WorkRunResult };
      /** 汇报轮要 @ 的人（群聊才加 at 段） */
      mention?: { userId: string; nickname?: string };
      /** 覆盖本轮的用户输入（多用户消息合并 / 主动发言） */
      userText?: string;
      /** 主动发言轮：允许模型用沉默标记保持安静，且不往历史里塞一条假用户消息 */
      proactive?: boolean;
      /** 本轮合并进来的整批事件（媒体按各自的来源聚合；不给就按 carrier 单事件取） */
      batch?: ChatEvent[];
      /** 拟人层开口时发的样本回执号（pipeline 用它回报模型最终有没有真说话） */
      gateId?: string;
    },
  ): Promise<void> {
    const chat = { platform: event.platform, type: event.type, chatId: event.chatId };
    const active = this.activeTurns.get(chatKey) ?? 0;
    /** 汇报轮：不是闲聊，不套聊天风格，也不参与生成期打断 */
    const isReport = !!opts?.report;
    /** 这一轮由 @ 触发：@ 必回，插话打断对它直接失效（生成期与气泡期都不打断） */
    const forcedAt = (opts?.batch?.length ? opts.batch : [event]).some((e) => e.isAtMe);

    // 检查本群是否有任何生效中的插件能提供工具/人格；全关时按配置提示管理员
    // 汇报轮的产物由系统合并成聊天记录，不再给模型 deliver_file（避免它又单独发一遍文件）
    const tools = this.plugins.toolsForChat(chat, role)
      .filter((t) => !(isReport && t.name === 'deliver_file'));
    // 「本群还没开启任何插件」的判据沿用重构前口径：work 面工具也算"本群有开启的插件"。
    const anyToolsInGroup = this.plugins.toolsForChat(chat, role, 'work').length > 0;
    const anyChatPersona = [...this.plugins.list()].some(
      (lp) => lp.manifest.category === 'persona' && lp.state === 'loaded' && this.plugins.effectiveEnabled(lp.manifest.id, event.chatId),
    );
    if (tools.length === 0 && !anyToolsInGroup && !anyChatPersona) {
      // 这一轮不会叫模型：把开口样本回执掉，别让它挂到下一轮
      this.humanlike.dropGate(event, opts?.gateId);
      if (event.type === 'group' && this.config.config.risk.silentWhenNothingEnabled) {
        if (roleAtLeastRole(role, 'admin')) {
          const last = this.adminHintAt.get(chatKey) ?? 0;
          if (Date.now() - last > 10 * 60_000) {
            this.adminHintAt.set(chatKey, Date.now());
            await this.chat.reply(event, '本群还没有开启任何插件。管理员可在桌面端「插件」页为本群开启。');
          }
        }
        // 普通成员：完全静默（严格不可见性）
      }
      return;
    }

    const ac = new AbortController();
    this.aborts.set(event.chatId, ac);
    this.turnMeta.set(event.chatId, {
      chatKey,
      phase: 'generating',
      // 汇报轮不参与生成期打断：work 的结论必须讲完；@ 轮同样不可打断（@ 必回）；
      // 普通聊天与主动轮都可以被新消息打断
      interruptible: !isReport && !forcedAt,
    });
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
      // ---- 上下文：只按 storage.historyLimit 条数截断（时间窗已删） ----
      // 更早的消息并没有丢：它们仍在历史缓存与会话日志里，由 search_history / recall_facts 现查。
      const keep = Math.max(1, Math.round(Number(this.config.config.storage.historyLimit) || 200));
      const windowHistory = this.history.snapshot(chat);
      // 搜索工具只翻模型眼前没有的那部分：以可见窗口里最早一条的 ts 为界
      const historyWindowStartTs = windowHistory.find((m) => typeof m.ts === 'number')?.ts;
      if (!isReport) {
        systemSections.push({
          order: 405, title: 'context-window',
          text: [
            `# 上下文`,
            `- 你只看到本会话最近的一段消息（最多 ${keep} 条）；更早的消息不在眼前（当时的图片、语音、视频也不会出现）。`,
            `- **眼前这几条就是你全部可见的对话**。对方只丢来一个词、一句没头没尾的话，那就是真只有这一句：别脑补"前面还说过什么"，照字面接或者问清楚。`,
            `- 回话前先掂量现有信息够不够：不够就查一次 —— search_history（只翻本会话上下文之外的旧原文）或 recall_facts（翻这位用户的长期记忆）；查完就必须作答，查不到就是真没有，别换个词接着查。`,
            `- 不要向用户提「上下文、检索记录」这类内部词，查到就自然接上话。`,
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
      // 输出口径（order 440）：chat 轮**唯一**一段规定"输出长什么样"的指令 ——
      // 短句、镜像长度、不写动作描写，总长上限写进词里。剧本体（HDSI 的 <say> 小说格式）已删，
      // 模型说什么就发什么，分条与截断由程序侧兜底（humanlike/delivery.ts）。
      // 汇报轮不加：那轮要的是把工作结果讲清楚，不是聊天。
      if (!isReport) {
        const out = this.humanlike.config.outgoing;
        systemSections.push({
          order: 440, title: 'chat-style',
          text: chatOutputStyleText({ maxChars: out.replyMaxCharacters }),
        });
      }
      // HDSI 的两个子系统：ChatRhythm 节奏提醒(460) / 日程(470)。汇报轮同样不加。
      if (!isReport) {
        systemSections.push(...this.humanlike.sceneSections(chat));
      }
      // 圈内黑话（472）：本群学来的词与含意，帮 bot 听懂对方；汇报轮同样不加。
      // 只注入当前上下文里真的出现的词（8 个不相干的词每轮塞进去只会让模型硬用）。
      if (!isReport) {
        const recentForJargon = [event.text, ...windowHistory.slice(-8).map((m) => m.content)].join('\n');
        const jargonSection = this.jargon?.sections(chat, recentForJargon);
        if (jargonSection) systemSections.push({ order: 472, title: 'jargon', text: jargonSection });
      }
      // 有一件活停在这位管理员这里（work 停下来提问了）：让她知道，并在对方回答时用 work_dispatch 接回去。
      // 只说给管理员听：这问题只有他能定，普通成员看到也只是噪声。
      const pendingAsk = isReport ? undefined : this.workRunner.livePending(chatKey, event.userId);
      if (pendingAsk && roleAtLeastRole(role, 'admin')) {
        systemSections.push({
          order: 500,
          title: 'work-pending',
          text: [
            `# 有一件活停在你这里`,
            `工作子代理 ${Math.max(1, Math.round((Date.now() - pendingAsk.at) / 60_000))} 分钟前停下来问：${pendingAsk.question}`,
            pendingAsk.notes ? `（它已经做到：${pendingAsk.notes}）` : '',
            `这个问题只有发起人能定，别替他猜。他回答之后，用 work_dispatch 把他的回答原话交回去（task 就写他说的话），它会接着干。`,
          ].filter(Boolean).join('\n'),
        });
      }
      // 本会话最近一次 work 交付的产物（只给管理员）：用户隔了几分钟回来说"发给我看看"时，
      // chat 模型看不到那次任务的上下文，得靠这一节知道有东西可发、叫什么名字。
      // 产物落在**发起人自己的** work 沙箱里，所以按当前说话人取（每个人只看见自己那份）。
      if (!isReport && roleAtLeastRole(role, 'admin')) {
        const last = this.workRunner.latestArtifacts(chatKey, event.userId);
        if (last?.artifacts.length) {
          systemSections.push({
            order: 505,
            title: 'work-artifacts',
            text: [
              `# 最近一次交付的产物`,
              `任务：${last.task}`,
              `文件（会话沙箱内，用 deliver_file 发送）：`,
              ...last.artifacts.map((a) => `- ${a}`),
              `他要文件/要看效果时就用 deliver_file 发出去，不要只说路径、也不要说"发不了"。`,
            ].join('\n'),
          });
        }
      }
      // 汇报轮：把 work 的结果作为本轮输入交给 chat 模型，由它用自己的口吻讲给发起人。
      // 三种口径分开写：停下来提问 ≠ 干完了，不能都用"已完成"糊过去。
      const userText = opts?.report
        ? workReportNote(opts.report)
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
        // 窗口起点交给工具面：search_history 只该翻模型眼前没有的那部分
        historyWindowStartTs,
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

      // 主动发言轮不往历史里塞这条"假用户消息"（它不是任何人的发言）；
      // 汇报轮的输入是内核写的内部汇报单，也不该伪装成发起人的发言——模型自己的汇报正文会入历史。
      // 附件跟着入账：窗口内的历史消息要能重放"这条当时带了图/语音/视频"。
      if (!opts?.proactive && !opts?.report) this.history.pushUser(chat, userText, ctx.attachments);

      const { reply } = await this.agentLoop.run(ctx, { chatKey, abort: ac.signal });

      // 生成期被新消息打断：模型即使把结果吐完了也整段作废（新消息会成为下一轮的输入）。
      // abort 是否被 pi-agent-core 立刻兑现因供应商而异，所以这里再兜一层。
      const turn = this.turnMeta.get(event.chatId);
      if (turn?.abortReason === 'generation') {
        this.humanlike.dropGate(event, opts?.gateId);
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system',
          text: '生成期被打断：模型输出已丢弃，等下一轮',
          data: { decision: 'generation_aborted' },
        });
        return;
      }
      // afterLLM 钩子（persona checker 插槽）
      let finalReply = await this.applyAfterLLM(ctx, reply, event);

      // 没接模型 / 额度耗尽 / 链全挂会被吞成空回复：这轮一个字不发，只落 gate 条目。
      // 群里出现"没答好请再问一次"式的托词比沉默更伤人设，失败细节都在报错中心与会话流里。
      if (!finalReply.trim()) {
        this.humanlike.noteTurnOutcome(chat, opts?.gateId, false);
        this.humanlike.noteSilent(chat);
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system', text: '本轮没有产出内容（模型未接入或请求失败），保持沉默',
          data: { decision: 'empty_reply' },
        });
        return;
      }

      // 主动发言轮允许沉默（[silent] 标记 = 模型选择这轮不说话）
      if (opts?.proactive && isSilentScene(finalReply)) {
        this.humanlike.noteTurnOutcome(chat, opts?.gateId, false);
        this.humanlike.noteSilent(chat);
        this.sessionLog.append(event.chatId, event.type, {
          type: 'gate', role: 'system', text: '主动发言：模型选择这次不说话',
          data: { decision: 'proactive_silent' },
        });
        return;
      }

      // 重复惩罚：冷却词在这条回复里又出现 → 严格重写一次（汇报轮不重写）。
      // 重写走独立的一次 llm.chat，不跑第二个 agent loop；期间仍可被新消息 abort。
      if (!isReport && !isSilentScene(finalReply)) {
        const hit = this.humanlike.repetitionHit(chat, finalReply);
        if (hit) {
          const retried = await this.rewriteRepetition(ctx, finalReply, hit.phrase, event, ac.signal);
          if (ac.signal.aborted || this.turnMeta.get(event.chatId)?.abortReason === 'generation') {
            this.humanlike.dropGate(event, opts?.gateId);
            return;
          }
          if (retried && !isSilentScene(retried)) {
            const checked = await this.applyAfterLLM(ctx, retried, event, false);
            if (checked.trim() && !isSilentScene(checked)) {
              const still = this.humanlike.repetitionHit(chat, checked);
              this.humanlike.noteRepetitionRetry(chat, hit.phrase, !still);
              this.sessionLog.append(event.chatId, event.type, {
                type: 'gate', role: 'system',
                text: `重复惩罚：重写${still ? '后仍含' : '去掉了'}「${hit.phrase}」`,
                data: {
                  decision: 'repetition_retry', phrase: hit.phrase, ok: !still,
                  from: finalReply.slice(0, 200), to: checked.slice(0, 200),
                },
              });
              finalReply = checked;
            } else {
              this.humanlike.noteRepetitionRetry(chat, hit.phrase, false);
              this.sessionLog.append(event.chatId, event.type, {
                type: 'gate', role: 'system',
                text: `重复惩罚：重写为空或被判沉默（${hit.phrase}）`,
                data: { decision: 'repetition_retry', phrase: hit.phrase, ok: false, reason: 'rewrite_empty' },
              });
            }
          } else {
            this.humanlike.noteRepetitionRetry(chat, hit.phrase, false);
            this.sessionLog.append(event.chatId, event.type, {
              type: 'gate', role: 'system',
              text: `重复惩罚：重写失败，保留原回复（${hit.phrase}）`,
              data: { decision: 'repetition_retry', phrase: hit.phrase, ok: false, reason: 'rewrite_failed' },
            });
          }
        }
      }

      // 重写结束、真正进入发送阶段：之后的插话交给气泡级打断，不再 abort 模型
      if (turn) turn.phase = 'sending';

      // 模型最终有没有真说话：以 afterLLM 之后的可见正文为准。回 [silent] / 空输出都记 0，
      // 不再把"门开了"当成"模型开口了"（2026-10-18 修）。
      this.humanlike.noteTurnOutcome(chat, opts?.gateId, !isSilentScene(finalReply));
      const quoteTarget = canQuoteTurn(event, opts) ? this.quoteTargetOf(event) : undefined;
      await this.sendScene(chat, finalReply, quoteTarget, opts?.mention,
        opts?.report ? { artifacts: opts.report.result.artifacts ?? [], userId: event.userId, nickname: event.nickname } : undefined,
        !forcedAt);
      if (opts?.proactive) this.humanlike.noteProactive(chat);
    } catch (e) {
      const msg = (e as Error).message;
      const turn = this.turnMeta.get(event.chatId);
      // 打断/异常结束：样本丢掉，别把"没来得及回"当成"模型不想回"
      this.humanlike.dropGate(event, opts?.gateId);
      // 生成期打断是预期内的事件，不是模型故障：静默收尾，别往报错中心写
      if (ac.signal.aborted && turn?.abortReason === 'generation') return;
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
      this.turnMeta.delete(event.chatId);
      // 重新武装主动发言计时器：这一轮不管说没说话，都从"现在"重新起算静默时长
      this.humanlike.afterTurn(chat);
    }
  }

  /** afterLLM 钩子循环：原回复与重复惩罚重写共用；重写只校验，不重复入记忆队列 */
  private async applyAfterLLM(
    ctx: LLMRequestContext,
    reply: string,
    event: ChatEvent,
    sideEffects = true,
  ): Promise<string> {
    let out = reply;
    for (const lp of this.plugins.list()) {
      if (lp.state !== 'loaded') continue;
      if (!this.plugins.effectiveEnabled(lp.manifest.id, event.chatId)) continue;
      if (!lp.hooks.afterLLM) continue;
      try {
        out = await lp.hooks.afterLLM(ctx, out, { sideEffects });
      } catch (e) {
        this.errors.record('warn', 'plugin', `afterLLM 出错（${lp.manifest.id}）: ${(e as Error).message}`, { pluginId: lp.manifest.id });
      }
    }
    return out;
  }

  /** 重复惩罚的一次重写：带草稿与命中词，只输出正文；不跑第二个 agent loop */
  private async rewriteRepetition(
    ctx: LLMRequestContext,
    draft: string,
    phrase: string,
    event: ChatEvent,
    signal: AbortSignal,
  ): Promise<string> {
    const system = composeSystem(ctx.system, [
      ...(ctx.systemSections ?? []),
      { order: 463, name: 'repetition-rewrite', text: repetitionRetryConstraint(draft, [phrase]) },
    ]);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...ctx.messages,
      { role: 'assistant', content: draft },
      { role: 'user', content: `重写上面这条回复：不要出现「${phrase}」，保持原意，短一点；只输出正文，不要解释。` },
    ];
    const cap = Math.round(Number(this.config.config.humanlike.outgoing.maxReplyTokens) || 0);
    try {
      const resp = await this.llm.chat({
        model: '',
        messages,
        stream: false,
        signal,
        ...(cap > 0 ? { maxTokens: cap } : {}),
      }, { chatId: event.chatId, chain: 'chat' });
      return String(resp.content ?? '').trim();
    } catch (e) {
      this.errors.record('warn', 'provider', `重复惩罚重写失败：${(e as Error).message}`, { chatId: event.chatId });
      return '';
    }
  }

  /**
   * 组回复的引用锚点（v1，纯程序）：引用"这条回复是在回谁"的触发消息。
   * 只在**发送那一刻**触发消息已被后面的新消息刷远时才挂 —— 群里安安静静的一问一答不加引用
   * （口径：一般的消息不需要引用；引用只在"落点显错位"时补位）。
   * 引用的正文段与发送由 ChatService 照常处理；模型全程零成本。
   */
  private quoteTargetOf(event: ChatEvent): string | undefined {
    if (event.type !== 'group') return undefined;
    const mid = String(event.messageId ?? '').trim();
    if (!mid) return undefined;
    try {
      return this.sessionLog.hasNewerInbound(event.chatId, event.type, mid) ? mid : undefined;
    } catch { return undefined; }
  }

  /**
   * 一轮回复落地：模型说什么就发什么。
   *  - 沉默标记 → 什么都不发；
   *  - 其余：程序侧按句分条 + 句边截断（humanlike/delivery.ts），需要时给第一条挂引用段；
   *  - 发出去的正文按 role=model 回灌历史 —— 模型读上下文时才知道这句话是自己说的
   *    （跟屏复读、桌面端手动发言也是同一条口径，见 kernel/repeat 与 pipeline.sendAsBot）。
   *
   * **被插话打断时（`interruptible`）只回灌真发出去的那几条**（2026-10-18 用户裁定）：
   * 砍掉的气泡一个字都不进历史 —— 她下一轮不该记得自己"本来还想说"那几句，
   * 否则模型会接着被截断的话头往下讲，等于打断没生效。
   */
  private async sendScene(
    chat: { platform: string; type: 'group' | 'private'; chatId: string },
    raw: string,
    quoteTarget?: string,
    /** 汇报轮 @ 发起人：程序带上 at 段（不靠模型在正文里写 @号码） */
    mention?: { userId: string; nickname?: string },
    /** 汇报轮：正文 + 产物合并成一条聊天记录；普通轮不传 */
    forward?: { artifacts: string[]; userId: string; nickname?: string },
    /** 这轮的气泡是否允许被插话砍掉；@ 轮与汇报轮传 false */
    interruptible = true,
  ): Promise<void> {
    if (forward) {
      // 一条聊天记录：汇报正文整段进首节点（不按聊天气泡切/50 字截断），产物文件各占一个节点
      const text = this.humanlike.reportText(raw);
      if (!text && !forward.artifacts.length) { this.humanlike.noteSilent(chat); return; }
      try {
        await this.chat.sendForward({ ...chat, scope: workScopeOf(forward.userId) }, {
          text,
          artifacts: forward.artifacts,
          mention: mention ? { userId: mention.userId } : undefined,
          selfId: this.selfId(),
          selfNickname: this.selfNickname(),
        });
        this.humanlike.noteSpoke(chat, 1, text ? [text] : []);
        if (text) this.history.pushAssistant(chat, text);
        this.markTurnSpoke(chat);
        return;
      } catch (e) {
        // 协议端不支持 forward 时 sendForward 内部已经退回过分开发送；走到这里多半是没连上，
        // 继续走普通发送，至少把文字说出去
        this.errors.record('warn', 'work', `聊天记录发送失败，退回普通发送：${(e as Error).message}`, { chatId: chat.chatId });
      }
    }
    const { plans } = await this.humanlike.composeScene(raw);
    if (!plans.length) {
      this.humanlike.noteSilent(chat);
      return;
    }
    if (mention && chat.type === 'group' && mention.userId) {
      plans[0].segments.unshift({ type: 'at', data: { qq: mention.userId } });
    }
    if (quoteTarget) plans[0].segments.unshift({ type: 'reply', data: { id: quoteTarget } });
    const { sent, aborted, sentTexts } = await this.chat.sendPlanned(chat, plans, { interruptible });
    if (aborted) {
      // 一条都没发出去就被打断：不记 spoke（打断不是她的犹豫，不该推进空闲退避），也不回灌历史
      if (sent <= 0) return;
      this.humanlike.noteSpoke(chat, sent, sentTexts);
      this.history.pushAssistant(chat, sentTexts.join('\n'));
      // 故意不标 spoke：被打断的那轮不算"答过了"，同一句重发应该照常回答
      return;
    }
    // 只记**真正发出去**的气泡：限速截断时没发的那几条不能算进重复惩罚/节奏签名/历史
    this.humanlike.noteSpoke(chat, sent > 0 ? sent : 1, sentTexts);
    if (sentTexts.length) this.history.pushAssistant(chat, sentTexts.join('\n'));
    this.markTurnSpoke(chat);
  }

  /** 这一轮真说出去了：给上一轮留的「重复消息」现场打上标记（下一句一字不差的重发才拦得住）。
   *  不动 `at`：窗口从**用户发那句话**算起，否则她答得慢时窗口会被悄悄拉长。 */
  private markTurnSpoke(chat: { type: 'group' | 'private'; chatId: string }): void {
    const rec = this.lastTurn.get(`${chat.type}_${chat.chatId}`);
    if (rec) rec.spoke = true;
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
