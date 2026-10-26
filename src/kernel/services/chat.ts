import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { ChatRef, ChatSendService, MsgSegment } from '../types.ts';
import type { SendPlan } from '../humanlike/index.ts';
import { RateLimiter } from '../ratelimit.ts';
import { faceTokensToSegments, qqFaceId, qqFaceName } from '../util/qqface.ts';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve, sep, normalize } from 'node:path';
import { createZipFile } from '../zip.ts';
import { isDeliverableArtifact } from './artifacts.ts';

export interface TransportAdapter {
  /** 发送消息段到指定会话；返回平台消息 id（可为空） */
  send(chat: ChatRef, segments: MsgSegment[]): Promise<string | undefined>;
  /** 发送合并转发（聊天记录）：nodes 的 content 里可以放文本与文件段 */
  sendForward(chat: ChatRef, nodes: { userId?: string; nickname?: string; content: MsgSegment[] }[]): Promise<string | undefined>;
  /** 戳一戳（双击头像）；群聊需要 userId，私聊传对面 userId */
  sendPoke(chat: ChatRef, userId: string): Promise<void>;
  /** 贴表情（消息下面的表情回应）：只支持群聊消息 */
  sendReaction(chat: ChatRef, messageId: string, emojiId: string): Promise<void>;
  /** 发送本地文件（OneBot 场景传 file:// URI）；仅内核在沙箱校验后调用 */
  sendFile(chat: ChatRef, absPath: string): Promise<string | undefined>;
  connected(): boolean;
  status(): Record<string, unknown>;
}

/**
 * 发送服务：逐条发送、限速、随机抖动（红线 §3.3 风控克制）、会话日志与 UI 事件。
 * 文件发送强校验：仅允许当前会话沙箱内路径（红线 §3.2）。
 *
 * 「一条回复拆成几条短消息、每两条之间隔多久」不在这里决定 —— 那是拟人层（humanlike）
 * 的 `compose()` 算好的 `SendPlan[]`；本服务只负责把计划照做。
 */
export class ChatService implements ChatSendService {
  private limiter: RateLimiter;
  private adapter?: TransportAdapter;
  /** 出站单条消息字节数上限（平台硬限制；超过按长度兜底再切） */
  maxSegmentChars = 1800;
  /** 在途的可打断发送（按 chatKey）：同一会话同时只会有一条（pipeline 的队列保证） */
  private outbound = new Map<string, OutboundRun>();

  constructor(
    private bus: Bus,
    private opts: {
      ratePerMin: number;
      sandboxRoot: (chat: ChatRef) => string;
      sessionLog: {
        append(chatId: string, chatType: string, entry: any): any;
        tail(chatId: string, chatType: string, limit?: number): any[];
      };
      onUsage: (dir: 'in' | 'out') => void;
    },
  ) {
    this.limiter = new RateLimiter(opts.ratePerMin);
  }

  setRatePerMin(n: number): void {
    this.opts.ratePerMin = n;
    this.limiter.setPerMin(n);
  }

  attachAdapter(adapter: TransportAdapter): void {
    this.adapter = adapter;
  }

  /** 发一组消息段（不分条、无停顿）。命令回复、通知这类"整块内容"走这里。 */
  async send(chat: ChatRef, segments: MsgSegment[]): Promise<void> {
    await this.sendTracked(chat, segments);
  }

  /**
   * 同 `send`，但返回真实投递回执：`sent === 0` = 被限速整批丢弃。
   * 调用方需要区分「已送达」与「静默丢弃」时用它（send 的 resolve 不能证明送达）。
   */
  async sendTracked(chat: ChatRef, segments: MsgSegment[]): Promise<{ sent: number; ids: string[] }> {
    const r = await this.sendPlanned(chat, [{ segments, pauseMs: 0 }]);
    // 不能用 r.sent：它统计的是协议端返回的消息 id 数（ui 模拟发送、或协议端不返 id 时会误报 0）。
    // sentTexts 是真正处理过的段数，才是「有没有发出去」的可靠口径。
    return { sent: r.sentTexts.length, ids: r.ids };
  }

