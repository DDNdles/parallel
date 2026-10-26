import WebSocket from 'ws';

/** waitForReply 判定"这条回复说完了"的静默窗口 */
const QUIET_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  /** 一律回 failed 的动作（测"协议端不支持这个动作"） */
  private fails = new Map<string, string>();
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
          const failMsg = this.fails.get(msg.action);
          if (failMsg !== undefined) {
            ws.send(JSON.stringify({ status: 'failed', retcode: 1400, message: failMsg, echo: msg.echo }));
            return;
          }
          const raw = this.replies.get(msg.action) ?? this.defaultReply(msg.action, msg.params);
          // 回包可以是按 params 现算的函数：测"同一种动作、按不同入参回不同内容"（比如一条消息里几个 resId）
          const data2 = typeof raw === 'function' ? (raw as (p: any) => unknown)(msg.params) : raw;
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
    // 发文件（deliver_file / send_file）：协议端回一个文件 id；测试靠 actions 里的记录断言
    if (action === 'upload_group_file' || action === 'upload_private_file') return { file_id: 'mock-file' };
    return {};
  }

  /** 指定某动作的回包（覆盖默认）：测"段里只有一个 id、正文要再问一次"这类协议端往返 */
  setReply(action: string, data: unknown): void { this.replies.set(action, data); }

  /** 让某动作一律回 failed（传 false 撤销；message 自定义报错文案）：测协议端不支持这个动作时内核怎么走 */
  failAction(action: string, on = true, message = '不支持的动作（测试设定）'): void {
    if (on) this.fails.set(action, message); else this.fails.delete(action);
  }

  /** 注入群消息事件 */
  sendGroupMessage(opts: {
    groupId: number; userId: number; text: string; nickname?: string; role?: string;
    atMe?: boolean; messageId?: number;
    /** 文本段之前再塞几个段（测引用/合拍这类"段里带信息"的消息形状） */
    extraSegments?: any[];
  }): void {
    const segments: any[] = [];
    if (opts.atMe) segments.push({ type: 'at', data: { qq: this.selfId } });
    segments.push(...(opts.extraSegments ?? []));
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

  /**
   * 等待指定群的文本回复（from = 只看该下标之后的动作，避免匹配到旧回复）。
   *
   * 拟人层会把一条回复**拆成多条短消息**分批发出，所以这里等"安静下来"再把所有分片
   * 拼起来返回 —— 断言写在拼接结果上，就不受"这条会不会被拆、拆成几段"影响。
   */
  async waitForReply(groupId: number, timeoutMs = 8000, from = 0): Promise<string> {
    const parts = () => this.actions
      .slice(from)
      .filter((a) => a.action === 'send_group_msg' && String(a.params.group_id) === String(groupId));
    const textOf = (a: { params: any }) => (a.params.message ?? [])
      .filter((s: any) => s.type === 'text')
      .map((s: any) => s.data.text)
      .join('');

    const start = Date.now();
    while (Date.now() - start < timeoutMs && !parts().length) await sleep(50);
    if (!parts().length) throw new Error(`等待群 ${groupId} 回复超时`);

    // 等分片发完：连续 QUIET_MS 没有新分片就算说完
    let seen = parts().length;
    let quietSince = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(50);
      const n = parts().length;
      if (n !== seen) { seen = n; quietSince = Date.now(); continue; }
      if (Date.now() - quietSince >= QUIET_MS) break;
    }
    return parts().map(textOf).join('');
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.connected = false;
  }
}
