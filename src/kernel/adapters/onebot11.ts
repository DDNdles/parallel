import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync, existsSync } from 'node:fs';
import type { ChatEvent, MsgSegment, ChatRef, ForwardNode, ForwardRecord, IncomingFile } from '../types.ts';
import type { TransportAdapter } from '../services/chat.ts';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { SandboxService } from '../services/sandbox.ts';
import type { Logger } from '../types.ts';
import { newId, nowMs } from '../util/misc.ts';
import { toWav } from '../services/media.ts';
import {
  FORWARD_MAX_IMAGE_BYTES, FORWARD_MAX_MEDIA_BYTES, FORWARD_MAX_NODE_CHARS, FORWARD_MAX_NODE_IMAGES,
  FORWARD_MAX_NODE_MEDIA, FORWARD_MAX_NODES, FORWARD_MAX_DEPTH,
} from '../util/forward.ts';

/** 群名按需拉取失败后的重试间隔（与全量刷新的 5 分钟一拍） */
const NAME_RETRY_MS = 5 * 60_000;
/** 取聊天记录正文的超时：合并转发的内容不在事件里，要现向服务器取，比普通动作慢 */
const FORWARD_TIMEOUT_MS = 10_000;

/**
 * OneBot 11 适配器（支持 access token）。
 * 形态：**反向 WS 服务端** —— 协议端（LLBot 等）主动连接内核，内核无需公网 IP。
 * 事件归一化为 ChatEvent；动作经 call() 携带 echo 等待回包。
 */
export class OneBot11Adapter implements TransportAdapter {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private selfId = '';
  private selfNickname = '';
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private echoSeq = 0;
  private connectedAt = 0;
  private lastHeartbeat = 0;
  private groupNames = new Map<string, string>();
  private friendNames = new Map<string, string>();
  /** 群名按需拉取的上次尝试时间（chatId → ts），失败后隔 NAME_RETRY_MS 再试 */
  private groupNameTried = new Map<string, number>();
  private nameTimer?: ReturnType<typeof setInterval>;
  /** 登录号 ≠ 预期 bot 账号时记在这里；此后所有上行事件丢弃、不再代发 */
  private accountBlocked: { got: string; expected: string } | null = null;
  /** 协议端是否已明确拒绝过私聊消息的表情回应（LLBot 只实现了群聊 reaction）：
   *  一旦失败过就记住，后续私聊不再白跑一趟 action */
  private privateReactionUnsupported = false;
  log: Logger;

  constructor(
    private config: ConfigStore,
    private errors: ErrorCenter,
    private bus: Bus,
    private sandbox: SandboxService,
    private onEvent: (e: ChatEvent) => void,
    /** 拉黑判定：被拉黑的用户连附件都不下、事件也不进内核（与隐藏会话同一处收口） */
    private isBlocked: (userId: string) => boolean,
    loggerFactory: (name: string) => Logger,
  ) {
    this.log = loggerFactory('onebot11');
  }

