/**
 * 运行环境依赖探测（初始页 /api/setup/deps 的后端）。
 *
 * 只回答三件事：**本机有没有、在哪/什么版本、缺了怎么拿**。
 * 缺一项给两个渠道：`install` = 让内核代下（协议端发行包下完就位；Docker 只把官方安装器拉到
 * data/downloads，装不装由人；ffmpeg 下完顺手解出 exe 到 data/bin），`download` = 官方页链接。
 * 探测本身不装任何东西、不写配置。所有探测并行跑，结果缓存 10 分钟：docker info 在 daemon 没起时
 * 能拖到超时，别每帧都探。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundledFfmpeg } from './downloads.ts';

export interface DepItem {
  id: string;
  label: string;
  /** 必备项没齐，初始页的「继续」不放行 */
  required: boolean;
  /** idle = 装了但没跑起来（Docker Desktop 没开）：既不是就绪，也不该让人重新下载 */
  state: 'ok' | 'idle' | 'missing';
  /** 版本、路径，或「装了但 daemon 没起」这类具体状况（页面上收在悬停提示里） */
  detail: string;
  /** 官方下载页（前端新标签打开）：与 install 同时给 = 两个渠道，点哪个都行 */
  download?: string;
  /** 由内核代下载（前端那颗「下载」钮走 POST /api/setup/install {id}）：
   *  llbot 是下载并解包就位，docker 是只把官方安装器拉到 data/downloads（装不装由人），ffmpeg 是下载并解出 exe */
  install?: 'llbot' | 'docker' | 'ffmpeg';
  /** 由内核拉起来（前端按钮走 POST /api/setup/start）：目前只有 Docker Desktop */
  launch?: 'docker';
}

export interface DepProbe {
  /** 内核数据目录（配置、库、QQ 登录态都落在这） */
  dataDir: string;
  /** 协议端接入方式：有头模式必须有本机 QQNT */
  headed: boolean;
  /** 当前托管的是哪一档协议端：这一项的名字、落点目录与官网链接全跟着它走，不许写死成 LLBot */
  endFlavor: 'llbot' | 'napcat';
  /** 协议端发行包是否已就位（来自 manager.status().downloaded） */
  endDownloaded: boolean;
  /** 反向 WS 已经连上：说明协议端在跑（可能是用户自己起的，本内核没下载过），不能算缺失 */
  endConnected: boolean;
  /** 配置里显式写死的 QQ.exe 路径（onebot.*.qqPath） */
  qqPathCfg: string;
}

/** 两档协议端对外的名字与去处（releases 链接取自内核实际下载用的那两个仓库，不是猜的） */
export const END_INFO: Record<'llbot' | 'napcat', { name: string; dir: string; releases: string }> = {
  llbot: { name: 'LuckyLillia', dir: 'data/llbot', releases: 'https://github.com/LLOneBot/LuckyLilliaBot/releases' },
  napcat: { name: 'NapCat', dir: 'data/napcat', releases: 'https://github.com/NapNeko/NapCatQQ/releases' },
};

const PROBE_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60_000;

let cache: { at: number; items: DepItem[] } | null = null;

/** 清掉探测缓存（重新检测按钮、以及测试里换环境后用） */
export function invalidateDepCache(): void { cache = null; }

interface RunResult { ok: boolean; /** 找不到可执行文件（区别于「找到了但跑失败」） */ notFound: boolean; out: string }
function run(bin: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolveP) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const first = `${stdout ?? ''}${stderr ?? ''}`.trim().split('\n')[0] ?? '';
      if (!err) return resolveP({ ok: true, notFound: false, out: first });
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      resolveP({ ok: false, notFound: e.code === 'ENOENT', out: first });
    });
  });
}

/** PATH 上的裸命令名到底解析到哪个文件（Store 的 python、WSL 的 bash 都可能截胡） */
async function resolveOnPath(name: string): Promise<string> {
  if (name.includes('\\') || name.includes('/')) return name;
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [name], 3000);
  return r.ok ? (r.out.split('\n')[0] || '').trim() || name : name;
}

/** 常见安装位置（winget 刚装完时**当前进程的 PATH 不会更新**，别让用户为此重启内核）：
 *  只看 Python3xx 这一级目录，不递归全盘扫。 */
function pythonCandidates(): string[] {
  const out: string[] = [];
  const roots = [
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Python'),
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      for (const d of readdirSync(root)) {
        if (/^Python3\d+$/i.test(d)) out.push(join(root, d, 'python.exe'));
      }
    } catch { /* 目录没权限/正好被删：跳过 */ }
  }
  out.push('C:\\Python313\\python.exe', 'C:\\Python312\\python.exe');
  return out;
}

