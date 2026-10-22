import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 媒体兜底转码：QQ 发来的语音常是 Silk / AMR，而 OpenAI 系的 input_audio 只认
 * mp3|wav|ogg|flac|pcm16，直接塞过去对端会 400。这里在本机把它转成 16k 单声道 wav。
 *
 * 依赖外部 ffmpeg（PATH 里能找到，或用 PARALLEL_FFMPEG 指定路径）。找不到不静默假装成功：
 * 抛 MediaError，由调用方记进报错中心，用户在「报错」页能看到语音为什么没被读懂。
 */

export class MediaError extends Error {}

const WAV_MAX_BYTES = 20 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

/** 动图拼图：3×3 最多九帧、每帧长边 ≤384px（拼起来约 1152px，仍在各家图片块的单图上限内） */
const SHEET_GRID = 3;
const SHEET_FRAME_MAX = 384;
const SHEET_PADDING = 4;
const SHEET_MAX_BYTES = 12 * 1024 * 1024;
/** 拼图输出成 JPEG：同样的画面只有 PNG 的十分之一（实测 116KB vs 1.4MB），请求体轻得多。
 *  q=4 是画质与体积的拐点，再压就看不清表情细节了。 */
const SHEET_JPEG_Q = 4;
const ANIM_TIMEOUT_MS = 20_000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let ffmpegBin: string | null | undefined;
/** 内核自己下的那个 ffmpeg（data/bin/ffmpeg.exe）：由 kernel 在启动时登记 */
let ffmpegCandidate = '';

/** 环境检查页代下载完 ffmpeg 后调用：清掉缓存，下一次转码就用新位置 */
export function setFfmpegCandidate(path: string): void {
  ffmpegCandidate = path;
  ffmpegBin = undefined;
}

/** 找 ffmpeg：内核对下载的（PARALLEL_FFMPEG 覆盖它）→ PARALLEL_FFMPEG → PATH。结果缓存，探测只跑一次 */
export function findFfmpeg(): string | null {
  if (ffmpegBin !== undefined) return ffmpegBin;
  if (ffmpegCandidate && existsSync(ffmpegCandidate)) return (ffmpegBin = ffmpegCandidate);
  const env = (process.env.PARALLEL_FFMPEG ?? '').trim();
  if (env && existsSync(env)) return (ffmpegBin = env);
  const bin = env || 'ffmpeg';
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 5000 });
  ffmpegBin = probe.status === 0 ? bin : null;
  return ffmpegBin;
}

function cacheDir(): string {
  const dir = join(tmpdir(), 'parallel-media');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 清掉一小时前的转码产物（每次落新文件时顺手扫一遍，不引定时器） */
function sweepCache(): void {
  const now = Date.now();
  for (const name of readdirSync(cacheDir())) {
    const f = join(cacheDir(), name);
    try { if (now - statSync(f).mtimeMs > CACHE_TTL_MS) rmSync(f, { force: true }); } catch { /* 正被占用就留给下次 */ }
  }
}

// ---------------- 动图 → 分帧拼图 ----------------

/**
 * 这张图是不是动图。模型那边的图片块只认静态图：OpenAI 系收 GIF 只取第一帧，
 * Anthropic 直接拒收 image/gif 之外的动图，Gemini 也只读首帧——所以动图必须先在本机摊成分帧拼图。
 * 只按内容判断（扩展名不可信：QQ 会把动图存成 .gif/.webp，也可能改过后缀）：
 *  - GIF：每帧前都有一个 Graphic Control Extension（0x21 0xF9 0x04），≥2 个就是多帧；
 *  - APNG：PNG 里带 `acTL` 块；
 *  - 动态 WebP：RIFF/WEBP 里带 `ANIM` 块。
 */
export function isAnimatedImage(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') {
    let frames = 0;
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04 && ++frames > 1) return true;
    }
    return false;
  }
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    return buf.includes('acTL', 8, 'latin1');
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return buf.includes('ANIM', 12, 'latin1');
  }
  return false;
}

