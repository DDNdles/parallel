import { join } from 'node:path';
import { appendFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { ensureDir } from './util/fsutil.ts';
import { newId, nowMs } from './util/misc.ts';
import type { ChatEvent } from './types.ts';
import type { Bus } from './bus.ts';
import { busEvents } from './bus.ts';

export type SessionLogType =
  | 'message_in' | 'message_out' | 'command' | 'command_result'
  | 'agent_start' | 'agent_end' | 'llm_call' | 'llm_delta' | 'tool_call' | 'tool_result'
  | 'error' | 'system';

export interface SessionLogEntry {
  id: string;
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
}

/**
 * 追加式会话日志（dsh 式可回放）：data/sessions/<chatKey>.jsonl。
 * 同时维护内存尾缓冲供 UI 快速打开，出站/工具调用全程留痕。
 */
export class SessionLog {
  private buffers = new Map<string, SessionLogEntry[]>();
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
    }
    return buf.slice(-limit);
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
      data: { segments: event.segments.length ? event.segments : undefined, files: event.files?.map((f) => f.name) },
    });
  }
}
