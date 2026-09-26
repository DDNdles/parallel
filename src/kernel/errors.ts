import { join } from 'node:path';
import { Bus, busEvents } from './bus.ts';
import { newId, nowMs } from './util/misc.ts';

export type ErrorLevel = 'info' | 'warn' | 'error';
export type ErrorCategory = 'adapter' | 'provider' | 'plugin' | 'sandbox' | 'storage' | 'kernel' | 'command' | 'media';

export interface ErrorRecord {
  id: string;
  ts: number;
  level: ErrorLevel;
  category: ErrorCategory;
  pluginId?: string;
  chatId?: string;
  message: string;
  stack?: string;
  dedupeKey: string;
  count: number;
  lastTs: number;
  suggestion?: string;
}

const SUGGESTIONS: Partial<Record<ErrorCategory, string>> = {
  adapter: '协议端连接异常：检查 LLBot 是否运行、Auth Token 是否有效、反向 WS 地址与 access token 是否一致，然后在报错中心或控制台执行重连。',
  provider: '模型调用失败：检查 API Key / Base URL / 模型名与网络连通性，然后重试。若使用 gemini-3.8-flash 占位项，请先切换到已接入的供应商。',
  plugin: '插件运行出错：可尝试在插件管理里重载该插件；连续同错 3 次会被自动停用。',
  sandbox: '沙箱执行受限或失败：检查 Python/Node 是否可用、脚本是否超时或超出输出/资源限额。',
  storage: '数据读写异常：检查磁盘空间与 data 目录权限；配置文件损坏时会自动回退到 .bak 备份。',
  command: '命令执行出错：查看插件日志；若持续出现请重载对应插件。',
  media: '图片/语音/视频没能送进模型：语音需要本机 ffmpeg 转码（装好后设 PARALLEL_FFMPEG 指向可执行文件并重启内核），或该模型未声明对应的输入类型。',
  kernel: '内核内部错误：请保存日志并反馈。',
};

/**
 * 报错中心（报告 05 §4）：统一记录、聚合计数、建议动作、QQ 侧节流通知主人。
 */
export class ErrorCenter {
  private records = new Map<string, ErrorRecord>();
  private order: string[] = [];
  private lastNotify = new Map<string, number>();
  readonly maxKeep = 500;

  constructor(
    private bus: Bus,
    private opts: { dataDir: string; notifyOwner?: (text: string) => Promise<void> } = { dataDir: '.' },
  ) {}

  record(
    level: ErrorLevel,
    category: ErrorCategory,
    message: string,
    opts: { pluginId?: string; chatId?: string; stack?: string; notifyOwner?: boolean } = {},
  ): ErrorRecord {
    const dedupeKey = `${category}|${opts.pluginId ?? ''}|${message.slice(0, 120)}`;
    let rec = this.records.get(dedupeKey);
    if (!rec) {
      rec = {
        id: newId('err_'), ts: nowMs(), level, category,
        pluginId: opts.pluginId, chatId: opts.chatId,
        message, stack: opts.stack, dedupeKey,
        count: 0, lastTs: nowMs(), suggestion: SUGGESTIONS[category],
      };
      this.records.set(dedupeKey, rec);
      this.order.push(dedupeKey);
      if (this.order.length > this.maxKeep) {
        const drop = this.order.shift();
        if (drop) this.records.delete(drop);
      }
    }
    rec.count += 1;
    rec.lastTs = nowMs();
    rec.level = level;
    if (opts.stack) rec.stack = opts.stack;
    this.bus.emit(busEvents.errorRecorded, rec);

    if (level === 'error' && opts.notifyOwner !== false) this.notifyOwnerThrottled(rec);
    return rec;
  }

  /** error 级私聊主人（节流：同 dedupeKey 10 分钟 1 次） */
  private notifyOwnerThrottled(rec: ErrorRecord): void {
    const last = this.lastNotify.get(rec.dedupeKey) ?? 0;
    if (nowMs() - last < 10 * 60_000) return;
    this.lastNotify.set(rec.dedupeKey, nowMs());
    const text = `[parallel 报错] ${rec.category}${rec.pluginId ? '/' + rec.pluginId : ''}: ${rec.message.slice(0, 200)}\n(累计 ${rec.count} 次，详情见桌面端报错中心)`;
    this.opts.notifyOwner?.(text).catch(() => { /* 通知失败静默 */ });
  }

  list(filter?: { level?: ErrorLevel; category?: ErrorCategory; pluginId?: string }): ErrorRecord[] {
    let arr = [...this.records.values()];
    if (filter?.level) arr = arr.filter((r) => r.level === filter.level);
    if (filter?.category) arr = arr.filter((r) => r.category === filter.category);
    if (filter?.pluginId) arr = arr.filter((r) => r.pluginId === filter.pluginId);
    return arr.sort((a, b) => b.lastTs - a.lastTs);
  }

  get(id: string): ErrorRecord | undefined {
    return [...this.records.values()].find((r) => r.id === id);
  }

  clear(): void {
    this.records.clear();
    this.order = [];
  }
}
