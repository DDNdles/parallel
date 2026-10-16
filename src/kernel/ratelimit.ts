/**
 * 风控克制（红线 §3.3）：每会话令牌桶限速。
 * 回复前的等待不在这里 —— 那是拟人化的打字节奏（`humanlike.outgoing`），风控只管上限。
 */
/** 一次取用的结果：`granted` 是实际拿到的条数（0 = 整批丢掉），`ok` 等价于 `granted >= cost` */
export interface RateTake {
  ok: boolean;
  waitMs: number;
  granted: number;
}

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  private perMin: number;

  constructor(perMin: number) {
    this.perMin = perMin;
  }

  setPerMin(n: number): void {
    this.perMin = n;
  }

  /**
   * 取 `cost` 个令牌。
   *
   * **按条计费**，不按"轮"计费：拟人化一轮回复会拆成若干条短消息，一次回复就该吃同样多个令牌 ——
   * 按轮计费时「12 条/分钟」实际能发到 70+ 条/分钟，红线等于没设。
   * 桶不够时**部分放行**（`granted < cost`）而不是整批拒绝：宁可少发两条，也别让整轮人间蒸发。
   */
  tryTake(key: string, cost = 1): RateTake {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.perMin, last: now }; this.buckets.set(key, b); }
    const refill = ((now - b.last) / 60_000) * this.perMin;
    b.tokens = Math.min(this.perMin, b.tokens + refill);
    b.last = now;
    // 一批最多吃满一个桶：桶本身就是"每分钟上限"，一批再长也不该欠着
    const want = Math.max(1, Math.min(cost, this.perMin));
    const granted = Math.floor(b.tokens);
    if (granted >= want) {
      b.tokens -= want;
      return { ok: true, waitMs: 0, granted: want };
    }
    if (granted > 0) {
      b.tokens -= granted;
      return { ok: false, waitMs: Math.ceil(((want - granted) / this.perMin) * 60_000), granted };
    }
    return { ok: false, waitMs: Math.ceil(((1 - b.tokens) / this.perMin) * 60_000), granted: 0 };
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
