import WebSocket from 'ws';

/**
 * 模拟 OneBot 11 协议端（协议端替身）：
 * 作为反向 WS 客户端连到内核适配器；可注入事件、捕获内核下发的动作调用。
 * 不插真 QQ 号即可验证主流程（红线 §3.6）。
 */
export class MockOneBot {
  ws?: WebSocket;
  /** 内核下发的动作调用 */
  actions: { action: string; params: any; echo?: string }[] = [];
  private replies = new Map<string, unknown>();
  connected = false;

  constructor(
    readonly url: string,
    readonly accessToken: string,
    readonly selfId = '3344',
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.accessToken}` },
      });
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('connect timeout')); }
      }, 5000);
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.ws = ws;
        resolve();
      };
      ws.on('open', ok);
      ws.on('close', () => {
        this.connected = false;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`连接被协议端关闭 code=`));
      });
      ws.on('error', (e) => {
        this.connected = false;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.echo) {
          this.actions.push({ action: msg.action, params: msg.params, echo: msg.echo });
          const data2 = this.replies.get(msg.action) ?? this.defaultReply(msg.action, msg.params);
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: data2, echo: msg.echo }));
        }
      });
    });
  }

  /** 动作默认回包 */
  private defaultReply(action: string, params?: any): unknown {
    if (action === 'get_login_info') return { user_id: Number(this.selfId), nickname: 'parallel-test' };
    if (action === 'get_group_list') return [{ group_id: 123, group_name: '测试群' }];
    if (action === 'get_group_info') return { group_id: Number(params?.group_id ?? 0), group_name: '按需群名' };
    if (action === 'get_friend_list') return [];
    if (action === 'send_group_msg' || action === 'send_private_msg') return { message_id: Math.floor(Math.random() * 100000) };
    return {};
  }

  /** 注入群消息事件 */
  sendGroupMessage(opts: {
    groupId: number; userId: number; text: string; nickname?: string; role?: string;
    atMe?: boolean; messageId?: number;
  }): void {
    const segments: any[] = [];
    if (opts.atMe) segments.push({ type: 'at', data: { qq: this.selfId } });
    segments.push({ type: 'text', data: { text: opts.text } });
    this.ws!.send(JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      time: Math.floor(Date.now() / 1000),
      self_id: Number(this.selfId),
      group_id: opts.groupId,
      user_id: opts.userId,
      message_id: opts.messageId ?? Math.floor(Math.random() * 100000),
      sender: { nickname: opts.nickname ?? 'tester', card: opts.nickname ?? 'tester', role: opts.role ?? 'member' },
      message: segments,
    }));
  }

  sendPrivateMessage(opts: { userId: number; text: string; nickname?: string }): void {
    this.ws!.send(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      time: Math.floor(Date.now() / 1000),
      self_id: Number(this.selfId),
      user_id: opts.userId,
      message_id: Math.floor(Math.random() * 100000),
      sender: { nickname: opts.nickname ?? 'tester' },
      message: [{ type: 'text', data: { text: opts.text } }],
    }));
  }

  /** 等待某个动作出现（轮询；from = 只看该下标之后的动作） */
  async waitForAction(action: string, timeoutMs = 8000, from = 0): Promise<{ action: string; params: any }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.actions.slice(from).find((a) => a.action === action);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待动作 ${action} 超时（已收动作: ${this.actions.map((a) => a.action).join(',')}）`);
  }

  /** 等待指定群的文本回复（from = 只看该下标之后的动作，避免匹配到旧回复） */
  async waitForReply(groupId: number, timeoutMs = 8000, from = 0): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.actions.slice(from).find((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(groupId));
      if (found) {
        const text = (found.params.message ?? [])
          .filter((s: any) => s.type === 'text')
          .map((s: any) => s.data.text)
          .join('');
        return text;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待群 ${groupId} 回复超时`);
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.connected = false;
  }
}
