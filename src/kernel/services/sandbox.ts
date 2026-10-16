import { spawn, execFileSync } from 'node:child_process';
import { join, resolve, sep, normalize, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import type { Db } from '../db.ts';
import type { ErrorCenter } from '../errors.ts';
import type { ConfigStore } from '../config.ts';
import type { ChatRef, SandboxEntry, SandboxRunResult, SandboxStat, SandboxWriteResult } from '../types.ts';
import { SlidingWindowCounter } from '../ratelimit.ts';
import { newId, nowMs, truncate } from '../util/misc.ts';
import { dockerBinCandidates } from './deps.ts';

/** 覆盖写的行增减：整行做多重集比对（够 UI 显示 +N -M，不做逐行 diff）；含 NUL 的二进制不计算 */
function lineDiff(oldText: string, newText: string): { added: number; removed: number } | null {
  if (/\0/.test(oldText) || /\0/.test(newText)) return null;
  const tally = (t: string) => {
    const m = new Map<string, number>();
    for (const l of t.split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
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

/** 语音/视频内联播放白名单（会话页的聊天记录卡片要用）。silk 是 QQ 语音的原容器。 */
const INLINE_MEDIA_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', amr: 'audio/amr', silk: 'audio/silk', slk: 'audio/silk',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};
/** 视频动辄几十 MB：流式发不占内存，但仍要有个天花板，别让人拿一条转发把磁盘 IO 拖死 */
const INLINE_MEDIA_MAX = 200 * 1024 * 1024;

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
 * 轻沙箱（非隔离档，红线见 README）：
 * - 每个会话一个沙箱根目录，LLM 文件工具只能触达当前会话目录（防路径穿越）
 * - 临时性：TTL 自动清理；单文件/单会话配额
 * - 受限执行：优先 Docker 容器强隔离（--network none 断网 + 只挂载会话目录），
 *   不可用时回落 python -I / node 本机隔离子进程；超时 kill、输出截断、并发与频率配额
 */
export class SandboxService {
  readonly rootDir: string;
  private execCounter = new SlidingWindowCounter();
  private runningCount = new Map<string, number>();
  private dockerOk: boolean | null = null;   // null=未探测；探测结果缓存
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
    return `${chat.type}_${chat.chatId}`;
  }

  root(chat: ChatRef): string {
    const dir = join(this.rootDir, this.chatKey(chat));
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'inbox'), { recursive: true });
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
    return normAbs;
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
      const s = statSync(p);
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
   * 通用执行入口：python/javascript 走容器或子进程；shell 走 powershell/bash（work 模式专用，
   * 由调用方保证角色门槛——工具层已设 minRole，服务层不重复鉴权但记审计）。
   * opts.work=true 时套用 work 档配额（更高频率/容量），并按会话沙箱上限校验。
   */
  async runAny(chat: ChatRef, opts: { language: 'python' | 'javascript' | 'powershell' | 'bash'; code: string; timeoutMs?: number; work?: boolean }): Promise<SandboxRunResult> {
    const cfg = this.config.config.sandbox;
    const key = this.chatKey(chat);
    // 配额：并发 1；每分钟频率按档位（work 档更宽）
    if ((this.runningCount.get(key) ?? 0) >= 1) {
      throw new SandboxError('当前会话已有脚本在运行，请稍候');
    }
    const rateCap = opts.work ? (cfg.workMaxRunsPerMin ?? cfg.maxRunsPerMin) : cfg.maxRunsPerMin;
    const runs = this.execCounter.hit(key);
    if (runs > rateCap) {
      throw new SandboxError(`执行频率超限（每分钟 ≤ ${rateCap} 次）`);
    }
    const langCap = opts.language === 'python' ? cfg.execTimeoutPythonMs
      : opts.language === 'javascript' ? cfg.execTimeoutJsMs
      : cfg.execTimeoutShellMs;
    const timeoutMs = Math.min(opts.timeoutMs ?? langCap, langCap);
    const cwd = this.root(chat);
    const started = nowMs();
    this.runningCount.set(key, (this.runningCount.get(key) ?? 0) + 1);
    try {
      if (opts.language === 'powershell' || opts.language === 'bash') {
        const runtime = this.resolveRuntime();
        // Windows 宿主机有原生 PowerShell（-NoProfile 受控执行），不拉 350MB 的 pwsh 镜像；
        // bash 则优先容器（宿主机 Git Bash 无 docker 那样的隔离）
        if (opts.language === 'powershell') {
          return await this.execSubprocessShell(chat, opts.language, opts.code, timeoutMs);
        }
        if (runtime === 'docker') {
          return await this.execDockerShell(chat, opts.language, opts.code, timeoutMs);
        }
        return await this.execSubprocessShell(chat, opts.language, opts.code, timeoutMs);
      }
      const runtime = this.resolveRuntime();
      if (runtime === 'docker') {
        return await this.execDocker(chat, opts.language, opts.code, timeoutMs);
      }
      return await this.execSubprocess(chat, opts.language, opts.code, cwd, timeoutMs);
    } finally {
      this.runningCount.set(key, Math.max(0, (this.runningCount.get(key) ?? 1) - 1));
    }
  }

  /** 决定本次执行的运行时：docker / subprocess（配置 + 可用性探测，探测失败回落并只告警一次） */
  private resolveRuntime(): 'docker' | 'subprocess' {
    const cfg = this.config.config.sandbox as { runtime?: string; dockerImagePython?: string };
    const want = cfg.runtime ?? 'auto';
    if (want === 'subprocess') return 'subprocess';
    if (this.dockerOk === null) this.dockerOk = this.probeDocker();
    if (this.dockerOk) return 'docker';
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

  /** 探测 docker CLI + daemon 是否可用（10s 预算，结果缓存）。PATH 找不到时尝试 Docker Desktop 默认安装位置。 */
  private probeDocker(): boolean {
    for (const bin of dockerBinCandidates()) {
      try {
        execFileSync(bin, ['info', '--format', 'ok'], { timeout: 10_000, windowsHide: true, stdio: 'pipe' });
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
   * --network none 物理断网；只挂载会话沙箱目录（读写）；--rm 跑完即销毁；无 GPU/无特权。
   * 代码经 stdin 传入，避免命令行长度与转义问题。
   */
  private execDocker(chat: ChatRef, language: 'python' | 'javascript', code: string, timeoutMs: number): Promise<SandboxRunResult> {
    const cfg = this.config.config.sandbox as { dockerImagePython?: string; dockerImageNode?: string };
    const image = language === 'python'
      ? (cfg.dockerImagePython || 'python:3.12-slim')
      : (cfg.dockerImageNode || 'node:24-slim');
    // Windows 路径转 Docker 挂载格式：C:\...\dir -> //c/.../dir（Docker Desktop 接受）；先 resolve 保证带盘符
    const hostDir = resolve(this.root(chat)).replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `//${d.toLowerCase()}/`).replace(/\\/g, '/');
    const args = [
      'run', '--rm', '-i', '--network', 'none',   // -i：保持容器 stdin 开启以接收代码
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
      const outCap = this.config.config.sandbox.maxOutputBytes;
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
   * shell（powershell/bash）Docker 执行：work 模式专用。与代码沙箱同等的强隔离：
   * --network none 断网、只挂会话目录、--rm 销毁、限额。bash 用 debian:12-slim 镜像。
   */
  private execDockerShell(chat: ChatRef, language: 'powershell' | 'bash', code: string, timeoutMs: number): Promise<SandboxRunResult> {
    const cfg = this.config.config.sandbox as { dockerImageBash?: string };
    const hostDir = resolve(this.root(chat)).replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `//${d.toLowerCase()}/`).replace(/\\/g, '/');
    const args = ['run', '--rm', '-i', '--network', 'none', '-v', `${hostDir}:/ws`, '-w', '/ws', '--cpus', '1', '--memory', '512m'];
    if (language === 'bash') {
      args.push(cfg.dockerImageBash || 'debian:12-slim', 'bash', '-c', code);
    } else {
      // PowerShell 无官方 slim 镜像坚持断网场景的轻量替代：只在宿主机子进程跑（见 execSubprocessShell）；
      // 容器内跑 pwsh 需 mcr.microsoft.com/powershell（约 350MB），按需拉取
      args.push('mcr.microsoft.com/powershell:debian-12', 'pwsh', '-NoProfile', '-NonInteractive', '-Command', code);
    }
    return new Promise((resolveP) => {
      const startTs = Date.now();
      const outCap = this.config.config.sandbox.maxOutputBytes;
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
   * shell 子进程执行（回落 / Windows PowerShell 原生）：
   * PowerShell 用 -NoProfile -NonInteractive（不加载用户配置、不交互）；
   * bash 仅在宿主机存在 bash 时可用（Git Bash/WSL）。cwd=会话沙箱目录。
   */
  private execSubprocessShell(chat: ChatRef, language: 'powershell' | 'bash', code: string, timeoutMs: number): Promise<SandboxRunResult> {
    const outCap = this.config.config.sandbox.maxOutputBytes;
    const cwd = this.root(chat);
    return new Promise((resolveP) => {
      const startTs = Date.now();
      let stdout = '', stderr = '', truncated = false, timedOut = false;
      let command: string, args: string[];
      if (language === 'powershell') {
        command = process.env['PARALLEL_PWSH'] || 'powershell';
        args = ['-NoProfile', '-NonInteractive', '-Command', code];
      } else {
        command = process.env['PARALLEL_BASH'] || 'bash';
        args = ['-c', code];
      }
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
        resolveP({ ok: false, exitCode: null, stdout: '', stderr: `进程启动失败: ${e.message}（${language === 'bash' ? '宿主机可能没有 bash' : 'PowerShell 不可用'}）`, truncated: false, durationMs: Date.now() - startTs, timedOut: false });
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

  sessionBytes(chatKey: string): number {
    const row = this.db.get<{ total: number | null }>('SELECT SUM(size) as total FROM sandbox_files WHERE chat_key=?', chatKey);
    return row?.total ?? 0;
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
  }

  /** TTL 清理：超期未访问的文件删除；inbox 更短；work 会话（有 work_runs 记录）用更长 TTL 保交付物 */
  async sweep(): Promise<void> {
    const cfg = this.config.config.sandbox as any;
    const now = nowMs();
    // work 会话集合：凡在 work_runs 表里出现过的会话，按 work 档 TTL（产物值得多留）
    let workChats = new Set<string>();
    try {
      workChats = new Set(
        this.db.all<{ chat_key: string }>('SELECT DISTINCT chat_key FROM work_runs').map((r) => r.chat_key),
      );
    } catch { /* 表未建（旧库）时退回 chat 档 */ }
    const rows = this.db.all<{ chat_key: string; rel_path: string; last_access: number }>(
      'SELECT chat_key, rel_path, last_access FROM sandbox_files WHERE rel_path != ? AND last_access IS NOT NULL', '.',
    );
    for (const r of rows) {
      const isWork = workChats.has(r.chat_key);
      const ttl = r.rel_path.startsWith('inbox/')
        ? (isWork ? (cfg.workInboxTtlHours ?? cfg.inboxTtlHours) : cfg.inboxTtlHours)
        : (isWork ? (cfg.workTtlHours ?? cfg.ttlHours) : cfg.ttlHours);
      if (now - r.last_access > ttl * 3_600_000) {
        const abs = join(this.rootDir, r.chat_key, r.rel_path);
        try {
          if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
          this.db.run('DELETE FROM sandbox_files WHERE chat_key=? AND rel_path=?', r.chat_key, r.rel_path);
        } catch (e) {
          this.errors.record('warn', 'sandbox', `TTL 清理失败 ${r.chat_key}/${r.rel_path}: ${(e as Error).message}`);
        }
      }
    }
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
