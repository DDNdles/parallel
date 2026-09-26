import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ErrorCenter } from '../errors.ts';
import type { ConfigStore } from '../config.ts';
import type { ChatRef } from '../types.ts';
import { nowMs } from '../util/misc.ts';

/**
 * 会话容器管理器：为每个会话维持两类常驻容器。
 *
 *  compute：--network none 的 Python 会话容器（常驻 ipykernel，变量跨调用保留）
 *  browser：有网的浏览器容器（常驻 Chromium，登录态/页面跨调用保留）
 *
 * 关键设计：控制通道走 `docker exec` + 容器内 loopback 桥，而不是端口映射 ——
 * 这样 compute 容器可以保持 --network none（没有任何出网路径），且在
 * Windows/Docker Desktop 上也能工作（无需宿主直连容器网络）。
 *
 * 生命周期：按需拉起；空闲超时回收；超过 maxPerHost 时按 LRU 回收。
 */
export class SessionContainers {
  private compute = new Map<string, { id: string; lastUse: number }>();
  private browse = new Map<string, { id: string; lastUse: number }>();
  private dockerBin = 'docker';
  private dockerReady: boolean | null = null;

  constructor(
    private dataDir: string,
    private config: ConfigStore,
    private errors: ErrorCenter,
  ) {
    const t = setInterval(() => this.sweep().catch(() => {}), 60_000);
    t.unref();
  }

  private get sandboxCfg(): any {
    return this.config.config.sandbox as any;
  }

  private dockerEnv(): NodeJS.ProcessEnv {
    if (process.platform !== 'win32') return process.env;
    const extra = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin');
    return { ...process.env, PATH: `${extra};${process.env.PATH ?? ''}` };
  }

  /** docker 可用性（带缓存；失败后下次调用会重新探测） */
  private ensureDocker(): string | null {
    if (this.dockerReady === false) this.dockerReady = null; // 允许重试
    if (this.dockerReady === null) {
      const candidates = process.platform === 'win32'
        ? ['docker', join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
        : ['docker'];
      this.dockerReady = false;
      for (const bin of candidates) {
        try {
          const r = spawnSync(bin, ['info', '--format', 'ok'], 10_000, this.dockerEnv());
          if (r.ok) { this.dockerBin = bin; this.dockerReady = true; break; }
        } catch { /* 下一个候选 */ }
      }
    }
    return this.dockerReady ? this.dockerBin : null;
  }

  available(): boolean {
    return this.ensureDocker() !== null;
  }

  private hostMount(chat: ChatRef): string {
    const dir = resolve(join(this.dataDir, 'sandbox', `${chat.type}_${chat.chatId}`));
    return dir.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `//${d.toLowerCase()}/`).replace(/\\/g, '/');
  }

  // ---------------- 容器生命周期 ----------------

  private async startContainer(kind: 'compute' | 'browser', chat: ChatRef): Promise<string> {
    const bin = this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用（会话容器需要 Docker Desktop 运行中）');
    const cfg = this.sandboxCfg[kind] ?? {};
    const image = cfg.image ?? (kind === 'compute' ? 'parallel-sandbox-python:latest' : 'parallel-sandbox-browser:latest');
    const name = `parallel-${kind}-${chat.type}-${chat.chatId}`.slice(0, 60);
    // 先清理同名残留（可能是异常退出留下的）
    spawnSync(bin, ['rm', '-f', name], 20_000, this.dockerEnv());
    const args = [
      'run', '-d', '--name', name,
      '-v', `${this.hostMount(chat)}:/ws`, '-w', '/ws',
      '--cpus', kind === 'browser' ? '2' : '1',
      '--memory', kind === 'browser' ? '1g' : '512m',
    ];
    if (kind === 'compute') args.push('--network', 'none');
    args.push(image);
    const r = spawnSync(bin, args, 60_000, this.dockerEnv());
    if (!r.ok) throw new Error(`启动 ${kind} 容器失败：${r.stderr || r.stdout}`.slice(0, 400));
    const id = r.stdout.trim();
    // 等桥就绪（compute 需要起 kernel，给足时间）
    const ready = await this.waitBridge(bin, name, kind, kind === 'compute' ? 60_000 : 30_000);
    if (!ready) {
      spawnSync(bin, ['rm', '-f', name], 20_000, this.dockerEnv());
      throw new Error(`${kind} 容器桥未就绪（超时）`);
    }
    return id;
  }

