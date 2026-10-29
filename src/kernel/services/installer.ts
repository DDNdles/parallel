/**
 * 首次安装的一键初始化（POST /api/setup/install-all 的后端）。
 *
 * 目标：新机器上点一次「立即安装」，把能自动化的依赖全部装好；装不了的（缺 winget、要重启、
 * 要进 UAC 点一下）如实标成「需要你处理」，不假装成功、也不卡住后面。
 *
 * 分工：
 *  - ffmpeg / 协议端发行包 = 内核自己下载（前者解出 exe，后者解包就位），全程静默；
 *  - Python / Git / QQ / Docker = 走 winget（`--silent`，可能弹 UAC 或安装窗口），装完轮询探测；
 *  - Node 与数据目录不代装：前者是内核运行的前提，后者多半是权限/磁盘问题，只能人来处理。
 *
 * 状态机是单例的：同一时间只跑一份，前端轮 GET 看进度；每步都有超时，不会把任务挂死。
 */
import { spawn } from 'node:child_process';
import { dockerDesktopExe, depsReady, invalidateDepCache, probeDep, probeDeps, type DepItem, type DepProbe } from './deps.ts';
import { fetchState, startDepFetch } from './downloads.ts';

export type InstallStepState = 'queued' | 'running' | 'waiting' | 'ok' | 'skipped' | 'failed' | 'manual';

export interface InstallStep {
  id: string;
  label: string;
  state: InstallStepState;
  /** 一句话说清"现在在做什么/为什么没装上" */
  detail: string;
  /** 0~100；未知进度（winget 安装、解包这类）给 null，前端画不定长效果 */
  percent: number | null;
}

export interface InstallJobView {
  running: boolean;
  startedAt: number;
  finishedAt: number;
  steps: InstallStep[];
  /** 收尾时重探的结果：必备项是否已齐 */
  ready: boolean;
  error: string;
}