  /** 启动反向 WS 服务端（端口占用等错误快速失败，不静默挂起） */
  start(): Promise<void> {
    const { port, host, reverseWsPath } = this.config.config.onebot;
    return new Promise((resolveP, rejectP) => {
      this.wss = new WebSocketServer({ port, host }, () => {
        this.log.info(`OneBot11 反向 WS 服务端就绪 ws://${host}:${port}${reverseWsPath}（等待协议端连接）`);
        resolveP();
      });
      this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
      this.wss.on('error', (e) => {
        if (String((e as any).code) === 'EADDRINUSE') {
          rejectP(new Error(`反向 WS 端口 ${port} 被占用（EADDRINUSE）: ${e.message}`));
        } else {
          this.errors.record('error', 'adapter', `反向 WS 服务异常: ${e.message}`);
        }
      });
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.config.config.onebot.reverseWsPath) {
      ws.close(1008, 'bad path');
      return;
    }
    // access token 鉴权（必配）：Authorization: Bearer xxx 或 ?access_token=xxx
    const token = this.config.secrets.onebotAccessToken;
    const header = req.headers['authorization'] ?? '';
    const got = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('access_token') ?? '';
    if (!token || got !== token) {
      this.log.warn(`拒绝未授权的协议端连接（${req.socket.remoteAddress}）`);
      this.errors.record('warn', 'adapter', '拒绝未授权的 OneBot 连接（access token 不匹配）');
      ws.close(1008, 'unauthorized');
      return;
    }

    this.client?.close(1000, 'replaced');
    this.client = ws;
    this.connectedAt = nowMs();
    this.log.info('协议端已连接（反向 WS，token 校验通过）');
    this.bus.emit(busEvents.adapterStatus, { connected: true, ts: this.connectedAt });

    ws.on('message', (data) => {
      try {
        this.handleFrame(JSON.parse(String(data)));
      } catch (e) {
        this.log.error(`帧解析失败: ${(e as Error).message}`);
      }
    });
    ws.on('close', () => {
      if (this.client === ws) {
        this.client = undefined;
        this.log.warn('协议端断开连接');
        this.bus.emit(busEvents.adapterStatus, { connected: false, ts: nowMs() });
        this.errors.record('warn', 'adapter', '协议端反向 WS 断开，等待重连…', { notifyOwner: false });
      }
    });
    ws.on('error', (e) => this.log.error(`WS 错误: ${e.message}`));

    // 连接即拉取登录信息（昵称失败不影响连接判定）
    this.call('get_login_info', {}).then((r) => {
      if (r?.user_id) {
        this.selfId = String(r.user_id);
        this.selfNickname = String(r.nickname ?? '');
        this.log.info(`协议端登录号: ${this.selfId} (${this.selfNickname})`);
        this.checkAccount();
        if (this.accountBlocked) return; // 登错号：不记 lastLogin、不宣告在线（见 checkAccount）
        // 记录最近登录账号（登录页"已登录过"展示与自动登录标识用）
        this.config.config.ui.lastLogin = { qq: this.selfId, nickname: this.selfNickname, ts: nowMs() };
        this.config.saveConfig();
        this.bus.emit(busEvents.adapterStatus, { connected: true, selfId: this.selfId, nickname: this.selfNickname, ts: nowMs() });
      }
    }).catch(() => {});
    // 连入即拉群名/好友昵称，并每 5 分钟刷新（群名会改；间隔避免协议端限频）
    this.refreshGroupNames().catch(() => {});
    if (this.nameTimer) clearInterval(this.nameTimer);
    this.nameTimer = setInterval(() => {
      if (this.connected()) this.refreshGroupNames().catch(() => {});
    }, 5 * 60_000);
  }

  private handleFrame(msg: any): void {
    // 动作回包
    if (msg.echo !== undefined && this.pending.has(String(msg.echo))) {
      const p = this.pending.get(String(msg.echo))!;
      clearTimeout(p.timer);
      this.pending.delete(String(msg.echo));
      if (msg.status === 'failed' || (msg.retcode !== undefined && msg.retcode !== 0)) {
        p.reject(new Error(`OneBot 动作失败 retcode=${msg.retcode}: ${msg.message ?? msg.wording ?? ''}`));
      } else {
        p.resolve(msg.data);
      }
      return;
    }
    // 心跳
    if (msg.post_type === 'meta_event') {
      if (msg.meta_event_type === 'heartbeat') this.lastHeartbeat = nowMs();
      if (msg.meta_event_type === 'lifecycle' && msg.self_id) {
        this.selfId = String(msg.self_id);
        this.checkAccount();
      }
      return;
    }
    // 登错号（见 checkAccount）：一律不处理，绝不代它发言
    if (this.accountBlocked) return;
    // 消息事件
    if (msg.post_type === 'message') {
      this.handleMessageEvent(msg).catch((e) => this.log.error(`消息事件处理失败: ${(e as Error).message}`));
      return;
    }
    // 群文件上传
    if (msg.post_type === 'notice' && msg.notice_type === 'group_upload') {
      this.handleGroupUpload(msg).catch(() => {});
      return;
    }
    // 私聊文件（OneBot 11 私聊文件通常在 message 段 file 或 notice）
    if (msg.post_type === 'notice' && msg.notice_type === 'offline_file') {
      this.handleOfflineFile(msg).catch(() => {});
    }
  }

  private async handleMessageEvent(msg: any): Promise<void> {
    const type = msg.message_type === 'group' ? 'group' : 'private';
    const chatId = String(type === 'group' ? msg.group_id : msg.user_id);
    const userId = String(msg.user_id);
    // 已隐藏的会话：在下载之前就收口——图片/文件不进沙箱，消息也不进内核（解除隐藏后不补历史）。
    if (this.config.chatHidden(this.selfId, type, chatId)) return;
    // 拉黑的用户：同样在下载之前收口，连"忽略"的会话条目都不留 —— 当这条消息没出现过。
    if (this.isBlocked(userId)) return;
    const segments = normalizeSegments(msg.message);
    const rendered = segmentsToText(segments, this.selfId, String(msg.source?.user_id ?? ''));
    const text = rendered.text;
    const isAtMe = rendered.isAtMe;
    const isReplyToMe = rendered.isReplyToMe;

    // 语音/视频段常常只带协议端的 file id：补出 url 内核才可能把它交给模型（补不出来仍会留 [语音] 占位）。
    // 下面落盘那步也吃这个 url，所以这里补一次就够，别两处各问一遍协议端。
    for (const s of segments) {
      if (s.type !== 'record' && s.type !== 'video') continue;
      const f = String(s.data.file ?? '');
      if (s.data.url || !f || /^https?:\/\//.test(f) || existsSync(f)) continue;
      const r: any = await this.call(s.type === 'record' ? 'get_record' : 'get_file', fileIdParams(f), 5000).catch(() => null);
      const url = String(r?.url ?? '');
      if (/^https?:\/\//.test(url)) s.data.url = url;
    }

    // 消息内的图片/语音/视频：下载进沙箱 inbox（红线 §3.2），桌面端据此出缩略图与播放器
    const files = await this.pullMedia(segments, { platform: 'qq', type, chatId },
      { nodes: 0, images: 0, media: 0, dropped: 0 }, '消息');

    // 「聊天记录」合集：段里只有一个 resId，正文要再问协议端取一次才看得见（取不到不拦这条消息）
    const forward = await this.fetchForwards(segments.filter((s) => s.type === 'forward'), { platform: 'qq', type, chatId });

    const event: ChatEvent = {
      id: newId('ev_'),
      platform: 'qq',
      type,
      chatId,
      userId,
      nickname: String(msg.sender?.nickname ?? msg.sender?.card ?? ''),
      senderRole: normalizeRole(msg.sender?.role),
      segments,
      text: text.trim(),
      isAtMe, isReplyToMe,
      messageId: String(msg.message_id ?? ''),
      files: files.length ? files : undefined,
      forward: forward ?? undefined,
      raw: msg,
      ts: (msg.time ? msg.time * 1000 : nowMs()),
    };
    if (type === 'group') this.fillGroupName(chatId);
    else this.fillFriendName(userId, String(msg.sender?.nickname ?? msg.sender?.card ?? ''));
    this.onEvent(event);
  }

  /**
   * 一条消息里可能有好几个聊天记录段（群友连着转了几份），逐段取回后**并成一张卡**：
   * 节点按段顺序接起来，resId 取第一段那个，任一段取不到就整体算 failed——
   * 宁可让界面留占位，也不摆一张缺了内容的卡。
   */
  private async fetchForwards(segs: MsgSegment[], chat: ChatRef): Promise<ForwardRecord | null> {
    if (!segs.length) return null;
    // 一条消息里几个记录段共用一份预算：上限是"这条消息最多带多少内容"，不是"每段这么多"
    const budget: FwdBudget = { nodes: 0, images: 0, media: 0, dropped: 0 };
    const parts: ForwardRecord[] = [];
    for (const s of segs) parts.push(await this.fetchForward(s, chat, budget));
    if (parts.length === 1) return parts[0];
    const nodes = parts.flatMap((p) => p.nodes);
    const failed = nodes.length === 0;
    return {
      id: parts[0].id,
      title: parts.map((p) => p.title).find((t) => t) ?? '',
      nodes: failed ? [] : nodes,
      dropped: budget.dropped,
      failed,
    };
  }

  /**
   * 取「聊天记录」（合并转发）的正文节点。
   * 2026-10-15 实测有头模式下的 LLBot：入站段只有一个 `{type:'forward',data:{id:<resId>}}`，
   * 标题/预览都不给，正文必须靠 get_forward_msg 现取（NapCat 同名动作，形状一致）。
   * 取不到就算 failed：协议端不支持、超时、那份记录过期都是这条路，界面留着占位、不许编内容。
   */
  private async fetchForward(seg: MsgSegment, chat: ChatRef, budget: FwdBudget): Promise<ForwardRecord> {
    const id = forwardResId(seg);
    const title = String(seg.data.title ?? '');
    const nodes = id ? await this.fetchNodes(id, chat, 0, budget) : [];
    // 一条都没拿到就按 failed 处理：QQ 撤回过的记录也会返回个空壳，摆一张没字的卡不如留占位
    if (!nodes.length) return { id, title, nodes: [], dropped: budget.dropped, failed: true };
    return { id, title, nodes, dropped: budget.dropped, failed: false };
  }

  /**
   * 按 resId 取一层记录的节点。取不到就是空数组——上层留 [聊天记录] 占位，不许编内容。
   * 2026-10-15 实测有头模式下的 LLBot：入站段与记录里的嵌套段形状同一个
   * `{type:'forward',data:{id:<resId>}}`，所以嵌套的也能照这条路再取一层（NapCat 同名动作）。
   */
  private async fetchNodes(id: string, chat: ChatRef, depth: number, budget: FwdBudget): Promise<ForwardNode[]> {
    try {
      const r = await this.call<any>('get_forward_msg', { id }, FORWARD_TIMEOUT_MS);
      return await this.collectNodes(Array.isArray(r?.messages) ? r.messages : [], chat, depth, budget);
    } catch (e) {
      this.log.warn(`聊天记录取不回（${id.slice(0, 16)}…）: ${(e as Error).message}`);
      return [];
    }
  }

  /** 把一层记录摊平成节点列表；budget 跨整份记录共享，套娃也绕不过条数与图片上限 */
  private async collectNodes(list: any[], chat: ChatRef, depth: number, budget: FwdBudget): Promise<ForwardNode[]> {
    const out: ForwardNode[] = [];
    for (const m of list) {
      if (budget.nodes >= FORWARD_MAX_NODES) { budget.dropped++; continue; }
      budget.nodes++;
      const segs = normalizeSegments(m?.content);
      const node: ForwardNode = {
        nickname: String(m?.sender?.nickname ?? m?.sender?.card ?? ''),
        userId: String(m?.sender?.user_id ?? ''),
        text: segmentsToText(segs).text.trim().slice(0, FORWARD_MAX_NODE_CHARS),
        ts: Number(m?.time ?? 0) * 1000,
        depth,
      };
      const files = await this.pullMedia(segs, chat, budget, '聊天记录');
      if (files.length) node.files = files;
      out.push(node);
      // 记录套记录（群里递来的那份"聊天记录"本身又是几份记录）：就地往下展开，
      // 里面夹的图也照这一层落盘——不展开的话那些图就永远看不见。
      if (depth < FORWARD_MAX_DEPTH) {
        for (const s of segs) {
          if (s.type !== 'forward') continue;
          const kidId = forwardResId(s);
          if (!kidId) continue;
          const kids = await this.fetchNodes(kidId, chat, depth + 1, budget);
          if (!kids.length) continue;
          node.text = node.text.replace('[聊天记录]', `[聊天记录·已展开 ${kids.length} 条]`);
          out.push(...kids);
        }
      }
    }
    return out;
  }

  /**
   * 把记录里的图片/语音/视频落到沙箱 inbox（与顶层图片同一目录、同一 raw 端点），
   * 桌面端据此出缩略图与播放器。段里给 url/temp_url 就直接下；只给文件号就按类型补问一次
   * （get_image / get_record / get_file）换临时链接——转发进来的媒体常常不在协议端的文件缓存里，
   * 那次补问会失败，此时留着 [图片]/[语音]/[视频] 占位不硬编。
   * 视频可能几十 MB，所以每种类型各有一份条数上限与单文件体积上限。
   */
  private async pullMedia(segs: MsgSegment[], chat: ChatRef, budget: FwdBudget, where: string): Promise<IncomingFile[]> {
    const out: IncomingFile[] = [];
    for (const s of segs) {
      const kind = s.type === 'image' ? 'image' : s.type === 'record' ? 'audio' : s.type === 'video' ? 'video' : null;
      if (!kind) continue;
      const left = kind === 'image' ? FORWARD_MAX_NODE_IMAGES - budget.images : FORWARD_MAX_NODE_MEDIA - budget.media;
      if (left <= 0) continue;
      const url = await this.nodeMediaUrl(s, kind);
      if (!url) {
        // 一声不吭地跳过就没法回答"为什么这条视频没下来"：把段里给了哪些字段打出来
        const label = kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '视频';
        this.log.warn(`${where}里的${label}取不到可下载地址（段里字段：${Object.keys(s.data).join(',') || '无'}）`);
        continue;
      }
      try {
        let name = nodeName(s.data.file, kind);
        let buf = await downloadToBuffer(url, kind === 'image' ? FORWARD_MAX_IMAGE_BYTES : FORWARD_MAX_MEDIA_BYTES);
        if (kind === 'audio' && !BROWSER_AUDIO_RE.test(name)) {
          // QQ 语音是 silk：浏览器的 <audio> 解不了，本机先转 wav 再存（模型那边也直接吃这份，省一次转码）。
          // 没有 ffmpeg 就按原样存——至少人在沙箱页能用系统播放器听，别把文件弄丢。
          try {
            buf = await toWav(buf, 'audio/silk');
            name = name.replace(/\.[a-z0-9]+$/i, '') + '.wav';
          } catch (e) {
            this.log.warn(`语音转 wav 失败，按原样存（桌面端播不动）: ${(e as Error).message}`);
          }
        }
        const rel = this.sandbox.saveInbox(chat, name, buf);
        if (kind === 'image') budget.images++; else budget.media++;
        out.push({ name, rel, sandboxPath: join(this.sandbox.root(chat), rel), size: buf.length, url });
      } catch (e) {
        this.log.warn(`聊天记录里的${kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '视频'}落盘失败: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** 记录里的媒体 → 可下载的地址：段里自带 url/temp_url 最好，只给文件号就按类型补问一次 */
  private async nodeMediaUrl(seg: MsgSegment, kind: 'image' | 'audio' | 'video'): Promise<string> {
    const d = seg.data;
    const direct = String(d.url ?? d.temp_url ?? '');
    if (/^https?:\/\//.test(direct)) return direct;
    const f = String(d.file ?? d.file_id ?? d.resource_id ?? '');
    if (!f || existsSync(f)) return '';
    // 答不上来就是这条取不到，不许假装下载成功；入参键名两家不同，见 fileIdParams
    const action = kind === 'audio' ? 'get_record' : 'get_file';
    const r: any = await this.call(kind === 'image' ? 'get_image' : action, fileIdParams(f), 5000).catch(() => null);
    const url = String(r?.url ?? '');
    return /^https?:\/\//.test(url) ? url : '';
  }

  /**
   * 群文件上传通知：协议端只给文件号，得换一次临时链接再下。
   * `get_image` 的入参键名两家不一样（LLBot 要 `file`，NapCat 按 OneBot 11 要 `file_id`），
   * 所以两个键一起给——LLBot 的 zod 是 strip 模式，多出来的键会被忽略，不会报参数错误。
   */
  private async handleGroupUpload(msg: any): Promise<void> {
    const chatId = String(msg.group_id);
    const file = msg.file ?? {};
    const chat: ChatRef = { platform: 'qq', type: 'group', chatId };
    if (this.config.chatHidden(this.selfId, 'group', chatId)) return;
    if (this.isBlocked(String(msg.user_id))) return;
    try {
      let buf: Buffer | null = null;
      let name = String(file.name ?? 'file');
      if (file.url) buf = await downloadToBuffer(String(file.url));
      else if (file.id) {
        const r = await this.call('get_image', fileIdParams(file.id)).catch(() => null);
        if (r?.url) buf = await downloadToBuffer(String(r.url));
      }
      if (buf) {
        const rel = this.sandbox.saveInbox(chat, name, buf);
        this.log.info(`群文件已入沙箱 ${chatId}/${rel}`);
        this.bus.emit('adapter.file_received', { chatId, userId: String(msg.user_id), name, rel });
      }
    } catch (e) {
      this.log.warn(`群文件落盘失败: ${(e as Error).message}`);
    }
  }

  private async handleOfflineFile(msg: any): Promise<void> {
    const chatId = String(msg.user_id);
    const chat: ChatRef = { platform: 'qq', type: 'private', chatId };
    if (this.config.chatHidden(this.selfId, 'private', chatId)) return;
    if (this.isBlocked(chatId)) return;
    try {
      const file = msg.file ?? {};
      let buf: Buffer | null = null;
      let name = String(file.name ?? 'file');
      if (file.url) buf = await downloadToBuffer(String(file.url));
      else if (file.id) {
        const r = await this.call('get_image', fileIdParams(file.id)).catch(() => null);
        if (r?.url) buf = await downloadToBuffer(String(r.url));
      }
      if (buf) {
        const rel = this.sandbox.saveInbox(chat, name, buf);
        this.bus.emit('adapter.file_received', { chatId, userId: chatId, name, rel });
      }
    } catch (e) {
      this.log.warn(`私聊文件落盘失败: ${(e as Error).message}`);
    }
  }

  // ---------------- 动作调用 ----------------

  call<T = any>(action: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    const ws = this.client;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('协议端未连接'));
    const echo = `e${++this.echoSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 动作 ${action} 超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async send(chat: ChatRef, segments: MsgSegment[]): Promise<string | undefined> {
    const wire = segments.map(localizeSegment);
    if (chat.type === 'group') {
      const r = await this.call('send_group_msg', { group_id: chat.chatId, message: wire });
      return r?.message_id ? String(r.message_id) : undefined;
    }
    const r = await this.call('send_private_msg', { user_id: chat.chatId, message: wire });
    return r?.message_id ? String(r.message_id) : undefined;
  }

  /** 合并转发：LLBot 与 NapCat 都吃 `messages: [{type:'node', data:{...content}}]`；
   *  node 里的 file 段由协议端展开成文件消息（LLBot transformOutgoingSegments 支持 File）。 */
  async sendForward(chat: ChatRef, nodes: { userId?: string; nickname?: string; content: MsgSegment[] }[]): Promise<string | undefined> {
    const messages = nodes.map((n) => ({
      type: 'node',
      data: {
        user_id: n.userId ?? this.selfId,
        nickname: n.nickname ?? this.selfNickname,
        content: n.content.map(localizeSegment),
      },
    }));
    const payload: Record<string, unknown> = { message_type: chat.type, messages };
    if (chat.type === 'group') payload.group_id = chat.chatId;
    else payload.user_id = chat.chatId;
    const r = await this.call('send_forward_msg', payload);
    return r?.message_id ? String(r.message_id) : undefined;
  }

  /** 戳一戳：优先 go-cqhttp 的 send_poke；老协议端退回 group_poke / friend_poke */
  async sendPoke(chat: ChatRef, userId: string): Promise<void> {    if (chat.type === 'group') {
      try {
        await this.call('send_poke', { group_id: chat.chatId, user_id: userId });
      } catch {
        await this.call('group_poke', { group_id: chat.chatId, user_id: userId });
      }
      return;
    }
    try {
      await this.call('send_poke', { user_id: chat.chatId });
    } catch {
      await this.call('friend_poke', { user_id: chat.chatId });
    }
  }

  /**
   * 贴表情（在别人的消息下面挂一个 QQ 表情回应）：LLBot 的 `set_msg_emoji_like`。
   *
   * emoji_id 传 **face 编号**（如 14=微笑、76=赞）。LLBot 底层按 code 长度推断类型
   * （≤3 位当 face，更长当 unicode emoji），经典表情最多 3 位，正好落 face 档。
   *
   * 群聊与私聊都发同一个 action：NapCat 的实现按 peer 直发（私聊可用），
   * LLBot 的实现**显式判群**（私聊一律报「只支持群聊消息」）。后者不猜、直接发一次，
   * 失败过就记住，后续私聊立刻拒绝，不再白跑。
   */
  async sendReaction(chat: ChatRef, messageId: string, emojiId: string): Promise<void> {
    if (chat.type === 'private' && this.privateReactionUnsupported) {
      throw new Error('当前协议端不支持私聊消息的表情回应（LLBot 只实现了群聊贴表情）');
    }
    try {
      await this.call('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId, set: true });
    } catch (e) {
      const msg = (e as Error).message || '';
      if (chat.type === 'private' && /只支持群聊|不支持私聊/.test(msg)) {
        this.privateReactionUnsupported = true;
        throw new Error('当前协议端不支持私聊消息的表情回应（LLBot 只实现了群聊贴表情）');
      }
      throw e;
    }
  }

  async sendFile(chat: ChatRef, absPath: string): Promise<string | undefined> {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) throw new Error('文件不存在');
    const uri = pathToFileURL(absPath).href;
    const name = absPath.split(/[\\/]/).pop() ?? 'file';
    if (chat.type === 'group') {
      return await this.call('upload_group_file', { group_id: chat.chatId, file: uri, name });
    }
    return await this.call('upload_private_file', { user_id: chat.chatId, file: uri, name });
  }

  /** TransportAdapter 契约要求公开（kernel/UI 据此判断协议端是否在线） */
  connected(): boolean {
    return !!this.client && this.client.readyState === 1;
  }

  /**
   * 账号守卫：协议端登录号必须与预期 bot 账号一致，否则一律停止代发。
   *
   * 为什么必须有：有头模式（PMHQ）下协议端寄生在本机 QQ 客户端上，**客户端登着谁，bot 就顶着谁**。
   * 万一 QQ 那边登的是使用者自己的号，而没有这层守卫，内核会照常回帖 —— 等于拿你自己的号去发言。
   * ui.expectedQq 为空时不设限（无头模式默认行为：扫谁的码就是谁）。
   */
  private checkAccount(): void {
    const expected = String(this.config.config.ui.expectedQq || '').trim();
    if (!expected || !this.selfId) return;
    if (this.selfId === expected) {
      if (this.accountBlocked) {
        this.accountBlocked = null;
        this.log.info(`协议端登录号已回到预期账号 ${expected}，恢复代发`);
        this.errors.record('info', 'adapter', `协议端登录号已回到预期账号 ${expected}，恢复代发`);
      }
      return;
    }
    if (this.accountBlocked?.got === this.selfId) return;
    this.accountBlocked = { got: this.selfId, expected };
    const msg =
      `协议端登录的是 ${this.selfId}，而预期 bot 账号是 ${expected}：已停止代发（有头模式下这可能是你本机 QQ 正在登录的其它账号）。` +
      `请在本机 QQ 里换成 ${expected} 登录；若确实要改用 ${this.selfId}，把 data/config.json 的 ui.expectedQq 改成它。`;
    this.log.error(msg);
    this.errors.record('warn', 'adapter', msg);
  }

  /** 停止反向 WS 服务端（优雅关闭用） */
  stop(): Promise<void> {
    if (this.nameTimer) { clearInterval(this.nameTimer); this.nameTimer = undefined; }
    return new Promise((resolveP) => {
      try {
        this.client?.close(1001, 'kernel shutdown');
      } catch { /* ignore */ }
      this.client = undefined;
      if (!this.wss) return resolveP();
      this.wss.close(() => resolveP());
      this.wss = undefined;
    });
  }

  status(): Record<string, unknown> {
    return {
      protocol: 'onebot11',
      mode: 'reverse_ws_server',
      endpoint: `ws://${this.config.config.onebot.host}:${this.config.config.onebot.port}${this.config.config.onebot.reverseWsPath}`,
      connected: this.connected(),
      selfId: this.selfId,
      selfNickname: this.selfNickname,
      connectedAt: this.connectedAt || undefined,
      lastHeartbeat: this.lastHeartbeat || undefined,
      expectedQq: String(this.config.config.ui.expectedQq || ''),
      /** 登录号与预期 bot 账号不符（有头模式下尤其危险：可能顶着你自己的号发言）→ 已停发 */
      accountBlocked: this.accountBlocked || undefined,
    };
  }

  /**
   * 尽力拉取协议端登录二维码（登录页用）。
   * OneBot 11 标准没有取码接口；这里尝试协议端可能实现的扩展动作（get_qrcode 等），
   * 成功返回 base64/URL，失败返回 null，前端回退为等待协议端登录状态。
   * 动作超时 3s：不支持的动作快速失败，前端不用干等。
   */
  async tryFetchQrcode(): Promise<{ image: string } | null> {
    if (!this.connected()) return null;
    for (const action of ['web_login_get_qrcode', 'get_qrcode', 'qrcode_get', 'get_login_qrcode']) {
      try {
        const r = await this.call<any>(action, {}, 3000);
        const image = r?.image ?? r?.qrcode ?? r?.base64 ?? (typeof r === 'string' ? r : '');
        if (image) return { image: String(image) };
      } catch { /* 下一个 */ }
    }
    return null;
  }

  /** 群名/好友昵称（pipeline 与会话页标题展示用）； strangers 拿不到就回落空串 */
  async refreshGroupNames(): Promise<void> {
    try {
      const list = await this.call<any[]>('get_group_list', {});
      // 空值不覆盖：协议端偶尔给空群名，别把已经拿到的真名字冲掉
      for (const g of list ?? []) {
        const id = String(g.group_id), name = String(g.group_name ?? '');
        if (name) this.groupNames.set(id, name);
      }
    } catch { /* ignore */ }
    try {
      const friends = await this.call<any[]>('get_friend_list', {});
      for (const f of friends ?? []) {
        const id = String(f.user_id), name = String(f.nickname || f.remark || '');
        if (name) this.friendNames.set(id, name);
      }
    } catch { /* ignore */ }
  }

  /** 桌面端权限名单：群列表与群成员。协议端没连时 call 会直接拒绝，交由 UI 就地报红。 */
  async listGroups(): Promise<{ groupId: string; name: string; memberCount: number }[]> {
    const list = await this.call<any[]>('get_group_list', {});
    return (list ?? [])
      .map((g) => ({
        groupId: String(g.group_id ?? ''),
        name: String(g.group_name ?? ''),
        memberCount: Number(g.member_count ?? 0),
      }))
      .filter((g) => g.groupId);
  }

  async listGroupMembers(groupId: string): Promise<{ userId: string; nickname: string; card?: string; role?: string }[]> {
    const list = await this.call<any[]>('get_group_member_list', { group_id: groupId });
    return (list ?? [])
      .map((m) => ({
        userId: String(m.user_id ?? ''),
        nickname: String(m.nickname ?? ''),
        card: m.card ? String(m.card) : undefined,
        role: m.role ? String(m.role) : undefined,
      }))
      .filter((m) => m.userId);
  }

  /** 群里来消息时把群名补齐：全量列表可能还没拉到（或压根没这个群），按需问一次 get_group_info。
   *  注意这里只能缓存"群自己的名字"——曾把 msg.sender.card（群名片）当群名塞进缓存，
   *  于是任何群名片非空的群友一发消息，侧边栏和 prompt 里的群名就变成那个人的名字。 */
  private fillGroupName(chatId: string): void {
    if (!chatId || this.groupNames.get(chatId)) return;
    const triedAt = this.groupNameTried.get(chatId) ?? 0;
    if (nowMs() - triedAt < NAME_RETRY_MS) return;   // 拉不到就别每条消息都问一次
    this.groupNameTried.set(chatId, nowMs());
    this.call<any>('get_group_info', { group_id: chatId })
      .then((r) => {
        const name = String(r?.group_name ?? r?.name ?? '');
        if (name) this.groupNames.set(chatId, name);
      })
      .catch(() => { /* 协议端不支持就算了，5 分钟一轮的 refreshGroupNames 兜底 */ });
  }

  /** 私聊同理：好友列表里没有（陌生人、或列表还没拉到）就用发言者昵称补上，不覆盖已有值 */
  private fillFriendName(userId: string, senderName: string): void {
    if (userId && senderName && !this.friendNames.get(userId)) this.friendNames.set(userId, senderName);
  }

  groupName(chatId: string): string {
    return this.groupNames.get(chatId) ?? '';
  }

  /** 会话标题：群聊→群名；私聊→好友昵称（无好友关系则空） */
  chatTitle(chatType: string, chatId: string): string {
    return chatType === 'group' ? this.groupNames.get(chatId) ?? '' : this.friendNames.get(chatId) ?? '';
  }
}

/** 一份聊天记录的共享预算：条数、图片数、被上限切掉多少（套娃也不能各层单独算） */
interface FwdBudget { nodes: number; images: number; media: number; dropped: number }

/** 浏览器 <audio> 能直接解的容器；其余（silk/amr）先转 wav 再存 */
const BROWSER_AUDIO_RE = /\.(mp3|wav|ogg|opus|m4a|aac|flac)$/i;

/** 落盘文件名：段里带了原名就用它（保住扩展名，raw 端点据此给 MIME），否则按类型编一个 */
function nodeName(dataFile: unknown, kind: 'image' | 'audio' | 'video'): string {
  const given = String(dataFile ?? '').trim();
  if (given && /\.[a-z0-9]{2,5}$/i.test(given)) return given;
  const ext = kind === 'audio' ? '.silk' : kind === 'video' ? '.mp4' : '.jpg';
  return (kind === 'audio' ? 'voice_' : kind === 'video' ? 'video_' : 'img_') + newId('') + ext;
}

/** 合并转发段的 resId：实测有头模式只给 id，其余键名是别家/别条序列化路径的形状 */
function forwardResId(seg: MsgSegment): string {
  return String(seg.data.id ?? seg.data.forward_id ?? seg.data.resId ?? seg.data.resid ?? '');
}

/**
 * `get_image` 的入参键名两家不一样：LLBot 的 schema 要 `file`（号或文件名都认），
 * NapCat 按 OneBot 11 要 `file_id`。只给一个，另一家就 retcode 1400 参数错——
 * 所以两个键一起给：LLBot 的 zod 是 strip 模式，多出来的那个会被安静忽略。
 */
function fileIdParams(id: unknown): Record<string, unknown> {
  const s = String(id);
  return { file: s, file_id: s };
}

/**
 * 消息段 → 一行文本：@、引用、媒体、聊天记录都落成占位（桌面端有真内容时再把字样剥掉）。
 * 入站正文与聊天记录里的每条节点共用这一套口径，两处不会各写一份走偏。
 */
function segmentsToText(segments: MsgSegment[], selfId = '', replyFallbackUserId = ''): { text: string; isAtMe: boolean; isReplyToMe: boolean } {
  let text = '', isAtMe = false, isReplyToMe = false;
  for (const s of segments) {
    if (s.type === 'text') text += String(s.data.text ?? '');
    else if (s.type === 'at') {
      const qq = String(s.data.qq ?? '');
      if (qq === selfId) isAtMe = true;
      else if (qq === 'all') { /* @全体成员不算唤醒 */ }
      text += ` @${qq}`;
    } else if (s.type === 'reply') {
      text += ` [回复:${s.data.id ?? ''}]`;
      // 协议端一般会在 reply 段后带实际被回复者信息；尽力判断是否回复 bot
      const replyUserId = String(s.data.user_id ?? replyFallbackUserId);
      if (replyUserId && replyUserId === selfId) isReplyToMe = true;
    } else if (s.type === 'image') text += ' [图片]';
    else if (s.type === 'record') text += ' [语音]';
    else if (s.type === 'video') text += ' [视频]';
    else if (s.type === 'file') text += ` [文件:${String(s.data.name ?? '').trim() || '未命名'}]`;
    else if (s.type === 'face') text += `[表情:${s.data.id ?? ''}]`;
    else if (s.type === 'forward') text += ' [聊天记录]';
  }
  return { text, isAtMe, isReplyToMe };
}

function normalizeRole(role: unknown): ChatEvent['senderRole'] {
  if (role === 'owner' || role === 'admin') return role;
  if (role === 'member') return 'member';
  return 'unknown';
}

function normalizeSegments(message: any): MsgSegment[] {
  if (typeof message === 'string') {
    // CQ 码兜底解析（简单场景）
    return [{ type: 'text', data: { text: message } }];
  }
  if (!Array.isArray(message)) return [];
  const out: MsgSegment[] = [];
  for (const s of message) {
    if (typeof s === 'string') { out.push({ type: 'text', data: { text: s } }); continue; }
    const type = String(s.type ?? 'text');
    out.push({ type: type as MsgSegment['type'], data: s.data ?? {} });
  }
  return out;
}

/** 本地文件路径 → file:// URI（OneBot 图片/文件上传） */
function localizeSegment(s: MsgSegment): MsgSegment {
  if (s.type === 'image' && typeof s.data.file === 'string' && !s.data.file.startsWith('file://') && !s.data.file.startsWith('http')) {
    if (existsSync(s.data.file)) {
      return { ...s, data: { ...s.data, file: pathToFileURL(s.data.file).href } };
    }
  }
  return s;
}

/** 取回字节，超过 maxBytes 就放弃：QQ 视频动辄几十 MB，不能由着一条转发把磁盘吃掉 */
async function downloadToBuffer(url: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const declared = Number(resp.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`文件过大（${declared} > ${maxBytes} 字节），不下载`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`文件过大（${buf.length} > ${maxBytes} 字节），已丢弃`);
  return buf;
}
