import { spawn, execFile, type ChildProcess } from 'node:child_process';import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, renameSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { ConfigStore } from '../config.ts';
import type { ErrorCenter } from '../errors.ts';
import type { Bus } from '../bus.ts';
import { busEvents } from '../bus.ts';
import type { EndCheck, Logger, ProtocolEnd } from '../types.ts';
import { LlbotIdentity, parseLlbotLine } from './llbot-identity.ts';
import { sha256File } from './integrity.ts';

/**
 * 有头模式前置检查的判定（纯函数，便于测试）。
 * 背景（2026-09-16 实测）：PMHQ 会启动 QQ；如果 bot 自己的 QQ（独立档案）还没起来、而本机已经有
 * 别的 QQ 在跑，那次注入会落到**那个** QQ 上，并且 PMHQ 退出时会把该 QQ 一起带走 —— 第一次切有头
 * 模式时就是这样把使用者自己的 QQ 顶掉的（账号守卫拦住了发言，但客户端窗口被关了）。
 * 所以这种情况拒绝启动并说清怎么办；查不到进程（权限/平台）时 fail-open，别因为查询失败挡住 bot。
 */
export function pmhqPreflightVerdict(probe: { total: number; ours: number } | null, usesOwnProfile: boolean): string {
  if (!usesOwnProfile) return '';          // 明确用本机默认档案：运行中的 QQ 就是目标，无需让路
  if (!probe) return '';                   // 查询失败：放行
  if (probe.total === 0 || probe.ours > 0) return ''; // 本机没 QQ，或 bot 的 QQ 已在跑 → 都能安全拉起
  return `检测到本机还有别的 QQ 在运行，而有头模式的 PMHQ 首次注入会落到它上面、退出时还会把它一起关掉。` +
    `请先退出本机 QQ 再重启协议端；或把 data/config.json 的 onebot.llbot.qqProfileDir 设为 "-"，` +
    `明确让 bot 用本机默认档案（即接管你正在登录的那个号）。`;
}

/** 在线看门狗轮询间隔（够快发现掉线，又不至于频繁打扰 LLBot WebUI） */
const WATCH_INTERVAL_MS = 15_000;
/** 掉线后先观望这么久再自愈（区分「抖一下就回来」和「真掉了」） */
const RECOVER_DELAY_MS = 20_000;
/** 从没登录成功过、且二维码已用尽：等这么久还没人扫就重启一次把码续上 */
const QR_STALL_RECOVER_MS = 30 * 60_000;
/** 最近这么久之内有人拉过二维码 = 正在扫码，不要重启打断他 */
const QR_SCAN_QUIET_MS = 3 * 60_000;
/** LLBot 往终端打的 ASCII 二维码（纯块字符行），不落日志 */
const QR_ART_RE = /^[\s\u2500-\u257F\u2580-\u259F]+$/;

/**
 * LLBot 的使用授权页：签名服务（SignProxy）要一个 Auth Token，不是下载了就能登录 QQ。
 * 申请要在页面上说明用途，或进官方 QQ 群过审核 —— 所以「初始化」这一步只能把人送到门口，
 * 拿码那一下内核替不了（要人工填理由 + 等审核）。cf 接入点与国内镜像两个域名都给它。
 */
const LLBOT_AUTH_PAGE = 'https://auth.luckylillia.com';
const LLBOT_AUTH_PAGE_CN = 'https://llbot.wumiao.wang';
const LLBOT_QQ_GROUP = '545402644';
const LLBOT_QQ_GROUP_LINK = 'https://qm.qq.com/q/NsbdKiQ3eg';

/** 授权状态：本地文件那一半 + LLBot 控制台报的那一半（后者拿不到时 reachable=false） */
export interface LLBotAuthState {
  pageUrl: string; mirrorUrl: string; qqGroup: string; groupLink: string;
  tokenFile: string; hasToken: boolean;
  reachable: boolean; applicable: boolean; online: boolean;
  /** '' | idle | validating | valid | invalid | error（LLBot 自己的词表，原样透传） */
  validation: string; message: string; loginError: string;
}

/**
 * LLBot（LuckyLilliaBot）内嵌托管：自动下载 CLI 发行包 → 预写配置与 Auth Token →
 * 拉起 llbot.exe → 崩溃守护 → 经其 WebUI 代理登录二维码/登录状态。
 *
 * CLI 包不带 --pmhq-port 时走 Direct 模式：纯协议直连（native sign + TCP），无需 QQ 客户端；
 * Auth Token 即签名服务凭证，写入 data/auth_token.txt 后由官方 watcher 自动校验并触发登录。
 * 登录二维码由官方 WebUI 提供（GET /api/login-qrcode），鉴权用 X-Webui-Token = sha256(webui_token.txt)。
 *
 * 登录态守护（2026-09-16 加，见 reports/12）：Direct 模式下腾讯会周期性把会话判失效
 * （`[Kick] code=1001 下线通知` 或恢复时的 `retCode=-10003 身份验证失败`），LLBot 的既定反应是
 * 删 <data>/qq-session-<uin>.json + machine_guid.bin 换新设备身份重扫 —— 掉一次线就要人工扫一次码，
 * 而且每次都换设备身份等于反复以「新电脑」出现（本身就是风控信号）。这里做两件事：
 *   1. 钉住设备身份 + 备份会话（LlbotIdentity），掉线时能免扫码恢复；
 *   2. 在线看门狗：轮询 WebUI /api/login-info（ob11 反向 WS 连着不代表 QQ 在线），
 *      掉线立刻记因、上报报错中心，并在没人扫码时自愈重启（有会话→快速登录，无会话→出新码）。
 */