export interface InstallerCtx {
  dataDir: string;
  /** 每次现取探测上下文（协议端 flavor / 有头模式可能在别处被改） */
  probeCtx: () => DepProbe;
  /** 只补协议端发行包（不拉起进程）；没托管协议端的内核不给 */
  ensureEnd?: () => Promise<void>;
  /** 全量探测（默认 probeDeps(probeCtx, true)；测试注入） */
  probeAll?: () => Promise<DepItem[]>;
  /** 单项探测（默认 probeDep(id, probeCtx)；测试注入） */
  probeOne?: (id: string) => Promise<DepItem>;
  /** winget 可用性（默认实测；测试注入） */
  hasWinget?: () => Promise<boolean>;
  /** 跑一条命令（默认 spawn + 收集输出；测试注入假实现） */
  exec?: (bin: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; out: string }>;
  /** 拉起 Docker Desktop（默认 detached 启动；测试注入空实现） */
  launchDocker?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 展示/执行顺序：先快后慢，让第一屏很快见到绿色 */
const ORDER = ['node', 'data', 'ffmpeg', 'python', 'bash', 'qq', 'llbot', 'docker'] as const;

/** 首次快照的兜底名字：探测回来之前前端就能显示中文（协议端名字随后由探测结果覆盖） */
const LABELS: Record<string, string> = {
  node: 'Node.js', data: '数据目录', ffmpeg: 'ffmpeg', python: 'Python',
  bash: 'Bash', qq: 'QQNT 客户端', llbot: '协议端', docker: 'Docker',
};

/** 走 winget 的那几项（id → 包 id）。Node 与数据目录没有 winget 可代装。 */
const WINGET_PKG: Record<string, string> = {
  python: 'Python.Python.3.13',
  bash: 'Git.Git',
  qq: 'Tencent.QQ.NT',
  docker: 'Docker.DockerDesktop',
};

const WINGET_TIMEOUT_MS = 20 * 60_000;
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const END_TIMEOUT_MS = 20 * 60_000;
const PROBE_WAIT_MS = 3 * 60_000;
const DOCKER_BOOT_MS = 4 * 60_000;

let job: InstallJobView | null = null;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 当前/上一次任务的快照（前端轮询用）；没跑过返回 null */
export function installJobView(): InstallJobView | null {
  return job;
}

/** 测试用：清掉单例，避免用例之间互相污染 */
export function resetInstallJob(): void {
  job = null;
}

/**
 * 起一轮一键安装。已在跑就直接返回同一份任务（幂等：双击/两个标签页不会装两遍）。
 * 立即返回，真正的安装跑在后台。
 */
export function startInstallAll(ctx: InstallerCtx): InstallJobView {
  if (job?.running) return job;
  const view: InstallJobView = {
    running: true,
    startedAt: ctx.now?.() ?? Date.now(),
    finishedAt: 0,
    steps: ORDER.map((id) => ({ id, label: LABELS[id] ?? id, state: 'queued', detail: '等待安装', percent: null })),
    ready: false,
    error: '',
  };
  job = view;
  void runJob(ctx, view)
    .catch((e) => { view.error = (e as Error).message; })
    .finally(() => {
      view.running = false;
      view.finishedAt = ctx.now?.() ?? Date.now();
    });
  return view;
}

/** 探测入口：正式路径走 deps.ts，测试可以整段换掉（不碰本机 winget/docker） */
function probeAllOf(ctx: InstallerCtx): Promise<DepItem[]> {
  return ctx.probeAll ? ctx.probeAll() : probeDeps(ctx.probeCtx(), true);
}
function probeOneOf(ctx: InstallerCtx, id: string): Promise<DepItem> {
  return ctx.probeOne ? ctx.probeOne(id) : probeDep(id, ctx.probeCtx());
}

async function runJob(ctx: InstallerCtx, view: InstallJobView): Promise<void> {
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? realSleep;
  const first = await probeAllOf(ctx);
  applyProbe(view, first);
  for (const step of view.steps) {
    if (step.state === 'ok') continue;            // 已经装好的不重装
    try {
      await installOne(ctx, step, { now, sleep });
    } catch (e) {
      step.state = 'failed';
      step.detail = `安装失败：${(e as Error).message}`.slice(0, 200);
    }
  }
  // 收尾重探一次：winget 装完但 PATH 尚未刷新、或安装器异步落盘，都靠这一次拍板
  const final = await probeAllOf(ctx);
  applyProbe(view, final);
  view.ready = depsReady(final);
  invalidateDepCache();
}

/** 把探测结果同步进任务：只把「已就绪」抬成 ok，绝不把已经失败的步骤改回等待 */
function applyProbe(view: InstallJobView, items: DepItem[]): void {
  for (const step of view.steps) {
    const it = items.find((x) => x.id === step.id);
    if (!it) continue;
    step.label = it.label;
    if (it.state === 'ok') {
      step.state = 'ok';
      step.detail = it.detail;
      step.percent = 100;
    } else if (step.state === 'queued') {
      step.detail = it.state === 'idle' ? '已安装但未启动' : '待安装';
    }
  }
}

async function installOne(
  ctx: InstallerCtx,
  step: InstallStep,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  const probe = () => probeOneOf(ctx, step.id);
  const item = await probe();
  if (item.state === 'ok') { step.state = 'ok'; step.detail = item.detail; step.percent = 100; return; }

  switch (step.id) {
    case 'node':
      // 内核能跑起来就说明 Node 够用；真缺/版本低只能人来装
      step.state = 'manual';
      step.detail = item.detail || '需要 Node.js 24 或更新版本';
      return;
    case 'data':
      step.state = 'failed';
      step.detail = item.detail || '数据目录不可写';
      return;
    case 'ffmpeg':
      await installFfmpeg(ctx, step, clock);
      return;
    case 'llbot':
      await installEnd(ctx, step, clock);
      return;
    case 'python':
    case 'bash':
    case 'qq':
      await installSys(ctx, step, clock, { probe, item });
      return;
    case 'docker':
      await installDocker(ctx, step, clock, probe);
      return;
    default:
      step.state = 'skipped';
      step.detail = '没有这一项的自动安装方式';
  }
}

/** ffmpeg：内核代下 + 解包（downloads.ts 的白名单与校验都在那一层） */
async function installFfmpeg(ctx: InstallerCtx, step: InstallStep, clock: { now: () => number; sleep: (ms: number) => Promise<void> }): Promise<void> {
  step.state = 'running';
  step.detail = '正在下载 ffmpeg 并解压…';
  startDepFetch('ffmpeg', ctx.dataDir);
  const until = clock.now() + FFMPEG_TIMEOUT_MS;
  for (;;) {
    const st = fetchState('ffmpeg');
    if (st?.total) step.percent = Math.min(99, Math.round((st.bytes / st.total) * 100));
    if (st?.error) { step.state = 'failed'; step.detail = `下载失败：${st.error}`.slice(0, 200); step.percent = null; return; }
    if (st?.done) break;
    if (clock.now() > until) { step.state = 'failed'; step.detail = '下载超时'; step.percent = null; return; }
    await clock.sleep(800);
  }
  step.state = 'waiting';
  step.detail = '正在解压…';
  const it = await waitProbe(ctx, 'ffmpeg', 60_000, clock.sleep);
  settle(step, it, 'ffmpeg 解压后仍找不到可执行文件');
}

/** 协议端发行包：只下载解包，不拉起进程（拉起属于登录阶段） */
async function installEnd(ctx: InstallerCtx, step: InstallStep, clock: { now: () => number; sleep: (ms: number) => Promise<void> }): Promise<void> {
  if (!ctx.ensureEnd) { step.state = 'skipped'; step.detail = '本内核不托管协议端；请自行运行 OneBot 11 实现'; return; }
  step.state = 'running';
  step.detail = '正在下载协议端发行包（约 90MB）…';
  await withTimeout(ctx.ensureEnd(), END_TIMEOUT_MS, '发行包下载超时');
  step.state = 'waiting';
  step.detail = '正在解包…';
  const it = await waitProbe(ctx, 'llbot', 90_000, clock.sleep);
  settle(step, it, '发行包解包后仍找不到 llbot.exe');
}

/** Python / Git / QQ：winget 静默装，装完轮询探测（新 PATH 可能要等安装器落盘） */
async function installSys(
  ctx: InstallerCtx,
  step: InstallStep,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  o: { probe: () => Promise<DepItem>; item: DepItem },
): Promise<void> {
  // 无头直连不需要 QQNT：别为了一个用不上的东西硬装 200MB
  if (step.id === 'qq' && !o.item.required) {
    step.state = 'skipped';
    step.detail = '当前接入方式不需要 QQNT（无头直连）';
    return;
  }
  const pkg = WINGET_PKG[step.id];
  const has = ctx.hasWinget ? await ctx.hasWinget() : await defaultHasWinget(ctx);
  if (!has) {
    step.state = 'manual';
    step.detail = '这台机器没有 winget：点「官网」安装后回到这里重新检测';
    return;
  }
  step.state = 'running';
  step.detail = `正在通过 winget 安装 ${o.item.label}（可能弹出 UAC 或安装窗口）…`;
  const r = await runExec(ctx, 'winget', [
    'install', '--id', pkg, '--exact', '--silent',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
  ], WINGET_TIMEOUT_MS);
  // winget 对「已是最新/已安装」也可能返回非零：先看探测，别把成功的当失败
  const after = await o.probe();
  if (after.state === 'ok') { step.state = 'ok'; step.detail = after.detail; step.percent = 100; return; }
  if (!r.ok) {
    step.state = 'failed';
    step.detail = `安装失败：${lastLine(r.out) || 'winget 返回非零'}`.slice(0, 200);
    return;
  }
  step.state = 'waiting';
  step.detail = '安装完成，等待就绪…';
  const it = await waitProbe(ctx, step.id, PROBE_WAIT_MS, clock.sleep);
  settle(step, it, '装完后仍未探测到可执行文件：可能需要重开终端/重启内核');
}

/** Docker：装完还要把 Desktop 拉起来，等 daemon 应答 */
async function installDocker(
  ctx: InstallerCtx,
  step: InstallStep,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  probe: () => Promise<DepItem>,
): Promise<void> {
  const item = await probe();
  if (item.state === 'ok') { step.state = 'ok'; step.detail = item.detail; step.percent = 100; return; }
  if (item.state === 'missing') {
    const has = ctx.hasWinget ? await ctx.hasWinget() : await defaultHasWinget(ctx);
    if (!has) {
      step.state = 'manual';
      step.detail = '这台机器没有 winget：点「官网」安装 Docker Desktop 后回来重新检测';
      return;
    }
    step.state = 'running';
    step.detail = '正在通过 winget 安装 Docker Desktop（约 600MB，可能弹出 UAC）…';
    const r = await runExec(ctx, 'winget', [
      'install', '--id', WINGET_PKG.docker, '--exact', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
    ], WINGET_TIMEOUT_MS);
    if (!r.ok) {
      const after = await probe();
      if (after.state !== 'ok' && after.state !== 'idle') {
        step.state = 'failed';
        step.detail = `安装失败：${lastLine(r.out) || 'winget 返回非零'}`.slice(0, 200);
        return;
      }
    }
    step.state = 'waiting';
    step.detail = '安装完成，正在启动 Docker Desktop…';
  } else {
    step.state = 'waiting';
    step.detail = 'Docker 已安装但没启动，正在拉起 Docker Desktop…';
  }

  const launch = ctx.launchDocker ?? defaultLaunchDocker;
  let it = await waitProbe(ctx, 'docker', 45_000, clock.sleep);
  if (it.state !== 'ok') {
    if (!launch()) {
      step.state = 'manual';
      step.detail = '没找到 Docker Desktop：请手动启动它后回来重新检测';
      return;
    }
    it = await waitProbe(ctx, 'docker', DOCKER_BOOT_MS, clock.sleep);
  }
  settle(step, it, 'Docker Desktop 需要完成首次启动（WSL 初始化/重启）后才能用');
}

/** 轮询单项直到 ok 或超时；返回最后一次探测结果（永远有值） */async function waitProbe(
  ctx: InstallerCtx,
  id: string,
  budgetMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<DepItem> {
  const now = ctx.now ?? Date.now;
  const until = now() + budgetMs;
  let last = await probeOneOf(ctx, id);
  while (last.state !== 'ok' && now() < until) {
    await sleep(1500);
    last = await probeOneOf(ctx, id);
  }
  return last;
}

/** 把最后一次探测结果落进步骤：ok 就是成功，否则按失败/待处理写清楚 */
function settle(step: InstallStep, it: DepItem, fallback: string): void {
  if (it.state === 'ok') {
    step.state = 'ok';
    step.detail = it.detail;
    step.percent = 100;
    return;
  }
  // 装在但没跑起来（Docker 首次启动）：这一项需要人接手，不是"失败"
  step.state = it.state === 'idle' ? 'manual' : 'failed';
  step.detail = it.detail && it.detail !== '未安装' ? it.detail : fallback;
  step.percent = null;
}

async function defaultHasWinget(ctx: InstallerCtx): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const r = await runExec(ctx, 'winget', ['--version'], 15_000);
  return r.ok;
}

function runExec(ctx: InstallerCtx, bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  if (ctx.exec) return ctx.exec(bin, args, timeoutMs);
  return spawnCollect(bin, args, timeoutMs);
}

/** 跑一条命令并收集输出（截断到 64KB）；超时杀掉整棵进程树 */
function spawnCollect(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const cap = (s: string) => { if (out.length < 64 * 1024) out += s; };
    child.stdout?.on('data', (b) => cap(String(b)));
    child.stderr?.on('data', (b) => cap(String(b)));
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* 已经退了就忽略 */ }
      resolveP({ ok: false, out: `${out}\n（超时 ${Math.round(timeoutMs / 60_000)} 分钟）` });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolveP({ ok: false, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolveP({ ok: code === 0, out }); });
  });
}

function defaultLaunchDocker(): boolean {
  const exe = dockerDesktopExe();
  if (!exe) return false;
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 带超时的 await：计时器 unref + finally 清掉，别在装完之后留一个几十分钟的定时器吊着事件循环 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(msg)), ms);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** winget 输出里最后一行的正文（去掉 ANSI 与进度条残留） */
function lastLine(out: string): string {
  const clean = String(out ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((s) => s.replace(/[\u2580-\u259f\u2500-\u257f]+/g, '').trim())
    .filter(Boolean);
  return (clean[clean.length - 1] ?? '').slice(0, 160);
}
