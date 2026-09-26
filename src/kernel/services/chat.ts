import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { ChatRef, ChatSendService, MsgSegment } from '../types.ts';
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
 * 发送服务：分段、限速、随机抖动（红线 §3.3 风控克制）、会话日志与 UI 事件。
 * 文件发送强校验：仅允许当前会话沙箱内路径（红线 §3.2）。
 */
export class ChatService implements ChatSendService {
  private limiter: RateLimiter;
  private adapter?: TransportAdapter;
  /** 出站消息字节数上限（超过自动分段） */
  maxSegmentChars = 1800;

  constructor(
    private bus: Bus,
    private opts: {
      ratePerMin: number;
      jitterMinMs: number;
      jitterMaxMs: number;
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

  async send(chat: ChatRef, segments: MsgSegment[]): Promise<void> {
    // 风控：限速（超限丢弃并记录，避免刷屏）
    const rl = this.limiter.tryTake(`${chat.platform}:${chat.type}:${chat.chatId}`);
    if (!rl.ok) {
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'error', role: 'system', text: `发送被限速丢弃（等待 ${rl.waitMs}ms 超过上限），内容: ${summarize(segments)}`,
      });
      return;
    }
    // 风控：随机抖动
    const jitter = RateLimiter.jitterDelay(this.opts.jitterMinMs, this.opts.jitterMaxMs);
    await jitter;
    // 桌面端注入的会话（platform=ui）：无外部协议端，仅落日志与事件流
    if (chat.platform === 'ui') {
      this.opts.onUsage('out');
      this.opts.sessionLog.append(chat.chatId, chat.type, {
        type: 'message_out', role: 'assistant', text: textOf(segments),
        data: { segments: segments.length ? segments : undefined, simulated: true },
      });
      this.bus.emit(busEvents.chatOut, { chat, segments, text: textOf(segments), ts: Date.now(), simulated: true });
      return;
    }
    if (!this.adapter?.connected()) {
      this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: '协议端未连接，消息未能发出' });
      throw new Error('协议端未连接');
    }
    // 分段发送
    for (const part of splitSegments(segments, this.maxSegmentChars)) {
      try {
        await this.adapter.send(chat, part);
      } catch (e) {
        this.opts.sessionLog.append(chat.chatId, chat.type, { type: 'error', role: 'system', text: `发送失败: ${(e as Error).message}` });
        throw e;
      }
    }
    this.opts.onUsage('out');
    this.opts.sessionLog.append(chat.chatId, chat.type, {
      type: 'message_out', role: 'assistant', text: textOf(segments),
      data: { segments: segments.length ? segments : undefined },
    });
    this.bus.emit(busEvents.chatOut, { chat, segments, text: textOf(segments), ts: Date.now() });
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

function textOf(segments: MsgSegment[]): string {
  return segments.map((s) => (s.type === 'text' ? String(s.data.text ?? '') : s.type === 'image' ? '[图片]' : s.type === 'at' ? `@${s.data.qq ?? ''}` : `[${s.type}]`)).join('');
}

function summarize(segments: MsgSegment[]): string {
  return truncateStr(textOf(segments), 80);
}

function truncateStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把文本段按长度切成多条，其余段保持独立 */
export function splitSegments(segments: MsgSegment[], maxChars: number): MsgSegment[][] {
  const out: MsgSegment[][] = [];
  let cur: MsgSegment[] = [];
  let curLen = 0;
  for (const seg of segments) {
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
