import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync, existsSync } from 'node:fs';
import type { ChatEvent, MsgSegment, ChatRef } from '../types.ts';
import type { TransportAdapter } from '../services/chat.ts';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { SandboxService } from '../services/sandbox.ts';
import type { Logger } from '../types.ts';
import { newId, nowMs } from '../util/misc.ts';

/** 群名按需拉取失败后的重试间隔（与全量刷新的 5 分钟一拍） */
const NAME_RETRY_MS = 5 * 60_000;

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
  log: Logger;

  constructor(
    private config: ConfigStore,
    private errors: ErrorCenter,
    private bus: Bus,
    private sandbox: SandboxService,
    private onEvent: (e: ChatEvent) => void,
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
    const segments = normalizeSegments(msg.message);
    let text = '';
    let isAtMe = false;
    let isReplyToMe = false;
    for (const s of segments) {
      if (s.type === 'text') text += String(s.data.text ?? '');
      else if (s.type === 'at') {
        const qq = String(s.data.qq ?? '');
        if (qq === this.selfId) isAtMe = true;
        else if (qq === 'all') { /* @全体成员不算唤醒 */ }
        text += ` @${qq}`;
      } else if (s.type === 'reply') {
        text += ` [回复:${s.data.id ?? ''}]`;
        // 协议端一般会在 reply 段后带实际被回复者信息；尽力判断是否回复 bot
        const replyUserId = String(s.data.user_id ?? msg.source?.user_id ?? '');
        if (replyUserId && replyUserId === this.selfId) isReplyToMe = true;
      } else if (s.type === 'image') text += ' [图片]';
      else if (s.type === 'record') text += ' [语音]';
      else if (s.type === 'video') text += ' [视频]';
      else if (s.type === 'file') text += ` [文件:${String(s.data.name ?? '').trim() || '未命名'}]`;
      else if (s.type === 'face') text += `[表情:${s.data.id ?? ''}]`;
    }

    // 语音/视频段常常只带协议端的 file id：补出 url 内核才可能把它交给模型（补不出来仍会留 [语音] 占位）
    for (const s of segments) {
      if (s.type !== 'record' && s.type !== 'video') continue;
      const f = String(s.data.file ?? '');
      if (s.data.url || !f || /^https?:\/\//.test(f) || existsSync(f)) continue;
      const r: any = await this.call(s.type === 'record' ? 'get_record' : 'get_file', { file: f }, 5000).catch(() => null);
      const url = String(r?.url ?? '');
      if (/^https?:\/\//.test(url)) s.data.url = url;
    }

    // 消息内的图片：下载进沙箱 inbox（红线 §3.2）
    const files: ChatEvent['files'] = [];
    for (const s of segments) {
      if (s.type === 'image' && s.data.url) {
        try {
          const name = String(s.data.file ?? newId('img_') + '.jpg');
          const buf = await downloadToBuffer(String(s.data.url));
          const rel = this.sandbox.saveInbox({ platform: 'qq', type, chatId }, name, buf);
          const abs = join(this.sandbox.root({ platform: 'qq', type, chatId }), rel);
          files.push({ name, sandboxPath: abs, size: buf.length });
        } catch (e) {
          this.log.warn(`图片落盘失败: ${(e as Error).message}`);
        }
      }
    }

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
      raw: msg,
      ts: (msg.time ? msg.time * 1000 : nowMs()),
    };
    if (type === 'group') this.fillGroupName(chatId);
    else this.fillFriendName(userId, String(msg.sender?.nickname ?? msg.sender?.card ?? ''));
    this.onEvent(event);
  }

  private async handleGroupUpload(msg: any): Promise<void> {
    const chatId = String(msg.group_id);
    const file = msg.file ?? {};
    const chat: ChatRef = { platform: 'qq', type: 'group', chatId };
    try {
      let buf: Buffer | null = null;
      let name = String(file.name ?? 'file');
      if (file.url) buf = await downloadToBuffer(String(file.url));
      else if (file.id) {
        const r = await this.call('get_image', { file_id: file.id }).catch(() => null);
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
    try {
      const file = msg.file ?? {};
      let buf: Buffer | null = null;
      let name = String(file.name ?? 'file');
      if (file.url) buf = await downloadToBuffer(String(file.url));
      else if (file.id) {
        const r = await this.call('get_image', { file_id: file.id }).catch(() => null);
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

  async sendFile(chat: ChatRef, absPath: string): Promise<string | undefined> {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) throw new Error('文件不存在');
    const uri = pathToFileURL(absPath).href;
    const name = absPath.split(/[\\/]/).pop() ?? 'file';
    if (chat.type === 'group') {
      return await this.call('upload_group_file', { group_id: chat.chatId, file: uri, name });
    }
    return await this.call('upload_private_file', { user_id: chat.chatId, file: uri, name });
  }

  private connected(): boolean {
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

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}
