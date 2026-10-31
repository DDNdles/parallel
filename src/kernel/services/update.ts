/**
 * 应用内更新检查：对照 GitHub latest release 提示桌面端有新版。
 *
 * 设计红线：
 *  - 纯锦上添花，任何失败（断网 / 被风控 / 限流 / 响应异常）都静默吞掉，绝不进报错中心；
 *  - 只读 `releases/latest`（GitHub 自动排除 draft 与 prerelease，接口层再防御一次）；
 *  - 不做自动下载/自替换——只提示 + 给出跳转地址，替换运行中的程序交给用户。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.ts';
import type { Logger } from '../types.ts';

const RELEASES_API = 'https://api.github.com/repos/DDNdles/parallel/releases/latest';
const RELEASES_PAGE = 'https://github.com/DDNdles/parallel/releases/latest';

export interface UpdateInfo {
  /** 运行中的版本 */
  current: string;
  /** 最新 release 的 tag（如 v0.4.0） */
  latest: string;
  /** 人类跳转地址（release 页，含更新说明与附件） */
  url: string;
}

/** 从包根的 package.json 读自己的版本；读不到回 0.0.0（永远不会提示更新） */
export function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
}

/** 运行版本 current 是否落后于 release tag（v 前缀随意，只比前三段数字，缺段按 0） */
export function isNewerVersion(current: string, latestTag: string): boolean {
  const num = (s: string) => s.replace(/^v/i, '').split('.').map((p) => Number.parseInt(p, 10) || 0);
  const a = num(current);
  const b = num(latestTag);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

export class UpdateService {
  private info: UpdateInfo | null = null;
  private timer?: NodeJS.Timeout;
  readonly current: string;

  constructor(private opts: {
    log: Logger;
    /** 测试注入用 */
    fetchFn?: typeof fetch;
    intervalMs?: number;
    currentVersion?: string;
  }) {
    this.current = opts.currentVersion ?? readOwnVersion();
  }

  /** 最近一次成功的检查结果；没有新版/还没查过就是 null */
  get(): UpdateInfo | null { return this.info; }

  /** 启动时查一次，之后每 6 小时复查。PARALLEL_NO_UPDATE_CHECK=1（测试/无头）整体跳过 */
  start(): void {
    if (process.env.PARALLEL_NO_UPDATE_CHECK === '1') return;
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.opts.intervalMs ?? 6 * 3600_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkNow(): Promise<UpdateInfo | null> {
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const res = await fetchFn(RELEASES_API, {
        headers: { 'User-Agent': 'parallel-update-check', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return this.info;
      const j = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
      if (typeof j.tag_name !== 'string' || j.draft === true || j.prerelease === true) return this.info;
      if (!isNewerVersion(this.current, j.tag_name)) return this.info;
      this.info = {
        current: this.current,
        latest: j.tag_name,
        url: typeof j.html_url === 'string' && j.html_url ? j.html_url : RELEASES_PAGE,
      };
    } catch (e) {
      this.opts.log.debug(`更新检查失败（忽略）：${(e as Error).message}`);
    }
    return this.info;
  }
}
