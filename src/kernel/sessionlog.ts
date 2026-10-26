import { join } from 'node:path';
import { appendFileSync, readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { ensureDir } from './util/fsutil.ts';
import { newId, nowMs } from './util/misc.ts';
import { inboundModelText } from './util/modeltext.ts';
import type { ChatEvent, ForwardRecord, MessageAttachment } from './types.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';

export type SessionLogType =
  | 'message_in' | 'message_out' | 'command' | 'command_result'
  | 'agent_start' | 'agent_end' | 'llm_call' | 'llm_delta' | 'tool_call' | 'tool_result'
  | 'error' | 'system'
  /** 戳一戳（双击头像）：不是消息，但会话流里要留下这一下 */
  | 'poke'
  /** 贴表情：别人消息下面的表情回应（不是消息，会话流留一行） */
  | 'reaction'
  /** 上下文压缩：这条之前的消息在后续请求里由 summary 代替（对齐 pi 的 compaction 条目） */
  | 'compaction'
  /** 拟人层决策：这一轮为什么开口 / 为什么沉默（含开口概率、动态预算与空窗补偿明细） */
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
  /**
   * 这条属于哪条执行线：`chat` = 会话模型自己的 loop，`work` = work 子代理的 loop。
   * 两边都会往同一份会话日志里写 tool_call / agent_start…，桌面端「工作」抽屉靠它分开显示。
   * 老记录没有这个字段 = chat（那时还没有 work 侧栏）。
   */
  lane?: 'chat' | 'work';
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

/** searchMessages 单次最多往回扫的体量（字节）：群聊日志可能几十兆，全量 readFileSync
 *  会把主线程卡住几百毫秒；检索语义是「最近的 N 条命中」，从尾部限窗倒着找，收满就停。 */
const SEARCH_SCAN_MAX_BYTES = 5 * 1024 * 1024;

/** 按扩展名猜媒体类型；猜不出来返回 undefined，由线格式按 kind 兜底。
 *  与 `pipeline.ts` 顶部是同一张表——这里**复制**一份而不是 import pipeline：
 *  pipeline 反过来 import 本模块，引过去就是环依赖。改表时两边一起改。 */
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

/**
 * 落账文件（`data.files` / 记录节点的 `files`）→ 可重放的附件。
 *
 * 与 `pipeline.attachmentsOf` 同一条底线：**url 与 path 都没有的不产出**。
 * 那种记录在模型侧读不出任何东西，塞进上下文只会让下游多报一条"读不动"；
 * 旧日志里顶层文件没有 sandboxPath（那时没存），于是自然退化成"没有附件"，不留空占位。
 */
function fileAttachment(raw: unknown): MessageAttachment | null {
  const f = (typeof raw === 'string' ? { name: raw } : raw) as
    { name?: unknown; rel?: unknown; sandboxPath?: unknown; url?: unknown } | undefined;
  if (!f || typeof f !== 'object') return null;
  const name = String(f.name ?? '') || undefined;
  const path = String(f.sandboxPath ?? '') || undefined;
  const url = /^https?:\/\//.test(String(f.url ?? '')) ? String(f.url) : undefined;
  if (!path && !url) return null;
  // QQ 的下载地址是 `.../download?appid=...`，扩展名只在文件名上，所以按 名字→路径→URL 依次猜（同 pipeline）
  const mime = [name, path, url].map((v) => (v ? mimeOf(v) : undefined)).find((m) => m !== undefined);
  const kind: MessageAttachment['kind'] =
    mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('video/') ? 'video' : 'image';
  return { kind, path, url, name, mime };
}

/** 一条入站消息带的全部媒体：顶层文件在前，聊天记录里各节点的图/语音/视频跟在后面 */
function inboundAttachments(d: { files?: unknown; forward?: ForwardRecord } | undefined): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const add = (raw: unknown) => {
    const a = fileAttachment(raw);
    if (a) out.push(a);
  };
  if (Array.isArray(d?.files)) for (const f of d.files) add(f);
  for (const n of d?.forward?.nodes ?? []) for (const f of n.files ?? []) add(f);
  return out;
}

export class SessionLog {
  private buffers = new Map<string, SessionLogEntry[]>();
  /** 每个会话当前的活动叶子（下一条的 parentId）。磁盘是严格追加的，所以重启后从最后一行接上。 */
  private leafs = new Map<string, string>();
  /** days() 的结果缓存：文件 mtime+size 不变就不重扫 */
  private dayIndex = new Map<string, { mtime: number; size: number; days: ChatDay[] }>();
  private seq = 0;
  readonly dir: string;
  private tailSize = 300;

