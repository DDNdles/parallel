import { spawn, execFile } from 'node:child_process';
import { join, resolve, sep, normalize, dirname, relative, isAbsolute } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, rmSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import type { Db } from '../db.ts';
import type { ErrorCenter } from '../errors.ts';
import type { ConfigStore } from '../config.ts';
import type { ChatRef, SandboxEntry, SandboxRunResult, SandboxStat, SandboxWriteResult } from '../types.ts';
import { SlidingWindowCounter } from '../ratelimit.ts';
import { newId, nowMs, truncate, safeKeyPart } from '../util/misc.ts';
import { dockerBinCandidates } from './deps.ts';

/** 异步跑一条 docker 短命令：调用方只关心成功/失败（同步版会冻结事件循环） */
function dockerCmd(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolveP({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** 覆盖写的行增减：整行做多重集比对（够 UI 显示 +N -M，不做逐行 diff）；含 NUL 的二进制不计算 */
function lineDiff(oldText: string, newText: string): { added: number; removed: number } | null {
  if (/\0/.test(oldText) || /\0/.test(newText)) return null;
  const tally = (t: string) => {
    const m = new Map<string, number>();
    const lines = t.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();   // 末尾换行不算多一行
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = oldText ? tally(oldText) : new Map<string, number>();
  const b = tally(newText);
  let added = 0, removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0));
  return { added, removed };
}

/** 页面内联预览的图片类型（svg 不在内：它可携带脚本，同源内联等于执行位） */
const INLINE_IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

/** 语音/视频内联播放白名单（会话页的聊天记录卡片要用）。silk 是 QQ 语音的原容器。 *//** 语音/视频内联播放白名单（会话页的聊天记录卡片要用）。silk 是 QQ 语音的原容器。 */
const INLINE_MEDIA_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', amr: 'audio/amr', silk: 'audio/silk', slk: 'audio/silk',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};
/** 视频动辄几十 MB：流式发不占内存，但仍要有个天花板，别让人拿一条转发把磁盘 IO 拖死 */
const INLINE_MEDIA_MAX = 200 * 1024 * 1024;

/**
 * 能给模型「看」的图片类型：tiff/bmp/heic 多数供应商不收，gif 只取首帧，都排除在外。
 * 沙箱里的题图、截图、参考图走这条（sandbox_read 读到图片就把它当视觉输入递过去）。
 */
const VISION_IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
/** 单张图片的上限：base64 会再涨三分之一，再大就把请求体顶到对端拒收 */
const VISION_IMAGE_MAX = 8 * 1024 * 1024;

/** 交给系统默认程序不会触发脚本执行的类型；不在此列的一律只在文件管理器里选中 */
const SAFE_OPEN_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'ico', 'tif', 'tiff',
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'mp3', 'wav', 'ogg', 'flac', 'm4a',
  'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'yml', 'yaml', 'toml', 'ini', 'env',
  'pdf', 'html', 'htm', 'srt', 'ass', 'ttf', 'otf', 'woff', 'woff2',
  'zip', '7z', 'rar', 'gz', 'tar', 'xz',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
]);

/**
 * 所有一次性容器共用的硬化开关（work 与 chat 都套）：
 *  - --init：容器里给个 PID 1 收尸，避免僵尸进程把上限吃满；
 *  - --cap-drop ALL：丢掉全部 Linux capability（容器里不需要任何特权操作）；
 *  - --security-opt no-new-privileges：禁止 setuid 提权；
 *  - --pids-limit：防 fork 炸弹把宿主拖死。
 * 不挂 docker.sock、不加 --privileged —— 那两种是"隔离看起来开了、实际全开"的典型。
 */
const CONTAINER_HARDEN = [
  '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
];

/**
 * 包管理器下载缓存（Docker named volume，所有容器共享）：
 * 一次性容器跑完即销毁，pip/npm 装的东西随容器丢；挂上缓存卷后下载环节读本地缓存，
 * npm/pip install 从分钟级降到秒级（解压安装仍要跑）。只是下载缓存，不影响隔离模型。
 * 卷不存在时 docker run 会自动创建同名卷；偶尔 `docker volume rm` 清一次即可。
 */
const PACKAGE_CACHE_MOUNTS = [
  '-v', 'parallel-pip-cache:/root/.cache/pip',
  '-v', 'parallel-npm-cache:/root/.npm',
];

/**
 * 轻沙箱（非隔离档，红线见 README）：
 * - 每个会话一个沙箱根目录，LLM 文件工具只能触达当前会话目录（防路径穿越）
 * - 临时性：TTL 自动清理；单文件/单会话配额
 * - 受限执行：优先 Docker 容器强隔离（chat 档 --network none 断网；work 档联网，
 *   sandbox.workNetwork 可关）+ 只挂载会话目录；不可用时回落 python -I / node
 *   本机隔离子进程；超时 kill、输出截断、并发与频率配额
 */
export class SandboxService {
  readonly rootDir: string;
  private execCounter = new SlidingWindowCounter();
  /** kernel 接线：work 执行发现镜像缺失时通知 SessionContainers 开始自动构建 */
  onMissingImage?: (image: string) => void;
  private imageCheckCache = new Map<string, { ok: boolean; at: number }>();
  private runningCount = new Map<string, number>();
  /** 全宿主并发执行上限：每会话 1 之外的总帽，超出排队（不是拒绝） */
  private globalRunning = 0;
  private static MAX_GLOBAL_RUNNING = 8;
  private globalWaiters: (() => void)[] = [];
  private dockerOk: boolean | null = null;   // null=未探测；探测结果缓存
  private dockerCheckedAt = 0;               // false 结果带时间：Docker 后启动的要在 60s 后重新探测
  private static DOCKER_RECHECK_MS = 60_000;
  private dockerWarned = false;
  private dockerBin: string | null = null;   // docker.exe 绝对路径（PATH 没有 Docker 时用默认安装位置）

  constructor(
    dataDir: string,
    private db: Db,
    private config: ConfigStore,
    private errors: ErrorCenter,
  ) {
    this.rootDir = join(dataDir, 'sandbox');
    mkdirSync(this.rootDir, { recursive: true });
    // TTL 清理循环
    const t = setInterval(() => this.sweep().catch(() => {}), 10 * 60_000);
    t.unref();
  }

  // ---------------- 路径与边界 ----------------