export class LLBotManager implements ProtocolEnd {
  readonly id = 'llbot' as const;
  private child?: ChildProcess;
  private exitCount = 0;
  private lastExitAt = 0;
  private stopping = false;
  /** 从 LLBot stdout 解析的实际 WebUI 端口（端口被占时其内部会自动顺延，不能只信配置） */
  private webuiPortActual = 0;
  /** 最近一次从 stdout 捕获的致命错误（签名 403 / 无 token 等），供登录页展示 */
  private lastError = '';
  /** 启动器报"未找到 QQ"（QQ 未装/正在更新）：这种情况不能再自动重试，见 spawn 的 exit 分支 */
  private qqMissing = false;
  /** 登录守护轮询句柄 */
  private loginWatchTimer?: ReturnType<typeof setInterval>;
  /** 在线看门狗句柄 */
  private watchTimer?: ReturnType<typeof setInterval>;
  /** 设备身份 + 会话备份（跨进程稳定，避免每次掉线变成一台新设备） */
  private identity: LlbotIdentity;
  /** LLBot 侧 QQ 是否在线（以 WebUI /api/login-info 为准，不是 ob11 反向 WS） */
  private online = false;
  private onlineUin = '';
  /** 掉线起点（用于判断是否够久该自愈） */
  private offlineSince = 0;
  /** 上一次自愈时间（冷却，避免反复重启） */
  private lastRecoverAt = 0;
  private recovering = false;
  /** 最近一次掉线原因（登录页据此解释「为什么突然要扫码」） */
  private lastDrop?: { desc: string; at: number };
  /** 内核最近一次向 LLBot 要二维码的时间（有人正在扫码时不要重启打断） */
  private lastQrFetchAt = 0;
  /** 本轮进程是否登录成功过（从没上过线 = 在等用户扫码，别去重启它） */
  private sawOnlineThisRun = false;
  /** 本轮掉线是否已自愈过（一波掉线只重启一次） */
  private recoveredThisEpisode = false;
  /**
   * 本轮掉线判为「人在 QQ 那边退出登录」（有头模式 + 没有踢线通知）。
   * 此时自愈 = PMHQ 带着 quick_login 又把号登回去，等于把用户的退出抹掉，登录门就永远关不住；
   * 所以停在离线，等桌面端登录门那颗「打开 QQNT」由人点。
   */
  private logoutByUser = false;
  /** 本轮 LLBot 里 PMHQ 是否报过「QQ 进程已退出」（= QQ 那边人为退的，不是崩溃） */
  private qqExited = false;
  /** LLBot 是否已耗尽自动刷新（10 张码），此后没人扫就停在死码上 */
  private qrExhausted = false;
  log: Logger;

  constructor(
    private config: ConfigStore,
    private errors: ErrorCenter,
    private bus: Bus,
    loggerFactory: (name: string) => Logger,
  ) {
    this.log = loggerFactory('llbot-manager');
    this.identity = new LlbotIdentity(join(config.dataDir, 'llbot-identity'), () => this.llbotDataDir());
  }

  private get cfg(): { webuiPort: number; mode?: 'pmhq' | 'direct'; qqPath?: string; qqProfileDir?: string } {
    return (this.config.config.onebot as any).llbot ?? { webuiPort: 5098, mode: 'pmhq' };
  }

  /** 接入方式：有头（PMHQ 注入本机 QQNT）/ 无头（纯协议直连） */
  mode(): 'pmhq' | 'direct' {
    return this.cfg.mode === 'direct' ? 'direct' : 'pmhq';
  }

  /** bot 专用 QQ 档案目录（有头模式：让 bot 的 QQ 实例跟你自己用的 QQ 各用各的档案） */
  qqProfileDir(): string {
    const raw = (this.cfg.qqProfileDir || '').trim();
    if (raw === '-') return '';                    // 明确要借用本机默认档案
    return raw || join(this.config.dataDir, 'qq-bot-profile');
  }

  status(): Record<string, unknown> {
    const id = this.identity.status();
    return {
      running: this.running(),
      pid: this.child?.pid,
      home: this.homeDir(),
      webuiUrl: this.webuiUrl(),
      downloaded: existsSync(this.exePath()),
      hasToken: !!this.config.secrets.llbotAuthToken,
      restarts: this.exitCount,
      mode: this.mode(),
      qqProfile: this.mode() === 'pmhq' ? (this.qqProfileDir() || '本机默认档案') : '',
      expectedQq: String(this.config.config.ui.expectedQq || ''),
      error: this.lastError,
      // 登录态守护（登录页据此解释掉线原因）
      online: this.online,
      uin: this.onlineUin,
      lastDrop: this.lastDrop,
      /** 判为在 QQ 客户端里退出了登录：已停止自动重登，等桌面端点「打开 QQNT」 */
      loggedOutByUser: this.logoutByUser || undefined,
      kickCode: id.lastKick?.code,
      kickDesc: id.lastKick?.desc,
      kicksInWindow: id.kicksInWindow,
      deviceId: id.deviceId ? id.deviceId.slice(0, 8) : '',
      savedSessions: id.sessions,
      recoveredAt: this.lastRecoverAt || undefined,
    };
  }

  /** 完整性与可用性逐项实测：状态由前面的点表示，详情只放值本身 */
  async check(): Promise<EndCheck[]> {
    const out: EndCheck[] = [];
    const exe = this.exePath();
    out.push(existsSync(exe)
      ? { state: 'pass', label: '发行包', detail: exe }
      : { state: 'warn', label: '发行包', detail: `未下载：${this.homeDir()}` });
    const uin = String(this.config.config.ui.expectedQq || '');
    if (this.mode() === 'pmhq') {
      out.push({ state: uin ? 'pass' : 'fail', label: '账号', detail: uin || '未设置：有头模式拒绝启动，免得顶掉你本机登录的号' });
    } else {
      const tok = !!this.config.secrets.llbotAuthToken;
      out.push({ state: tok ? 'pass' : 'fail', label: 'Auth Token', detail: tok ? 'secrets.json' : '未配置：无头模式无法签名登录' });
    }
    out.push(this.running()
      ? { state: 'pass', label: '进程', detail: `pid=${this.child?.pid}` }
      : { state: 'fail', label: '进程', detail: this.lastError || '未运行' });
    const li = await this.loginInfo().catch(() => null);
    out.push(li
      ? { state: li.online ? 'pass' : 'warn', label: '控制台', detail: this.webuiUrl() }
      : { state: 'fail', label: '控制台', detail: `打不开：${this.webuiUrl()}` });
    return out;
  }

