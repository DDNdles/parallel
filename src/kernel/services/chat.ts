import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { ChatRef, ChatSendService, MsgSegment } from '../types.ts';
import type { SendPlan } from '../humanlike/index.ts';
import { RateLimiter } from '../ratelimit.ts';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep, normalize } from 'node:path';

export interface TransportAdapter {
  /** 发送消息段到指定会话；返回平台消息 id（可为空） */
  send(chat: ChatRef, segments: MsgSegment[]): Promise<string | undefined>;
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

  constructor(
    private bus: Bus,
    private opts: {
      ratePerMin: number;
      sandboxRoot: (chat: ChatRef) => string;
      sessionLog: { append(chatId: string, chatType: string, entry: any): any };
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
    await this.sendPlanned(chat, [{ segments, pauseMs: 0 }]);
  }

  /**
   * 按拟人层给的计划逐条发送。
   * - 限速**按条计费**（`plans.length` 个令牌），配额不够就截断成前几条，而不是整批丢弃
   * - `pauseMs` 是这条发出前的停顿（模拟"正在输入"）——**回复前的等待只有这一个来源**
   *   （拟人化 `outgoing` / `merge`），风控不再另设随机抖动，两处叠加会把节奏调不准
   */
  async sendPlanned(chat: ChatRef, plans: SendPlan[]): Promise<{ sent: number; ids: string[] }> {
    if (!plans.length) return { sent: 0, ids: [] };

    // 风控：限速。一轮回复拆成几条就该吃几个令牌 —— 否则 12 条/分钟能变成 70+ 条/分钟。
    const rl = this.limiter.tryTake(`${chat.platform}:${chat.type}:${chat.chatId}`, plans.length);
    let queue = plans;
    if (rl.granted <= 0) {
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'gate', role: 'system',
        text: `发送被限速丢弃（等待 ${rl.waitMs}ms 超过上限），内容: ${summarize(plans.flatMap((p) => p.segments))}`,
        data: { decision: 'rate_limited', waitMs: rl.waitMs, dropped: plans.length },
      });
      return { sent: 0, ids: [] };
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

    for (const plan of queue) {
      if (plan.pauseMs > 0) await sleep(plan.pauseMs);
      // 条与条之间的硬长度兜底（平台单条上限）；拟人层已按分隔标记切过，这里基本不会触发
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
          continue;
        }
        if (!this.adapter?.connected()) {
          this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: '协议端未连接，消息未能发出' });
          if (!ids.length) throw new Error('协议端未连接');
          return { sent: ids.length, ids };
        }
        try {
          const id = await this.adapter.send(chat, segments);
          if (id) ids.push(id);
        } catch (e) {
          this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: `发送失败: ${(e as Error).message}` });
          if (!ids.length) throw e;
          return { sent: ids.length, ids };   // 已经发出去几条就不再抛，免得用户看到"整条失败"
        }
        this.opts.onUsage('out');
        this.opts.sessionLog.append(chat.chatId, chat.type, {
          type: 'message_out', role: 'assistant', text: textOf(segments),
          data: { segments, part: ids.length, parts: queue.length },
        });
        this.bus.emit(busEvents.chatOut, { chat, segments, text: textOf(segments), ts: Date.now() });
      }
    }
    return { sent: ids.length, ids };
  }

  async sendText(chat: ChatRef, text: string): Promise<void> {
    await this.send(chat, [{ type: 'text', data: { text } }]);
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

  async reply(event: { chatId: string; type: 'group' | 'private'; platform: string }, text: string): Promise<void> {
    await this.sendText({ platform: event.platform, type: event.type, chatId: event.chatId }, text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

function textOf(segments: MsgSegment[]): string {
  return segments.map((s) => (s.type === 'text' ? String(s.data.text ?? '') : s.type === 'image' ? '[图片]' : s.type === 'at' ? `@${s.data.qq ?? ''}` : s.type === 'reply' ? '' : `[${s.type}]`)).join('');
}

function summarize(segments: MsgSegment[]): string {
  return truncateStr(textOf(segments), 80);
}

function truncateStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把文本段按长度切成多条，其余段保持独立（平台单条上限的硬兜底）。
 *  `reply` 段例外：它是**下一条正文的引用块**，必须和正文在同一个消息里（拆开就是一条空引用 +
 *  一条无引用的正文）——挂进当前消息、跟着后面的文本走。 */
export function splitSegments(segments: MsgSegment[], maxChars: number): MsgSegment[][] {
  const out: MsgSegment[][] = [];
  let cur: MsgSegment[] = [];
  let curLen = 0;
  for (const seg of segments) {
    if (seg.type === 'reply') { cur.push(seg); continue; }
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
