import { join } from 'node:path';
import { appendFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { ensureDir } from './util/fsutil.ts';
import { newId, nowMs } from './util/misc.ts';
import { inboundModelText } from './util/modeltext.ts';
import type { ChatEvent, ForwardRecord } from './types.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';

export type SessionLogType =
  | 'message_in' | 'message_out' | 'command' | 'command_result'
  | 'agent_start' | 'agent_end' | 'llm_call' | 'llm_delta' | 'tool_call' | 'tool_result'
  | 'error' | 'system'
  /** 上下文压缩：这条之前的消息在后续请求里由 summary 代替（对齐 pi 的 compaction 条目） */
  | 'compaction'
  /** 拟人层决策：这一轮为什么开口 / 为什么沉默（含必要性打分与空窗补偿明细） */
  | 'gate';

export interface SessionLogEntry {
  id: string;
  /**
   * 上一条的 id（同一会话内构成一条"对话树"）。
   * pi 的会话是**带 parentId 的条目树**，其压缩要靠 `firstKeptEntryId` 指回具体条目；
   * parallel 目前只有一条活动分支（不做 fork/回溯），所以链就是树。
   * 有了这个字段，压缩才能表达"这段历史被摘要替换、从哪一条起继续保留"。
   */
  parentId?: string | null;
  ts: number;
  chatId: string;
  chatType: string;
  type: SessionLogType;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  userId?: string;
  nickname?: string;
  text?: string;
  data?: unknown;
  seq?: number;
  pending?: boolean;   // 流式中的 assistant 消息（UI 合并用）
  /** compaction 条目专用：摘要正文 */
  summary?: string;
  /** compaction 条目专用：保留段从哪条开始（null = 只保留摘要） */
  firstKeptEntryId?: string | null;
  /** compaction 条目专用：压缩前的估算 token */
  tokensBefore?: number;
}

/**
 * 追加式会话日志（dsh 式可回放）：data/sessions/<chatKey>.jsonl。
 * 同时维护内存尾缓冲供 UI 快速打开，出站/工具调用全程留痕。
 */
/** 日轨上的一格：本地某一天，以及那天有几条可看的消息 */
export interface ChatDay { day: string; count: number; firstTs: number; lastTs: number }

/** 本地日期键（YYYY-MM-DD）：按使用者所在时区切天——跨零点连聊时按 UTC 会错一天 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 只有真正显示在会话流里的行才算进日轨 */
const DAY_COUNTED = new Set(['message_in', 'message_out']);

export class SessionLog {
  private buffers = new Map<string, SessionLogEntry[]>();
  /** 每个会话当前的活动叶子（下一条的 parentId）。磁盘是严格追加的，所以重启后从最后一行接上。 */
  private leafs = new Map<string, string>();
  /** days() 的结果缓存：文件 mtime+size 不变就不重扫 */
  private dayIndex = new Map<string, { mtime: number; size: number; days: ChatDay[] }>();
  private seq = 0;
  readonly dir: string;
  private tailSize = 300;

  constructor(dataDir: string, private bus: Bus) {
    this.dir = join(dataDir, 'sessions');
    ensureDir(this.dir);
  }

  chatKey(chatId: string, chatType: string): string {
    return `${chatType}_${chatId}`;
  }

  append(chatId: string, chatType: string, entry: Omit<SessionLogEntry, 'id' | 'ts' | 'chatId' | 'chatType' | 'seq'>): SessionLogEntry {
    const full: SessionLogEntry = {
      id: newId('s_'),
      ts: nowMs(),
      chatId, chatType,
      seq: ++this.seq,
      ...entry,
    };
    const key = this.chatKey(chatId, chatType);
    // 接上活动叶子：调用方给了 parentId 就用它（显式分叉），否则接上一条
    if (entry.parentId === undefined) full.parentId = this.leafs.get(key) ?? null;
    this.leafs.set(key, full.id);
    let buf = this.buffers.get(key);
    if (!buf) { buf = []; this.buffers.set(key, buf); }
    buf.push(full);
    if (buf.length > this.tailSize) buf.splice(0, buf.length - this.tailSize);
    try {
      appendFileSync(join(this.dir, key + '.jsonl'), JSON.stringify(full) + '\n', 'utf-8');
    } catch { /* 磁盘异常不阻塞消息流 */ }
    this.bus.emit('session.log', full);
    if (entry.type === 'message_out' || entry.type === 'message_in' || entry.type === 'error') {
      this.bus.emit(busEvents.chatEvent + '.logged', full);
    }
    return full;
  }

  tail(chatId: string, chatType: string, limit = 200): SessionLogEntry[] {
    const key = this.chatKey(chatId, chatType);
    let buf = this.buffers.get(key);
    if (!buf || buf.length === 0) {
      buf = this.readFromDisk(key, this.tailSize);
      this.buffers.set(key, buf);
      const last = buf[buf.length - 1];
      if (last && !this.leafs.has(key)) this.leafs.set(key, last.id);
    }
    return buf.slice(-limit);
  }

  /**
   * 活动分支：从叶子沿 parentId 往回走（新→旧），最多取 limit 条。
   * 与 `tail` 的区别：tail 是"文件里最后 N 行"，这里是"这条分支上的 N 条"——
   * 将来真做了分叉，这里才是正确的取法。
   */
  branch(chatId: string, chatType: string, limit = 200): SessionLogEntry[] {
    const key = this.chatKey(chatId, chatType);
    const all = this.tail(chatId, chatType, Number.MAX_SAFE_INTEGER);
    const byId = new Map(all.map((e) => [e.id, e] as const));
    const leafId = this.leafs.get(key) ?? all[all.length - 1]?.id;
    const out: SessionLogEntry[] = [];
    let cur = leafId ? byId.get(leafId) : undefined;
    while (cur && out.length < limit) {
      out.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out.reverse();
  }

  /** 记一条压缩条目：从这一刻起，firstKeptEntryId 之前的历史由 summary 代替 */
  appendCompaction(chatId: string, chatType: string, c: { summary: string; firstKeptEntryId: string | null; tokensBefore: number }): SessionLogEntry {
    return this.append(chatId, chatType, {
      type: 'compaction', role: 'system', summary: c.summary,
      firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore,
      text: `上下文已压缩（原 ~${Math.round(c.tokensBefore / 1000)}k tokens）`,
    });
  }

  /**
   * 把活动分支投影成"模型该看到的消息表"：
   *  - 找到分支上最后一条 compaction → 它的 summary 当开头；
   *  - 只收 firstKeptEntryId 之后（含）的 message_in/message_out；
   *  - 没有任何 compaction 时就是整条分支的消息。
   * 冷启动（重启后）走这里，所以压缩过的历史不会因为重启又变回全文。
   */
  project(chatId: string, chatType: string, limit = 400): { messages: { role: 'user' | 'assistant'; content: string }[]; summary?: string } {
    const branch = this.branch(chatId, chatType, limit * 2);
    const lastCut = [...branch].reverse().find((e) => e.type === 'compaction');
    const startIdx = lastCut
      ? (lastCut.firstKeptEntryId ? branch.findIndex((e) => e.id === lastCut.firstKeptEntryId) : branch.indexOf(lastCut) + 1)
      : 0;
    const from = startIdx < 0 ? branch.length : startIdx;
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const e of branch.slice(from)) {
      if (e.type === 'message_in' && e.role === 'user' && e.text) {
        // 落账的 text 是"给人看"的（界面靠它 + data 画引用块与记录卡），给模型要现净化一遍
        const d = e.data as { replyTo?: { nickname?: string; text?: string }; forward?: ForwardRecord } | undefined;
        messages.push({ role: 'user', content: inboundModelText({ text: e.text, replyTo: d?.replyTo, forward: d?.forward }) });
      } else if (e.type === 'message_out' && e.role === 'assistant' && e.text) {
        messages.push({ role: 'assistant', content: e.text });
      }
    }
    return { messages: messages.slice(-limit), summary: lastCut?.summary };
  }

  /**
   * 该会话「有消息的日子」（时间正序），给会话左侧的日轨用。
   * 整份 JSONL 扫一遍，按文件指纹（mtime+size）缓存——日轨每次开会话都要读，不能次次全扫。
   */
  days(chatId: string, chatType: string): ChatDay[] {
    const key = this.chatKey(chatId, chatType);
    const file = join(this.dir, key + '.jsonl');
    let st; try { st = statSync(file); } catch { return []; }
    const hit = this.dayIndex.get(key);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.days;
    const byDay = new Map<string, ChatDay>();
    for (const e of this.iterCounted(file)) {
      const day = localDay(e.ts);
      const cur = byDay.get(day);
      if (!cur) byDay.set(day, { day, count: 1, firstTs: e.ts, lastTs: e.ts });
      else {
        cur.count++;
        if (e.ts < cur.firstTs) cur.firstTs = e.ts;
        if (e.ts > cur.lastTs) cur.lastTs = e.ts;
      }
    }
    const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    this.dayIndex.set(key, { mtime: st.mtimeMs, size: st.size, days });
    return days;
  }

  /**
   * 某一天里的消息（时间正序）。cap 兜底：极端刷屏的一天可能上千条，
   * 超了就只给当天最早的那些，界面不炸，日轨那格的计数仍是全量。
   */
  dayEntries(chatId: string, chatType: string, day: string, cap = 800): SessionLogEntry[] {
    const file = join(this.dir, this.chatKey(chatId, chatType) + '.jsonl');
    if (!existsSync(file)) return [];
    const out: SessionLogEntry[] = [];
    for (const e of this.iterCounted(file)) {
      if (localDay(e.ts) !== day) continue;
      out.push(e);
      if (out.length >= cap) break;
    }
    return out;
  }

  /** 逐行解析并只留会话流里真显示的那种行（message_in / message_out）：日轨的一格按它们计 */
  private *iterCounted(file: string): Generator<SessionLogEntry> {
    let raw: string;
    try { raw = readFileSync(file, 'utf-8'); } catch { return; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e: SessionLogEntry;
      try { e = JSON.parse(line); } catch { continue; }
      if (DAY_COUNTED.has(e.type) && Number.isFinite(e.ts)) yield e;
    }
  }

  /** 从磁盘回放（Trajectory 视图） */
  readFromDisk(key: string, limit = 500): SessionLogEntry[] {
    const file = join(this.dir, key + '.jsonl');
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, 'utf-8').trim().split('\n');
      const out: SessionLogEntry[] = [];
      for (const line of lines.slice(-limit)) {
        try { out.push(JSON.parse(line)); } catch { /* skip */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 关键词检索本会话的历史消息（入站 message_in + 出站 message_out 原文），时间正序。
   * 上下文窗口外的旧消息模型平时看不到，这个方法是她"翻旧账"的通道：整份 JSONL 扫一遍，
   * 取**最近** limit 条命中（旧命中太多时不该把最早的顶上来）。工具调用是显式低频动作，全量扫可接受。
   */
  searchMessages(chatId: string, chatType: string, opts: { q: string; limit?: number }): { ts: number; role: 'user' | 'assistant'; nickname?: string; text: string }[] {
    const q = opts.q.trim().toLowerCase();
    if (!q) return [];
    const limit = Math.max(1, Math.min(Math.round(opts.limit ?? 20), 100));
    const file = join(this.dir, this.chatKey(chatId, chatType) + '.jsonl');
    if (!existsSync(file)) return [];
    const hits: { ts: number; role: 'user' | 'assistant'; nickname?: string; text: string }[] = [];
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let e: SessionLogEntry;
        try { e = JSON.parse(line); } catch { continue; }
        const isUser = e.type === 'message_in' && e.role === 'user';
        const isAssistant = e.type === 'message_out' && e.role === 'assistant';
        if (!isUser && !isAssistant) continue;
        const text = String(e.text ?? '');
        if (!text || !text.toLowerCase().includes(q)) continue;
        hits.push({ ts: e.ts, role: isUser ? 'user' : 'assistant', nickname: e.nickname, text });
        if (hits.length > limit * 4) hits.splice(0, hits.length - limit);  // 极端大文件时兜底限内存
      }
    } catch {
      return [];
    }
    return hits.slice(-limit);
  }

  listChats(): { chatKey: string; chatId: string; chatType: string; lastTs: number; size: number; lines: number }[] {
    const out: { chatKey: string; chatId: string; chatType: string; lastTs: number; size: number; lines: number }[] = [];
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const chatKey = f.replace(/\.jsonl$/, '');
        const m = chatKey.match(/^(group|private)_(.+)$/);
        if (!m) continue;
        const st = statSync(join(this.dir, f));
        let lastTs = Math.floor(st.mtimeMs);
        let lines = 0;
        try {
          const tail = readFileSync(join(this.dir, f), 'utf-8').trim().split('\n').slice(-1)[0];
          if (tail) { lastTs = JSON.parse(tail).ts ?? lastTs; lines = 1; }
        } catch { /* ignore */ }
        out.push({ chatKey, chatId: m[2], chatType: m[1], lastTs, size: st.size, lines });
      }
    } catch { /* ignore */ }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  /** 静态注入一条非消息事件（桌面端注入测试消息等） */
  logInbound(event: ChatEvent): void {
    this.append(event.chatId, event.type, {
      type: 'message_in',
      role: 'user',
      userId: event.userId,
      nickname: event.nickname,
      text: event.text,
      data: {
        segments: event.segments.length ? event.segments : undefined,
        // 存协议端消息号：引用段只带这个号，下次有人引用时按它查回原文（见 findByMessageId）
        messageId: event.messageId,
        replyTo: event.replyTo,
        // 存 rel 而不是只有名字：重名落盘会加 _1，名字对不上真实文件，桌面端就没法取图
        files: event.files?.map((f) => ({ name: f.name, rel: f.rel, size: f.size })),
        // 聊天记录（合并转发）：段里只有 resId，节点是适配器现取回来的，不存就只有一行占位。
        // 附件只留 name/rel/size：那份临时 URL 带 rkey 且几小时就过期，不该躺在会话日志里。
        forward: event.forward && {
          ...event.forward,
          nodes: event.forward.nodes.map((n) => (n.files
            ? { ...n, files: n.files.map((f) => ({ name: f.name, rel: f.rel, sandboxPath: f.sandboxPath, size: f.size })) }
            : n)),
        },
      },
    });
  }

  /** 按协议端消息号在本会话的内存尾里找一条（引用回查用）。找不到就 null——UI 留着 [回复:id] 占位 */
  findByMessageId(chatId: string, chatType: string, messageId: string): SessionLogEntry | null {
    if (!messageId) return null;
    const buf = this.tail(chatId, chatType, Number.MAX_SAFE_INTEGER);
    for (let i = buf.length - 1; i >= 0; i--) {
      const e = buf[i];
      if ((e.data as { messageId?: string } | undefined)?.messageId === messageId) return e;
    }
    return null;
  }
}