  chatKey(chat: ChatRef): string {
    // scope = 同一聊天里按发起人再分一层（work 轮）；不带 scope 的就是聊天本身。
    // 三段都会变成目录名：chatId/scope 来自协议端与 API 参数，必须消毒，`..` 不能参与。
    return `${safeKeyPart(chat.type)}_${safeKeyPart(chat.chatId)}${chat.scope ? `__${safeKeyPart(chat.scope)}` : ''}`;
  }

  /**
   * 把聊天级 inbox 镜像进按人作用域的沙箱。
   *
   * work 轮的沙箱按发起人分开（同一个群里两位管理员各有自己的产物与常驻容器），
   * 但群聊里收到的文件仍落在聊天级 `inbox/`。每次 work 开跑前把新文件拷进去，
   * 模型照旧用 `inbox/xxx` 就能读到「发起者刚发的那份」。
   * 只补缺失或更新的文件，不覆盖 work 自己产出的同名文件。
   */
  syncInbox(from: ChatRef, to: ChatRef): number {
    if (!to.scope) return 0;
    const src = join(this.rootDir, `${from.type}_${from.chatId}`, 'inbox');
    const dest = join(this.root(to), 'inbox');
    if (!existsSync(src)) return 0;
    // dest 也可能是容器种下的符号链接：跟着写会把文件落到沙箱外
    try {
      const dst = lstatSync(dest);
      if (dst.isSymbolicLink() || !dst.isDirectory()) return 0;
    } catch {
      mkdirSync(dest, { recursive: true });
    }
    let names: string[];
    try { names = readdirSync(src); } catch { return 0; }
    let copied = 0;
    for (const name of names) {
      const s = join(src, name);
      const d = join(dest, name);
      try {
        const st = lstatSync(s);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        try {
          const ds = lstatSync(d);
          if (ds.isSymbolicLink() || !ds.isFile()) continue;
          if (ds.mtimeMs >= st.mtimeMs) continue;
        } catch { /* 目标不存在：照常拷 */ }
        copyFileSync(s, d);
        this.touchFile(to, `inbox/${name.replace(/\\/g, '/')}`, st.size);
        copied++;
      } catch { /* 单个文件失败不影响整次任务 */ }
    }
    return copied;
  }

  root(chat: ChatRef): string {
    const dir = join(this.rootDir, this.chatKey(chat));
    mkdirSync(dir, { recursive: true });
    const inbox = join(dir, 'inbox');
    // inbox 被容器换成符号链接时先拆掉再建：否则后续 saveInbox 的写入会落到链接目标
    try {
      const st = lstatSync(inbox);
      if (st.isSymbolicLink() || !st.isDirectory()) rmSync(inbox, { recursive: true, force: true });
    } catch { /* 不存在：下面创建 */ }
    mkdirSync(inbox, { recursive: true });
    return dir;
  }