  running(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  /** 托管根目录：<data>/llbot/（llbot.exe 与其 data/ 同层） */
  homeDir(): string {
    return join(this.config.dataDir, 'llbot');
  }

  /**
   * LLBot 的 DATA_DIR。CLI 包布局：根目录 llbot.exe 为 launcher，运行时在 bin/llbot/（node.exe + llbot.js），
   * 其 DATA_DIR = cwd 相对 data/ = <home>/bin/llbot/data（launcher 亦会把旧布局 <home>/data 迁过去）。
   */
  private llbotDataDir(): string {
    const runtime = join(this.homeDir(), 'bin', 'llbot');
    if (existsSync(runtime)) return join(runtime, 'data');
    return join(this.homeDir(), 'data');
  }

  private exePath(): string {
    return join(this.homeDir(), 'llbot.exe');
  }

  webuiUrl(): string {
    const port = this.webuiPortActual || this.cfg.webuiPort || 5098;
    return `http://127.0.0.1:${port}`;
  }

  /** 启动托管：准备目录/配置/token/发行包后拉起。幂等。 */
  async start(): Promise<void> {
    if (this.running()) return;
    // 发行包只有 win-x64：非 Windows 上先下 89MB 再解压失败，报错还会落在更晚的一步
    if (process.platform !== 'win32') {
      this.lastError = 'LLBot 内嵌托管目前只支持 Windows（发行包只有 win-x64）；其它平台请自行运行 OneBot 11 协议端，并把反向 WS 指向内核。';
      this.errors.record('warn', 'adapter', this.lastError);
      return;
    }
    this.stopping = false;
    this.sawOnlineThisRun = false;
    this.qrExhausted = false;
    const home = this.homeDir();
    mkdirSync(home, { recursive: true });
    mkdirSync(this.llbotDataDir(), { recursive: true });
    // 有头模式必须知道"这个 bot 该是哪个号"：PMHQ 寄生在本机 QQ 上，登着谁就顶着谁发言，
    // 没设预期账号就宁可不起（否则可能拿你自己的号去回别人的消息）。
    if (this.mode() === 'pmhq' && !String(this.config.config.ui.expectedQq || '').trim()) {
      this.lastError = '有头模式（PMHQ）未设置预期 bot 账号：请在 data/config.json 的 ui.expectedQq 填入本 bot 的 QQ 号后重启内核。';
      this.log.warn(this.lastError);
      this.errors.record('warn', 'adapter', this.lastError);
      return;
    }
    if (!existsSync(this.exePath())) {
      await this.downloadAndExtract(home);
    }
    if (this.mode() === 'pmhq') {
      const gate = await this.pmhqPreflight();
      if (gate) {
        this.lastError = gate;
        this.log.warn(gate);
        this.errors.record('warn', 'adapter', gate);
        return;
      }
      this.writePmhqConfig();
    } else {
      // 设备身份必须先于 LLBot 落盘：它启动时就把它读进 wtlogin/签名层，之后再改只影响文件的运行内副本。
      // 仅无头模式有意义 —— 有头模式的设备身份是本机 QQ 客户端自己的，别去动它。
      const pin = this.identity.pinGuid();
      if (pin === 'pinned') this.log.info(`设备身份已钉住: ${this.identity.deviceId().slice(0, 8)}…（避免每次掉线都被腾讯当成新设备）`);
      else if (pin === 'adopted') this.log.info(`接管现有设备身份: ${this.identity.deviceId().slice(0, 8)}…`);
    }
    this.writeAuthToken();
    this.writeWebuiToken();
    this.patchAccountConfigs(); // 重启场景：账号配置已存在则直接补丁
    this.cleanLegacyDataDir();
    this.spawn(home);
  }

  /**
   * 本机 QQ 进程盘点：总数 vs 带我们 bot 档案的。查不到（非 Windows / 无权限 / 超时）返回 null。
   * 用 PowerShell 是因为只靠 tasklist 拿不到命令行（拿不到命令行就分不清是哪个档案）。
   */
  private async probeQqProcesses(): Promise<{ total: number; ours: number } | null> {
    if (process.platform !== 'win32') return null;
    const profile = this.qqProfileDir();
    const script = `Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Select-Object -ExpandProperty CommandLine`;
    const out = await new Promise<string | null>((resolveP) => {
      execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 8000, windowsHide: true }, (e, stdout) =>
        resolveP(e ? null : String(stdout)));
    });
    if (out === null) return null;
    const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return { total: lines.length, ours: profile ? lines.filter((l) => l.includes(profile)).length : lines.length };
  }

  private async pmhqPreflight(): Promise<string> {
    const profile = this.qqProfileDir();
    const probe = await this.probeQqProcesses();
    return pmhqPreflightVerdict(probe, !!profile);
  }

  /**
   * 写 PMHQ 的配置 bin/pmhq/pmhq_config.json（有头模式）。
   * PMHQ 是独立项目（linyuchen/PMHQ，「Pure memory hook for QQNT」）：它注入本机 QQ 进程，
   * 把 QQ 的能力暴露成 127.0.0.1:13000 的 HTTP/WS API，LLBot 再经它通信。
   * 关键三项：qq_path（指向 QQ.exe）、quick_login_qq（自动登录本 bot 号）、auth_token（manager 鉴权，必填）。
   * qq_args 里塞 --user-data-dir，让 bot 的 QQ 走自己的档案目录，不干扰用户自己在用的 QQ。
   * 已存在的配置只做 upsert，保留用户手改的其它字段。
   */
  private writePmhqConfig(): void {
    const dir = join(this.homeDir(), 'bin', 'pmhq');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'pmhq_config.json');
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* 首次：用默认 */ }
    const uin = String(this.config.config.ui.expectedQq || this.config.config.ui.lastLogin?.qq || '').trim();
    const profile = this.qqProfileDir();
    const qqPath = (this.cfg.qqPath || '').trim();
    // qq_args 里我们只负责 --user-data-dir 这一段（档案隔离是本内核加的），其余手改参数原样保留；
    // 切回本机默认档案时要能把我们之前写的那段摘掉（否则残留会导致下次仍走 bot 档案）。
    const extraArgs = String(cfg.qq_args ?? '').replace(/--user-data-dir="[^"]*"\s*/g, '').trim();
    const merged = {
      default_host: '127.0.0.1',
      default_port: 13000,
      debug: false,
      qq_console: false,
      ...cfg,
      ...(qqPath ? { qq_path: qqPath } : {}),
      ...(uin ? { quick_login_qq: uin } : {}),
      auth_token: this.config.secrets.llbotAuthToken || '',
      qq_args: [profile ? `--user-data-dir="${profile}"` : '', extraArgs].filter(Boolean).join(' '),
    };
    writeFileSync(path, JSON.stringify(merged, null, 2));
    this.log.info(
      `已写入 PMHQ 配置: ${path}（QQ ${qqPath || '自动探测'}，自动登录 ${uin || '未指定'}，` +
      `档案 ${profile || '本机默认'}）`,
    );
  }

  /** Auth Token 写入 data/auth_token.txt（每次启动覆写，便于换 token 后立即生效） */
  private writeAuthToken(): void {
    const token = (this.config.secrets.llbotAuthToken || '').trim();
    if (!token) {
      this.log.warn('未配置 secrets.llbotAuthToken：LLBot 将无法登录 QQ，请在 data/secrets.json 填入');
      return;
    }
    writeFileSync(join(this.llbotDataDir(), 'auth_token.txt'), token, 'utf-8');
  }

  /** 授权页与群：LLBot 的签名 Auth Token 不是自助下载就有的，要先向作者申请（填用途，或进官方群过审） */
  authPage(): { pageUrl: string; mirrorUrl: string; qqGroup: string; groupLink: string } {
    return {
      pageUrl: LLBOT_AUTH_PAGE,
      mirrorUrl: LLBOT_AUTH_PAGE_CN,
      qqGroup: LLBOT_QQ_GROUP,
      groupLink: LLBOT_QQ_GROUP_LINK,
    };
  }

  /**
   * 授权状态：本地 token 文件 + LLBot 控制台报的校验态（它自己每 1s 轮询那个文件，写完不用重启）。
   * 控制台连不上时只回本地那半截并标 `reachable:false` —— 连不上不等于没授权，别说反。
   *
   * **前端刻意不接（2026-10-11 决定）**：LLBot 在有头（PMHQ）模式下自报 `applicable:false` ——
   * 本机真 QQ 自己签名，压根不需要这个 token，而项目已全面放弃无头模式。接口与测试留着，
   * 万一要回到无头直连，`GET|POST /api/setup/auth` 这套原样能用，别再从零摸一遍。
   */
  async authState(): Promise<LLBotAuthState> {
    const base = this.authPage();
    const file = join(this.llbotDataDir(), 'auth_token.txt');
    const out: LLBotAuthState = {
      ...base,
      tokenFile: file,
      hasToken: existsSync(file) || !!(this.config.secrets.llbotAuthToken || '').trim(),
      reachable: false,
      applicable: true,
      online: false,
      validation: '',
      message: '',
      loginError: '',
    };
    try {
      const resp = await fetch(`${this.webuiUrl()}/api/auth-token/status`, {
        headers: this.webuiAuthHeader(), signal: AbortSignal.timeout(4000),
      });
      const j = (await resp.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
      const d = j?.data;
      if (!resp.ok || !d) return out;
      out.reachable = true;
      out.applicable = d.applicable !== false;
      out.online = !!d.online;
      out.hasToken = !!d.hasToken || out.hasToken;
      out.validation = String(d.validation ?? '');
      out.message = String(d.message ?? '');
      out.loginError = String(d.loginError ?? '');
      if (typeof d.authTokenPageUrl === 'string' && d.authTokenPageUrl) out.pageUrl = d.authTokenPageUrl;
    } catch { /* 控制台没起来（协议端没跑 / 端口没定）：只报本地状态 */ }
    return out;
  }

  /**
   * 存授权 token：落 secrets.json 与 auth_token.txt，LLBot 下一次轮询就重新校验并登录。
   * 传空串 = 撤销：把文件删掉，否则它会一直拿旧 token 跑。
   */
  setAuthToken(token: string): void {
    const t = (token ?? '').trim();
    this.config.secrets.llbotAuthToken = t;
    this.config.saveSecrets();
    // 目录可能还没建（协议端从没启动过就贴 token 是常见路径）：先补上，别让写入抛 ENOENT
    if (t) {
      mkdirSync(this.llbotDataDir(), { recursive: true });
      writeFileSync(join(this.llbotDataDir(), 'auth_token.txt'), t, 'utf-8');
    } else {
      rmSync(join(this.llbotDataDir(), 'auth_token.txt'), { force: true });
    }
    // 日志里绝不出现 token 内容，只说长度：这东西能签名登录 QQ
    this.log.info(t ? `已写入 LLBot Auth Token（${t.length} 字符），等它自行校验` : '已清除 LLBot Auth Token');
  }

  /** WebUI 密码（明文存 data/webui_token.txt，LLBot 自管）；缺失时生成。内核调其 API 用 sha256 值鉴权 */
  private writeWebuiToken(): void {
    const p = join(this.llbotDataDir(), 'webui_token.txt');
    if (!existsSync(p)) writeFileSync(p, randomBytes(12).toString('hex'), 'utf-8');
  }

  /** sha256(webui_token.txt)，作为 X-Webui-Token 调 LLBot WebUI */
  private webuiAuthHeader(): Record<string, string> {
    try {
      const token = readFileSync(join(this.llbotDataDir(), 'webui_token.txt'), 'utf-8').trim();
      return { 'X-Webui-Token': createHash('sha256').update(token).digest('hex') };
    } catch {
      return {};
    }
  }

  /**
   * 补写 LLBot 的 ob11 反向 WS 配置。CLI 包会把内置默认强写到 default_config.json（webui 端口等改不动），
   * 但登录后生效的 config_<uin>.json 是官方文档认可的可改文件（watchFile 热重载），
   * ob11 适配器又在登录后才加载 —— 所以只在 config_<uin>.json 上补丁，且不碰 webui 块。
   */
  private patchAccountConfigs(): void {
    const dataDir = this.llbotDataDir();
    try {
      for (const f of readdirSync(dataDir)) {
        if (/^config_\d+\.json$/.test(f) && statSync(join(dataDir, f)).isFile()) {
          this.patchOb11Config(join(dataDir, f));
        }
      }
    } catch { /* data 目录未建 */ }
  }

  /** upsert ob11 ws-reverse（保留文件其余字段；官方 watchFile 1s 轮询 + 2s 防抖后热重载） */
  private patchOb11Config(cfgPath: string): void {
    let cfg: any = {};
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { return; }
    if (!cfg.ob11 || typeof cfg.ob11 !== 'object') cfg.ob11 = { enable: true, connect: [] };
    cfg.ob11.enable = true;
    if (!Array.isArray(cfg.ob11.connect)) cfg.ob11.connect = [];
    const ob = this.config.config.onebot;
    const revUrl = `ws://${ob.host}:${ob.port}${ob.reverseWsPath}`;
    let rev = (cfg.ob11.connect as any[]).find((c) => c?.type === 'ws-reverse');
    if (!rev) {
      rev = { type: 'ws-reverse' };
      cfg.ob11.connect.push(rev);
    }
    Object.assign(rev, {
      enable: true,
      url: revUrl,
      heartInterval: 60000,
      token: this.config.secrets.onebotAccessToken,
      reportSelfMessage: false,
      reportOfflineMessage: false,
      messageFormat: 'array',
      debug: false,
    });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    this.log.info(`已写入 LLBot ob11 反向 WS 配置: ${cfgPath}`);
  }

  /**
   * 登录守护循环：等 uin 出现（扫码确认）→ 等 config_<uin>.json 生成 → 补写 ob11 → 协议端反向 WS 连入内核。
   * 每 2s 轮询一次；运行期间只对每个 uin 补写一次。
   */
  private startLoginWatch(): void {
    if (this.loginWatchTimer) return;
    const patchedUins = new Set<string>();
    this.loginWatchTimer = setInterval(() => {
      if (!this.running()) return;
      this.loginInfo().then(async (li) => {
        if (!li?.uin || patchedUins.has(li.uin)) return;
        const cfgPath = join(this.llbotDataDir(), `config_${li.uin}.json`);
        if (!existsSync(cfgPath)) return; // 登录流程尚未写出账号配置
        await new Promise((r) => setTimeout(r, 2500)); // 让 LLBot 先写完整
        patchedUins.add(li.uin);
        this.patchOb11Config(cfgPath);
      }).catch(() => {});
    }, 2000);
  }

  /** launcher 会把旧布局 <home>/data 迁入 bin/llbot/data；迁移完成后清掉遗留目录避免两份状态 */
  private cleanLegacyDataDir(): void {
    const legacy = join(this.homeDir(), 'data');
    if (!existsSync(legacy) || legacy === this.llbotDataDir()) return;
    const known = new Set(['auth_token.txt', 'webui_token.txt', 'default_config.json', 'machine_guid.bin', 'database', 'logs', 'temp']);
    try {
      const entries = readdirSync(legacy);
      if (entries.some((e) => !known.has(e))) return; // 有不认识的文件，不动
      rmSync(legacy, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /** 下载发行包（win-x64 CLI，约 89MB，自带运行时无需 Node）并解压到 home */
  private async downloadAndExtract(home: string): Promise<void> {
    const version = 'v8.2.0'; // 锁定已验证版本；升级改这里
    const asset = `LLBot-CLI-win-x64.zip`;
    // 官方 Release API 的 asset digest：升级版本必须同时更新它（sha256sum 形态见发布页）
    const expectedSha256 = 'e05186e1cfc2c49d5cb8d577cdfd1a48d46dee020094e8424a1ddf8c78144a16';
    const rel = `https://github.com/LLOneBot/LuckyLilliaBot/releases/download/${version}/${asset}`;
    // 官方源优先；镜像只作备用（第三方镜像被投毒是真实威胁，不能放第一位）
    const mirrors = [
      rel,
      `https://gh-proxy.com/${rel}`,
      `https://ghfast.top/${rel}`,
    ];
    const zipPath = join(home, 'llbot.zip');
    let lastErr = '';
    let ok = false;
    for (const url of mirrors) {
      try {
        this.log.info(`下载 LLBot ${version}: ${url.split('/releases/')[0]}…（约 89MB）`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 300_000);
        try {
          const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          // 流式落盘：整体 arrayBuffer/writeFileSync 会一次性占内存并在慢盘上卡事件循环
          await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(zipPath));
        } finally {
          clearTimeout(timer);
        }
        // 解压执行前必须校验完整性：镜像/中间人换一个包等于在本机执行任意代码
        const got = await sha256File(zipPath);
        if (got !== expectedSha256) {
          rmSync(zipPath, { force: true });
          throw new Error(`SHA256 校验失败（期望 ${expectedSha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
        }
        ok = true;
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        this.log.warn(`下载失败（${lastErr}），尝试下一个源…`);
      }
    }
    if (!ok) {
      const msg = `LLBot 下载失败（${lastErr}）。可手动下载 ${asset}（releases ${version}，已校验官方 SHA256）解压到 ${home}，确保 llbot.exe 在该目录下，然后重启内核。`;
      this.errors.record('error', 'adapter', msg, { notifyOwner: true });
      throw new Error(msg);
    }
    // Windows 自带 bsdtar 解 zip（系统 PATH 里的 GNU tar 不行，用绝对路径）。
    // 必须异步：execFileSync 解压 89MB 包会阻塞事件循环数秒，e2e 首个 agent loop 回复会被卡到超时。
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await new Promise<void>((resolve, reject) => {
      execFile(tar, ['-xf', zipPath, '-C', home], (e) => (e ? reject(e) : resolve()));
    });
    rmSync(zipPath, { force: true });
    if (!existsSync(this.exePath())) {
      // 兼容包内多一层目录的情况：把 llbot.exe 上提到 home 根
      const found = this.findExe(home, 2);
      if (!found) throw new Error(`解压后未找到 llbot.exe（${home}）`);
      renameSync(found, this.exePath());
    }
    this.log.info('LLBot 发行包就绪');
  }

  private findExe(dir: string, depth: number): string | null {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).isFile() && name.toLowerCase() === 'llbot.exe') return p;
        if (depth > 0 && statSync(p).isDirectory()) {
          const hit = this.findExe(p, depth - 1);
          if (hit) return hit;
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  /**
   * 记住的账号：上次成功登录的 QQ 号。
   * - 无头模式：有会话文件时以 --qq=<uin> 启动，LLBot 走快速登录（qq-session-<uin>[-<protocol>].json 恢复，免扫码）。
   *   注意会话文件带协议后缀（linux 无后缀、windows/macos/watch 有），早期只认无后缀名，换协议就会误判成「无会话」。
   * - 有头模式：登录态在 QQ 客户端那边，这里只给 PMHQ 一个「自动登录哪个号」（quick_login_qq），不依赖会话文件。
   */
  private rememberedUin(): string {
    if (this.mode() === 'pmhq') {
      return String(this.config.config.ui.expectedQq || this.config.config.ui.lastLogin?.qq || '').trim();
    }
    try {
      const files = this.identity.liveSessions();
      const has = (uin: string) => files.some((f) => f === `qq-session-${uin}.json` || f.startsWith(`qq-session-${uin}-`));
      const last = this.config.config.ui.lastLogin?.qq;
      if (last && has(String(last))) return String(last);
      // 记的号和磁盘上对不上（或没有记录）时，只有唯一一份会话才敢直接用它，避免登错账号
      if (last) return '';
      const uins = [...new Set(files.map((f) => /^qq-session-(\d+)/.exec(f)?.[1] ?? '').filter(Boolean))];
      return uins.length === 1 ? uins[0] : '';
    } catch { /* ignore */ }
    return '';
  }

  private spawn(home: string): void {
    if (!existsSync(this.exePath())) {
      this.errors.record('error', 'adapter', `LLBot 启动中止：未找到 llbot.exe（${home}）`, { notifyOwner: true });
      return;
    }
    const uin = this.rememberedUin();
    // launcher（Rust）参数语法：--qq=<uin>（等号连写；-q 分离式不转发）；--pmhq 切到有头模式
    const mode = this.mode();
    const args = mode === 'pmhq' ? ['--pmhq'] : [];
    if (uin) args.push(`--qq=${uin}`);
    if (mode === 'pmhq') {
      const profile = this.qqProfileDir();
      this.log.info(
        `拉起 LLBot（有头模式 PMHQ）: ${home}` +
        `${uin ? `（自动登录 uin=${uin}）` : ''}（QQ 档案 ${profile || '本机默认'}）`,
      );
    } else {
      this.log.info(`拉起 LLBot（无头模式 Direct）: ${home}${uin ? `（快速登录 uin=${uin}）` : '（无已存会话，全新扫码）'}`);
    }
    this.webuiPortActual = 0;
    this.qqMissing = false;
    this.qqExited = false;
    this.child = spawn(this.exePath(), args, { cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    this.startLoginWatch();
    this.startOnlineWatch();
    // 两个流都要接：LLBot 的 [I] 走 stdout，而 [W]/[E]（含最关键的 [Kick] 与 Login failed）走 stderr
    this.child.stdout?.on('data', (d: Buffer) => this.handleLlbotOutput(d, 'stdout'));
    this.child.stderr?.on('data', (d: Buffer) => this.handleLlbotOutput(d, 'stderr'));
    this.child.stderr?.on('data', (d: Buffer) => this.log.warn(`[llbot] ${d.toString().trim().split('\n')[0].slice(0, 150)}`));
    this.child.on('exit', (code) => {
      this.child = undefined;
      if (this.stopping) return;
      if (this.qqMissing) {
        this.log.warn(this.lastError);
        this.errors.record('error', 'adapter', this.lastError, { notifyOwner: true });
        return;
      }
      // QQ 是自己退的（在 QQ 窗口里点了退出登录 / 关了 QQ）：这不是崩溃，自动重启 = PMHQ 又把 QQ 拉起来，
      // 用户的退出就被抹掉了。停在这里，等桌面端登录门那颗「打开 QQNT」。
      if (this.qqExited && this.mode() === 'pmhq') {
        this.logoutByUser = true;
        this.online = false;
        this.onlineUin = '';
        this.lastDrop = { desc: '在 QQ 里退出了登录', at: Date.now() };
        this.log.info('QQ 进程自行退出：不再自动拉起（要恢复请在桌面端点「打开 QQNT」）');
        this.errors.record('warn', 'adapter', 'QQ 已退出登录：parallel 不会自动把它拉起来，需要时在桌面端点「打开 QQNT」');
        return;
      }
      this.exitCount++;
      const now = Date.now();
      if (now - this.lastExitAt > 30 * 60_000) this.exitCount = 1;
      this.lastExitAt = now;
      if (this.exitCount >= 5) {
        this.errors.record('error', 'adapter', `LLBot 连续退出 ${this.exitCount} 次，已停止自动重启（请检查 ${home}/data/logs 与 Auth Token 有效性）`, { notifyOwner: true });
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.exitCount, 5));
      this.log.warn(`LLBot 退出（code=${code}），${Math.round(delay / 1000)}s 后自动重启（第 ${this.exitCount} 次）`);
      setTimeout(() => { if (!this.stopping) this.start().catch(() => {}); }, delay);
    });
    this.bus.emit(busEvents.adapterStatus, { llbotManaged: true, running: true, pid: this.child.pid });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.loginWatchTimer) { clearInterval(this.loginWatchTimer); this.loginWatchTimer = undefined; }
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = undefined; }
    this.online = false;
    this.onlineUin = '';
    // 显式停一次（登录门那颗「打开 QQNT」/ 切协议端 / 内核退出）= 有人接手了，解除「等人重登」的闸门
    this.logoutByUser = false;
    const c = this.child;
    if (!c) return;
    await new Promise<void>((resolveP) => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolveP(); }, 5000);
      c.once('exit', () => { clearTimeout(t); resolveP(); });
      try {
        // 有头模式下这棵树里还挂着 pmhq.exe 和 QQ.exe：只杀 llbot.exe 会漏掉它们，
        // 下次拉起时 PMHQ 会看到"QQ 已在跑"而注入不上（官方 FAQ 也提到 QQ 进程残留会让登录异常）。
        // taskkill /T 只杀本进程的后代，不会碰到用户自己开的那个 QQ 实例。
        if (process.platform === 'win32' && c.pid) {
          execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => { /* 进程已退时 taskkill 报错，忽略 */ });
        } else {
          c.kill();
        }
      } catch { clearTimeout(t); resolveP(); }
    });
    this.child = undefined;
  }

  // ---------- 登录态守护：踢下线记账 + 在线看门狗 + 掉线自愈 ----------

  /**
   * LLBot 输出处理。两个流都进来（见 spawn 的注释）：[W]/[E] 走 stderr，只盯 stdout 会漏掉每一次踢下线。
   * 终端那张 ASCII 二维码不落日志（几十行块字符，纯噪声）。
   */
  private handleLlbotOutput(d: Buffer, stream: 'stdout' | 'stderr'): void {
    const t = d.toString();
    // 解析实际 WebUI 端口（"Webui 服务器已启动 127.0.0.1:3081"）
    const m = t.match(/Webui[^\n]*?127\.0\.0\.1:(\d{2,5})/);
    if (m) {
      this.webuiPortActual = Number(m[1]);
      this.log.info(`LLBot WebUI 实际端口: ${this.webuiPortActual}`);
    }
    for (const raw of t.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // 终端二维码行（含着色的块字符）不落日志
      const printable = line.replace(/\u001b?\[[0-9;]*m/g, '').trim();
      // 登录态事件按去色后的文本判：ANSI 码可能夹在关键字中间
      if (printable) this.handleLlbotLine(printable);
      if (!printable || QR_ART_RE.test(printable)) continue;
      const text = `[llbot] ${printable.slice(0, 200)}`;
      if (stream === 'stderr') this.log.warn(text);
      else this.log.info(text);
    }
    // 捕获致命错误供登录页展示
    if (/FATAL auth failure|uin not in this token/i.test(t)) {
      this.lastError = '签名服务拒绝了本次登录：Auth Token 未绑定该 QQ 号（allowed_uins 不含此 uin）。请到 LLBot 管理端把该 QQ 号绑定进 token。';
    } else if (/auth_token 未配置/i.test(t)) {
      this.lastError = 'LLBot 未检测到 Auth Token（data/auth_token.txt 缺失或为空）。';
    } else if (/未找到 QQ/.test(t)) {
      // 启动器找不到本机 QQ（未装 / 正在更新）：它会问"是否下载并安装？(y/n)"，
      // 而我们没给它 stdin（ignore → 直接 EOF），继续重试等于放任它把本机 QQ 重装一遍。
      this.qqMissing = true;
      this.lastError = '协议端找不到本机 QQ（未安装或正在更新）。已停止自动重启：等 QQ 装好后在登录页点「打开 QQNT」或重启内核。';
    }
  }

  /** LLBot 单行输出 → 登录态事件。踢下线/凭证作废都是腾讯侧动作，这里只记账与告知，自愈交给看门狗。 */
  private handleLlbotLine(line: string): void {
    const ev = parseLlbotLine(line);
    if (!ev) return;
    if (ev.type === 'kick') {
      const kick = this.identity.noteKick(ev.code, ev.desc);
      this.lastError =
        ev.code === 1001
          ? `账号被 QQ 下线（code=1001）：${ev.desc || '你的账号当前登录已失效，请重新登录'}。请重新扫码登录。`
          : `协议端被 QQ 断开（code=${ev.code}）：${ev.desc}`;
      this.log.warn(`检测到踢下线：code=${kick.code} ${kick.desc}（6 小时内第 ${this.identity.kicksInWindow()} 次）`);
      return;
    }
    if (ev.type === 'session-invalid') {
      // 凭证被服务端判死：别再拿旧会话去撞（noteSessionInvalid 会连备份一起丢掉）
      this.identity.noteSessionInvalid(ev.reason);
      this.lastError = `登录凭证已失效：${ev.reason || '请重新扫码登录'}`;
      this.log.warn(`会话凭证已作废：${ev.reason}`);
      return;
    }
    if (ev.type === 'logged-in') {
      this.lastError = '';
      this.qrExhausted = false;
      return;
    }
    if (ev.type === 'login-failed') {
      // 扫码本身成功但 QQ 拒绝这次登录 —— 最常见是账号被风控（state=168 社交功能限制提醒）。
      // 这种情况重启/换设备身份都没用，必须去手机 QQ 按提示解除限制，所以直接把原话转述给用户。
      const restricted = ev.state === 168 || /社交功能限制|安全风险|恢复账号使用/.test(ev.message);
      this.lastError = restricted
        ? `QQ 拒绝登录（state=${ev.state}）：${ev.message || '账号存在安全风险'}。请用手机 QQ 登录该账号，按提示解除限制后再扫码。`
        : `QQ 拒绝登录（state=${ev.state}）：${ev.message || '请查看 LLBot 日志'}`;
      this.log.warn(this.lastError);
      this.errors.record('warn', 'adapter', this.lastError);
      return;
    }
    if (ev.type === 'qq-exited') {
      // 有头模式的人为退出信号：LLBot 随后会以 code=0 退出，exit 分支据此不再自动拉起 QQ
      this.qqExited = true;
      return;
    }
    if (ev.type === 'qr-exhausted') {
      this.qrExhausted = true;
      this.log.warn('LLBot 已停止自动刷新二维码（等登录页刷新，或看门狗在无人扫码时重启）');
    }
  }

  /**
   * 在线看门狗：ob11 反向 WS 连着 ≠ QQ 在线（掉线后 LLBot 仍照常上报 meta_event 心跳，
   * 实测正是这个假象让「离线一整天」没人发现），所以以 WebUI /api/login-info 为真值。
   */
  private startOnlineWatch(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => { this.tickOnlineWatch().catch(() => {}); }, WATCH_INTERVAL_MS);
  }

  private async tickOnlineWatch(): Promise<void> {
    if (!this.running() || this.stopping || this.recovering) return;
    const li = await this.loginInfo();
    if (!li) return; // WebUI 还没起来（或正在重启）：下一轮再看

    if (li.online) {
      const first = !this.online;
      this.online = true;
      this.onlineUin = li.uin || this.onlineUin;
      this.offlineSince = 0;
      this.recoveredThisEpisode = false;
      this.logoutByUser = false;
      this.sawOnlineThisRun = true;
      const deviceId = this.identity.adoptLiveGuid();
      const backed = this.identity.backupSessions();
      if (first) {
        this.lastError = '';
        this.identity.noteOnline();
        if (this.mode() === 'pmhq') {
          this.log.info(`QQ 已在线（uin=${li.uin || '?'}，有头模式：本机 QQ 客户端，档案 ${this.qqProfileDir() || '默认'}）`);
        } else {
          this.log.info(
            `QQ 已在线（uin=${li.uin || '?'}，设备身份 ${deviceId.slice(0, 8) || '未建立'}` +
            `${backed.length ? `，会话已备份 ${backed.join(', ')}` : '，暂无可备份会话'}）`,
          );
        }
      } else if (backed.length) {
        this.identity.noteOnline();
        this.log.info(`会话已更新备份：${backed.join(', ')}`);
      }
      return;
    }

    if (this.online) {
      const kick = this.identity.status().lastKick;
      // lastKick 是跨进程持久历史，只有「刚刚发生的」才能用来解释这次掉线，
      // 否则昨天那次被踢会把今天的人为退出误判成腾讯踢号（然后又被自动登回去）。
      const dropAt = Date.now();
      const kicked = !!kick && kick.at >= dropAt - 60_000;
      const desc = kicked ? `code=${kick!.code} ${kick!.desc}` : '与 QQ 的连接中断（未收到下线通知）';
      this.online = false;
      this.onlineUin = '';
      this.offlineSince = dropAt;
      this.recoveredThisEpisode = false;
      this.logoutByUser = !kicked && this.mode() === 'pmhq';
      this.lastDrop = { desc, at: this.offlineSince };
      this.log.warn(`QQ 掉线：${desc}`);
      if (this.logoutByUser) this.log.info('判为在 QQ 客户端侧退出登录：不再自动重登，需要在桌面端点「打开 QQNT」');
      // 掉线时发不出 QQ 消息，故用 warn 级（只进报错中心 + 登录页），不私聊主人
      this.errors.record('warn', 'adapter', `QQ 掉线：${desc}${this.logoutByUser ? '（已停止自动重登，需要时在桌面端点「打开 QQNT」）' : ''}`);
    } else if (!this.offlineSince) {
      this.offlineSince = Date.now();
    }

    if (this.recoveredThisEpisode || this.logoutByUser) return;
    // 「在线过然后掉了」= 真掉线，20s 内确认后自愈；
    // 「从没上过线」= 在等用户扫码，不动它 —— 除非二维码已用尽且长时间没人扫（否则会整夜停在死码上）
    const waitMs = this.sawOnlineThisRun ? RECOVER_DELAY_MS : this.qrExhausted ? QR_STALL_RECOVER_MS : Number.POSITIVE_INFINITY;
    if (Date.now() - this.offlineSince < waitMs) return;
    if (Date.now() - this.lastQrFetchAt < QR_SCAN_QUIET_MS) return; // 有人正在扫码，别重启打断
    await this.recover();
  }

  /**
   * 掉线自愈：先定设备身份，再重启 LLBot。
   * - 同一设备身份 6 小时内被踢 ≥2 次 → 认定身份已被腾讯标记，轮换一次（代价：重新扫码）；
   * - 否则保持同一身份，并把备份会话补回 LLBot 目录，让它带 --qq 快速登录（免扫码）。
   */
  private async recover(): Promise<void> {
    if (this.recovering || this.stopping) return;
    this.recovering = true;
    this.recoveredThisEpisode = true;
    this.lastRecoverAt = Date.now();
    try {
      if (this.mode() === 'pmhq') {
        // 有头模式的掉线基本是 QQ 客户端那边的事（退出/登出/网络）：重启整棵树，让 PMHQ 重新拉起 QQ 并自动登录
        this.log.info('掉线自愈：重启 LLBot（有头模式：一并重新拉起本机 QQ）');
      } else if (this.identity.shouldRotate()) {
        const n = this.identity.kicksInWindow();
        this.identity.rotate();
        this.log.warn(`设备身份 6 小时内被踢 ${n} 次，判定已被腾讯标记：轮换设备身份（需重新扫码）`);
        this.errors.record(
          'warn', 'adapter',
          `账号被连续下线 ${n} 次，已更换设备身份，请重新扫码登录。若换了身份仍频繁掉线，多半是腾讯对该账号的风控（LLBot 官方 issue #857 同类现象），需换号或改有头模式。`,
        );
      } else {
        const restored = this.identity.restoreSessionsIfLost();
        if (restored.length) this.log.info(`已从备份恢复会话：${restored.join(', ')}（尝试免扫码快速登录）`);
      }
      const uin = this.rememberedUin();
      this.log.info(`掉线自愈：重启 LLBot${uin ? `（快速登录 uin=${uin}）` : '（重新出二维码）'}`);
      await this.stop();
      await this.start();
    } catch (e) {
      this.log.warn(`掉线自愈失败：${(e as Error).message}`);
    } finally {
      this.recovering = false;
    }
  }

  // ---------- 官方 WebUI 代理（登录二维码 / 登录状态） ----------

  /** 登录二维码：GET /api/login-qrcode → { pngBase64QrcodeData, qrcodeUrl, expireTime(s), pollTimeInterval(ms) } */
  async fetchQrcode(): Promise<{ png: string; url: string; expireSec: number; pollMs: number } | null> {
    if (!this.running()) return null;
    // 记录有人在拉码：看门狗据此避开「用户正在扫码」的窗口（重启会作废他手上那张码）
    this.lastQrFetchAt = Date.now();
    try {
      const resp = await fetch(`${this.webuiUrl()}/api/login-qrcode`, {
        headers: this.webuiAuthHeader(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      const j = await resp.json() as { success?: boolean; data?: { pngBase64QrcodeData?: string; qrcodeUrl?: string; expireTime?: number; pollTimeInterval?: number } };
      const d = j?.data;
      if (!j?.success || !d?.pngBase64QrcodeData) return null;
      return {
        png: d.pngBase64QrcodeData,
        url: d.qrcodeUrl ?? '',
        expireSec: d.expireTime ?? 120,
        pollMs: d.pollTimeInterval ?? 2000,
      };
    } catch {
      return null;
    }
  }

  /** 登录状态：GET /api/login-info → { online, uin, nick, mode } */
  async loginInfo(): Promise<{ online: boolean; uin: string; nick: string } | null> {
    if (!this.running()) return null;
    try {
      const resp = await fetch(`${this.webuiUrl()}/api/login-info`, {
        headers: this.webuiAuthHeader(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      const j = await resp.json() as { success?: boolean; data?: { online?: boolean; uin?: string; nick?: string } };
      const d = j?.data;
      if (!j?.success || !d) return null;
      return { online: !!d.online, uin: d.uin ?? '', nick: d.nick ?? '' };
    } catch {
      return null;
    }
  }
}