/** 跑一次 ffmpeg，把 stdin 喂进去、收 stdout（动图这两趟都不大，统一 20s 上限） */
function runFfmpeg(bin: string, args: string[], input: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, args);
    const chunks: Buffer[] = [];
    let err = '';
    let size = 0;
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; child.kill(); reject(e); } };
    const timer = setTimeout(() => fail(new MediaError('动图处理超时（20s）')), ANIM_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { fail(new MediaError(`动图拼图超过 ${Math.round(maxBytes / 1048576)}MB，已放弃`)); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-600); });
    child.on('error', (e) => fail(new MediaError(`ffmpeg 启动失败: ${e.message}`)));
    // ffmpeg 提前退出时写 stdin 会 EPIPE：不吞掉就是一个未捕获异常，会把内核带崩
    child.stdin.on('error', () => { /* 由 close 的退出码统一报 */ });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new MediaError(`ffmpeg 退出码 ${code}：${err.trim() || '（无输出）'}`));
    });
    child.stdin.end(input);
  });
}

/** 数帧：解码一遍只读 stderr 的进度行（不落盘、不产视频）。最后一条 `frame= N` 就是总帧数 */
async function countFrames(bin: string, buf: Buffer): Promise<number> {
  let err = '';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-']);
    const timer = setTimeout(() => { child.kill(); reject(new MediaError('动图探测超时（20s）')); }, ANIM_TIMEOUT_MS);
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new MediaError(`ffmpeg 启动失败: ${e.message}`)); });
    child.stdin.on('error', () => { /* 由 close 统一收口 */ });
    child.on('close', () => { clearTimeout(timer); resolve(); });
    child.stdin.end(buf);
  });
  const m = [...err.matchAll(/frame=\s*(\d+)/g)].pop();
  return m ? Number(m[1]) : 0;
}

/** 分帧拼图本体与它怎么排的（模型那边要一句话说清"这是动图不是多张图"） */
export interface AnimatedSheet {
  jpeg: Buffer;
  cols: number;
  rows: number;
  /** 原动图总帧数 */
  total: number;
  /** 实际抽出来放进拼图的帧数 */
  sampled: number;
}

/**
 * 动图 → 一张 3×3 以内的分帧拼图（JPEG）。等距抽最多九帧、按时间顺序从左到右、从上到下排，
 * 模型拿到的就是"这一小段动图长什么样"，而不是只看得到第一帧。
 * 帧数 ≤ 9 时按实际帧数选网格（2 帧就 2×1，4 帧就 2×2），不留大片空白。
 */
