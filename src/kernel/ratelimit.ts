import { randomInt } from './util/misc.ts';

/**
 * 风控克制（红线 §3.3）：每会话令牌桶限速 + 随机抖动。
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  private perMin: number;

  constructor(perMin: number) {
    this.perMin = perMin;
  }

  setPerMin(n: number): void {
    this.perMin = n;
  }

  /** 是否允许此刻发送；不允许则返回建议等待毫秒 */
  tryTake(key: string): { ok: boolean; waitMs: number } {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.perMin, last: now }; this.buckets.set(key, b); }
    const refill = ((now - b.last) / 60_000) * this.perMin;
    b.tokens = Math.min(this.perMin, b.tokens + refill);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, waitMs: 0 };
    }
    return { ok: false, waitMs: Math.ceil(((1 - b.tokens) / this.perMin) * 60_000) };
  }

  /** 回复前的随机抖动延迟（模拟真人节奏） */
  static jitterDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs >= maxMs ? minMs : randomInt(minMs, maxMs);
    return new Promise((r) => setTimeout(r, ms));
  }
}

/** 每分钟滑动窗口计数（用于沙箱执行配额等） */
export class SlidingWindowCounter {
  private hits = new Map<string, number[]>();

  hit(key: string, now = Date.now()): number {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length;
  }

  count(key: string, now = Date.now()): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < 60_000).length;
  }
}
