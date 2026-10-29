import { randomUUID } from 'node:crypto';

export function newId(prefix = ''): string {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 16);
}

export function nowMs(): number {
  return Date.now();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(截断,原长${s.length})`;
}

/** 给人看的短文本：截断只留省略号，不带内部调试标记（truncate 的标记只该出现在模型/日志里） */
export function clip(s: string, max: number): string {
  const t = String(s ?? '');
  return t.length <= max ? t : t.slice(0, max) + '…';
}

/**
 * 聊天标识拼进目录/文件名前的消毒：只留字母数字与 `. _ -`。
 * chatId/scope 来自协议端事件与 API 参数，直接参与 `join()` 时 `..` 与 `/` 会越出数据目录。
 */
export function safeKeyPart(v: unknown): string {
  const s = String(v ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return s === '' || s === '.' || s === '..' ? '_' : s;
}

/** 深合并 target ← source（仅普通对象；source 值为 null 时直接赋值），返回 target */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (target as any)[k] && typeof (target as any)[k] === 'object' && !Array.isArray((target as any)[k])) {
      deepMerge((target as any)[k], v as Record<string, unknown>);
    } else if (v !== undefined) {
      (target as any)[k] = v;
    }
  }
  return target;
}

/** 依据默认值骨架浅校验/补齐（类型不一致时回落默认值），默认值里没有的键原样保留 */
export function coerceLike<T extends Record<string, unknown>>(defaults: T, input: unknown): T {
  const out: Record<string, unknown> = structuredClone(defaults);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out as T;
  const src = input as Record<string, unknown>;
  for (const [k, dv] of Object.entries(defaults)) {
    const iv = src[k];
    if (iv === undefined) continue;
    if (dv === null || dv === undefined) { out[k] = iv; continue; }
    if (typeof dv === 'number' && typeof iv === 'number') out[k] = iv;
    else if (typeof dv === 'boolean' && typeof iv === 'boolean') out[k] = iv;
    else if (typeof dv === 'string' && typeof iv === 'string') out[k] = iv;
    else if (Array.isArray(dv) && Array.isArray(iv)) out[k] = iv;
    else if (typeof dv === 'object' && !Array.isArray(dv) && typeof iv === 'object' && !Array.isArray(iv)) {
      out[k] = coerceLike(dv as Record<string, unknown>, iv);
    }
  }
  // 默认值里没有的键照原样留：providers / llm.modelByProvider / ui.chatPrefs 这些是「按 id 装条目」
  // 的字典，用户自己加的键不在骨架里。只按骨架裁剪等于每次启动把它们全删掉（2026-10-28 的回归）
  for (const [k, iv] of Object.entries(src)) {
    if (Object.hasOwn(defaults, k) || iv === undefined) continue;
    out[k] = structuredClone(iv);
  }
  return out as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function todayKey(tzOffsetMs = 0): string {
  return new Date(Date.now() + tzOffsetMs).toISOString().slice(0, 10);
}

export function hhmm(now = new Date()): string {
  return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}