/** QQNT 安装位置：配置显式路径 → 注册表卸载项 → 常见默认目录（有头模式与 NapCat 注入共用） */
export function qqPathFromUninstallString(s: string): string {
  const m = /"([^"]+)"|(\S+)/.exec(s.trim());
  const exe = m?.[1] ?? m?.[2] ?? '';
  return exe ? join(dirname(exe), 'QQ.exe') : '';
}

export const QQ_DEFAULT_PATHS = [
  'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
  'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
  'D:\\QQ\\QQ.exe',
];

/** Docker Desktop 主程序（daemon 没起来时由内核替用户拉一下） */
export function dockerDesktopExe(): string {
  const root = process.env['ProgramFiles'] ?? 'C:\Program Files';
  const exe = join(root, 'Docker', 'Docker', 'Docker Desktop.exe');
  return existsSync(exe) ? exe : '';
}

/** docker CLI 候选：PATH 里没有时兜到 Docker Desktop 的默认安装位置 */
export function dockerBinCandidates(): string[] {
  return process.platform === 'win32'
    ? ['docker', join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
    : ['docker'];
}

export async function findQqInstallPath(cfgPath = ''): Promise<string> {
  if (cfgPath) return existsSync(cfgPath) ? cfgPath : '';
  if (process.platform !== 'win32') return QQ_DEFAULT_PATHS.find(existsSync) ?? '';
  const fromRegistry = await new Promise<string>((resolveP) => {
    execFile('reg', ['query',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString'],
      { timeout: 8000, windowsHide: true }, (e, stdout) => {
        if (e) return resolveP('');
        const line = String(stdout).split('\n').find((l) => /REG_SZ/.test(l));
        resolveP(qqPathFromUninstallString((line ?? '').replace(/.*REG_SZ\s*/, '').trim()));
      });
  });
  if (fromRegistry && existsSync(fromRegistry)) return fromRegistry;
  return QQ_DEFAULT_PATHS.find(existsSync) ?? '';
}

/** 数据目录真的能写吗（装进 Program Files、盘满、杀软拦目录都会在这露出来） */
function probeWritable(dataDir: string): { ok: boolean; detail: string } {
  const probeFile = join(dataDir, '.parallel-write-probe');
  try {
    writeFileSync(probeFile, 'x');
    const back = readFileSync(probeFile, 'utf8');
    unlinkSync(probeFile);
    return { ok: back === 'x', detail: back === 'x' ? dataDir : '写入后读不回内容' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 120) };
  }
}

async function probeOne(id: string, ctx: DepProbe): Promise<DepItem> {
  switch (id) {
    case 'node': {
      const major = Number(process.versions.node.split('.')[0]);
      return {
        id, label: 'Node.js', required: true,
        state: major >= 24 ? 'ok' : 'missing',
        detail: major >= 24 ? `v${process.versions.node}` : `v${process.versions.node}（需 ≥ 24：低版本跑不了 node:sqlite 与类型直跑）`,
        download: 'https://nodejs.org/zh-cn/download',
      };
    }
    case 'data': {
      const w = probeWritable(ctx.dataDir);
      return {
        id, label: '数据目录', required: true,
        state: w.ok ? 'ok' : 'missing', detail: w.detail,
      };
    }
    case 'qq': {
      const path = await findQqInstallPath(ctx.qqPathCfg);
      return {
        id, label: 'QQNT 客户端', required: ctx.headed, state: path ? 'ok' : 'missing',
        detail: path || '没探到 QQ.exe：装好后重启内核，或在 data/config.json 写 onebot.llbot.qqPath',
        download: 'https://im.qq.com/pcqq/',
      };
    }
    case 'llbot': {
      // 反向 WS 已连上就说明协议端在跑（很可能是用户自己起的、本内核没下载过）——那时报"缺失"是误判
      const up = ctx.endDownloaded || ctx.endConnected;
      const end = END_INFO[ctx.endFlavor] ?? END_INFO.llbot;
      return {
        id, label: end.name, required: true,
        state: up ? 'ok' : 'missing',
        // 路径一律写成相对数据目录：绝对路径在这宽度下要折两行，读起来全是噪音
        detail: ctx.endDownloaded ? `已就位（${end.dir}）`
          : ctx.endConnected ? '外部协议端已连入（不由本内核下载）'
            : '尚未下载：内核会自行拉取发行包，也可以点这里让它现在下',
        // install 是路由键不是名字：前端 POST /api/setup/install 带它，内核按 protocolEnd() 决定下哪一档
        install: 'llbot',
        download: end.releases,
      };
    }
    case 'docker': {
      let cli = '';
      for (const bin of dockerBinCandidates()) {
        const v = await run(bin, ['--version'], 3000);
        if (v.ok) { cli = await resolveOnPath(bin); break; }
      }
      if (!cli) {
        return {
          id, label: 'Docker', required: true,
          state: 'missing', detail: '未安装',
          install: 'docker',
          download: 'https://www.docker.com/products/docker-desktop/',
        };
      }
      // 预算与沙箱侧 probeDocker 一致（10s）：daemon 冷启动时两边不能一个说有一个说没有
      const info = await run(cli, ['info', '--format', 'ok'], 10_000);
      // 装了但 daemon 没应答 ≠ 没装：这时候要的是「启动」，再给一颗「下载」钮就是误导
      if (!info.ok) {
        return { id, label: 'Docker', required: true, state: 'idle', detail: `CLI 在（${cli}），daemon 没应答`, launch: 'docker' };
      }
      return { id, label: 'Docker', required: true, state: 'ok', detail: cli };
    }
    case 'python': {
      // Windows 的 `python` 可能是商店占位程序：它也会退出并打一行提示，所以必须认输出里的版本号
      for (const [bin, args] of [['python', ['--version']], ['py', ['-3', '--version']]] as [string, string[]][]) {
        const r = await run(bin, args, 3000);
        const ver = /([Pp]ython\s+\d+\.\d+(?:\.\d+)?)/.exec(r.out);
        if (r.ok && ver) {
          return { id, label: 'Python', required: true, state: 'ok', detail: `${ver[1]}（${await resolveOnPath(bin)}）` };
        }
      }
      // 刚用 winget 装完的 Python 不会出现在当前进程的 PATH 里（环境变量是启动时的快照）：
      // 直接去常见安装目录找 exe，装完这一轮就能判就绪，不用让用户重启内核。
      for (const exe of pythonCandidates()) {
        if (!existsSync(exe)) continue;
        const r = await run(exe, ['--version'], 3000);
        const ver = /([Pp]ython\s+\d+\.\d+(?:\.\d+)?)/.exec(r.out);
        if (ver) return { id, label: 'Python', required: true, state: 'ok', detail: `${ver[1]}（${exe}）` };
      }
      return {
        id, label: 'Python', required: true,
        state: 'missing', detail: '未安装', download: 'https://www.python.org/downloads/',
      };
    }
    case 'bash': {
      const cands = process.platform === 'win32'
        ? ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'D:\\Git\\bin\\bash.exe']
        : ['bash'];
      for (const bin of cands) {
        const r = await run(bin, ['--version'], 3000);
        // 首行形如 "GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)"：逗号在 bash 与 version 之间
        const ver = /version\s+(\d+\.\d+\.\d+)/.exec(r.out)?.[1] ?? '';
        if (r.ok && ver) {
          // 报解析到的真实文件：PATH 上 Git 的 bash 与 System32 的 WSL bash 会抢，只写 "bash" 等于没报
          return { id, label: 'Bash', required: true, state: 'ok', detail: `v${ver}（${await resolveOnPath(bin)}）` };
        }
      }
      return {
        id, label: 'Bash', required: true,
        state: 'missing', detail: '未安装', download: 'https://git-scm.com/download/win',
      };
    }
    case 'ffmpeg': {
      const bundled = bundledFfmpeg(ctx.dataDir);
      const env = (process.env.PARALLEL_FFMPEG ?? '').trim();
      const hit = existsSync(bundled) ? bundled : env && existsSync(env) ? env : '';
      const r = hit ? { ok: true, notFound: false, out: hit } : await run('ffmpeg', ['-version'], 3000);
      const ver = /ffmpeg version (\S+)/.exec(r.out)?.[1] ?? '';
      return {
        id, label: 'ffmpeg', required: false,
        state: r.ok ? 'ok' : 'missing',
        detail: r.ok ? (hit ? '已就位（data/bin）' : ver || '可用') : '未安装：语音消息不会送进模型（其余功能不受影响）',
        // 一个 exe 的东西，内核下完顺手解出来就能用，所以两个渠道都给
        install: r.ok ? undefined : 'ffmpeg',
        download: 'https://www.gyan.dev/ffmpeg/download/',
      };
    }
  }
  throw new Error(`未知依赖探测项 ${id}`);
}

const DEP_IDS = ['node', 'data', 'qq', 'llbot', 'docker', 'python', 'bash', 'ffmpeg'];

/** 单探一项：一键安装每走完一步只重探这一步，别把 docker info 又白打一遍 */
export function probeDep(id: string, ctx: DepProbe): Promise<DepItem> {
  return probeOne(id, ctx);
}

/** 并行探完全部依赖；同一份结果缓存 10 分钟，fresh=true 强制重探 */
export async function probeDeps(ctx: DepProbe, fresh = false): Promise<DepItem[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;
  const items = await Promise.all(DEP_IDS.map((id) => probeOne(id, ctx)));
  cache = { at: Date.now(), items };
  return items;
}

/** 必备项是否已齐（初始页据此决定「继续」能不能点） */
export function depsReady(items: DepItem[]): boolean {
  return items.filter((i) => i.required).every((i) => i.state === 'ok');
}
