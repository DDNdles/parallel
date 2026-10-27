import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from './types.ts';

/**
 * cover 插件在 107 上的守护进程：内核启动时按配置拉起 scripts/cover/ustc-watch.mjs，
 * 由它负责「没有作业就自动提交 + 作业起来后自动接线」。这里只做启停与状态判断。
 */
export interface CoverSupervisorInput {
  /** 无头模式（测试/服务）不拉外部进程 */
  noApi: boolean;
  /** 排障开关：PARALLEL_NO_COVER_SUPERVISOR=1 时整个功能停用 */
  disabledByEnv: boolean;
  pluginLoaded: boolean;
  autoStart: boolean;
  hasCookie: boolean;
  childRunning: boolean;
}

export interface CoverSupervisorPlan {
  action: 'start' | 'stop' | 'none';
  reason: string;
}

export function planCoverSupervisor(input: CoverSupervisorInput): CoverSupervisorPlan {
  if (input.noApi) return { action: 'stop', reason: '无头模式' };
  if (input.disabledByEnv) return { action: 'stop', reason: '已由环境变量停用' };
  if (!input.pluginLoaded) return { action: 'stop', reason: 'cover 插件未载入' };
  if (!input.autoStart) return { action: 'stop', reason: '自动接线未开启' };
  if (!input.hasCookie) return { action: 'stop', reason: '没有 Cookie' };
  if (!input.childRunning) return { action: 'start', reason: '自动接线已开启' };
  return { action: 'none', reason: '守护进程已在跑' };
}

export class CoverSupervisor {
  private child: ChildProcess | null = null;
  private readonly script: string;
  private readonly logFile: string;
  private readonly pidFile: string;
  private readonly beatFile: string;

  constructor(private readonly opts: { root: string; dataDir: string; kernelUrl: string; log: Logger }) {
    this.script = join(opts.root, 'scripts', 'cover', 'ustc-watch.mjs');
    this.logFile = join(opts.dataDir, 'cover', 'supervisor.out.log');
    this.pidFile = join(opts.dataDir, 'cover', 'supervisor.pid');
    this.beatFile = join(opts.dataDir, 'cover', 'supervisor.beat');
  }

  /**
   * 已经有一个 supervisor 在跑（比如内核被硬杀后留下的孤儿，或手动起的）：
   * 认 PID 文件 + 6 分钟内的心跳，避免 stale PID 被复用后误判/误杀。
   */
  private externalPid(): number {
    try {
      const pid = Number(readFileSync(this.pidFile, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) return 0;
      if (this.child?.pid === pid) return 0;
      const beat = statSync(this.beatFile);
      if (Date.now() - beat.mtimeMs > 6 * 60 * 1000) return 0;
      try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return 0; }
      return pid;
    } catch {
      return 0;
    }
  }

  get running(): boolean {
    if (this.child && this.child.exitCode === null && !this.child.killed) return true;
    return this.externalPid() > 0;
  }

  start(): void {
    if (this.running) return;
    mkdirSync(dirname(this.logFile), { recursive: true });
    // 子进程的 stdout/stderr 直接追加到 data/cover/supervisor.out.log；
    // fd 复制给子进程后父进程就可以关掉，不会泄漏句柄。
    const fd = openSync(this.logFile, 'a');
    const child = spawn(process.execPath, [
      '--use-system-ca', this.script,
      '--data-dir', this.opts.dataDir,
      '--kernel', this.opts.kernelUrl,
    ], {
      cwd: this.opts.root,
      env: { ...process.env, PARALLEL_COVER_SUPERVISOR: '1' },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    closeSync(fd);
    this.child = child;
    child.once('error', (e) => this.opts.log.error(`cover supervisor 启动失败: ${e.message}`));
    child.once('exit', (code, signal) => {
      this.opts.log.info(`cover supervisor 退出（code=${code}${signal ? ` signal=${signal}` : ''}）`);
      if (this.child === child) this.child = null;
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* 已经退出 */ }
    }
    // 手动起的/上次内核留下的孤儿也要能停掉：只认「PID 活着 + 心跳新鲜」的那个
    const pid = this.externalPid();
    if (pid) {
      try { process.kill(pid); } catch { /* ignore */ }
    }
  }
}