  /**
   * 归一化并强校验：解析后的绝对路径必须落在会话沙箱根内（红线 §3.2）。
   * 返回绝对路径；越界抛 SandboxError。
   */
  resolveInside(chat: ChatRef, relPath: string): string {
    const root = this.root(chat);
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new SandboxError('路径不能为空');
    }
    // 拒绝盘符/UNC/绝对路径，交给相对解析
    const abs = resolve(root, relPath);
    const normRoot = normalize(root);
    const normAbs = normalize(abs);
    if (normAbs !== normRoot && !normAbs.startsWith(normRoot + sep)) {
      throw new SandboxError(`路径越界：只允许访问当前会话沙箱目录内的文件（${this.chatKey(chat)}）`);
    }
    // 字面校验不够：容器/子进程能在挂载卷里种符号链接（`ln -s / /ws/escape`），
    // 后面的 readFileSync/writeFileSync 会跟着它出沙箱。真实路径也必须落在根内。
    this.assertRealInside(normRoot, normAbs, relPath);
    return normAbs;
  }

  /** 解开符号链接后再比对一次；目标还不存在时向上找第一个存在的祖先（write 新建文件） */
  private assertRealInside(root: string, abs: string, relPath: string): void {
    const realRoot = realpathSync(root);
    let probe = abs;
    for (;;) {
      try {
        const real = realpathSync(probe);
        const inside = relative(realRoot, real);
        if (inside.startsWith('..') || isAbsolute(inside)) {
          throw new SandboxError(`路径越界：符号链接指向沙箱外（${relPath}）`);
        }
        return;
      } catch (e) {
        if (e instanceof SandboxError) throw e;
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new SandboxError(`无法校验路径（${relPath}）：${(e as Error).message}`);
        }
        const parent = dirname(probe);
        if (parent === probe) throw new SandboxError(`路径越界（${relPath}）`);
        probe = parent;
      }
    }
  }

  // ---------------- 文件工具 ----------------

  list(chat: ChatRef, relPath = '.'): SandboxEntry[] {
    const abs = this.resolveInside(chat, relPath);
    if (!existsSync(abs)) throw new SandboxError(`不存在: ${relPath}`);
    const st = statSync(abs);
    if (!st.isDirectory()) throw new SandboxError(`不是目录: ${relPath}`);
    const out: SandboxEntry[] = [];
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      let s;
      try { s = lstatSync(p); } catch { continue; }
      // 与 walkFiles 同口径：符号链接一律不列（可能指到沙箱外，点开就是越界读）
      if (s.isSymbolicLink()) continue;
      const rel = join(relPath, name).replace(/\\/g, '/');
      out.push({ name, relPath: rel, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs });
      if (s.isFile()) this.touchFile(chat, rel, s.size);
    }
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  /**
   * 递归列出沙箱内的文件（给 grep / glob 用）。
   * 边界与 `list` 同源：从 `resolveInside` 起步、逐层拼相对路径；不跟随符号链接（可能指到沙箱外）。
   * 有上限（文件数 / 层数）并回报是否截断：宁可少扫，不把一次工具调用拖成整树遍历。
   */
  walkFiles(chat: ChatRef, relPath = '.', opts: { maxFiles?: number; maxDepth?: number } = {}): { files: SandboxEntry[]; truncated: boolean } {
    const maxFiles = Math.max(1, Math.min(Math.floor(opts.maxFiles ?? 800), 5000));
    const maxDepth = Math.max(1, Math.min(Math.floor(opts.maxDepth ?? 8), 24));
    const startAbs = this.resolveInside(chat, relPath);
    if (!existsSync(startAbs)) throw new SandboxError(`不存在: ${relPath}`);
    if (!statSync(startAbs).isDirectory()) throw new SandboxError(`不是目录: ${relPath}`);
    const files: SandboxEntry[] = [];
    let truncated = false;
    const startRel = relPath.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
    const walk = (abs: string, rel: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(abs).sort(); } catch { return; }
      for (const name of names) {
        if (files.length >= maxFiles) { truncated = true; return; }
        const p = join(abs, name);
        const relP = rel === '.' ? name : `${rel}/${name}`;
        let s;
        try { s = lstatSync(p); } catch { continue; }
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) {
          if (depth < maxDepth) walk(p, relP, depth + 1);
          else truncated = true;
          continue;
        }
        if (!s.isFile()) continue;
        files.push({ name, relPath: relP, type: 'file', size: s.size, mtime: s.mtimeMs });
        this.touchFile(chat, relP, s.size);
      }
    };
    walk(startAbs, startRel, 0);
    return { files, truncated };
  }

  read(chat: ChatRef, relPath: string): string {
    const abs = this.resolveInside(chat, relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new SandboxError(`文件不存在: ${relPath}`);
    const st = statSync(abs);
    const cap = this.config.config.sandbox.maxFileBytes;
    if (st.size > cap) throw new SandboxError(`文件过大（${st.size} > ${cap} 字节），拒绝读取`);
    this.touchFile(chat, relPath, st.size);
    return readFileSync(abs, 'utf-8');
  }

    /**
   * 把沙箱里的图片读成模型的视觉输入（base64）：`sandbox_read` 读到图片走这条。
   * 非图片扩展名返回 null（调用方退回按文本读）；文件不存在/过大照实抛错。
   * 不收图的模型由 agent loop 统一丢弃并留 warn，这里不做模型能力判断。
   */
  readImage(chat: ChatRef, relPath: string): { data: string; mime: string; size: number } | null {
    const abs = this.resolveInside(chat, relPath);
    const ext = /\.([A-Za-z0-9]+)$/.exec(abs)?.[1]?.toLowerCase() ?? '';
    const mime = VISION_IMAGE_MIME[ext];
    if (!mime) return null;
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new SandboxError(`文件不存在: ${relPath}`);
    const st = statSync(abs);
    if (st.size > VISION_IMAGE_MAX) {
      throw new SandboxError(
        `图片过大（${(st.size / 1024 / 1024).toFixed(1)} MB > 8 MB），没法直接看；先用 Python 缩小一版（PIL 可用）再读`,
      );
    }
    this.touchFile(chat, relPath, st.size);
    return { data: readFileSync(abs).toString('base64'), mime, size: st.size };
  }

/** 桌面端预览：文本文件给内容（按字符截断，不切坏中文），二进制给 null（由 UI 决定改走系统程序打开） */
  preview(chat: ChatRef, relPath: string, cap = 256_000): { text: string; truncated: boolean } | null {
    const abs = this.resolveInside(chat, relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new SandboxError(`文件不存在: ${relPath}`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 4096).includes(0)) return null;
    const full = buf.toString('utf-8');
    this.touchFile(chat, relPath, buf.length);
    return { text: full.slice(0, cap), truncated: full.length > cap };
  }

  /**
   * 内联预览的字节：图片 + 语音 + 视频，只认白名单扩展名。
   * svg/html 一类能带脚本的类型不放进来——沙箱里的文件名与内容都来自 QQ 附件和 LLM 工具，
   * 同源内联等于把沙箱目录变成执行位。
   * 语音/视频要能拖进度条，所以只回文件位置让路由层流式发（stream:true），不整个读进内存；
   * 图片仍走一次性读取，体积上限也照原来的 sandbox.maxFileBytes。
   */
  rawInline(chat: ChatRef, relPath: string): { abs: string; mime: string; size: number; stream: boolean } {
    const abs = this.resolveInside(chat, relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new SandboxError(`文件不存在: ${relPath}`);
    const ext = /\.([A-Za-z0-9]+)$/.exec(abs)?.[1].toLowerCase() ?? '';
    const isImg = !!INLINE_IMAGE_MIME[ext];
    const mime = isImg ? INLINE_IMAGE_MIME[ext] : INLINE_MEDIA_MIME[ext];
    if (!mime) throw new SandboxError(`不支持内联预览的类型：${ext || '（无扩展名）'}`);
    const st = statSync(abs);
    const cap = isImg ? this.config.config.sandbox.maxFileBytes : INLINE_MEDIA_MAX;
    if (st.size > cap) throw new SandboxError(`文件过大（${st.size} > ${cap} 字节），拒绝读取`);
    this.touchFile(chat, relPath, st.size);
    return { abs, mime, size: st.size, stream: !isImg };
  }

  /**
   * 桌面端「打开」：交给系统默认程序，或只在文件管理器里选中（不代跑）。
   * 沙箱里的文件名来自 LLM 与 QQ 附件，所以只有确定不会触发执行的类型才用默认程序打开，
   * 其余（.py/.bat/.ps1/无扩展名…）一律只选中，避免点一下就把脚本跑起来。
   */
  handOff(chat: ChatRef, relPath: string): 'open' | 'reveal' {
    const abs = this.resolveInside(chat, relPath);
    if (!existsSync(abs)) throw new SandboxError(`文件不存在: ${relPath}`);
    if (/["\r\n]/.test(abs)) throw new SandboxError('文件名含引号或换行，无法安全交给系统');
    const ext = /\.([A-Za-z0-9]+)$/.exec(abs)?.[1].toLowerCase() ?? '';
    const reveal = !SAFE_OPEN_EXT.has(ext);
    let cmd: string, args: string[], verbatim = false;
    if (process.platform === 'win32') {
      // explorer 自己再解析一遍命令行，不走标准 argv：路径必须自带引号且关掉 Node 的转义
      cmd = 'explorer.exe'; verbatim = true;
      const q = `"${abs}"`;
      args = reveal ? [`/select,${q}`] : [q];
    } else if (process.platform === 'darwin') {
      cmd = 'open'; args = reveal ? ['-R', abs] : [abs];
    } else {
      cmd = 'xdg-open'; args = reveal ? [dirname(abs)] : [abs];
    }
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim }).unref();
    return reveal ? 'reveal' : 'open';
  }

  write(chat: ChatRef, relPath: string, content: string | Buffer, opts?: { work?: boolean }): SandboxWriteResult {
    const abs = this.resolveInside(chat, relPath);
    const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const cfg = this.config.config.sandbox as any;
    const work = !!opts?.work;
    // work 档：单文件与容量上限都放宽（work 产物通常更大）
    const fileCap = work ? (cfg.workMaxFileBytes ?? cfg.maxFileBytes * 5) : cfg.maxFileBytes;
    const sessionCap = work ? (cfg.workMaxSessionBytes ?? cfg.maxSessionBytes) : cfg.maxSessionBytes;
    if (data.length > fileCap) throw new SandboxError(`写入被拒绝：单文件上限 ${fileCap} 字节（本文件 ${data.length} 字节）`);
    const sessionBytes = this.sessionBytes(this.chatKey(chat));
    if (sessionBytes + data.length > sessionCap) {
      throw new SandboxError(`写入被拒绝：会话总占用将达到配额上限（${sessionCap} 字节），请先清理旧文件`);
    }
    mkdirSync(join(abs, '..'), { recursive: true });
    const diff = typeof content === 'string'
      ? lineDiff(existsSync(abs) ? readFileSync(abs).toString('utf-8') : '', content)
      : null;
    writeFileSync(abs, data);
    this.touchFile(chat, relPath, data.length);
    return { relPath: relPath.replace(/\\/g, '/'), size: data.length, added: diff?.added, removed: diff?.removed };
  }

  delete(chat: ChatRef, relPath: string): void {
    const abs = this.resolveInside(chat, relPath);
    if (!existsSync(abs)) throw new SandboxError(`不存在: ${relPath}`);
    const st = statSync(abs);
    if (st.isDirectory()) rmSync(abs, { recursive: true });
    else unlinkSync(abs);
    this.db.run('DELETE FROM sandbox_files WHERE chat_key=? AND rel_path=?', this.chatKey(chat), relPath.replace(/\\/g, '/'));
  }

  /** 收到的聊天文件落进 inbox（红线 §3.2） */
  saveInbox(chat: ChatRef, originalName: string, data: Buffer): string {
    const safe = originalName.replace(/[\\/:*?"<>|]/g, '_') || 'file';
    let name = safe;
    let i = 1;
    while (existsSync(join(this.root(chat), 'inbox', name))) {
      name = safe.replace(/(\.[^.]*)?$/, `_${i}$1`);
      i++;
    }
    const rel = `inbox/${name}`;
    this.write(chat, rel, data);
    return rel;
  }

  // ---------------- 受限执行 ----------------

  async run(chat: ChatRef, opts: { language: 'python' | 'javascript'; code: string; timeoutMs?: number }): Promise<SandboxRunResult> {
    return this.runAny(chat, opts);
  }

  /**
   * 通用执行入口：python/javascript/bash 全走容器（work 模式专用 shell 由调用方保证
   * 角色门槛——工具层已设 minRole，服务层不重复鉴权但记审计）。
   * opts.work=true 时套用 work 档配额（更高频率/容量），并按会话沙箱上限校验。
   *
   * **work 档一律要求容器**（2026-10-19）：子进程回落对本机是"能跑任意命令、还能看到宿主
   * 桌面与网络"的逃逸口——实测 work 模型在容器浏览器不可用时，自己用宿主机 PowerShell 拉起
   * 了宿主机的 Chrome，用户看得见窗口。容器不可用时报错，让它照实说做不了，而不是悄悄降级。
   *
   * 不再支持 powershell（2026-10-22）：Linux 容器里的 pwsh 没有 python/git/curl，
   * 计算与文本处理用 bash/python 就够；工具、镜像与配置项一并删掉。
   */
  async runAny(chat: ChatRef, opts: { language: 'python' | 'javascript' | 'bash'; code: string; timeoutMs?: number; work?: boolean }): Promise<SandboxRunResult> {
    const cfg = this.config.config.sandbox;
    const key = this.chatKey(chat);
    // 全局并发帽：不同会话各自 1 并发，但几十个群同时跑仍能打穿宿主内存
    await this.acquireGlobalSlot();
    try {
    // 配额：并发 1；每分钟频率按档位（work 档更宽）
    if ((this.runningCount.get(key) ?? 0) >= 1) {
      throw new SandboxError('当前会话已有脚本在运行，请稍候');
    }
    const rateCap = opts.work ? (cfg.workMaxRunsPerMin ?? cfg.maxRunsPerMin) : cfg.maxRunsPerMin;
    const runs = this.execCounter.hit(key);
    if (runs > rateCap) {
      throw new SandboxError(`执行频率超限（每分钟 ≤ ${rateCap} 次）`);
    }
    const langCap = opts.work
      // work 档有自己的整体上限（默认 5 分钟）：它经常要跑构建/大数据集，
      // 用 chat 档的 20s 会把正常任务截断（旧代码 workExecTimeoutMs 一直没被读）
      ? Math.max(cfg.workExecTimeoutMs ?? 300_000, opts.language === 'python' ? cfg.execTimeoutPythonMs : 0)
      : (opts.language === 'python' ? cfg.execTimeoutPythonMs
        : opts.language === 'javascript' ? cfg.execTimeoutJsMs
        : cfg.execTimeoutShellMs);
    const timeoutMs = Math.min(opts.timeoutMs ?? langCap, langCap);
    const cwd = this.root(chat);
    const started = nowMs();
    // work 执行可能顺手用 bash/python 写文件：执行前后各拍一次文本快照，
    // 把新增/修改的文件算成整行增减，工作页才能逐条显示 +N -M
    const before = opts.work ? this.snapshotText(chat) : null;
    const attach = (r: SandboxRunResult): SandboxRunResult => {
      if (!before) return r;
      const changes = this.diffSnapshots(before, this.snapshotText(chat));
      return changes.length ? { ...r, changes } : r;
    };
    this.runningCount.set(key, (this.runningCount.get(key) ?? 0) + 1);
    try {
      if (opts.language === 'bash') {
        // shell 一律容器内跑：宿主机 shell 能看到桌面、能启动本机程序，
        // 作为 work 工具的落地就是隔离漏口（容器不可用 → 报错，不回落）。
        const runtime = opts.work ? await this.requireDocker('shell 执行') : await this.resolveRuntime();
        if (runtime === 'docker') {
          if (opts.work) await this.requireWorkImage((this.config.config.sandbox as { dockerImageBash?: string }).dockerImageBash || 'parallel-sandbox-python:latest');
          return attach(await this.execDockerShell(chat, opts.code, timeoutMs));
        }
        return attach(await this.execSubprocessShell(chat, opts.code, timeoutMs));
      }
      // python/javascript：work 档同样强制容器（见方法注释）；chat 档维持 auto 回落
      const runtime = opts.work ? await this.requireDocker('脚本执行') : await this.resolveRuntime();
      if (runtime === 'docker') {
        if (opts.work) await this.requireWorkImage(opts.language === 'python'
          ? (cfg as { dockerImagePythonWork?: string }).dockerImagePythonWork || 'parallel-sandbox-python:latest'
          : (cfg as { dockerImageNodeWork?: string }).dockerImageNodeWork || 'parallel-sandbox-python:latest');
        return attach(await this.execDocker(chat, opts.language, opts.code, timeoutMs, !!opts.work));
      }
      return attach(await this.execSubprocess(chat, opts.language, opts.code, cwd, timeoutMs));
    } finally {
      this.runningCount.set(key, Math.max(0, (this.runningCount.get(key) ?? 1) - 1));
    }
    } finally {
      this.releaseGlobalSlot();
    }
  }

  private async acquireGlobalSlot(): Promise<void> {
    while (this.globalRunning >= SandboxService.MAX_GLOBAL_RUNNING) {
      await new Promise<void>((res) => this.globalWaiters.push(res));
    }
    this.globalRunning++;
  }

  private releaseGlobalSlot(): void {
    this.globalRunning = Math.max(0, this.globalRunning - 1);
    this.globalWaiters.shift()?.();
  }

  /** 沙箱内文本文件的快照（相对路径 → 内容）；二进制/超大文件直接跳过，别把一次执行拖成整树读盘 */
  private snapshotText(chat: ChatRef): Map<string, string> {
    const out = new Map<string, string>();
    let files: SandboxEntry[] = [];
    try { files = this.walkFiles(chat, '.', { maxFiles: 300, maxDepth: 12 }).files; } catch { return out; }
    let bytes = 0;
    for (const f of files) {
      if (f.type !== 'file' || f.size > 256 * 1024) continue;
      if (bytes + f.size > 8 * 1024 * 1024) break;
      try {
        const text = this.read(chat, f.relPath);
        if (text.includes('\0')) continue;   // 二进制（图片/压缩包）不算行数
        out.set(f.relPath, text);
        bytes += f.size;
      } catch { /* 读不动的跳过 */ }
    }
    return out;
  }

  /** 两份快照的差异 → 整行增减；删除的文件只报 -N */
  private diffSnapshots(before: Map<string, string>, after: Map<string, string>): { path: string; added: number; removed: number }[] {
    const changes: { path: string; added: number; removed: number }[] = [];
    for (const [path, text] of after) {
      const old = before.get(path);
      if (old === undefined) {
        const d = lineDiff('', text);
        if (d) changes.push({ path, ...d });
      } else if (old !== text) {
        const d = lineDiff(old, text);
        if (d && (d.added || d.removed)) changes.push({ path, ...d });
      }
    }
    for (const [path, text] of before) {
      if (after.has(path)) continue;
      changes.push({ path, added: 0, removed: text ? text.split('\n').length : 0 });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * work 档执行前确认镜像在本地（60s 缓存）：不在就触发自动构建并明确报错——
   * 首次使用的用户在这里得到「正在构建」而不是 docker run 的找不到镜像原文。
   */
  private async requireWorkImage(image: string): Promise<void> {
    const hit = this.imageCheckCache.get(image);
    if (hit && nowMs() - hit.at < 60_000) { if (hit.ok) return; }
    let ok = false;
    for (const bin of dockerBinCandidates()) {
      try { await dockerCmd(bin, ['image', 'inspect', image], 10_000); ok = true; break; } catch { /* 下一个候选 */ }
    }
    this.imageCheckCache.set(image, { ok, at: nowMs() });
    if (!ok) {
      this.onMissingImage?.(image);
      throw new SandboxError(`沙箱镜像 ${image} 还没构建，内核已开始自动构建（首次要拉基础镜像，约几分钟）。构建完成后再试一次。`);
    }
  }

  /** work 容器是否联网（sandbox.workNetwork，默认开；chat 档不受它影响，始终断网） */
  private workNetworkOn(): boolean {
    return (this.config.config.sandbox as { workNetwork?: boolean }).workNetwork !== false;
  }

  /** work 档的执行必须走容器：不可用就抛（隔离没生效时宁可做不了，也不悄悄降级到宿主） */
  private async requireDocker(what: string): Promise<'docker'> {
    if (!(await this.ensureDockerOk())) {
      throw new SandboxError(
        `Docker 不可用，${what}被拒绝：work 的执行只在容器沙箱里跑（宿主机子进程能看到本机桌面与网络，等于隔离失效）。请启动 Docker Desktop 后重试。`,
      );
    }
    return 'docker';
  }

  /** 决定本次执行的运行时：docker / subprocess（配置 + 可用性探测，探测失败回落并只告警一次） */
  private async resolveRuntime(): Promise<'docker' | 'subprocess'> {
    const cfg = this.config.config.sandbox as { runtime?: string; dockerImagePython?: string };
    const want = cfg.runtime ?? 'auto';
    if (want === 'subprocess') return 'subprocess';
    if (await this.ensureDockerOk()) return 'docker';
    if (want === 'docker') {
      // 显式要求 docker 但不可用：报错而不是静默降级（管理员需要知道隔离没生效）
      throw new SandboxError('sandbox.runtime=docker 但 Docker 不可用（未安装或 daemon 未启动）。请启动 Docker Desktop，或将 runtime 改为 auto/subprocess。');
    }
    if (!this.dockerWarned) {
      this.dockerWarned = true;
      this.errors.record('warn', 'sandbox', 'Docker 不可用，沙箱执行回落到本机子进程模式（弱隔离）。启动 Docker Desktop 后将自动使用容器强隔离。');
    }
    return 'subprocess';
  }

  /** 可用性缓存：成功一直用（docker 执行失败会把 dockerOk 清成 null）；
   *  失败 60s 后才重探——用户中途启动 Docker Desktop 不该等到重启内核才恢复强隔离。 */
  private async ensureDockerOk(): Promise<boolean> {
    if (this.dockerOk === true) return true;
    if (this.dockerOk === false && nowMs() - this.dockerCheckedAt < SandboxService.DOCKER_RECHECK_MS) return false;
    this.dockerOk = await this.probeDocker();
    this.dockerCheckedAt = nowMs();
    return this.dockerOk;
  }

  /** 探测 docker CLI + daemon 是否可用（异步，10s 预算）。PATH 找不到时尝试 Docker Desktop 默认安装位置。 */
  private async probeDocker(): Promise<boolean> {
    for (const bin of dockerBinCandidates()) {
      try {
        await dockerCmd(bin, ['info', '--format', 'ok'], 10_000);
        this.dockerBin = bin;
        return true;
      } catch { /* 尝试下一个候选 */ }
    }
    return false;
  }

  /** docker 子进程环境：把 Docker Desktop 凭据助手所在目录补进 PATH（内核进程 PATH 可能没有它） */
  private dockerEnv(): NodeJS.ProcessEnv {
    if (process.platform !== 'win32') return process.env;
    const extra = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin');
    return { ...process.env, PATH: process.env.PATH?.includes('Docker\\\\Docker\\\\resources') ? process.env.PATH : `${extra};${process.env.PATH ?? ''}` };
  }

  /**
   * Docker 容器执行（强隔离档）：
   * chat 档 --network none 物理断网；work 档联网（workNetworkOn，默认开），
   * 模型可在脚本里直接 requests/pip。只挂载会话沙箱目录（读写）；--rm 跑完即销毁；
   * 无 GPU/无特权。代码经 stdin 传入，避免命令行长度与转义问题。
   *
   * work 档默认换用 `parallel-sandbox-python` 镜像（Dockerfile 里预装了 numpy/pandas/
   * matplotlib/PIL/opencv/node 等）：实测 work 模型在一次性 python 里 import PIL/numpy 全失败，
   * 只能改用宿主机命令绕路——工具面"看起来齐全、实际不可用"同样是隔离失效的一种。
   */
  private execDocker(chat: ChatRef, language: 'python' | 'javascript', code: string, timeoutMs: number, work = false): Promise<SandboxRunResult> {
    const cfg = this.config.config.sandbox as {
      dockerImagePython?: string; dockerImageNode?: string;
      dockerImagePythonWork?: string; dockerImageNodeWork?: string;
    };
    const image = language === 'python'
      ? (work ? (cfg.dockerImagePythonWork || 'parallel-sandbox-python:latest') : (cfg.dockerImagePython || 'python:3.12-slim'))
      : (work ? (cfg.dockerImageNodeWork || 'parallel-sandbox-python:latest') : (cfg.dockerImageNode || 'node:24-slim'));
    // Windows 路径转 Docker 挂载格式：C:\...\dir -> //c/.../dir（Docker Desktop 接受）；先 resolve 保证带盘符
    const hostDir = resolve(this.root(chat)).replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `//${d.toLowerCase()}/`).replace(/\\/g, '/');
    const args = [
      'run', '--rm', '-i',   // -i：保持容器 stdin 开启以接收代码
      // chat 档断网；work 档按 sandbox.workNetwork（默认联网，2026-10-24 用户定）
      ...(work && this.workNetworkOn() ? [] : ['--network', 'none']),
      ...CONTAINER_HARDEN,
      ...PACKAGE_CACHE_MOUNTS,
      '-v', `${hostDir}:/ws`,
      '-w', '/ws',
      '--cpus', '1', '--memory', '512m',
      image,
    ];
    if (language === 'python') {
      args.push('python', '-I', '-u', '-'); // python 从 stdin 读脚本
    } else {
      args.push('node', '--input-type=module'); // node 从 stdin 读 ESM
    }
    return new Promise((resolveP) => {
      const startTs = Date.now();
      const outCap = work ? (this.config.config.sandbox as any).workMaxOutputBytes ?? this.config.config.sandbox.maxOutputBytes : this.config.config.sandbox.maxOutputBytes;
      let stdout = '', stderr = '', truncated = false, timedOut = false;
      const dockerBin = this.dockerBin ?? 'docker';
      const child = spawn(dockerBin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.dockerEnv() });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const collect = (chunk: Buffer, isOut: boolean) => {
        if (stdout.length + stderr.length >= outCap) { truncated = true; killTree(child); return; }
        const s = chunk.toString('utf-8');
        if (isOut) stdout += s; else stderr += s;
        if (stdout.length + stderr.length > outCap) {
          truncated = true;
          if (isOut) stdout = stdout.slice(0, outCap);
          else stderr = stderr.slice(0, Math.max(0, outCap - stdout.length));
          killTree(child);
        }
      };
      child.stdout!.on('data', (c: Buffer) => collect(c, true));
      child.stderr!.on('data', (c: Buffer) => collect(c, false));
      child.on('error', (e) => {
        clearTimeout(timer);
        // docker 命令本身失败（未安装/daemon 掉线）：标记不可用并回落子进程重试一次
        this.dockerOk = null;
        this.errors.record('warn', 'sandbox', `docker 执行失败，回落子进程: ${(e as Error).message}`);
        resolveP({ ok: false, exitCode: null, stdout: '', stderr: `[parallel] docker 执行失败: ${e.message}`, truncated: false, durationMs: Date.now() - startTs, timedOut: false });
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTs;
        if (timedOut) stderr += `\n[parallel] 超时被终止（上限 ${timeoutMs}ms）`;
        if (truncated) stdout += '\n[parallel] 输出超出上限被截断';
        this.touchFile(chat, '.', 0);
        resolveP({ ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, truncated, durationMs, timedOut });
      });
      // 代码经 stdin 传入（python - / node ESM 均支持），随后关闭 stdin 让进程自然结束
      child.stdin!.end(code, 'utf-8');
    });
  }

  /**
   * bash 的 Docker 执行：work 模式专用。与代码沙箱同等的强隔离：
   * 联网（可配）、只挂会话目录、--rm 销毁、限额。
   * 用**计算镜像**而不是 debian-slim：模型会在这里 import numpy/PIL、调 node，
   * 而 debian:12-slim 里连 python3 都没有（实测 `python3: command not found`）。
   */
  private execDockerShell(chat: ChatRef, code: string, timeoutMs: number): Promise<SandboxRunResult> {
    const cfg = this.config.config.sandbox as { dockerImageBash?: string };
    const hostDir = resolve(this.root(chat)).replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `//${d.toLowerCase()}/`).replace(/\\/g, '/');
    const args = ['run', '--rm', '-i', ...(this.workNetworkOn() ? [] : ['--network', 'none']), ...CONTAINER_HARDEN, ...PACKAGE_CACHE_MOUNTS, '-v', `${hostDir}:/ws`, '-w', '/ws', '--cpus', '1', '--memory', '512m'];
    args.push(cfg.dockerImageBash || 'parallel-sandbox-python:latest', 'bash', '-c', code);
    return new Promise((resolveP) => {
      const startTs = Date.now();
      const outCap = (this.config.config.sandbox as any).workMaxOutputBytes ?? this.config.config.sandbox.maxOutputBytes;
      let stdout = '', stderr = '', truncated = false, timedOut = false;
      const dockerBin = this.dockerBin ?? 'docker';
      const child = spawn(dockerBin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.dockerEnv() });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const collect = (chunk: Buffer, isOut: boolean) => {
        if (stdout.length + stderr.length >= outCap) { truncated = true; killTree(child); return; }
        const s = chunk.toString('utf-8');
        if (isOut) stdout += s; else stderr += s;
        if (stdout.length + stderr.length > outCap) {
          truncated = true;
          if (isOut) stdout = stdout.slice(0, outCap);
          else stderr = stderr.slice(0, Math.max(0, outCap - stdout.length));
          killTree(child);
        }
      };
      child.stdout!.on('data', (c: Buffer) => collect(c, true));
      child.stderr!.on('data', (c: Buffer) => collect(c, false));
      child.on('error', (e) => {
        clearTimeout(timer);
        this.dockerOk = null;
        this.errors.record('warn', 'sandbox', `docker shell 执行失败: ${(e as Error).message}`);
        resolveP({ ok: false, exitCode: null, stdout: '', stderr: `[parallel] docker shell 执行失败: ${e.message}`, truncated: false, durationMs: Date.now() - startTs, timedOut: false });
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTs;
        if (timedOut) stderr += `\n[parallel] 超时被终止（上限 ${timeoutMs}ms）`;
        if (truncated) stdout += '\n[parallel] 输出超出上限被截断';
        this.touchFile(chat, '.', 0);
        resolveP({ ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, truncated, durationMs, timedOut });
      });
    });
  }

  /**
   * shell 子进程执行（chat 档回落）：宿主机存在 bash 时可用（Git Bash/WSL）。cwd=会话沙箱目录。
   * work 档不会走到这里——`runAny` 里 work 已强制容器。
   */
  private execSubprocessShell(chat: ChatRef, code: string, timeoutMs: number): Promise<SandboxRunResult> {
    const outCap = this.config.config.sandbox.maxOutputBytes;
    const cwd = this.root(chat);
    return new Promise((resolveP) => {
      const startTs = Date.now();
      let stdout = '', stderr = '', truncated = false, timedOut = false;
      const command = process.env['PARALLEL_BASH'] || 'bash';
      const args = ['-c', code];
      const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          COMSPEC: process.env.COMSPEC ?? '',
          PARALLEL_SANDBOX: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const collect = (chunk: Buffer, isOut: boolean) => {
        if (stdout.length + stderr.length >= outCap) { truncated = true; killTree(child); return; }
        const s = chunk.toString('utf-8');
        if (isOut) stdout += s; else stderr += s;
        if (stdout.length + stderr.length > outCap) {
          truncated = true;
          if (isOut) stdout = stdout.slice(0, outCap);
          else stderr = stderr.slice(0, Math.max(0, outCap - stdout.length));
          killTree(child);
        }
      };
      child.stdout!.on('data', (c: Buffer) => collect(c, true));
      child.stderr!.on('data', (c: Buffer) => collect(c, false));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolveP({ ok: false, exitCode: null, stdout: '', stderr: `进程启动失败: ${e.message}（宿主机可能没有 bash；work 档不会走这条路，它强制容器）`, truncated: false, durationMs: Date.now() - startTs, timedOut: false });
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTs;
        if (timedOut) stderr += `\n[parallel] 超时被终止（上限 ${timeoutMs}ms）`;
        if (truncated) stdout += '\n[parallel] 输出超出上限被截断';
        this.touchFile(chat, '.', 0);
        resolveP({ ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, truncated, durationMs, timedOut });
      });
    });
  }

  private execSubprocess(chat: ChatRef, language: 'python' | 'javascript', code: string, cwd: string, timeoutMs: number): Promise<SandboxRunResult> {
    return new Promise((resolveP) => {
      const cfg = this.config.config.sandbox;
      const outCap = cfg.maxOutputBytes;
      const startTs = Date.now();
      // 代码经 -c / -e 传入（参数长度足够脚本用；超长代码建议先落盘再执行）
      const args = language === 'python'
        ? ['-I', '-u', '-c', code]                       // -I 隔离模式：不加载用户 site-packages/环境变量
        : ['--input-type=module', '-e', code];

      const child = spawn(language === 'python' ? process.env.PARALLEL_PYTHON || 'python' : process.execPath, args, {
        cwd,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',   // Windows 必需
          COMSPEC: process.env.COMSPEC ?? '',
          PARALLEL_SANDBOX: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '', stderr = '', truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);

      const collect = (chunk: Buffer, isOut: boolean) => {
        if (stdout.length + stderr.length >= outCap) {
          truncated = true;
          child.stdout.destroy();
          child.stderr.destroy();
          return;
        }
        const s = chunk.toString('utf-8');
        if (isOut) stdout += s; else stderr += s;
        if (stdout.length + stderr.length > outCap) {
          truncated = true;
          if (isOut) stdout = stdout.slice(0, outCap);
          else stderr = stderr.slice(0, Math.max(0, outCap - stdout.length));
          killTree(child);
        }
      };
      child.stdout.on('data', (c: Buffer) => collect(c, true));
      child.stderr.on('data', (c: Buffer) => collect(c, false));

      child.on('error', (e) => {
        clearTimeout(timer);
        resolveP({
          ok: false, exitCode: null,
          stdout: '', stderr: `进程启动失败: ${e.message}（${language === 'python' ? '请确认已安装 Python 并在 PATH 中' : 'node 执行异常'}）`,
          truncated: false, durationMs: Date.now() - startTs, timedOut: false,
        });
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTs;
        let out = truncate(stdout, outCap);
        let err = truncate(stderr, Math.max(0, outCap - stdout.length));
        if (timedOut) err += `\n[parallel] 超时被终止（上限 ${timeoutMs}ms）`;
        if (truncated) out += '\n[parallel] 输出超出上限被截断';
        // 记录会话最后活动
        this.touchFile(chat, '.', 0);
        resolveP({ ok: exitCode === 0 && !timedOut, exitCode, stdout: out, stderr: err, truncated, durationMs, timedOut });
      });
    });
  }

  // ---------------- 配额与清理 ----------------

  private touchFile(chat: ChatRef, relPath: string, size: number): void {
    const key = this.chatKey(chat);
    const rel = relPath.replace(/\\/g, '/');
    if (rel === '.') { this.db.run('INSERT OR IGNORE INTO sandbox_files (chat_key, rel_path, size, last_access) VALUES (?,?,0,?)', key, '.', nowMs()); return; }
    this.db.run(
      `INSERT INTO sandbox_files (chat_key, rel_path, size, last_access) VALUES (?,?,?,?)
       ON CONFLICT(chat_key, rel_path) DO UPDATE SET last_access=excluded.last_access, size=excluded.size`,
      key, rel, size, nowMs(),
    );
  }

  /** 会话目录的真实占用：容器直写/run_bash 产生的文件不进 sandbox_files，按表求和会低估配额 */
  sessionBytes(chatKey: string): number {
    let total = 0;
    let files = 0;
    const walk = (d: string, depth: number): void => {
      if (depth > 12 || files > 5000) return;
      let names: string[];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        if (files > 5000) return;
        const p = join(d, n);
        let st;
        try { st = lstatSync(p); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walk(p, depth + 1); continue; }
        if (!st.isFile()) continue;
        total += st.size;
        files++;
      }
    };
    walk(join(this.rootDir, safeKeyPart(chatKey)), 0);
    return total;
  }

  stats(): SandboxStat[] {
    const rows = this.db.all<{ chat_key: string; files: number; bytes: number; last: number }>(
      `SELECT chat_key, COUNT(*) as files, SUM(size) as bytes, MAX(last_access) as last FROM sandbox_files WHERE rel_path != '.' GROUP BY chat_key`,
    );
    return rows.map((r) => ({
      chat: r.chat_key,
      root: join(this.rootDir, r.chat_key),
      files: r.files,
      bytes: r.bytes ?? 0,
      lastActivity: r.last ?? 0,
    }));
  }

  clear(chat: ChatRef): void {
    const key = this.chatKey(chat);
    rmSync(join(this.rootDir, key), { recursive: true, force: true });
    this.db.run('DELETE FROM sandbox_files WHERE chat_key=?', key);
    // 清聊天级沙箱时把它名下所有按人分的 work 沙箱一起清掉（它们属于这个聊天）
    if (!chat.scope) {
      const prefix = `${key}__`;
      const rows = this.db.all<{ chat_key: string }>(
        'SELECT DISTINCT chat_key FROM sandbox_files WHERE chat_key LIKE ?', `${prefix}%`,
      );
      for (const r of rows) {
        rmSync(join(this.rootDir, r.chat_key), { recursive: true, force: true });
        this.db.run('DELETE FROM sandbox_files WHERE chat_key=?', r.chat_key);
      }
    }
  }

  /** TTL 清理：超期未访问的文件删除。全站一档（sandbox.retentionHours，默认 72h），
   *  收件文件、聊天临时文件、work 产物同一条线 —— 让「文件保留天数」这一个旋钮说话 */
  async sweep(): Promise<void> {
    const cfg = this.config.config.sandbox as any;
    const now = nowMs();
    const ttlHours = Number(cfg.retentionHours) > 0 ? Number(cfg.retentionHours) : 72;
    const rows = this.db.all<{ chat_key: string; rel_path: string; last_access: number }>(
      'SELECT chat_key, rel_path, last_access FROM sandbox_files WHERE rel_path != ? AND last_access IS NOT NULL', '.',
    );
    for (const r of rows) {
      if (now - r.last_access > ttlHours * 3_600_000) {
        const abs = join(this.rootDir, r.chat_key, r.rel_path);
        try {
          if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
          this.db.run('DELETE FROM sandbox_files WHERE chat_key=? AND rel_path=?', r.chat_key, r.rel_path);
        } catch (e) {
          this.errors.record('warn', 'sandbox', `TTL 清理失败 ${r.chat_key}/${r.rel_path}: ${(e as Error).message}`);
        }
      }
    }
    // 未登记的文件（容器直写 / run_bash 产物不会进 sandbox_files）按 mtime 走同一套 TTL：
    // 不扫目录的话，work 产物可能永远不被回收，磁盘只增不减。
    const known = new Set(rows.map((r) => `${r.chat_key}\u0000${r.rel_path.replace(/\\/g, '/')}`));
    try {
      for (const chatKey of readdirSync(this.rootDir)) {
        const base = join(this.rootDir, chatKey);
        let isDir = false;
        try {
          const st = lstatSync(base);
          isDir = st.isDirectory() && !st.isSymbolicLink();
        } catch { /* 不存在 */ }
        if (!isDir) continue;
        const walk = (d: string, rel: string, depth: number): void => {
          if (depth > 12) return;
          let names: string[];
          try { names = readdirSync(d); } catch { return; }
          for (const n of names) {
            const p = join(d, n);
            const rp = rel ? `${rel}/${n}` : n;
            let st;
            try { st = lstatSync(p); } catch { continue; }
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) { walk(p, rp, depth + 1); continue; }
            if (!st.isFile()) continue;
            if (known.has(`${chatKey}\u0000${rp}`)) continue;
            if (now - st.mtimeMs > ttlHours * 3_600_000) {
              try { unlinkSync(p); } catch { /* 下一轮再试 */ }
            }
          }
        };
        walk(base, '', 0);
      }
    } catch { /* 目录被并发删除等，不影响已登记文件的清理 */ }
    // 清理空目录
    try {
      for (const d of readdirSync(this.rootDir)) {
        const p = join(this.rootDir, d);
        if (statSync(p).isDirectory() && readdirSync(p).length === 0) rmSync(p, { recursive: true });
      }
    } catch { /* ignore */ }
  }
}

export class SandboxError extends Error {}

/** Windows/Unix 通用的进程树终止 */
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* ignore */ }
}