  /** 容器内 bridge 就绪探测（docker exec + curl 容器内 loopback） */
  private async waitBridge(bin: string, name: string, kind: 'compute' | 'browser', timeoutMs: number): Promise<boolean> {
    const port = kind === 'compute' ? 8899 : 8900;
    const probe = kind === 'compute'
      ? ['exec', name, 'python', '-c', `import urllib.request;urllib.request.urlopen("http://127.0.0.1:${port}/health",timeout=3)`]
      : ['exec', name, 'node', '-e', `fetch("http://127.0.0.1:${port}/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = spawnSync(bin, probe, 15_000, this.dockerEnv());
      if (r.ok) return true;
      await new Promise((res) => setTimeout(res, 1200));
    }
    return false;
  }

  private containerName(kind: 'compute' | 'browser', chat: ChatRef): string {
    return `parallel-${kind}-${chat.type}-${chat.chatId}`.slice(0, 60);
  }

  /** 确保容器在跑（惰性拉起 + LRU 回收） */
  private async ensure(kind: 'compute' | 'browser', chat: ChatRef): Promise<string> {
    const bin = this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用（会话容器需要 Docker Desktop 运行中）');
    const reg = kind === 'compute' ? this.compute : this.browse;
    const key = `${chat.type}_${chat.chatId}`;
    const entry = reg.get(key);
    if (entry) {
      const st = spawnSync(bin, ['inspect', '-f', '{{.State.Running}}', entry.id], 15_000, this.dockerEnv());
      if (st.ok && st.stdout.trim() === 'true') {
        entry.lastUse = nowMs();
        return entry.id;
      }
      reg.delete(key); // 已死，重建
    }
    await this.reapIfNeeded(kind);
    const id = await this.startContainer(kind, chat);
    reg.set(key, { id, lastUse: nowMs() });
    this.errors.record('info' as any, 'sandbox', `${kind} 会话容器已启动（${key}）`);
    return id;
  }

  /** 超过 maxPerHost 时回收最久未用的容器 */
  private async reapIfNeeded(kind: 'compute' | 'browser'): Promise<void> {
    const reg = kind === 'compute' ? this.compute : this.browse;
    const cap = Number(this.sandboxCfg[kind]?.maxPerHost ?? (kind === 'compute' ? 8 : 4));
    if (reg.size < cap) return;
    const sorted = [...reg.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [key, e] of sorted.slice(0, Math.max(1, reg.size - cap + 1))) {
      await this.kill(kind, e.id);
      reg.delete(key);
    }
  }

  private async kill(kind: 'compute' | 'browser', idOrName: string): Promise<void> {
    const bin = this.ensureDocker();
    if (!bin) return;
    spawnSync(bin, ['rm', '-f', idOrName], 30_000, this.dockerEnv());
    void kind;
  }

  /** 空闲回收（容器内 bridge 也有自杀死守；这里是宿主侧兜底） */
  async sweep(): Promise<void> {
    const bin = this.ensureDocker();
    if (!bin) return;
    const now = nowMs();
    for (const [kind, reg] of [['compute', this.compute], ['browser', this.browse]] as const) {
      const ttl = Number(this.sandboxCfg[kind]?.idleTtlMs ?? (kind === 'compute' ? 20 * 60_000 : 10 * 60_000));
      for (const [key, e] of [...reg.entries()]) {
        if (now - e.lastUse > ttl) {
          await this.kill(kind, e.id);
          reg.delete(key);
        }
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [, e] of [...this.compute.entries()]) await this.kill('compute', e.id);
    for (const [, e] of [...this.browse.entries()]) await this.kill('browser', e.id);
    this.compute.clear();
    this.browse.clear();
  }

  /** 会话沙箱被清空时，连带重置其容器（避免残留状态） */
  async reset(chat: ChatRef): Promise<void> {
    const key = `${chat.type}_${chat.chatId}`;
    const c = this.compute.get(key);
    if (c) { await this.kill('compute', c.id); this.compute.delete(key); }
    const b = this.browse.get(key);
    if (b) { await this.kill('browser', b.id); this.browse.delete(key); }
  }

  // ---------------- 执行（docker exec 驱动容器内桥） ----------------

  /** 在常驻 Python 会话容器里执行代码（变量跨调用保留） */
  async runPython(chat: ChatRef, code: string, timeoutMs: number, restart = false): Promise<{ status: string; outputs: any[]; executionCount?: number }> {
    const bin = this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用');
    const id = await this.ensure('compute', chat);
    const payload = JSON.stringify({ code, timeout: Math.ceil(timeoutMs / 1000), restart });
    const r = await spawnWithStdin(bin, ['exec', '-i', id, 'python', '/client.py'], payload, timeoutMs + 20_000, this.dockerEnv());
    if (!r.ok && !r.stdout.trim()) throw new Error(`会话容器执行失败：${r.stderr || '无输出'}`.slice(0, 300));
    try {
      const j = JSON.parse(r.stdout.trim());
      return { status: j.status ?? 'ok', outputs: j.outputs ?? [], executionCount: j.execution_count };
    } catch {
      throw new Error(`会话容器返回无法解析：${r.stdout.slice(0, 200)}`);
    }
  }

  /** 浏览器动作（页面/登录态跨调用保留） */
  async browserAction(chat: ChatRef, action: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ ok: boolean; text?: string; image?: string; error?: string }> {
    const bin = this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用');
    const id = await this.ensure('browser', chat);
    const payload = JSON.stringify({ action, args, timeout: timeoutMs });
    const r = await spawnWithStdin(bin, ['exec', '-i', id, 'node', '/client.mjs'], payload, timeoutMs + 25_000, this.dockerEnv());
    try {
      const j = JSON.parse(r.stdout.trim());
      return { ok: !!j.ok, text: j.text, image: j.image, error: j.error };
    } catch {
      throw new Error(`浏览器容器返回无法解析：${(r.stdout || r.stderr).slice(0, 200)}`);
    }
  }

  /** 状态汇总（桌面端展示） */
  status(): { kind: string; chat: string; id: string; idleMs: number }[] {
    const now = nowMs();
    const out: { kind: string; chat: string; id: string; idleMs: number }[] = [];
    for (const [key, e] of this.compute) out.push({ kind: 'compute', chat: key, id: e.id.slice(0, 12), idleMs: now - e.lastUse });
    for (const [key, e] of this.browse) out.push({ kind: 'browser', chat: key, id: e.id.slice(0, 12), idleMs: now - e.lastUse });
    return out;
  }
}

// ---------------- 低层进程工具（同步短命令 / 异步带 stdin） ----------------

interface SyncResult { ok: boolean; stdout: string; stderr: string }

function spawnSync(bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): SyncResult {
  // 用 spawnSync 的同步语义做短命令（inspect/rm/probe），避免异步竞态
  const r = nodeSpawnSync(bin, args, { timeout: timeoutMs, windowsHide: true, env, encoding: 'utf-8' });
  return { ok: r.status === 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
}

function spawnWithStdin(bin: string, args: string[], stdin: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SyncResult> {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ ok: code === 0, stdout, stderr });
    });
    child.stdin!.end(stdin, 'utf-8');
  });
}