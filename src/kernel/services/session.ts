import { spawn, execFile } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import type { ErrorCenter } from '../errors.ts';
import type { ConfigStore } from '../config.ts';
import type { ChatRef } from '../types.ts';
import { nowMs } from '../util/misc.ts';
import { PACKAGE_ROOT } from '../paths.ts';

/**
 * 会话容器管理器：为每个会话维持两类常驻容器。
 *
 *  compute：Python 会话容器（常驻 ipykernel，变量跨调用保留）；联网可配
 *  browser：有网的浏览器容器（常驻 Chromium，登录态/页面跨调用保留）
 *
 * 关键设计：控制通道走 `docker exec` + 容器内 loopback 桥，而不是端口映射 ——
 * 桥只监听 loopback、不映射端口，容器是否出网由启动参数单独决定（work 容器
 * 2026-10-24 起联网，sandbox.workNetwork 可关回 --network none），且在
 * Windows/Docker Desktop 上也能工作（无需宿主直连容器网络）。
 *
 * 生命周期：按需拉起；空闲超时回收；超过 maxPerHost 时按 LRU 回收。
 */
export class SessionContainers {
  private compute = new Map<string, { id: string; lastUse: number }>();
  private browse = new Map<string, { id: string; lastUse: number }>();
  private dockerBin = 'docker';
  private dockerReady: boolean | null = null;
  /** 自动构建现场（方案1，2026-10-25）：镜像缺失时后台 docker build；failed 后 10 分钟冷却防轮询风暴 */
  private builds = new Map<'compute' | 'browser', { status: 'building' | 'failed'; startedAt: number; log: string }>();
  private static BUILD_RETRY_MS = 10 * 60_000;

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

  /** 镜像名：compute 读 sandbox.session.image，browser 读 sandbox.browser.image；缺省两个内置镜像 */
  private imageOf(kind: 'compute' | 'browser'): string {
    if (kind === 'compute') return this.sandboxCfg.session?.image ?? 'parallel-sandbox-python:latest';
    return this.sandboxCfg.browser?.image ?? 'parallel-sandbox-browser:latest';
  }

  private dockerEnv(): NodeJS.ProcessEnv {
    if (process.platform !== 'win32') return process.env;
    const extra = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin');
    return { ...process.env, PATH: `${extra};${process.env.PATH ?? ''}` };
  }

