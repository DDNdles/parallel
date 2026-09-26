import type { Bus } from './bus.ts';
import type { ScheduleJob } from './types.ts';
import { hhmm } from './util/misc.ts';
import { busEvents } from './bus.ts';

/**
 * 定时任务调度器（需 schedule 权限的插件才能注册）。
 * 主动推送类任务（proactive=true）受风控开关控制：默认关闭，
 * 仅主人在桌面端为该插件显式开启后才会触发（红线 §3.3）。
 */
export class Scheduler {
  private jobs = new Map<string, { job: ScheduleJob; pluginId: string }>();
  private timer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private bus: Bus,
    private isProactiveEnabled: (pluginId: string) => boolean,
  ) {
    // 每分钟 tick：匹配每日任务；interval 任务用独立 timer
    this.timer = setInterval(() => this.tickDaily(), 30_000);
    this.timer.unref();
  }

  register(pluginId: string, job: ScheduleJob): void {
    const id = `${pluginId}:${job.id}`;
    if (this.jobs.has(id)) return;
    this.jobs.set(id, { job, pluginId });
    if (job.intervalMs && job.intervalMs > 0) {
      const t = setInterval(() => this.fire(id), job.intervalMs);
      t.unref();
      this.intervals.set(id, t);
    }
  }

  /** 插件卸载/重载时注销其全部任务（统一 deactivate 协议的一部分） */
  unregisterPlugin(pluginId: string): void {
    for (const [id, entry] of this.jobs) {
      if (entry.pluginId !== pluginId) continue;
      const t = this.intervals.get(id);
      if (t) { clearInterval(t); this.intervals.delete(id); }
      this.jobs.delete(id);
    }
  }

  private intervals = new Map<string, NodeJS.Timeout>();

  private tickDaily(): void {
    if (this.disposed) return;
    const t = hhmm();
    for (const [id, { job }] of this.jobs) {
      if (job.dailyAt === t) {
        // 同一分钟只触发一次
        const lastKey = `daily:${id}`;
        const last = this.lastFired.get(lastKey);
        const minuteKey = new Date().toISOString().slice(0, 16);
        if (last === minuteKey) continue;
        this.lastFired.set(lastKey, minuteKey);
        this.fire(id);
      }
    }
  }

  private lastFired = new Map<string, string>();

  private fire(id: string): void {
    const entry = this.jobs.get(id);
    if (!entry) return;
    if (entry.job.proactive && !this.isProactiveEnabled(entry.pluginId)) {
      return; // 主动推送默认关闭（风控红线）
    }
    this.bus.emit(busEvents.scheduleFire, { id, pluginId: entry.pluginId });
    try {
      Promise.resolve(entry.job.handler()).catch((e) => {
        this.bus.emit('schedule.error', { id, error: (e as Error).message });
      });
    } catch (e) {
      this.bus.emit('schedule.error', { id, error: (e as Error).message });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of this.intervals.values()) clearInterval(t);
    this.intervals.clear();
  }
}