  constructor(dataDir: string, private bus: Bus, private onError?: (message: string) => void) {
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
    } catch (e) {
      // 磁盘异常不阻塞消息流，但"连账都丢了没人知道"不行：报错中心按错误文本去重
      this.onError?.(`会话日志写盘失败（${(e as Error).message}）：这条消息没落账，磁盘可能已满或被其他程序占用。`);
    }
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
   *
   * 每条都带回落账时的 `ts`；入站的还重建 `attachments`（顶层文件 + 记录节点的媒体）——
   * 调用方（HistoryStore）要靠它们做时间窗过滤与窗口内媒体重放，丢了这两样等于重启即失忆。
   */
  project(chatId: string, chatType: string, limit = 400): {
    messages: { role: 'user' | 'assistant'; content: string; ts?: number; attachments?: MessageAttachment[] }[];
    summary?: string;
  } {
    const branch = this.branch(chatId, chatType, limit * 2);
    const lastCut = [...branch].reverse().find((e) => e.type === 'compaction');
    const startIdx = lastCut
      ? (lastCut.firstKeptEntryId ? branch.findIndex((e) => e.id === lastCut.firstKeptEntryId) : branch.indexOf(lastCut) + 1)
      : 0;
    const from = startIdx < 0 ? branch.length : startIdx;
    const messages: { role: 'user' | 'assistant'; content: string; ts?: number; attachments?: MessageAttachment[] }[] = [];
    for (const e of branch.slice(from)) {
      if (e.type === 'message_in' && e.role === 'user' && e.text) {
        // 落账的 text 是"给人看"的（界面靠它 + data 画引用块与记录卡），给模型要现净化一遍。
        // 群聊再把说话人拼进正文（昵称优先，无昵称给 QQ 号）——与 pipeline 的当前轮同一口径；
        // 私聊不带名，对面是谁 system 里已写明。
        const d = e.data as { replyTo?: { nickname?: string; text?: string }; forward?: ForwardRecord; files?: unknown[] } | undefined;
        const m: { role: 'user'; content: string; ts?: number; attachments?: MessageAttachment[] } = {
          role: 'user',
        content: inboundModelText({
          text: e.text,
          replyTo: d?.replyTo,
          forward: d?.forward,
          nickname: chatType === 'group' ? (e.nickname || String(e.userId ?? '') || undefined) : undefined,
        }),
        };
        if (Number.isFinite(e.ts)) m.ts = e.ts;
        const atts = inboundAttachments(d);
        if (atts.length) m.attachments = atts;
        messages.push(m);
      } else if (e.type === 'message_out' && e.role === 'assistant' && e.text) {
        const m: { role: 'assistant'; content: string; ts?: number } = { role: 'assistant', content: e.text };
        if (Number.isFinite(e.ts)) m.ts = e.ts;
        messages.push(m);
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
   * 上下文窗口外的旧消息模型平时看不到，这个方法是她"翻旧账"的通道。
   * 只取**最近** limit 条命中（旧命中太多时不该把最早的顶上来）。
   * `beforeTs`：只翻这个时刻之前的（窗口起点）——模型眼前就有的那几条再还回去一遍，
   *  它只会误以为"还有前文我没看到"，然后越查越离谱。
   *
   * 读取走"尾部限窗"：一次性 readFileSync 整份会话日志会把主线程卡几百毫秒（群聊日志几十兆）。
   * 只从文件末尾回看 `SEARCH_SCAN_MAX_BYTES` 字节，按字节切行（utf-8 里 \n 永远是单字节，
   * 按行整段解码不会劈开多字节字符）；窗口起头截在半行上的残段整行丢弃（宁少一行不错一行），
   * 命中数够了就停。语义上仍是"最近的 N 条命中"——更老的零星命中交给 recall/长期记忆。
   */
  searchMessages(chatId: string, chatType: string, opts: { q: string; limit?: number; beforeTs?: number }): { ts: number; role: 'user' | 'assistant'; nickname?: string; text: string }[] {
    const q = opts.q.trim().toLowerCase();
    if (!q) return [];
    const limit = Math.max(1, Math.min(Math.round(opts.limit ?? 20), 100));
    const file = join(this.dir, this.chatKey(chatId, chatType) + '.jsonl');
    if (!existsSync(file)) return [];
    const hits: { ts: number; role: 'user' | 'assistant'; nickname?: string; text: string }[] = [];
    try {
      const size = statSync(file).size;
      const windowLen = Math.min(size, SEARCH_SCAN_MAX_BYTES);
      const window = Buffer.alloc(windowLen);
      const fd = openSync(file, 'r');
      try {
        readSync(fd, window, 0, windowLen, size - windowLen);
      } finally {
        closeSync(fd);
      }
      // 窗口起头截在半行上（整文件比窗口长时）：丢弃首条 \n 之前的残段，从完整行的起点开始
      let from = 0;
      if (size > SEARCH_SCAN_MAX_BYTES) {
        const firstNl = window.indexOf(0x0a);
        if (firstNl === -1) return [];  // 一整窗都没有行分隔（单行比窗口还大）：可看的没有
        from = firstNl + 1;
      }
      const lines = window.toString('utf8', from).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        let e: SessionLogEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (opts.beforeTs !== undefined && e.ts >= opts.beforeTs) continue;
        const isUser = e.type === 'message_in' && e.role === 'user';
        const isAssistant = e.type === 'message_out' && e.role === 'assistant';
        if (!isUser && !isAssistant) continue;
        const text = String(e.text ?? '');
        if (!text || !text.toLowerCase().includes(q)) continue;
        hits.push({ ts: e.ts, role: isUser ? 'user' : 'assistant', nickname: e.nickname, text });
        if (hits.length >= limit) break;
      }
    } catch {
      return [];
    }
    // 倒着扫出来的命中是「新→旧」，检索的对外契约一直是时间正序（加入站早于出站按 ts 排）：
    // 翻回来再交出去
    hits.reverse();
    return hits;
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
        // 存 rel 而不是只有名字：重名落盘会加 _1，名字对不上真实文件，桌面端就没法取图。
        // sandboxPath 也一起存：重启后重建历史要靠它把窗口内的图/语音/视频交回模型
        //（url 带 rkey 且几小时过期，不能存；记录节点那份早就这么存了，这里对齐）
        files: event.files?.map((f) => ({ name: f.name, rel: f.rel, sandboxPath: f.sandboxPath, size: f.size })),
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

  /** 按协议端消息号在本会话里找一条（引用回查用）：先查内存尾，查不到再回磁盘里找。
   *  内存尾只有 tailSize 条（引用却常常指向很久以前发的一张图），磁盘日志才是全的；
   *  磁盘这一层同样走尾部限窗，只为一次引用不回读几十兆。找不到才 null（UI 留着 [回复:id] 占位）。 */
  findByMessageId(chatId: string, chatType: string, messageId: string): SessionLogEntry | null {
    if (!messageId) return null;
    const buf = this.tail(chatId, chatType, Number.MAX_SAFE_INTEGER);
    for (let i = buf.length - 1; i >= 0; i--) {
      const e = buf[i];
      if (String((e.data as { messageId?: string } | undefined)?.messageId ?? '') === messageId) return e;
    }
    return this.findByMessageIdOnDisk(chatId, chatType, messageId);
  }

  /** findByMessageId 的磁盘兜底：从文件尾部限窗倒着扫，命中就返回（新→旧，取最新一条） */
  private findByMessageIdOnDisk(chatId: string, chatType: string, messageId: string): SessionLogEntry | null {
    const file = join(this.dir, this.chatKey(chatId, chatType) + '.jsonl');
    if (!existsSync(file)) return null;
    try {
      const size = statSync(file).size;
      const windowLen = Math.min(size, SEARCH_SCAN_MAX_BYTES);
      const window = Buffer.alloc(windowLen);
      const fd = openSync(file, 'r');
      try {
        readSync(fd, window, 0, windowLen, size - windowLen);
      } finally {
        closeSync(fd);
      }
      // 窗口起头截在半行上时整行丢弃（宁少一行不错一行），与 searchMessages 同一口径
      let from = 0;
      if (size > windowLen) {
        const firstNl = window.indexOf(0x0a);
        if (firstNl === -1) return null;
        from = firstNl + 1;
      }
      const lines = window.toString('utf8', from).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        let e: SessionLogEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (String((e.data as { messageId?: string } | undefined)?.messageId ?? '') === messageId) return e;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * 触发消息（按协议端消息号定位）**之后**有没有更新的入站消息（组回复的引用锚点判断用，
   * 见 pipeline.quoteTargetOf）：触发消息被后面的新消息刷远了，回复才挂引用段。
   * 按尾缓冲的追加序比较（不按 ts —— 落账 ts 与事件 ts 差几毫秒，自己会被当成"更新的"；
   * 踩过这个坑：每条回复都挂上了空引用）。只算 message_in，自己的出站不算；找不到触发消息就是 false。
   */
  hasNewerInbound(chatId: string, chatType: string, messageId: string): boolean {
    if (!messageId) return false;
    const buf = this.tail(chatId, chatType, Number.MAX_SAFE_INTEGER);
    let idx = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if ((buf[i].data as { messageId?: string } | undefined)?.messageId === messageId) { idx = i; break; }
    }
    if (idx < 0) return false;
    for (let i = idx + 1; i < buf.length; i++) {
      if (buf[i].type === 'message_in') return true;
    }
    return false;
  }
}
