/**
 * 内核代下载的第三方安装包（环境检查页那颗「下载」钮）。
 *
 * 两条铁律：
 * 1. **只下载，不代装**——安装包落在 `data/downloads/`，装不装由人双击决定。静默跑别人的安装程序
 *    （要管理员权限、会动 Hyper-V/WSL）不是这个内核该替用户做的事。
 * 2. **URL 只走这张白名单表**，绝不拿前端传来的地址去 fetch（那是 SSRF 与投毒的入口）。
 *
 * 唯一的例外是 ffmpeg：它就是一个静态 exe，解压出来放进 `data/bin/` 就能直接用，
 * 所以给它多做一步解包——这样"点一下就下载"对可选项来说等于"点一下就可用"。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { setFfmpegCandidate } from './media.ts';

export interface DepFetchSpec {
  /** 官方直链（实测可用；版本随官方走，不钉死） */
  url: string;
  /** 落在 data/downloads 下的文件名 */
  file: string;
  /** zip 里要提出来的可执行文件名（给了就多做一步解包到 data/bin） */
  unpackBin?: string;
}

/** 环境检查页「点击就下载」的全部货源。加新条目先确认直链真的能下（curl -I），别猜。 */
export const DEP_FETCHES: Record<string, DepFetchSpec> = {
  docker: {
    url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
    file: 'DockerDesktopInstaller.exe',
  },
  ffmpeg: {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    file: 'ffmpeg-build.zip',
    unpackBin: 'ffmpeg.exe',
  },
};

export interface FetchState {
  id: string;
  dest: string;
  bytes: number;
  /** 服务端报了 content-length 才有，慢网下用来显示进度 */
  total: number;
  done: boolean;
  error: string;
}

const jobs = new Map<string, FetchState>();
/** 635MB 的 Docker 安装器在慢网下要跑十几分钟，别用几分钟的闸把它掐了 */
const TIMEOUT_MS = 30 * 60_000;

export function fetchState(id: string): FetchState | null {
  const j = jobs.get(id);
  if (!j || j.done || !j.dest) return j ?? null;
  // 计数走的是响应流，落盘可能领先一点点；以磁盘上的 .part 为准更诚实
  try {
    const part = j.dest + '.part';
    const onDisk = existsSync(part) ? statSync(part).size : statSync(j.dest).size;
    if (onDisk > j.bytes) j.bytes = onDisk;
  } catch { /* 文件还没建出来，保持原值 */ }
  return j;
}

/** 内核自带的 ffmpeg 落点：media.ts 与依赖探测都从这里读，别各写一份路径 */
export function bundledFfmpeg(dataDir: string): string {
  return join(dataDir, 'bin', 'ffmpeg.exe');
}

/**
 * 起一个后台下载（同 id 正在跑就复用，不重复开流）。
 * 立即返回状态，前端靠 /api/setup/fetch 轮进度——下载几分钟，不能把 HTTP 请求挂在那儿。
 */
export function startDepFetch(id: string, dataDir: string): FetchState {
  const spec = DEP_FETCHES[id];
  if (!spec) throw new Error(`不在下载白名单里：${id}`);
  const running = jobs.get(id);
  if (running && !running.done && !running.error) return running;

  const dir = join(dataDir, 'downloads');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, spec.file);
  const state: FetchState = { id, dest, bytes: 0, total: 0, done: false, error: '' };
  jobs.set(id, state);
  void finish(state, spec, dataDir);
  return state;
}

async function finish(state: FetchState, spec: DepFetchSpec, dataDir: string): Promise<void> {
  const part = state.dest + '.part';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(spec.url, { redirect: 'follow', signal: ctrl.signal });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
    state.total = Number(resp.headers.get('content-length') ?? 0) || 0;
    const counter = new PassThrough();
    counter.on('data', (chunk: Buffer) => { state.bytes += chunk.length; });
    // 流式落盘：整体 arrayBuffer 会把 600MB 安装包一口吞进内存
    await pipeline(Readable.fromWeb(resp.body as any), counter, createWriteStream(part));
    renameSync(part, state.dest);
    if (spec.unpackBin) {
      await unpackBin(state.dest, spec.unpackBin, bundledFfmpeg(dataDir));
      // 转码那头缓存过"没有 ffmpeg"，不清掉要等重启才认新位置
      setFfmpegCandidate(bundledFfmpeg(dataDir));
    }
    state.done = true;
  } catch (e) {
    state.error = (e as Error).name === 'AbortError' ? '下载超时' : (e as Error).message;
    try { rmSync(part, { force: true }); } catch { /* 半成品留着也没用，删不掉就算了 */ }
  } finally {
    clearTimeout(timer);
  }
}

/** zip 里按名字找那个 exe（包内通常还套一层 ffmpeg-<版本>-essentials_build/bin） */
async function unpackBin(zip: string, want: string, target: string): Promise<void> {
  const dir = join(target, '..', '_unpack');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Windows 自带 bsdtar 解 zip（PATH 里的 GNU tar 不行，所以走绝对路径）；必须异步，别阻塞事件循环
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await new Promise<void>((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { timeout: 300_000 }, (e) => (e ? reject(e) : resolve()));
  });
  const found = findDeep(dir, want, 4);
  if (!found) throw new Error(`解压后没找到 ${want}`);
  mkdirSync(join(target, '..'), { recursive: true });
  renameSync(found, target);
  rmSync(dir, { recursive: true, force: true });
  rmSync(zip, { force: true });   // 已经解出可执行文件，114MB 的 zip 没必要占着盘
}

function findDeep(root: string, name: string, depth: number): string {
  if (depth < 0) return '';
  let entries: string[] = [];
  try { entries = readdirSync(root, { withFileTypes: false }); } catch { return ''; }
  for (const n of entries) {
    const p = join(root, n);
    if (n === name) return p;
  }
  for (const n of entries) {
    const p = join(root, n);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch { continue; }
    const hit = findDeep(p, name, depth - 1);
    if (hit) return hit;
  }
  return '';
}