  /** docker 可用性（异步探测 + 并发去重 + 30s 负缓存）。
   *  以前是 spawnSync：Docker Desktop 没起来时 `docker info` 会挂满 10s×2，
   *  每分钟的 sweep 直接把整个内核冻结二十秒。 */
  private dockerProbe: Promise<string | null> | null = null;
  private dockerFailAt = 0;
  private async ensureDocker(): Promise<string | null> {
    if (this.dockerReady === true) return this.dockerBin;
    if (this.dockerReady === false) {
      if (nowMs() - this.dockerFailAt < 30_000) return null; // 刚失败过：别每个 sweep 都重打十分钟
      this.dockerReady = null;
    }
    if (this.dockerProbe) return this.dockerProbe;
    this.dockerProbe = (async () => {
      const candidates = process.platform === 'win32'
        ? ['docker', join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
        : ['docker'];
      this.dockerReady = false;
      for (const bin of candidates) {
        try {
          const r = await dockerExec(bin, ['info', '--format', 'ok'], 10_000, this.dockerEnv());
          if (r.ok) { this.dockerBin = bin; this.dockerReady = true; return bin; }
        } catch { /* 下一个候选 */ }
      }
      this.dockerFailAt = nowMs();
      return null;
    })().finally(() => { this.dockerProbe = null; });
    return this.dockerProbe;
  }

  async available(): Promise<boolean> {
    return (await this.ensureDocker()) !== null;
  }

  /** 镜像是否已在本地（docker image inspect 现场探测；60s 缓存，桌面端 8s 轮询别每次都打 docker） */
  private imageCache = new Map<string, { ok: boolean; at: number }>();

  async imagesAvailable(): Promise<{
    python: boolean; browser: boolean;
    build?: { python?: 'building' | 'failed'; browser?: 'building' | 'failed' };
  }> {
    const bin = await this.ensureDocker();
    if (!bin) return { python: false, browser: false };
    const probe = async (kind: 'compute' | 'browser'): Promise<boolean> => {
      const image = this.imageOf(kind);
      const hit = this.imageCache.get(image);
      if (hit && nowMs() - hit.at < 60_000) return hit.ok;
      const ok = (await dockerExec(bin, ['image', 'inspect', image], 15_000, this.dockerEnv())).ok;
      this.imageCache.set(image, { ok, at: nowMs() });
      if (!ok) void this.maybeAutoBuild(kind, bin);
      return ok;
    };
    const build: { python?: 'building' | 'failed'; browser?: 'building' | 'failed' } = {};
    const pc = this.builds.get('compute');
    if (pc) build.python = pc.status;
    const pb = this.builds.get('browser');
    if (pb) build.browser = pb.status;
    return { python: await probe('compute'), browser: await probe('browser'), build: Object.keys(build).length ? build : undefined };
  }

  /**
   * 镜像缺失时的自动构建（2026-10-25 分发方案1）：docker/ 目录随发布包走，
   * 新用户不用手工 build——首次探测不到就后台构建，工作页显示「构建中」，
   * 完成后镜像可用；失败进报错中心并冷却 10 分钟（轮询不会反复重试）。
   */
  async maybeAutoBuild(kind: 'compute' | 'browser', bin?: string): Promise<void> {
    const prev = this.builds.get(kind);
    if (prev?.status === 'building') return;
    if (prev?.status === 'failed' && nowMs() - prev.startedAt < SessionContainers.BUILD_RETRY_MS) return;
    const docker = bin ?? (await this.ensureDocker());
    if (!docker) return;
    const dir = join(PACKAGE_ROOT, 'docker', kind === 'compute' ? 'sandbox-python' : 'sandbox-browser');
    if (!existsSync(join(dir, 'Dockerfile'))) return;   // 发布环境没有 docker/ 目录：静默跳过
    const image = this.imageOf(kind);
    this.builds.set(kind, { status: 'building', startedAt: nowMs(), log: '' });
    this.errors.record('info' as any, 'sandbox', `沙箱镜像 ${image} 不在本地，开始自动构建（${dir}；首次要拉基础镜像，可能几分钟）`);
    const child = spawn(docker, ['build', '-t', image, dir], { windowsHide: true, env: this.dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onChunk = (c: Buffer) => { tail = (tail + c.toString('utf-8')).slice(-6000); };
    child.stdout!.on('data', onChunk);
    child.stderr!.on('data', onChunk);
    child.on('error', (e) => {
      this.builds.set(kind, { status: 'failed', startedAt: nowMs(), log: tail || e.message });
      this.errors.record('warn', 'sandbox', `沙箱镜像 ${image} 自动构建启动失败: ${e.message}`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        this.builds.delete(kind);
        this.imageCache.set(image, { ok: true, at: nowMs() });
        this.errors.record('info' as any, 'sandbox', `沙箱镜像 ${image} 自动构建完成`);
      } else {
        this.builds.set(kind, { status: 'failed', startedAt: nowMs(), log: tail });
        this.errors.record('warn', 'sandbox', `沙箱镜像 ${image} 自动构建失败（exit=${code}）：…${tail.slice(-400)}`);
      }
    });
  }

  /** 按镜像名请求构建（SandboxService 执行前发现镜像缺失时回调进来） */
  requestBuildForImage(image: string): void {
    const kind: 'compute' | 'browser' = image.includes('browser') ? 'browser' : 'compute';
    void this.maybeAutoBuild(kind);
  }

  /** 容器/挂载的唯一键：work 轮按发起人再分一层（与 SandboxService.chatKey 同口径） */
  private keyOf(chat: ChatRef): string {
    return `${chat.type}_${chat.chatId}${chat.scope ? `__${chat.scope}` : ''}`;
  }

  private hostMount(chat: ChatRef): string {
    const dir = resolve(join(this.dataDir, 'sandbox', this.keyOf(chat)));
    return dir.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `//${d.toLowerCase()}/`).replace(/\\/g, '/');
  }

  // ---------------- 容器生命周期 ----------------

  private async startContainer(kind: 'compute' | 'browser', chat: ChatRef): Promise<string> {
    const bin = await this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用（会话容器需要 Docker Desktop 运行中）');
    const image = this.imageOf(kind);
    const name = this.containerName(kind, chat);
    // 先清理同名残留（可能是异常退出留下的）
    await dockerExec(bin, ['rm', '-f', name], 20_000, this.dockerEnv());
    const args = [
      'run', '-d', '--name', name,
      // 与一次性容器同一套硬化：丢 capability、禁提权、限进程数。
      // Playwright 的 Chromium 在这种容器里实测可正常启动（它本来就要 --no-sandbox）。
      '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', kind === 'browser' ? '512' : '256',
      '-v', `${this.hostMount(chat)}:/ws`, '-w', '/ws',
      '--cpus', kind === 'browser' ? '2' : '1',
      // compute 提到 1g（2026-10-28）：512m 下排大文档时容器实测已用到 380MB 左右，留点余量
      '--memory', '1g',
    ];
    // compute 是 work 专用容器：默认联网（workNetworkOn），关了才 --network none
    if (kind === 'compute' && this.sandboxCfg.workNetwork === false) args.push('--network', 'none');
    // compute 容器也共享 pip 下载缓存（容器被 LRU 回收重建后 install 不用重新下载）
    if (kind === 'compute') args.push('-v', 'parallel-pip-cache:/root/.cache/pip');
    args.push(image);
    const r = await dockerExec(bin, args, 60_000, this.dockerEnv());
    if (!r.ok) throw new Error(`启动 ${kind} 容器失败：${r.stderr || r.stdout}`.slice(0, 400));
    const id = r.stdout.trim();
    // 等桥就绪（compute 需要起 kernel，给足时间）
    const ready = await this.waitBridge(bin, name, kind, kind === 'compute' ? 60_000 : 30_000);
    if (!ready) {
      await dockerExec(bin, ['rm', '-f', name], 20_000, this.dockerEnv());
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
      const r = await dockerExec(bin, probe, 15_000, this.dockerEnv());
      if (r.ok) return true;
      await new Promise((res) => setTimeout(res, 1200));
    }
    return false;
  }

  private containerName(kind: 'compute' | 'browser', chat: ChatRef): string {
    // 容器名带上作用域：同一个群里两位管理员的 work 容器必须能同时存在
    const key = this.keyOf(chat).replace(/[^A-Za-z0-9_.-]/g, '-');
    return `parallel-${kind}-${key}`.slice(0, 60);
  }

  /** 确保容器在跑（惰性拉起 + LRU 回收） */
  private async ensure(kind: 'compute' | 'browser', chat: ChatRef): Promise<string> {
    const bin = await this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用（会话容器需要 Docker Desktop 运行中）');
    const reg = kind === 'compute' ? this.compute : this.browse;
    const key = this.keyOf(chat);
    const entry = reg.get(key);
    if (entry) {
      const st = await dockerExec(bin, ['inspect', '-f', '{{.State.Running}}', entry.id], 15_000, this.dockerEnv());
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
    const bin = await this.ensureDocker();
    if (!bin) return;
    await dockerExec(bin, ['rm', '-f', idOrName], 30_000, this.dockerEnv());
    void kind;
  }

  /** 空闲回收（容器内 bridge 也有自杀死守；这里是宿主侧兜底） */
  async sweep(): Promise<void> {
    const bin = await this.ensureDocker();
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

  /** 会话沙箱被清空时，连带重置其容器（避免残留状态）；聊天级重置连按人分的 work 容器一起收 */
  async reset(chat: ChatRef): Promise<void> {
    const keys = chat.scope ? [this.keyOf(chat)] : [this.keyOf(chat), ...this.scopedKeysOf(chat)];
    for (const key of keys) {
      const c = this.compute.get(key);
      if (c) { await this.kill('compute', c.id); this.compute.delete(key); }
      const b = this.browse.get(key);
      if (b) { await this.kill('browser', b.id); this.browse.delete(key); }
    }
  }

  /** 聊天名下所有按发起人分的容器键（`<chat>__u<QQ>`） */
  private scopedKeysOf(chat: ChatRef): string[] {
    const prefix = `${chat.type}_${chat.chatId}__`;
    const keys = new Set<string>();
    for (const k of this.compute.keys()) if (k.startsWith(prefix)) keys.add(k);
    for (const k of this.browse.keys()) if (k.startsWith(prefix)) keys.add(k);
    return [...keys];
  }

  // ---------------- 执行（docker exec 驱动容器内桥） ----------------

  /** 在常驻 Python 会话容器里执行代码（变量跨调用保留） */
  async runPython(chat: ChatRef, code: string, timeoutMs: number, restart = false): Promise<{ status: string; outputs: any[]; executionCount?: number }> {
    const bin = await this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用');
    const id = await this.ensure('compute', chat);
    // 超时必须是个正数：调用方漏传时 Math.ceil(undefined/1000) 会变成 NaN，
    // JSON.stringify 把 NaN 写成 null，桥那头 int(None) 直接炸（实测）。
    const secs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 60;
    const payload = JSON.stringify({ code, timeout: secs, restart });
    // 宿主侧看门狗的等待也要有限值：timeoutMs 是 NaN 时 setTimeout(NaN) 会当成 0 立即触发，
    // 子进程还没回话就被 kill，报出来却是"无输出"（实测踩到，排查方向会被带偏）。
    const waitMs = (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : secs * 1000) + 20_000;
    const r = await spawnWithStdin(bin, ['exec', '-i', id, 'python', '/client.py'], payload, waitMs, this.dockerEnv());
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
    const bin = await this.ensureDocker();
    if (!bin) throw new Error('Docker 不可用');
    const id = await this.ensure('browser', chat);
    // 工具面叫 browser_open，桥（/opt/bridge/client.mjs）的动作名是 goto：
    // 直接把 open 发过去会被判成"未知动作"（2026-10-21 实测），这里收口一次。
    const wireAction = action === 'open' ? 'goto' : action;
    // file:// URL 指向宿主沙箱路径时，映射成容器里的 /ws/...：容器只挂了会话目录，
    // 宿主绝对路径在容器里不存在（实测 work 模型用 file:// 打开自己写的 HTML 会失败）。
    const fixed = { ...args };
    if (wireAction === 'goto' && typeof fixed.url === 'string') {
      const mapped = this.toContainerFileUrl(chat, fixed.url);
      if (mapped) fixed.url = mapped;
    }
    const payload = JSON.stringify({ action: wireAction, args: fixed, timeout: timeoutMs });
    // client.mjs 在镜像里是 /opt/bridge/client.mjs（Dockerfile 的 COPY 目标）。
    // 之前写成 /client.mjs，browser_* 全部报 "Cannot find module '/client.mjs'"——
    // 模型于是改去宿主机 PowerShell 拉起本机 Chrome，隔离被绕过（2026-10-19 实测抓到）。
    const r = await spawnWithStdin(bin, ['exec', '-i', id, 'node', '/opt/bridge/client.mjs'], payload, timeoutMs + 25_000, this.dockerEnv());
    try {
      const j = JSON.parse(r.stdout.trim());
      return { ok: !!j.ok, text: j.text, image: j.image, error: j.error };
    } catch {
      throw new Error(`浏览器容器返回无法解析：${(r.stdout || r.stderr).slice(0, 200)}`);
    }
  }

  /**
   * 宿主 `file://` 路径 → 容器内 `/ws` 路径（只映射本会话沙箱内的文件）。
   * 不在沙箱里、不是 file:// 协议、或路径解析失败时返回 undefined（原样交给浏览器）。
   */
  private toContainerFileUrl(chat: ChatRef, url: string): string | undefined {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return undefined; }
    if (parsed.protocol !== 'file:') return undefined;
    let hostFile: string;
    try { hostFile = decodeURIComponent(parsed.pathname); } catch { return undefined; }
    // Windows 上是 /C:/Users/...，去掉开头那个斜杠
    if (/^\/[A-Za-z]:\//.test(hostFile)) hostFile = hostFile.slice(1);
    const root = resolve(join(this.dataDir, 'sandbox', this.keyOf(chat)));
    const rel = relative(root, resolve(hostFile));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return `file:///ws/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
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

// ---------------- 低层进程工具（异步短命令 / 异步带 stdin） ----------------

interface SyncResult { ok: boolean; stdout: string; stderr: string }

/** 短 docker 命令一律异步：同步版会在 Docker 卡顿时冻结整个事件循环 */
function dockerExec(bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SyncResult> {
  return new Promise((resolveP) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, env, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolveP({
        ok: !err,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (err as Error | null)?.message ?? ''),
      });
    });
  });
}

function spawnWithStdin(bin: string, args: string[], stdin: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SyncResult> {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const CAP = 8 * 1024 * 1024; // 输出上限：别让一个失控的桥把内核内存吃满
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout!.on('data', (c: Buffer) => { if (stdout.length < CAP) stdout += c.toString('utf-8'); });
    child.stderr!.on('data', (c: Buffer) => { if (stderr.length < CAP) stderr += c.toString('utf-8'); });
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