import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { EndCheck, LoginQrcode, Logger, ProtocolEnd } from '../types.ts';
import { findQqInstallPath } from './deps.ts';
import { sha256File } from './integrity.ts';

/**
 * NapCat（NapCatQQ）内嵌托管：下载 Shell 发行包 → 预写 WebUI 与 ob11 网络配置 →
 * 用官方启动器同样的方式把 NapCat 注入本机 QQNT → 崩溃守护。
 *
 * 与 LLBot 的分工：两者对内核都只是 OneBot 11 反向 WS 的来源，差别只在"谁被拉起、谁出登录窗口"。
 * NapCat 走的是注入本机 QQ 客户端的路子（等价于官方 launcher-user.bat，但不 pause、不要求管理员），
 * 所以登录发生在 QQ 窗口里，内核不出二维码 —— fetchQrcode() 返回 null，登录页据此提示。
 *
 * 下面这些常量不是猜的，取自 v4.18.28 的 NapCat.Shell.Windows.Node.zip 实测：
 *   包内布局  node.exe / config.json / win64/ + napcat/{napcat.mjs, NapCatWinBootMain.exe,
 *             NapCatWinBootHook.dll, qqnt.json, config/, launcher*.bat}
 *   启动方式  NapCatWinBootMain.exe "<QQ.exe>" "<Hook.dll>" [-q <uin>]，
 *             配 NAPCAT_PATCH_PACKAGE / NAPCAT_LOAD_PATH / NAPCAT_INJECT_PATH /
 *                 NAPCAT_LAUNCHER_PATH / NAPCAT_MAIN_PATH 五个环境变量，
 *             其中 loadNapCat.js 由启动脚本现写：`(async () => {await import("file:///<napcat.mjs>")})()`
 *   配置落点  <shell>/config/onebot11[_<uin>].json（network.websocketClients）；
 *             WebUI 的 token 走环境变量 NAPCAT_WEBUI_SECRET_KEY（值存 <data>/napcat-webui-token.txt），
 *             不去改写用户的 webui.json 端口设置
 *   客户端键  name/enable/url/messagePostFormat/reportSelfMessage/reconnectInterval/token/debug/heartInterval
 */
const NAPCAT_VERSION = 'v4.18.28';
const ASSET_WIN = 'NapCat.Shell.Windows.Node.zip';   // 自带 node.exe（v22.11），不依赖使用者装了 Node

/** 内核写进 NapCat ob11 网络配置里那条反向 WS 客户端的名字（upsert 时按它认，别的一律不动） */
export const NAPCAT_CLIENT_NAME = 'parallel';

export function napcatWsClient(url: string, token: string) {
  return {
    name: NAPCAT_CLIENT_NAME,
    enable: true,
    url,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    reconnectInterval: 5000,
    token,
    debug: false,
    heartInterval: 30000,
  };
}

/** 只增改我们那条 websocketClients，保留用户在 WebUI 里配过的其它网络与顶层字段 */
export function mergeNapcatNetworkConfig(existing: unknown, client: ReturnType<typeof napcatWsClient>): Record<string, unknown> {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>;
  const net = (base.network && typeof base.network === 'object' ? base.network : {}) as Record<string, unknown>;
  const list = Array.isArray(net.websocketClients) ? net.websocketClients as Record<string, unknown>[] : [];
  const prev = list.find((c) => c?.name === client.name);
  const rest = list.filter((c) => c?.name !== client.name);
  return { ...base, network: { ...net, websocketClients: [...rest, { ...prev, ...client }] } };
}

/** 注入模式没有可代理的出码接口：登录发生在 QQ 窗口里，所以 fetchQrcode 恒为 null */