  /**
   * 按拟人层给的计划逐条发送。
   * - 限速**按条计费**（`plans.length` 个令牌），配额不够就截断成前几条，而不是整批丢弃
   * - `pauseMs` 是这条发出前的停顿（模拟"正在输入"）——**回复前的等待只有这一个来源**
   *   （拟人化 `outgoing` / `merge`），风控不再另设随机抖动，两处叠加会把节奏调不准
   * - `interruptible` = 这条回复允许被 `interrupt()` 打断：打断只砍**还没发**的气泡，
   *   等待中的停顿立刻结束（不留残余 timer），返回的 `sentTexts` 是真正发出去的那几条
   */
  async sendPlanned(chat: ChatRef, plans: SendPlan[], opts: { interruptible?: boolean } = {}): Promise<{
    sent: number; ids: string[]; aborted: boolean; sentTexts: string[];
  }> {
    if (!plans.length) return { sent: 0, ids: [], aborted: false, sentTexts: [] };

    // 风控：限速。一轮回复拆成几条就该吃几个令牌 —— 否则 12 条/分钟能变成 70+ 条/分钟。
    const rl = this.limiter.tryTake(`${chat.platform}:${chat.type}:${chat.chatId}`, plans.length);
    let queue = plans;
    if (rl.granted <= 0) {
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'gate', role: 'system',
        text: `发送被限速丢弃（等待 ${rl.waitMs}ms 超过上限），内容: ${summarize(plans.flatMap((p) => p.segments))}`,
        data: { decision: 'rate_limited', waitMs: rl.waitMs, dropped: plans.length },
      });
      return { sent: 0, ids: [], aborted: false, sentTexts: [] };
    }
    if (rl.granted < plans.length) {
      queue = plans.slice(0, rl.granted);
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'gate', role: 'system',
        text: `限速截断：这一轮 ${plans.length} 条，配额只够 ${rl.granted} 条，后面的留在会话日志里没发`,
        data: { decision: 'rate_truncated', wanted: plans.length, granted: rl.granted },
      });
    }

    const ids: string[] = [];
    const sentTexts: string[] = [];
    const chatKey = `${chat.platform}:${chat.type}:${chat.chatId}`;
    let run: OutboundRun | undefined;
    if (opts.interruptible) {
      run = { total: queue.length, sent: 0, aborted: false, wake: () => {}, wakePromise: Promise.resolve() };
      // 唤醒口：打断时 resolve，让正在等打字停顿的那一觉立刻醒
      let wake!: () => void;
      run.wakePromise = new Promise<void>((r) => { wake = r; });
      run.wake = wake;
      this.outbound.set(chatKey, run);
    }
    const done = () => ({ sent: ids.length, ids, aborted: !!run?.aborted, sentTexts: [...sentTexts] });

    try {
      for (const plan of queue) {
        if (run?.aborted) break;
        if (plan.pauseMs > 0) {
          await (run ? Promise.race([sleep(plan.pauseMs), run.wakePromise]) : sleep(plan.pauseMs));
        }
        if (run?.aborted) break;                    // 打断落在停顿里：这条连同后面的一起不发
        // 条与条之间的硬长度兜底（平台单条上限）；拟人层已按分隔符切过，这里基本不会触发
        for (const part of splitSegments(plan.segments, this.maxSegmentChars)) {
          const segments = part;

          // 桌面端注入的会话（platform=ui）：无外部协议端，仅落日志与事件流
          if (chat.platform === 'ui') {
            this.opts.onUsage('out');
            this.opts.sessionLog.append(chat.chatId, chat.type, {
              type: 'message_out', role: 'assistant', text: textOf(segments),
              data: { segments, simulated: true },
            });
            this.bus.emit(busEvents.chatOut, { chat, segments, text: textOf(segments), ts: Date.now(), simulated: true });
            sentTexts.push(textOf(segments));
            if (run) run.sent++;
            continue;
          }
          if (!this.adapter?.connected()) {
            this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: '协议端未连接，消息未能发出' });
            if (!ids.length) throw new Error('协议端未连接');
            return done();   // 已经发出去几条就不再抛，免得用户看到"整条失败"
          }
          let sentId: string | undefined;
          try {
            sentId = await this.adapter.send(chat, segments);
            if (sentId) ids.push(sentId);
          } catch (e) {
            this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: `发送失败: ${(e as Error).message}` });
            if (!ids.length) throw e;
            return done();   // 已经发出去几条就不再抛，免得用户看到"整条失败"
          }
          this.opts.onUsage('out');
          this.opts.sessionLog.append(chat.chatId, chat.type, {
            type: 'message_out', role: 'assistant', text: textOf(segments),
            // 存协议端消息号：别人引用 bot 的这条消息时，pipeline.attachReply 才能查回原文
            data: { segments, messageId: sentId, part: ids.length, parts: queue.length },
          });
          this.bus.emit(busEvents.chatOut, { chat, segments, text: textOf(segments), ts: Date.now() });
          sentTexts.push(textOf(segments));
          if (run) run.sent++;
        }
      }
      return done();
    } finally {
      // 只清自己那份：万一同一会话已经排了下一轮，别把它登记表里的现场删掉
      if (run && this.outbound.get(chatKey) === run) this.outbound.delete(chatKey);
    }
  }

  /**
   * 打断该会话在途的回复（纯程序，零模型调用）：把 `aborted` 立起来并唤醒等待中的停顿，
   * 循环下一行就退出，**剩下的气泡一个字都不发**。返回还剩几条没发（没有在途发送返回 undefined）。
   */
  interrupt(chat: ChatRef): { remaining: number } | undefined {
    const run = this.outbound.get(`${chat.platform}:${chat.type}:${chat.chatId}`);
    if (!run || run.aborted) return undefined;
    run.aborted = true;
    run.wake();
    return { remaining: Math.max(0, run.total - run.sent) };
  }

  /** 该会话有没有在途的可打断发送（还剩几条）；没有返回 undefined */
  pendingOutbound(chat: ChatRef): { remaining: number } | undefined {
    const run = this.outbound.get(`${chat.platform}:${chat.type}:${chat.chatId}`);
    if (!run) return undefined;
    return { remaining: Math.max(0, run.total - run.sent) };
  }

  async sendText(chat: ChatRef, text: string): Promise<void> {
    // 桌面端手打、命令回复、系统通报都走这里：`[表情/微笑]` 同样能发成真表情
    const segments = faceTokensToSegments(text);
    if (!segments.length) return; // 整条都是切坏/认不出的表情标记：不发空消息
    await this.send(chat, segments);
  }

  /**
   * 合并转发一条「工作交付」聊天记录：正文 + 产物都塞进同一个 forward。
   *
   * 产物多于一个时**先打包成一个 zip 合集**再放进聊天记录（2026-10-23 用户明令）：
   * QQ 的合并转发对 node 里的文件段支持并不一致，逐个文件节点很容易被协议端展开成
   * 一串独立文件消息——看起来就是"一堆产物单独发了"。只留一个包，既是一次投递，
   * 也保证正文和文件在同一条聊天记录里。
   *
   * 协议端不支持 forward（或 node 里不收 file）时退回普通分开发送，正文和文件都不丢。
   */
  async sendForward(chat: ChatRef, opts: {
    text: string;
    artifacts?: string[];
    mention?: { userId: string };
    selfId?: string;
    selfNickname?: string;
    /** 产物所在的沙箱（2026-10-25 任务隔离：任务沙箱 ≠ 发送目标聊天）；缺省用 chat 自己的 */
    sandboxChat?: ChatRef;
  }): Promise<void> {
    const text = String(opts.text ?? '').trim();
    const root = normalize(this.opts.sandboxRoot(opts.sandboxChat ?? chat));
    const files: { rel: string; name: string; abs: string; size: number }[] = [];
    for (const rel of opts.artifacts ?? []) {
      try {
        const p = String(rel ?? '').trim().replace(/\\/g, '/');
        if (!isDeliverableArtifact(p)) continue;
        const abs = normalize(resolve(root, p));
        if ((abs !== root && !abs.startsWith(root + sep)) || !existsSync(abs) || !statSync(abs).isFile()) continue;
        files.push({ rel: p, name: p.split('/').pop() || p, abs, size: statSync(abs).size });
      } catch { /* 单个文件解析失败不拖垮整条记录 */ }
    }
    if (!text && !files.length) return;
    // 限速按条计费：一条聊天记录算一条
    const rl = this.limiter.tryTake(`${chat.platform}:${chat.type}:${chat.chatId}`, 1);
    if (rl.granted <= 0) {
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'gate', role: 'system', text: `聊天记录被限速丢弃（等待 ${rl.waitMs}ms 超过上限）`,
        data: { decision: 'rate_limited', waitMs: rl.waitMs, dropped: 1 },
      });
      return;
    }

    // 多份产物 → 一个合集包；单份保持原样（一张图/一个文件再包一层反而添麻烦）
    const pack = files.length > 1 ? this.packArtifacts(root, files) : undefined;
    const delivery = pack ? [pack.file] : files;
    const shownText = pack
      ? `${text}${text ? '\n\n' : ''}—— 合集：${files.length} 个产物已打包进「${pack.file.name}」`
      : text;

    const content: MsgSegment[] = [];
    if (opts.mention && chat.type === 'group') content.push({ type: 'at', data: { qq: opts.mention.userId } });
    if (shownText) content.push({ type: 'text', data: { text: shownText } });
    const nodes: { userId?: string; nickname?: string; content: MsgSegment[] }[] = [];
    if (content.length) nodes.push({ userId: opts.selfId, nickname: opts.selfNickname, content });
    for (const f of delivery) {
      nodes.push({
        userId: opts.selfId, nickname: opts.selfNickname,
        content: [{ type: 'file', data: { file: pathToFileURL(f.abs).href, name: f.name } }],
      });
    }

    const record = {
      title: '工作交付',
      dropped: 0,
      failed: false,
      nodes: [
        ...(shownText ? [{ userId: opts.selfId ?? '', nickname: opts.selfNickname ?? '', text: shownText, ts: Date.now() }] : []),
        ...delivery.map((f) => ({
          userId: opts.selfId ?? '', nickname: opts.selfNickname ?? '',
          text: '', ts: Date.now(),
          files: [{ name: f.name, rel: f.rel, sandboxPath: f.abs, size: f.size }],
        })),
      ],
    };

    if (chat.platform === 'ui') {
      this.opts.onUsage('out');
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'message_out', role: 'assistant', text: shownText,
        data: { forward: record, artifacts: files.map((f) => f.rel), package: pack ? { name: pack.file.name, count: files.length } : undefined, simulated: true },
      });
      this.bus.emit(busEvents.chatOut, { chat, segments: [], text: shownText, ts: Date.now(), simulated: true });
      return;
    }
    if (!this.adapter?.connected()) throw new Error('协议端未连接，消息未能发出');
    let id: string | undefined;
    try {
      id = await this.adapter.sendForward(chat, nodes);
    } catch {
      // 老协议端/不支持 forward 的线格式：退回正文一条 + 文件逐条，至少不丢交付
      await this.send(chat, content.length ? content : [{ type: 'text', data: { text: shownText } }]);
      for (const f of delivery) await this.sendFile(chat, f.abs);
      return;
    }
    this.opts.onUsage('out');
    this.opts.sessionLog.append(chat.chatId, chat.type, {
      type: 'message_out', role: 'assistant', text: shownText,
      data: {
        forward: record,
        // 清单仍记原始产物（桌面端抽屉/补发要按它们找），合集只影响实际发出的节点
        artifacts: files.map((f) => f.rel),
        package: pack ? { name: pack.file.name, count: files.length } : undefined,
        messageId: id,
      },
    });
    this.bus.emit(busEvents.chatOut, { chat, segments: [{ type: 'forward', data: { id: id ?? '' } }], text: shownText, ts: Date.now() });
  }

  /** 把多份产物打成一个 zip 合集（沙箱内 deliver/，并顺手清掉旧的包）；失败返回 undefined */
  private packArtifacts(
    root: string,
    files: { rel: string; name: string; abs: string; size: number }[],
  ): { file: { rel: string; name: string; abs: string; size: number } } | undefined {
    const dir = join(root, 'deliver');
    try { mkdirSync(dir, { recursive: true }); } catch { return undefined; }
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const name = `工作交付_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
    const abs = join(dir, name);
    const r = createZipFile(abs, files.map((f) => ({ name: f.rel, abs: f.abs })));
    // 有文件因预算/读取失败被跳过时不发残缺包：退回逐个文件，至少内容齐全
    if (!r.files || r.skipped > 0) {
      try { unlinkSync(abs); } catch { /* 没写成就不用删 */ }
      return undefined;
    }
    // 只留最近 10 个合集，避免沙箱里堆满历史包
    try {
      const olds = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.zip'))
        .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const o of olds.slice(10)) { try { unlinkSync(join(dir, o.n)); } catch { /* 被占用就下次再清 */ } }
    } catch { /* 清理失败不影响本次投递 */ }
    return { file: { rel: `deliver/${name}`, name, abs, size: statSync(abs).size } };
  }

  async sendFile(chat: ChatRef, sandboxPath: string): Promise<void> {
    const root = normalize(this.opts.sandboxRoot(chat));
    const abs = normalize(resolve(sandboxPath));
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error('只允许发送当前会话沙箱内的文件');
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`文件不存在: ${sandboxPath}`);
    if (!this.adapter?.connected()) throw new Error('协议端未连接');
    await this.adapter.sendFile(chat, abs);
    this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'message_out', role: 'assistant', text: `[文件] ${abs}`, data: { file: abs } });
  }

  /** 戳一戳（双击头像）：target 可以是 QQ 号或最近说话人的昵称；私聊省略 = 对面 */
  async poke(chat: ChatRef, target?: string): Promise<{ userId: string; nickname?: string }> {
    const raw = String(target ?? '').trim();
    let userId = '';
    let nickname = '';
    if (/^\d{4,}$/.test(raw)) {
      userId = raw;
    } else if (raw) {
      // 昵称只在本会话最近 500 条里找：模型看到的就是这些名字，别去全库猜人
      const tail = this.opts.sessionLog.tail(chat.chatId, chat.type, 500);
      for (let i = tail.length - 1; i >= 0; i--) {
        const e = tail[i];
        if (e?.type === 'message_in' && (e.nickname === raw || e.userId === raw)) {
          userId = String(e.userId ?? '');
          nickname = String(e.nickname ?? '');
          break;
        }
      }
      if (!userId) throw new Error(`没找到最近说话的人「${raw}」`);
    } else if (chat.type === 'private') {
      userId = chat.chatId;
    } else {
      throw new Error('群里要指定戳谁');
    }
    if (!userId) throw new Error('没有可戳的对象');
    if (!this.adapter?.connected()) throw new Error('协议端未连接');
    await this.adapter.sendPoke(chat, userId);
    const text = `戳了戳 ${nickname || userId}`;
    this.opts.onUsage('out');
    this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'poke', role: 'assistant', text, data: { poke: { userId, nickname } } });
    this.bus.emit(busEvents.chatOut, { chat, segments: [], text, ts: Date.now(), poke: { userId, nickname } });
    return { userId, nickname };
  }

  /**
   * 贴表情（在别人的消息下面挂一个 QQ 表情回应）。
   *
   * 模型看不到消息号（编号戳 2026-10-17 已删），所以「贴哪条」由程序定位：
   *  - 给了 target（QQ 号或昵称）→ 这个人最近一条入站消息；
   *  - 没给 → 本会话最近一条入站消息（对面刚说的那句；私聊就是对方刚说的）。
   * emoji 走内核既有的 QQ 表情名体系（`[表情/微笑]` 那套名字/别名/编号），
   * 解析出的 face 编号直接当 `emoji_id` 用（LLBot 按长度判 face 档）。
   * 群聊与私聊同一套逻辑；私聊能不能真贴上由协议端决定（NapCat 可以，LLBot 只做了群聊）。
   */
  async react(chat: ChatRef, emoji: string, target?: string): Promise<{
    messageId: string; emojiId: string; emojiName: string; userId?: string; nickname?: string;
  }> {
    const rawEmoji = String(emoji ?? '').trim();
    const emojiId = qqFaceId(rawEmoji);
    if (!emojiId) throw new Error(`认不出这个表情「${rawEmoji}」：写表情名（如 微笑/笑哭/赞）或编号`);
    const emojiName = qqFaceName(emojiId);
    const raw = String(target ?? '').trim();
    // 昵称/QQ 号只在最近 500 条里找：模型看到的就是这些名字
    const tail = this.opts.sessionLog.tail(chat.chatId, chat.type, 500);
    let hit: (typeof tail)[number] | undefined;
    const byId = /^\d{4,}$/.test(raw);
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i];
      if (e?.type !== 'message_in') continue;
      if (!raw) { hit = e; break; }
      if (byId ? String(e.userId) === raw : e.nickname === raw) { hit = e; break; }
    }
    if (!hit) {
      throw new Error(raw ? `没找到${byId ? ' ' + raw : `最近说话的「${raw}」`}的消息` : '这个会话里还没有能贴表情的消息');
    }
    const messageId = String((hit.data as { messageId?: string } | undefined)?.messageId ?? '');
    if (!messageId) throw new Error('这条消息没有消息号（协议端没给），贴不了表情');
    const userId = String(hit.userId ?? '');
    const nickname = String(hit.nickname ?? '');
    if (!this.adapter?.connected()) throw new Error('协议端未连接');
    await this.adapter.sendReaction(chat, messageId, emojiId);
    const text = `贴了个表情 ${emojiName}${nickname ? `（${nickname}的消息）` : ''}`;
    this.opts.onUsage('out');
    this.opts.sessionLog.append(chat.chatId, chat.type, {
      type: 'reaction', role: 'assistant', text,
      data: { reaction: { messageId, emojiId, emojiName, userId, nickname } },
    });
    this.bus.emit(busEvents.chatOut, { chat, segments: [], text, ts: Date.now(), reaction: { messageId, emojiId, emojiName, userId, nickname } });
    return { messageId, emojiId, emojiName, userId, nickname };
  }

  async reply(event: { chatId: string; type: 'group' | 'private'; platform: string }, text: string): Promise<void> {
    await this.sendText({ platform: event.platform, type: event.type, chatId: event.chatId }, text);
  }
}

/** 一条在途的可打断发送（sendPlanned 登记，interrupt() 打断） */
interface OutboundRun {
  /** 这一轮计划发几条 */
  total: number;
  /** 已经发出去几条 */
  sent: number;
  aborted: boolean;
  /** 唤醒正在等打字停顿的那一觉 */
  wake: () => void;
  wakePromise: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

function textOf(segments: MsgSegment[]): string {
  return segments.map((s) => (s.type === 'text' ? String(s.data.text ?? '')
    : s.type === 'image' ? '[图片]'
      : s.type === 'face' ? `[表情:${String(s.data.id ?? '')}]`
        : s.type === 'at' ? `@${s.data.qq ?? ''}`
          : s.type === 'reply' ? '' : `[${s.type}]`)).join('');
}

function summarize(segments: MsgSegment[]): string {
  return truncateStr(textOf(segments), 80);
}

function truncateStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把文本段按长度切成多条，其余段保持独立（平台单条上限的硬兜底）。
 *  `reply` / `at` / `face` 段例外：它们必须和正文在同一个消息里（拆开就是一条只有引用/只有 @/只有表情
 *  的空消息 + 一条无引用/没 @ 到的正文）——挂进当前消息、跟着后面的文本走。 */
export function splitSegments(segments: MsgSegment[], maxChars: number): MsgSegment[][] {
  const out: MsgSegment[][] = [];
  let cur: MsgSegment[] = [];
  let curLen = 0;
  for (const seg of segments) {
    if (seg.type === 'reply' || seg.type === 'at' || seg.type === 'face') { cur.push(seg); continue; }
    if (seg.type === 'text' && typeof seg.data.text === 'string') {
      let text: string = seg.data.text;
      while (text.length > maxChars) {
        if (cur.length) { out.push(cur); cur = []; curLen = 0; }
        out.push([{ type: 'text', data: { text: text.slice(0, maxChars) } }]);
        text = text.slice(maxChars);
      }
      if (text) {
        if (curLen + text.length > maxChars) { out.push(cur); cur = []; curLen = 0; }
        cur.push({ type: 'text', data: { text } });
        curLen += text.length;
      }
    } else {
      if (cur.length) { out.push(cur); cur = []; curLen = 0; }
      out.push([seg]);
    }
  }
  if (cur.length) out.push(cur);
  return out.length ? out : [[{ type: 'text', data: { text: '' } }]];
}