export async function animatedToSheet(buf: Buffer): Promise<AnimatedSheet> {
  const bin = findFfmpeg();
  if (!bin) throw new MediaError('本机没有 ffmpeg，动图无法抽帧（装 ffmpeg，或用 PARALLEL_FFMPEG 指定其路径）');
  const frames = await countFrames(bin, buf);
  if (!frames) throw new MediaError('动图解码不出帧（文件可能损坏或不是 ffmpeg 认得的格式）');
  const wanted = Math.min(frames, SHEET_GRID * SHEET_GRID);
  const cols = Math.min(SHEET_GRID, Math.ceil(Math.sqrt(wanted)));
  const rows = Math.ceil(wanted / cols);
  // 等距抽帧：首尾都取到（i*(total-1)/(wanted-1) 取整），正好 wanted 个序号。
  // 不用 `mod(n, step)`：步长取整会漏掉尾巴、也可能多抽，拼图里就缺了结尾那几帧的动作。
  const picks: number[] = [];
  if (wanted === 1) picks.push(0);
  else {
    for (let i = 0; i < wanted; i++) {
      const n = Math.round((i * (frames - 1)) / (wanted - 1));
      if (picks[picks.length - 1] !== n) picks.push(n);
    }
  }
  const select = picks.length < frames ? `select='${picks.map((n) => `eq(n\\,${n})`).join('+')}'` : 'null';
  const vf = [
    select,
    `scale='min(${SHEET_FRAME_MAX},iw)':'min(${SHEET_FRAME_MAX},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
    `tile=${cols}x${rows}:padding=${SHEET_PADDING}:color=white`,
  ].join(',');
  const jpeg = await runFfmpeg(bin, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', String(SHEET_JPEG_Q), 'pipe:1',
  ], buf, SHEET_MAX_BYTES);
  return { jpeg, cols, rows, total: frames, sampled: picks.length };
}

/**
 * 动图拼图 + 按内容寻址落盘（同一条动图在窗口里重放时不重复抽帧），返回拼图文件与排版信息。
 * 排版信息编进文件名（`<hash>_<cols>x<rows>_<sampled>of<total>.sheet.jpg`）：命中缓存时不必再问 ffmpeg。
 */
export async function animatedToSheetFile(buf: Buffer): Promise<AnimatedSheet & { path: string }> {
  const key = createHash('sha1').update(buf).digest('hex').slice(0, 24);
  const hit = readdirSync(cacheDir()).find((n) => n.startsWith(`${key}_`) && n.endsWith('.sheet.jpg'));
  const parsed = hit ? /_(\d+)x(\d+)_(\d+)of(\d+)\.sheet\.jpg$/.exec(hit) : null;
  if (hit && parsed) {
    const f = join(cacheDir(), hit);
    return {
      jpeg: readFileSync(f), path: f,
      cols: Number(parsed[1]), rows: Number(parsed[2]), sampled: Number(parsed[3]), total: Number(parsed[4]),
    };
  }
  const sheet = await animatedToSheet(buf);
  const name = `${key}_${sheet.cols}x${sheet.rows}_${sheet.sampled}of${sheet.total}.sheet.jpg`;
  const f = join(cacheDir(), name);
  const before = readdirSync(cacheDir()).length;
  writeFileSync(f, sheet.jpeg);
  if (before > 8) sweepCache();
  return { ...sheet, path: f };
}

/** 给模型的一句话：这张是动图的分帧拼图，不是多张不同的图 */
export function animatedSheetNote(s: Pick<AnimatedSheet, 'cols' | 'rows' | 'sampled' | 'total'>): string {
  const layout = s.rows === 1
    ? `${s.sampled} 帧从左到右排开`
    : `${s.cols}×${s.rows} 的分帧拼图，从左到右、从上到下`;
  const how = s.total > s.sampled ? `原动图 ${s.total} 帧，这里等距抽了 ${s.sampled} 帧` : `共 ${s.sampled} 帧`;
  return `（这张是动图的${layout}，按时间顺序排列；${how}。它表示一段连续动作，不是多张不同的图）`;
}

/** 任意容器 → 16k 单声道 wav；ffmpeg 缺失或解码失败都抛带原因的 MediaError */
export async function toWav(buf: Buffer, mime: string): Promise<Buffer> {
  const bin = findFfmpeg();
  if (!bin) throw new MediaError(`本机没有 ffmpeg，无法把 ${mime || '未知格式'} 语音转成模型认得的 wav（装 ffmpeg，或用 PARALLEL_FFMPEG 指定其路径）`);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    let size = 0;
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > WAV_MAX_BYTES) { child.kill(); reject(new MediaError('转码结果超过 20MB，已放弃')); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-400); });
    child.on('error', (e) => reject(new MediaError(`ffmpeg 启动失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new MediaError(`ffmpeg 退出码 ${code}：${err || '（无输出——该文件可能是 QQ Silk，协议端未转码）'}`));
    });
    child.stdin.end(buf);
  });
}

/** 转码 + 按内容寻址落盘（同一条语音在历史里重放时不重复转），返回绝对路径 */
export async function toWavFile(buf: Buffer, mime: string): Promise<string> {
  const key = createHash('sha1').update(buf).digest('hex').slice(0, 24);
  const f = join(cacheDir(), `${key}.wav`);
  if (existsSync(f)) return f;
  const wav = await toWav(buf, mime);
  const hit = readdirSync(cacheDir()).length;
  writeFileSync(f, wav);
  if (hit > 8) sweepCache();
  return f;
}

export async function fetchBuffer(url: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new MediaError(`下载失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) throw new MediaError(`文件为空或超过 ${Math.round(maxBytes / 1048576)}MB`);
  return buf;
}