/** 端口上有没有人答话（任何 HTTP 响应都算——NapCat 没登录时控制台也会回页面） */
async function reachable(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/webui`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch { return false; }
}

export class NapCatManager implements ProtocolEnd {
  readonly id = 'napcat' as const;
  private child?: ChildProcess;
  private exitCount = 0;
  private lastExitAt = 0;
  private stopping = false;
  private lastError = '';
  /** 本次注入用的 QQ.exe（启动时定下来，状态行要如实报出到底注进了哪个客户端） */
  private qqUsed = '';
  log: Logger;

  constructor(
    private config: ConfigStore,
    private errors: ErrorCenter,
    loggerFactory: (name: string) => Logger,
    /** 反向 WS 那头的登录情况（NapCat 连上内核即代表 QQ 在线） */
    private selfInfo: () => { connected: boolean; selfId: string; nickname: string },
  ) {
    this.log = loggerFactory('napcat-manager');
  }

  private get cfg(): { webuiPort: number; qqPath?: string } {
    return (this.config.config.onebot as any).napcat ?? { webuiPort: 6099 };
  }

  running(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  homeDir(): string { return join(this.config.dataDir, 'napcat'); }
  /**
   * Shell 目录：Windows.Node 包把运行时放在 napcat/ 子目录下（根目录另有 node.exe 与自带 QQ 运行环境），
   * 而通用 NapCat.Shell.zip 是平铺布局 —— 两种都认，按 napcat.mjs 实际落在哪儿判定。
   */
  private shellDir(): string {
    const nested = join(this.homeDir(), 'napcat');
    if (existsSync(join(nested, 'napcat.mjs'))) return nested;
    return existsSync(join(this.homeDir(), 'napcat.mjs')) ? this.homeDir() : nested;
  }
  private configDir(): string { return join(this.shellDir(), 'config'); }
  private bootExe(): string { return join(this.shellDir(), 'NapCatWinBootMain.exe'); }
  private hookDll(): string { return join(this.shellDir(), 'NapCatWinBootHook.dll'); }
  private mainMjs(): string { return join(this.shellDir(), 'napcat.mjs'); }
  private loadScript(): string { return join(this.shellDir(), 'loadNapCat.js'); }
  private tokenFile(): string { return join(this.config.dataDir, 'napcat-webui-token.txt'); }

  /** WebUI 地址：NapCat 的控制台页要求带 token，token 由内核首次托管时定下并复用 */
  webuiUrl(): string {
    return `${this.webuiBase()}/webui?token=${this.webuiToken()}`;
  }

  private webuiBase(): string {
    return `http://127.0.0.1:${this.cfg.webuiPort || 6099}`;
  }

  /** 固定 token 经 NAPCAT_WEBUI_SECRET_KEY 注入（NapCat 会在启动时改写 webui.json），不去覆盖用户的端口设置 */
  private webuiToken(): string {
    const p = this.tokenFile();
    try {
      const cur = readFileSync(p, 'utf-8').trim();
      if (cur) return cur;
    } catch { /* 首次 */ }
    const t = randomBytes(6).toString('hex');
    try { writeFileSync(p, t, 'utf-8'); } catch { /* 读不到就用临时值，下次再生成 */ }
    return t;
  }

  downloaded(): boolean { return existsSync(this.bootExe()) && existsSync(this.mainMjs()); }

  status(): Record<string, unknown> {
    const self = this.selfInfo();
    return {
      running: this.running(),
      pid: this.child?.pid,
      home: this.homeDir(),
      webuiUrl: this.webuiUrl(),
      downloaded: this.downloaded(),
      restarts: this.exitCount,
      version: NAPCAT_VERSION,
      error: this.lastError,
      qqPath: this.qqUsed,
      online: self.connected,
      uin: self.selfId,
      expectedQq: String(this.config.config.ui.expectedQq || ''),
    };
  }

  /** 完整性与可用性逐项实测：状态由前面的点表示，详情只放值本身 */
  async check(): Promise<EndCheck[]> {
    const out: EndCheck[] = [];
    out.push(this.downloaded()
      ? { state: 'pass', label: '发行包', detail: `${this.shellDir()}（${NAPCAT_VERSION}）` }
      : { state: 'warn', label: '发行包', detail: `未下载：${this.homeDir()}` });
    const qq = await this.resolveQQPath();
    out.push(qq
      ? { state: 'pass', label: '注入目标', detail: qq }
      : { state: 'fail', label: '注入目标', detail: '没探到 QQNT：在 data/config.json 的 onebot.napcat.qqPath 填 QQ.exe 路径' });
    out.push(this.running()
      ? { state: 'pass', label: '进程', detail: `pid=${this.child?.pid}` }
      : { state: 'fail', label: '进程', detail: this.lastError || '未运行' });
    const reach = await reachable(this.webuiBase());
    const self = this.selfInfo();
    out.push(reach
      ? { state: self.connected ? 'pass' : 'warn', label: '控制台', detail: this.webuiUrl() }
      : { state: 'fail', label: '控制台', detail: `打不开：${this.webuiBase()}` });
    return out;
  }

  /** 注入模式在 QQ 客户端窗口里扫码，内核没有可代理的出码接口 */
  async fetchQrcode(): Promise<LoginQrcode | null> { return null; }

  async loginInfo(): Promise<{ online: boolean; uin: string; nick: string } | null> {
    const s = this.selfInfo();
    return { online: s.connected, uin: s.selfId, nick: s.nickname };
  }

  /** 启动托管：备好目录/发行包/配置后注入拉起。幂等。 */
  async start(): Promise<void> {
    if (this.running()) return;
    if (process.platform !== 'win32') {
      this.lastError = 'NapCat 托管目前只支持 Windows（注入本机 QQNT）；其它平台请自行运行 NapCat 并把反向 WS 指向内核。';
      this.errors.record('warn', 'adapter', this.lastError);
      return;
    }
    this.stopping = false;
    mkdirSync(this.configDir(), { recursive: true });
    if (!this.downloaded()) await this.downloadAndExtract();
    if (!this.downloaded()) {
      this.lastError = `NapCat 未就绪：解压后找不到 NapCatWinBootMain.exe 或 napcat.mjs（${this.shellDir()}）`;
      this.errors.record('error', 'adapter', this.lastError, { notifyOwner: true });
      return;
    }
    const qq = await this.resolveQQPath();
    if (!qq) {
      this.lastError = '没找到本机 QQ：请在 data/config.json 的 onebot.napcat.qqPath 填入 QQ.exe 路径（NapCat 要注入到 QQNT 进程里）。';
      this.errors.record('error', 'adapter', this.lastError, { notifyOwner: true });
      return;
    }
    this.qqUsed = qq;
    this.writeNetworkConfig();
    this.spawn(qq);
  }

  private spawn(qq: string): void {
    const env = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: join(this.shellDir(), 'qqnt.json'),
      NAPCAT_LOAD_PATH: this.loadScript(),
      NAPCAT_INJECT_PATH: this.hookDll(),
      NAPCAT_LAUNCHER_PATH: this.bootExe(),
      NAPCAT_MAIN_PATH: this.mainMjs(),
      NAPCAT_WEBUI_SECRET_KEY: this.webuiToken(),   // 固定控制台 token，NapCat 启动时自己写进 webui.json
    };
    writeFileSync(this.loadScript(), `(async () => {await import("file:///${this.mainMjs().replace(/\\/g, '/')}")})()\n`, 'utf-8');
    const uin = String(this.config.config.ui.expectedQq || this.config.config.ui.lastLogin?.qq || '').trim();
    const args = [qq, this.hookDll(), ...(uin && /^\d+$/.test(uin) ? ['-q', uin] : [])];
    this.log.info(`拉起 NapCat（注入 ${qq}）${uin ? `，快速登录 uin=${uin}` : '，未指定账号（在 QQ 窗口里扫码）'}`);
    this.child = spawn(this.bootExe(), args, { cwd: this.shellDir(), env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (d: Buffer) => this.logLine(d));
    this.child.stderr?.on('data', (d: Buffer) => this.logLine(d));
    this.child.on('exit', (code) => {
      this.child = undefined;
      if (this.stopping) return;
      this.exitCount++;
      const now = Date.now();
      if (now - this.lastExitAt > 30 * 60_000) this.exitCount = 1;
      this.lastExitAt = now;
      if (this.exitCount >= 5) {
        this.errors.record('error', 'adapter', `NapCat 连续退出 ${this.exitCount} 次，已停止自动重启（检查 QQ 是否被登录保护挡住、或 ${this.configDir()} 下的配置）`, { notifyOwner: true });
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.exitCount, 5));
      this.log.warn(`NapCat 退出（code=${code}），${Math.round(delay / 1000)}s 后重启（第 ${this.exitCount} 次）`);
      setTimeout(() => { if (!this.stopping) void this.start().catch(() => {}); }, delay);
    });
  }

  private logLine(d: Buffer): void {
    const line = d.toString().trim().split('\n')[0];
    if (line) this.log.info(`[napcat] ${line.slice(0, 200)}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const c = this.child;
    this.child = undefined;
    if (!c) return;
    await new Promise<void>((resolveP) => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolveP(); }, 5000);
      c.once('exit', () => { clearTimeout(t); resolveP(); });
      try { c.kill(); } catch { /* ignore */ }
    });
  }

  private writeNetworkConfig(): void {
    const url = `ws://${this.config.config.onebot.host}:${this.config.config.onebot.port}${this.config.config.onebot.reverseWsPath}`;
    const client = napcatWsClient(url, this.config.secrets.onebotAccessToken || '');
    const names = ['onebot11.json', ...readdirSync(this.configDir()).filter((n) => /^onebot11_.+\.json$/.test(n))];
    for (const name of names) {
      const p = join(this.configDir(), name);
      let cur: unknown = {};
      try { cur = JSON.parse(readFileSync(p, 'utf-8')); } catch { cur = {}; }
      writeFileSync(p, JSON.stringify(mergeNapcatNetworkConfig(cur, client), null, 2));
      this.log.info(`已写入 NapCat 反向 WS 配置: ${p}`);
    }
  }

  /** QQ 路径：配置优先，其次照官方启动脚本读注册表，最后试几个默认安装位（与有头模式同一套探测） */
  private async resolveQQPath(): Promise<string> {
    return findQqInstallPath(String(this.cfg.qqPath || '').trim());
  }

  /** 下载发行包（约 117MB，自带 Node 运行时）并解压到 home */
  private async downloadAndExtract(): Promise<void> {
    const asset = ASSET_WIN;
    // 官方 Release API 的 asset digest：升级 NAPCAT_VERSION 必须同时更新它
    const expectedSha256 = 'fb64fa3b036ad2df1a5d7c204c482694c20e4b763978c8a4968fd3474c05b4a8';
    const rel = `https://github.com/NapNeko/NapCatQQ/releases/download/${NAPCAT_VERSION}/${asset}`;
    const home = this.homeDir();
    const zipPath = join(home, asset);
    let lastErr = '';
    let ok = false;
    // 官方源优先；镜像只作备用
    for (const url of [rel, `https://gh-proxy.com/${rel}`, `https://ghfast.top/${rel}`]) {
      try {
        this.log.info(`下载 NapCat ${NAPCAT_VERSION}: ${url.split('/releases/')[0]}…（约 117MB）`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 600_000);
        try {
          const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(zipPath));
        } finally { clearTimeout(timer); }
        // 解压前校验：注入用的 DLL/EXE 被换掉等于把整台机器交出去
        const got = await sha256File(zipPath);
        if (got !== expectedSha256) {
          rmSync(zipPath, { force: true });
          throw new Error(`SHA256 校验失败（期望 ${expectedSha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
        }
        ok = true;
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        this.log.warn(`NapCat 下载失败（${lastErr}），尝试下一个源…`);
      }
    }
    if (!ok) {
      const msg = `NapCat 下载失败（${lastErr}）。可手动下载 ${asset}（releases ${NAPCAT_VERSION}，已校验官方 SHA256）解压到 ${home}，然后重启内核。`;
      this.errors.record('error', 'adapter', msg, { notifyOwner: true });
      throw new Error(msg);
    }
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await new Promise<void>((resolveP, reject) => execFile(tar, ['-xf', zipPath, '-C', home], (e) => (e ? reject(e) : resolveP())));
    rmSync(zipPath, { force: true });
    this.log.info('NapCat 发行包就绪');
  }
}
